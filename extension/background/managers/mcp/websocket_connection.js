import { asWsUrl, hasHeaders } from './transport.js';

export async function ensureWebSocketConnected({
    conn,
    serverId,
    url,
    normalizedHeaders,
    disconnectState,
    initializeHandshake,
    bumpIdleClose,
    clearPending,
    onRpcMessage,
}) {
    if (hasHeaders(normalizedHeaders)) {
        throw new Error(
            'Custom MCP headers are not supported for WebSocket transport in browser extensions. Use SSE or Streamable HTTP.'
        );
    }

    const wsUrl = asWsUrl(url);
    if (!wsUrl) throw new Error('Invalid MCP server URL');
    const key = `ws:${wsUrl}`;

    if (
        conn.ws &&
        conn.ws.readyState === WebSocket.OPEN &&
        conn.initialized &&
        conn.configKey === key
    ) {
        bumpIdleClose(conn, serverId);
        return conn;
    }

    disconnectState(conn);
    conn.configKey = key;
    conn.transport = 'ws';
    conn.headers = {};

    // Detach listeners from any prior socket so a late close/error on the
    // old socket cannot tear down the shared conn state of the new socket.
    if (conn._wsListeners && conn.ws) {
        detachWsListeners(conn.ws, conn._wsListeners);
    }
    conn._wsListeners = null;

    await new Promise((resolve, reject) => {
        const ws = new WebSocket(wsUrl);
        conn.ws = ws;
        let opened = false;
        let settled = false;
        const safeResolve = () => {
            if (settled) return;
            settled = true;
            clearTimeout(connectTimer);
            resolve();
        };
        const safeReject = (err) => {
            if (settled) return;
            settled = true;
            clearTimeout(connectTimer);
            reject(err);
        };
        const connectTimer = setTimeout(() => {
            if (!opened) {
                try {
                    ws.close();
                } catch {}
                safeReject(new Error(`MCP WebSocket connect timeout: ${wsUrl}`));
            }
        }, 10000);

        const onOpen = () => {
            opened = true;
            safeResolve();
        };
        const onError = () => {
            if (!opened) safeReject(new Error(`Failed to connect to MCP WebSocket: ${wsUrl}`));
        };
        const onClose = () => {
            // Only act if this socket is still the active one; otherwise the
            // close belongs to a superseded connection and must be ignored.
            if (conn.ws !== ws) return;

            const error = new Error(`MCP WebSocket closed: ${wsUrl}`);
            clearPending(conn, error);
            detachWsListeners(ws, listeners);
            conn.ws = null;
            conn.initialized = false;
            conn.configKey = null;
            conn.transport = null;
            if (!opened) safeReject(error);
        };
        const onMessage = (event) => {
            if (conn.ws !== ws) return;
            try {
                onRpcMessage(conn, JSON.parse(event.data));
            } catch {
                // 静默降级:非 JSON 或畸形消息无法解析为 RPC,丢弃
            }
        };

        const listeners = { open: onOpen, error: onError, close: onClose, message: onMessage };
        attachWsListeners(ws, listeners);
        conn._wsListeners = listeners;
    });

    await initializeHandshake(conn);
    bumpIdleClose(conn, serverId);
    return conn;
}

function attachWsListeners(ws, listeners) {
    ws.addEventListener('open', listeners.open);
    ws.addEventListener('error', listeners.error);
    ws.addEventListener('close', listeners.close);
    ws.addEventListener('message', listeners.message);
}

function detachWsListeners(ws, listeners) {
    if (!ws || !listeners) return;
    ws.removeEventListener('open', listeners.open);
    ws.removeEventListener('error', listeners.error);
    ws.removeEventListener('close', listeners.close);
    ws.removeEventListener('message', listeners.message);
}
