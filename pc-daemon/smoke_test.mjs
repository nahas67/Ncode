#!/usr/bin/env node
/**
 * Smoke test for the Ncode PC daemon (server.mjs).
 *
 * Starts real daemon processes on ephemeral ports and verifies:
 *   - node --check of server.mjs
 *   - HTTP MCP: initialize, notifications, tools/list, tools/call, health,
 *     protocol errors, batch, CORS, GET/DELETE /mcp
 *   - tools: pc_system_info, checkpoint save/load/list, fs write/read/patch,
 *     pc_exec_shell (echo, long-output truncation, timeout, background),
 *     pc_shell_session (cwd/env persistence, pushd/popd, reset/list),
 *     pc_bg_process (start/status/logs/kill/list, registry across restarts),
 *     pc_fs_tree (gitignore, depth cap, file sizes), pc_search_code
 *     (Node fallback, fileGlob, contextLines, maxResults, caseInsensitive),
 *     the pc_git_* suite in a throwaway repository, pc_clipboard round-trip
 *     and pc_desktop_screenshot (both skipped with a reason when the OS
 *     facility is genuinely unavailable), validation errors
 *   - WebSocket bridge: register, application ping/pong, WS-level ping/pong,
 *     legacy gemini-browser-mcp relay, WS-port health
 *   - --no-ws listener flags (plus pc_bg_process status/logs/kill after a
 *     daemon restart against the same state directory)
 *   - stdio MCP: banner, tools/list incl. ask_gemini_web and the new tools,
 *     stateful shell calls, no HTTP listener, ask_gemini_web round-trip
 *     through a fake extension, stdout JSON purity, graceful exit on stdin close
 *
 * Prints PASS/FAIL/SKIP per assertion and exits 0 on success, 1 on any failure.
 */

import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = path.join(__dirname, 'server.mjs');

let failures = 0;
let checks = 0;
let skips = 0;
const startedAt = Date.now();

function section(title) {
    console.log(`\n--- ${title} ---`);
}

function check(name, condition, detail) {
    checks += 1;
    const ok = Boolean(condition);
    if (ok) {
        console.log(`  PASS  ${name}`);
    } else {
        failures += 1;
        const suffix = detail === undefined ? '' : ` :: ${String(detail).replace(/\r?\n/g, ' | ').slice(0, 700)}`;
        console.log(`  FAIL  ${name}${suffix}`);
    }
    return ok;
}

/** Record a check that cannot run on this machine (counts as skipped, not failed). */
function skip(name, reason) {
    skips += 1;
    const suffix = reason === undefined ? '' : ` :: ${String(reason).replace(/\r?\n/g, ' | ').slice(0, 400)}`;
    console.log(`  SKIP  ${name}${suffix}`);
    return false;
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getFreePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const port = server.address().port;
            server.close(() => resolve(port));
        });
    });
}

async function waitFor(predicate, timeoutMs = 15_000, intervalMs = 100) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            const value = await predicate();
            if (value) return value;
        } catch {
            // retry
        }
        await sleep(intervalMs);
    }
    return null;
}

async function httpJson(url, { method = 'GET', body = undefined, headers = undefined } = {}) {
    const requestHeaders = {
        Accept: 'application/json, text/event-stream',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(headers || {}),
    };
    const response = await fetch(url, {
        method,
        headers: requestHeaders,
        body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    const text = await response.text();
    let json = null;
    try {
        json = text ? JSON.parse(text) : null;
    } catch {
        json = null;
    }
    return { status: response.status, headers: response.headers, text, json };
}

// ---------------------------------------------------------------------------
// Daemon process wrapper
// ---------------------------------------------------------------------------

class DaemonProcess {
    constructor(args, extraEnv = {}) {
        this.args = args;
        this.stderr = '';
        this.stdout = '';
        this.exitInfo = null;
        this.exitWaiters = [];
        this.child = spawn(process.execPath, [SERVER_PATH, ...args], {
            env: { ...process.env, ...extraEnv },
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
        });
        this.child.stderr.on('data', (chunk) => {
            this.stderr += chunk.toString('utf8');
        });
        this.child.stdout.on('data', (chunk) => {
            this.stdout += chunk.toString('utf8');
        });
        this.child.on('error', () => {
            // surfaced by banner/exit waits
        });
        this.child.on('exit', (code, signal) => {
            this.exitInfo = { code, signal };
            for (const waiter of this.exitWaiters.splice(0)) waiter(this.exitInfo);
        });
    }

    get bannerLine() {
        return (
            this.stderr
                .split(/\r?\n/)
                .find((line) => line.startsWith('[ncode-pc-daemon] http=')) || null
        );
    }

    async waitForBanner(timeoutMs = 15_000) {
        const line = await waitFor(() => this.bannerLine, timeoutMs, 50);
        if (!line) {
            throw new Error(
                `daemon printed no startup banner. args=${JSON.stringify(this.args)}\nstderr:\n${this.stderr.slice(-4000)}`
            );
        }
        return line;
    }

    waitForExit(timeoutMs = 10_000) {
        if (this.exitInfo) return Promise.resolve(this.exitInfo);
        return new Promise((resolve) => {
            const timer = setTimeout(() => resolve(null), timeoutMs);
            const waiter = (info) => {
                clearTimeout(timer);
                resolve(info);
            };
            this.exitWaiters.push(waiter);
        });
    }

    async stop() {
        if (this.exitInfo) return this.exitInfo;
        try {
            this.child.kill('SIGTERM');
        } catch {
            // ignore
        }
        let info = await this.waitForExit(6000);
        if (!info) {
            try {
                this.child.kill('SIGKILL');
            } catch {
                // ignore
            }
            info = await this.waitForExit(2000);
        }
        return info;
    }
}

// ---------------------------------------------------------------------------
// stdio MCP client (newline-delimited JSON-RPC)
// ---------------------------------------------------------------------------

class StdioClient {
    constructor(child) {
        this.child = child;
        this.buffer = '';
        this.waiters = [];
        this.allLines = [];
        child.stdout.on('data', (chunk) => this._onData(chunk.toString('utf8')));
        child.on('exit', () => {
            for (const waiter of this.waiters.splice(0)) {
                clearTimeout(waiter.timer);
                waiter.reject(new Error('stdio daemon exited'));
            }
        });
    }

    _onData(text) {
        this.buffer += text;
        let index = this.buffer.indexOf('\n');
        while (index !== -1) {
            const line = this.buffer.slice(0, index);
            this.buffer = this.buffer.slice(index + 1);
            if (line.trim()) {
                this.allLines.push(line);
                this._dispatch(line);
            }
            index = this.buffer.indexOf('\n');
        }
    }

    _dispatch(line) {
        let parsed = null;
        try {
            parsed = JSON.parse(line);
        } catch {
            return;
        }
        for (let index = 0; index < this.waiters.length; index += 1) {
            const waiter = this.waiters[index];
            let matched = false;
            try {
                matched = waiter.predicate(parsed);
            } catch {
                matched = false;
            }
            if (matched) {
                this.waiters.splice(index, 1);
                clearTimeout(waiter.timer);
                waiter.resolve(parsed);
                return;
            }
        }
    }

    send(message) {
        this.child.stdin.write(`${JSON.stringify(message)}\n`);
    }

    request(message, timeoutMs = 15_000) {
        return new Promise((resolve, reject) => {
            const waiter = {
                predicate: (parsed) =>
                    parsed &&
                    parsed.id === message.id &&
                    (parsed.result !== undefined || parsed.error !== undefined),
                resolve,
                reject,
                timer: null,
            };
            waiter.timer = setTimeout(() => {
                const index = this.waiters.indexOf(waiter);
                if (index !== -1) this.waiters.splice(index, 1);
                reject(new Error(`stdio request "${message.method}" timed out after ${timeoutMs}ms`));
            }, timeoutMs);
            this.waiters.push(waiter);
            this.send(message);
        });
    }
}

// ---------------------------------------------------------------------------
// WebSocket test client (RFC 6455, masked client frames, unmasked server frames)
// ---------------------------------------------------------------------------

class WsClient {
    constructor() {
        this.socket = null;
        this.buffer = Buffer.alloc(0);
        this.messages = [];
        this.waiters = [];
        this.pongPayloads = [];
        this.closeInfo = null;
        this.closed = false;
    }

    static connect(port, pathName = '/') {
        const client = new WsClient();
        return client._connect(port, pathName).then(() => client);
    }

    _connect(port, pathName) {
        return new Promise((resolve, reject) => {
            const socket = net.connect(port, '127.0.0.1');
            this.socket = socket;
            const key = crypto.randomBytes(16).toString('base64');
            let handshakeBuffer = Buffer.alloc(0);
            let settled = false;

            const finishReject = (error) => {
                if (settled) return;
                settled = true;
                reject(error);
            };

            const onHandshakeData = (chunk) => {
                handshakeBuffer = Buffer.concat([handshakeBuffer, chunk]);
                const headerEnd = handshakeBuffer.indexOf('\r\n\r\n');
                if (headerEnd === -1) return;
                clearTimeout(handshakeTimer);
                socket.removeListener('data', onHandshakeData);
                const headerText = handshakeBuffer.subarray(0, headerEnd).toString('latin1');
                const statusLine = headerText.split('\r\n')[0] || '';
                if (!/^HTTP\/1\.1 101/.test(statusLine)) {
                    finishReject(new Error(`WebSocket handshake failed: ${statusLine}`));
                    socket.destroy();
                    return;
                }
                settled = true;
                socket.on('data', (data) => this._onData(data));
                const leftover = handshakeBuffer.subarray(headerEnd + 4);
                if (leftover.length > 0) this._onData(leftover);
                resolve();
            };

            const handshakeTimer = setTimeout(() => {
                finishReject(new Error('WebSocket handshake timed out'));
                socket.destroy();
            }, 5000);

            socket.on('data', onHandshakeData);
            socket.on('error', (error) => finishReject(error));
            socket.on('close', () => {
                this.closed = true;
                for (const waiter of this.waiters.splice(0)) {
                    clearTimeout(waiter.timer);
                    waiter.reject(new Error('WebSocket closed'));
                }
            });

            const headers = [
                `GET ${pathName} HTTP/1.1`,
                `Host: 127.0.0.1:${port}`,
                'Upgrade: websocket',
                'Connection: Upgrade',
                `Sec-WebSocket-Key: ${key}`,
                'Sec-WebSocket-Version: 13',
                '',
                '',
            ].join('\r\n');
            socket.write(headers);
        });
    }

    _onData(chunk) {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        while (true) {
            const buffer = this.buffer;
            if (buffer.length < 2) return;
            const firstByte = buffer[0];
            const secondByte = buffer[1];
            const opcode = firstByte & 0x0f;
            let payloadLength = secondByte & 0x7f;
            let offset = 2;
            if (payloadLength === 126) {
                if (buffer.length < 4) return;
                payloadLength = buffer.readUInt16BE(2);
                offset = 4;
            } else if (payloadLength === 127) {
                if (buffer.length < 10) return;
                payloadLength = Number(buffer.readBigUInt64BE(2));
                offset = 10;
            }
            if (buffer.length < offset + payloadLength) return;
            const payload = buffer.subarray(offset, offset + payloadLength);
            this.buffer = buffer.subarray(offset + payloadLength);

            if (opcode === 0x1) {
                const text = payload.toString('utf8');
                let parsed = null;
                try {
                    parsed = JSON.parse(text);
                } catch {
                    parsed = { __raw: text };
                }
                this._dispatch(parsed);
            } else if (opcode === 0x9) {
                this._sendFrame(0xa, payload);
            } else if (opcode === 0xa) {
                this.pongPayloads.push(payload.toString('utf8'));
            } else if (opcode === 0x8) {
                this.closeInfo = {
                    code: payload.length >= 2 ? payload.readUInt16BE(0) : null,
                    reason: payload.length > 2 ? payload.subarray(2).toString('utf8') : '',
                };
                this.closed = true;
            }
        }
    }

    _dispatch(message) {
        // Auto-respond to application keepalive pings so test clients are not dropped.
        if (message && message.type === 'ping' && typeof message.ts === 'number') {
            try {
                this.sendJson({ type: 'pong', ts: message.ts });
            } catch {
                // ignore
            }
        }
        for (let index = 0; index < this.waiters.length; index += 1) {
            const waiter = this.waiters[index];
            let matched = false;
            try {
                matched = waiter.predicate(message);
            } catch {
                matched = false;
            }
            if (matched) {
                this.waiters.splice(index, 1);
                clearTimeout(waiter.timer);
                waiter.resolve(message);
                return;
            }
        }
        this.messages.push(message);
    }

    _sendFrame(opcode, payloadInput) {
        if (!this.socket || this.socket.destroyed) return;
        const payload = Buffer.isBuffer(payloadInput)
            ? payloadInput
            : Buffer.from(String(payloadInput), 'utf8');
        const mask = crypto.randomBytes(4);
        const length = payload.length;
        let header = null;
        if (length < 126) {
            header = Buffer.from([0x80 | opcode, 0x80 | length]);
        } else if (length < 65536) {
            header = Buffer.alloc(4);
            header[0] = 0x80 | opcode;
            header[1] = 0x80 | 126;
            header.writeUInt16BE(length, 2);
        } else {
            header = Buffer.alloc(10);
            header[0] = 0x80 | opcode;
            header[1] = 0x80 | 127;
            header.writeBigUInt64BE(BigInt(length), 2);
        }
        const masked = Buffer.allocUnsafe(length);
        for (let index = 0; index < length; index += 1) {
            masked[index] = payload[index] ^ mask[index % 4];
        }
        this.socket.write(Buffer.concat([header, mask, masked]));
    }

    sendJson(message) {
        this._sendFrame(0x1, Buffer.from(JSON.stringify(message), 'utf8'));
    }

    sendPing(payloadText) {
        this._sendFrame(0x9, Buffer.from(payloadText, 'utf8'));
    }

    waitForMessage(predicate, timeoutMs = 10_000, label = 'message') {
        for (let index = 0; index < this.messages.length; index += 1) {
            if (predicate(this.messages[index])) {
                return Promise.resolve(this.messages.splice(index, 1)[0]);
            }
        }
        return new Promise((resolve, reject) => {
            const waiter = { predicate, resolve, reject, timer: null };
            waiter.timer = setTimeout(() => {
                const index = this.waiters.indexOf(waiter);
                if (index !== -1) this.waiters.splice(index, 1);
                reject(new Error(`timeout waiting for ${label} (${timeoutMs}ms)`));
            }, timeoutMs);
            this.waiters.push(waiter);
        });
    }

    async waitForPongPayload(expected, timeoutMs = 3000) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            if (this.pongPayloads.includes(expected)) return true;
            await sleep(50);
        }
        return false;
    }

    close() {
        if (this.closed) return;
        try {
            this._sendFrame(0x8, Buffer.from([0x03, 0xe8]));
        } catch {
            // ignore
        }
        try {
            this.socket.end();
            this.socket.destroy();
        } catch {
            // ignore
        }
        this.closed = true;
    }
}

function extractToolResult(response) {
    const result = response && response.json && response.json.result;
    if (!result || !Array.isArray(result.content)) {
        return {
            isError: true,
            text: response ? response.text : 'no JSON-RPC result',
            payload: null,
            result: null,
        };
    }
    const text = result.content
        .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
        .map((part) => part.text)
        .join('\n');
    let payload = null;
    try {
        payload = JSON.parse(text);
    } catch {
        payload = null;
    }
    return { isError: result.isError === true, text, payload, result };
}

async function rpcHttp(baseUrl, payload) {
    return httpJson(`${baseUrl}/mcp`, { method: 'POST', body: payload });
}

async function callTool(baseUrl, id, name, args) {
    const response = await rpcHttp(baseUrl, {
        jsonrpc: '2.0',
        id,
        method: 'tools/call',
        params: { name, arguments: args || {} },
    });
    return extractToolResult(response);
}

const CORE_TOOL_NAMES = [
    'pc_exec_shell',
    'pc_shell_session',
    'pc_bg_process',
    'pc_fs_read',
    'pc_fs_write',
    'pc_fs_patch',
    'pc_fs_tree',
    'pc_search_code',
    'pc_git_status',
    'pc_git_diff',
    'pc_git_status_diff',
    'pc_git_add',
    'pc_git_commit',
    'pc_git_checkout',
    'pc_git_log',
    'pc_desktop_screenshot',
    'pc_clipboard',
    'pc_system_info',
    'workflow_save_checkpoint',
    'workflow_load_checkpoint',
    'workflow_list_checkpoints',
];

const EXPECTED_TOOL_COUNT = CORE_TOOL_NAMES.length;

/** Run a git command directly (test fixtures only; the daemon tools are tested over MCP). */
function gitCli(cwd, args) {
    return spawnSync('git', args, {
        cwd,
        encoding: 'utf8',
        timeout: 30_000,
        windowsHide: true,
    });
}

/** Best-effort process-tree kill used by test cleanup for spawned background children. */
function killTestProcessTree(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return;
    if (process.platform === 'win32') {
        try {
            spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], {
                windowsHide: true,
                timeout: 15_000,
                encoding: 'utf8',
            });
        } catch {
            // best effort
        }
        return;
    }
    try {
        process.kill(-pid, 'SIGKILL');
    } catch {
        // not a group leader
    }
    try {
        process.kill(pid, 'SIGKILL');
    } catch {
        // already gone
    }
}

async function run() {
    console.log(`Ncode pc-daemon smoke test (${new Date().toISOString()})`);
    console.log(`node ${process.version} on ${process.platform} ${process.arch}`);
    console.log(`server: ${SERVER_PATH}`);

    const syntax = spawnSync(process.execPath, ['--check', SERVER_PATH], { encoding: 'utf8' });
    check('node --check server.mjs', syntax.status === 0, syntax.stderr);

    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncode-daemon-smoke-'));
    const cleanups = [];

    // Search fixtures (created before the daemon starts; reused by pc_search_code).
    const fixtureDir = path.join(stateDir, 'search-fixture');
    fs.mkdirSync(path.join(fixtureDir, 'node_modules'), { recursive: true });
    fs.mkdirSync(path.join(fixtureDir, 'deep'), { recursive: true });
    fs.writeFileSync(path.join(fixtureDir, 'a.js'), 'const needle = 1;\nconsole.log(needle);\n');
    fs.writeFileSync(path.join(fixtureDir, 'deep', 'b.ts'), 'export const needle = 2;\n');
    fs.writeFileSync(path.join(fixtureDir, 'node_modules', 'skip.js'), 'needle must be skipped\n');

    try {
        // --------------------------------------------------------------
        // Phase A: default mode === HTTP MCP + WebSocket bridge
        // --------------------------------------------------------------
        section('HTTP MCP mode (default flags)');
        const httpPort = await getFreePort();
        const wsPort = await getFreePort();
        const daemon = new DaemonProcess(
            ['--http-port', String(httpPort), '--ws-port', String(wsPort)],
            { NCODE_STATE_DIR: stateDir, NCODE_WS_PING_MS: '300' }
        );
        cleanups.push(() => daemon.stop());

        const banner = await daemon.waitForBanner();
        check(
            'startup banner is machine-readable',
            banner.includes(`http=http://127.0.0.1:${httpPort}/mcp`) &&
                banner.includes(`ws=ws://127.0.0.1:${wsPort}`) &&
                banner.includes('stdio=false'),
            banner
        );

        const baseUrl = `http://127.0.0.1:${httpPort}`;
        const health = await waitFor(
            async () => {
                try {
                    const response = await httpJson(`${baseUrl}/health`);
                    return response.status === 200 ? response : null;
                } catch {
                    return null;
                }
            },
            15_000
        );
        if (!health) throw new Error(`daemon never became healthy. stderr:\n${daemon.stderr.slice(-4000)}`);
        check(
            'GET /health payload shape',
            health.json &&
                health.json.ok === true &&
                health.json.name === 'ncode-pc-daemon' &&
                health.json.version === '1.0.0' &&
                typeof health.json.uptimeMs === 'number' &&
                health.json.tools === EXPECTED_TOOL_COUNT,
            health.text
        );

        const init = await rpcHttp(baseUrl, {
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {
                protocolVersion: '2025-03-26',
                capabilities: {},
                clientInfo: { name: 'smoke-test', version: '1.0.0' },
            },
        });
        check('initialize returns HTTP 200', init.status === 200, `${init.status} ${init.text.slice(0, 300)}`);
        check(
            'initialize serverInfo.name',
            init.json && init.json.result && init.json.result.serverInfo && init.json.result.serverInfo.name === 'ncode-pc-daemon',
            init.text.slice(0, 300)
        );
        check(
            'initialize echoes supported protocolVersion',
            init.json.result.protocolVersion === '2025-03-26',
            init.json.result.protocolVersion
        );
        check(
            'initialize capabilities.tools.listChanged === false',
            init.json.result.capabilities && init.json.result.capabilities.tools && init.json.result.capabilities.tools.listChanged === false
        );
        check(
            'initialize instructions describe the PC harness',
            typeof init.json.result.instructions === 'string' &&
                init.json.result.instructions.length > 150 &&
                /pc_exec_shell/.test(init.json.result.instructions) &&
                /workflow_load_checkpoint/.test(init.json.result.instructions)
        );
        check('POST /mcp has CORS * header', init.headers.get('access-control-allow-origin') === '*');
        check('POST /mcp is stateless (no MCP-Session-Id)', init.headers.get('mcp-session-id') === null);
        check(
            'POST /mcp responds application/json',
            (init.headers.get('content-type') || '').includes('application/json')
        );

        const initFallback = await rpcHttp(baseUrl, {
            jsonrpc: '2.0',
            id: 2,
            method: 'initialize',
            params: { protocolVersion: '1999-01-01' },
        });
        check(
            'initialize unsupported protocolVersion falls back to 2025-03-26',
            initFallback.json && initFallback.json.result.protocolVersion === '2025-03-26',
            initFallback.text.slice(0, 300)
        );

        const notification = await httpJson(`${baseUrl}/mcp`, {
            method: 'POST',
            body: { jsonrpc: '2.0', method: 'notifications/initialized' },
        });
        check(
            'notifications/initialized -> 202 with empty body',
            notification.status === 202 && notification.text === '',
            `${notification.status} "${notification.text}"`
        );

        const list = await rpcHttp(baseUrl, { jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} });
        const httpToolNames = ((list.json && list.json.result && list.json.result.tools) || []).map(
            (tool) => tool.name
        );
        check(
            `tools/list contains all ${EXPECTED_TOOL_COUNT} core tools`,
            CORE_TOOL_NAMES.every((name) => httpToolNames.includes(name)),
            httpToolNames.join(',')
        );
        check(
            'tools/list excludes ask_gemini_web over HTTP',
            !httpToolNames.includes('ask_gemini_web'),
            httpToolNames.join(',')
        );
        check(
            'tools/list tools all carry an object inputSchema',
            ((list.json && list.json.result && list.json.result.tools) || []).every(
                (tool) => tool.inputSchema && tool.inputSchema.type === 'object'
            )
        );

        // ---- pc_system_info ----
        const systemInfo = await callTool(baseUrl, 10, 'pc_system_info', {});
        check(
            'tools/call pc_system_info returns parseable JSON',
            systemInfo.isError === false && systemInfo.payload && typeof systemInfo.payload === 'object',
            systemInfo.text.slice(0, 400)
        );
        check(
            'pc_system_info platform matches host',
            systemInfo.payload.platform === process.platform,
            systemInfo.payload && systemInfo.payload.platform
        );
        check(
            'pc_system_info node matches host',
            systemInfo.payload.node === process.version,
            systemInfo.payload && systemInfo.payload.node
        );
        check(
            'pc_system_info reports stateDir/workflows/backgroundProcesses',
            systemInfo.payload.stateDir &&
                typeof systemInfo.payload.workflows === 'number' &&
                Array.isArray(systemInfo.payload.backgroundProcesses),
            JSON.stringify({
                stateDir: systemInfo.payload.stateDir,
                workflows: systemInfo.payload.workflows,
            })
        );

        // ---- workflow checkpoints ----
        const save = await callTool(baseUrl, 11, 'workflow_save_checkpoint', {
            workflowId: 'smoke_flow',
            checkpoint: { step: 3, plan: ['a', 'b'], notes: 'hello' },
            pretty: true,
        });
        check(
            'workflow_save_checkpoint writes checkpoint',
            save.isError === false && save.payload.bytes > 0 && /workflows/.test(save.payload.path),
            save.text.slice(0, 300)
        );
        const load = await callTool(baseUrl, 12, 'workflow_load_checkpoint', {
            workflowId: 'smoke_flow',
        });
        check(
            'workflow_load_checkpoint round-trips',
            load.isError === false &&
                load.payload.checkpoint &&
                load.payload.checkpoint.step === 3 &&
                Array.isArray(load.payload.checkpoint.plan) &&
                typeof load.payload.savedAt === 'string',
            load.text.slice(0, 400)
        );
        const listCheckpoints = await callTool(baseUrl, 13, 'workflow_list_checkpoints', {});
        check(
            'workflow_list_checkpoints lists saved checkpoint',
            listCheckpoints.isError === false &&
                listCheckpoints.payload.count >= 1 &&
                listCheckpoints.payload.checkpoints.some(
                    (item) => item.workflowId === 'smoke_flow' && typeof item.bytes === 'number'
                ),
            listCheckpoints.text.slice(0, 400)
        );
        const traversal = await callTool(baseUrl, 14, 'workflow_save_checkpoint', {
            workflowId: '../evil',
            checkpoint: {},
        });
        check(
            'workflow path traversal rejected as tool error',
            traversal.isError === true && /workflowId/i.test(traversal.text),
            traversal.text.slice(0, 400)
        );
        const missingCheckpoint = await callTool(baseUrl, 15, 'workflow_load_checkpoint', {
            workflowId: 'does_not_exist',
        });
        check(
            'workflow_load_checkpoint missing file is a tool error',
            missingCheckpoint.isError === true && /No checkpoint found/i.test(missingCheckpoint.text),
            missingCheckpoint.text.slice(0, 300)
        );

        // ---- pc_fs_write / read / patch ----
        const fsFile = path.join(stateDir, 'fs-test.txt');
        const originalContent = 'line one\nTARGET_LINE\nline three\nline four\nline five\n';
        const write = await callTool(baseUrl, 20, 'pc_fs_write', {
            filePath: fsFile,
            content: originalContent,
        });
        check(
            'pc_fs_write creates file with byte count',
            write.isError === false &&
                write.payload.created === true &&
                write.payload.bytes === Buffer.byteLength(originalContent),
            write.text.slice(0, 300)
        );
        const read = await callTool(baseUrl, 21, 'pc_fs_read', {
            filePath: fsFile,
            startLine: 2,
            endLine: 3,
        });
        check(
            'pc_fs_read returns numbered inclusive line range',
            read.isError === false &&
                read.payload.content.includes('2| TARGET_LINE') &&
                read.payload.content.includes('3| line three') &&
                read.payload.totalLines === 6,
            read.text.slice(0, 400)
        );
        const patch = await callTool(baseUrl, 22, 'pc_fs_patch', {
            filePath: fsFile,
            searchBlock: 'TARGET_LINE',
            replaceBlock: 'PATCHED_LINE',
        });
        check(
            'pc_fs_patch returns unified diff',
            patch.isError === false &&
                patch.payload.occurrences === 1 &&
                patch.payload.diff.includes('--- a/') &&
                patch.payload.diff.includes('+++ b/') &&
                patch.payload.diff.includes('@@') &&
                patch.payload.diff.includes('-TARGET_LINE') &&
                patch.payload.diff.includes('+PATCHED_LINE'),
            patch.text.slice(0, 600)
        );
        const afterPatch = await callTool(baseUrl, 23, 'pc_fs_read', { filePath: fsFile });
        check(
            'pc_fs_patch content applied on disk',
            afterPatch.isError === false && afterPatch.payload.content.includes('PATCHED_LINE'),
            afterPatch.text.slice(0, 300)
        );
        const secondWrite = await callTool(baseUrl, 24, 'pc_fs_write', {
            filePath: fsFile,
            content: originalContent,
        });
        check(
            'pc_fs_write reports created=false for existing file',
            secondWrite.isError === false && secondWrite.payload.created === false,
            secondWrite.text.slice(0, 300)
        );
        const multiPatch = await callTool(baseUrl, 25, 'pc_fs_patch', {
            filePath: fsFile,
            searchBlock: 'line',
            replaceBlock: 'LINE',
        });
        check(
            'pc_fs_patch rejects multiple occurrences with count',
            multiPatch.isError === true && /4 occurrences/.test(multiPatch.text),
            multiPatch.text.slice(0, 300)
        );
        const missingPatch = await callTool(baseUrl, 26, 'pc_fs_patch', {
            filePath: fsFile,
            searchBlock: 'NOT_PRESENT_ANYWHERE',
            replaceBlock: 'x',
        });
        check(
            'pc_fs_patch rejects missing searchBlock',
            missingPatch.isError === true && /not found/.test(missingPatch.text),
            missingPatch.text.slice(0, 300)
        );
        const missingRead = await callTool(baseUrl, 27, 'pc_fs_read', {
            filePath: path.join(stateDir, 'definitely-not-here.txt'),
        });
        check(
            'pc_fs_read missing file is a tool error',
            missingRead.isError === true && /not found/i.test(missingRead.text),
            missingRead.text.slice(0, 300)
        );
        const binaryFile = path.join(stateDir, 'binary-sample.bin');
        fs.writeFileSync(binaryFile, Buffer.from([0x00, 0x01, 0x02, 0x00, 0x03]));
        const binaryRead = await callTool(baseUrl, 28, 'pc_fs_read', { filePath: binaryFile });
        check(
            'pc_fs_read rejects binary NUL files clearly',
            binaryRead.isError === true && /binary/i.test(binaryRead.text),
            binaryRead.text.slice(0, 300)
        );

        // ---- pc_exec_shell ----
        const echo = await callTool(baseUrl, 30, 'pc_exec_shell', { command: 'echo NCODE_ECHO_OK' });
        check(
            'pc_exec_shell echo captures stdout + exitCode',
            echo.isError === false &&
                echo.payload.exitCode === 0 &&
                echo.payload.stdout.includes('NCODE_ECHO_OK') &&
                typeof echo.payload.logPath === 'string',
            echo.text.slice(0, 400)
        );

        const longScript = path.join(stateDir, 'emit-long.mjs');
        fs.writeFileSync(longScript, "process.stdout.write('x'.repeat(100000));\n");
        const nodeExe = process.execPath;
        const longCommand = `"${nodeExe}" "${longScript}"`;
        const longResult = await callTool(baseUrl, 31, 'pc_exec_shell', {
            command: longCommand,
            timeoutMs: 30_000,
        });
        check(
            'pc_exec_shell truncates long output with log pointer',
            longResult.isError === false &&
                longResult.payload.stdoutTruncated === true &&
                longResult.payload.stdout.includes('[truncated: full log at ') &&
                longResult.payload.stdout.length < 40_000,
            longResult.text.slice(0, 400)
        );
        check(
            'pc_exec_shell writes full output to the log file',
            longResult.payload.logPath &&
                fs.existsSync(longResult.payload.logPath) &&
                fs.statSync(longResult.payload.logPath).size >= 100_000,
            longResult.payload && longResult.payload.logPath
        );

        const sleepScript = path.join(stateDir, 'sleep-forever.mjs');
        fs.writeFileSync(sleepScript, 'setTimeout(() => {}, 5000);\n');
        const timeoutCommand = `"${nodeExe}" "${sleepScript}"`;
        const timedOut = await callTool(baseUrl, 32, 'pc_exec_shell', {
            command: timeoutCommand,
            timeoutMs: 400,
        });
        check(
            'pc_exec_shell timeout kills the tree and reports timedOut',
            timedOut.isError === false && timedOut.payload.timedOut === true,
            timedOut.text.slice(0, 500)
        );

        const badCwd = await callTool(baseUrl, 36, 'pc_exec_shell', {
            command: 'echo hi',
            cwd: path.join(stateDir, 'no-such-directory'),
        });
        check(
            'pc_exec_shell nonexistent cwd is a clear tool error',
            badCwd.isError === true && /Working directory does not exist/i.test(badCwd.text),
            badCwd.text.slice(0, 300)
        );

        const bgScript = path.join(stateDir, 'background-sleep.mjs');
        fs.writeFileSync(bgScript, 'setTimeout(() => {}, 6000);\n');
        const bgCommand = `"${nodeExe}" "${bgScript}"`;
        const background = await callTool(baseUrl, 33, 'pc_exec_shell', {
            command: bgCommand,
            background: true,
        });
        check(
            'pc_exec_shell background returns pid + logPath',
            background.isError === false &&
                background.payload.started === true &&
                Number.isInteger(background.payload.pid) &&
                background.payload.pid > 0 &&
                typeof background.payload.logPath === 'string',
            background.text.slice(0, 400)
        );
        const backgroundPid = background.payload && background.payload.pid;
        if (backgroundPid) {
            cleanups.push(() => {
                try {
                    process.kill(backgroundPid);
                } catch {
                    // already gone
                }
            });
        }
        const systemInfoAfterBg = await callTool(baseUrl, 34, 'pc_system_info', {});
        check(
            'pc_system_info lists managed background process',
            systemInfoAfterBg.isError === false &&
                Array.isArray(systemInfoAfterBg.payload.backgroundProcesses) &&
                systemInfoAfterBg.payload.backgroundProcesses.some(
                    (entry) => entry.pid === backgroundPid && entry.alive === true
                ),
            JSON.stringify(systemInfoAfterBg.payload && systemInfoAfterBg.payload.backgroundProcesses)
        );

        // ---- pc_search_code (rg may be absent -> Node fallback must work) ----
        const search = await callTool(baseUrl, 40, 'pc_search_code', {
            directory: fixtureDir,
            pattern: 'needle',
        });
        check(
            'pc_search_code finds matches',
            search.isError === false &&
                search.payload.count >= 3 &&
                search.payload.matches.every(
                    (match) =>
                        typeof match.file === 'string' &&
                        typeof match.line === 'number' &&
                        typeof match.text === 'string'
                ),
            search.text.slice(0, 500)
        );
        check(
            'pc_search_code skips node_modules',
            search.payload.matches.every((match) => !match.file.includes('node_modules')),
            JSON.stringify(search.payload.matches.map((match) => match.file))
        );
        check(
            'pc_search_code reports a valid engine',
            search.payload.engine === 'node' || search.payload.engine === 'rg',
            search.payload.engine
        );
        const searchGlob = await callTool(baseUrl, 41, 'pc_search_code', {
            directory: fixtureDir,
            pattern: 'needle',
            fileGlob: '*.js',
        });
        check(
            'pc_search_code fileGlob *.js filters by basename',
            searchGlob.isError === false &&
                searchGlob.payload.matches.length >= 1 &&
                searchGlob.payload.matches.every((match) => match.file.endsWith('.js')) &&
                searchGlob.payload.matches.some((match) => match.file.endsWith('a.js')),
            searchGlob.text.slice(0, 500)
        );
        const searchGlobDeep = await callTool(baseUrl, 42, 'pc_search_code', {
            directory: fixtureDir,
            pattern: 'needle',
            fileGlob: '**/*.ts',
        });
        check(
            'pc_search_code fileGlob **/*.ts filters recursively',
            searchGlobDeep.isError === false &&
                searchGlobDeep.payload.count >= 1 &&
                searchGlobDeep.payload.matches.every((match) => match.file.endsWith('.ts')),
            searchGlobDeep.text.slice(0, 500)
        );
        const invalidRegex = await callTool(baseUrl, 43, 'pc_search_code', {
            directory: fixtureDir,
            pattern: '(',
        });
        check('pc_search_code invalid regex is a tool error', invalidRegex.isError === true, invalidRegex.text.slice(0, 300));

        // ---- pc_fs_tree ----
        section('pc_fs_tree (gitignore-aware IDE tree)');
        const treeRoot = path.join(stateDir, 'tree-fixture');
        fs.mkdirSync(path.join(treeRoot, 'src', 'nested'), { recursive: true });
        fs.mkdirSync(path.join(treeRoot, 'build'), { recursive: true });
        fs.mkdirSync(path.join(treeRoot, 'node_modules', 'pkg'), { recursive: true });
        fs.writeFileSync(
            path.join(treeRoot, '.gitignore'),
            'build/\nignored.txt\nnode_modules/\n*.log\n!keep.log\n'
        );
        fs.writeFileSync(path.join(treeRoot, 'README.md'), '# tree fixture\n');
        fs.writeFileSync(path.join(treeRoot, 'src', 'a.js'), 'const a = 1;\n');
        fs.writeFileSync(path.join(treeRoot, 'src', 'nested', 'b.ts'), 'export const b = 2;\n');
        fs.writeFileSync(path.join(treeRoot, 'ignored.txt'), 'ignored\n');
        fs.writeFileSync(path.join(treeRoot, 'debug.log'), 'log\n');
        fs.writeFileSync(path.join(treeRoot, 'keep.log'), 'keep\n');
        fs.writeFileSync(path.join(treeRoot, 'build', 'out.js'), 'built\n');
        fs.writeFileSync(path.join(treeRoot, 'node_modules', 'pkg', 'index.js'), 'module\n');

        const tree = await callTool(baseUrl, 60, 'pc_fs_tree', { directory: treeRoot });
        const treeFlat = tree.payload && Array.isArray(tree.payload.flatFiles) ? tree.payload.flatFiles : [];
        check(
            'pc_fs_tree returns a nested tree plus flat file list',
            tree.isError === false &&
                tree.payload.tree &&
                tree.payload.tree.type === 'directory' &&
                Array.isArray(tree.payload.tree.children) &&
                tree.payload.files >= 3,
            tree.text.slice(0, 500)
        );
        check(
            'pc_fs_tree respects .gitignore rules',
            treeFlat.includes('src/a.js') &&
                treeFlat.includes('src/nested/b.ts') &&
                treeFlat.includes('keep.log') &&
                !treeFlat.includes('ignored.txt') &&
                !treeFlat.includes('debug.log') &&
                !treeFlat.some((entry) => entry.startsWith('build/')) &&
                !treeFlat.some((entry) => entry.startsWith('node_modules/')),
            JSON.stringify(treeFlat)
        );
        const readmeNode = tree.payload.tree.children.find((child) => child.name === 'README.md');
        check(
            'pc_fs_tree reports file sizes',
            readmeNode && readmeNode.size === fs.statSync(path.join(treeRoot, 'README.md')).size,
            JSON.stringify(readmeNode)
        );
        const treeNoIgnore = await callTool(baseUrl, 61, 'pc_fs_tree', {
            directory: treeRoot,
            respectGitignore: false,
        });
        const treeNoIgnoreFlat = treeNoIgnore.payload ? treeNoIgnore.payload.flatFiles : [];
        check(
            'pc_fs_tree respectGitignore:false keeps ignored files',
            treeNoIgnore.isError === false &&
                treeNoIgnoreFlat.includes('ignored.txt') &&
                treeNoIgnoreFlat.some((entry) => entry.startsWith('build/')),
            JSON.stringify(treeNoIgnoreFlat)
        );
        const treeDepth = await callTool(baseUrl, 62, 'pc_fs_tree', { directory: treeRoot, depth: 1 });
        const srcDirNode =
            treeDepth.payload && treeDepth.payload.tree.children.find((child) => child.name === 'src');
        check(
            'pc_fs_tree enforces the depth cap',
            treeDepth.isError === false &&
                srcDirNode &&
                Array.isArray(srcDirNode.children) &&
                srcDirNode.children.length === 0 &&
                treeDepth.payload.totalNodes <= 30,
            treeDepth.text.slice(0, 600)
        );
        const treeMissing = await callTool(baseUrl, 63, 'pc_fs_tree', {
            directory: path.join(stateDir, 'no-such-tree-dir'),
        });
        check(
            'pc_fs_tree missing directory is a clear tool error',
            treeMissing.isError === true && /Directory not found/.test(treeMissing.text),
            treeMissing.text.slice(0, 300)
        );

        // ---- pc_search_code extensions ----
        section('pc_search_code context/case/maxResults');
        const searchExtDir = path.join(stateDir, 'search-ext');
        fs.mkdirSync(searchExtDir, { recursive: true });
        fs.writeFileSync(
            path.join(searchExtDir, 'context.js'),
            'line one\nconst alpha = 1;\nconst BETA = 2;\nfunction gamma() {\n  return alpha + BETA;\n}\nline seven\n'
        );
        const contextSearch = await callTool(baseUrl, 64, 'pc_search_code', {
            directory: searchExtDir,
            pattern: 'return alpha',
            contextLines: 2,
        });
        const contextMatch = contextSearch.payload && contextSearch.payload.matches[0];
        check(
            'pc_search_code contextLines returns surrounding lines',
            contextSearch.isError === false &&
                contextMatch &&
                Array.isArray(contextMatch.context) &&
                contextMatch.context.length === 5 &&
                contextMatch.context.some((entry) => entry.line === 3 && entry.isMatch === false) &&
                contextMatch.context.some((entry) => entry.isMatch === true),
            contextSearch.text.slice(0, 800)
        );
        const insensitiveSearch = await callTool(baseUrl, 65, 'pc_search_code', {
            directory: searchExtDir,
            pattern: 'beta',
            caseInsensitive: true,
        });
        const sensitiveSearch = await callTool(baseUrl, 66, 'pc_search_code', {
            directory: searchExtDir,
            pattern: 'beta',
            caseInsensitive: false,
        });
        check(
            'pc_search_code caseInsensitive toggles matching',
            insensitiveSearch.isError === false &&
                insensitiveSearch.payload.count >= 1 &&
                sensitiveSearch.isError === false &&
                sensitiveSearch.payload.count === 0,
            `${insensitiveSearch.text.slice(0, 300)} / ${sensitiveSearch.text.slice(0, 200)}`
        );
        const cappedSearch = await callTool(baseUrl, 67, 'pc_search_code', {
            directory: searchExtDir,
            pattern: 'line',
            maxResults: 1,
        });
        check(
            'pc_search_code maxResults clamps the result count',
            cappedSearch.isError === false &&
                cappedSearch.payload.count === 1 &&
                cappedSearch.payload.maxResults === 1,
            cappedSearch.text.slice(0, 400)
        );

        // ---- stateful shell sessions ----
        section('Stateful shell sessions (pc_exec_shell + pc_shell_session)');
        const sessionDirA = path.join(stateDir, 'session-a');
        const sessionDirB = path.join(stateDir, 'session-b');
        fs.mkdirSync(sessionDirA, { recursive: true });
        fs.mkdirSync(sessionDirB, { recursive: true });
        const statefulWorkflow = 'wf_smoke_stateful';
        const statefulCwdScript = path.join(stateDir, 'print-cwd.mjs');
        fs.writeFileSync(statefulCwdScript, 'process.stdout.write(process.cwd());\n');
        const statefulEnvScript = path.join(stateDir, 'print-env-var.mjs');
        fs.writeFileSync(
            statefulEnvScript,
            'process.stdout.write(String(process.env.NCODE_SMOKE_VAR));\n'
        );

        const cdIntercept = await callTool(baseUrl, 70, 'pc_exec_shell', {
            command: `cd "${sessionDirA}"`,
            workflowId: statefulWorkflow,
        });
        check(
            'pc_exec_shell intercepts cd without spawning',
            cdIntercept.isError === false &&
                cdIntercept.payload.intercepted === true &&
                cdIntercept.payload.spawn === false &&
                path.resolve(cdIntercept.payload.sessionCwd) === path.resolve(sessionDirA),
            cdIntercept.text.slice(0, 500)
        );
        const pwdIntercept = await callTool(baseUrl, 71, 'pc_exec_shell', {
            command: 'pwd',
            workflowId: statefulWorkflow,
        });
        check(
            'stateful session cwd persists across calls',
            pwdIntercept.isError === false &&
                path.resolve(pwdIntercept.payload.stdout.trim()) === path.resolve(sessionDirA),
            pwdIntercept.text.slice(0, 400)
        );
        const spawnCwd = await callTool(baseUrl, 72, 'pc_exec_shell', {
            command: `"${nodeExe}" "${statefulCwdScript}"`,
            workflowId: statefulWorkflow,
        });
        check(
            'spawned command runs in the session cwd',
            spawnCwd.isError === false &&
                spawnCwd.payload.exitCode === 0 &&
                path.resolve(spawnCwd.payload.stdout.trim()) === path.resolve(sessionDirA) &&
                spawnCwd.payload.workflowId === statefulWorkflow,
            spawnCwd.text.slice(0, 500)
        );
        const exportIntercept = await callTool(baseUrl, 73, 'pc_exec_shell', {
            command: 'export NCODE_SMOKE_VAR=hello-workflow',
            workflowId: statefulWorkflow,
        });
        check(
            'pc_exec_shell intercepts export',
            exportIntercept.isError === false && exportIntercept.payload.intercepted === true,
            exportIntercept.text.slice(0, 400)
        );
        const envSpawn = await callTool(baseUrl, 74, 'pc_exec_shell', {
            command: `"${nodeExe}" "${statefulEnvScript}"`,
            workflowId: statefulWorkflow,
        });
        check(
            'session env persists into spawned commands',
            envSpawn.isError === false && envSpawn.payload.stdout.trim() === 'hello-workflow',
            envSpawn.text.slice(0, 400)
        );
        const setBuiltin = await callTool(baseUrl, 86, 'pc_exec_shell', {
            command: 'set NCODE_SET_VAR=set-ok',
            workflowId: statefulWorkflow,
        });
        const infoAfterSet = await callTool(baseUrl, 87, 'pc_shell_session', {
            action: 'info',
            workflowId: statefulWorkflow,
        });
        const unsetBuiltin = await callTool(baseUrl, 88, 'pc_exec_shell', {
            command: 'unset NCODE_SET_VAR',
            workflowId: statefulWorkflow,
        });
        const infoAfterUnset = await callTool(baseUrl, 89, 'pc_shell_session', {
            action: 'info',
            workflowId: statefulWorkflow,
        });
        check(
            'set/unset builtins update the session env',
            setBuiltin.isError === false &&
                setBuiltin.payload.intercepted === true &&
                infoAfterSet.payload.env.NCODE_SET_VAR === 'set-ok' &&
                unsetBuiltin.isError === false &&
                unsetBuiltin.payload.intercepted === true &&
                !Object.prototype.hasOwnProperty.call(infoAfterUnset.payload.env, 'NCODE_SET_VAR'),
            `${infoAfterSet.text.slice(0, 300)} / ${infoAfterUnset.text.slice(0, 300)}`
        );
        const envParamCall = await callTool(baseUrl, 75, 'pc_exec_shell', {
            command: 'pwd',
            workflowId: statefulWorkflow,
            env: { NCODE_INLINE_VAR: 'inline-ok' },
        });
        const sessionInfo = await callTool(baseUrl, 76, 'pc_shell_session', {
            action: 'info',
            workflowId: statefulWorkflow,
        });
        check(
            'pc_exec_shell env parameter merges into the session',
            envParamCall.isError === false &&
                sessionInfo.isError === false &&
                sessionInfo.payload.env.NCODE_SMOKE_VAR === 'hello-workflow' &&
                sessionInfo.payload.env.NCODE_INLINE_VAR === 'inline-ok' &&
                path.resolve(sessionInfo.payload.cwd) === path.resolve(sessionDirA),
            sessionInfo.text.slice(0, 700)
        );
        const pushdCall = await callTool(baseUrl, 77, 'pc_exec_shell', {
            command: `pushd "${sessionDirB}"`,
            workflowId: statefulWorkflow,
        });
        const pushdPwd = await callTool(baseUrl, 78, 'pc_exec_shell', {
            command: 'pwd',
            workflowId: statefulWorkflow,
        });
        check(
            'pushd changes the session cwd and keeps a stack',
            pushdCall.isError === false &&
                path.resolve(pushdCall.payload.sessionCwd) === path.resolve(sessionDirB) &&
                Array.isArray(pushdCall.payload.session.pushdStack) &&
                pushdCall.payload.session.pushdStack.length === 1 &&
                path.resolve(pushdPwd.payload.stdout.trim()) === path.resolve(sessionDirB),
            `${pushdCall.text.slice(0, 300)} / ${pushdPwd.text.slice(0, 300)}`
        );
        const popdCall = await callTool(baseUrl, 79, 'pc_exec_shell', {
            command: 'popd',
            workflowId: statefulWorkflow,
        });
        check(
            'popd restores the previous session cwd',
            popdCall.isError === false &&
                path.resolve(popdCall.payload.sessionCwd) === path.resolve(sessionDirA),
            popdCall.text.slice(0, 400)
        );
        const cdMissing = await callTool(baseUrl, 80, 'pc_exec_shell', {
            command: `cd "${path.join(stateDir, 'nope-dir')}"`,
            workflowId: statefulWorkflow,
        });
        check(
            'cd into a missing directory is a clear tool error',
            cdMissing.isError === true && /does not exist/i.test(cdMissing.text),
            cdMissing.text.slice(0, 400)
        );
        const statelessPwd = await callTool(baseUrl, 81, 'pc_exec_shell', { command: 'pwd' });
        check(
            'stateless pc_exec_shell keeps no session state',
            statelessPwd.isError === false &&
                statelessPwd.payload.workflowId === null &&
                path.resolve(statelessPwd.payload.stdout.trim()) === path.resolve(os.homedir()),
            statelessPwd.text.slice(0, 400)
        );
        const chainedBuiltins = await callTool(baseUrl, 82, 'pc_exec_shell', {
            command: `cd "${sessionDirB}" && "${nodeExe}" "${statefulCwdScript}"`,
            workflowId: 'wf_smoke_chain',
        });
        check(
            'leading cd builtin applies before the spawned command',
            chainedBuiltins.isError === false &&
                path.resolve(chainedBuiltins.payload.stdout.trim()) === path.resolve(sessionDirB),
            chainedBuiltins.text.slice(0, 500)
        );
        const sessionList = await callTool(baseUrl, 83, 'pc_shell_session', { action: 'list' });
        check(
            'pc_shell_session list reports sessions',
            sessionList.isError === false &&
                sessionList.payload.count >= 1 &&
                sessionList.payload.sessions.some(
                    (entry) => entry.workflowId === statefulWorkflow && entry.envCount >= 2
                ),
            sessionList.text.slice(0, 700)
        );
        const sessionReset = await callTool(baseUrl, 84, 'pc_shell_session', {
            action: 'reset',
            workflowId: statefulWorkflow,
        });
        const sessionAfterReset = await callTool(baseUrl, 85, 'pc_shell_session', {
            action: 'info',
            workflowId: statefulWorkflow,
        });
        check(
            'pc_shell_session reset clears cwd and env',
            sessionReset.isError === false &&
                sessionReset.payload.reset === true &&
                sessionAfterReset.isError === false &&
                sessionAfterReset.payload.envCount === 0 &&
                path.resolve(sessionAfterReset.payload.cwd) === path.resolve(os.homedir()),
            sessionAfterReset.text.slice(0, 700)
        );

        // Prepared here, verified from the phase-B daemon after the restart below.
        const persistSessionWorkflow = 'wf_smoke_persist';
        const persistSessionCd = await callTool(baseUrl, 100, 'pc_exec_shell', {
            command: `cd "${sessionDirB}"`,
            workflowId: persistSessionWorkflow,
        });
        const persistSessionEnv = await callTool(baseUrl, 101, 'pc_exec_shell', {
            command: 'export NCODE_PERSIST_SESSION=persisted',
            workflowId: persistSessionWorkflow,
        });
        check(
            'stateful session prepared for the restart-persistence check',
            persistSessionCd.isError === false &&
                persistSessionEnv.isError === false &&
                persistSessionEnv.payload.intercepted === true,
            `${persistSessionCd.text.slice(0, 300)} / ${persistSessionEnv.text.slice(0, 300)}`
        );

        // ---- pc_bg_process ----
        section('Background process manager (pc_bg_process)');
        const bgTickerScript = path.join(stateDir, 'bg-ticker.mjs');
        fs.writeFileSync(
            bgTickerScript,
            "let ticks = 0;\nconst timer = setInterval(() => { ticks += 1; console.log('tick ' + ticks); }, 100);\nsetTimeout(() => { clearInterval(timer); process.exit(0); }, 60000);\n"
        );
        const bgStart = await callTool(baseUrl, 90, 'pc_bg_process', {
            action: 'start',
            command: `"${nodeExe}" "${bgTickerScript}"`,
            name: 'smoke-ticker',
        });
        check(
            'pc_bg_process start returns id/pid/logPath',
            bgStart.isError === false &&
                bgStart.payload.started === true &&
                typeof bgStart.payload.id === 'string' &&
                Number.isInteger(bgStart.payload.pid) &&
                typeof bgStart.payload.logPath === 'string',
            bgStart.text.slice(0, 600)
        );
        const bgProcessId = bgStart.payload && bgStart.payload.id;
        const bgProcessPid = bgStart.payload && bgStart.payload.pid;
        cleanups.push(() => killTestProcessTree(bgProcessPid));
        await sleep(700);
        const bgStatus = await callTool(baseUrl, 91, 'pc_bg_process', {
            action: 'status',
            id: bgProcessId,
        });
        check(
            'pc_bg_process status reports a running process',
            bgStatus.isError === false &&
                bgStatus.payload.running === true &&
                bgStatus.payload.exitCode === null &&
                bgStatus.payload.pid === bgProcessPid &&
                typeof bgStatus.payload.uptimeMs === 'number' &&
                bgStatus.payload.uptimeMs >= 0,
            bgStatus.text.slice(0, 600)
        );
        const bgLogs = await callTool(baseUrl, 92, 'pc_bg_process', {
            action: 'logs',
            id: bgProcessId,
            tailBytes: 4096,
        });
        check(
            'pc_bg_process logs returns the bounded tail',
            bgLogs.isError === false &&
                bgLogs.payload.text.includes('tick') &&
                bgLogs.payload.totalBytes > 0 &&
                bgLogs.payload.bytes <= 4096 &&
                bgLogs.payload.logPath === bgStart.payload.logPath,
            bgLogs.text.slice(0, 600)
        );
        const bgTailCap = await callTool(baseUrl, 93, 'pc_bg_process', {
            action: 'logs',
            id: bgProcessId,
            tailBytes: 1,
        });
        check(
            'pc_bg_process logs honours the 64 KB tail bound',
            bgTailCap.isError === false &&
                bgTailCap.payload.totalBytes > bgTailCap.payload.bytes &&
                bgTailCap.payload.bytes <= 12 &&
                bgTailCap.payload.truncated === true,
            bgTailCap.text.slice(0, 500)
        );
        const bgList = await callTool(baseUrl, 94, 'pc_bg_process', { action: 'list' });
        check(
            'pc_bg_process list includes the running process',
            bgList.isError === false &&
                bgList.payload.count >= 1 &&
                bgList.payload.processes.some((entry) => entry.id === bgProcessId && entry.running === true),
            bgList.text.slice(0, 700)
        );
        const bgUnknown = await callTool(baseUrl, 95, 'pc_bg_process', {
            action: 'status',
            id: 'bg_does_not_exist_smoke',
        });
        check(
            'pc_bg_process unknown id is a clear tool error',
            bgUnknown.isError === true && /Unknown background process id/.test(bgUnknown.text),
            bgUnknown.text.slice(0, 400)
        );
        const shellBackgroundRegistry = await callTool(baseUrl, 96, 'pc_bg_process', {
            action: 'status',
            id: background.payload.id,
        });
        check(
            'pc_exec_shell background processes share the pc_bg_process registry',
            shellBackgroundRegistry.isError === false &&
                shellBackgroundRegistry.payload.pid === backgroundPid,
            shellBackgroundRegistry.text.slice(0, 500)
        );
        const bgKill = await callTool(baseUrl, 97, 'pc_bg_process', {
            action: 'kill',
            id: bgProcessId,
            signal: 'SIGKILL',
        });
        check(
            'pc_bg_process kill stops the process tree',
            bgKill.isError === false && bgKill.payload.killed === true && bgKill.payload.running === false,
            bgKill.text.slice(0, 600)
        );
        const bgStatusAfterKill = await callTool(baseUrl, 98, 'pc_bg_process', {
            action: 'status',
            id: bgProcessId,
        });
        check(
            'pc_bg_process status after kill reports not running',
            bgStatusAfterKill.isError === false && bgStatusAfterKill.payload.running === false,
            bgStatusAfterKill.text.slice(0, 600)
        );

        // Started now, managed from the phase-B daemon after this daemon exits.
        const persistTickerScript = path.join(stateDir, 'persist-ticker.mjs');
        fs.writeFileSync(
            persistTickerScript,
            "let ticks = 0;\nconst timer = setInterval(() => { ticks += 1; console.log('persist-tick ' + ticks); }, 100);\nsetTimeout(() => { clearInterval(timer); process.exit(0); }, 120000);\n"
        );
        const persistStart = await callTool(baseUrl, 99, 'pc_bg_process', {
            action: 'start',
            command: `"${nodeExe}" "${persistTickerScript}"`,
            name: 'persist-across-restart',
        });
        check(
            'pc_bg_process start for the restart-persistence check',
            persistStart.isError === false && persistStart.payload.started === true,
            persistStart.text.slice(0, 500)
        );
        const persistProcessId = persistStart.payload && persistStart.payload.id;
        const persistProcessPid = persistStart.payload && persistStart.payload.pid;
        cleanups.push(() => killTestProcessTree(persistProcessPid));
        await sleep(500);

        // ---- git suite ----
        section('Git suite (pc_git_*)');
        const gitProbe = spawnSync('git', ['--version'], { encoding: 'utf8', windowsHide: true });
        const gitAvailable = !gitProbe.error && gitProbe.status === 0;
        if (!gitAvailable) {
            skip('git suite', 'git is not installed on this machine');
        } else {
            const repoDir = path.join(stateDir, 'git-repo');
            fs.mkdirSync(repoDir, { recursive: true });
            gitCli(repoDir, ['init']);
            gitCli(repoDir, ['config', 'user.name', 'Ncode Smoke Test']);
            gitCli(repoDir, ['config', 'user.email', 'smoke@example.com']);
            gitCli(repoDir, ['config', 'commit.gpgsign', 'false']);
            fs.writeFileSync(path.join(repoDir, 'README.md'), '# git fixture\n');
            fs.writeFileSync(path.join(repoDir, 'notes.txt'), 'seed\n');

            const notRepoDir = path.join(stateDir, 'not-a-repo-fixture');
            fs.mkdirSync(notRepoDir, { recursive: true });
            const notRepoStatus = await callTool(baseUrl, 110, 'pc_git_status', {
                directory: notRepoDir,
            });
            check(
                'pc_git_status explains non-repository directories',
                notRepoStatus.isError === true && /Not a git repository/.test(notRepoStatus.text),
                notRepoStatus.text.slice(0, 400)
            );

            const gitAdd = await callTool(baseUrl, 111, 'pc_git_add', {
                directory: repoDir,
                paths: ['README.md', 'notes.txt'],
            });
            check(
                'pc_git_add stages files',
                gitAdd.isError === false &&
                    Array.isArray(gitAdd.payload.added) &&
                    gitAdd.payload.added.length === 2 &&
                    gitAdd.payload.status.counts.staged >= 2,
                gitAdd.text.slice(0, 700)
            );
            const gitCommit = await callTool(baseUrl, 112, 'pc_git_commit', {
                directory: repoDir,
                message: 'initial commit',
            });
            check(
                'pc_git_commit creates a commit',
                gitCommit.isError === false &&
                    typeof gitCommit.payload.hash === 'string' &&
                    gitCommit.payload.hash.length === 40 &&
                    gitCommit.payload.status.clean === true,
                gitCommit.text.slice(0, 700)
            );
            fs.writeFileSync(path.join(repoDir, 'README.md'), '# git fixture\nsecond line\n');
            fs.writeFileSync(path.join(repoDir, 'untracked.txt'), 'untracked\n');
            const gitStatus = await callTool(baseUrl, 113, 'pc_git_status', { directory: repoDir });
            check(
                'pc_git_status reports changed + untracked files',
                gitStatus.isError === false &&
                    gitStatus.payload.clean === false &&
                    gitStatus.payload.changes.some(
                        (entry) => entry.path === 'README.md' && entry.worktreeStatus === 'M'
                    ) &&
                    gitStatus.payload.changes.some(
                        (entry) => entry.path === 'untracked.txt' && entry.code === '??'
                    ) &&
                    typeof gitStatus.payload.branch === 'string',
                gitStatus.text.slice(0, 900)
            );
            const gitDiff = await callTool(baseUrl, 114, 'pc_git_diff', { directory: repoDir });
            check(
                'pc_git_diff returns a unified diff',
                gitDiff.isError === false &&
                    gitDiff.payload.diff.includes('+second line') &&
                    gitDiff.payload.filesChanged >= 1 &&
                    typeof gitDiff.payload.stat === 'string',
                gitDiff.text.slice(0, 900)
            );
            const gitStatusDiff = await callTool(baseUrl, 115, 'pc_git_status_diff', {
                directory: repoDir,
            });
            check(
                'pc_git_status_diff composes status + diff + commits',
                gitStatusDiff.isError === false &&
                    gitStatusDiff.payload.status &&
                    Array.isArray(gitStatusDiff.payload.commits) &&
                    gitStatusDiff.payload.commits.length >= 1 &&
                    typeof gitStatusDiff.payload.diff.unstaged === 'string' &&
                    gitStatusDiff.payload.diff.unstaged.includes('+second line'),
                gitStatusDiff.text.slice(0, 900)
            );
            await callTool(baseUrl, 116, 'pc_git_add', {
                directory: repoDir,
                paths: ['README.md', 'untracked.txt'],
            });
            const gitCommitSecond = await callTool(baseUrl, 117, 'pc_git_commit', {
                directory: repoDir,
                message: 'second commit',
            });
            check(
                'pc_git_commit commits staged changes',
                gitCommitSecond.isError === false && gitCommitSecond.payload.subject === 'second commit',
                gitCommitSecond.text.slice(0, 600)
            );
            const gitLog = await callTool(baseUrl, 118, 'pc_git_log', {
                directory: repoDir,
                maxCount: 5,
            });
            check(
                'pc_git_log returns structured commits',
                gitLog.isError === false &&
                    gitLog.payload.count >= 2 &&
                    gitLog.payload.commits[0].subject === 'second commit' &&
                    typeof gitLog.payload.commits[0].hash === 'string',
                gitLog.text.slice(0, 900)
            );
            const originalBranch = String(gitCli(repoDir, ['rev-parse', '--abbrev-ref', 'HEAD']).stdout || '').trim();
            const gitCheckoutCreate = await callTool(baseUrl, 119, 'pc_git_checkout', {
                directory: repoDir,
                branch: 'smoke-feature',
                create: true,
            });
            check(
                'pc_git_checkout creates and switches branches',
                gitCheckoutCreate.isError === false &&
                    gitCheckoutCreate.payload.branch === 'smoke-feature' &&
                    gitCheckoutCreate.payload.created === true,
                gitCheckoutCreate.text.slice(0, 600)
            );
            const gitCheckoutBack = await callTool(baseUrl, 120, 'pc_git_checkout', {
                directory: repoDir,
                branch: originalBranch,
            });
            check(
                'pc_git_checkout switches back to the original branch',
                gitCheckoutBack.isError === false && gitCheckoutBack.payload.branch === originalBranch,
                gitCheckoutBack.text.slice(0, 600)
            );
            const gitTraversal = await callTool(baseUrl, 121, 'pc_git_add', {
                directory: repoDir,
                paths: ['../escape.txt'],
            });
            check(
                'pc_git_add rejects paths outside the repository',
                gitTraversal.isError === true && /outside the repository/.test(gitTraversal.text),
                gitTraversal.text.slice(0, 500)
            );
        }

        // ---- desktop computer-use tools ----
        section('Desktop computer-use tools');
        const clipboardRead = await callTool(baseUrl, 130, 'pc_clipboard', { action: 'read' });
        if (clipboardRead.isError) {
            skip('pc_clipboard write/read round-trip', clipboardRead.text.slice(0, 300));
        } else {
            const previousClipboard = clipboardRead.payload.text;
            const clipboardMarker = `ncode-smoke-clip-${Date.now()}`;
            const clipboardWrite = await callTool(baseUrl, 131, 'pc_clipboard', {
                action: 'write',
                text: clipboardMarker,
            });
            const clipboardVerify = await callTool(baseUrl, 132, 'pc_clipboard', { action: 'read' });
            check(
                'pc_clipboard write/read round-trip',
                clipboardWrite.isError === false &&
                    clipboardVerify.isError === false &&
                    clipboardVerify.payload.text === clipboardMarker,
                `${clipboardWrite.text.slice(0, 300)} / ${clipboardVerify.text.slice(0, 300)}`
            );
            if (previousClipboard.length > 0) {
                await callTool(baseUrl, 133, 'pc_clipboard', {
                    action: 'write',
                    text: previousClipboard,
                });
            }
        }
        const screenshotPath = path.join(stateDir, 'screenshot-smoke.png');
        const screenshot = await callTool(baseUrl, 134, 'pc_desktop_screenshot', {
            savePath: screenshotPath,
            format: 'png',
        });
        if (screenshot.isError) {
            skip('pc_desktop_screenshot capture', screenshot.text.slice(0, 300));
        } else {
            const screenshotDisk = fs.existsSync(screenshotPath) ? fs.readFileSync(screenshotPath) : null;
            check(
                'pc_desktop_screenshot returns filePath/base64/dimensions',
                screenshotDisk !== null &&
                    screenshot.payload.bytes === screenshotDisk.length &&
                    screenshot.payload.width > 0 &&
                    screenshot.payload.height > 0 &&
                    Buffer.from(screenshot.payload.base64, 'base64').length === screenshotDisk.length,
                screenshot.text.slice(0, 600)
            );
            check(
                'pc_desktop_screenshot writes a real PNG',
                screenshotDisk !== null &&
                    screenshotDisk.subarray(0, 8).toString('hex') === '89504e470d0a1a0a',
                screenshot.text.slice(0, 300)
            );
        }
        const badScreenshotFormat = await callTool(baseUrl, 135, 'pc_desktop_screenshot', {
            format: 'jpeg',
        });
        check(
            'pc_desktop_screenshot rejects unsupported formats',
            badScreenshotFormat.isError === true && /Only "png"/.test(badScreenshotFormat.text),
            badScreenshotFormat.text.slice(0, 400)
        );
        const systemInfoExtended = await callTool(baseUrl, 136, 'pc_system_info', {});
        check(
            'pc_system_info reports shell sessions and the tool count',
            systemInfoExtended.isError === false &&
                systemInfoExtended.payload.shellSessions &&
                typeof systemInfoExtended.payload.shellSessions.count === 'number' &&
                systemInfoExtended.payload.toolCount === EXPECTED_TOOL_COUNT,
            systemInfoExtended.text.slice(0, 700)
        );

        // ---- JSON-RPC protocol behaviour ----
        const unknownMethod = await rpcHttp(baseUrl, {
            jsonrpc: '2.0',
            id: 50,
            method: 'does/not/exist',
        });
        check(
            'unknown method -> -32601',
            unknownMethod.json && unknownMethod.json.error && unknownMethod.json.error.code === -32601,
            unknownMethod.text.slice(0, 300)
        );
        const malformed = await httpJson(`${baseUrl}/mcp`, {
            method: 'POST',
            body: '{"jsonrpc":"2.0",',
            headers: { 'Content-Type': 'application/json' },
        });
        check(
            'malformed JSON -> 400 -32700',
            malformed.status === 400 && malformed.json && malformed.json.error && malformed.json.error.code === -32700,
            `${malformed.status} ${malformed.text}`
        );
        const invalidRequest = await rpcHttp(baseUrl, { jsonrpc: '2.0', id: 51, method: 42 });
        check(
            'invalid request -> -32600',
            invalidRequest.json && invalidRequest.json.error && invalidRequest.json.error.code === -32600,
            invalidRequest.text.slice(0, 300)
        );
        const batch = await rpcHttp(baseUrl, [
            { jsonrpc: '2.0', id: 52, method: 'ping' },
            { jsonrpc: '2.0', id: 53, method: 'tools/list' },
            { jsonrpc: '2.0', method: 'notifications/initialized' },
        ]);
        check(
            'batch array supported (notifications omitted)',
            batch.status === 200 &&
                Array.isArray(batch.json) &&
                batch.json.length === 2 &&
                batch.json[0].result &&
                Array.isArray(batch.json[1].result.tools),
            `${batch.status} ${batch.text.slice(0, 400)}`
        );
        const emptyBatch = await rpcHttp(baseUrl, []);
        check(
            'empty batch -> 400 -32600',
            emptyBatch.status === 400 && emptyBatch.json && emptyBatch.json.error && emptyBatch.json.error.code === -32600,
            `${emptyBatch.status} ${emptyBatch.text}`
        );
        const getMcp = await httpJson(`${baseUrl}/mcp`);
        check(
            'GET /mcp -> 405 JSON error',
            getMcp.status === 405 && getMcp.json && getMcp.json.error,
            `${getMcp.status} ${getMcp.text.slice(0, 300)}`
        );
        const deleteMcp = await httpJson(`${baseUrl}/mcp`, { method: 'DELETE' });
        check(
            'DELETE /mcp -> 200 {}',
            deleteMcp.status === 200 && deleteMcp.text === '{}',
            `${deleteMcp.status} ${deleteMcp.text}`
        );
        const options = await fetch(`${baseUrl}/mcp`, { method: 'OPTIONS' });
        check(
            'OPTIONS /mcp -> 204 with CORS allow headers',
            options.status === 204 &&
                (options.headers.get('access-control-allow-headers') || '').includes('Content-Type') &&
                (options.headers.get('access-control-allow-origin') || '') === '*',
            `${options.status}`
        );

        // ---- WebSocket bridge ----
        section('WebSocket bridge (Ncode protocol)');
        const extensionClient = await WsClient.connect(wsPort);
        cleanups.push(() => extensionClient.close());
        extensionClient.sendJson({
            type: 'register',
            role: 'extension',
            client: 'ncode-extension',
            version: '1.0.0',
        });
        const registered = await extensionClient.waitForMessage(
            (message) => message.type === 'registered',
            5000,
            'registered ack'
        );
        check(
            'WS register -> registered ack',
            registered.ok === true && registered.server === 'ncode-pc-daemon',
            JSON.stringify(registered)
        );
        const appPing = await extensionClient.waitForMessage(
            (message) => message.type === 'ping' && typeof message.ts === 'number',
            5000,
            'application ping'
        );
        check('WS daemon sends application ping every interval', typeof appPing.ts === 'number');
        extensionClient.sendJson({ type: 'pong', ts: appPing.ts });
        const appPing2 = await extensionClient.waitForMessage(
            (message) => message.type === 'ping',
            5000,
            'second application ping'
        );
        check('WS client survives after pong', !extensionClient.closed && Boolean(appPing2));

        extensionClient.sendPing('ncode-ws-ping');
        check(
            'WS protocol-level ping is answered with pong frame',
            await extensionClient.waitForPongPayload('ncode-ws-ping', 3000)
        );

        const wsHealth = await httpJson(`http://127.0.0.1:${wsPort}/health`);
        check(
            'WS-port /health reports extensionConnected',
            wsHealth.status === 200 &&
                wsHealth.json &&
                wsHealth.json.ws &&
                wsHealth.json.ws.extensionConnected === true,
            wsHealth.text
        );

        extensionClient.close();
        await sleep(200);

        // Legacy gemini-browser-mcp adapter.
        const legacyExtension = await WsClient.connect(wsPort);
        cleanups.push(() => legacyExtension.close());
        legacyExtension.sendJson({ action: 'identify', role: 'extension' });
        const legacyRegistered = await legacyExtension.waitForMessage(
            (message) => message.type === 'registered' && message.ok === true,
            5000,
            'legacy registered ack'
        );
        check('legacy {action:identify} -> registered ack', Boolean(legacyRegistered));

        const legacyHealth = await httpJson(`http://127.0.0.1:${wsPort}/health`);
        check(
            'legacy extension is treated as registered extension',
            legacyHealth.json && legacyHealth.json.ws && legacyHealth.json.ws.extensionConnected === true
        );

        const legacyAsker = await WsClient.connect(wsPort);
        cleanups.push(() => legacyAsker.close());
        legacyAsker.sendJson({ action: 'ask', prompt: 'legacy prompt', requestId: 'legacy-req-1' });
        const forwardedAsk = await legacyExtension.waitForMessage(
            (message) => message.action === 'ask' && message.requestId === 'legacy-req-1',
            5000,
            'legacy ask forwarded'
        );
        check('legacy ask is translated and forwarded to extension', forwardedAsk.prompt === 'legacy prompt');
        legacyExtension.sendJson({ text: 'legacy answer', requestId: 'legacy-req-1' });
        const legacyReply = await legacyAsker.waitForMessage(
            (message) => message.requestId === 'legacy-req-1' && typeof message.text === 'string',
            5000,
            'legacy reply'
        );
        check('legacy relay answer routed back in legacy shape', legacyReply.text === 'legacy answer');

        // Background children are detached and must survive daemon exit by design.
        const survivalScript = path.join(stateDir, 'survival.mjs');
        const survivalMarker = path.join(stateDir, 'survival-marker.txt');
        fs.writeFileSync(
            survivalScript,
            "import fs from 'node:fs';\nsetTimeout(() => { fs.writeFileSync(process.argv[2], 'survived'); }, 2000);\n"
        );
        const survivalCommand = `"${nodeExe}" "${survivalScript}" "${survivalMarker}"`;
        const survival = await callTool(baseUrl, 35, 'pc_exec_shell', {
            command: survivalCommand,
            background: true,
        });
        const survivalPid = survival.payload && survival.payload.pid;
        check(
            'pc_exec_shell background started for survival check',
            survival.isError === false &&
                survival.payload.started === true &&
                Number.isInteger(survivalPid),
            survival.text.slice(0, 400)
        );
        if (survivalPid) {
            cleanups.push(() => {
                try {
                    process.kill(survivalPid);
                } catch {
                    // already gone
                }
            });
        }

        const daemonExit = await daemon.stop();
        check('daemon exits after SIGTERM', Boolean(daemonExit), daemon.stderr.slice(-1500));
        const survivalMarkerWritten = await waitFor(
            () =>
                fs.existsSync(survivalMarker) &&
                fs.readFileSync(survivalMarker, 'utf8') === 'survived',
            10_000,
            200
        );
        check(
            'background child survives daemon exit',
            Boolean(survivalMarkerWritten),
            `pid=${survivalPid} marker=${survivalMarker}`
        );

        // --------------------------------------------------------------
        // Phase B: listener flags
        // --------------------------------------------------------------
        section('Listener flags: --no-ws');
        const noWsPort = await getFreePort();
        const noWsDaemon = new DaemonProcess(['--http-port', String(noWsPort), '--no-ws'], {
            NCODE_STATE_DIR: stateDir,
        });
        cleanups.push(() => noWsDaemon.stop());
        const noWsBanner = await noWsDaemon.waitForBanner();
        check(
            '--no-ws banner reports ws=off',
            noWsBanner.includes('ws=off') &&
                noWsBanner.includes(`http=http://127.0.0.1:${noWsPort}/mcp`) &&
                noWsBanner.includes('stdio=false'),
            noWsBanner
        );
        const noWsHealth = await waitFor(
            async () => {
                try {
                    const response = await httpJson(`http://127.0.0.1:${noWsPort}/health`);
                    return response.status === 200 ? response : null;
                } catch {
                    return null;
                }
            },
            10_000
        );
        check(
            '--no-ws HTTP MCP still healthy',
            Boolean(noWsHealth) && noWsHealth.json.ok === true && noWsHealth.json.tools === EXPECTED_TOOL_COUNT,
            noWsHealth ? noWsHealth.text : noWsDaemon.stderr.slice(-1500)
        );

        // The background process was started by the phase-A daemon; state dir is shared.
        const noWsBaseUrl = `http://127.0.0.1:${noWsPort}`;
        const persistedStatus = await callTool(noWsBaseUrl, 180, 'pc_bg_process', {
            action: 'status',
            id: persistProcessId,
        });
        check(
            'pc_bg_process status works after a daemon restart',
            persistedStatus.isError === false &&
                persistedStatus.payload.running === true &&
                persistedStatus.payload.pid === persistProcessPid,
            persistedStatus.text.slice(0, 700)
        );
        const persistedLogs = await callTool(noWsBaseUrl, 181, 'pc_bg_process', {
            action: 'logs',
            id: persistProcessId,
            tailBytes: 65536,
        });
        check(
            'pc_bg_process logs work after a daemon restart',
            persistedLogs.isError === false &&
                persistedLogs.payload.text.includes('persist-tick') &&
                persistedLogs.payload.totalBytes > 0,
            persistedLogs.text.slice(0, 700)
        );
        const persistedKill = await callTool(noWsBaseUrl, 182, 'pc_bg_process', {
            action: 'kill',
            id: persistProcessId,
            signal: 'SIGKILL',
        });
        check(
            'pc_bg_process kill works after a daemon restart',
            persistedKill.isError === false &&
                persistedKill.payload.killed === true &&
                persistedKill.payload.running === false,
            persistedKill.text.slice(0, 700)
        );
        const persistedSession = await callTool(noWsBaseUrl, 183, 'pc_shell_session', {
            action: 'info',
            workflowId: persistSessionWorkflow,
        });
        check(
            'stateful shell session survives a daemon restart',
            persistedSession.isError === false &&
                path.resolve(persistedSession.payload.cwd) === path.resolve(sessionDirB) &&
                persistedSession.payload.env.NCODE_PERSIST_SESSION === 'persisted',
            persistedSession.text.slice(0, 700)
        );
        await noWsDaemon.stop();

        // --------------------------------------------------------------
        // Phase C: stdio MCP + ask_gemini_web relay
        // --------------------------------------------------------------
        section('stdio MCP mode + ask_gemini_web');
        const stdioHttpPort = await getFreePort();
        const stdioWsPort = await getFreePort();
        const stdioDaemon = new DaemonProcess(
            ['--stdio', '--ws-port', String(stdioWsPort), '--http-port', String(stdioHttpPort)],
            { NCODE_STATE_DIR: path.join(stateDir, 'stdio-state') }
        );
        cleanups.push(() => stdioDaemon.stop());
        const stdioBanner = await stdioDaemon.waitForBanner();
        check(
            'stdio banner reports http=off ws=<port> stdio=true',
            stdioBanner.includes('http=off') &&
                stdioBanner.includes(`ws=ws://127.0.0.1:${stdioWsPort}`) &&
                stdioBanner.includes('stdio=true'),
            stdioBanner
        );

        const stdioClient = new StdioClient(stdioDaemon.child);
        const stdioInit = await stdioClient.request({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {
                protocolVersion: '2025-03-26',
                capabilities: {},
                clientInfo: { name: 'smoke-test-stdio', version: '1.0.0' },
            },
        });
        check(
            'stdio initialize returns serverInfo',
            stdioInit.result &&
                stdioInit.result.serverInfo &&
                stdioInit.result.serverInfo.name === 'ncode-pc-daemon',
            JSON.stringify(stdioInit).slice(0, 500)
        );
        const stdioList = await stdioClient.request({
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/list',
            params: {},
        });
        const stdioToolNames = ((stdioList.result && stdioList.result.tools) || []).map(
            (tool) => tool.name
        );
        check(
            `stdio tools/list contains all ${EXPECTED_TOOL_COUNT} core tools + ask_gemini_web`,
            [...CORE_TOOL_NAMES, 'ask_gemini_web'].every((name) => stdioToolNames.includes(name)),
            stdioToolNames.join(',')
        );
        const stdioSystemInfo = await stdioClient.request({
            jsonrpc: '2.0',
            id: 3,
            method: 'tools/call',
            params: { name: 'pc_system_info', arguments: {} },
        });
        const stdioSystemPayload = JSON.parse(stdioSystemInfo.result.content[0].text);
        check(
            'stdio tools/call pc_system_info works',
            stdioSystemInfo.result.isError === false && stdioSystemPayload.platform === process.platform
        );

        const stdioShellState = await stdioClient.request({
            jsonrpc: '2.0',
            id: 31,
            method: 'tools/call',
            params: {
                name: 'pc_exec_shell',
                arguments: { command: `cd "${sessionDirA}"`, workflowId: 'wf_smoke_stdio' },
            },
        });
        const stdioShellPayload = JSON.parse(stdioShellState.result.content[0].text);
        check(
            'stdio mode exposes the stateful shell',
            stdioShellState.result.isError === false &&
                stdioShellPayload.intercepted === true &&
                stdioShellPayload.workflowId === 'wf_smoke_stdio' &&
                path.resolve(stdioShellPayload.sessionCwd) === path.resolve(sessionDirA),
            JSON.stringify(stdioShellPayload).slice(0, 500)
        );

        const noExtensionAsk = await stdioClient.request(
            {
                jsonrpc: '2.0',
                id: 4,
                method: 'tools/call',
                params: { name: 'ask_gemini_web', arguments: { prompt: 'hi', timeoutMs: 700 } },
            },
            10_000
        );
        const noExtensionText = noExtensionAsk.result.content[0].text;
        check(
            'ask_gemini_web without extension fails with clear error',
            noExtensionAsk.result.isError === true &&
                /No registered Ncode browser extension client/.test(noExtensionText),
            noExtensionText.slice(0, 500)
        );

        let httpListenerRefused = false;
        try {
            await fetch(`http://127.0.0.1:${stdioHttpPort}/health`, {
                signal: AbortSignal.timeout(800),
            });
        } catch {
            httpListenerRefused = true;
        }
        check('stdio mode does not start the HTTP listener by default', httpListenerRefused);

        const stdioExtension = await WsClient.connect(stdioWsPort);
        cleanups.push(() => stdioExtension.close());
        stdioExtension.sendJson({
            type: 'register',
            role: 'extension',
            client: 'ncode-extension',
            version: '1.0.0',
        });
        const stdioRegistered = await stdioExtension.waitForMessage(
            (message) => message.type === 'registered' && message.ok === true,
            5000,
            'stdio extension registered ack'
        );
        check('stdio-mode WS register ack', Boolean(stdioRegistered));

        const askPromise = stdioClient.request(
            {
                jsonrpc: '2.0',
                id: 5,
                method: 'tools/call',
                params: {
                    name: 'ask_gemini_web',
                    arguments: { prompt: 'Say hi to the smoke test', timeoutMs: 8000 },
                },
            },
            20_000
        );
        const askFrame = await stdioExtension.waitForMessage(
            (message) => message.type === 'ask_gemini_web' && typeof message.id === 'string',
            5000,
            'ask_gemini_web frame'
        );
        check(
            'daemon sends Ncode ask_gemini_web frame',
            askFrame.prompt === 'Say hi to the smoke test' && typeof askFrame.timeoutMs === 'number',
            JSON.stringify(askFrame)
        );
        stdioExtension.sendJson({
            type: 'ask_gemini_web_result',
            id: askFrame.id,
            ok: true,
            text: 'hello from fake gemini',
        });
        const askResponse = await askPromise;
        const askResultText = askResponse.result.content[0].text;
        const askPayload = JSON.parse(askResultText);
        check(
            'ask_gemini_web round-trip returns extension text',
            askResponse.result.isError === false &&
                askPayload.text === 'hello from fake gemini' &&
                askPayload.requestId === askFrame.id,
            askResultText.slice(0, 500)
        );

        const rawStdoutLines = stdioClient.allLines.filter((line) => line.trim().length > 0);
        const impureLines = rawStdoutLines.filter((line) => {
            try {
                const parsed = JSON.parse(line);
                return !(parsed && parsed.jsonrpc === '2.0');
            } catch {
                return true;
            }
        });
        check(
            'stdio stdout contains only JSON-RPC frames',
            impureLines.length === 0,
            impureLines.slice(0, 3).join(' | ')
        );

        stdioDaemon.child.stdin.end();
        const stdioExit = await stdioDaemon.waitForExit(8000);
        check(
            'stdio daemon exits 0 when stdin closes',
            stdioExit && stdioExit.code === 0,
            JSON.stringify(stdioExit)
        );
    } finally {
        for (const cleanup of cleanups.reverse()) {
            try {
                await cleanup();
            } catch {
                // best effort cleanup
            }
        }
        try {
            fs.rmSync(stateDir, { recursive: true, force: true });
        } catch {
            // Windows may briefly lock daemon log files; temp dir cleanup is best effort
        }
    }

    const durationMs = Date.now() - startedAt;
    console.log('');
    const skipSuffix = skips > 0 ? ` (${skips} skipped)` : '';
    if (failures === 0) {
        console.log(`PASS: ${checks}/${checks} checks passed${skipSuffix} in ${durationMs}ms`);
        return 0;
    }
    console.log(`FAIL: ${failures} of ${checks} checks failed${skipSuffix} in ${durationMs}ms`);
    return 1;
}

run()
    .then((exitCode) => {
        process.exitCode = exitCode === 0 ? 0 : 1;
    })
    .catch((error) => {
        console.error('\nFAIL: smoke test crashed');
        console.error(error && error.stack ? error.stack : error);
        process.exitCode = 1;
    });
