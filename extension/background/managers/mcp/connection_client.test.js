import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { McpConnectionClient } from './connection_client.js';

class FakeWebSocket {
    static instances = [];

    constructor(url) {
        this.url = url;
        this.readyState = 0; // CONNECTING
        this._listeners = new Map();
        FakeWebSocket.instances.push(this);
        // Auto-open on the next microtask so the 'open' event fires and the
        // connect promise resolves, mimicking a real socket connection.
        queueMicrotask(() => this.open());
    }

    addEventListener(type, fn) {
        if (!this._listeners.has(type)) this._listeners.set(type, new Set());
        this._listeners.get(type).add(fn);
    }

    removeEventListener(type, fn) {
        this._listeners.get(type)?.delete(fn);
    }

    _emit(type, event) {
        for (const fn of this._listeners.get(type) ?? []) {
            try {
                fn(event);
            } catch {}
        }
    }

    open() {
        this.readyState = 1; // OPEN
        this._emit('open');
    }

    close() {
        this.readyState = 3; // CLOSED
        this._emit('close');
    }

    emitMessage(data) {
        this._emit('message', { data: JSON.stringify(data) });
    }

    send() {}
}

function setupChrome() {
    globalThis.chrome = {
        runtime: { sendMessage: vi.fn(() => Promise.resolve()) },
        storage: { local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) } },
    };
}

describe('McpConnectionClient', () => {
    beforeEach(() => {
        FakeWebSocket.instances = [];
        globalThis.WebSocket = FakeWebSocket;
        setupChrome();
    });

    afterEach(() => {
        delete globalThis.WebSocket;
        delete globalThis.chrome;
        vi.restoreAllMocks();
    });

    it('serializes concurrent connect attempts for the same server (single-flight)', async () => {
        const client = new McpConnectionClient();
        const handshakeSpy = vi
            .spyOn(client, '_initializeHandshake')
            .mockImplementation(async (conn) => {
                conn.initialized = true;
                // Yield so a concurrent caller could interleave if not serialized.
                await Promise.resolve();
            });

        // Two concurrent connect calls for the same server.
        const [a, b] = await Promise.all([
            client.ensureConnectedForServer('srv-1', 'ws', 'ws://example.test', {}),
            client.ensureConnectedForServer('srv-1', 'ws', 'ws://example.test', {}),
        ]);

        expect(a).toBe(b);
        // Only one WebSocket should have been created.
        expect(FakeWebSocket.instances).toHaveLength(1);
        expect(handshakeSpy).toHaveBeenCalledTimes(1);
    });

    it('ignores close/error events from a superseded socket', async () => {
        const client = new McpConnectionClient();
        vi.spyOn(client, '_initializeHandshake').mockImplementation(async (conn) => {
            conn.initialized = true;
        });

        // First connection.
        await client.ensureConnectedForServer('srv-1', 'ws', 'ws://example.test', {});
        const firstSocket = FakeWebSocket.instances[0];
        expect(firstSocket).toBeDefined();

        // Force a reconnect (different URL → different configKey).
        await client.ensureConnectedForServer('srv-1', 'ws', 'ws://other.test', {});
        const secondSocket = FakeWebSocket.instances[1];
        expect(secondSocket).toBeDefined();
        expect(secondSocket.url).toContain('other.test');

        const conn = client.connections.get('srv-1');
        expect(conn.ws).toBe(secondSocket);
        expect(conn.initialized).toBe(true);

        // The old socket closes late — this must NOT tear down the new connection.
        firstSocket.close();

        expect(conn.ws).toBe(secondSocket);
        expect(conn.initialized).toBe(true);
    });
});
