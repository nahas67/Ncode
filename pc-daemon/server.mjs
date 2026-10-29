#!/usr/bin/env node
/**
 * Ncode unified local PC & shell MCP daemon.
 *
 * One zero-dependency Node built-ins process that serves the PC/browser harness:
 *
 *   - Streamable HTTP MCP endpoint ............ http://127.0.0.1:3001/mcp
 *   - WebSocket extension bridge .............. ws://127.0.0.1:8085
 *   - stdio MCP transport (--stdio) ........... newline-delimited JSON-RPC
 *
 * Tools: pc_exec_shell, pc_fs_read, pc_fs_write, pc_fs_patch, pc_search_code,
 * pc_system_info, workflow_save_checkpoint, workflow_load_checkpoint,
 * workflow_list_checkpoints and (stdio mode only) ask_gemini_web.
 *
 * Hard rules baked into this file:
 *   - No runtime npm dependencies, Node built-ins only.
 *   - stdout is reserved for stdio JSON-RPC frames. ALL logging goes to stderr
 *     through the prefixed logger below, so JSON-RPC framing can never corrupt.
 *   - MCP is stateless (no MCP-Session-Id), which keeps restarts safe.
 *   - Background shell children are detached and intentionally survive daemon
 *     exit; graceful shutdown only closes listeners, watchers and log streams.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as http from 'node:http';
import * as crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import * as readline from 'node:readline';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SERVER_NAME = 'ncode-pc-daemon';
const SERVER_VERSION = '1.0.0';

const IS_WINDOWS = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';

const DEFAULT_HTTP_PORT = 3001;
const DEFAULT_WS_PORT = 8085;
const DEFAULT_HOST = '127.0.0.1';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const WS_PING_INTERVAL_MS = 20_000;
const WS_MAX_MISSED_PONGS = 3;
const WS_MAX_MESSAGE_BYTES = 1024 * 1024; // 1 MB inbound WebSocket message bound

const HTTP_MAX_BODY_BYTES = 16 * 1024 * 1024; // 16 MB JSON-RPC body bound

const MCP_DEFAULT_PROTOCOL_VERSION = '2025-03-26';
const MCP_SUPPORTED_PROTOCOL_VERSIONS = Object.freeze([
    '2025-11-25',
    '2025-06-18',
    '2025-03-26',
    '2024-11-05',
    '2024-10-07',
    '2024-06-20',
]);

const DEFAULT_SHELL_TIMEOUT_MS = 120_000;
const MAX_SHELL_TIMEOUT_MS = 600_000;
const STREAM_CAPTURE_LIMIT = 32 * 1024; // 32 KB kept per stream (head + tail)
const STREAM_CAPTURE_HALF = STREAM_CAPTURE_LIMIT / 2;
const FOREGROUND_KILL_GRACE_MS = 3_000;

const READ_MAX_LINES = 2000;
const READ_MAX_CHARS = 256 * 1024;

const SEARCH_MAX_MATCHES = 200;
const SEARCH_MAX_FILE_BYTES = 2 * 1024 * 1024;
const SEARCH_TIMEOUT_MS = 30_000;
const SEARCH_SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'artifacts', 'build']);

const CHECKPOINT_MAX_ID_LENGTH = 128;
const CHECKPOINT_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

const ASK_DEFAULT_TIMEOUT_MS = 120_000;
const ASK_MAX_TIMEOUT_MS = 600_000;

const MCP_INSTRUCTIONS = [
    `Ncode PC harness daemon ${SERVER_VERSION} (${SERVER_NAME}).`,
    'This local daemon gives you a real shell and filesystem on the user machine plus durable workflow checkpoints.',
    '',
    'Workflow:',
    '1. Inspect the machine with pc_system_info, then run commands with pc_exec_shell.',
    '2. Use pc_fs_read / pc_fs_write / pc_fs_patch for surgical file edits (patch requires exactly one literal match).',
    '3. Use pc_search_code to find symbols across a project; ripgrep is used when installed, otherwise a built-in regex walker.',
    '4. After every meaningful step call workflow_save_checkpoint with a concrete checkpoint object ({plan, step, done, pending, notes, files, lastCommand}).',
    '5. After a restart, context reset or hand-off, call workflow_load_checkpoint to resume exactly where you stopped instead of redoing work.',
    '',
    'Durability rules: checkpoints live under ~/.ncode/workflows/<workflowId>.json (or NCODE_STATE_DIR/workflows). They are atomic writes, survive daemon restarts, and are listed by workflow_list_checkpoints. Save often, and never assume in-memory state survives a restart.',
    '',
    'Shell notes: long output is truncated per stream to 32 KB (head+tail) with a pointer to the full log in ~/.ncode/logs. Background commands return {pid, logPath} and keep running after the daemon exits. Timeouts kill the whole process tree.',
    '',
    'In stdio mode ask_gemini_web relays a prompt to the user logged-in gemini.google.com tab through the Ncode browser extension connected to the daemon WebSocket bridge.',
].join('\n');

// ---------------------------------------------------------------------------
// Logger (stderr only, never stdout)
// ---------------------------------------------------------------------------

const DEBUG_ENABLED = /^(1|true|yes|on)$/i.test(process.env.NCODE_DEBUG || '');

function safeSerialize(value) {
    if (value === undefined) return '';
    if (value instanceof Error) return `${value.name}: ${value.message}`;
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

function writeStderr(level, message, details) {
    const suffix = details === undefined ? '' : ` ${safeSerialize(details)}`;
    const line = `[${SERVER_NAME}] [${level}] ${message}${suffix}\n`;
    try {
        process.stderr.write(line);
    } catch {
        // stderr is gone (parent died / EPIPE); nothing sane left to do.
    }
}

const log = {
    debug(message, details) {
        if (DEBUG_ENABLED) writeStderr('debug', message, details);
    },
    info(message, details) {
        writeStderr('info', message, details);
    },
    warn(message, details) {
        writeStderr('warn', message, details);
    },
    error(message, details) {
        writeStderr('error', message, details);
    },
};

// ---------------------------------------------------------------------------
// Errors & small type helpers
// ---------------------------------------------------------------------------

class ToolError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ToolError';
    }
}

class UsageError extends Error {
    constructor(message) {
        super(message);
        this.name = 'UsageError';
    }
}

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
    return typeof value === 'string' && value.trim().length > 0;
}

function asTrimmedString(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function requireStringArg(args, key, { allowEmpty = false, trim = false } = {}) {
    const raw = args[key];
    if (typeof raw !== 'string') {
        throw new ToolError(`Parameter "${key}" is required and must be a string.`);
    }
    const value = trim ? raw.trim() : raw;
    if (!allowEmpty && value.trim().length === 0) {
        throw new ToolError(`Parameter "${key}" is required and must be a non-empty string.`);
    }
    return value;
}

function optionalStringArg(args, key, defaultValue = undefined) {
    const raw = args[key];
    if (raw === undefined || raw === null) return defaultValue;
    if (typeof raw !== 'string') {
        throw new ToolError(`Parameter "${key}" must be a string when provided.`);
    }
    return raw;
}

function optionalBooleanArg(args, key, defaultValue) {
    const raw = args[key];
    if (raw === undefined || raw === null) return defaultValue;
    if (typeof raw === 'boolean') return raw;
    if (raw === 'true' || raw === '1') return true;
    if (raw === 'false' || raw === '0') return false;
    throw new ToolError(`Parameter "${key}" must be a boolean when provided.`);
}

function optionalNumberArg(args, key, { defaultValue, min, max, integer = true } = {}) {
    const raw = args[key];
    if (raw === undefined || raw === null) return defaultValue;
    const number = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isFinite(number)) {
        throw new ToolError(`Parameter "${key}" must be a finite number when provided.`);
    }
    if (integer && !Number.isInteger(number)) {
        throw new ToolError(`Parameter "${key}" must be an integer when provided.`);
    }
    if (min !== undefined && number < min) {
        throw new ToolError(`Parameter "${key}" must be >= ${min}.`);
    }
    if (max !== undefined && number > max) return max; // clamp documented maxima
    return number;
}

function expandHome(input) {
    if (typeof input !== 'string' || input.length === 0) return input;
    if (input === '~') return os.homedir();
    if (input.startsWith('~/') || input.startsWith('~\\')) {
        return path.join(os.homedir(), input.slice(2));
    }
    return input;
}

function resolveUserPath(input, baseDir = process.cwd()) {
    const expanded = expandHome(String(input));
    return path.isAbsolute(expanded) ? path.normalize(expanded) : path.resolve(baseDir, expanded);
}

function ensureDir(dirPath) {
    fs.mkdirSync(dirPath, { recursive: true });
}

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error) {
    if (error instanceof Error) return error.message;
    return String(error);
}

// ---------------------------------------------------------------------------
// CLI / configuration
// ---------------------------------------------------------------------------

const USAGE = [
    `Usage: node server.mjs [options]`,
    '',
    `Starts the Ncode PC daemon. Default mode serves Streamable HTTP MCP on`,
    `http://127.0.0.1:${DEFAULT_HTTP_PORT}/mcp and the WebSocket extension bridge on`,
    `ws://127.0.0.1:${DEFAULT_WS_PORT}.`,
    '',
    'Options:',
    '  --stdio              Run the stdio MCP transport (newline JSON-RPC on stdin/stdout)',
    '                       plus the WS bridge. HTTP stays off unless --http is also given.',
    '  --http               Force the HTTP listener on (also with --stdio).',
    '  --no-http            Disable the HTTP listener.',
    '  --ws                 Force the WebSocket bridge on (default in every mode).',
    '  --no-ws              Disable the WebSocket bridge.',
    `  --http-port <port>   HTTP MCP port (default ${DEFAULT_HTTP_PORT}, 0 = ephemeral).`,
    `  --ws-port <port>     WebSocket bridge port (default ${DEFAULT_WS_PORT}, 0 = ephemeral).`,
    `  --host <host>        Bind host (default ${DEFAULT_HOST}); keep loopback for safety.`,
    '  -h, --help           Show this help on stderr.',
    '',
    'Environment fallbacks: NCODE_HTTP_PORT, NCODE_WS_PORT, NCODE_HOST, NCODE_STATE_DIR.',
    '',
    'Exit codes: 0 graceful shutdown, 1 fatal startup error, 2 bad CLI usage.',
].join('\n');

function parsePortValue(raw, label) {
    const text = String(raw === undefined || raw === null ? '' : raw).trim();
    if (!/^\d+$/.test(text)) {
        throw new UsageError(`${label} must be an integer between 0 and 65535 (got "${text}").`);
    }
    const port = Number(text);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
        throw new UsageError(`${label} must be an integer between 0 and 65535 (got "${text}").`);
    }
    return port;
}

function envPort(name, fallback) {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return fallback;
    try {
        return parsePortValue(raw, name);
    } catch (error) {
        throw new UsageError(errorMessage(error));
    }
}

function parseCliArgs(argv) {
    const config = {
        help: false,
        host: process.env.NCODE_HOST || DEFAULT_HOST,
        httpPort: envPort('NCODE_HTTP_PORT', DEFAULT_HTTP_PORT),
        wsPort: envPort('NCODE_WS_PORT', DEFAULT_WS_PORT),
        stateDir: path.resolve(
            expandHome(process.env.NCODE_STATE_DIR || path.join(os.homedir(), '.ncode'))
        ),
        stdio: false,
        http: null, // null = mode default
        ws: null, // null = mode default
    };

    for (let index = 0; index < argv.length; index += 1) {
        let arg = argv[index];
        let inlineValue = null;
        if (arg.startsWith('--')) {
            const equalsIndex = arg.indexOf('=');
            if (equalsIndex !== -1) {
                inlineValue = arg.slice(equalsIndex + 1);
                arg = arg.slice(0, equalsIndex);
            }
        }

        const readValue = (label) => {
            if (inlineValue !== null) return inlineValue;
            index += 1;
            const candidate = argv[index];
            if (candidate === undefined || candidate.startsWith('--')) {
                throw new UsageError(`Missing value for ${label}.`);
            }
            return candidate;
        };

        switch (arg) {
            case '--help':
            case '-h':
                config.help = true;
                return config;
            case '--stdio':
                config.stdio = true;
                break;
            case '--http':
                config.http = true;
                break;
            case '--no-http':
                config.http = false;
                break;
            case '--ws':
                config.ws = true;
                break;
            case '--no-ws':
                config.ws = false;
                break;
            case '--http-port':
                config.httpPort = parsePortValue(readValue('--http-port'), '--http-port');
                break;
            case '--ws-port':
                config.wsPort = parsePortValue(readValue('--ws-port'), '--ws-port');
                break;
            case '--host':
                config.host = String(readValue('--host')).trim();
                if (!config.host) throw new UsageError('--host must be a non-empty host name.');
                break;
            default:
                throw new UsageError(`Unknown option: ${arg}`);
        }
    }

    if (config.http === null) config.http = !config.stdio;
    if (config.ws === null) config.ws = true;
    if (!config.http && !config.ws && !config.stdio) {
        throw new UsageError(
            'Nothing to run: HTTP and WebSocket are both disabled and --stdio was not given.'
        );
    }
    return config;
}

// ---------------------------------------------------------------------------
// Runtime state
// ---------------------------------------------------------------------------

const runtime = {
    config: null,
    startedAt: Date.now(),
    stateDir: '',
    logsDir: '',
    workflowsDir: '',
    httpServer: null,
    wsServer: null,
    stdioInterface: null,
    stdioActive: false,
    httpSockets: new Set(),
    wsSockets: new Set(),
    wsClients: new Set(),
    pendingAsks: new Map(), // requestId -> { resolve, reject, timer, client }
    extensionWaitTimers: new Set(),
    foregroundLogStreams: new Set(),
    backgroundProcesses: new Map(), // id -> {id, pid, command, cwd, logPath, startedAt}
    bgSweepTimer: null,
    wsPingTimer: null,
    shuttingDown: false,
    shutdownReason: '',
    actualHttpPort: null,
    actualWsPort: null,
};

function initRuntimePaths(config) {
    runtime.config = config;
    runtime.stateDir = config.stateDir;
    runtime.logsDir = path.join(config.stateDir, 'logs');
    runtime.workflowsDir = path.join(config.stateDir, 'workflows');
}

function getLogsDir() {
    if (!fs.existsSync(runtime.logsDir)) ensureDir(runtime.logsDir);
    return runtime.logsDir;
}

function getWorkflowsDir() {
    if (!fs.existsSync(runtime.workflowsDir)) ensureDir(runtime.workflowsDir);
    return runtime.workflowsDir;
}

function getHttpBaseUrl() {
    const config = runtime.config;
    return `http://${config.host}:${runtime.actualHttpPort}`;
}

function getWsUrl() {
    const config = runtime.config;
    return `ws://${config.host}:${runtime.actualWsPort}`;
}

function getBannerLine() {
    const config = runtime.config;
    const httpPart = config.http ? `http=${getHttpBaseUrl()}/mcp` : 'http=off';
    const wsPart = config.ws ? `ws=${getWsUrl()}` : 'ws=off';
    return `[${SERVER_NAME}] ${httpPart} ${wsPart} stdio=${config.stdio}`;
}

// ---------------------------------------------------------------------------
// JSON-RPC envelope helpers
// ---------------------------------------------------------------------------

function jsonRpcResult(id, result) {
    return { jsonrpc: '2.0', id: id === undefined ? null : id, result };
}

function jsonRpcError(id, code, message, data) {
    const error = { code, message };
    if (data !== undefined) error.data = data;
    return { jsonrpc: '2.0', id: id === undefined ? null : id, error };
}

function isJsonRpcNotification(message) {
    return isPlainObject(message) && !Object.prototype.hasOwnProperty.call(message, 'id');
}

// ---------------------------------------------------------------------------
// Tool output helpers
// ---------------------------------------------------------------------------

function toolSuccess(payload) {
    let text;
    try {
        text = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
    } catch (error) {
        text = safeSerialize(payload);
    }
    return { content: [{ type: 'text', text }], isError: false };
}

function toolFailure(message, data) {
    const suffix = data === undefined ? '' : `\n${JSON.stringify(data, null, 2)}`;
    return {
        content: [{ type: 'text', text: `Error: ${message}${suffix}` }],
        isError: true,
    };
}

// ---------------------------------------------------------------------------
// Tool schema registry
// ---------------------------------------------------------------------------

function schema(properties, required = []) {
    return {
        type: 'object',
        properties,
        required,
        additionalProperties: true,
    };
}

const BASE_TOOL_DEFINITIONS = [
    {
        name: 'pc_exec_shell',
        description:
            'Run a shell command on the user PC (Windows: cmd.exe; macOS/Linux: /bin/sh -lc). Foreground captures stdout/stderr/exitCode with 32 KB head+tail truncation and a pointer to the full log. background=true spawns a detached process and returns {pid, logPath, started:true}; the process survives daemon exit. timeouts kill the whole process tree.',
        inputSchema: schema(
            {
                command: { type: 'string', description: 'Shell command line to execute.' },
                cwd: {
                    type: 'string',
                    description:
                        'Working directory (supports ~). Defaults to the user home directory; must exist.',
                },
                timeoutMs: {
                    type: 'number',
                    description: `Foreground timeout in ms (default ${DEFAULT_SHELL_TIMEOUT_MS}, max ${MAX_SHELL_TIMEOUT_MS}).`,
                    minimum: 1,
                    maximum: MAX_SHELL_TIMEOUT_MS,
                },
                background: {
                    type: 'boolean',
                    description: 'Spawn detached in the background and return immediately.',
                },
            },
            ['command']
        ),
    },
    {
        name: 'pc_fs_read',
        description:
            'Read a UTF-8 text file (supports ~), optionally a 1-based inclusive line range. Returns line-numbered content. Caps at 2000 lines / 256 KB, rejects binary files.',
        inputSchema: schema(
            {
                filePath: { type: 'string', description: 'File path to read (supports ~).' },
                startLine: { type: 'number', description: 'First line to return, 1-based inclusive.' },
                endLine: { type: 'number', description: 'Last line to return, 1-based inclusive.' },
            },
            ['filePath']
        ),
    },
    {
        name: 'pc_fs_write',
        description:
            'Write a UTF-8 text file atomically (temp file in the same directory + rename). Creates parent directories by default. Returns {filePath, bytes, created}.',
        inputSchema: schema(
            {
                filePath: { type: 'string', description: 'Destination file path (supports ~).' },
                content: { type: 'string', description: 'Full file content to write.' },
                createDirs: {
                    type: 'boolean',
                    description: 'Create missing parent directories (default true).',
                },
            },
            ['filePath', 'content']
        ),
    },
    {
        name: 'pc_fs_patch',
        description:
            'Surgically replace an exact literal block in a UTF-8 file. searchBlock must match exactly one occurrence (0 or >1 is an error with occurrence count). Returns a unified diff plus {occurrences:1, bytes}.',
        inputSchema: schema(
            {
                filePath: { type: 'string', description: 'File to patch (supports ~).' },
                searchBlock: {
                    type: 'string',
                    description: 'Exact literal text to find (must be unique, non-empty).',
                },
                replaceBlock: { type: 'string', description: 'Replacement text (may be empty).' },
            },
            ['filePath', 'searchBlock', 'replaceBlock']
        ),
    },
    {
        name: 'pc_search_code',
        description:
            'Recursively search a directory with a JavaScript regular expression. Uses ripgrep when available, otherwise a pure-Node walker that skips node_modules/.git/dist/artifacts/build. Supports fileGlob (*.js, **/*.ts, {a,b}). Returns up to 200 matches.',
        inputSchema: schema(
            {
                directory: { type: 'string', description: 'Directory to search (supports ~).' },
                pattern: { type: 'string', description: 'JavaScript regular expression.' },
                fileGlob: {
                    type: 'string',
                    description: 'Optional file glob filter, e.g. *.js or **/*.ts.',
                },
            },
            ['directory', 'pattern']
        ),
    },
    {
        name: 'pc_system_info',
        description:
            'Report platform, release, arch, shell, cwd, homedir, node version, npm/python/git versions, state dir, checkpoint count, managed background processes and daemon uptime.',
        inputSchema: schema({}, []),
    },
    {
        name: 'workflow_save_checkpoint',
        description:
            'Atomically save a durable workflow checkpoint to ~/.ncode/workflows/<workflowId>.json as {savedAt, checkpoint}. workflowId is sanitized to [A-Za-z0-9._-].',
        inputSchema: schema(
            {
                workflowId: {
                    type: 'string',
                    description: 'Stable workflow id (letters, digits, dot, underscore, dash).',
                },
                checkpoint: {
                    type: 'object',
                    description: 'JSON checkpoint object, e.g. {plan, step, done, pending, notes}.',
                },
                pretty: {
                    type: 'boolean',
                    description: 'Pretty-print the JSON with 2-space indentation (default false).',
                },
            },
            ['workflowId', 'checkpoint']
        ),
    },
    {
        name: 'workflow_load_checkpoint',
        description:
            'Load a workflow checkpoint saved by workflow_save_checkpoint. Call this after a restart or context reset to resume exactly where the workflow stopped.',
        inputSchema: schema(
            { workflowId: { type: 'string', description: 'Workflow id to load.' } },
            ['workflowId']
        ),
    },
    {
        name: 'workflow_list_checkpoints',
        description:
            'List saved workflow checkpoints with workflowId, savedAt and bytes. Useful for building harness status output.',
        inputSchema: schema({}, []),
    },
];

const ASK_TOOL_DEFINITION = {
    name: 'ask_gemini_web',
    description:
        'Send a prompt to the user logged-in gemini.google.com web session through the Ncode browser extension connected to the WebSocket bridge and return the response text. Only available in stdio mode.',
    inputSchema: schema(
        {
            prompt: { type: 'string', description: 'Prompt to send to the Gemini web app.' },
            timeoutMs: {
                type: 'number',
                description: `Overall timeout in ms (default ${ASK_DEFAULT_TIMEOUT_MS}, max ${ASK_MAX_TIMEOUT_MS}).`,
                minimum: 1,
                maximum: ASK_MAX_TIMEOUT_MS,
            },
        },
        ['prompt']
    ),
};

const TOOL_HANDLERS = new Map([
    ['pc_exec_shell', handlePcExecShell],
    ['pc_fs_read', handlePcFsRead],
    ['pc_fs_write', handlePcFsWrite],
    ['pc_fs_patch', handlePcFsPatch],
    ['pc_search_code', handlePcSearchCode],
    ['pc_system_info', handlePcSystemInfo],
    ['workflow_save_checkpoint', handleWorkflowSaveCheckpoint],
    ['workflow_load_checkpoint', handleWorkflowLoadCheckpoint],
    ['workflow_list_checkpoints', handleWorkflowListCheckpoints],
    ['ask_gemini_web', handleAskGeminiWeb],
]);

function isAskToolEnabled() {
    return Boolean(runtime.config && runtime.config.stdio);
}

function listToolDefinitions() {
    const definitions = [...BASE_TOOL_DEFINITIONS];
    if (isAskToolEnabled()) definitions.push(ASK_TOOL_DEFINITION);
    return definitions;
}

function countTools() {
    return listToolDefinitions().length;
}

// ---------------------------------------------------------------------------
// MCP JSON-RPC core (shared by HTTP and stdio transports)
// ---------------------------------------------------------------------------

function negotiateProtocolVersion(requested) {
    if (
        typeof requested === 'string' &&
        MCP_SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
    ) {
        return requested;
    }
    return MCP_DEFAULT_PROTOCOL_VERSION;
}

function buildInitializeResult(params) {
    const requested = isPlainObject(params) ? params.protocolVersion : undefined;
    return {
        protocolVersion: negotiateProtocolVersion(requested),
        capabilities: {
            tools: { listChanged: false },
            logging: {},
        },
        serverInfo: {
            name: SERVER_NAME,
            version: SERVER_VERSION,
        },
        instructions: MCP_INSTRUCTIONS,
    };
}

function findToolDefinition(name) {
    return listToolDefinitions().find((definition) => definition.name === name) || null;
}

async function invokeTool(toolName, toolArguments) {
    const definition = findToolDefinition(toolName);
    if (!definition) {
        const available = listToolDefinitions()
            .map((item) => item.name)
            .join(', ');
        return toolFailure(`Unknown tool "${toolName}". Available tools: ${available}`);
    }
    const handler = TOOL_HANDLERS.get(toolName);
    if (typeof handler !== 'function') {
        return toolFailure(`Tool "${toolName}" is registered without a handler.`);
    }
    try {
        const payload = await handler(toolArguments);
        return toolSuccess(payload);
    } catch (error) {
        if (!(error instanceof ToolError)) {
            log.error(`tool "${toolName}" threw an internal error`, {
                error: error && error.stack ? error.stack : errorMessage(error),
            });
        } else {
            log.debug(`tool "${toolName}" failed`, { error: error.message });
        }
        return toolFailure(errorMessage(error));
    }
}

/**
 * Handle one JSON-RPC message.
 *
 * Returns the JSON-RPC response object, or null when the message is a
 * notification and must not be answered. Never throws: every internal failure
 * becomes a JSON-RPC error response.
 */
async function handleMcpMessage(message) {
    if (!isPlainObject(message)) {
        return jsonRpcError(null, -32600, 'Invalid Request: expected a JSON object.');
    }
    const hasId = Object.prototype.hasOwnProperty.call(message, 'id');
    const id = hasId ? message.id : null;

    if (
        message.jsonrpc !== undefined &&
        message.jsonrpc !== null &&
        message.jsonrpc !== '2.0'
    ) {
        return jsonRpcError(id, -32600, 'Invalid Request: "jsonrpc" must be "2.0".');
    }
    if (typeof message.method !== 'string' || message.method.length === 0) {
        return jsonRpcError(id, -32600, 'Invalid Request: "method" must be a non-empty string.');
    }

    const method = message.method;
    const params = message.params;

    // Notifications must never be answered (HTTP 202 / no stdio frame).
    if (!hasId) {
        if (method !== 'notifications/initialized') {
            log.debug('ignored JSON-RPC notification', { method });
        }
        return null;
    }

    try {
        switch (method) {
            case 'initialize':
                return jsonRpcResult(id, buildInitializeResult(params));

            case 'notifications/initialized':
                // Tolerated as a request-shaped initialized notification.
                return jsonRpcResult(id, {});

            case 'ping':
                return jsonRpcResult(id, {});

            case 'tools/list':
                return jsonRpcResult(id, { tools: listToolDefinitions() });

            case 'tools/call': {
                if (!isPlainObject(params)) {
                    return jsonRpcResult(
                        id,
                        toolFailure(
                            'Invalid params for tools/call: expected {"name": string, "arguments": object}.'
                        )
                    );
                }
                if (typeof params.name !== 'string' || params.name.length === 0) {
                    return jsonRpcResult(
                        id,
                        toolFailure('Invalid params for tools/call: "name" must be a non-empty string.')
                    );
                }
                let toolArguments = {};
                if (params.arguments !== undefined && params.arguments !== null) {
                    if (!isPlainObject(params.arguments)) {
                        return jsonRpcResult(
                            id,
                            toolFailure('Invalid params for tools/call: "arguments" must be an object.')
                        );
                    }
                    toolArguments = params.arguments;
                }
                const toolResult = await invokeTool(params.name, toolArguments);
                return jsonRpcResult(id, toolResult);
            }

            case 'logging/setLevel':
                return jsonRpcResult(id, {});

            default:
                return jsonRpcError(id, -32601, `Method not found: ${method}`, {
                    supportedMethods: [
                        'initialize',
                        'notifications/initialized',
                        'ping',
                        'tools/list',
                        'tools/call',
                    ],
                });
        }
    } catch (error) {
        log.error('JSON-RPC handler crashed', {
            method,
            error: error && error.stack ? error.stack : errorMessage(error),
        });
        return jsonRpcError(id, -32603, `Internal error while handling ${method}: ${errorMessage(error)}`);
    }
}

/** Handle a POST /mcp body that may be a single message or a batch array. */
async function handleMcpPayload(payload) {
    if (Array.isArray(payload)) {
        if (payload.length === 0) {
            return {
                kind: 'invalid',
                response: jsonRpcError(null, -32600, 'Invalid Request: empty batch array.'),
            };
        }
        const responses = [];
        let sawRequest = false;
        for (const entry of payload) {
            if (!isPlainObject(entry)) {
                responses.push(
                    jsonRpcError(null, -32600, 'Invalid Request: batch entries must be JSON objects.')
                );
                sawRequest = true;
                continue;
            }
            const response = await handleMcpMessage(entry);
            if (response !== null) {
                responses.push(response);
                sawRequest = true;
            }
        }
        if (!sawRequest) return { kind: 'notification' };
        return { kind: 'batch', responses };
    }

    const response = await handleMcpMessage(payload);
    if (response === null) return { kind: 'notification' };
    return { kind: 'single', response };
}

// ---------------------------------------------------------------------------
// Shell execution helpers
// ---------------------------------------------------------------------------

/** Bounded stdout/stderr capture: keeps the first/last 16 KB of a 32 KB budget. */
class StreamCapture {
    constructor(limitBytes = STREAM_CAPTURE_LIMIT, halfBytes = STREAM_CAPTURE_HALF) {
        this.limitBytes = limitBytes;
        this.halfBytes = halfBytes;
        this.totalBytes = 0;
        this.headChunks = [];
        this.headBytes = 0;
        this.tailChunks = [];
        this.tailBytes = 0;
    }

    push(chunk) {
        if (!chunk || chunk.length === 0) return;
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        this.totalBytes += buffer.length;
        let rest = buffer;
        if (this.headBytes < this.halfBytes) {
            const take = Math.min(buffer.length, this.halfBytes - this.headBytes);
            this.headChunks.push(buffer.subarray(0, take));
            this.headBytes += take;
            rest = buffer.subarray(take);
        }
        if (rest.length > 0) this.appendTail(rest);
    }

    appendTail(buffer) {
        this.tailChunks.push(buffer);
        this.tailBytes += buffer.length;
        while (this.tailBytes > this.halfBytes && this.tailChunks.length > 0) {
            const overflow = this.tailBytes - this.halfBytes;
            const first = this.tailChunks[0];
            if (first.length <= overflow) {
                this.tailChunks.shift();
                this.tailBytes -= first.length;
            } else {
                this.tailChunks[0] = first.subarray(overflow);
                this.tailBytes -= overflow;
            }
        }
    }

    finish() {
        const truncated = this.totalBytes > this.limitBytes;
        if (!truncated) {
            const all = Buffer.concat([...this.headChunks, ...this.tailChunks]);
            return { text: all.toString('utf8'), truncated: false, totalBytes: this.totalBytes };
        }
        return {
            head: Buffer.concat(this.headChunks).toString('utf8'),
            tail: Buffer.concat(this.tailChunks).toString('utf8'),
            truncated: true,
            totalBytes: this.totalBytes,
        };
    }
}

function formatCapture(capture, logPath) {
    const finished = capture.finish();
    if (!finished.truncated) {
        return { text: finished.text, truncated: false, totalBytes: finished.totalBytes };
    }
    const marker = `\n...[truncated: full log at ${logPath}]...\n`;
    return {
        text: `${finished.head}${marker}${finished.tail}`,
        truncated: true,
        totalBytes: finished.totalBytes,
    };
}

function spawnShellCommand(command, cwd, options) {
    const spawnOptions = {
        cwd,
        env: process.env,
        windowsHide: true,
        ...options,
    };
    if (IS_WINDOWS) {
        const comspec = process.env.ComSpec || 'cmd.exe';
        // cmd.exe /d /s /c strips the first and last quote of its command line.
        // Wrapping the command in one extra quote pair therefore preserves quoted
        // executable paths such as "C:\Program Files\nodejs\node.exe" "script.mjs".
        // windowsVerbatimArguments stops Node from backslash-escaping the inner
        // quotes (cmd.exe does not understand \" escapes, which breaks commands
        // containing quoted paths).
        return spawn(comspec, ['/d', '/s', '/c', `"${command}"`], {
            ...spawnOptions,
            windowsVerbatimArguments: true,
        });
    }
    return spawn('/bin/sh', ['-lc', command], spawnOptions);
}

function resolveShellCwd(args) {
    const raw = optionalStringArg(args, 'cwd');
    const cwd = raw && raw.trim().length > 0 ? resolveUserPath(raw) : os.homedir();
    let stat = null;
    try {
        stat = fs.statSync(cwd);
    } catch {
        throw new ToolError(`Working directory does not exist: ${cwd}`);
    }
    if (!stat.isDirectory()) {
        throw new ToolError(`Working directory is not a directory: ${cwd}`);
    }
    return cwd;
}

function resolveShellTimeout(args) {
    return optionalNumberArg(args, 'timeoutMs', {
        defaultValue: DEFAULT_SHELL_TIMEOUT_MS,
        min: 1,
        max: MAX_SHELL_TIMEOUT_MS,
    });
}

function newTimedId(prefix) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    return `${prefix}_${stamp}_${crypto.randomBytes(4).toString('hex')}`;
}

function isPidAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        // EPERM means the process exists but belongs to another user.
        return Boolean(error && error.code === 'EPERM');
    }
}

/** Kill an entire foreground process tree (Windows taskkill /T, POSIX group kill). */
function killProcessTree(child) {
    if (!child || !Number.isInteger(child.pid) || child.pid <= 0) return;
    const pid = child.pid;
    if (IS_WINDOWS) {
        try {
            const result = spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], {
                windowsHide: true,
                timeout: 10_000,
                encoding: 'utf8',
            });
            log.debug('taskkill finished', {
                pid,
                status: result.status,
                stderr: asTrimmedString(result.stderr),
            });
        } catch (error) {
            log.warn('taskkill failed', { pid, error: errorMessage(error) });
        }
        try {
            child.kill('SIGKILL');
        } catch {
            // already gone
        }
        return;
    }
    // POSIX: the child is spawned detached, so it leads its own process group.
    try {
        process.kill(-pid, 'SIGKILL');
    } catch (error) {
        log.debug('process group kill failed, falling back to child.kill', {
            pid,
            error: errorMessage(error),
        });
        try {
            child.kill('SIGKILL');
        } catch {
            // already gone
        }
    }
}

function runForegroundShell({ command, cwd, timeoutMs }) {
    return new Promise((resolve) => {
        const id = newTimedId('exec');
        const logPath = path.join(getLogsDir(), `${id}.log`);
        const logStream = fs.createWriteStream(logPath, { flags: 'w' });
        runtime.foregroundLogStreams.add(logStream);
        logStream.on('close', () => runtime.foregroundLogStreams.delete(logStream));
        logStream.on('error', (error) => {
            log.warn('foreground log stream error', { logPath, error: errorMessage(error) });
        });

        const stdoutCapture = new StreamCapture();
        const stderrCapture = new StreamCapture();
        const startedAt = Date.now();
        let child = null;
        let spawnError = null;
        let timedOut = false;
        let settled = false;
        let timeoutTimer = null;
        let forceFinishTimer = null;

        const finish = (exitCode, signal) => {
            if (settled) return;
            settled = true;
            if (timeoutTimer) clearTimeout(timeoutTimer);
            if (forceFinishTimer) clearTimeout(forceFinishTimer);
            const durationMs = Date.now() - startedAt;
            const stdout = formatCapture(stdoutCapture, logPath);
            const stderr = formatCapture(stderrCapture, logPath);
            const payload = {
                command,
                cwd,
                exitCode: exitCode === undefined ? null : exitCode,
                signal: signal || null,
                timedOut,
                durationMs,
                stdout: stdout.text,
                stderr: stderr.text,
                stdoutTruncated: stdout.truncated,
                stderrTruncated: stderr.truncated,
                logPath,
                bytes: { stdout: stdout.totalBytes, stderr: stderr.totalBytes },
            };
            if (spawnError) payload.error = errorMessage(spawnError);
            log.debug('foreground command finished', {
                command,
                exitCode: payload.exitCode,
                timedOut,
                durationMs,
            });
            let resolved = false;
            const done = () => {
                if (resolved) return;
                resolved = true;
                resolve(payload);
            };
            try {
                logStream.end(done);
            } catch {
                done();
            }
            // Safety net if the log stream callback never fires.
            const safety = setTimeout(done, 1000);
            if (typeof safety.unref === 'function') safety.unref();
        };

        try {
            child = spawnShellCommand(command, cwd, {
                detached: !IS_WINDOWS,
                stdio: ['ignore', 'pipe', 'pipe'],
            });
        } catch (error) {
            spawnError = error;
            finish(null, null);
            return;
        }

        child.stdout.on('data', (chunk) => {
            stdoutCapture.push(chunk);
            try {
                logStream.write(chunk);
            } catch {
                // log stream already closed; capture still works
            }
        });
        child.stderr.on('data', (chunk) => {
            stderrCapture.push(chunk);
            try {
                logStream.write(chunk);
            } catch {
                // log stream already closed; capture still works
            }
        });
        child.on('error', (error) => {
            spawnError = error;
            log.warn('shell spawn error', { command, error: errorMessage(error) });
            finish(null, null);
        });
        child.on('close', (code, signal) => finish(code, signal));

        timeoutTimer = setTimeout(() => {
            timedOut = true;
            log.warn('foreground command timed out, killing process tree', {
                command,
                timeoutMs,
                pid: child && child.pid,
            });
            killProcessTree(child);
            forceFinishTimer = setTimeout(() => finish(null, 'SIGKILL'), FOREGROUND_KILL_GRACE_MS);
        }, timeoutMs);
    });
}

function startBackgroundShell({ command, cwd }) {
    const id = newTimedId('bg');
    const logPath = path.join(getLogsDir(), `${id}.log`);
    let outFd = null;
    let errFd = null;
    let child = null;
    try {
        outFd = fs.openSync(logPath, 'a');
        errFd = fs.openSync(logPath, 'a');
        child = spawnShellCommand(command, cwd, {
            detached: true,
            stdio: ['ignore', outFd, errFd],
        });
    } catch (error) {
        throw new ToolError(`Failed to start background command: ${errorMessage(error)}`);
    } finally {
        // Parent copies of the handles are no longer needed; the child owns its own.
        if (outFd !== null) {
            try {
                fs.closeSync(outFd);
            } catch {
                // ignore
            }
        }
        if (errFd !== null) {
            try {
                fs.closeSync(errFd);
            } catch {
                // ignore
            }
        }
    }

    child.on('error', (error) => {
        log.warn('background shell spawn error', { command, error: errorMessage(error) });
    });
    try {
        child.unref();
    } catch {
        // ignore
    }
    const record = {
        id,
        pid: child.pid,
        command,
        cwd,
        logPath,
        startedAt: Date.now(),
    };
    runtime.backgroundProcesses.set(id, record);
    log.info('background command started', {
        id,
        pid: child.pid,
        logPath,
    });
    return {
        id,
        pid: child.pid,
        logPath,
        started: true,
        command,
        cwd,
        detached: true,
        note: 'Background process is detached and keeps running after the daemon exits.',
    };
}

async function handlePcExecShell(rawArgs) {
    const args = isPlainObject(rawArgs) ? rawArgs : {};
    const command = requireStringArg(args, 'command');
    const cwd = resolveShellCwd(args);
    const background = optionalBooleanArg(args, 'background', false);
    if (background) {
        return startBackgroundShell({ command, cwd });
    }
    const timeoutMs = resolveShellTimeout(args);
    return runForegroundShell({ command, cwd, timeoutMs });
}

// ---------------------------------------------------------------------------
// Filesystem tools
// ---------------------------------------------------------------------------

function assertReadableFile(filePath, label = 'File') {
    let stat = null;
    try {
        stat = fs.statSync(filePath);
    } catch {
        throw new ToolError(`${label} not found: ${filePath}`);
    }
    if (!stat.isFile()) {
        throw new ToolError(`${label} is not a regular file: ${filePath}`);
    }
    return stat;
}

function atomicWriteFile(filePath, content) {
    const directory = path.dirname(filePath);
    const tempPath = path.join(
        directory,
        `.${path.basename(filePath)}.ncode-tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`
    );
    try {
        fs.writeFileSync(tempPath, content, { encoding: 'utf8' });
        fs.renameSync(tempPath, filePath);
    } catch (error) {
        try {
            fs.unlinkSync(tempPath);
        } catch {
            // temp file may not exist
        }
        throw new ToolError(`Failed to write ${filePath}: ${errorMessage(error)}`);
    }
    try {
        return fs.statSync(filePath).size;
    } catch {
        return Buffer.byteLength(String(content), 'utf8');
    }
}

function splitDiffLines(text) {
    if (text === '') return [];
    const lines = text.split('\n');
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    return lines;
}

/** Minimal unified diff generator: ---/+++ headers, 3 context lines, @@ hunk. */
function generateUnifiedDiff(oldContent, newContent, filePath, contextLines = 3) {
    if (oldContent === newContent) return '';
    const oldLines = splitDiffLines(oldContent);
    const newLines = splitDiffLines(newContent);

    let prefix = 0;
    while (
        prefix < oldLines.length &&
        prefix < newLines.length &&
        oldLines[prefix] === newLines[prefix]
    ) {
        prefix += 1;
    }
    let suffix = 0;
    while (
        suffix < oldLines.length - prefix &&
        suffix < newLines.length - prefix &&
        oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
    ) {
        suffix += 1;
    }

    const oldChangeEnd = oldLines.length - suffix;
    const newChangeEnd = newLines.length - suffix;
    const beforeStart = Math.max(0, prefix - contextLines);
    const before = oldLines.slice(beforeStart, prefix);
    const removed = oldLines.slice(prefix, oldChangeEnd);
    const added = newLines.slice(prefix, newChangeEnd);
    const after = oldLines.slice(oldChangeEnd, Math.min(oldLines.length, oldChangeEnd + contextLines));

    const startLine = beforeStart + 1;
    const oldCount = before.length + removed.length + after.length;
    const newCount = before.length + added.length + after.length;
    const displayPath = filePath.replace(/\\/g, '/');

    const output = [
        `--- a/${displayPath}`,
        `+++ b/${displayPath}`,
        `@@ -${startLine},${oldCount} +${startLine},${newCount} @@`,
    ];
    for (const line of before) output.push(` ${line}`);
    for (const line of removed) output.push(`-${line}`);
    for (const line of added) output.push(`+${line}`);
    for (const line of after) output.push(` ${line}`);
    return output.join('\n');
}

async function handlePcFsRead(rawArgs) {
    const args = isPlainObject(rawArgs) ? rawArgs : {};
    const filePath = resolveUserPath(requireStringArg(args, 'filePath'));
    const startLine = optionalNumberArg(args, 'startLine', {
        defaultValue: 1,
        min: 1,
        integer: true,
    });
    const explicitEnd = optionalNumberArg(args, 'endLine', {
        defaultValue: null,
        min: 1,
        integer: true,
    });
    const stat = assertReadableFile(filePath);
    if (stat.size > 64 * 1024 * 1024) {
        throw new ToolError(
            `File is too large to read safely (${stat.size} bytes, limit 64 MB): ${filePath}`
        );
    }
    const buffer = fs.readFileSync(filePath);
    const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
    const nulIndex = sample.indexOf(0);
    if (nulIndex !== -1) {
        throw new ToolError(
            `File appears to be binary (NUL byte near offset ${nulIndex}); pc_fs_read only handles UTF-8 text: ${filePath}`
        );
    }
    const text = buffer.toString('utf8');
    const lines = text === '' ? [] : text.split(/\r?\n/);
    const totalLines = lines.length;
    const availableEnd = Math.min(explicitEnd === null ? totalLines : explicitEnd, totalLines);

    const rendered = [];
    let usedChars = 0;
    let truncated = false;
    let cursor = startLine;
    while (cursor <= availableEnd) {
        if (rendered.length >= READ_MAX_LINES) {
            truncated = true;
            break;
        }
        const lineText = `${cursor}| ${lines[cursor - 1]}`;
        if (usedChars + lineText.length + 1 > READ_MAX_CHARS) {
            truncated = true;
            break;
        }
        rendered.push(lineText);
        usedChars += lineText.length + 1;
        cursor += 1;
    }

    return {
        filePath,
        totalLines,
        startLine,
        endLine: rendered.length > 0 ? startLine + rendered.length - 1 : startLine,
        requestedEndLine: explicitEnd,
        lines: rendered.length,
        truncated,
        bytes: stat.size,
        content: rendered.join('\n'),
    };
}

async function handlePcFsWrite(rawArgs) {
    const args = isPlainObject(rawArgs) ? rawArgs : {};
    const filePath = resolveUserPath(requireStringArg(args, 'filePath'));
    const content = requireStringArg(args, 'content', { allowEmpty: true });
    const createDirs = optionalBooleanArg(args, 'createDirs', true);

    const existed = fs.existsSync(filePath);
    if (existed) {
        let existingStat = null;
        try {
            existingStat = fs.statSync(filePath);
        } catch {
            // treat as non-existent target; write will surface any real error
        }
        if (existingStat && existingStat.isDirectory()) {
            throw new ToolError(`Refusing to write: path is a directory: ${filePath}`);
        }
    }

    const parentDir = path.dirname(filePath);
    if (!fs.existsSync(parentDir)) {
        if (!createDirs) {
            throw new ToolError(
                `Parent directory does not exist: ${parentDir} (pass createDirs:true to create it).`
            );
        }
        try {
            ensureDir(parentDir);
        } catch (error) {
            throw new ToolError(`Failed to create parent directory ${parentDir}: ${errorMessage(error)}`);
        }
    }

    const bytes = atomicWriteFile(filePath, content);
    log.debug('file written', { filePath, bytes, created: !existed });
    return { filePath, bytes, created: !existed };
}

async function handlePcFsPatch(rawArgs) {
    const args = isPlainObject(rawArgs) ? rawArgs : {};
    const filePath = resolveUserPath(requireStringArg(args, 'filePath'));
    const searchBlock = requireStringArg(args, 'searchBlock');
    if (searchBlock.length === 0) {
        throw new ToolError('searchBlock must not be empty.');
    }
    const replaceBlock = requireStringArg(args, 'replaceBlock', { allowEmpty: true });

    assertReadableFile(filePath);
    let oldContent = '';
    try {
        oldContent = fs.readFileSync(filePath, 'utf8');
    } catch (error) {
        throw new ToolError(`Failed to read ${filePath}: ${errorMessage(error)}`);
    }

    let occurrences = 0;
    let firstIndex = -1;
    let searchFrom = 0;
    while (true) {
        const index = oldContent.indexOf(searchBlock, searchFrom);
        if (index === -1) break;
        occurrences += 1;
        if (firstIndex === -1) firstIndex = index;
        if (occurrences >= 1000) break;
        searchFrom = index + 1;
    }

    if (occurrences === 0) {
        throw new ToolError(
            `searchBlock not found in ${filePath}. Read the file with pc_fs_read and copy the exact literal text (whitespace and line endings must match).`
        );
    }
    if (occurrences > 1) {
        const countLabel = occurrences >= 1000 ? '1000+' : String(occurrences);
        throw new ToolError(
            `searchBlock matches ${countLabel} occurrences in ${filePath}; pc_fs_patch requires exactly one. Add more surrounding context to make the match unique.`
        );
    }

    const newContent =
        oldContent.slice(0, firstIndex) +
        replaceBlock +
        oldContent.slice(firstIndex + searchBlock.length);
    const changed = newContent !== oldContent;
    const bytes = changed ? atomicWriteFile(filePath, newContent) : fs.statSync(filePath).size;
    const diff = generateUnifiedDiff(oldContent, newContent, filePath);
    log.debug('file patched', { filePath, changed, bytes });
    return {
        filePath,
        occurrences: 1,
        bytes,
        changed,
        matchAtOffset: firstIndex,
        diff,
    };
}

// ---------------------------------------------------------------------------
// Code search tool (ripgrep when available, pure-Node walker otherwise)
// ---------------------------------------------------------------------------

function escapeRegExpChar(ch) {
    return /[.*+?^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
}

/** Translate a glob fragment into a regular-expression source string. */
function globFragmentToRegexSource(glob) {
    let source = '';
    for (let index = 0; index < glob.length; index += 1) {
        const ch = glob[index];
        if (ch === '*') {
            if (glob[index + 1] === '*') {
                index += 1;
                if (glob[index + 1] === '/') {
                    index += 1;
                    source += '(?:.*/)?';
                } else {
                    source += '.*';
                }
            } else {
                source += '[^/]*';
            }
        } else if (ch === '?') {
            source += '[^/]';
        } else if (ch === '{') {
            let depth = 1;
            let end = index + 1;
            while (end < glob.length && depth > 0) {
                if (glob[end] === '{') depth += 1;
                else if (glob[end] === '}') depth -= 1;
                end += 1;
            }
            if (depth > 0) {
                source += '\\{';
                continue;
            }
            const inner = glob.slice(index + 1, end - 1);
            const parts = [];
            let current = '';
            let braceDepth = 0;
            for (const innerChar of inner) {
                if (innerChar === '{') braceDepth += 1;
                else if (innerChar === '}') braceDepth -= 1;
                if (innerChar === ',' && braceDepth === 0) {
                    parts.push(current);
                    current = '';
                } else {
                    current += innerChar;
                }
            }
            parts.push(current);
            source += `(?:${parts.map((part) => globFragmentToRegexSource(part)).join('|')})`;
            index = end - 1;
        } else {
            source += escapeRegExpChar(ch);
        }
    }
    return source;
}

/** Compile a fileGlob into a predicate over a path relative to the search root. */
function compileGlob(glob) {
    const normalizedGlob = String(glob)
        .trim()
        .replace(/\\/g, '/')
        .replace(/^\.\//, '');
    if (!normalizedGlob) return null;
    let regex = null;
    try {
        regex = new RegExp(`^${globFragmentToRegexSource(normalizedGlob)}$`);
    } catch (error) {
        throw new ToolError(`Invalid fileGlob "${glob}": ${errorMessage(error)}`);
    }
    const basenameOnly = !normalizedGlob.includes('/');
    return (relativePath) => {
        const normalizedPath = relativePath.replace(/\\/g, '/');
        if (basenameOnly) return regex.test(path.posix.basename(normalizedPath));
        return regex.test(normalizedPath);
    };
}

let ripgrepAvailable = null;

function detectRipgrep() {
    if (ripgrepAvailable !== null) return ripgrepAvailable;
    try {
        const result = spawnSync('rg', ['--version'], {
            encoding: 'utf8',
            timeout: 5000,
            windowsHide: true,
        });
        ripgrepAvailable = !result.error && result.status === 0;
    } catch {
        ripgrepAvailable = false;
    }
    if (!ripgrepAvailable) {
        log.debug('ripgrep not installed; pc_search_code will use the pure-Node walker');
    }
    return ripgrepAvailable;
}

function searchWithRipgrep({ directory, pattern, fileGlob }) {
    const startedAt = Date.now();
    const args = [
        '--line-number',
        '--with-filename',
        '--no-messages',
        '--color',
        'never',
        '--max-count',
        String(SEARCH_MAX_MATCHES),
    ];
    if (fileGlob) args.push('--glob', fileGlob);
    args.push('--', pattern, directory);
    const result = spawnSync('rg', args, {
        encoding: 'utf8',
        timeout: SEARCH_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 32 * 1024 * 1024,
    });
    if (result.error || (result.status !== 0 && result.status !== 1)) {
        log.debug('ripgrep search failed, falling back to Node walker', {
            status: result.status,
            error: result.error ? errorMessage(result.error) : undefined,
        });
        return null;
    }
    const stdout = result.stdout || '';
    const outputLines = stdout.split('\n').filter((line) => line.length > 0);
    const matches = [];
    for (const line of outputLines) {
        const parsed = /^(.+?):(\d+):(.*)$/.exec(line);
        if (!parsed) continue;
        matches.push({ file: parsed[1], line: Number(parsed[2]), text: parsed[3] });
        if (matches.length >= SEARCH_MAX_MATCHES) break;
    }
    return {
        matches,
        count: matches.length,
        engine: 'rg',
        truncated: outputLines.length > SEARCH_MAX_MATCHES,
        directory,
        pattern,
        fileGlob: fileGlob || null,
        durationMs: Date.now() - startedAt,
    };
}

function searchWithNode({ directory, pattern, fileGlob }) {
    const startedAt = Date.now();
    const deadline = startedAt + SEARCH_TIMEOUT_MS;
    let matcher = null;
    try {
        matcher = new RegExp(pattern);
    } catch (error) {
        throw new ToolError(`Invalid regular expression "${pattern}": ${errorMessage(error)}`);
    }
    const globMatcher = fileGlob ? compileGlob(fileGlob) : null;
    const matches = [];
    let truncated = false;
    let timedOut = false;
    let truncatedReason = null;
    let scannedFiles = 0;
    let skippedFiles = 0;

    const walk = (currentDir) => {
        if (matches.length >= SEARCH_MAX_MATCHES) {
            truncated = true;
            truncatedReason = truncatedReason || 'match-cap';
            return;
        }
        if (Date.now() > deadline) {
            truncated = true;
            timedOut = true;
            truncatedReason = 'timeout';
            return;
        }
        let entries = [];
        try {
            entries = fs.readdirSync(currentDir, { withFileTypes: true });
        } catch (error) {
            log.debug('search: cannot read directory', {
                directory: currentDir,
                error: errorMessage(error),
            });
            return;
        }
        entries.sort((left, right) => left.name.localeCompare(right.name));
        for (const entry of entries) {
            if (matches.length >= SEARCH_MAX_MATCHES) {
                truncated = true;
                truncatedReason = truncatedReason || 'match-cap';
                return;
            }
            if (Date.now() > deadline) {
                truncated = true;
                timedOut = true;
                truncatedReason = 'timeout';
                return;
            }
            const entryPath = path.join(currentDir, entry.name);
            if (entry.isDirectory()) {
                if (SEARCH_SKIP_DIRS.has(entry.name)) continue;
                walk(entryPath);
                continue;
            }
            if (!entry.isFile()) continue; // symlinks/devices are skipped to avoid cycles
            const relativePath = path.relative(directory, entryPath);
            if (globMatcher && !globMatcher(relativePath)) continue;
            let stat = null;
            try {
                stat = fs.statSync(entryPath);
            } catch {
                skippedFiles += 1;
                continue;
            }
            if (stat.size > SEARCH_MAX_FILE_BYTES) {
                skippedFiles += 1;
                continue;
            }
            let content = '';
            try {
                content = fs.readFileSync(entryPath, 'utf8');
            } catch {
                skippedFiles += 1;
                continue;
            }
            if (content.indexOf('\u0000') !== -1) {
                skippedFiles += 1;
                continue;
            }
            scannedFiles += 1;
            const lines = content.split(/\r?\n/);
            for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
                if (matcher.test(lines[lineIndex])) {
                    matches.push({ file: entryPath, line: lineIndex + 1, text: lines[lineIndex] });
                    if (matches.length >= SEARCH_MAX_MATCHES) {
                        truncated = true;
                        truncatedReason = 'match-cap';
                        break;
                    }
                }
            }
        }
    };

    walk(directory);
    return {
        matches,
        count: matches.length,
        engine: 'node',
        truncated,
        timedOut,
        truncatedReason,
        scannedFiles,
        skippedFiles,
        directory,
        pattern,
        fileGlob: fileGlob || null,
        durationMs: Date.now() - startedAt,
    };
}

async function handlePcSearchCode(rawArgs) {
    const args = isPlainObject(rawArgs) ? rawArgs : {};
    const directory = resolveUserPath(requireStringArg(args, 'directory'));
    const pattern = requireStringArg(args, 'pattern');
    const fileGlobRaw = optionalStringArg(args, 'fileGlob');
    const fileGlob = fileGlobRaw && fileGlobRaw.trim().length > 0 ? fileGlobRaw.trim() : null;

    let directoryStat = null;
    try {
        directoryStat = fs.statSync(directory);
    } catch {
        throw new ToolError(`Directory not found: ${directory}`);
    }
    if (!directoryStat.isDirectory()) {
        throw new ToolError(`Not a directory: ${directory}`);
    }
    try {
        // Validate the pattern before choosing an engine so the error is consistent.
        new RegExp(pattern);
    } catch (error) {
        throw new ToolError(`Invalid regular expression "${pattern}": ${errorMessage(error)}`);
    }
    if (fileGlob) compileGlob(fileGlob); // validates the glob up-front

    if (detectRipgrep()) {
        const ripgrepResult = searchWithRipgrep({ directory, pattern, fileGlob });
        if (ripgrepResult) return ripgrepResult;
    }
    return searchWithNode({ directory, pattern, fileGlob });
}

// ---------------------------------------------------------------------------
// System info tool
// ---------------------------------------------------------------------------

function defaultShell() {
    if (IS_WINDOWS) return process.env.ComSpec || 'cmd.exe';
    return process.env.SHELL || '/bin/sh';
}

function probeCommandVersion(commandLine) {
    try {
        const result = IS_WINDOWS
            ? spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', commandLine], {
                  encoding: 'utf8',
                  timeout: 5000,
                  windowsHide: true,
              })
            : spawnSync('/bin/sh', ['-lc', commandLine], {
                  encoding: 'utf8',
                  timeout: 5000,
              });
        if (result.error || result.status !== 0) return null;
        const output = String(result.stdout || result.stderr || '').trim();
        if (!output) return null;
        return output.split(/\r?\n/)[0].trim() || null;
    } catch {
        return null;
    }
}

function countCheckpointFiles() {
    try {
        if (!fs.existsSync(runtime.workflowsDir)) return 0;
        return fs
            .readdirSync(runtime.workflowsDir)
            .filter((name) => name.endsWith('.json') && !name.startsWith('.')).length;
    } catch {
        return 0;
    }
}

function pruneBackgroundProcesses() {
    for (const [id, record] of runtime.backgroundProcesses) {
        if (!isPidAlive(record.pid)) runtime.backgroundProcesses.delete(id);
    }
}

function listBackgroundProcesses() {
    pruneBackgroundProcesses();
    return [...runtime.backgroundProcesses.values()].map((record) => ({
        id: record.id,
        pid: record.pid,
        command: record.command,
        logPath: record.logPath,
        startedAt: new Date(record.startedAt).toISOString(),
        alive: isPidAlive(record.pid),
    }));
}

async function handlePcSystemInfo() {
    return {
        platform: process.platform,
        release: os.release(),
        arch: process.arch,
        shell: defaultShell(),
        cwd: process.cwd(),
        homedir: os.homedir(),
        node: process.version,
        npm: probeCommandVersion('npm --version'),
        python: probeCommandVersion('python --version'),
        git: probeCommandVersion('git --version'),
        stateDir: runtime.stateDir,
        logsDir: runtime.logsDir,
        workflows: countCheckpointFiles(),
        backgroundProcesses: listBackgroundProcesses(),
        uptimeMs: Date.now() - runtime.startedAt,
        pid: process.pid,
    };
}

// ---------------------------------------------------------------------------
// Workflow checkpoint tools
// ---------------------------------------------------------------------------

function sanitizeWorkflowId(rawValue) {
    const workflowId = String(rawValue === undefined || rawValue === null ? '' : rawValue).trim();
    if (!workflowId) {
        throw new ToolError('workflowId is required.');
    }
    if (workflowId.length > CHECKPOINT_MAX_ID_LENGTH) {
        throw new ToolError(
            `workflowId is too long (${workflowId.length} chars, max ${CHECKPOINT_MAX_ID_LENGTH}).`
        );
    }
    if (!CHECKPOINT_ID_PATTERN.test(workflowId)) {
        throw new ToolError(
            'workflowId may only contain letters, digits, dots, underscores and dashes (no path separators).'
        );
    }
    if (workflowId === '.' || workflowId === '..' || /^\.+$/.test(workflowId) || workflowId.endsWith('.')) {
        throw new ToolError(`workflowId "${workflowId}" is not a valid file name.`);
    }
    return workflowId;
}

function checkpointFilePath(workflowId) {
    const directory = getWorkflowsDir();
    const filePath = path.join(directory, `${workflowId}.json`);
    if (path.resolve(path.dirname(filePath)) !== path.resolve(directory)) {
        throw new ToolError('Resolved checkpoint path escapes the workflow directory.');
    }
    return filePath;
}

async function handleWorkflowSaveCheckpoint(rawArgs) {
    const args = isPlainObject(rawArgs) ? rawArgs : {};
    const workflowId = sanitizeWorkflowId(requireStringArg(args, 'workflowId'));
    const checkpoint = args.checkpoint;
    if (!isPlainObject(checkpoint)) {
        throw new ToolError('Parameter "checkpoint" is required and must be a JSON object.');
    }
    const pretty = optionalBooleanArg(args, 'pretty', false);
    const savedAt = new Date().toISOString();
    let json = '';
    try {
        json = JSON.stringify({ savedAt, checkpoint }, null, pretty ? 2 : 0);
    } catch (error) {
        throw new ToolError(`Checkpoint is not JSON-serializable: ${errorMessage(error)}`);
    }
    const filePath = checkpointFilePath(workflowId);
    const bytes = atomicWriteFile(filePath, json);
    log.info('workflow checkpoint saved', { workflowId, bytes, path: filePath });
    return { workflowId, path: filePath, bytes, savedAt };
}

async function handleWorkflowLoadCheckpoint(rawArgs) {
    const args = isPlainObject(rawArgs) ? rawArgs : {};
    const workflowId = sanitizeWorkflowId(requireStringArg(args, 'workflowId'));
    const filePath = checkpointFilePath(workflowId);
    if (!fs.existsSync(filePath)) {
        throw new ToolError(
            `No checkpoint found for workflow "${workflowId}" (expected ${filePath}).`
        );
    }
    let parsed = null;
    try {
        parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (error) {
        throw new ToolError(
            `Checkpoint file for workflow "${workflowId}" is corrupt (invalid JSON): ${filePath}: ${errorMessage(error)}`
        );
    }
    if (!isPlainObject(parsed)) {
        throw new ToolError(
            `Checkpoint file for workflow "${workflowId}" is corrupt (expected a JSON object): ${filePath}`
        );
    }
    return {
        workflowId,
        checkpoint: parsed.checkpoint !== undefined ? parsed.checkpoint : parsed,
        savedAt: typeof parsed.savedAt === 'string' ? parsed.savedAt : null,
        path: filePath,
    };
}

async function handleWorkflowListCheckpoints() {
    const directory = getWorkflowsDir();
    let names = [];
    try {
        names = fs
            .readdirSync(directory)
            .filter((name) => name.endsWith('.json') && !name.startsWith('.'));
    } catch {
        names = [];
    }
    const checkpoints = [];
    for (const name of names.sort()) {
        const filePath = path.join(directory, name);
        const workflowId = name.slice(0, -'.json'.length);
        let bytes = 0;
        let savedAt = null;
        let corrupt = false;
        try {
            bytes = fs.statSync(filePath).size;
            const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            if (isPlainObject(parsed) && typeof parsed.savedAt === 'string') {
                savedAt = parsed.savedAt;
            }
        } catch {
            corrupt = true;
        }
        checkpoints.push({
            workflowId,
            savedAt,
            bytes,
            path: filePath,
            ...(corrupt ? { corrupt: true } : {}),
        });
    }
    checkpoints.sort((left, right) =>
        String(right.savedAt || '').localeCompare(String(left.savedAt || ''))
    );
    return { count: checkpoints.length, checkpoints, directory };
}

// ---------------------------------------------------------------------------
// ask_gemini_web tool (stdio mode only; relayed through the WebSocket bridge)
// ---------------------------------------------------------------------------

async function handleAskGeminiWeb(rawArgs) {
    if (!isAskToolEnabled()) {
        throw new ToolError('ask_gemini_web is only available when the daemon runs with --stdio.');
    }
    const args = isPlainObject(rawArgs) ? rawArgs : {};
    const prompt = requireStringArg(args, 'prompt');
    const timeoutMs = optionalNumberArg(args, 'timeoutMs', {
        defaultValue: ASK_DEFAULT_TIMEOUT_MS,
        min: 1,
        max: ASK_MAX_TIMEOUT_MS,
    });
    const startedAt = Date.now();
    const relayed = await relayAskToExtension(prompt, timeoutMs);
    return {
        text: relayed.text,
        requestId: relayed.requestId,
        chars: relayed.text.length,
        durationMs: Date.now() - startedAt,
        timeoutMs,
    };
}

// ---------------------------------------------------------------------------
// WebSocket bridge: RFC 6455 handshake + frame codec + Ncode/legacy adapter
// ---------------------------------------------------------------------------

function encodeWebSocketFrame(opcode, payloadInput) {
    const payload = Buffer.isBuffer(payloadInput)
        ? payloadInput
        : Buffer.from(payloadInput === undefined ? '' : String(payloadInput), 'utf8');
    const length = payload.length;
    let header = null;
    if (length < 126) {
        header = Buffer.from([0x80 | opcode, length]);
    } else if (length < 65536) {
        header = Buffer.alloc(4);
        header[0] = 0x80 | opcode;
        header[1] = 126;
        header.writeUInt16BE(length, 2);
    } else {
        header = Buffer.alloc(10);
        header[0] = 0x80 | opcode;
        header[1] = 127;
        header.writeBigUInt64BE(BigInt(length), 2);
    }
    return Buffer.concat([header, payload]);
}

function createWsClient(socket, request) {
    return {
        id: `ws_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
        socket,
        remoteAddress: socket.remoteAddress || null,
        remotePort: socket.remotePort || null,
        connectedAt: Date.now(),
        registered: false,
        role: null,
        name: null,
        version: null,
        protocol: 'unknown', // 'ncode' | 'legacy' | 'unknown'
        lastPongAt: Date.now(),
        missedPongs: 0,
        bytesIn: 0,
        bytesOut: 0,
        buffer: Buffer.alloc(0),
        closed: false,
        userAgent: typeof request?.headers?.['user-agent'] === 'string' ? request.headers['user-agent'] : null,
    };
}

function wsSendFrame(client, opcode, payload) {
    if (!client || client.closed) return false;
    const socket = client.socket;
    if (!socket || socket.destroyed || socket.writable === false) return false;
    try {
        const frame = encodeWebSocketFrame(opcode, payload);
        client.bytesOut += frame.length;
        socket.write(frame);
        return true;
    } catch (error) {
        log.debug('WebSocket write failed', { clientId: client.id, error: errorMessage(error) });
        return false;
    }
}

function wsSendJson(client, payload) {
    if (!client || client.closed) return false;
    let text = '';
    try {
        text = JSON.stringify(payload);
    } catch (error) {
        log.warn('could not serialize WebSocket payload', { error: errorMessage(error) });
        return false;
    }
    return wsSendFrame(client, 0x1, Buffer.from(text, 'utf8'));
}

function cleanupWsClient(client) {
    if (!client) return;
    if (runtime.wsClients.delete(client)) {
        log.info('WebSocket client disconnected', {
            id: client.id,
            role: client.role,
            name: client.name,
            uptimeMs: Date.now() - client.connectedAt,
        });
    }
    rejectPendingAsksForClient(client);
}

function wsCloseClient(client, code = 1000, reason = '') {
    if (!client || client.closed) return;
    client.closed = true;
    const reasonBuffer = Buffer.from(String(reason || ''), 'utf8').subarray(0, 120);
    const payload = Buffer.alloc(2 + reasonBuffer.length);
    payload.writeUInt16BE(code, 0);
    reasonBuffer.copy(payload, 2);
    try {
        if (client.socket && !client.socket.destroyed) {
            client.socket.write(encodeWebSocketFrame(0x8, payload));
        }
    } catch {
        // socket already dead
    }
    try {
        client.socket.end();
    } catch {
        // ignore
    }
    const destroyTimer = setTimeout(() => {
        try {
            client.socket.destroy();
        } catch {
            // ignore
        }
    }, 100);
    if (typeof destroyTimer.unref === 'function') destroyTimer.unref();
    cleanupWsClient(client);
}

function rejectPendingAsksForClient(client) {
    for (const [requestId, pending] of runtime.pendingAsks) {
        if (pending.client !== client) continue;
        runtime.pendingAsks.delete(requestId);
        clearTimeout(pending.timer);
        pending.reject(
            new Error(
                'The browser extension disconnected before answering ask_gemini_web. Reconnect the Ncode extension and retry.'
            )
        );
    }
}

function registerWsClient(client, { role, name, version, protocol }) {
    if (!client || client.closed) return;
    const wasRegistered = client.registered;
    client.registered = true;
    client.role = role || 'extension';
    if (name) client.name = name;
    if (version) client.version = version;
    if (protocol) client.protocol = protocol;
    client.lastPongAt = Date.now();
    client.missedPongs = 0;
    wsSendJson(client, {
        type: 'registered',
        ok: true,
        server: SERVER_NAME,
        role: client.role,
        protocol: client.protocol,
    });
    if (!wasRegistered) {
        log.info('WebSocket client registered', {
            id: client.id,
            role: client.role,
            name: client.name,
            version: client.version,
            protocol: client.protocol,
        });
    }
}

function looksLikeLegacyClient(message) {
    if (message.protocol === 'legacy') return true;
    const name = String(message.client || message.name || message.clientName || '').toLowerCase();
    return name.includes('gemini-browser') || name.includes('gemini_web_bridge');
}

function askResultFromWsMessage(message) {
    const requestId =
        asTrimmedString(message.id) ||
        asTrimmedString(message.requestId) ||
        asTrimmedString(message.queryId) ||
        null;
    const hasError = message.error !== undefined && message.error !== null;
    let text = '';
    if (typeof message.text === 'string') text = message.text;
    else if (typeof message.result === 'string') text = message.result;
    else if (isPlainObject(message.result) && typeof message.result.text === 'string') {
        text = message.result.text;
    }
    const errorText = hasError
        ? typeof message.error === 'string'
            ? message.error
            : safeSerialize(message.error)
        : 'The browser extension reported ok:false.';
    return {
        kind: 'ask_result',
        id: requestId,
        ok: message.ok !== false && !hasError,
        text: text || '',
        error: errorText,
    };
}

/**
 * Legacy protocol adapter (documented explicitly on purpose).
 *
 * Ncode native WebSocket protocol (the one the Ncode extension speaks):
 *   extension -> daemon : {type:'register', role:'extension', client:'ncode-extension', version:'1.0.0'}
 *   daemon -> extension : {type:'registered', ok:true, server:'ncode-pc-daemon'}
 *   daemon -> extension : {type:'ping', ts}            (every 20s)
 *   extension -> daemon : {type:'pong', ts}
 *   daemon -> extension : {type:'ask_gemini_web', id, prompt, timeoutMs}
 *   extension -> daemon : {type:'ask_gemini_web_result', id, ok, text|error}
 *
 * Legacy gemini-browser-mcp protocol (see legacy-bridge/server.js and
 * gemini-browser-mcp/chrome-extension/background.js), translated here:
 *   extension -> bridge : {action:'identify', role:'extension'}       -> register (legacy)
 *   extension -> bridge : {action:'ping'}                             -> liveness pong
 *   bridge    -> extension : {action:'ask', prompt, requestId}        <- ask (legacy)
 *   extension -> bridge : {text, requestId} or {action:'response', text, requestId}
 *                                                                     -> ask result
 *   asker     -> bridge : {action:'ask', prompt, requestId}           -> relay + reply
 *   bridge    -> asker     : {text, requestId}                        <- legacy reply
 * Older type-based dialects are accepted too:
 *   {type:'register', ...}, {type:'query', prompt, requestId}, {type:'response', text, requestId}.
 *
 * Everything is normalized into a small internal envelope:
 *   {kind:'register'|'pong'|'ask_result'|'legacy_ask'|'unknown', ...}
 */
function normalizeWsMessage(message, client) {
    if (!isPlainObject(message)) return null;

    if (message.type === 'register') {
        const role = asTrimmedString(message.role) || 'extension';
        const protocol = looksLikeLegacyClient(message) ? 'legacy' : 'ncode';
        return {
            kind: 'register',
            role,
            name:
                asTrimmedString(message.client) ||
                asTrimmedString(message.name) ||
                asTrimmedString(message.clientName) ||
                null,
            version: asTrimmedString(message.version) || null,
            protocol,
        };
    }

    if (message.action === 'identify' || message.type === 'identify') {
        return {
            kind: 'register',
            role: asTrimmedString(message.role) || 'extension',
            name:
                asTrimmedString(message.client) ||
                asTrimmedString(message.name) ||
                'legacy-gemini-extension',
            version: asTrimmedString(message.version) || null,
            protocol: 'legacy',
        };
    }

    if (message.type === 'pong') {
        return { kind: 'pong', ts: message.ts };
    }
    if (message.action === 'ping') {
        // Legacy extensions send {action:'ping'} as an application keepalive.
        return { kind: 'pong', ts: message.ts };
    }
    if (message.type === 'ping' && client && client.registered) {
        return { kind: 'pong', ts: message.ts };
    }

    if (message.type === 'ask_gemini_web_result') {
        return askResultFromWsMessage(message);
    }
    if (message.action === 'response') {
        return askResultFromWsMessage(message);
    }
    if (message.type === 'response' && (message.text !== undefined || message.error !== undefined)) {
        return askResultFromWsMessage(message);
    }
    if (
        message.action === undefined &&
        message.type === undefined &&
        (message.id !== undefined || message.requestId !== undefined) &&
        (typeof message.text === 'string' || message.error !== undefined)
    ) {
        // Bare legacy response shape from gemini-browser-mcp background.js
        return askResultFromWsMessage(message);
    }

    if (message.action === 'ask' && typeof message.prompt === 'string') {
        return {
            kind: 'legacy_ask',
            requestId: asTrimmedString(message.requestId) || asTrimmedString(message.id) || null,
            prompt: message.prompt,
            timeoutMs: Number(message.timeoutMs) || null,
        };
    }
    if ((message.type === 'query' || message.type === 'ask_gemini_web') && typeof message.prompt === 'string') {
        return {
            kind: 'legacy_ask',
            requestId:
                asTrimmedString(message.requestId) ||
                asTrimmedString(message.id) ||
                asTrimmedString(message.queryId) ||
                null,
            prompt: message.prompt,
            timeoutMs: Number(message.timeoutMs) || null,
        };
    }
    if (message.type === 'ask' && typeof message.prompt === 'string') {
        return {
            kind: 'legacy_ask',
            requestId: asTrimmedString(message.requestId) || asTrimmedString(message.id) || null,
            prompt: message.prompt,
            timeoutMs: Number(message.timeoutMs) || null,
        };
    }

    return { kind: 'unknown' };
}

function findExtensionClient() {
    const candidates = [];
    for (const client of runtime.wsClients) {
        if (client.closed || !client.registered) continue;
        if (client.role !== 'extension') continue;
        if (!client.socket || client.socket.destroyed || client.socket.writable === false) continue;
        candidates.push(client);
    }
    if (candidates.length === 0) return null;
    candidates.sort((left, right) => right.lastPongAt - left.lastPongAt);
    return candidates[0];
}

function waitForExtensionClient(deadline) {
    const existing = findExtensionClient();
    if (existing) return Promise.resolve(existing);
    const startedAt = Date.now();
    return new Promise((resolve, reject) => {
        const timer = setInterval(() => {
            const client = findExtensionClient();
            if (client) {
                finish(() => resolve(client));
                return;
            }
            if (runtime.shuttingDown) {
                finish(() => reject(new Error('Daemon is shutting down.')));
                return;
            }
            if (Date.now() >= deadline) {
                finish(() =>
                    reject(
                        new Error(
                            `No registered Ncode browser extension client is connected to ${getWsUrl()} (waited ${Date.now() - startedAt}ms). Load the Ncode extension in Chrome, open a gemini.google.com tab, and retry.`
                        )
                    )
                );
            }
        }, 200);
        const finish = (action) => {
            clearInterval(timer);
            runtime.extensionWaitTimers.delete(timer);
            action();
        };
        runtime.extensionWaitTimers.add(timer);
    });
}

function sendAskToExtension(client, requestId, prompt, timeoutMs) {
    let payload = null;
    if (client.protocol === 'legacy') {
        payload = { action: 'ask', requestId, prompt, timeoutMs };
    } else if (client.protocol === 'ncode') {
        payload = { type: 'ask_gemini_web', id: requestId, prompt, timeoutMs };
    } else {
        // Unknown dialect: include both shapes so legacy and Ncode readers work.
        payload = {
            type: 'ask_gemini_web',
            action: 'ask',
            id: requestId,
            requestId,
            prompt,
            timeoutMs,
        };
    }
    return wsSendJson(client, payload);
}

async function relayAskToExtension(prompt, timeoutMs, options = {}) {
    const deadline = Date.now() + timeoutMs;
    const client = findExtensionClient() || (await waitForExtensionClient(deadline));
    const requestedId = typeof options.requestId === 'string' ? options.requestId.trim() : '';
    const requestId =
        requestedId && !runtime.pendingAsks.has(requestedId)
            ? requestedId
            : `gem_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const remaining = Math.max(1, deadline - Date.now());
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            runtime.pendingAsks.delete(requestId);
            reject(
                new Error(
                    `ask_gemini_web timed out after ${timeoutMs}ms waiting for the browser extension to answer (request ${requestId}).`
                )
            );
        }, remaining);
        runtime.pendingAsks.set(requestId, { resolve, reject, timer, client });
        log.debug('relaying ask_gemini_web to extension', {
            requestId,
            clientId: client.id,
            protocol: client.protocol,
            promptChars: prompt.length,
        });
        const sent = sendAskToExtension(client, requestId, prompt, timeoutMs);
        if (!sent) {
            runtime.pendingAsks.delete(requestId);
            clearTimeout(timer);
            reject(
                new Error(
                    'Failed to send ask_gemini_web to the browser extension (socket closed or not writable).'
                )
            );
        }
    });
}

function settlePendingAsk(result) {
    if (!result.id) {
        log.warn('browser extension returned an ask result without an id; ignoring');
        return;
    }
    const pending = runtime.pendingAsks.get(result.id);
    if (!pending) {
        log.debug('ask result has no pending request', { requestId: result.id });
        return;
    }
    runtime.pendingAsks.delete(result.id);
    clearTimeout(pending.timer);
    if (result.ok) {
        pending.resolve({ text: result.text, requestId: result.id });
    } else {
        pending.reject(new Error(result.error || 'ask_gemini_web failed in the browser extension.'));
    }
}

async function handleLegacyAskRequest(client, request) {
    const requestId =
        request.requestId || `req_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
    const timeoutCandidate = Number(request.timeoutMs);
    const timeoutMs =
        Number.isFinite(timeoutCandidate) && timeoutCandidate > 0
            ? Math.min(timeoutCandidate, ASK_MAX_TIMEOUT_MS)
            : ASK_DEFAULT_TIMEOUT_MS;
    log.debug('legacy ask relay', { requestId, promptChars: request.prompt.length, timeoutMs });
    try {
        const relayed = await relayAskToExtension(request.prompt, timeoutMs, { requestId });
        wsSendJson(client, { text: relayed.text, requestId });
    } catch (error) {
        wsSendJson(client, {
            text: `Error: ${errorMessage(error)}`,
            requestId,
            error: true,
        });
    }
}

function handleWsTextMessage(client, text) {
    client.bytesIn += Buffer.byteLength(text, 'utf8');
    let parsed = null;
    try {
        parsed = JSON.parse(text);
    } catch {
        log.debug('ignoring non-JSON WebSocket message', { clientId: client.id });
        return;
    }
    const normalized = normalizeWsMessage(parsed, client);
    if (!normalized) return;

    if (!client.registered && normalized.kind === 'ask_result') {
        // Old gemini-browser-mcp extension never identifies itself; the legacy
        // bridge simply assumed the first connection was the extension.
        registerWsClient(client, {
            role: 'extension',
            name: 'legacy-unidentified',
            version: null,
            protocol: 'legacy',
        });
    }

    switch (normalized.kind) {
        case 'register':
            registerWsClient(client, normalized);
            break;
        case 'pong':
            client.lastPongAt = Date.now();
            client.missedPongs = 0;
            break;
        case 'ask_result':
            settlePendingAsk(normalized);
            break;
        case 'legacy_ask':
            if (client.registered && client.role === 'extension') {
                log.warn('registered extension sent an ask request; ignoring to avoid a relay loop', {
                    clientId: client.id,
                });
                break;
            }
            handleLegacyAskRequest(client, normalized).catch((error) => {
                log.error('legacy ask relay failed', { error: errorMessage(error) });
            });
            break;
        default:
            log.debug('unhandled WebSocket message type', { clientId: client.id });
    }
}

function wsProtocolError(client, code, reason) {
    log.warn('WebSocket protocol error', { clientId: client.id, code, reason });
    wsCloseClient(client, code, reason);
}

function handleWsFrameData(client, chunk) {
    if (client.closed || !chunk || chunk.length === 0) return;
    client.buffer = client.buffer.length === 0 ? chunk : Buffer.concat([client.buffer, chunk]);

    while (!client.closed) {
        const buffer = client.buffer;
        if (buffer.length < 2) return;

        const firstByte = buffer[0];
        const secondByte = buffer[1];
        const fin = (firstByte & 0x80) !== 0;
        const reserved = firstByte & 0x70;
        const opcode = firstByte & 0x0f;
        const masked = (secondByte & 0x80) !== 0;
        let payloadLength = secondByte & 0x7f;
        let offset = 2;

        if (reserved !== 0) {
            wsProtocolError(client, 1002, 'reserved frame bits must be zero');
            return;
        }
        if (payloadLength === 126) {
            if (buffer.length < 4) return;
            payloadLength = buffer.readUInt16BE(2);
            offset = 4;
        } else if (payloadLength === 127) {
            if (buffer.length < 10) return;
            const bigLength = buffer.readBigUInt64BE(2);
            if (bigLength > BigInt(WS_MAX_MESSAGE_BYTES)) {
                wsProtocolError(client, 1009, 'message exceeds 1 MB limit');
                return;
            }
            payloadLength = Number(bigLength);
            offset = 10;
        }
        if (payloadLength > WS_MAX_MESSAGE_BYTES) {
            wsProtocolError(client, 1009, 'message exceeds 1 MB limit');
            return;
        }
        if (!masked) {
            wsProtocolError(client, 1002, 'client-to-server frames must be masked');
            return;
        }
        const frameLength = offset + 4 + payloadLength;
        if (buffer.length < frameLength) return;

        const mask = buffer.subarray(offset, offset + 4);
        const payload = Buffer.allocUnsafe(payloadLength);
        for (let index = 0; index < payloadLength; index += 1) {
            payload[index] = buffer[offset + 4 + index] ^ mask[index % 4];
        }
        client.buffer = buffer.subarray(frameLength);

        if (!fin) {
            wsProtocolError(client, 1003, 'fragmented frames are not supported');
            return;
        }

        switch (opcode) {
            case 0x1:
                handleWsTextMessage(client, payload.toString('utf8'));
                break;
            case 0x2:
                wsProtocolError(client, 1003, 'binary frames are not supported');
                return;
            case 0x8: {
                let closeCode = 1000;
                let closeReason = '';
                if (payload.length >= 2) {
                    closeCode = payload.readUInt16BE(0);
                    closeReason = payload.subarray(2).toString('utf8');
                }
                log.debug('received WebSocket close frame', {
                    clientId: client.id,
                    closeCode,
                    closeReason,
                });
                try {
                    if (!client.socket.destroyed) {
                        client.socket.write(encodeWebSocketFrame(0x8, payload));
                    }
                } catch {
                    // ignore
                }
                client.closed = true;
                cleanupWsClient(client);
                try {
                    client.socket.end();
                } catch {
                    // ignore
                }
                return;
            }
            case 0x9:
                wsSendFrame(client, 0xa, payload); // pong echoes ping payload
                break;
            case 0xa:
                client.lastPongAt = Date.now();
                client.missedPongs = 0;
                break;
            default:
                wsProtocolError(client, 1002, `unsupported opcode ${opcode}`);
                return;
        }
    }
}

function handleWsUpgrade(request, socket, head) {
    socket.on('error', (error) => {
        log.debug('WebSocket upgrade socket error', { error: errorMessage(error) });
    });
    const key = request.headers['sec-websocket-key'];
    const upgradeHeader = String(request.headers.upgrade || '').toLowerCase();
    const connectionHeader = String(request.headers.connection || '').toLowerCase();
    if (
        request.method !== 'GET' ||
        upgradeHeader !== 'websocket' ||
        !key ||
        !connectionHeader.includes('upgrade')
    ) {
        try {
            socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
        } catch {
            // ignore
        }
        socket.destroy();
        return;
    }
    if (String(request.headers['sec-websocket-version'] || '') !== '13') {
        try {
            socket.write(
                'HTTP/1.1 426 Upgrade Required\r\nSec-WebSocket-Version: 13\r\nConnection: close\r\n\r\n'
            );
        } catch {
            // ignore
        }
        socket.destroy();
        return;
    }

    const accept = crypto
        .createHash('sha1')
        .update(`${key}${WS_GUID}`)
        .digest('base64');
    const handshake = [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${accept}`,
        '',
        '',
    ].join('\r\n');
    try {
        socket.write(handshake);
    } catch (error) {
        log.warn('WebSocket handshake write failed', { error: errorMessage(error) });
        socket.destroy();
        return;
    }
    socket.setNoDelay(true);
    socket.setTimeout(0);

    const client = createWsClient(socket, request);
    runtime.wsClients.add(client);
    runtime.wsSockets.add(socket);

    socket.on('close', () => {
        client.closed = true;
        cleanupWsClient(client);
        runtime.wsSockets.delete(socket);
    });
    socket.on('end', () => {
        try {
            socket.end();
        } catch {
            // ignore
        }
    });
    socket.on('data', (chunk) => handleWsFrameData(client, chunk));

    if (head && head.length > 0) handleWsFrameData(client, head);
    log.info('WebSocket client connected', {
        id: client.id,
        remote: `${socket.remoteAddress || '?'}:${socket.remotePort || '?'}`,
    });
}

function startWsHeartbeat() {
    const configured = Number(process.env.NCODE_WS_PING_MS || '');
    const intervalMs =
        Number.isFinite(configured) && configured >= 50 ? Math.floor(configured) : WS_PING_INTERVAL_MS;
    runtime.wsPingTimer = setInterval(() => {
        const now = Date.now();
        for (const client of [...runtime.wsClients]) {
            if (client.closed || !client.registered) continue;
            const silentMs = now - client.lastPongAt;
            if (silentMs >= intervalMs * WS_MAX_MISSED_PONGS) {
                log.warn('dropping WebSocket client after missed pongs', {
                    id: client.id,
                    silentMs,
                    intervalMs,
                });
                wsCloseClient(client, 1001, 'missed pong keepalives');
                continue;
            }
            client.missedPongs += 1;
            wsSendJson(client, { type: 'ping', ts: now });
        }
    }, intervalMs);
    if (typeof runtime.wsPingTimer.unref === 'function') runtime.wsPingTimer.unref();
    log.debug('WebSocket heartbeat started', { intervalMs });
}

// ---------------------------------------------------------------------------
// HTTP transport (Streamable HTTP MCP + health + CORS)
// ---------------------------------------------------------------------------

const CORS_ALLOW_HEADERS =
    'Content-Type, Accept, Authorization, MCP-Protocol-Version, MCP-Session-Id, Last-Event-ID, X-Requested-With';

function applyCorsHeaders(res) {
    try {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', CORS_ALLOW_HEADERS);
        res.setHeader('Access-Control-Expose-Headers', 'Content-Type');
        res.setHeader('Access-Control-Max-Age', '86400');
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Content-Type-Options', 'nosniff');
    } catch {
        // response already finished
    }
}

function sendJsonResponse(res, statusCode, payload, extraHeaders = undefined) {
    if (res.headersSent) {
        try {
            res.end();
        } catch {
            // ignore
        }
        return;
    }
    const body = JSON.stringify(payload === undefined ? null : payload);
    const headers = {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        ...(extraHeaders || {}),
    };
    try {
        res.writeHead(statusCode, headers);
        res.end(body);
    } catch (error) {
        log.warn('failed to write HTTP response', { statusCode, error: errorMessage(error) });
    }
}

function sendEmptyResponse(res, statusCode, extraHeaders = undefined) {
    if (res.headersSent) {
        try {
            res.end();
        } catch {
            // ignore
        }
        return;
    }
    try {
        res.writeHead(statusCode, { 'Content-Length': '0', ...(extraHeaders || {}) });
        res.end();
    } catch (error) {
        log.warn('failed to write empty HTTP response', { statusCode, error: errorMessage(error) });
    }
}

function readRequestRawBody(request) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let totalBytes = 0;
        let settled = false;

        const fail = (error) => {
            if (settled) return;
            settled = true;
            reject(error);
        };

        request.on('data', (chunk) => {
            if (settled) return;
            totalBytes += chunk.length;
            if (totalBytes > HTTP_MAX_BODY_BYTES) {
                const error = new Error('Request body exceeds the 16 MB limit.');
                error.code = 'BODY_TOO_LARGE';
                fail(error);
                return;
            }
            chunks.push(chunk);
        });
        request.on('end', () => {
            if (settled) return;
            settled = true;
            resolve(Buffer.concat(chunks));
        });
        request.on('error', (error) => fail(error));
        request.on('aborted', () => fail(new Error('Request aborted by client.')));
    });
}

async function handleHttpMcpPost(request, response) {
    let raw = null;
    try {
        raw = await readRequestRawBody(request);
    } catch (error) {
        if (error && error.code === 'BODY_TOO_LARGE') {
            sendJsonResponse(
                response,
                413,
                jsonRpcError(null, -32600, 'Invalid Request: body exceeds the 16 MB limit.')
            );
        } else {
            sendJsonResponse(
                response,
                400,
                jsonRpcError(null, -32700, `Parse error: could not read request body (${errorMessage(error)}).`)
            );
        }
        return;
    }

    const text = raw.toString('utf8').trim();
    if (!text) {
        sendJsonResponse(response, 400, jsonRpcError(null, -32700, 'Parse error: empty request body.'));
        return;
    }

    let parsed = null;
    try {
        parsed = JSON.parse(text);
    } catch (error) {
        sendJsonResponse(
            response,
            400,
            jsonRpcError(null, -32700, `Parse error: ${errorMessage(error)}`)
        );
        return;
    }

    const outcome = await handleMcpPayload(parsed);
    if (outcome.kind === 'notification') {
        sendEmptyResponse(response, 202);
        return;
    }
    if (outcome.kind === 'invalid') {
        sendJsonResponse(response, 400, outcome.response);
        return;
    }
    if (outcome.kind === 'batch') {
        sendJsonResponse(response, 200, outcome.responses);
        return;
    }
    const isInvalidRequest =
        outcome.response &&
        outcome.response.error &&
        (outcome.response.error.code === -32600 || outcome.response.error.code === -32700);
    sendJsonResponse(response, isInvalidRequest ? 400 : 200, outcome.response);
}

async function handleHttpRequest(request, response) {
    applyCorsHeaders(response);

    if (request.method === 'OPTIONS') {
        sendEmptyResponse(response, 204);
        return;
    }

    let url = null;
    try {
        url = new URL(request.url || '/', 'http://localhost');
    } catch {
        sendJsonResponse(response, 400, { ok: false, error: 'bad request url' });
        return;
    }
    const pathname = url.pathname.replace(/\/+$/, '') || '/';

    if (pathname === '/mcp') {
        if (request.method === 'POST') {
            await handleHttpMcpPost(request, response);
            return;
        }
        if (request.method === 'DELETE') {
            // Stateless server: nothing to terminate, always fine.
            sendJsonResponse(response, 200, {});
            return;
        }
        if (request.method === 'GET') {
            sendJsonResponse(
                response,
                405,
                jsonRpcError(
                    null,
                    -32000,
                    'Method Not Allowed: this stateless MCP endpoint does not expose a GET SSE stream. Use POST /mcp.'
                ),
                { Allow: 'POST, DELETE, OPTIONS' }
            );
            return;
        }
        sendJsonResponse(response, 405, jsonRpcError(null, -32000, 'Method Not Allowed'), {
            Allow: 'POST, DELETE, OPTIONS',
        });
        return;
    }

    if (pathname === '/health') {
        if (request.method !== 'GET' && request.method !== 'HEAD') {
            sendJsonResponse(response, 405, { ok: false, error: 'method not allowed' }, {
                Allow: 'GET, HEAD, OPTIONS',
            });
            return;
        }
        const payload = {
            ok: true,
            name: SERVER_NAME,
            version: SERVER_VERSION,
            uptimeMs: Date.now() - runtime.startedAt,
            tools: countTools(),
        };
        if (request.method === 'HEAD') {
            sendEmptyResponse(response, 200);
            return;
        }
        sendJsonResponse(response, 200, payload);
        return;
    }

    if (pathname === '/') {
        sendJsonResponse(response, 200, {
            ok: true,
            name: SERVER_NAME,
            version: SERVER_VERSION,
            transport: 'streamable-http',
            stateless: true,
            endpoints: { mcp: '/mcp', health: '/health' },
            tools: listToolDefinitions().map((definition) => definition.name),
        });
        return;
    }

    sendJsonResponse(response, 404, {
        ok: false,
        error: 'not found',
        endpoints: ['/mcp', '/health'],
    });
}

// ---------------------------------------------------------------------------
// Listener helpers
// ---------------------------------------------------------------------------

function trackServerSockets(server, socketSet) {
    server.on('connection', (socket) => {
        socketSet.add(socket);
        socket.on('close', () => socketSet.delete(socket));
        socket.on('error', (error) => {
            log.debug('socket error', { error: errorMessage(error) });
        });
    });
}

function listenServer(server, host, port) {
    return new Promise((resolve, reject) => {
        const onError = (error) => {
            server.removeListener('listening', onListening);
            reject(error);
        };
        const onListening = () => {
            server.removeListener('error', onError);
            resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, host);
    });
}

async function startHttpMcpServer(config) {
    const server = http.createServer((request, response) => {
        handleHttpRequest(request, response).catch((error) => {
            log.error('HTTP request handler crashed', {
                error: error && error.stack ? error.stack : errorMessage(error),
            });
            try {
                sendJsonResponse(response, 500, { ok: false, error: 'internal daemon error' });
            } catch {
                // response already gone
            }
        });
    });
    server.on('clientError', (error, socket) => {
        log.debug('HTTP client error', { error: errorMessage(error) });
        try {
            if (socket && !socket.destroyed) {
                socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
            }
        } catch {
            // ignore
        }
    });
    trackServerSockets(server, runtime.httpSockets);
    await listenServer(server, config.host, config.httpPort);
    server.on('error', (error) => {
        log.error('HTTP server error after startup', { error: errorMessage(error) });
    });
    log.debug('HTTP MCP listener started', {
        host: config.host,
        port: server.address().port,
    });
    return server;
}

function handleWsBridgeHttpRequest(request, response) {
    applyCorsHeaders(response);
    if (request.method === 'OPTIONS') {
        sendEmptyResponse(response, 204);
        return;
    }
    let pathname = '/';
    try {
        pathname = new URL(request.url || '/', 'http://localhost').pathname.replace(/\/+$/, '') || '/';
    } catch {
        pathname = '/';
    }
    if (request.method === 'GET' && (pathname === '/health' || pathname === '/')) {
        sendJsonResponse(response, 200, {
            ok: true,
            name: SERVER_NAME,
            version: SERVER_VERSION,
            uptimeMs: Date.now() - runtime.startedAt,
            tools: countTools(),
            ws: {
                clients: runtime.wsClients.size,
                extensionConnected: Boolean(findExtensionClient()),
            },
        });
        return;
    }
    sendJsonResponse(response, 404, {
        ok: false,
        error: 'not found',
        hint: 'Open a WebSocket upgrade connection to use the Ncode bridge.',
        endpoints: ['/health'],
    });
}

async function startWsBridgeServer(config) {
    const server = http.createServer((request, response) => {
        try {
            handleWsBridgeHttpRequest(request, response);
        } catch (error) {
            log.error('WS bridge HTTP handler crashed', { error: errorMessage(error) });
            try {
                sendJsonResponse(response, 500, { ok: false, error: 'internal daemon error' });
            } catch {
                // ignore
            }
        }
    });
    server.on('upgrade', (request, socket, head) => {
        try {
            handleWsUpgrade(request, socket, head);
        } catch (error) {
            log.error('WebSocket upgrade crashed', {
                error: error && error.stack ? error.stack : errorMessage(error),
            });
            try {
                socket.destroy();
            } catch {
                // ignore
            }
        }
    });
    server.on('clientError', (error, socket) => {
        log.debug('WS bridge client error', { error: errorMessage(error) });
        try {
            if (socket && !socket.destroyed) socket.destroy();
        } catch {
            // ignore
        }
    });
    trackServerSockets(server, runtime.wsSockets);
    await listenServer(server, config.host, config.wsPort);
    server.on('error', (error) => {
        log.error('WebSocket server error after startup', { error: errorMessage(error) });
    });
    startWsHeartbeat();
    log.debug('WebSocket bridge listener started', {
        host: config.host,
        port: server.address().port,
    });
    return server;
}

// ---------------------------------------------------------------------------
// stdio transport
// ---------------------------------------------------------------------------

function writeStdioResponse(payload) {
    let text = '';
    try {
        text = JSON.stringify(payload);
    } catch (error) {
        log.error('failed to serialize stdio JSON-RPC response', { error: errorMessage(error) });
        return;
    }
    try {
        process.stdout.write(`${text}\n`);
    } catch (error) {
        log.error('failed to write stdio JSON-RPC response', { error: errorMessage(error) });
    }
}

function startStdioTransport() {
    runtime.stdioActive = true;
    const iface = readline.createInterface({
        input: process.stdin,
        output: undefined,
        terminal: false,
        crlfDelay: Infinity,
    });
    runtime.stdioInterface = iface;

    iface.on('line', (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        let parsed = null;
        try {
            parsed = JSON.parse(trimmed);
        } catch (error) {
            writeStdioResponse(jsonRpcError(null, -32700, `Parse error: ${errorMessage(error)}`));
            return;
        }
        handleMcpPayload(parsed)
            .then((outcome) => {
                if (outcome.kind === 'notification') return;
                if (outcome.kind === 'invalid') {
                    writeStdioResponse(outcome.response);
                    return;
                }
                if (outcome.kind === 'batch') {
                    if (outcome.responses.length > 0) writeStdioResponse(outcome.responses);
                    return;
                }
                writeStdioResponse(outcome.response);
            })
            .catch((error) => {
                log.error('stdio JSON-RPC handling crashed', {
                    error: error && error.stack ? error.stack : errorMessage(error),
                });
                writeStdioResponse(
                    jsonRpcError(null, -32603, `Internal error: ${errorMessage(error)}`)
                );
            });
    });

    iface.on('close', () => {
        log.debug('stdio input closed');
        shutdown('stdin closed', 0);
    });

    process.stdin.on('error', (error) => {
        log.warn('stdin error', { error: errorMessage(error) });
        shutdown('stdin error', 0);
    });

    process.stdout.on('error', (error) => {
        const message = `${error && error.code ? error.code : ''} ${errorMessage(error)}`;
        if (/EPIPE/i.test(message)) {
            shutdown('stdout EPIPE', 0);
            return;
        }
        log.warn('stdout error', { error: errorMessage(error) });
    });

    log.info('stdio MCP transport ready (stdout reserved for JSON-RPC)');
}

// ---------------------------------------------------------------------------
// Background process registry/sweep, shutdown and process guards
// ---------------------------------------------------------------------------

function startBackgroundSweep() {
    runtime.bgSweepTimer = setInterval(() => {
        pruneBackgroundProcesses();
    }, 60_000);
    if (typeof runtime.bgSweepTimer.unref === 'function') runtime.bgSweepTimer.unref();
}

function closeServer(server, socketSet) {
    if (!server) return;
    try {
        server.close();
    } catch {
        // ignore
    }
    for (const socket of [...socketSet]) {
        try {
            socket.destroy();
        } catch {
            // ignore
        }
    }
    socketSet.clear();
}

function shutdown(reason, exitCode = 0) {
    if (runtime.shuttingDown) {
        if (exitCode !== 0) runtime.exitCode = exitCode;
        return;
    }
    runtime.shuttingDown = true;
    runtime.shutdownReason = reason;
    runtime.exitCode = exitCode;
    log.info(`shutting down (${reason})`);

    if (runtime.wsPingTimer) {
        clearInterval(runtime.wsPingTimer);
        runtime.wsPingTimer = null;
    }
    if (runtime.bgSweepTimer) {
        clearInterval(runtime.bgSweepTimer);
        runtime.bgSweepTimer = null;
    }
    for (const timer of runtime.extensionWaitTimers) clearInterval(timer);
    runtime.extensionWaitTimers.clear();

    for (const [requestId, pending] of runtime.pendingAsks) {
        clearTimeout(pending.timer);
        pending.reject(new Error('Daemon is shutting down before the browser extension answered.'));
        runtime.pendingAsks.delete(requestId);
    }

    for (const client of [...runtime.wsClients]) {
        wsCloseClient(client, 1001, 'daemon shutting down');
    }
    for (const stream of runtime.foregroundLogStreams) {
        try {
            stream.end();
        } catch {
            // ignore
        }
    }
    runtime.foregroundLogStreams.clear();

    // Background children are intentionally left running (they are detached and
    // owned by the user, not by the daemon lifetime).
    if (runtime.stdioInterface) {
        try {
            runtime.stdioInterface.close();
        } catch {
            // ignore
        }
        runtime.stdioInterface = null;
    }

    closeServer(runtime.httpServer, runtime.httpSockets);
    closeServer(runtime.wsServer, runtime.wsSockets);
    runtime.httpServer = null;
    runtime.wsServer = null;

    // Deliberately referenced timer: graceful shutdown must always terminate the
    // daemon even if a foreground command pipe or similar handle is still open.
    setTimeout(() => process.exit(runtime.exitCode), 150);
    process.exitCode = runtime.exitCode;
}

function installProcessGuards() {
    process.on('uncaughtException', (error) => {
        log.error('uncaughtException (daemon stays alive unless EPIPE)', {
            error: error && error.stack ? error.stack : errorMessage(error),
        });
        const message = `${error && error.code ? error.code : ''} ${errorMessage(error)}`;
        if (/EPIPE/i.test(message)) shutdown('EPIPE in uncaughtException', 0);
    });
    process.on('unhandledRejection', (reason) => {
        log.error('unhandledRejection', {
            reason: reason && reason.stack ? reason.stack : safeSerialize(reason),
        });
    });
    process.on('SIGINT', () => shutdown('SIGINT', 0));
    process.on('SIGTERM', () => shutdown('SIGTERM', 0));
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

async function main(argv = process.argv.slice(2)) {
    let config = null;
    try {
        config = parseCliArgs(argv);
    } catch (error) {
        log.error(errorMessage(error));
        process.stderr.write(`${USAGE}\n`);
        process.exitCode = 2;
        return null;
    }
    if (config.help) {
        process.stderr.write(`${USAGE}\n`);
        return null;
    }

    initRuntimePaths(config);
    installProcessGuards();
    startBackgroundSweep();

    try {
        if (config.http) {
            runtime.httpServer = await startHttpMcpServer(config);
            runtime.actualHttpPort = runtime.httpServer.address().port;
        }
        if (config.ws) {
            runtime.wsServer = await startWsBridgeServer(config);
            runtime.actualWsPort = runtime.wsServer.address().port;
        }
    } catch (error) {
        log.error('fatal startup error', {
            error: error && error.stack ? error.stack : errorMessage(error),
        });
        if (error && error.code === 'EADDRINUSE') {
            log.error(
                `port already in use (http=${config.http ? config.httpPort : 'off'}, ws=${
                    config.ws ? config.wsPort : 'off'
                }). Stop the other daemon instance or pass --http-port/--ws-port.`
            );
        }
        runtime.shuttingDown = false;
        shutdown('startup failure', 1);
        return null;
    }

    // The one machine-readable startup banner (always the first line after the
    // listeners are bound). All other logs are debug-gated or happen later.
    process.stderr.write(`${getBannerLine()}\n`);

    if (config.stdio) {
        startStdioTransport();
    }

    log.debug('daemon ready', {
        host: config.host,
        http: config.http ? runtime.actualHttpPort : null,
        ws: config.ws ? runtime.actualWsPort : null,
        stdio: config.stdio,
        stateDir: runtime.stateDir,
    });
    return runtime;
}

const isMainModule = (() => {
    try {
        if (!process.argv[1]) return false;
        return path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
    } catch {
        return false;
    }
})();

if (isMainModule) {
    main().catch((error) => {
        log.error('fatal main() rejection', {
            error: error && error.stack ? error.stack : errorMessage(error),
        });
        process.exit(1);
    });
}

export {
    main,
    parseCliArgs,
    handleMcpMessage,
    handleMcpPayload,
    listToolDefinitions,
    invokeTool,
    encodeWebSocketFrame,
    normalizeWsMessage,
    generateUnifiedDiff,
    compileGlob,
    SERVER_NAME,
    SERVER_VERSION,
};
