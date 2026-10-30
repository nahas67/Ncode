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
 * PC harness tools:
 *   shell ........... pc_exec_shell (stateful per-workflowId cwd/env + builtins),
 *                     pc_shell_session (info|reset|list), pc_bg_process
 *                     (detached start/status/logs/kill/list with a persisted registry)
 *   filesystem ...... pc_fs_read, pc_fs_write, pc_fs_patch, pc_fs_tree
 *                     (gitignore-aware), pc_search_code (regex + context)
 *   git ............. pc_git_status, pc_git_diff, pc_git_status_diff, pc_git_add,
 *                     pc_git_commit, pc_git_checkout, pc_git_log (argv spawns only)
 *   desktop ......... pc_desktop_screenshot, pc_clipboard (OS-native CLIs)
 *   system .......... pc_system_info
 *   workflow ........ workflow_save_checkpoint, workflow_load_checkpoint,
 *                     workflow_list_checkpoints
 *   browser relay ... ask_gemini_web (stdio mode only)
 *
 * State survives restarts under <stateDir> (default ~/.ncode):
 *   workflows/<workflowId>.json   durable checkpoints
 *   shell-sessions.json           per-workflow cwd + env + pushd stack
 *   bg-processes.json             background process registry (status/kill after restart)
 *   bg-runner.mjs                 generated Windows detached-log launcher
 *   logs/<id>.log                 foreground output and background process logs
 *   screenshots/                  default screenshot destination
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

const SHELL_SESSIONS_FILE = 'shell-sessions.json';
const SHELL_SESSION_MAX_ENV_ENTRIES = 256;
const SHELL_SESSION_MAX_ENV_BYTES = 256 * 1024;
const SHELL_SESSION_MAX_PUSHD = 32;
const SHELL_SESSION_MAX_SESSIONS = 200;

const BACKGROUND_REGISTRY_FILE = 'bg-processes.json';
const BG_RUNNER_FILE = 'bg-runner.mjs';
const BG_LOG_TAIL_MAX_BYTES = 64 * 1024;
const BG_LOG_TAIL_DEFAULT_BYTES = 64 * 1024;
const BG_SWEEP_INTERVAL_MS = 60_000;
const BG_KILL_WAIT_MS = 3_000;
const BG_KILL_POLL_MS = 100;

const FS_TREE_DEFAULT_DEPTH = 4;
const FS_TREE_MAX_DEPTH = 12;
const FS_TREE_DEFAULT_MAX_ENTRIES = 2_000;
const FS_TREE_MAX_ENTRIES = 20_000;

const SEARCH_MAX_CONTEXT_LINES = 10;
const SEARCH_MAX_RESULTS = 200;

const GIT_TIMEOUT_MS = 30_000;
const GIT_MAX_BUFFER = 64 * 1024 * 1024;
const GIT_MAX_DIFF_CHARS = 200 * 1024;
const GIT_DEFAULT_LOG_COUNT = 20;
const GIT_MAX_LOG_COUNT = 100;
const GIT_MAX_STATUS_CHANGES = 5_000;

const OS_CLI_TIMEOUT_MS = 60_000;
const SCREENSHOT_MAX_BYTES = 64 * 1024 * 1024;
const SCREENSHOT_DIR_NAME = 'screenshots';
const CLIPBOARD_MAX_BYTES = 4 * 1024 * 1024;
const PNG_SIGNATURE_HEX = '89504e470d0a1a0a';

const MCP_INSTRUCTIONS = [
    `Ncode PC harness daemon ${SERVER_VERSION} (${SERVER_NAME}).`,
    'This local daemon gives you a real shell, filesystem, git and desktop on the user machine plus durable workflow state.',
    '',
    'Workflow:',
    '1. Inspect the machine with pc_system_info, then run commands with pc_exec_shell. Pass the same workflowId on every shell call: cwd and exported env vars persist per workflowId, and cd/export/set/pushd/popd/pwd/unset are executed against the session state without spawning (so `cd src` sticks). Omit workflowId for a stateless one-shot command.',
    '2. Inspect sessions with pc_shell_session {action:"info"|"reset"|"list"}. Long-running servers, watchers and dev loops belong in pc_bg_process {action:"start"} which returns {id, pid, logPath}; poll it with status/logs (bounded 64 KB tails) and stop it with kill (whole process tree). Its registry survives daemon restarts.',
    '3. Use pc_fs_tree (gitignore-aware) to map a project, pc_fs_read / pc_fs_write / pc_fs_patch for surgical file edits (patch requires exactly one literal match), and pc_search_code for regex search with optional contextLines/maxResults/caseInsensitive.',
    '4. Use the git suite for version control: pc_git_status, pc_git_diff, pc_git_status_diff (status + diff + recent commits), pc_git_add, pc_git_commit, pc_git_checkout, pc_git_log. All git commands are spawned as argv arrays, never interpolated shell strings.',
    '5. Use pc_desktop_screenshot for the screen and pc_clipboard {action:"read"|"write"} for text clipboard access when a task needs computer use; both degrade with clear errors on headless machines.',
    '6. After every meaningful step call workflow_save_checkpoint with a concrete checkpoint object ({plan, step, done, pending, notes, files, lastCommand}).',
    '7. After a restart, context reset or hand-off, call workflow_load_checkpoint to resume exactly where you stopped instead of redoing work.',
    '',
    'Durability rules: checkpoints live under ~/.ncode/workflows/<workflowId>.json (or NCODE_STATE_DIR/workflows), shell sessions in ~/.ncode/shell-sessions.json and background process records in ~/.ncode/bg-processes.json. They are atomic writes, survive daemon restarts, and are listed by the matching tools. Save often, and never assume in-memory state survives a restart.',
    '',
    'Shell notes: long output is truncated per stream to 32 KB (head+tail) with a pointer to the full log in ~/.ncode/logs. Foreground timeouts kill the whole process tree. Background commands are detached and keep running after the daemon exits by design.',
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
            'Run a shell command on the user PC (Windows: cmd.exe; macOS/Linux: /bin/sh -lc). Pass workflowId to get a stateful session: cwd and exported env vars persist across calls, and the cd/chdir/pushd/popd/export/set/unset/pwd builtins are executed against the session without spawning a shell (so `cd src` sticks). Without workflowId the call is fully stateless. Foreground captures stdout/stderr/exitCode with 32 KB head+tail truncation and a pointer to the full log; background=true registers a detached process that survives daemon exit. Timeouts kill the whole process tree.',
        inputSchema: schema(
            {
                command: { type: 'string', description: 'Shell command line to execute.' },
                workflowId: {
                    type: 'string',
                    description:
                        'Optional workflow/session id (letters, digits, dot, underscore, dash). Enables persistent cwd + env across calls. Reject path separators.',
                },
                cwd: {
                    type: 'string',
                    description:
                        'Working directory (supports ~). Defaults to the session cwd when workflowId is given, otherwise the user home directory; must exist. With workflowId it also becomes the session cwd.',
                },
                env: {
                    type: 'object',
                    description:
                        'Optional environment variable overrides for this call (string values; numbers/booleans are coerced). With workflowId they persist in the session env; pass null to remove a variable.',
                    additionalProperties: { type: 'string' },
                },
                timeoutMs: {
                    type: 'number',
                    description: `Foreground timeout in ms (default ${DEFAULT_SHELL_TIMEOUT_MS}, max ${MAX_SHELL_TIMEOUT_MS}).`,
                    minimum: 1,
                    maximum: MAX_SHELL_TIMEOUT_MS,
                },
                background: {
                    type: 'boolean',
                    description:
                        'Spawn detached in the background and return {id, pid, logPath, started:true}; manage it with pc_bg_process.',
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
            'Recursively search a directory with a JavaScript regular expression. Uses ripgrep when available, otherwise a pure-Node walker that skips node_modules/.git/dist/artifacts/build. Supports fileGlob (*.js, **/*.ts, {a,b}), caseInsensitive and contextLines (surrounding lines per match), capped at maxResults (default 200).',
        inputSchema: schema(
            {
                directory: { type: 'string', description: 'Directory to search (supports ~).' },
                pattern: { type: 'string', description: 'JavaScript regular expression.' },
                fileGlob: {
                    type: 'string',
                    description: 'Optional file glob filter, e.g. *.js or **/*.ts.',
                },
                caseInsensitive: {
                    type: 'boolean',
                    description: 'Match case-insensitively (default false).',
                },
                contextLines: {
                    type: 'number',
                    description: `Surrounding context lines per match (0-${SEARCH_MAX_CONTEXT_LINES}, default 0).`,
                    minimum: 0,
                    maximum: SEARCH_MAX_CONTEXT_LINES,
                },
                maxResults: {
                    type: 'number',
                    description: `Maximum matches to return (1-${SEARCH_MAX_RESULTS}, default ${SEARCH_MAX_RESULTS}).`,
                    minimum: 1,
                    maximum: SEARCH_MAX_RESULTS,
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
    {
        name: 'pc_fs_tree',
        description:
            'Build a fast directory tree (nested tree + flat file list) with file sizes. Respects .gitignore rules (including nested .gitignore files and negation) by default, always skips .git, caps depth and total entries, and never follows symlinks.',
        inputSchema: schema(
            {
                directory: { type: 'string', description: 'Root directory to walk (supports ~).' },
                depth: {
                    type: 'number',
                    description: `Maximum directory depth to expand (0-${FS_TREE_MAX_DEPTH}, default ${FS_TREE_DEFAULT_DEPTH}).`,
                    minimum: 0,
                    maximum: FS_TREE_MAX_DEPTH,
                },
                respectGitignore: {
                    type: 'boolean',
                    description: 'Honour .gitignore files (default true).',
                },
                maxEntries: {
                    type: 'number',
                    description: `Maximum entries returned (1-${FS_TREE_MAX_ENTRIES}, default ${FS_TREE_DEFAULT_MAX_ENTRIES}).`,
                    minimum: 1,
                    maximum: FS_TREE_MAX_ENTRIES,
                },
            },
            ['directory']
        ),
    },
    {
        name: 'pc_shell_session',
        description:
            'Inspect, reset or list the stateful shell sessions used by pc_exec_shell when workflowId is passed. Sessions persist cwd, environment variables and the pushd stack across calls and daemon restarts (stored in <stateDir>/shell-sessions.json).',
        inputSchema: schema(
            {
                action: {
                    type: 'string',
                    enum: ['info', 'reset', 'list'],
                    description:
                        'info = describe one session, reset = delete a session (back to default state), list = all sessions with cwd/env summary.',
                },
                workflowId: {
                    type: 'string',
                    description: 'Session/workflow id. Required for info and reset, ignored for list.',
                },
            },
            ['action']
        ),
    },
    {
        name: 'pc_bg_process',
        description:
            'Manage detached background processes (dev servers, watchers, long builds). start spawns detached with stdout/stderr appended to <stateDir>/logs/<id>.log and returns {id, pid, logPath}; status/logs/kill/list work by id, including after a daemon restart because the registry is persisted to <stateDir>/bg-processes.json. kill terminates the whole process tree. logs are bounded to a 64 KB tail.',
        inputSchema: schema(
            {
                action: {
                    type: 'string',
                    enum: ['start', 'status', 'logs', 'kill', 'list'],
                    description: 'Operation to perform.',
                },
                id: {
                    type: 'string',
                    description: 'Background process id (required for status, logs and kill).',
                },
                command: { type: 'string', description: 'Command line to start (required for start).' },
                cwd: {
                    type: 'string',
                    description:
                        'Working directory for start (supports ~). Defaults to the workflow session cwd when workflowId is given, else the user home directory.',
                },
                workflowId: {
                    type: 'string',
                    description: 'Optional workflow id used to scope the process and inherit its cwd/env.',
                },
                name: { type: 'string', description: 'Optional human-readable label for start.' },
                env: {
                    type: 'object',
                    description: 'Optional environment overrides for start (string values).',
                    additionalProperties: { type: 'string' },
                },
                tailBytes: {
                    type: 'number',
                    description: `logs: maximum bytes to return (1-${BG_LOG_TAIL_MAX_BYTES}, default ${BG_LOG_TAIL_DEFAULT_BYTES}).`,
                    minimum: 1,
                    maximum: BG_LOG_TAIL_MAX_BYTES,
                },
                offset: {
                    type: 'number',
                    description:
                        'logs: byte offset to start reading from (default: end minus tailBytes).',
                    minimum: 0,
                },
                signal: {
                    type: 'string',
                    enum: ['SIGTERM', 'SIGINT', 'SIGKILL'],
                    description: 'kill: signal to send (default SIGTERM; Windows always force-kills the tree).',
                },
            },
            ['action']
        ),
    },
    {
        name: 'pc_git_status',
        description:
            'Run the safe argv-array equivalent of `git status --porcelain --branch` in a directory. Returns branch/upstream/ahead/behind, clean flag, counts (staged/unstaged/untracked) and a structured change list. Fails with a clear error when the directory is not a git repository.',
        inputSchema: schema(
            { directory: { type: 'string', description: 'Repository or subdirectory path (supports ~).' } },
            ['directory']
        ),
    },
    {
        name: 'pc_git_diff',
        description:
            'Run `git diff` (worktree, or staged with staged:true) in a repository using spawnSync argv arrays. Returns the unified diff (bounded to 200 KB), the --stat summary and the number of changed files. Optional path filter and contextLines.',
        inputSchema: schema(
            {
                directory: { type: 'string', description: 'Repository or subdirectory path (supports ~).' },
                staged: {
                    type: 'boolean',
                    description: 'Diff the index against HEAD (git diff --cached) instead of the worktree.',
                },
                path: {
                    type: 'string',
                    description: 'Optional pathspec/relative path to limit the diff.',
                },
                contextLines: {
                    type: 'number',
                    description: 'Unified diff context lines (0-10, default 3).',
                    minimum: 0,
                    maximum: 10,
                },
            },
            ['directory']
        ),
    },
    {
        name: 'pc_git_status_diff',
        description:
            'Composite git snapshot for an IDE: returns {status, diff, commits} where status is the structured porcelain status, diff contains unstaged + staged unified diffs with stats, and commits is the recent git log. One call replaces status+diff+log for Coder Agent context.',
        inputSchema: schema(
            {
                directory: { type: 'string', description: 'Repository or subdirectory path (supports ~).' },
                maxCommits: {
                    type: 'number',
                    description: `Recent commits to include (1-${GIT_MAX_LOG_COUNT}, default 10).`,
                    minimum: 1,
                    maximum: GIT_MAX_LOG_COUNT,
                },
            },
            ['directory']
        ),
    },
    {
        name: 'pc_git_add',
        description:
            'Stage files with `git add -- <paths>` (argv array, never a shell string). Paths are resolved and rejected if they escape the repository root or look like options. Returns the staged paths plus the post-add status.',
        inputSchema: schema(
            {
                directory: { type: 'string', description: 'Repository path (supports ~).' },
                paths: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Repository-relative or absolute paths to stage (at least one).',
                },
            },
            ['directory', 'paths']
        ),
    },
    {
        name: 'pc_git_commit',
        description:
            'Create a commit with `git commit -m <message>` using an argv array. Set all:true to stage tracked modifications first (git commit -a). Returns the commit hash/short hash/subject plus the new status. Clear error when git identity is missing or the commit fails.',
        inputSchema: schema(
            {
                directory: { type: 'string', description: 'Repository path (supports ~).' },
                message: { type: 'string', description: 'Commit message (non-empty).' },
                all: {
                    type: 'boolean',
                    description: 'Stage tracked files automatically (git commit -a).',
                },
            },
            ['directory', 'message']
        ),
    },
    {
        name: 'pc_git_checkout',
        description:
            'Switch branches (git checkout <branch>) or create and switch with create:true (git checkout -b <branch>). Branch names starting with "-" are rejected; returns the resulting branch name.',
        inputSchema: schema(
            {
                directory: { type: 'string', description: 'Repository path (supports ~).' },
                branch: { type: 'string', description: 'Branch name to switch to or create.' },
                create: { type: 'boolean', description: 'Create the branch (git checkout -b).' },
            },
            ['directory', 'branch']
        ),
    },
    {
        name: 'pc_git_log',
        description:
            'Return recent commits as structured objects {hash, shortHash, author, authorEmail, date, subject}. Empty repositories return an empty commit list instead of an error.',
        inputSchema: schema(
            {
                directory: { type: 'string', description: 'Repository path (supports ~).' },
                maxCount: {
                    type: 'number',
                    description: `Commits to return (1-${GIT_MAX_LOG_COUNT}, default ${GIT_DEFAULT_LOG_COUNT}).`,
                    minimum: 1,
                    maximum: GIT_MAX_LOG_COUNT,
                },
            },
            ['directory']
        ),
    },
    {
        name: 'pc_desktop_screenshot',
        description:
            'Capture the desktop and return {filePath, base64, width, height, bytes}. Windows uses PowerShell System.Windows.Forms CopyFromScreen, macOS uses screencapture, Linux tries grim/gnome-screenshot/import/scrot. savePath overrides the default <stateDir>/screenshots location. Fails with a clear headless/degradation error when no desktop is available.',
        inputSchema: schema(
            {
                format: {
                    type: 'string',
                    enum: ['png'],
                    description: 'Image format (only png is supported).',
                },
                savePath: {
                    type: 'string',
                    description:
                        'Optional destination file path (supports ~); parent directories are created. Defaults to <stateDir>/screenshots/screenshot_<timestamp>.png',
                },
            },
            []
        ),
    },
    {
        name: 'pc_clipboard',
        description:
            'Read or write the OS text clipboard using native tooling: Windows PowerShell Get-Clipboard/Set-Clipboard, macOS pbpaste/pbcopy, Linux wl-paste/wl-copy or xclip/xsel. Returns {action, text/chars, bytes, tool}. Fails with a clear headless/degradation error when no clipboard backend is available.',
        inputSchema: schema(
            {
                action: { type: 'string', enum: ['read', 'write'], description: 'Clipboard operation.' },
                text: {
                    type: 'string',
                    description: 'Text to place on the clipboard (required for write; empty string clears it).',
                },
            },
            ['action']
        ),
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
    ['pc_shell_session', handlePcShellSession],
    ['pc_bg_process', handlePcBgProcess],
    ['pc_fs_read', handlePcFsRead],
    ['pc_fs_write', handlePcFsWrite],
    ['pc_fs_patch', handlePcFsPatch],
    ['pc_fs_tree', handlePcFsTree],
    ['pc_search_code', handlePcSearchCode],
    ['pc_git_status', handlePcGitStatus],
    ['pc_git_diff', handlePcGitDiff],
    ['pc_git_status_diff', handlePcGitStatusDiff],
    ['pc_git_add', handlePcGitAdd],
    ['pc_git_commit', handlePcGitCommit],
    ['pc_git_checkout', handlePcGitCheckout],
    ['pc_git_log', handlePcGitLog],
    ['pc_desktop_screenshot', handlePcDesktopScreenshot],
    ['pc_clipboard', handlePcClipboard],
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

// ---------------------------------------------------------------------------
// Stateful shell sessions (per-workflow persistent cwd, env and pushd stack)
// ---------------------------------------------------------------------------

const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SHELL_BUILTIN_NAMES = new Set(['cd', 'chdir', 'pushd', 'popd', 'export', 'set', 'unset', 'pwd']);

const shellSessions = new Map(); // workflowId -> {workflowId, cwd, previousCwd, pushdStack, env, createdAt, updatedAt, calls}
let shellSessionsLoaded = false;

function shellSessionsFilePath() {
    return path.join(runtime.stateDir, SHELL_SESSIONS_FILE);
}

function isDirectoryPath(candidate) {
    if (typeof candidate !== 'string' || candidate.length === 0) return false;
    try {
        return fs.statSync(candidate).isDirectory();
    } catch {
        return false;
    }
}

function createShellSession(workflowId, initialCwd) {
    const timestamp = new Date().toISOString();
    return {
        workflowId: workflowId || null,
        cwd: initialCwd || os.homedir(),
        previousCwd: null,
        pushdStack: [],
        env: {},
        createdAt: timestamp,
        updatedAt: timestamp,
        calls: 0,
    };
}

function enforceShellSessionEnvLimits(env) {
    const names = Object.keys(env);
    if (names.length > SHELL_SESSION_MAX_ENV_ENTRIES) {
        throw new ToolError(
            `Session environment has ${names.length} variables (max ${SHELL_SESSION_MAX_ENV_ENTRIES}). Unset variables with the unset builtin or reset the session.`
        );
    }
    let bytes = 0;
    for (const name of names) {
        bytes += Buffer.byteLength(name, 'utf8') + 1 + Buffer.byteLength(String(env[name]), 'utf8');
    }
    if (bytes > SHELL_SESSION_MAX_ENV_BYTES) {
        throw new ToolError(
            `Session environment is ${bytes} bytes (max ${SHELL_SESSION_MAX_ENV_BYTES}). Unset variables with the unset builtin or reset the session.`
        );
    }
}

function normalizeStoredShellSession(workflowId, raw) {
    if (!isPlainObject(raw)) return null;
    const session = createShellSession(workflowId, os.homedir());
    if (typeof raw.cwd === 'string' && raw.cwd.trim().length > 0) {
        const normalized = path.normalize(raw.cwd);
        if (path.isAbsolute(normalized) && isDirectoryPath(normalized)) session.cwd = normalized;
    }
    if (isPlainObject(raw.env)) {
        const restored = {};
        for (const [name, value] of Object.entries(raw.env)) {
            if (!ENV_NAME_PATTERN.test(name) || typeof value !== 'string') continue;
            restored[name] = value;
        }
        try {
            enforceShellSessionEnvLimits(restored);
            session.env = restored;
        } catch {
            session.env = {};
        }
    }
    if (Array.isArray(raw.pushdStack)) {
        session.pushdStack = raw.pushdStack
            .filter((entry) => path.isAbsolute(String(entry)) && isDirectoryPath(String(entry)))
            .slice(-SHELL_SESSION_MAX_PUSHD);
    }
    if (typeof raw.createdAt === 'string') session.createdAt = raw.createdAt;
    if (typeof raw.updatedAt === 'string') session.updatedAt = raw.updatedAt;
    if (Number.isInteger(raw.calls) && raw.calls >= 0) session.calls = raw.calls;
    return session;
}

function loadShellSessions() {
    if (shellSessionsLoaded) return;
    shellSessionsLoaded = true;
    let parsed = null;
    try {
        parsed = JSON.parse(fs.readFileSync(shellSessionsFilePath(), 'utf8'));
    } catch {
        return;
    }
    if (!isPlainObject(parsed) || !isPlainObject(parsed.sessions)) return;
    for (const [workflowId, raw] of Object.entries(parsed.sessions)) {
        if (!CHECKPOINT_ID_PATTERN.test(workflowId)) continue;
        const session = normalizeStoredShellSession(workflowId, raw);
        if (session) shellSessions.set(workflowId, session);
    }
    log.debug('shell session state loaded', { count: shellSessions.size });
}

function persistShellSessions() {
    if (!shellSessionsLoaded) return;
    try {
        ensureDir(runtime.stateDir);
        const payload = { savedAt: new Date().toISOString(), sessions: {} };
        for (const [workflowId, session] of shellSessions) {
            payload.sessions[workflowId] = {
                cwd: session.cwd,
                previousCwd: session.previousCwd,
                pushdStack: session.pushdStack,
                env: session.env,
                createdAt: session.createdAt,
                updatedAt: session.updatedAt,
                calls: session.calls,
            };
        }
        atomicWriteFile(shellSessionsFilePath(), JSON.stringify(payload));
    } catch (error) {
        log.warn('failed to persist shell session state', { error: errorMessage(error) });
    }
}

function touchShellSession(session) {
    session.updatedAt = new Date().toISOString();
}

function getShellSession(workflowId) {
    loadShellSessions();
    const existing = shellSessions.get(workflowId);
    if (existing) return existing;
    if (shellSessions.size >= SHELL_SESSION_MAX_SESSIONS) {
        // Bound the persisted file: evict the least recently updated session.
        let oldestId = null;
        let oldestStamp = Number.POSITIVE_INFINITY;
        for (const [candidateId, candidate] of shellSessions) {
            const stamp = Date.parse(candidate.updatedAt) || 0;
            if (stamp < oldestStamp) {
                oldestStamp = stamp;
                oldestId = candidateId;
            }
        }
        if (oldestId !== null) shellSessions.delete(oldestId);
    }
    const session = createShellSession(workflowId, os.homedir());
    shellSessions.set(workflowId, session);
    return session;
}

function shellSessionSnapshot(session) {
    return {
        workflowId: session.workflowId,
        cwd: session.cwd,
        previousCwd: session.previousCwd,
        pushdStack: [...session.pushdStack],
        env: { ...session.env },
        envCount: Object.keys(session.env).length,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        calls: session.calls,
    };
}

function shellSessionSummary(session) {
    return {
        workflowId: session.workflowId,
        cwd: session.cwd,
        envCount: Object.keys(session.env).length,
        pushdDepth: session.pushdStack.length,
        calls: session.calls,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
    };
}

function listShellSessionSummaries() {
    loadShellSessions();
    return [...shellSessions.values()]
        .map((session) => shellSessionSummary(session))
        .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
}

function optionalWorkflowIdArg(args, key = 'workflowId') {
    const raw = optionalStringArg(args, key);
    if (raw === undefined || raw === null || raw.trim().length === 0) return null;
    return sanitizeWorkflowId(raw);
}

function validateEnvUpdates(rawValue, label) {
    if (rawValue === undefined || rawValue === null) return {};
    if (!isPlainObject(rawValue)) {
        throw new ToolError(
            `Parameter "${label}" must be an object mapping environment variable names to values.`
        );
    }
    const updates = {};
    for (const [name, value] of Object.entries(rawValue)) {
        if (!ENV_NAME_PATTERN.test(name)) {
            throw new ToolError(
                `Invalid environment variable name "${name}" in "${label}"; use letters, digits and underscores, starting with a letter or underscore.`
            );
        }
        if (value === null) {
            updates[name] = null;
            continue;
        }
        if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
            throw new ToolError(`Environment variable "${name}" must be a string value.`);
        }
        updates[name] = String(value);
    }
    return updates;
}

function mergeShellSessionEnv(baseEnv, updates) {
    const merged = { ...baseEnv };
    for (const [name, value] of Object.entries(updates)) {
        if (value === null) delete merged[name];
        else merged[name] = value;
    }
    enforceShellSessionEnvLimits(merged);
    return merged;
}

/** Expand ${VAR}, $VAR and %VAR% references used by shell builtin arguments. */
function expandBuiltinArgument(text, env) {
    return String(text)
        .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, name) =>
            Object.prototype.hasOwnProperty.call(env, name) ? env[name] : ''
        )
        .replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (match, name) =>
            Object.prototype.hasOwnProperty.call(env, name) ? env[name] : ''
        )
        .replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (match, name) =>
            Object.prototype.hasOwnProperty.call(env, name) ? env[name] : ''
        );
}

/** Split one shell segment into quote-aware tokens (quotes are stripped). */
function tokenizeShellSegment(segment) {
    const tokens = [];
    let current = '';
    let quote = null;
    let hasContent = false;
    for (let index = 0; index < segment.length; index += 1) {
        const ch = segment[index];
        if (quote !== null) {
            if (ch === quote) {
                quote = null;
                continue;
            }
            // POSIX double quotes honour backslash escapes; Windows paths keep "\".
            if (!IS_WINDOWS && ch === '\\' && quote === '"' && index + 1 < segment.length) {
                index += 1;
                current += segment[index];
                hasContent = true;
                continue;
            }
            current += ch;
            hasContent = true;
            continue;
        }
        if (ch === '"' || ch === "'") {
            quote = ch;
            hasContent = true;
            continue;
        }
        if (!IS_WINDOWS && ch === '\\' && index + 1 < segment.length) {
            index += 1;
            current += segment[index];
            hasContent = true;
            continue;
        }
        if (/\s/.test(ch)) {
            if (hasContent) {
                tokens.push(current);
                current = '';
                hasContent = false;
            }
            continue;
        }
        current += ch;
        hasContent = true;
    }
    if (hasContent) tokens.push(current);
    return tokens;
}

/**
 * Split a command line into top-level segments separated by `&&`, `;` or
 * newlines, preserving offsets so the unparsed remainder can be executed by a
 * real shell. Returns null when quotes are unbalanced (let the shell report it).
 */
function splitShellCommand(command) {
    const segments = [];
    let start = 0;
    let quote = null;
    let index = 0;
    while (index < command.length) {
        const ch = command[index];
        if (quote !== null) {
            if (ch === '\\' && quote === '"' && index + 1 < command.length) {
                index += 2;
                continue;
            }
            if (ch === quote) quote = null;
            index += 1;
            continue;
        }
        if (ch === '"' || ch === "'") {
            quote = ch;
            index += 1;
            continue;
        }
        if (!IS_WINDOWS && ch === '\\' && index + 1 < command.length) {
            index += 2;
            continue;
        }
        if (ch === '&' && command[index + 1] === '&') {
            segments.push({ start, text: command.slice(start, index), separator: '&&' });
            index += 2;
            start = index;
            continue;
        }
        if (ch === ';' || ch === '\n' || ch === '\r') {
            const isCrLf = ch === '\r' && command[index + 1] === '\n';
            segments.push({
                start,
                text: command.slice(start, index),
                separator: isCrLf ? '\r\n' : ch,
            });
            index += isCrLf ? 2 : 1;
            start = index;
            continue;
        }
        index += 1;
    }
    if (quote !== null) return null;
    segments.push({ start, text: command.slice(start), separator: null });
    return segments;
}

function resolveBuiltinDirectory(session, rawTarget, env, builtinName) {
    const expanded = expandBuiltinArgument(rawTarget, env).trim();
    if (!expanded || expanded === '~') return path.resolve(os.homedir());
    if (expanded.startsWith('~/') || expanded.startsWith('~\\')) {
        return path.resolve(path.join(os.homedir(), expanded.slice(2)));
    }
    if (expanded === '-') {
        if (!session.previousCwd) {
            throw new ToolError(`${builtinName}: no previous directory recorded for this session.`);
        }
        if (!isDirectoryPath(session.previousCwd)) {
            throw new ToolError(
                `${builtinName}: previous directory no longer exists: ${session.previousCwd}`
            );
        }
        return session.previousCwd;
    }
    return path.isAbsolute(expanded) ? path.normalize(expanded) : path.resolve(session.cwd, expanded);
}

function changeSessionDirectory(session, targetDir, builtinName) {
    let stat = null;
    try {
        stat = fs.statSync(targetDir);
    } catch {
        throw new ToolError(`${builtinName}: directory does not exist: ${targetDir}`);
    }
    if (!stat.isDirectory()) {
        throw new ToolError(`${builtinName}: not a directory: ${targetDir}`);
    }
    if (path.resolve(session.cwd) !== path.resolve(targetDir)) {
        session.previousCwd = session.cwd;
    }
    session.cwd = path.resolve(targetDir);
}

function runEnvironmentBuiltin(session, tokens, baseEnv, builtinName) {
    const currentEnv = { ...baseEnv, ...session.env };
    if (tokens.length === 0) {
        const lines = Object.keys(session.env)
            .sort()
            .map((name) => `${name}=${session.env[name]}`);
        return { builtin: builtinName, stdout: lines.join('\n'), changed: false, env: { ...session.env } };
    }
    const updates = {};
    const outputLines = [];
    for (const token of tokens) {
        const equalsIndex = token.indexOf('=');
        if (equalsIndex <= 0) {
            const name = token.trim();
            if (!ENV_NAME_PATTERN.test(name)) {
                throw new ToolError(`${builtinName}: invalid environment variable name "${token}".`);
            }
            outputLines.push(
                Object.prototype.hasOwnProperty.call(session.env, name)
                    ? `${name}=${session.env[name]}`
                    : `${name}=`
            );
            continue;
        }
        const name = token.slice(0, equalsIndex).trim();
        if (!ENV_NAME_PATTERN.test(name)) {
            throw new ToolError(`${builtinName}: invalid environment variable name "${token}".`);
        }
        updates[name] = expandBuiltinArgument(token.slice(equalsIndex + 1), currentEnv);
    }
    if (Object.keys(updates).length > 0) {
        session.env = mergeShellSessionEnv(session.env, updates);
        return {
            builtin: builtinName,
            stdout: outputLines.join('\n'),
            changed: true,
            env: { ...session.env },
        };
    }
    return { builtin: builtinName, stdout: outputLines.join('\n'), changed: false, env: { ...session.env } };
}

/**
 * Execute one tokens array against the session when it is a supported builtin.
 * Returns null when the segment is not a builtin (it must then run in a shell).
 */
function runShellBuiltin(session, tokens, baseEnv) {
    if (tokens.length === 0) return null;
    const name = tokens[0].toLowerCase();
    if (!SHELL_BUILTIN_NAMES.has(name)) return null;
    const env = { ...baseEnv, ...session.env };
    const argumentText = tokens.slice(1).join(' ');
    switch (name) {
        case 'cd':
        case 'chdir': {
            let target = argumentText;
            if (/^\/d\s+/i.test(target)) target = target.slice(3);
            const directory = resolveBuiltinDirectory(session, target, env, 'cd');
            changeSessionDirectory(session, directory, 'cd');
            return { builtin: 'cd', stdout: '', changed: true, env: { ...session.env } };
        }
        case 'pushd': {
            if (!argumentText.trim()) throw new ToolError('pushd requires a directory argument.');
            const directory = resolveBuiltinDirectory(session, argumentText, env, 'pushd');
            if (session.pushdStack.length >= SHELL_SESSION_MAX_PUSHD) {
                throw new ToolError(`pushd stack is full (max ${SHELL_SESSION_MAX_PUSHD} directories).`);
            }
            session.pushdStack.push(session.cwd);
            changeSessionDirectory(session, directory, 'pushd');
            return { builtin: 'pushd', stdout: session.cwd, changed: true, env: { ...session.env } };
        }
        case 'popd': {
            const previous = session.pushdStack.pop();
            if (!previous) throw new ToolError('popd: pushd stack is empty.');
            changeSessionDirectory(session, previous, 'popd');
            return { builtin: 'popd', stdout: session.cwd, changed: true, env: { ...session.env } };
        }
        case 'pwd':
            return { builtin: 'pwd', stdout: session.cwd, changed: false, env: { ...session.env } };
        case 'export':
        case 'set':
            return runEnvironmentBuiltin(session, tokens.slice(1), baseEnv, name);
        case 'unset': {
            if (tokens.length <= 1) throw new ToolError('unset requires at least one variable name.');
            const names = tokens.slice(1);
            for (const rawName of names) {
                if (!ENV_NAME_PATTERN.test(rawName)) {
                    throw new ToolError(`unset: invalid environment variable name "${rawName}".`);
                }
            }
            for (const rawName of names) delete session.env[rawName];
            session.env = { ...session.env };
            return { builtin: 'unset', stdout: '', changed: true, env: { ...session.env } };
        }
        default:
            return null;
    }
}

/**
 * Apply the leading chain of shell builtins to the session. Returns the builtin
 * outcomes plus the remainder of the command that still needs a real shell
 * (null when every segment was handled as a builtin).
 */
function applyShellBuiltins({ command, session, baseEnv }) {
    const segments = splitShellCommand(command);
    if (!segments) return { applied: [], remainingCommand: command, parsed: false };
    const applied = [];
    let index = 0;
    while (index < segments.length) {
        const segment = segments[index];
        if (segment.text.trim().length === 0) {
            index += 1;
            continue;
        }
        const tokens = tokenizeShellSegment(segment.text);
        const outcome = runShellBuiltin(session, tokens, baseEnv);
        if (!outcome) break;
        applied.push(outcome);
        index += 1;
    }
    if (index >= segments.length) {
        return { applied, remainingCommand: null, parsed: true };
    }
    const remainder = command.slice(segments[index].start);
    return {
        applied,
        remainingCommand: remainder.trim().length > 0 ? remainder : null,
        parsed: true,
    };
}

function buildSessionEnvironment(baseEnv, sessionEnv) {
    const merged = { ...baseEnv, ...sessionEnv };
    for (const [name, value] of Object.entries(merged)) {
        if (value === undefined || value === null) delete merged[name];
    }
    return merged;
}

function buildInterceptedShellPayload({ command, workflowId, session, applied, startedAt }) {
    const stdout = applied
        .map((outcome) => outcome.stdout)
        .filter((text) => text.length > 0)
        .join('\n');
    return {
        command,
        exitCode: 0,
        signal: null,
        timedOut: false,
        durationMs: Date.now() - startedAt,
        stdout,
        stderr: '',
        stdoutTruncated: false,
        stderrTruncated: false,
        logPath: null,
        bytes: { stdout: Buffer.byteLength(stdout, 'utf8'), stderr: 0 },
        intercepted: true,
        spawn: false,
        builtins: applied.map((outcome) => outcome.builtin),
        workflowId: workflowId || null,
        sessionCwd: session.cwd,
        session: shellSessionSnapshot(session),
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

function runForegroundShell({ command, cwd, timeoutMs, env }) {
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
                ...(env ? { env } : {}),
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

// ---------------------------------------------------------------------------
// Managed background processes (pc_bg_process)
// ---------------------------------------------------------------------------

const managedBackgroundProcesses = new Map(); // id -> serializable record
const managedBackgroundChildren = new Map(); // id -> ChildProcess (current daemon only)
let backgroundRegistryLoaded = false;

function backgroundRegistryFilePath() {
    return path.join(runtime.stateDir, BACKGROUND_REGISTRY_FILE);
}

function normalizeStoredBackgroundProcess(raw) {
    if (!isPlainObject(raw)) return null;
    if (typeof raw.id !== 'string' || raw.id.length === 0) return null;
    if (!Number.isInteger(raw.pid) || raw.pid <= 0) return null;
    if (typeof raw.logPath !== 'string' || raw.logPath.length === 0) return null;
    return {
        id: raw.id,
        pid: raw.pid,
        command: typeof raw.command === 'string' ? raw.command : '',
        cwd: typeof raw.cwd === 'string' ? raw.cwd : null,
        workflowId: typeof raw.workflowId === 'string' && raw.workflowId ? raw.workflowId : null,
        name: typeof raw.name === 'string' && raw.name ? raw.name : null,
        logPath: raw.logPath,
        startedAt: Number.isFinite(raw.startedAt) ? raw.startedAt : Date.now(),
        endedAt: Number.isFinite(raw.endedAt) ? raw.endedAt : null,
        exitCode: Number.isInteger(raw.exitCode) ? raw.exitCode : null,
        signal: typeof raw.signal === 'string' ? raw.signal : null,
    };
}

function loadBackgroundRegistry() {
    if (backgroundRegistryLoaded) return;
    backgroundRegistryLoaded = true;
    let parsed = null;
    try {
        parsed = JSON.parse(fs.readFileSync(backgroundRegistryFilePath(), 'utf8'));
    } catch {
        return;
    }
    if (!isPlainObject(parsed) || !Array.isArray(parsed.processes)) return;
    for (const raw of parsed.processes) {
        const record = normalizeStoredBackgroundProcess(raw);
        if (record) managedBackgroundProcesses.set(record.id, record);
    }
    if (managedBackgroundProcesses.size > 0) {
        log.debug('background process registry loaded', { count: managedBackgroundProcesses.size });
    }
}

function persistBackgroundRegistry() {
    if (!backgroundRegistryLoaded) return;
    try {
        ensureDir(runtime.stateDir);
        const payload = {
            savedAt: new Date().toISOString(),
            processes: [...managedBackgroundProcesses.values()],
        };
        atomicWriteFile(backgroundRegistryFilePath(), JSON.stringify(payload));
    } catch (error) {
        log.warn('failed to persist background process registry', { error: errorMessage(error) });
    }
}

function isManagedProcessRunning(record) {
    if (!record || record.endedAt) return false;
    return isPidAlive(record.pid);
}

/** Mark externally exited processes as ended and persist the registry. */
function refreshManagedBackgroundProcesses() {
    loadBackgroundRegistry();
    let changed = false;
    for (const record of managedBackgroundProcesses.values()) {
        if (record.endedAt) continue;
        if (!isPidAlive(record.pid)) {
            record.endedAt = Date.now();
            changed = true;
        }
    }
    if (changed) persistBackgroundRegistry();
    return changed;
}

function logFileSize(logPath) {
    try {
        return fs.statSync(logPath).size;
    } catch {
        return null;
    }
}

function describeManagedProcess(record, { includeLogBytes = false } = {}) {
    const running = isManagedProcessRunning(record);
    const endedAt = record.endedAt || null;
    return {
        id: record.id,
        pid: record.pid,
        command: record.command,
        cwd: record.cwd,
        workflowId: record.workflowId,
        name: record.name,
        logPath: record.logPath,
        startedAt: new Date(record.startedAt).toISOString(),
        endedAt: endedAt === null ? null : new Date(endedAt).toISOString(),
        running,
        exitCode: record.exitCode,
        signal: record.signal,
        uptimeMs: Math.max(0, (endedAt || Date.now()) - record.startedAt),
        ...(includeLogBytes ? { logBytes: logFileSize(record.logPath) } : {}),
    };
}

function listManagedBackgroundProcesses({ workflowId = null } = {}) {
    loadBackgroundRegistry();
    refreshManagedBackgroundProcesses();
    let records = [...managedBackgroundProcesses.values()];
    if (workflowId) records = records.filter((record) => record.workflowId === workflowId);
    records.sort((left, right) => right.startedAt - left.startedAt);
    return records.map((record) => describeManagedProcess(record));
}

/**
 * Windows cannot hand inherited stdio file handles to a grandchild of a
 * detached cmd.exe (the grandchild loses its stdout/stderr), and a
 * non-detached child is torn down with the daemon. The runner script is a
 * tiny detached Node process that owns the log file, spawns the shell itself
 * and forwards the command exit code. It is regenerated under the state
 * directory so the daemon stays a single authored file.
 */
const BG_RUNNER_SOURCE = [
    '#!/usr/bin/env node',
    '// Generated by the Ncode pc-daemon (server.mjs). Runs one background command',
    '// with stdout/stderr appended to a log file and exits with the command code.',
    "import { spawn } from 'node:child_process';",
    "import fs from 'node:fs';",
    '',
    "const command = process.env.NCODE_BG_COMMAND || '';",
    "const logPath = process.env.NCODE_BG_LOG || '';",
    'const cwd = process.env.NCODE_BG_CWD || process.cwd();',
    "const isWindows = process.platform === 'win32';",
    'if (!command || !logPath) {',
    "    process.stderr.write('[ncode-bg-runner] missing NCODE_BG_COMMAND or NCODE_BG_LOG\\n');",
    '    process.exit(2);',
    '}',
    'let outFd = null;',
    'try {',
    "    outFd = fs.openSync(logPath, 'a');",
    "    const shell = isWindows ? process.env.ComSpec || 'cmd.exe' : process.env.SHELL || '/bin/sh';",
    "    const args = isWindows ? ['/d', '/s', '/c', '\"' + command + '\"'] : ['-lc', command];",
    '    const child = spawn(shell, args, {',
    '        cwd,',
    '        env: process.env,',
    "        stdio: ['ignore', outFd, outFd],",
    '        windowsHide: true,',
    '        ...(isWindows ? { windowsVerbatimArguments: true } : {}),',
    '    });',
    "    child.on('error', (error) => {",
    "        try { fs.writeSync(outFd, '[ncode-bg-runner] failed to start command: ' + error.message + '\\n'); } catch { /* ignore */ }",
    '        process.exitCode = 127;',
    '    });',
    "    child.on('exit', (code, signal) => {",
    '        process.exitCode = Number.isInteger(code) ? code : signal ? 1 : 0;',
    '    });',
    '} catch (error) {',
    "    process.stderr.write('[ncode-bg-runner] ' + error.message + '\\n');",
    '    process.exitCode = 1;',
    '}',
].join('\n');

function ensureBackgroundRunnerScript() {
    const runnerPath = path.join(runtime.stateDir, BG_RUNNER_FILE);
    let existing = '';
    try {
        existing = fs.readFileSync(runnerPath, 'utf8');
    } catch {
        existing = '';
    }
    if (existing !== BG_RUNNER_SOURCE) {
        try {
            ensureDir(runtime.stateDir);
            atomicWriteFile(runnerPath, BG_RUNNER_SOURCE);
        } catch (error) {
            throw new ToolError(
                `Failed to prepare the background process runner at ${runnerPath}: ${errorMessage(error)}`
            );
        }
    }
    return runnerPath;
}

function startManagedBackgroundProcess({ command, cwd, workflowId, name, env }) {
    loadBackgroundRegistry();
    const id = newTimedId('bg');
    const logPath = path.join(getLogsDir(), `${id}.log`);
    const spawnEnv = env ? { ...env } : { ...process.env };
    let child = null;
    let outFd = null;
    let errFd = null;
    try {
        const creationFd = fs.openSync(logPath, 'a');
        fs.closeSync(creationFd);
        if (IS_WINDOWS) {
            const runnerPath = ensureBackgroundRunnerScript();
            child = spawn(process.execPath, [runnerPath], {
                detached: true,
                stdio: 'ignore',
                windowsHide: true,
                env: {
                    ...spawnEnv,
                    NCODE_BG_COMMAND: command,
                    NCODE_BG_LOG: logPath,
                    NCODE_BG_CWD: cwd,
                },
            });
        } else {
            outFd = fs.openSync(logPath, 'a');
            errFd = fs.openSync(logPath, 'a');
            child = spawnShellCommand(command, cwd, {
                detached: true,
                stdio: ['ignore', outFd, errFd],
                env: spawnEnv,
            });
        }
    } catch (error) {
        throw new ToolError(`Failed to start background process: ${errorMessage(error)}`);
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
    const record = {
        id,
        pid: child.pid,
        command,
        cwd,
        workflowId: workflowId || null,
        name: name || null,
        logPath,
        startedAt: Date.now(),
        endedAt: null,
        exitCode: null,
        signal: null,
    };
    managedBackgroundProcesses.set(id, record);
    managedBackgroundChildren.set(id, child);
    child.on('error', (error) => {
        log.warn('background process spawn error', { id, error: errorMessage(error) });
    });
    child.on('exit', (code, signal) => {
        managedBackgroundChildren.delete(id);
        const current = managedBackgroundProcesses.get(id);
        if (!current) return;
        current.exitCode = Number.isInteger(code) ? code : null;
        current.signal = typeof signal === 'string' ? signal : null;
        current.endedAt = Date.now();
        persistBackgroundRegistry();
        log.info('background process exited', {
            id,
            pid: current.pid,
            exitCode: current.exitCode,
            signal: current.signal,
        });
    });
    try {
        child.unref();
    } catch {
        // ignore
    }
    persistBackgroundRegistry();
    log.info('background process started', {
        id,
        pid: child.pid,
        workflowId: record.workflowId,
        logPath,
    });
    return record;
}

/** Kill a process tree by pid. Windows always force-kills the tree. */
function killProcessTreeByPid(pid, signal) {
    const requestedSignal =
        typeof signal === 'string' && signal.trim().length > 0
            ? signal.trim().toUpperCase()
            : 'SIGTERM';
    if (IS_WINDOWS) {
        try {
            const result = spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], {
                windowsHide: true,
                timeout: 15_000,
                encoding: 'utf8',
            });
            if (result.error) throw result.error;
            return {
                killed: result.status === 0,
                tool: 'taskkill',
                status: result.status,
                stderr: asTrimmedString(result.stderr) || null,
            };
        } catch (error) {
            throw new ToolError(`Failed to kill process tree ${pid}: ${errorMessage(error)}`);
        }
    }
    try {
        process.kill(-pid, requestedSignal);
        return { killed: true, tool: 'process.kill(-pgid)', signal: requestedSignal };
    } catch (error) {
        if (error && error.code === 'ESRCH') {
            return { killed: false, tool: 'process.kill', signal: requestedSignal, reason: 'no such process' };
        }
        try {
            process.kill(pid, requestedSignal);
            return { killed: true, tool: 'process.kill', signal: requestedSignal };
        } catch (fallbackError) {
            throw new ToolError(`Failed to kill process ${pid}: ${errorMessage(fallbackError)}`);
        }
    }
}

function readBoundedLog(filePath, { tailBytes, offset }) {
    let stat = null;
    try {
        stat = fs.statSync(filePath);
    } catch {
        throw new ToolError(`Log file not found: ${filePath}`);
    }
    const totalBytes = stat.size;
    if (totalBytes > SCREENSHOT_MAX_BYTES) {
        // Extremely large log files are still read in bounded windows below.
        log.debug('reading a very large log file with a bounded window', { filePath, totalBytes });
    }
    const requestedOffset =
        offset === undefined || offset === null ? null : Math.max(0, Number(offset) || 0);
    const start = requestedOffset === null ? Math.max(0, totalBytes - tailBytes) : requestedOffset;
    const clampedStart = Math.min(start, totalBytes);
    const length = Math.min(tailBytes, totalBytes - clampedStart);
    let text = '';
    if (length > 0) {
        const fd = fs.openSync(filePath, 'r');
        try {
            const buffer = Buffer.alloc(length);
            const read = fs.readSync(fd, buffer, 0, length, clampedStart);
            text = buffer.subarray(0, read).toString('utf8');
        } finally {
            try {
                fs.closeSync(fd);
            } catch {
                // ignore
            }
        }
    }
    return {
        text,
        bytes: Buffer.byteLength(text, 'utf8'),
        totalBytes,
        offset: clampedStart,
        truncated: clampedStart > 0,
        tailBytes,
    };
}

async function handlePcBgProcess(rawArgs) {
    const args = isPlainObject(rawArgs) ? rawArgs : {};
    const actionRaw = requireStringArg(args, 'action');
    const action = actionRaw.trim().toLowerCase();
    loadBackgroundRegistry();

    if (action === 'start') {
        const command = requireStringArg(args, 'command');
        const workflowId = optionalWorkflowIdArg(args);
        const nameRaw = optionalStringArg(args, 'name');
        const name = nameRaw && nameRaw.trim().length > 0 ? nameRaw.trim() : null;
        const explicitCwd = optionalStringArg(args, 'cwd');
        let cwd = null;
        let sessionEnv = {};
        if (explicitCwd && explicitCwd.trim().length > 0) {
            cwd = resolveUserPath(explicitCwd);
            if (!isDirectoryPath(cwd)) {
                throw new ToolError(`Working directory does not exist: ${cwd}`);
            }
        } else if (workflowId) {
            const session = getShellSession(workflowId);
            if (!isDirectoryPath(session.cwd)) {
                throw new ToolError(
                    `Session working directory no longer exists: ${session.cwd}. Pass cwd or reset the session with pc_shell_session.`
                );
            }
            cwd = session.cwd;
            sessionEnv = session.env;
        } else {
            cwd = os.homedir();
        }
        const envUpdates = validateEnvUpdates(args.env, 'env');
        const spawnEnv = { ...sessionEnv };
        for (const [nameKey, value] of Object.entries(envUpdates)) {
            if (value === null) delete spawnEnv[nameKey];
            else spawnEnv[nameKey] = value;
        }
        const record = startManagedBackgroundProcess({
            command,
            cwd,
            workflowId,
            name,
            env: buildSessionEnvironment(process.env, spawnEnv),
        });
        return {
            action: 'start',
            started: true,
            ...describeManagedProcess(record, { includeLogBytes: true }),
            detached: true,
            note: 'Background process is detached and keeps running after the daemon exits; manage it with pc_bg_process status|logs|kill.',
        };
    }

    if (action === 'list') {
        const workflowId = optionalWorkflowIdArg(args);
        const processes = listManagedBackgroundProcesses({ workflowId });
        return {
            action: 'list',
            count: processes.length,
            running: processes.filter((process) => process.running).length,
            processes,
            registryPath: backgroundRegistryFilePath(),
        };
    }

    if (action === 'status' || action === 'logs' || action === 'kill') {
        const id = requireStringArg(args, 'id');
        refreshManagedBackgroundProcesses();
        const record = managedBackgroundProcesses.get(id);
        if (!record) {
            throw new ToolError(
                `Unknown background process id "${id}". Use pc_bg_process {action:"list"} to see managed processes.`
            );
        }
        if (action === 'status') {
            return {
                action: 'status',
                ...describeManagedProcess(record, { includeLogBytes: true }),
            };
        }
        if (action === 'logs') {
            const tailBytes = optionalNumberArg(args, 'tailBytes', {
                defaultValue: BG_LOG_TAIL_DEFAULT_BYTES,
                min: 1,
                max: BG_LOG_TAIL_MAX_BYTES,
            });
            const offset = optionalNumberArg(args, 'offset', {
                defaultValue: null,
                min: 0,
                integer: true,
            });
            const logRead = readBoundedLog(record.logPath, { tailBytes, offset });
            return {
                action: 'logs',
                id: record.id,
                pid: record.pid,
                running: isManagedProcessRunning(record),
                logPath: record.logPath,
                ...logRead,
            };
        }
        const signalRaw = optionalStringArg(args, 'signal');
        const signal = signalRaw && signalRaw.trim().length > 0 ? signalRaw.trim().toUpperCase() : 'SIGTERM';
        if (!['SIGTERM', 'SIGINT', 'SIGKILL'].includes(signal)) {
            throw new ToolError('signal must be one of "SIGTERM", "SIGINT" or "SIGKILL".');
        }
        if (!isManagedProcessRunning(record)) {
            if (!record.endedAt) {
                record.endedAt = Date.now();
                persistBackgroundRegistry();
            }
            return {
                action: 'kill',
                killed: false,
                alreadyExited: true,
                ...describeManagedProcess(record, { includeLogBytes: true }),
            };
        }
        const killResult = killProcessTreeByPid(record.pid, signal);
        const deadline = Date.now() + BG_KILL_WAIT_MS;
        while (Date.now() < deadline && isPidAlive(record.pid)) {
            await delay(BG_KILL_POLL_MS);
        }
        let forced = false;
        if (isPidAlive(record.pid) && signal !== 'SIGKILL') {
            forced = true;
            log.warn('background process survived the requested signal; force-killing tree', {
                id,
                pid: record.pid,
                signal,
            });
            killProcessTreeByPid(record.pid, 'SIGKILL');
            const forceDeadline = Date.now() + BG_KILL_WAIT_MS;
            while (Date.now() < forceDeadline && isPidAlive(record.pid)) {
                await delay(BG_KILL_POLL_MS);
            }
        }
        const running = isPidAlive(record.pid);
        if (!running) {
            record.endedAt = record.endedAt || Date.now();
            record.signal = signal;
            persistBackgroundRegistry();
        }
        return {
            action: 'kill',
            killed: !running,
            forced,
            signal,
            killTool: killResult.tool,
            ...describeManagedProcess(record, { includeLogBytes: true }),
        };
    }

    throw new ToolError(
        `Unknown pc_bg_process action "${actionRaw}". Use one of: start, status, logs, kill, list.`
    );
}

async function handlePcShellSession(rawArgs) {
    const args = isPlainObject(rawArgs) ? rawArgs : {};
    const actionRaw = requireStringArg(args, 'action');
    const action = actionRaw.trim().toLowerCase();
    if (action === 'list') {
        const sessions = listShellSessionSummaries();
        return {
            action: 'list',
            count: sessions.length,
            sessions,
            sessionsPath: shellSessionsFilePath(),
        };
    }
    if (action !== 'info' && action !== 'reset') {
        throw new ToolError(
            `Unknown pc_shell_session action "${actionRaw}". Use one of: info, reset, list.`
        );
    }
    const workflowId = sanitizeWorkflowId(requireStringArg(args, 'workflowId'));
    loadShellSessions();
    if (action === 'reset') {
        const existed = shellSessions.delete(workflowId);
        persistShellSessions();
        log.info('shell session reset', { workflowId, existed });
        return {
            action: 'reset',
            workflowId,
            reset: true,
            existed,
            cwd: os.homedir(),
            previousCwd: null,
            pushdStack: [],
            env: {},
            envCount: 0,
            updatedAt: new Date().toISOString(),
        };
    }
    const existing = shellSessions.get(workflowId);
    const session = existing || getShellSession(workflowId);
    if (!existing) persistShellSessions();
    return {
        action: 'info',
        created: !existing,
        ...shellSessionSnapshot(session),
        backgroundProcesses: listManagedBackgroundProcesses({ workflowId }),
        sessionsPath: shellSessionsFilePath(),
    };
}

/** Resolve an optional directory argument; null when absent/blank. */
function resolveOptionalCwdArg(args) {
    const raw = optionalStringArg(args, 'cwd');
    if (raw === undefined || raw === null || raw.trim().length === 0) return null;
    const cwd = resolveUserPath(raw);
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

async function handlePcExecShell(rawArgs) {
    const startedAt = Date.now();
    const args = isPlainObject(rawArgs) ? rawArgs : {};
    const command = requireStringArg(args, 'command');
    const workflowId = optionalWorkflowIdArg(args);
    const explicitCwd = resolveOptionalCwdArg(args);
    const envUpdates = validateEnvUpdates(args.env, 'env');

    let session = null;
    if (workflowId) {
        session = getShellSession(workflowId);
        if (explicitCwd) changeSessionDirectory(session, explicitCwd, 'cwd parameter');
        if (!isDirectoryPath(session.cwd)) {
            throw new ToolError(
                `Session working directory no longer exists: ${session.cwd}. Pass cwd or reset the session with pc_shell_session.`
            );
        }
    } else {
        session = createShellSession(null, explicitCwd || os.homedir());
    }
    if (Object.keys(envUpdates).length > 0) {
        session.env = mergeShellSessionEnv(session.env, envUpdates);
    }

    const builtinRun = applyShellBuiltins({ command, session, baseEnv: process.env });
    const builtins = builtinRun.applied.map((outcome) => outcome.builtin);
    const changedState =
        builtins.length > 0 || Object.keys(envUpdates).length > 0 || Boolean(explicitCwd);
    if (workflowId) {
        touchShellSession(session);
        session.calls += 1;
        if (changedState) persistShellSessions();
    }

    const background = optionalBooleanArg(args, 'background', false);
    if (background) {
        const backgroundCommand = builtinRun.remainingCommand;
        if (!backgroundCommand) {
            throw new ToolError(
                'background:true requires a command to run after any leading shell builtins; the whole command line was consumed by builtins.'
            );
        }
        const record = startManagedBackgroundProcess({
            command: backgroundCommand,
            cwd: session.cwd,
            workflowId,
            name: null,
            env: buildSessionEnvironment(process.env, session.env),
        });
        return {
            id: record.id,
            pid: record.pid,
            logPath: record.logPath,
            started: true,
            command,
            executedCommand: backgroundCommand,
            cwd: session.cwd,
            workflowId: workflowId || null,
            detached: true,
            background: true,
            note: 'Background process is detached and keeps running after the daemon exits; manage it with pc_bg_process.',
        };
    }

    if (!builtinRun.remainingCommand) {
        return buildInterceptedShellPayload({ command, workflowId, session, applied: builtinRun.applied, startedAt });
    }

    const timeoutMs = resolveShellTimeout(args);
    const result = await runForegroundShell({
        command: builtinRun.remainingCommand,
        cwd: session.cwd,
        timeoutMs,
        env: buildSessionEnvironment(process.env, session.env),
    });
    return {
        ...result,
        command,
        executedCommand: builtinRun.remainingCommand,
        workflowId: workflowId || null,
        sessionCwd: session.cwd,
        intercepted: false,
        spawn: true,
        builtins,
    };
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
// Directory tree tool (gitignore-aware pc_fs_tree)
// ---------------------------------------------------------------------------

const REGEX_LITERAL_ESCAPES = /[\\^$.*+?()[\]{}|]/;

function escapeRegexLiteral(character) {
    return REGEX_LITERAL_ESCAPES.test(character) ? `\\${character}` : character;
}

function detectGitRootForDirectory(directory) {
    try {
        const result = spawnSync('git', ['rev-parse', '--show-toplevel'], {
            cwd: directory,
            encoding: 'utf8',
            timeout: GIT_TIMEOUT_MS,
            windowsHide: true,
        });
        if (!result.error && result.status === 0) {
            const root = String(result.stdout || '').trim();
            if (root) return path.resolve(root);
        }
    } catch {
        // git missing/not a repo: fall back to the directory itself
    }
    return null;
}

function toRepoRelativePath(repoRoot, absolutePath) {
    const relative = path.relative(repoRoot, absolutePath);
    if (!relative) return '';
    return relative.split(path.sep).join('/');
}

/** Compile one .gitignore line into a matcher (null for comments/blank lines). */
function compileGitignorePatternLine(rawLine, baseRelDir) {
    let line = String(rawLine === undefined || rawLine === null ? '' : rawLine).replace(/\r$/, '');
    if (!line || line.startsWith('#')) return null;
    // Unescaped trailing whitespace is ignored by git.
    line = line.replace(/(?<!\\)\s+$/, '');
    if (!line) return null;
    let negate = false;
    if (line.startsWith('!')) {
        negate = true;
        line = line.slice(1);
    }
    if (!line) return null;
    let dirOnly = false;
    if (line.endsWith('/')) {
        dirOnly = true;
        line = line.replace(/\/+$/, '');
    }
    if (!line) return null;
    let anchored = false;
    if (line.startsWith('/')) {
        anchored = true;
        line = line.replace(/^\/+/, '');
    }
    if (!line) return null;
    const hasSlash = line.includes('/');
    let source = '';
    for (let index = 0; index < line.length; index += 1) {
        const ch = line[index];
        if (ch === '\\' && index + 1 < line.length) {
            index += 1;
            source += escapeRegexLiteral(line[index]);
            continue;
        }
        if (ch === '*') {
            if (line[index + 1] === '*') {
                index += 1;
                if (line[index + 1] === '/') {
                    index += 1;
                    source += '(?:.*/)?';
                } else {
                    source += '.*';
                }
            } else {
                source += '[^/]*';
            }
            continue;
        }
        if (ch === '?') {
            source += '[^/]';
            continue;
        }
        if (ch === '[') {
            const close = line.indexOf(']', index + 1);
            if (close === -1) {
                source += '\\[';
                continue;
            }
            const inner = line.slice(index + 1, close);
            source += `[${inner.startsWith('!') ? `^${inner.slice(1)}` : inner}]`;
            index = close;
            continue;
        }
        source += escapeRegexLiteral(ch);
    }
    let regex = null;
    try {
        regex = new RegExp(`^${source}$`);
    } catch {
        return null;
    }
    return { negate, dirOnly, anchored, hasSlash, regex, baseRelDir: baseRelDir || '' };
}

function readGitignoreRulesForDirectory(absoluteDir, dirRepoRel) {
    const rules = [];
    let content = '';
    try {
        content = fs.readFileSync(path.join(absoluteDir, '.gitignore'), 'utf8');
    } catch {
        return rules;
    }
    for (const line of content.split(/\r?\n/)) {
        const rule = compileGitignorePatternLine(line, dirRepoRel);
        if (rule) rules.push(rule);
    }
    return rules;
}

/** Load .gitignore rules from the repo root down to (and including) directory. */
function createGitignoreMatcher(directory) {
    const repoRoot = detectGitRootForDirectory(directory) || directory;
    const rules = [];
    const chain = [{ dir: repoRoot, rel: '' }];
    const relativeRoot = path.relative(repoRoot, directory);
    if (relativeRoot && relativeRoot !== '') {
        let current = repoRoot;
        for (const part of relativeRoot.split(path.sep)) {
            if (!part || part === '..' || part === '.') continue;
            current = path.join(current, part);
            chain.push({ dir: current, rel: toRepoRelativePath(repoRoot, current) });
        }
    }
    for (const entry of chain) {
        rules.push(...readGitignoreRulesForDirectory(entry.dir, entry.rel));
    }
    return { repoRoot, rules };
}

function gitignoreRuleMatches(rule, repoRelPath, isDirectory, basename) {
    let candidate = repoRelPath;
    if (rule.baseRelDir) {
        if (repoRelPath === rule.baseRelDir) return false;
        const prefix = `${rule.baseRelDir}/`;
        if (!repoRelPath.startsWith(prefix)) return false;
        candidate = repoRelPath.slice(prefix.length);
    }
    if (rule.dirOnly && !isDirectory) return false;
    if (rule.hasSlash || rule.anchored) return rule.regex.test(candidate);
    return rule.regex.test(basename);
}

function isPathIgnoredByGitignore(rules, repoRelPath, isDirectory) {
    if (!repoRelPath) return false;
    const basename = path.posix.basename(repoRelPath);
    let ignored = false;
    for (const rule of rules) {
        if (gitignoreRuleMatches(rule, repoRelPath, isDirectory, basename)) {
            ignored = !rule.negate;
        }
    }
    return ignored;
}

function readDirentSize(absolutePath) {
    try {
        return fs.statSync(absolutePath).size;
    } catch {
        return null;
    }
}

async function handlePcFsTree(rawArgs) {
    const startedAt = Date.now();
    const args = isPlainObject(rawArgs) ? rawArgs : {};
    const directory = resolveUserPath(requireStringArg(args, 'directory'));
    const depth = optionalNumberArg(args, 'depth', {
        defaultValue: FS_TREE_DEFAULT_DEPTH,
        min: 0,
        max: FS_TREE_MAX_DEPTH,
    });
    const respectGitignore = optionalBooleanArg(args, 'respectGitignore', true);
    const maxEntries = optionalNumberArg(args, 'maxEntries', {
        defaultValue: FS_TREE_DEFAULT_MAX_ENTRIES,
        min: 1,
        max: FS_TREE_MAX_ENTRIES,
    });
    let stat = null;
    try {
        stat = fs.statSync(directory);
    } catch {
        throw new ToolError(`Directory not found: ${directory}`);
    }
    if (!stat.isDirectory()) {
        throw new ToolError(`Not a directory: ${directory}`);
    }

    const matcher = respectGitignore ? createGitignoreMatcher(directory) : null;
    const repoRoot = matcher ? matcher.repoRoot : null;
    const rules = matcher ? matcher.rules : [];
    const stats = { directories: 0, files: 0, symlinks: 0, ignored: 0, totalNodes: 0 };
    const flatFiles = [];
    let truncated = false;
    let stopped = false;

    const rootNode = {
        name: path.basename(directory) || directory,
        path: '.',
        type: 'directory',
        children: [],
    };
    stats.directories += 1;
    stats.totalNodes += 1;

    const walk = (node, absoluteDir, relFromRoot, level) => {
        if (stopped || level >= depth) return;
        if (respectGitignore && level > 0) {
            const dirRepoRel = toRepoRelativePath(repoRoot, absoluteDir);
            rules.push(...readGitignoreRulesForDirectory(absoluteDir, dirRepoRel));
        }
        let entries = [];
        try {
            entries = fs.readdirSync(absoluteDir, { withFileTypes: true });
        } catch (error) {
            node.error = errorMessage(error);
            return;
        }
        entries.sort((left, right) => {
            const leftRank = left.isDirectory() ? 0 : 1;
            const rightRank = right.isDirectory() ? 0 : 1;
            if (leftRank !== rightRank) return leftRank - rightRank;
            return left.name.localeCompare(right.name);
        });
        for (const entry of entries) {
            if (stopped) return;
            const childAbs = path.join(absoluteDir, entry.name);
            const childRel = relFromRoot ? `${relFromRoot}/${entry.name}` : entry.name;
            if (entry.isDirectory() && entry.name === '.git') {
                stats.ignored += 1;
                continue;
            }
            if (respectGitignore) {
                const repoRel = toRepoRelativePath(repoRoot, childAbs);
                if (isPathIgnoredByGitignore(rules, repoRel, entry.isDirectory())) {
                    stats.ignored += 1;
                    continue;
                }
            }
            if (stats.totalNodes >= maxEntries) {
                truncated = true;
                stopped = true;
                return;
            }
            if (entry.isSymbolicLink()) {
                const size = readDirentSize(childAbs);
                node.children.push({ name: entry.name, path: childRel, type: 'symlink', size });
                stats.symlinks += 1;
                stats.totalNodes += 1;
                continue;
            }
            if (entry.isDirectory()) {
                const childNode = {
                    name: entry.name,
                    path: childRel,
                    type: 'directory',
                    children: [],
                };
                node.children.push(childNode);
                stats.directories += 1;
                stats.totalNodes += 1;
                walk(childNode, childAbs, childRel, level + 1);
                continue;
            }
            if (!entry.isFile()) continue;
            const size = readDirentSize(childAbs);
            node.children.push({ name: entry.name, path: childRel, type: 'file', size });
            flatFiles.push(childRel);
            stats.files += 1;
            stats.totalNodes += 1;
        }
    };

    walk(rootNode, directory, '', 0);

    return {
        directory,
        gitRoot: repoRoot,
        depth,
        respectGitignore,
        maxEntries,
        totalNodes: stats.totalNodes,
        directories: stats.directories,
        files: stats.files,
        symlinks: stats.symlinks,
        ignored: stats.ignored,
        truncated,
        durationMs: Date.now() - startedAt,
        tree: rootNode,
        flatFiles,
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

function searchWithRipgrep({ directory, pattern, fileGlob, maxResults, caseInsensitive }) {
    const startedAt = Date.now();
    const args = [
        '--line-number',
        '--with-filename',
        '--no-messages',
        '--color',
        'never',
        '--max-count',
        String(maxResults),
    ];
    if (caseInsensitive) args.push('--ignore-case');
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
        if (matches.length >= maxResults) break;
    }
    return {
        matches,
        count: matches.length,
        engine: 'rg',
        truncated: outputLines.length > maxResults,
        directory,
        pattern,
        fileGlob: fileGlob || null,
        durationMs: Date.now() - startedAt,
    };
}

function searchWithNode({ directory, pattern, fileGlob, maxResults, caseInsensitive }) {
    const startedAt = Date.now();
    const deadline = startedAt + SEARCH_TIMEOUT_MS;
    let matcher = null;
    try {
        matcher = new RegExp(pattern, caseInsensitive ? 'i' : '');
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
        if (matches.length >= maxResults) {
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
            if (matches.length >= maxResults) {
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
                    if (matches.length >= maxResults) {
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

/** Attach surrounding-line context to search matches (per-file read cache). */
function attachSearchContext(matches, contextLines) {
    if (!contextLines || contextLines <= 0 || matches.length === 0) return matches;
    const fileCache = new Map();
    return matches.map((match) => {
        let fileLines = fileCache.get(match.file);
        if (fileLines === undefined) {
            try {
                const stat = fs.statSync(match.file);
                fileLines =
                    stat.size > SEARCH_MAX_FILE_BYTES
                        ? null
                        : fs.readFileSync(match.file, 'utf8').split(/\r?\n/);
            } catch {
                fileLines = null;
            }
            fileCache.set(match.file, fileLines);
        }
        if (!fileLines) return match;
        const lineIndex = match.line - 1;
        if (lineIndex < 0 || lineIndex >= fileLines.length) return match;
        const startIndex = Math.max(0, lineIndex - contextLines);
        const endIndex = Math.min(fileLines.length - 1, lineIndex + contextLines);
        const context = [];
        for (let index = startIndex; index <= endIndex; index += 1) {
            context.push({ line: index + 1, text: fileLines[index], isMatch: index === lineIndex });
        }
        return { ...match, context };
    });
}

async function handlePcSearchCode(rawArgs) {
    const args = isPlainObject(rawArgs) ? rawArgs : {};
    const directory = resolveUserPath(requireStringArg(args, 'directory'));
    const pattern = requireStringArg(args, 'pattern');
    const fileGlobRaw = optionalStringArg(args, 'fileGlob');
    const fileGlob = fileGlobRaw && fileGlobRaw.trim().length > 0 ? fileGlobRaw.trim() : null;
    const caseInsensitive = optionalBooleanArg(args, 'caseInsensitive', false);
    const contextLines = optionalNumberArg(args, 'contextLines', {
        defaultValue: 0,
        min: 0,
        max: SEARCH_MAX_CONTEXT_LINES,
    });
    const maxResults = optionalNumberArg(args, 'maxResults', {
        defaultValue: SEARCH_MAX_MATCHES,
        min: 1,
        max: SEARCH_MAX_RESULTS,
    });

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
        new RegExp(pattern, caseInsensitive ? 'i' : '');
    } catch (error) {
        throw new ToolError(`Invalid regular expression "${pattern}": ${errorMessage(error)}`);
    }
    if (fileGlob) compileGlob(fileGlob); // validates the glob up-front

    let payload = null;
    if (detectRipgrep()) {
        payload = searchWithRipgrep({ directory, pattern, fileGlob, maxResults, caseInsensitive });
    }
    if (!payload) {
        payload = searchWithNode({ directory, pattern, fileGlob, maxResults, caseInsensitive });
    }
    if (contextLines > 0) {
        payload.matches = attachSearchContext(payload.matches, contextLines);
    }
    return {
        ...payload,
        contextLines,
        caseInsensitive,
        maxResults,
    };
}

// ---------------------------------------------------------------------------
// Git suite (argv-array spawnSync only, never shell strings)
// ---------------------------------------------------------------------------

function gitErrorText(result) {
    const parts = [String(result.stderr || '').trim(), String(result.stdout || '').trim()].filter(
        (part) => part.length > 0
    );
    const text = parts.join('\n');
    if (!text) return `git exited with code ${result.status}`;
    return text.length > 800 ? `${text.slice(0, 800)}...` : text;
}

function runGit(directory, args, options = {}) {
    const timeoutMs =
        options.timeoutMs === undefined || options.timeoutMs === null
            ? GIT_TIMEOUT_MS
            : options.timeoutMs;
    let result = null;
    try {
        result = spawnSync('git', args, {
            cwd: directory,
            encoding: 'utf8',
            timeout: timeoutMs,
            windowsHide: true,
            maxBuffer: GIT_MAX_BUFFER,
        });
    } catch (error) {
        throw new ToolError(`Failed to run git: ${errorMessage(error)}`);
    }
    if (result.error) {
        if (result.error.code === 'ENOENT') {
            throw new ToolError(
                'git is not installed or not on PATH. Install Git to use the pc_git_* tools.'
            );
        }
        if (result.error.code === 'ETIMEDOUT') {
            throw new ToolError(`git ${args[0] || ''} timed out after ${timeoutMs}ms.`);
        }
        throw new ToolError(`git ${args[0] || ''} failed: ${errorMessage(result.error)}`);
    }
    return {
        status: result.status,
        stdout: result.stdout || '',
        stderr: result.stderr || '',
        directory,
    };
}

function resolveGitRepository(args) {
    const directory = resolveUserPath(requireStringArg(args, 'directory'));
    let stat = null;
    try {
        stat = fs.statSync(directory);
    } catch {
        throw new ToolError(`Directory not found: ${directory}`);
    }
    if (!stat.isDirectory()) {
        throw new ToolError(`Not a directory: ${directory}`);
    }
    const probe = runGit(directory, ['rev-parse', '--show-toplevel']);
    if (probe.status !== 0) {
        throw new ToolError(
            `Not a git repository: ${directory}. Run "git init" there or point the tool at a repository directory. (${gitErrorText(probe)})`
        );
    }
    const rootText = String(probe.stdout || '').trim();
    return { directory, root: path.resolve(rootText || directory) };
}

function parseGitStatusPorcelain(text) {
    const summary = {
        branch: null,
        detached: false,
        upstream: null,
        ahead: 0,
        behind: 0,
        noCommits: false,
    };
    const changes = [];
    let truncated = false;
    for (const line of String(text || '').split('\n')) {
        if (!line) continue;
        if (line.startsWith('## ')) {
            const info = line.slice(3).trim();
            const noCommitsMatch = /^No commits yet on (.+)$/.exec(info);
            if (noCommitsMatch) {
                summary.branch = noCommitsMatch[1];
                summary.noCommits = true;
                continue;
            }
            if (/^HEAD \(no branch\)$/.test(info) || info.startsWith('HEAD (no branch)')) {
                summary.branch = 'HEAD';
                summary.detached = true;
                continue;
            }
            const aheadMatch = /ahead (\d+)/.exec(info);
            if (aheadMatch) summary.ahead = Number(aheadMatch[1]);
            const behindMatch = /behind (\d+)/.exec(info);
            if (behindMatch) summary.behind = Number(behindMatch[1]);
            let branchPart = info;
            const bracket = info.indexOf(' [');
            if (bracket !== -1) branchPart = info.slice(0, bracket);
            if (branchPart.includes('...')) {
                const parts = branchPart.split('...');
                summary.branch = parts[0];
                summary.upstream = parts[1] || null;
            } else {
                summary.branch = branchPart;
            }
            continue;
        }
        if (changes.length >= GIT_MAX_STATUS_CHANGES) {
            truncated = true;
            continue;
        }
        const indexStatus = line.slice(0, 1);
        const worktreeStatus = line.slice(1, 2);
        let rest = line.slice(3);
        let originalPath = null;
        const arrow = rest.indexOf(' -> ');
        if (arrow !== -1) {
            originalPath = rest.slice(0, arrow);
            rest = rest.slice(arrow + 4);
        }
        changes.push({
            code: line.slice(0, 2),
            indexStatus,
            worktreeStatus,
            path: rest,
            originalPath,
        });
    }
    return { ...summary, changes, truncated };
}

function buildGitStatusPayload({ directory, root }) {
    const result = runGit(root, ['status', '--porcelain=v1', '--untracked-files=all', '-b']);
    if (result.status !== 0) {
        throw new ToolError(`git status failed in ${root}: ${gitErrorText(result)}`);
    }
    const parsed = parseGitStatusPorcelain(result.stdout);
    const staged = parsed.changes.filter(
        (change) => change.indexStatus !== ' ' && change.indexStatus !== '?'
    ).length;
    const unstaged = parsed.changes.filter(
        (change) => change.worktreeStatus !== ' ' && change.indexStatus !== '?'
    ).length;
    const untracked = parsed.changes.filter((change) => change.indexStatus === '?').length;
    return {
        directory,
        root,
        branch: parsed.branch,
        detached: parsed.detached,
        noCommits: parsed.noCommits,
        upstream: parsed.upstream,
        ahead: parsed.ahead,
        behind: parsed.behind,
        clean: parsed.changes.length === 0,
        counts: {
            changes: parsed.changes.length,
            staged,
            unstaged,
            untracked,
        },
        changes: parsed.changes,
        truncated: parsed.truncated,
        porcelain: String(result.stdout || '').trimEnd(),
    };
}

function truncateGitText(text, maxChars) {
    const full = String(text || '');
    if (full.length <= maxChars) {
        return { text: full, truncated: false, totalChars: full.length };
    }
    return {
        text: `${full.slice(0, maxChars)}\n...[diff truncated at ${maxChars} chars]`,
        truncated: true,
        totalChars: full.length,
    };
}

function countDiffFiles(diffText) {
    const matches = String(diffText || '').match(/^diff --git /gm);
    return matches ? matches.length : 0;
}

function buildGitDiffPayload({ directory, root }, options = {}) {
    const staged = options.staged === true;
    const contextLines = options.contextLines === undefined ? 3 : options.contextLines;
    const pathFilter = options.path ? String(options.path) : null;
    const diffArgs = ['diff', '--no-color', '--no-ext-diff', '--no-textconv', `-U${contextLines}`];
    if (staged) diffArgs.push('--cached');
    if (pathFilter) diffArgs.push('--', pathFilter);
    const diffResult = runGit(root, diffArgs);
    if (diffResult.status !== 0) {
        throw new ToolError(`git diff failed in ${root}: ${gitErrorText(diffResult)}`);
    }
    const statArgs = ['diff', '--stat', '--no-color', '--no-ext-diff'];
    if (staged) statArgs.push('--cached');
    if (pathFilter) statArgs.push('--', pathFilter);
    const statResult = runGit(root, statArgs);
    const diffInfo = truncateGitText(diffResult.stdout, GIT_MAX_DIFF_CHARS);
    return {
        directory,
        root,
        staged,
        contextLines,
        path: pathFilter,
        diff: diffInfo.text,
        truncated: diffInfo.truncated,
        totalChars: diffInfo.totalChars,
        filesChanged: countDiffFiles(diffResult.stdout),
        stat: String(statResult.stdout || '').trimEnd(),
    };
}

function buildGitLogPayload({ directory, root }, { maxCount }) {
    const formatToken = ['%H', '%h', '%an', '%ae', '%aI', '%s'].join('%x1f') + '%x1e';
    const result = runGit(root, ['log', '-n', String(maxCount), `--format=${formatToken}`]);
    if (result.status !== 0) {
        const text = gitErrorText(result);
        if (/does not have any commits yet|unknown revision|ambiguous argument 'HEAD'/i.test(text)) {
            return { directory, root, count: 0, commits: [] };
        }
        throw new ToolError(`git log failed in ${root}: ${text}`);
    }
    const commits = [];
    for (const chunk of String(result.stdout || '').split('\x1e')) {
        const record = chunk.trim();
        if (!record) continue;
        const fields = record.split('\x1f');
        if (fields.length < 6) continue;
        commits.push({
            hash: fields[0],
            shortHash: fields[1],
            author: fields[2],
            authorEmail: fields[3],
            date: fields[4],
            subject: fields[5],
        });
    }
    return { directory, root, count: commits.length, commits };
}

function requireStringArrayArg(args, key) {
    const raw = args[key];
    if (typeof raw === 'string') {
        if (!raw.trim()) {
            throw new ToolError(`Parameter "${key}" must be a non-empty string or array of strings.`);
        }
        return [raw];
    }
    if (!Array.isArray(raw) || raw.length === 0) {
        throw new ToolError(`Parameter "${key}" is required and must be a non-empty array of strings.`);
    }
    if (!raw.every((item) => typeof item === 'string' && item.trim().length > 0)) {
        throw new ToolError(`Parameter "${key}" must contain only non-empty strings.`);
    }
    return raw;
}

async function handlePcGitStatus(rawArgs) {
    const args = isPlainObject(rawArgs) ? rawArgs : {};
    return buildGitStatusPayload(resolveGitRepository(args));
}

async function handlePcGitDiff(rawArgs) {
    const args = isPlainObject(rawArgs) ? rawArgs : {};
    const repo = resolveGitRepository(args);
    const staged = optionalBooleanArg(args, 'staged', false);
    const contextLines = optionalNumberArg(args, 'contextLines', {
        defaultValue: 3,
        min: 0,
        max: 10,
    });
    const pathFilterRaw = optionalStringArg(args, 'path');
    const pathFilter =
        pathFilterRaw && pathFilterRaw.trim().length > 0 ? pathFilterRaw.trim() : null;
    const payload = buildGitDiffPayload(repo, { staged, contextLines, path: pathFilter });
    return { action: staged ? 'diff-staged' : 'diff', ...payload };
}

async function handlePcGitStatusDiff(rawArgs) {
    const args = isPlainObject(rawArgs) ? rawArgs : {};
    const repo = resolveGitRepository(args);
    const maxCommits = optionalNumberArg(args, 'maxCommits', {
        defaultValue: 10,
        min: 1,
        max: GIT_MAX_LOG_COUNT,
    });
    const status = buildGitStatusPayload(repo);
    const unstaged = buildGitDiffPayload(repo, { staged: false });
    const staged = buildGitDiffPayload(repo, { staged: true });
    const log = buildGitLogPayload(repo, { maxCount: maxCommits });
    return {
        action: 'status-diff',
        directory: repo.directory,
        root: repo.root,
        branch: status.branch,
        clean: status.clean,
        status,
        diff: {
            unstaged: unstaged.diff,
            staged: staged.diff,
            stat: unstaged.stat,
            stagedStat: staged.stat,
            filesChanged: unstaged.filesChanged + staged.filesChanged,
            truncated: unstaged.truncated || staged.truncated,
            contextLines: 3,
        },
        commits: log.commits,
        commitCount: log.count,
    };
}

async function handlePcGitAdd(rawArgs) {
    const args = isPlainObject(rawArgs) ? rawArgs : {};
    const repo = resolveGitRepository(args);
    const requestedPaths = requireStringArrayArg(args, 'paths');
    for (const requestedPath of requestedPaths) {
        if (requestedPath.trim().startsWith('-')) {
            throw new ToolError(`Refusing git path "${requestedPath}": paths must not start with "-".`);
        }
        const resolved = path.resolve(repo.root, requestedPath);
        const relative = path.relative(repo.root, resolved);
        if (relative.startsWith('..') || path.isAbsolute(relative)) {
            throw new ToolError(
                `Refusing git path "${requestedPath}": it resolves outside the repository ${repo.root}.`
            );
        }
    }
    const result = runGit(repo.root, ['add', '--', ...requestedPaths]);
    if (result.status !== 0) {
        throw new ToolError(`git add failed in ${repo.root}: ${gitErrorText(result)}`);
    }
    return {
        action: 'add',
        directory: repo.directory,
        root: repo.root,
        added: requestedPaths,
        status: buildGitStatusPayload(repo),
    };
}

async function handlePcGitCommit(rawArgs) {
    const args = isPlainObject(rawArgs) ? rawArgs : {};
    const repo = resolveGitRepository(args);
    const message = requireStringArg(args, 'message', { allowEmpty: true });
    if (!message.trim()) {
        throw new ToolError('Parameter "message" is required and must be a non-empty commit message.');
    }
    const all = optionalBooleanArg(args, 'all', false);
    const commitArgs = ['commit', '-m', message];
    if (all) commitArgs.push('-a');
    const result = runGit(repo.root, commitArgs);
    if (result.status !== 0) {
        throw new ToolError(`git commit failed in ${repo.root}: ${gitErrorText(result)}`);
    }
    const hashResult = runGit(repo.root, ['rev-parse', 'HEAD']);
    const hash = hashResult.status === 0 ? String(hashResult.stdout || '').trim() : null;
    let subject = null;
    if (hash) {
        const subjectResult = runGit(repo.root, ['log', '-1', '--format=%s']);
        if (subjectResult.status === 0) subject = String(subjectResult.stdout || '').trim();
    }
    return {
        action: 'commit',
        directory: repo.directory,
        root: repo.root,
        committed: true,
        hash,
        shortHash: hash ? hash.slice(0, 7) : null,
        subject,
        all,
        output: String(result.stdout || '').trim(),
        status: buildGitStatusPayload(repo),
    };
}

async function handlePcGitCheckout(rawArgs) {
    const args = isPlainObject(rawArgs) ? rawArgs : {};
    const repo = resolveGitRepository(args);
    const branch = requireStringArg(args, 'branch').trim();
    if (branch.startsWith('-')) {
        throw new ToolError(`Refusing branch name "${branch}": branch names must not start with "-".`);
    }
    const create = optionalBooleanArg(args, 'create', false);
    const checkoutArgs = create ? ['checkout', '-b', branch] : ['checkout', branch];
    const result = runGit(repo.root, checkoutArgs);
    if (result.status !== 0) {
        throw new ToolError(`git checkout failed in ${repo.root}: ${gitErrorText(result)}`);
    }
    const current = runGit(repo.root, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const currentBranch = current.status === 0 ? String(current.stdout || '').trim() : branch;
    return {
        action: 'checkout',
        directory: repo.directory,
        root: repo.root,
        branch: currentBranch,
        created: create,
        output: `${String(result.stdout || '').trim()}\n${String(result.stderr || '').trim()}`.trim(),
    };
}

async function handlePcGitLog(rawArgs) {
    const args = isPlainObject(rawArgs) ? rawArgs : {};
    const repo = resolveGitRepository(args);
    const maxCount = optionalNumberArg(args, 'maxCount', {
        defaultValue: GIT_DEFAULT_LOG_COUNT,
        min: 1,
        max: GIT_MAX_LOG_COUNT,
    });
    const payload = buildGitLogPayload(repo, { maxCount });
    return {
        action: 'log',
        directory: payload.directory,
        root: payload.root,
        maxCount,
        count: payload.count,
        commits: payload.commits,
    };
}

// ---------------------------------------------------------------------------
// Desktop computer-use tools (screenshot + clipboard through OS-native CLIs)
// ---------------------------------------------------------------------------

let powerShellProbe = undefined; // undefined = not probed, null = unavailable, string = executable

function findPowerShell() {
    if (powerShellProbe !== undefined) return powerShellProbe;
    const candidates = IS_WINDOWS
        ? ['powershell.exe', 'powershell', 'pwsh.exe', 'pwsh']
        : ['pwsh', 'pwsh.exe'];
    for (const candidate of candidates) {
        try {
            const probe = spawnSync(
                candidate,
                ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.Major'],
                { encoding: 'utf8', timeout: 20_000, windowsHide: true }
            );
            if (!probe.error && probe.status === 0) {
                powerShellProbe = candidate;
                return candidate;
            }
        } catch {
            // try the next executable name
        }
    }
    powerShellProbe = null;
    return null;
}

function clipCliOutput(result) {
    const text = `${String(result.stderr || '').trim()} ${String(result.stdout || '').trim()}`.trim();
    return text.length > 400 ? `${text.slice(0, 400)}...` : text;
}

function desktopAccessHint() {
    if (IS_WINDOWS) {
        return ' This usually means the daemon is running in a non-interactive/headless Windows session without desktop access.';
    }
    if (IS_MAC) {
        return ' screencapture/pbpaste need an active graphical login session (and Screen Recording permission for screenshots).';
    }
    return ' The daemon needs a graphical session (DISPLAY or WAYLAND_DISPLAY) plus a supported native CLI.';
}

function getScreenshotsDir() {
    const directory = path.join(runtime.stateDir, SCREENSHOT_DIR_NAME);
    if (!fs.existsSync(directory)) ensureDir(directory);
    return directory;
}

function resolveScreenshotPath(args) {
    const requested = optionalStringArg(args, 'savePath');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filePath =
        requested && requested.trim().length > 0
            ? resolveUserPath(requested)
            : path.join(getScreenshotsDir(), `screenshot_${timestamp}.png`);
    const parentDir = path.dirname(filePath);
    if (!fs.existsSync(parentDir)) {
        try {
            ensureDir(parentDir);
        } catch (error) {
            throw new ToolError(`Failed to create screenshot directory ${parentDir}: ${errorMessage(error)}`);
        }
    }
    let stat = null;
    try {
        stat = fs.statSync(filePath);
    } catch {
        stat = null;
    }
    if (stat && stat.isDirectory()) {
        throw new ToolError(`savePath points to a directory, not a file: ${filePath}`);
    }
    return filePath;
}

function readPngDimensions(buffer) {
    if (!buffer || buffer.length < 24) return null;
    if (buffer.subarray(0, 8).toString('hex') !== PNG_SIGNATURE_HEX) return null;
    const width = buffer.readUInt32BE(16);
    const height = buffer.readUInt32BE(20);
    if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
    return { width, height };
}

function fileExistsWithBytes(filePath) {
    try {
        const stat = fs.statSync(filePath);
        return stat.isFile() && stat.size > 0;
    } catch {
        return false;
    }
}

const WINDOWS_SCREENSHOT_SCRIPT = [
    "$ErrorActionPreference = 'Stop'",
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -AssemblyName System.Drawing',
    '$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen',
    '$width = [int]$bounds.Width',
    '$height = [int]$bounds.Height',
    "if ($width -le 0 -or $height -le 0) { throw 'no display bounds available (headless session)' }",
    '$bitmap = New-Object System.Drawing.Bitmap $width, $height',
    '$graphics = [System.Drawing.Graphics]::FromImage($bitmap)',
    'try {',
    '    $graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)',
    '    $bitmap.Save($env:NCODE_SCREENSHOT_PATH, [System.Drawing.Imaging.ImageFormat]::Png)',
    '} finally {',
    '    $graphics.Dispose()',
    '    $bitmap.Dispose()',
    '}',
    "[Console]::Out.Write('ok')",
].join('\n');

const WINDOWS_CLIPBOARD_READ_SCRIPT = [
    "$ErrorActionPreference = 'Stop'",
    'try { $clipText = Get-Clipboard -Raw } catch { $clipText = $null }',
    "if ($null -eq $clipText) { $clipText = '' }",
    '[Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$clipText)))',
].join('\n');

const WINDOWS_CLIPBOARD_WRITE_SCRIPT = [
    "$ErrorActionPreference = 'Stop'",
    '$raw = [Console]::In.ReadToEnd()',
    "if ([string]::IsNullOrEmpty($raw)) { throw 'no clipboard payload received on stdin' }",
    '$clipText = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($raw.Trim()))',
    'Set-Clipboard -Value $clipText',
    "[Console]::Out.Write('ok')",
].join('\n');

const WINDOWS_CLIPBOARD_CLEAR_SCRIPT = [
    "$ErrorActionPreference = 'Stop'",
    'Add-Type -AssemblyName System.Windows.Forms',
    '[System.Windows.Forms.Clipboard]::Clear()',
    "[Console]::Out.Write('ok')",
].join('\n');

function runPowerShellScript(script, options = {}) {
    const executable = findPowerShell();
    if (!executable) {
        throw new ToolError(
            'Windows PowerShell (powershell.exe or pwsh) was not found on PATH, so this desktop tool cannot run.'
        );
    }
    const args = [
        '-NoProfile',
        '-NonInteractive',
        '-STA',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        script,
    ];
    const spawnOptions = {
        encoding: 'utf8',
        timeout: OS_CLI_TIMEOUT_MS,
        windowsHide: true,
        ...(options.env ? { env: options.env } : {}),
        ...(options.input !== undefined ? { input: options.input } : {}),
        ...(options.maxBuffer ? { maxBuffer: options.maxBuffer } : {}),
    };
    try {
        return spawnSync(executable, args, spawnOptions);
    } catch (error) {
        throw new ToolError(`Failed to run PowerShell: ${errorMessage(error)}`);
    }
}

/** Capture the desktop into filePath using the best available native facility. */
function captureScreenshotToFile(filePath) {
    if (IS_WINDOWS) {
        const result = runPowerShellScript(WINDOWS_SCREENSHOT_SCRIPT, {
            env: { ...process.env, NCODE_SCREENSHOT_PATH: filePath },
        });
        if (result.error) {
            throw new ToolError(`Screenshot capture failed to start PowerShell: ${errorMessage(result.error)}`);
        }
        if (result.status !== 0) {
            throw new ToolError(
                `Screenshot capture failed (PowerShell CopyFromScreen): ${clipCliOutput(result) || `exit code ${result.status}`}.${desktopAccessHint()}`
            );
        }
        if (!fileExistsWithBytes(filePath)) {
            throw new ToolError(
                `Screenshot capture produced no image at ${filePath}.${desktopAccessHint()}`
            );
        }
        return { tool: 'powershell-copyfromscreen' };
    }

    if (IS_MAC) {
        const result = spawnSync('screencapture', ['-x', '-t', 'png', filePath], {
            encoding: 'utf8',
            timeout: OS_CLI_TIMEOUT_MS,
            windowsHide: true,
        });
        if (result.error) {
            throw new ToolError(
                `screencapture is not available (${errorMessage(result.error)}).${desktopAccessHint()}`
            );
        }
        if (result.status !== 0 || !fileExistsWithBytes(filePath)) {
            throw new ToolError(
                `Screenshot capture failed via screencapture: ${clipCliOutput(result) || `exit code ${result.status}`}.${desktopAccessHint()}`
            );
        }
        return { tool: 'screencapture' };
    }

    if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
        throw new ToolError(
            'Screenshot capture is unavailable in this headless Linux environment (DISPLAY and WAYLAND_DISPLAY are both unset).'
        );
    }
    const candidates = [];
    if (process.env.WAYLAND_DISPLAY) {
        candidates.push({ tool: 'grim', command: 'grim', args: [filePath] });
    }
    candidates.push({ tool: 'gnome-screenshot', command: 'gnome-screenshot', args: ['-f', filePath] });
    candidates.push({ tool: 'import(ImageMagick)', command: 'import', args: ['-window', 'root', filePath] });
    candidates.push({ tool: 'scrot', command: 'scrot', args: [filePath] });
    const attempts = [];
    for (const candidate of candidates) {
        const result = spawnSync(candidate.command, candidate.args, {
            encoding: 'utf8',
            timeout: OS_CLI_TIMEOUT_MS,
            windowsHide: true,
        });
        if (result.error) {
            attempts.push(
                `${candidate.tool}: ${result.error.code === 'ENOENT' ? 'not installed' : errorMessage(result.error)}`
            );
            continue;
        }
        if (result.status === 0 && fileExistsWithBytes(filePath)) {
            return { tool: candidate.tool };
        }
        attempts.push(`${candidate.tool}: exit ${result.status} ${clipCliOutput(result)}`.trim());
    }
    throw new ToolError(
        `Screenshot capture failed on Linux (tried ${candidates.map((candidate) => candidate.tool).join(', ')}). ${attempts.join('; ')}`
    );
}

async function handlePcDesktopScreenshot(rawArgs) {
    const args = isPlainObject(rawArgs) ? rawArgs : {};
    const formatRaw = optionalStringArg(args, 'format');
    const format = formatRaw && formatRaw.trim().length > 0 ? formatRaw.trim().toLowerCase() : 'png';
    if (format !== 'png') {
        throw new ToolError(`Unsupported screenshot format "${formatRaw}". Only "png" is supported.`);
    }
    const filePath = resolveScreenshotPath(args);
    const capture = captureScreenshotToFile(filePath);
    let stat = null;
    try {
        stat = fs.statSync(filePath);
    } catch {
        throw new ToolError(`Screenshot file disappeared after capture: ${filePath}`);
    }
    if (stat.size > SCREENSHOT_MAX_BYTES) {
        throw new ToolError(
            `Screenshot is too large to return (${stat.size} bytes, limit ${SCREENSHOT_MAX_BYTES}).`
        );
    }
    const buffer = fs.readFileSync(filePath);
    const dimensions = readPngDimensions(buffer) || { width: null, height: null };
    log.info('desktop screenshot captured', {
        filePath,
        bytes: stat.size,
        tool: capture.tool,
        width: dimensions.width,
        height: dimensions.height,
    });
    return {
        filePath,
        base64: buffer.toString('base64'),
        width: dimensions.width,
        height: dimensions.height,
        bytes: stat.size,
        mimeType: 'image/png',
        format: 'png',
        captureTool: capture.tool,
        capturedAt: new Date().toISOString(),
        platform: process.platform,
    };
}

function readClipboardViaNativeCli() {
    if (IS_WINDOWS) {
        const result = runPowerShellScript(WINDOWS_CLIPBOARD_READ_SCRIPT, {
            maxBuffer: CLIPBOARD_MAX_BYTES * 2,
        });
        if (result.error) {
            throw new ToolError(`Clipboard read failed to start PowerShell: ${errorMessage(result.error)}`);
        }
        if (result.status !== 0) {
            throw new ToolError(
                `Clipboard read failed: ${clipCliOutput(result) || `exit code ${result.status}`}.${desktopAccessHint()}`
            );
        }
        let text = '';
        try {
            text = Buffer.from(String(result.stdout || '').trim(), 'base64').toString('utf8');
        } catch (error) {
            throw new ToolError(`Clipboard read returned invalid data: ${errorMessage(error)}`);
        }
        return { text, tool: 'powershell-get-clipboard' };
    }
    if (IS_MAC) {
        const result = spawnSync('pbpaste', [], {
            encoding: 'utf8',
            timeout: OS_CLI_TIMEOUT_MS,
            windowsHide: true,
            maxBuffer: CLIPBOARD_MAX_BYTES * 2,
        });
        if (result.error) {
            throw new ToolError(`pbpaste is not available (${errorMessage(result.error)}).${desktopAccessHint()}`);
        }
        if (result.status !== 0) {
            throw new ToolError(
                `Clipboard read failed via pbpaste: ${clipCliOutput(result) || `exit code ${result.status}`}.`
            );
        }
        return { text: String(result.stdout || ''), tool: 'pbpaste' };
    }
    if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
        throw new ToolError(
            'Clipboard access is unavailable in this headless Linux environment (DISPLAY and WAYLAND_DISPLAY are both unset).'
        );
    }
    const candidates = [];
    if (process.env.WAYLAND_DISPLAY) {
        candidates.push({ tool: 'wl-paste', command: 'wl-paste', args: ['--no-newline'] });
    }
    candidates.push({ tool: 'xclip', command: 'xclip', args: ['-selection', 'clipboard', '-o'] });
    candidates.push({ tool: 'xsel', command: 'xsel', args: ['--clipboard', '--output'] });
    const attempts = [];
    for (const candidate of candidates) {
        const result = spawnSync(candidate.command, candidate.args, {
            encoding: 'utf8',
            timeout: OS_CLI_TIMEOUT_MS,
            windowsHide: true,
            maxBuffer: CLIPBOARD_MAX_BYTES * 2,
        });
        if (result.error) {
            attempts.push(
                `${candidate.tool}: ${result.error.code === 'ENOENT' ? 'not installed' : errorMessage(result.error)}`
            );
            continue;
        }
        if (result.status === 0) {
            return { text: String(result.stdout || ''), tool: candidate.tool };
        }
        attempts.push(`${candidate.tool}: exit ${result.status} ${clipCliOutput(result)}`.trim());
    }
    throw new ToolError(
        `Clipboard read failed on Linux (tried ${candidates.map((candidate) => candidate.tool).join(', ')}). ${attempts.join('; ')}`
    );
}

function writeClipboardViaNativeCli(text) {
    const payload = String(text === undefined || text === null ? '' : text);
    if (IS_WINDOWS) {
        if (payload.length === 0) {
            const clearResult = runPowerShellScript(WINDOWS_CLIPBOARD_CLEAR_SCRIPT);
            if (clearResult.error || clearResult.status !== 0) {
                throw new ToolError(
                    `Clipboard clear failed: ${clipCliOutput(clearResult) || errorMessage(clearResult.error) || 'unknown error'}.`
                );
            }
            return { tool: 'powershell-clipboard-clear' };
        }
        const encoded = Buffer.from(payload, 'utf8').toString('base64');
        const result = runPowerShellScript(WINDOWS_CLIPBOARD_WRITE_SCRIPT, {
            input: encoded,
            maxBuffer: CLIPBOARD_MAX_BYTES * 2,
        });
        if (result.error) {
            throw new ToolError(`Clipboard write failed to start PowerShell: ${errorMessage(result.error)}`);
        }
        if (result.status !== 0) {
            throw new ToolError(
                `Clipboard write failed: ${clipCliOutput(result) || `exit code ${result.status}`}.${desktopAccessHint()}`
            );
        }
        return { tool: 'powershell-set-clipboard' };
    }
    if (IS_MAC) {
        const result = spawnSync('pbcopy', [], {
            input: payload,
            encoding: 'utf8',
            timeout: OS_CLI_TIMEOUT_MS,
            windowsHide: true,
        });
        if (result.error) {
            throw new ToolError(`pbcopy is not available (${errorMessage(result.error)}).${desktopAccessHint()}`);
        }
        if (result.status !== 0) {
            throw new ToolError(`Clipboard write failed via pbcopy: ${clipCliOutput(result)}.`);
        }
        return { tool: 'pbcopy' };
    }
    if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
        throw new ToolError(
            'Clipboard access is unavailable in this headless Linux environment (DISPLAY and WAYLAND_DISPLAY are both unset).'
        );
    }
    const candidates = [];
    if (process.env.WAYLAND_DISPLAY) {
        candidates.push({ tool: 'wl-copy', command: 'wl-copy', args: [] });
    }
    candidates.push({ tool: 'xclip', command: 'xclip', args: ['-selection', 'clipboard', '-i'] });
    candidates.push({ tool: 'xsel', command: 'xsel', args: ['--clipboard', '--input'] });
    const attempts = [];
    for (const candidate of candidates) {
        const result = spawnSync(candidate.command, candidate.args, {
            input: payload,
            encoding: 'utf8',
            timeout: OS_CLI_TIMEOUT_MS,
            windowsHide: true,
        });
        if (result.error) {
            attempts.push(
                `${candidate.tool}: ${result.error.code === 'ENOENT' ? 'not installed' : errorMessage(result.error)}`
            );
            continue;
        }
        if (result.status === 0) return { tool: candidate.tool };
        attempts.push(`${candidate.tool}: exit ${result.status} ${clipCliOutput(result)}`.trim());
    }
    throw new ToolError(
        `Clipboard write failed on Linux (tried ${candidates.map((candidate) => candidate.tool).join(', ')}). ${attempts.join('; ')}`
    );
}

async function handlePcClipboard(rawArgs) {
    const args = isPlainObject(rawArgs) ? rawArgs : {};
    const actionRaw = requireStringArg(args, 'action');
    const action = actionRaw.trim().toLowerCase();
    if (action === 'read') {
        const clipboard = readClipboardViaNativeCli();
        return {
            action: 'read',
            text: clipboard.text,
            chars: clipboard.text.length,
            bytes: Buffer.byteLength(clipboard.text, 'utf8'),
            empty: clipboard.text.length === 0,
            tool: clipboard.tool,
            platform: process.platform,
        };
    }
    if (action === 'write') {
        const text = requireStringArg(args, 'text', { allowEmpty: true });
        const writeResult = writeClipboardViaNativeCli(text);
        return {
            action: 'write',
            ok: true,
            chars: text.length,
            bytes: Buffer.byteLength(text, 'utf8'),
            tool: writeResult.tool,
            platform: process.platform,
        };
    }
    throw new ToolError(`Unknown pc_clipboard action "${actionRaw}". Use one of: read, write.`);
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
    refreshManagedBackgroundProcesses();
}

function listBackgroundProcesses() {
    return listManagedBackgroundProcesses().map((process) => ({
        id: process.id,
        pid: process.pid,
        command: process.command,
        logPath: process.logPath,
        startedAt: process.startedAt,
        alive: process.running,
        ...(process.workflowId ? { workflowId: process.workflowId } : {}),
        ...(process.name ? { name: process.name } : {}),
    }));
}

async function handlePcSystemInfo() {
    const sessions = listShellSessionSummaries();
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
        shellSessions: { count: sessions.length, sessions: sessions.slice(0, 20) },
        backgroundProcesses: listBackgroundProcesses().slice(0, 50),
        uptimeMs: Date.now() - runtime.startedAt,
        pid: process.pid,
        toolCount: countTools(),
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
    }, BG_SWEEP_INTERVAL_MS);
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

    // Persist durable shell session / background process state before exiting.
    try {
        persistShellSessions();
        persistBackgroundRegistry();
    } catch (error) {
        log.warn('failed to persist daemon state during shutdown', { error: errorMessage(error) });
    }

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
    loadShellSessions();
    loadBackgroundRegistry();
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
