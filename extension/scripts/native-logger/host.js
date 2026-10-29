#!/usr/bin/env node
// Native messaging host for Gemini Nexus: writes framed log entries from the
// extension to a rotating log file AND exposes a localhost HTTP/SSE bridge so
// local tools (agents, curl, IDE) can pull real-time errors without DevTools.
//
// Chrome MV3 cannot open TCP ports itself — this host is the only process that
// can listen. Protocol:
//   extension → host (stdin, 4-byte LE length + JSON):
//     log entry {timestamp,level,context,message,data?}
//     control   {type:'hello'|'response'|'event', ...}
//   host → extension (stdout, same framing):
//     {type:'request', id, method, params?}
//
// HTTP (default 127.0.0.1:17321):
//   GET  /health          — bridge liveness + extensionConnected
//   GET  /logs?limit=N    — recent buffered entries
//   GET  /logs/stream     — SSE real-time stream
//   GET  /status          — RPC to extension get_status
//   GET  /sessions        — list/search chat sessions (RPC get_sessions)
//   GET  /sessions/:id    — full single session (RPC get_session)
//   GET  /records         — sessions + groups + logs dump (RPC get_records)
//   GET  /groups          — chat groups (RPC get_groups)
//   GET  /storage/keys    — chrome.storage.local key inventory
//   POST /rpc             — {method, params} → extension, wait for response
//
// Env: GEMINI_NEXUS_BRIDGE_HOST (default 127.0.0.1),
//      GEMINI_NEXUS_BRIDGE_PORT (default 17321),
//      GEMINI_NEXUS_BRIDGE_TOKEN (optional; required if host is not loopback).

import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

export const DEFAULT_LOG_PATH = join(homedir(), 'Library', 'Logs', 'gemini-nexus.log');
export const ROTATE_BYTES = 10 * 1024 * 1024;
export const DEFAULT_BRIDGE_HOST = '127.0.0.1';
export const DEFAULT_BRIDGE_PORT = 17321;
export const RING_BUFFER_SIZE = 500;
export const RPC_TIMEOUT_MS = 10_000;

export function formatLogLine(entry) {
    const ts = entry?.timestamp
        ? new Date(entry.timestamp).toISOString()
        : new Date().toISOString();
    const level = String(entry?.level || 'INFO').toUpperCase();
    const ctx = entry?.context || 'System';
    const msg = entry?.message ?? '';
    const data = entry?.data ? ` ${JSON.stringify(entry.data)}` : '';
    return `[${ts}] [${level}] [${ctx}] ${msg}${data}`;
}

export function rotateIfNeeded(filePath, maxBytes = ROTATE_BYTES) {
    if (!existsSync(filePath)) return;
    let size = 0;
    try {
        size = statSync(filePath).size;
    } catch {
        return;
    }
    if (size >= maxBytes) {
        try {
            renameSync(filePath, `${filePath}.1`);
        } catch {
            // best-effort rotation; ignore failure
        }
    }
}

export function appendLogEntry(entry, filePath = DEFAULT_LOG_PATH, maxBytes = ROTATE_BYTES) {
    try {
        rotateIfNeeded(filePath, maxBytes);
        const dir = dirname(filePath);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        appendFileSync(filePath, `${formatLogLine(entry)}\n`, 'utf8');
    } catch (error) {
        process.stderr.write(`[native-logger] append failed: ${error?.message ?? error}\n`);
    }
}

export function readFramedMessages(buffer) {
    const messages = [];
    let offset = 0;
    while (offset + 4 <= buffer.length) {
        const length = buffer.readUInt32LE(offset);
        if (length <= 0 || offset + 4 + length > buffer.length) break;
        const raw = buffer.subarray(offset + 4, offset + 4 + length).toString('utf8');
        try {
            messages.push(JSON.parse(raw));
        } catch {
            // skip unparseable frame
        }
        offset += 4 + length;
    }
    return { messages, rest: buffer.subarray(offset) };
}

export function encodeFramedMessage(obj) {
    const json = Buffer.from(JSON.stringify(obj), 'utf8');
    const header = Buffer.alloc(4);
    header.writeUInt32LE(json.length, 0);
    return Buffer.concat([header, json]);
}

export function isLoopbackHost(host) {
    return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

/**
 * In-memory bridge state: ring buffer of recent log entries, SSE clients,
 * pending RPC waiters, and extension connection metadata.
 */
export class BridgeState {
    constructor({ ringSize = RING_BUFFER_SIZE } = {}) {
        this.ringSize = ringSize;
        this.logs = [];
        this.sseClients = new Set();
        this.pendingRpc = new Map(); // id → { resolve, reject, timer }
        this.extension = {
            connected: false,
            version: null,
            connectedAt: null,
            lastMessageAt: null,
        };
        this.writeToExtension = null; // (obj) => void
    }

    setWriter(fn) {
        this.writeToExtension = fn;
    }

    markExtensionHello(msg) {
        this.extension.connected = true;
        this.extension.version = msg?.version ?? this.extension.version;
        this.extension.connectedAt = Date.now();
        this.extension.lastMessageAt = Date.now();
    }

    markExtensionSeen() {
        this.extension.connected = true;
        this.extension.lastMessageAt = Date.now();
    }

    markExtensionDisconnected() {
        this.extension.connected = false;
        for (const [id, waiter] of this.pendingRpc) {
            clearTimeout(waiter.timer);
            waiter.reject(new Error('extension disconnected'));
            this.pendingRpc.delete(id);
        }
    }

    pushLog(entry) {
        this.markExtensionSeen();
        const normalized = {
            timestamp: entry?.timestamp ?? Date.now(),
            level: entry?.level || 'INFO',
            context: entry?.context || 'System',
            message: entry?.message ?? '',
            ...(entry?.data !== undefined ? { data: entry.data } : {}),
        };
        this.logs.push(normalized);
        if (this.logs.length > this.ringSize) {
            this.logs = this.logs.slice(-this.ringSize);
        }
        const payload = `data: ${JSON.stringify(normalized)}\n\n`;
        for (const res of this.sseClients) {
            try {
                res.write(payload);
            } catch {
                this.sseClients.delete(res);
            }
        }
        return normalized;
    }

    getLogs({ limit = 100, level } = {}) {
        let list = this.logs;
        if (level) {
            const want = String(level).toUpperCase();
            list = list.filter((e) => String(e.level).toUpperCase() === want);
        }
        const n = Math.max(1, Math.min(Number(limit) || 100, this.ringSize));
        return list.slice(-n);
    }

    addSseClient(res) {
        this.sseClients.add(res);
        // Catch-up: send buffered entries once so late joiners see recent history.
        for (const entry of this.logs.slice(-100)) {
            res.write(`data: ${JSON.stringify(entry)}\n\n`);
        }
    }

    removeSseClient(res) {
        this.sseClients.delete(res);
    }

    resolveRpc(msg) {
        const id = msg?.id;
        if (!id || !this.pendingRpc.has(id)) return false;
        const waiter = this.pendingRpc.get(id);
        this.pendingRpc.delete(id);
        clearTimeout(waiter.timer);
        if (msg.ok === false) {
            waiter.reject(new Error(msg.error || 'rpc failed'));
        } else {
            waiter.resolve(msg.result ?? msg);
        }
        return true;
    }

    request(method, params = {}, timeoutMs = RPC_TIMEOUT_MS) {
        if (!this.writeToExtension) {
            return Promise.reject(new Error('no writer to extension'));
        }
        if (!this.extension.connected) {
            return Promise.reject(new Error('extension not connected'));
        }
        const id = randomUUID();
        const envelope = { type: 'request', id, method, params };
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pendingRpc.delete(id);
                reject(new Error(`rpc timeout: ${method}`));
            }, timeoutMs);
            this.pendingRpc.set(id, { resolve, reject, timer });
            try {
                this.writeToExtension(envelope);
            } catch (error) {
                clearTimeout(timer);
                this.pendingRpc.delete(id);
                reject(error);
            }
        });
    }
}

export function checkAuth(req, token) {
    if (!token) return true;
    const header = req.headers['authorization'] || '';
    const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    const queryToken = (() => {
        try {
            return new URL(req.url || '/', 'http://x').searchParams.get('token') || '';
        } catch {
            return '';
        }
    })();
    const xToken = req.headers['x-bridge-token'] || '';
    return bearer === token || queryToken === token || xToken === token;
}

export function parseJsonBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            if (chunks.length === 0) {
                resolve({});
                return;
            }
            try {
                resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
            } catch (error) {
                reject(error);
            }
        });
        req.on('error', reject);
    });
}

function sendJson(res, status, body) {
    const json = JSON.stringify(body);
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Bridge-Token',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Cache-Control': 'no-store',
    });
    res.end(json);
}

/**
 * Pure request router used by createBridgeServer (and unit tests).
 * Returns true if handled; false means 404.
 */
export async function handleBridgeRequest(req, res, state, { token } = {}) {
    if (req.method === 'OPTIONS') {
        res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Bridge-Token',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        });
        res.end();
        return true;
    }

    if (!checkAuth(req, token)) {
        sendJson(res, 401, { ok: false, error: 'unauthorized' });
        return true;
    }

    let url;
    try {
        url = new URL(req.url || '/', 'http://bridge.local');
    } catch {
        sendJson(res, 400, { ok: false, error: 'bad url' });
        return true;
    }
    const path = url.pathname;

    if (req.method === 'GET' && path === '/health') {
        sendJson(res, 200, {
            ok: true,
            service: 'gemini-nexus-bridge',
            extensionConnected: !!state.extension.connected,
            extensionVersion: state.extension.version,
            connectedAt: state.extension.connectedAt,
            lastMessageAt: state.extension.lastMessageAt,
            bufferedLogs: state.logs.length,
            sseClients: state.sseClients.size,
        });
        return true;
    }

    if (req.method === 'GET' && path === '/logs') {
        const limit = url.searchParams.get('limit');
        const level = url.searchParams.get('level') || undefined;
        sendJson(res, 200, {
            ok: true,
            logs: state.getLogs({ limit, level }),
        });
        return true;
    }

    if (req.method === 'GET' && path === '/logs/stream') {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
            'Access-Control-Allow-Origin': '*',
        });
        res.write(': connected\n\n');
        state.addSseClient(res);
        const heartbeat = setInterval(() => {
            try {
                res.write(': ping\n\n');
            } catch {
                clearInterval(heartbeat);
            }
        }, 15000);
        req.on('close', () => {
            clearInterval(heartbeat);
            state.removeSseClient(res);
        });
        return true;
    }

    if (req.method === 'GET' && path === '/status') {
        try {
            const result = await state.request('get_status', {});
            sendJson(res, 200, { ok: true, status: result });
        } catch (error) {
            sendJson(res, 503, { ok: false, error: error?.message || String(error) });
        }
        return true;
    }

    if (req.method === 'GET' && path === '/sessions') {
        try {
            const result = await state.request('get_sessions', {
                limit: url.searchParams.get('limit') || undefined,
                offset: url.searchParams.get('offset') || undefined,
                query: url.searchParams.get('q') || url.searchParams.get('query') || undefined,
                includeMessages: parseBoolParam(url.searchParams.get('messages')),
                includeAttachments: parseBoolParam(url.searchParams.get('attachments')),
            });
            sendJson(res, 200, { ok: true, ...result });
        } catch (error) {
            sendJson(res, 503, { ok: false, error: error?.message || String(error) });
        }
        return true;
    }

    const sessionMatch = path.match(/^\/sessions\/([^/]+)$/);
    if (req.method === 'GET' && sessionMatch) {
        try {
            const result = await state.request('get_session', {
                id: decodeURIComponent(sessionMatch[1]),
                includeAttachments: parseBoolParam(url.searchParams.get('attachments')),
            });
            if (!result?.found) {
                sendJson(res, 404, { ok: false, error: 'session not found', ...result });
            } else {
                sendJson(res, 200, { ok: true, ...result });
            }
        } catch (error) {
            sendJson(res, 503, { ok: false, error: error?.message || String(error) });
        }
        return true;
    }

    if (req.method === 'GET' && path === '/records') {
        try {
            const result = await state.request('get_records', {
                limit: url.searchParams.get('limit') || undefined,
                offset: url.searchParams.get('offset') || undefined,
                query: url.searchParams.get('q') || url.searchParams.get('query') || undefined,
                id: url.searchParams.get('id') || undefined,
                // Default full messages; ?messages=0 for summary-only.
                includeMessages: url.searchParams.has('messages')
                    ? parseBoolParam(url.searchParams.get('messages'))
                    : true,
                includeAttachments: parseBoolParam(url.searchParams.get('attachments')),
                includeLogs: url.searchParams.has('logs')
                    ? parseBoolParam(url.searchParams.get('logs'))
                    : true,
                logLimit: url.searchParams.get('logLimit') || undefined,
            });
            sendJson(res, 200, { ok: true, ...result });
        } catch (error) {
            sendJson(res, 503, { ok: false, error: error?.message || String(error) });
        }
        return true;
    }

    if (req.method === 'GET' && path === '/groups') {
        try {
            const result = await state.request('get_groups', {});
            sendJson(res, 200, { ok: true, ...result });
        } catch (error) {
            sendJson(res, 503, { ok: false, error: error?.message || String(error) });
        }
        return true;
    }

    if (req.method === 'GET' && path === '/storage/keys') {
        try {
            const result = await state.request('get_storage_keys', {});
            sendJson(res, 200, { ok: true, ...result });
        } catch (error) {
            sendJson(res, 503, { ok: false, error: error?.message || String(error) });
        }
        return true;
    }

    if (req.method === 'POST' && path === '/rpc') {
        let body;
        try {
            body = await parseJsonBody(req);
        } catch {
            sendJson(res, 400, { ok: false, error: 'invalid json body' });
            return true;
        }
        const method = body?.method;
        if (!method || typeof method !== 'string') {
            sendJson(res, 400, { ok: false, error: 'method required' });
            return true;
        }
        try {
            const result = await state.request(method, body.params || {});
            sendJson(res, 200, { ok: true, result });
        } catch (error) {
            sendJson(res, 503, { ok: false, error: error?.message || String(error) });
        }
        return true;
    }

    sendJson(res, 404, {
        ok: false,
        error: 'not found',
        endpoints: [
            '/health',
            '/logs',
            '/logs/stream',
            '/status',
            '/sessions',
            '/sessions/:id',
            '/records',
            '/groups',
            '/storage/keys',
            'POST /rpc',
        ],
    });
    return true;
}

/** Accept 1/true/yes as true; 0/false/no as false; null/empty → false. */
export function parseBoolParam(value) {
    if (value == null || value === '') return false;
    const s = String(value).trim().toLowerCase();
    if (s === '1' || s === 'true' || s === 'yes' || s === 'on') return true;
    if (s === '0' || s === 'false' || s === 'no' || s === 'off') return false;
    return Boolean(value);
}

export function createBridgeServer(state, { host, port, token } = {}) {
    const server = createServer((req, res) => {
        handleBridgeRequest(req, res, state, { token }).catch((error) => {
            try {
                sendJson(res, 500, { ok: false, error: error?.message || String(error) });
            } catch {
                // ignore
            }
        });
    });
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
            resolve(server);
        });
    });
}

export function classifyExtensionMessage(msg) {
    if (!msg || typeof msg !== 'object') return 'ignore';
    if (msg.type === 'hello') return 'hello';
    if (msg.type === 'response') return 'response';
    if (msg.type === 'event') return 'event';
    // Plain log entries from NativeLoggerSink (no type field)
    if (msg.message != null || msg.level != null || msg.context != null) return 'log';
    return 'ignore';
}

export function processExtensionMessage(msg, state, logFilePath = DEFAULT_LOG_PATH) {
    const kind = classifyExtensionMessage(msg);
    switch (kind) {
        case 'hello':
            state.markExtensionHello(msg);
            return kind;
        case 'response':
            state.resolveRpc(msg);
            return kind;
        case 'event':
            state.markExtensionSeen();
            // Surface events as pseudo-log so SSE clients see them.
            state.pushLog({
                timestamp: msg.timestamp ?? Date.now(),
                level: 'INFO',
                context: msg.name || 'event',
                message:
                    typeof msg.payload === 'string'
                        ? msg.payload
                        : JSON.stringify(msg.payload ?? {}),
            });
            return kind;
        case 'log':
            appendLogEntry(msg, logFilePath);
            state.pushLog(msg);
            return kind;
        default:
            return kind;
    }
}

export async function main({
    logFilePath = DEFAULT_LOG_PATH,
    host = process.env.GEMINI_NEXUS_BRIDGE_HOST || DEFAULT_BRIDGE_HOST,
    port = Number(process.env.GEMINI_NEXUS_BRIDGE_PORT || DEFAULT_BRIDGE_PORT),
    token = process.env.GEMINI_NEXUS_BRIDGE_TOKEN || '',
    stdin = process.stdin,
    stdout = process.stdout,
    startHttp = true,
} = {}) {
    if (!isLoopbackHost(host) && !token) {
        process.stderr.write(
            '[native-logger] refusing non-loopback bind without GEMINI_NEXUS_BRIDGE_TOKEN\n'
        );
        process.exit(1);
    }

    const state = new BridgeState();
    state.setWriter((obj) => {
        stdout.write(encodeFramedMessage(obj));
    });

    let server = null;
    if (startHttp) {
        try {
            server = await createBridgeServer(state, { host, port, token });
            process.stderr.write(
                `[native-logger] HTTP bridge listening on http://${host}:${port}\n`
            );
        } catch (error) {
            process.stderr.write(
                `[native-logger] HTTP bridge failed to start: ${error?.message ?? error}\n`
            );
            // Keep file-logging even if the port is busy.
        }
    }

    let pending = Buffer.alloc(0);
    stdin.on('data', (chunk) => {
        pending = Buffer.concat([pending, chunk]);
        const { messages, rest } = readFramedMessages(pending);
        pending = rest;
        for (const msg of messages) {
            processExtensionMessage(msg, state, logFilePath);
        }
    });
    stdin.on('end', () => {
        state.markExtensionDisconnected();
        if (server) {
            try {
                server.close();
            } catch {
                // ignore
            }
        }
        process.exit(0);
    });
    stdin.on('error', () => {
        state.markExtensionDisconnected();
        process.exit(1);
    });

    return { state, server };
}

const invokedAsScript = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedAsScript) {
    main().catch((error) => {
        process.stderr.write(`[native-logger] fatal: ${error?.message ?? error}\n`);
        process.exit(1);
    });
}
