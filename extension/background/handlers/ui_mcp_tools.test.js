import { describe, expect, it, vi } from 'vitest';
import { handleMcpListTools, handleMcpTestConnection } from './ui_mcp_tools.js';

function createManager() {
    return { listTools: vi.fn(async () => []) };
}

async function waitForResponse(sendResponse) {
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledTimes(1));
    return sendResponse.mock.calls[0][0];
}

describe('MCP tool loading input validation', () => {
    it('rejects non-http(s) URLs before any fetch', async () => {
        const mcpManager = createManager();
        const sendResponse = vi.fn();

        handleMcpTestConnection(mcpManager, { url: 'file:///etc/passwd' }, sendResponse);
        const response = await waitForResponse(sendResponse);

        expect(response).toMatchObject({ action: 'MCP_TEST_RESULT', ok: false });
        expect(response.error).toMatch(/http/i);
        expect(mcpManager.listTools).not.toHaveBeenCalled();
    });

    it('rejects malformed URLs before any fetch', async () => {
        const mcpManager = createManager();
        const sendResponse = vi.fn();

        handleMcpListTools(mcpManager, { url: 'not a url at all' }, sendResponse);
        const response = await waitForResponse(sendResponse);

        expect(response).toMatchObject({ action: 'MCP_TOOLS_RESULT', ok: false });
        expect(mcpManager.listTools).not.toHaveBeenCalled();
    });

    it('rejects unknown transports before any fetch', async () => {
        const mcpManager = createManager();
        const sendResponse = vi.fn();

        handleMcpTestConnection(
            mcpManager,
            { url: 'https://example.test/mcp', transport: 'gopher' },
            sendResponse
        );
        const response = await waitForResponse(sendResponse);

        expect(response).toMatchObject({ action: 'MCP_TEST_RESULT', ok: false });
        expect(response.error).toMatch(/transport/i);
        expect(mcpManager.listTools).not.toHaveBeenCalled();
    });

    it('strips prototype-polluting header keys', async () => {
        const mcpManager = createManager();
        const sendResponse = vi.fn();
        const headers = JSON.parse('{"__proto__":{"polluted":true},"X-Token":"abc"}');

        handleMcpTestConnection(
            mcpManager,
            { url: 'https://example.test/mcp', transport: 'sse', headers },
            sendResponse
        );
        const response = await waitForResponse(sendResponse);

        expect(response).toMatchObject({ action: 'MCP_TEST_RESULT', ok: true });
        expect(mcpManager.listTools).toHaveBeenCalledTimes(1);
        expect(mcpManager.listTools.mock.calls[0][0].mcpHeaders).toEqual({
            'X-Token': 'abc',
        });
        expect({}.polluted).toBeUndefined();
    });

    it('passes valid http(s) URLs and known transports through', async () => {
        const mcpManager = createManager();
        const sendResponse = vi.fn();

        handleMcpTestConnection(
            mcpManager,
            { url: 'http://127.0.0.1:3006/mcp', transport: 'streamable-http' },
            sendResponse
        );
        const response = await waitForResponse(sendResponse);

        expect(response).toMatchObject({ action: 'MCP_TEST_RESULT', ok: true });
        expect(mcpManager.listTools).toHaveBeenCalledWith(
            expect.objectContaining({
                mcpServerUrl: 'http://127.0.0.1:3006/mcp',
                mcpTransport: 'streamable-http',
            })
        );
    });
});
