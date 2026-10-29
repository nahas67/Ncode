import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    formatLogLine,
    appendLogEntry,
    rotateIfNeeded,
    readFramedMessages,
    encodeFramedMessage,
    BridgeState,
    classifyExtensionMessage,
    processExtensionMessage,
    checkAuth,
    isLoopbackHost,
    handleBridgeRequest,
} from './host.js';

describe('formatLogLine', () => {
    it('formats a standard entry with ISO time, level, context, message', () => {
        const line = formatLogLine({
            timestamp: 1_718_000_000_000,
            level: 'info',
            context: 'browser_control.click',
            message: '点击元素',
        });
        expect(line).toMatch(
            /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] \[INFO\] \[browser_control\.click\] 点击元素$/
        );
    });

    it('appends compact data json when data present', () => {
        const line = formatLogLine({
            level: 'warn',
            context: 'X',
            message: 'm',
            data: { ok: true, n: 3 },
        });
        expect(line).toMatch(/ \{"ok":true,"n":3\}$/);
    });

    it('omits data segment when absent', () => {
        expect(formatLogLine({ level: 'error', context: 'X', message: 'm' })).not.toContain('{');
    });

    it('uppercases level and defaults context/message', () => {
        expect(formatLogLine({ level: 'debug' })).toMatch(/\[DEBUG\] \[System\] $/);
    });
});

describe('rotateIfNeeded', () => {
    it('renames to .1 when file at or over maxBytes', () => {
        const dir = mkdtempSync(join(tmpdir(), 'gn-host-'));
        const f = join(dir, 'a.log');
        writeFileSync(f, 'x'.repeat(100));
        rotateIfNeeded(f, 100);
        expect(readFileSync(join(dir, 'a.log.1'), 'utf8').length).toBe(100);
        rmSync(dir, { recursive: true, force: true });
    });

    it('leaves file untouched when under maxBytes', () => {
        const dir = mkdtempSync(join(tmpdir(), 'gn-host-'));
        const f = join(dir, 'a.log');
        writeFileSync(f, 'small');
        rotateIfNeeded(f, 100);
        expect(readFileSync(f, 'utf8')).toBe('small');
        rmSync(dir, { recursive: true, force: true });
    });

    it('no-op when file does not exist', () => {
        const dir = mkdtempSync(join(tmpdir(), 'gn-host-'));
        expect(() => rotateIfNeeded(join(dir, 'nope.log'), 1)).not.toThrow();
        rmSync(dir, { recursive: true, force: true });
    });
});

describe('appendLogEntry', () => {
    it('appends one line per entry with trailing newline', () => {
        const dir = mkdtempSync(join(tmpdir(), 'gn-host-'));
        const f = join(dir, 'sub', 'out.log');
        appendLogEntry({ level: 'info', context: 'C', message: 'first' }, f);
        appendLogEntry({ level: 'info', context: 'C', message: 'second' }, f);
        const text = readFileSync(f, 'utf8');
        expect(text.split('\n').filter(Boolean)).toHaveLength(2);
        expect(text).toContain('first');
        expect(text).toContain('second');
        rmSync(dir, { recursive: true, force: true });
    });

    it('rotates before append when over limit', () => {
        const dir = mkdtempSync(join(tmpdir(), 'gn-host-'));
        const f = join(dir, 'out.log');
        writeFileSync(f, 'x'.repeat(50));
        appendLogEntry({ level: 'info', message: 'new' }, f, 10);
        expect(readFileSync(join(dir, 'out.log.1'), 'utf8').length).toBe(50);
        expect(readFileSync(f, 'utf8')).toContain('new');
        rmSync(dir, { recursive: true, force: true });
    });
});

describe('readFramedMessages', () => {
    it('parses complete 4-byte-LE-length-prefixed JSON frames', () => {
        const a = Buffer.from(JSON.stringify({ message: 'a' }), 'utf8');
        const b = Buffer.from(JSON.stringify({ message: 'b' }), 'utf8');
        const buf = Buffer.concat([
            Buffer.from([a.length, 0, 0, 0]),
            a,
            Buffer.from([b.length, 0, 0, 0]),
            b,
        ]);
        const { messages, rest } = readFramedMessages(buf);
        expect(messages).toEqual([{ message: 'a' }, { message: 'b' }]);
        expect(rest.length).toBe(0);
    });

    it('keeps incomplete tail as rest', () => {
        const a = Buffer.from(JSON.stringify({ message: 'a' }), 'utf8');
        const partial = Buffer.from([5, 0, 0, 0]);
        const buf = Buffer.concat([Buffer.from([a.length, 0, 0, 0]), a, partial]);
        const { messages, rest } = readFramedMessages(buf);
        expect(messages).toEqual([{ message: 'a' }]);
        expect(rest.equals(partial)).toBe(true);
    });

    it('skips unparseable JSON frames', () => {
        const bad = Buffer.from('not-json', 'utf8');
        const buf = Buffer.concat([Buffer.from([bad.length, 0, 0, 0]), bad]);
        expect(readFramedMessages(buf).messages).toEqual([]);
    });
});

describe('encodeFramedMessage + round-trip', () => {
    it('round-trips through readFramedMessages', () => {
        const frame = encodeFramedMessage({ type: 'request', id: '1', method: 'ping' });
        const { messages } = readFramedMessages(frame);
        expect(messages).toEqual([{ type: 'request', id: '1', method: 'ping' }]);
    });
});

describe('isLoopbackHost / checkAuth', () => {
    it('recognizes loopback hosts', () => {
        expect(isLoopbackHost('127.0.0.1')).toBe(true);
        expect(isLoopbackHost('localhost')).toBe(true);
        expect(isLoopbackHost('0.0.0.0')).toBe(false);
    });

    it('allows all when no token configured', () => {
        expect(checkAuth({ headers: {}, url: '/' }, '')).toBe(true);
    });

    it('accepts bearer, query, or x-bridge-token', () => {
        expect(checkAuth({ headers: { authorization: 'Bearer secret' }, url: '/' }, 'secret')).toBe(
            true
        );
        expect(checkAuth({ headers: {}, url: '/?token=secret' }, 'secret')).toBe(true);
        expect(checkAuth({ headers: { 'x-bridge-token': 'secret' }, url: '/' }, 'secret')).toBe(
            true
        );
        expect(checkAuth({ headers: {}, url: '/' }, 'secret')).toBe(false);
    });
});

describe('BridgeState', () => {
    it('buffers logs and filters by level/limit', () => {
        const state = new BridgeState({ ringSize: 10 });
        state.pushLog({ level: 'info', message: 'a' });
        state.pushLog({ level: 'error', message: 'b' });
        state.pushLog({ level: 'error', message: 'c' });
        expect(state.getLogs({ limit: 2 }).map((e) => e.message)).toEqual(['b', 'c']);
        expect(state.getLogs({ level: 'error' }).map((e) => e.message)).toEqual(['b', 'c']);
    });

    it('resolves RPC when response arrives', async () => {
        const state = new BridgeState();
        state.markExtensionHello({ version: '1' });
        const sent = [];
        state.setWriter((obj) => sent.push(obj));
        const p = state.request('ping', {});
        expect(sent[0].type).toBe('request');
        expect(sent[0].method).toBe('ping');
        state.resolveRpc({ type: 'response', id: sent[0].id, ok: true, result: { pong: true } });
        await expect(p).resolves.toEqual({ pong: true });
    });

    it('rejects RPC when extension not connected', async () => {
        const state = new BridgeState();
        state.setWriter(() => {});
        await expect(state.request('ping')).rejects.toThrow(/not connected/);
    });
});

describe('classifyExtensionMessage / processExtensionMessage', () => {
    it('classifies hello, response, and plain logs', () => {
        expect(classifyExtensionMessage({ type: 'hello', version: '1' })).toBe('hello');
        expect(classifyExtensionMessage({ type: 'response', id: 'x' })).toBe('response');
        expect(classifyExtensionMessage({ level: 'info', message: 'hi' })).toBe('log');
    });

    it('writes logs to file and ring buffer', () => {
        const dir = mkdtempSync(join(tmpdir(), 'gn-host-'));
        const f = join(dir, 'out.log');
        const state = new BridgeState();
        processExtensionMessage({ level: 'error', context: 'X', message: 'boom' }, state, f);
        expect(state.logs).toHaveLength(1);
        expect(readFileSync(f, 'utf8')).toContain('boom');
        rmSync(dir, { recursive: true, force: true });
    });

    it('marks connected on hello', () => {
        const state = new BridgeState();
        processExtensionMessage({ type: 'hello', version: '5.0.18' }, state);
        expect(state.extension.connected).toBe(true);
        expect(state.extension.version).toBe('5.0.18');
    });
});

describe('handleBridgeRequest', () => {
    function mockRes() {
        const res = {
            statusCode: 0,
            headers: null,
            body: '',
            writeHead: vi.fn((code, headers) => {
                res.statusCode = code;
                res.headers = headers;
            }),
            end: vi.fn((data) => {
                res.body = data || '';
            }),
            write: vi.fn(),
        };
        return res;
    }

    it('GET /health returns extension connection state', async () => {
        const state = new BridgeState();
        state.markExtensionHello({ version: '5.0.18' });
        const res = mockRes();
        await handleBridgeRequest({ method: 'GET', url: '/health', headers: {} }, res, state);
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);
        expect(body.ok).toBe(true);
        expect(body.extensionConnected).toBe(true);
        expect(body.extensionVersion).toBe('5.0.18');
    });

    it('GET /logs returns buffered entries', async () => {
        const state = new BridgeState();
        state.pushLog({ level: 'info', message: 'one' });
        const res = mockRes();
        await handleBridgeRequest({ method: 'GET', url: '/logs?limit=5', headers: {} }, res, state);
        const body = JSON.parse(res.body);
        expect(body.logs[0].message).toBe('one');
    });

    it('rejects unauthorized when token set', async () => {
        const state = new BridgeState();
        const res = mockRes();
        await handleBridgeRequest({ method: 'GET', url: '/health', headers: {} }, res, state, {
            token: 'secret',
        });
        expect(res.statusCode).toBe(401);
    });

    it('GET /sessions proxies get_sessions RPC', async () => {
        const state = new BridgeState();
        state.request = vi.fn(async (method, params) => {
            expect(method).toBe('get_sessions');
            expect(params.includeMessages).toBe(true);
            return { total: 1, offset: 0, limit: 10, sessions: [{ id: 's1' }] };
        });
        const res = mockRes();
        await handleBridgeRequest(
            { method: 'GET', url: '/sessions?messages=1&limit=10', headers: {} },
            res,
            state
        );
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);
        expect(body.ok).toBe(true);
        expect(body.sessions[0].id).toBe('s1');
    });

    it('GET /sessions/:id proxies get_session RPC', async () => {
        const state = new BridgeState();
        state.request = vi.fn(async (method, params) => {
            expect(method).toBe('get_session');
            expect(params.id).toBe('abc-1');
            return { found: true, session: { id: 'abc-1', messages: [] } };
        });
        const res = mockRes();
        await handleBridgeRequest(
            { method: 'GET', url: '/sessions/abc-1', headers: {} },
            res,
            state
        );
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);
        expect(body.session.id).toBe('abc-1');
    });

    it('GET /records proxies get_records RPC', async () => {
        const state = new BridgeState();
        state.request = vi.fn(async (method) => {
            expect(method).toBe('get_records');
            return { sessions: { total: 0, sessions: [] }, groups: [], logs: [] };
        });
        const res = mockRes();
        await handleBridgeRequest({ method: 'GET', url: '/records', headers: {} }, res, state);
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);
        expect(body.ok).toBe(true);
        expect(body.groups).toEqual([]);
    });
});
