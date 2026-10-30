// Per-server reconnect policy for the MCP manager.
//
// The local PC & shell daemon may be started long after Chrome, so a failed
// connection attempt must never be cached forever: the first failure opens a
// short invalidation window (the TTL), repeated failures back off exponentially
// per server, and the next call after the window drops the stale connection and
// dials again. Explicit reconnects bypass the window.

export const MCP_RECONNECT_FAILURE_TTL_MS = 5000;
export const MCP_RECONNECT_MAX_DELAY_MS = 30000;

export function createReconnectPolicy({
    failureTtlMs = MCP_RECONNECT_FAILURE_TTL_MS,
    maxDelayMs = MCP_RECONNECT_MAX_DELAY_MS,
    now = () => Date.now(),
} = {}) {
    const failures = new Map();

    function getRetryDelay(failureCount) {
        const exponent = Math.max(0, failureCount - 1);
        const delayMs = failureTtlMs * 2 ** exponent;
        return Math.min(delayMs, Math.max(maxDelayMs, failureTtlMs));
    }

    function getFailure(serverId) {
        return failures.get(serverId) || null;
    }

    function invalidate(serverId) {
        if (serverId) failures.delete(serverId);
        else failures.clear();
    }

    function recordFailure(serverId, error) {
        const previous = failures.get(serverId);
        const count = (previous?.count || 0) + 1;
        const failedAt = now();
        const failure = {
            count,
            error: error || new Error(`MCP server ${serverId} connection failed`),
            failedAt,
            retryAt: failedAt + getRetryDelay(count),
        };
        failures.set(serverId, failure);
        return failure;
    }

    function isCoolingDown(serverId) {
        const failure = failures.get(serverId);
        return Boolean(failure && failure.retryAt > now());
    }

    async function disconnectQuietly(operations) {
        try {
            await operations.disconnect();
        } catch {
            // The stale connection state is already unusable; dropping the
            // reference matters more than a disconnect failure here.
        }
    }

    /**
     * Runs one connection + operation sequence under the policy.
     *
     * - A failure recorded less than the TTL ago fails fast with the cached
     *   error instead of retrying (avoids a 6-version handshake per prompt).
     * - Once the window elapsed (or with `forceNewConnection`) the cached
     *   connection is dropped before dialing, so a daemon that came up later is
     *   picked up without an extension reload.
     * - A connect or operation failure records/backoff-increments the server's
     *   failure state and disconnects, so the next call starts from scratch.
     *
     * @param {string} serverId
     * @param {{ forceNewConnection?: boolean }} [options]
     * @param {{ connect: () => Promise<object>, disconnect: () => Promise<void>, use?: (conn: object) => Promise<unknown> }} operations
     * @returns {Promise<unknown>}
     */
    async function execute(serverId, options, operations) {
        const failure = failures.get(serverId);
        const forceNewConnection = options?.forceNewConnection === true;

        if (failure && !forceNewConnection && failure.retryAt > now()) {
            throw failure.error;
        }

        if (failure || forceNewConnection) {
            failures.delete(serverId);
            await disconnectQuietly(operations);
        }

        let conn;
        try {
            conn = await operations.connect();
        } catch (error) {
            failures.delete(serverId);
            recordFailure(serverId, error);
            await disconnectQuietly(operations);
            throw error;
        }

        try {
            return operations.use ? await operations.use(conn) : conn;
        } catch (error) {
            // A cached connection can outlive the daemon process; drop the
            // stale state so the next call redials instead of reusing it.
            failures.delete(serverId);
            recordFailure(serverId, error);
            await disconnectQuietly(operations);
            throw error;
        }
    }

    return { execute, recordFailure, invalidate, getFailure, isCoolingDown };
}
