import { describe, expect, it, vi } from 'vitest';

import {
    MCP_RECONNECT_FAILURE_TTL_MS,
    MCP_RECONNECT_MAX_DELAY_MS,
    createReconnectPolicy,
} from './reconnect_policy.js';

function createClock(start = 1000) {
    let current = start;
    return {
        now: () => current,
        advance(ms) {
            current += ms;
        },
    };
}

describe('createReconnectPolicy', () => {
    it('opens a short failure invalidation window then allows a retry', () => {
        const clock = createClock();
        const policy = createReconnectPolicy({ now: clock.now });
        const failure = policy.recordFailure('ncode_local_pc', new Error('daemon offline'));

        expect(failure.count).toBe(1);
        expect(failure.retryAt - failure.failedAt).toBe(MCP_RECONNECT_FAILURE_TTL_MS);
        expect(policy.getFailure('ncode_local_pc')?.error.message).toBe('daemon offline');
        expect(policy.isCoolingDown('ncode_local_pc')).toBe(true);

        clock.advance(MCP_RECONNECT_FAILURE_TTL_MS - 1);
        expect(policy.isCoolingDown('ncode_local_pc')).toBe(true);

        clock.advance(1);
        expect(policy.isCoolingDown('ncode_local_pc')).toBe(false);
    });

    it('backs off exponentially per server up to the max delay', () => {
        const clock = createClock();
        const policy = createReconnectPolicy({ now: clock.now });
        const delays = [];

        for (let attempt = 1; attempt <= 6; attempt++) {
            const failure = policy.recordFailure('ncode_local_pc', new Error(`fail-${attempt}`));
            delays.push(failure.retryAt - failure.failedAt);
            clock.advance(MCP_RECONNECT_MAX_DELAY_MS);
        }

        expect(delays).toEqual([5000, 10000, 20000, 30000, 30000, 30000]);
        expect(policy.getFailure('ncode_local_pc').count).toBe(6);
        expect(policy.getFailure('other-server')).toBeNull();
    });

    it('fails fast with the cached error while the invalidation window is open', async () => {
        const clock = createClock();
        const policy = createReconnectPolicy({ now: clock.now });
        const cachedError = new Error('daemon offline');
        policy.recordFailure('ncode_local_pc', cachedError);

        const connect = vi.fn(async () => ({}));
        const disconnect = vi.fn(async () => {});

        await expect(policy.execute('ncode_local_pc', {}, { connect, disconnect })).rejects.toBe(
            cachedError
        );
        expect(connect).not.toHaveBeenCalled();
        expect(disconnect).not.toHaveBeenCalled();
    });

    it('drops the stale connection and reconnects once the window expires', async () => {
        const clock = createClock();
        const policy = createReconnectPolicy({ now: clock.now });
        const connect = vi
            .fn()
            .mockRejectedValueOnce(new Error('daemon offline'))
            .mockResolvedValue({ id: 'fresh-connection' });
        const disconnect = vi.fn(async () => {});
        const use = vi.fn(async () => ['pc_exec_shell']);

        await expect(
            policy.execute('ncode_local_pc', {}, { connect, disconnect, use })
        ).rejects.toThrow('daemon offline');
        expect(policy.getFailure('ncode_local_pc').count).toBe(1);
        expect(disconnect).toHaveBeenCalledTimes(1);

        clock.advance(MCP_RECONNECT_FAILURE_TTL_MS);

        await expect(
            policy.execute('ncode_local_pc', {}, { connect, disconnect, use })
        ).resolves.toEqual(['pc_exec_shell']);
        expect(connect).toHaveBeenCalledTimes(2);
        expect(disconnect).toHaveBeenCalledTimes(2);
        expect(use).toHaveBeenCalledWith({ id: 'fresh-connection' });
        expect(policy.getFailure('ncode_local_pc')).toBeNull();
    });

    it('forceNewConnection bypasses an open invalidation window', async () => {
        const clock = createClock();
        const policy = createReconnectPolicy({ now: clock.now });
        policy.recordFailure('ncode_local_pc', new Error('daemon offline'));

        const connect = vi.fn(async () => ({ id: 'fresh-connection' }));
        const disconnect = vi.fn(async () => {});

        await expect(
            policy.execute('ncode_local_pc', { forceNewConnection: true }, { connect, disconnect })
        ).resolves.toEqual({ id: 'fresh-connection' });
        expect(connect).toHaveBeenCalledTimes(1);
        expect(disconnect).toHaveBeenCalledTimes(1);
    });

    it('records a failed operation and drops the connection for the next call', async () => {
        const clock = createClock();
        const policy = createReconnectPolicy({ now: clock.now });
        const connect = vi.fn(async () => ({ id: 'stale-connection' }));
        const disconnect = vi.fn(async () => {});
        const use = vi.fn(async () => {
            throw new Error('tools/list failed');
        });

        await expect(
            policy.execute('ncode_local_pc', {}, { connect, disconnect, use })
        ).rejects.toThrow('tools/list failed');

        expect(disconnect).toHaveBeenCalledTimes(1);
        expect(policy.getFailure('ncode_local_pc')?.error.message).toBe('tools/list failed');
        expect(policy.isCoolingDown('ncode_local_pc')).toBe(true);
    });

    it('keeps per-server state independent and invalidates on request', () => {
        const clock = createClock();
        const policy = createReconnectPolicy({ now: clock.now });
        policy.recordFailure('server-a', new Error('a offline'));
        policy.recordFailure('server-b', new Error('b offline'));

        policy.invalidate('server-a');
        expect(policy.getFailure('server-a')).toBeNull();
        expect(policy.getFailure('server-b')).not.toBeNull();

        policy.invalidate();
        expect(policy.getFailure('server-b')).toBeNull();
    });
});
