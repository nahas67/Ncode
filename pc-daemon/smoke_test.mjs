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
 *     pc_search_code (Node fallback, fileGlob), validation errors
 *   - WebSocket bridge: register, application ping/pong, WS-level ping/pong,
 *     legacy gemini-browser-mcp relay, WS-port health
 *   - --no-ws listener flags
 *   - stdio MCP: banner, tools/list incl. ask_gemini_web, no HTTP listener,
 *     ask_gemini_web round-trip through a fake extension, stdout JSON purity,
 *     graceful exit on stdin close
 *
 * Prints PASS/FAIL per assertion and exits 0 on success, 1 on any failure.
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
    'pc_fs_read',
    'pc_fs_write',
    'pc_fs_patch',
    'pc_search_code',
    'pc_system_info',
    'workflow_save_checkpoint',
    'workflow_load_checkpoint',
    'workflow_list_checkpoints',
];

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
                health.json.tools === 9,
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
            'tools/list contains all 9 core tools',
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
            Boolean(noWsHealth) && noWsHealth.json.ok === true && noWsHealth.json.tools === 9,
            noWsHealth ? noWsHealth.text : noWsDaemon.stderr.slice(-1500)
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
            'stdio tools/list contains all 9 core tools + ask_gemini_web',
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
    if (failures === 0) {
        console.log(`PASS: ${checks}/${checks} checks passed in ${durationMs}ms`);
        return 0;
    }
    console.log(`FAIL: ${failures} of ${checks} checks failed in ${durationMs}ms`);
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
