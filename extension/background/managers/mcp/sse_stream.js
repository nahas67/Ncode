export async function readSseStream(
    conn,
    reader,
    baseUrl,
    { resolvePendingRpcMessage, clearPending }
) {
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let eventType = 'message';
    let dataLines = [];

    const dispatch = () => {
        const eventData = dataLines.join('\n');
        const type = eventType || 'message';
        eventType = 'message';
        dataLines = [];

        const payload = eventData.trim();
        if (!payload) return;

        if (type === 'endpoint') {
            let endpoint = payload;
            try {
                const parsed = JSON.parse(payload);
                if (parsed && typeof parsed === 'object' && typeof parsed.endpoint === 'string') {
                    endpoint = parsed.endpoint;
                }
            } catch {
                // 静默降级:endpoint 不是合法 JSON 时回退到原始字符串
            }

            try {
                const url = new URL(endpoint, baseUrl).toString();
                if (!conn.ssePostUrl) {
                    conn.ssePostUrl = url;
                    if (conn._resolveSseEndpoint) conn._resolveSseEndpoint(url);
                }
            } catch {
                // 静默降级:URL 构造失败(endpoint 无效时)忽略该 endpoint 事件
            }
            return;
        }

        if (type === 'message' || type === 'mcp' || type === 'data') {
            try {
                const rpcMessage = JSON.parse(payload);
                resolvePendingRpcMessage(rpcMessage);
            } catch {
                // 静默降级:非 JSON 消息(如心跳/注释)无法解析为 RPC,直接丢弃
            }
        }
    };

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            let lineBreakIndex;
            while ((lineBreakIndex = buffer.indexOf('\n')) !== -1) {
                const line = buffer.slice(0, lineBreakIndex);
                buffer = buffer.slice(lineBreakIndex + 1);
                const trimmed = line.replace(/\r$/, '');

                if (trimmed === '') {
                    dispatch();
                    continue;
                }
                if (trimmed.startsWith(':')) continue;
                if (trimmed.startsWith('event:')) {
                    eventType = trimmed.slice('event:'.length).trim() || 'message';
                    continue;
                }
                if (trimmed.startsWith('data:')) {
                    dataLines.push(trimmed.slice('data:'.length).trimStart());
                }
            }
        }
    } finally {
        try {
            reader.releaseLock();
        } catch {
            // 静默降级:reader 释放失败时流已结束或被其他代码释放,无需处理
        }
        clearPending(new Error('MCP SSE stream closed'));
        conn.initialized = false;
        conn.transport = null;
        conn.configKey = null;
        conn.sseAbort = null;
        conn.ssePostUrl = null;
        // Tear down any pending endpoint-handshake timer/resolver so a stopped
        // reader doesn't leave a dangling 10s timeout on the conn.
        if (conn._sseEndpointTimer) {
            clearTimeout(conn._sseEndpointTimer);
            conn._sseEndpointTimer = null;
        }
        conn._resolveSseEndpoint = null;
    }
}
