import { describe, expect, it, vi } from 'vitest';
import { readSseStream } from './sse_stream.js';

function streamFromChunks(chunks) {
    const encoder = new TextEncoder();
    return new ReadableStream({
        start(controller) {
            for (const chunk of chunks) {
                controller.enqueue(encoder.encode(chunk));
            }
            controller.close();
        },
    });
}

describe('readSseStream', () => {
    it('resolves JSON endpoint events and RPC messages split across chunks', async () => {
        const resolveSseEndpoint = vi.fn();
        const conn = {
            _resolveSseEndpoint: resolveSseEndpoint,
            configKey: 'sse:key',
            initialized: true,
            sseAbort: {},
            ssePostUrl: null,
            transport: 'sse',
        };
        const resolvePendingRpcMessage = vi.fn();
        const clearPending = vi.fn();
        const reader = streamFromChunks([
            'event: endpoint\ndata: {"endpoint":',
            '"/messages"}\n\n',
            'event: mcp\ndata: {"jsonrpc":"2.0","id":7,',
            '"result":{"ok":true}}\n\n',
        ]).getReader();

        await readSseStream(conn, reader, 'http://localhost/sse', {
            resolvePendingRpcMessage,
            clearPending,
        });

        // readSseStream nulls conn._resolveSseEndpoint in its finally cleanup,
        // so assert against the captured spy reference rather than conn.
        expect(resolveSseEndpoint).toHaveBeenCalledWith('http://localhost/messages');
        expect(resolvePendingRpcMessage).toHaveBeenCalledWith({
            jsonrpc: '2.0',
            id: 7,
            result: { ok: true },
        });
        expect(clearPending).toHaveBeenCalledWith(expect.any(Error));
        expect(conn.initialized).toBe(false);
        expect(conn.transport).toBeNull();
        expect(conn.ssePostUrl).toBeNull();
    });

    it('clears the endpoint-handshake timer and resolver when the stream stops', async () => {
        const fakeTimer = { id: 42 };
        const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
        const conn = {
            _resolveSseEndpoint: vi.fn(),
            _sseEndpointTimer: fakeTimer,
            configKey: 'sse:key',
            initialized: true,
            sseAbort: {},
            ssePostUrl: null,
            transport: 'sse',
        };
        const reader = streamFromChunks(['event: endpoint\ndata: "/messages"\n\n']).getReader();

        await readSseStream(conn, reader, 'http://localhost/sse', {
            resolvePendingRpcMessage: vi.fn(),
            clearPending: vi.fn(),
        });

        // The 10s handshake timer must be cleared and the resolver nulled so a
        // dangling timeout can't fire against a resurrected conn.
        expect(clearTimeoutSpy).toHaveBeenCalledWith(fakeTimer);
        expect(conn._sseEndpointTimer).toBeNull();
        expect(conn._resolveSseEndpoint).toBeNull();
        clearTimeoutSpy.mockRestore();
    });
});
