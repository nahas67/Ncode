import { describe, expect, it } from 'vitest';
import {
    CONNECTION_STORAGE_KEYS,
    NCODE_DEFAULT_MCP_SERVER,
    NCODE_LOCAL_MCP_SERVER_ID,
    NCODE_LOCAL_MCP_SERVER_NAME,
    NCODE_LOCAL_MCP_URL,
    createConnectionSettingsPayload,
    createConnectionStorageUpdate,
    createDefaultMcpServer,
    createDefaultNcodeMcpServer,
    forceMergeNcodeDefaultServer,
    getConnectionProvider,
    getDefaultMcpUrlForTransport,
    getSelectedModelForProvider,
    normalizeNcodeMcpServers,
} from './connection.js';

const expectedLocalMcpServer = {
    id: NCODE_LOCAL_MCP_SERVER_ID,
    name: NCODE_LOCAL_MCP_SERVER_NAME,
    transport: 'streamable-http',
    url: NCODE_LOCAL_MCP_URL,
    enabled: true,
    autoConnect: true,
    headers: {},
    toolMode: 'all',
    enabledTools: [],
};

describe('connection settings helpers', () => {
    it('builds the default connection payload used by sidepanel restore messages', () => {
        expect(createConnectionSettingsPayload({})).toEqual({
            provider: 'web',
            useOfficialApi: false,
            selectedModel: '56fdd199312815e2',
            webThinkingLevel: 'minimal',
            webTemporaryChat: false,
            openaiSelectedModel: '',
            officialBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
            apiKey: '',
            officialModel: 'gemini-3.8-flash, gemini-3.5-flash-lite',
            thinkingLevel: 'low',
            officialWebSearch: false,
            openaiBaseUrl: '',
            openaiApiKey: '',
            openaiModel: '',
            openaiThinkingLevel: 'low',
            openaiUseResponsesApi: false,
            openaiWebSearch: false,
            dedicatedApiProviders: {
                openai_official: {
                    provider: 'openai_official',
                    baseUrl: 'https://api.openai.com/v1',
                    apiKey: '',
                    model: 'gpt-5.6-terra, gpt-5.6-sol, gpt-5.6-luna, gpt-6-astra',
                    selectedModel: '',
                    thinkingLevel: 'low',
                    webSearch: false,
                    providerRouting: '',
                },
                deepseek: {
                    provider: 'deepseek',
                    baseUrl: 'https://api.deepseek.com',
                    apiKey: '',
                    model: 'deepseek-v4-pro, deepseek-v4-flash, deepseek-reasoner, deepseek-chat',
                    selectedModel: '',
                    thinkingLevel: 'low',
                    webSearch: false,
                    providerRouting: '',
                },
                openrouter: {
                    provider: 'openrouter',
                    baseUrl: 'https://openrouter.ai/api/v1',
                    apiKey: '',
                    model: 'openai/gpt-5.6-terra, anthropic/claude-sonnet-5, deepseek/deepseek-v4-flash',
                    selectedModel: '',
                    thinkingLevel: 'low',
                    webSearch: false,
                    providerRouting: '',
                },
                dashscope: {
                    provider: 'dashscope',
                    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
                    apiKey: '',
                    model: 'qwen3.8-max, qwen3.8-flash-next, qwen3.7-max, qwen3-vl-plus, qwq-plus',
                    selectedModel: '',
                    thinkingLevel: 'low',
                    webSearch: false,
                    providerRouting: '',
                },
                anthropic: {
                    provider: 'anthropic',
                    baseUrl: 'https://api.anthropic.com/v1',
                    apiKey: '',
                    model: 'claude-sonnet-5, claude-opus-5, claude-fable-5-1, claude-haiku-4-5',
                    selectedModel: '',
                    thinkingLevel: 'low',
                    webSearch: false,
                    providerRouting: '',
                },
                zhipu: {
                    provider: 'zhipu',
                    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
                    apiKey: '',
                    model: 'glm-5.3, glm-5.2, glm-5.1, glm-5',
                    selectedModel: '',
                    thinkingLevel: 'low',
                    webSearch: false,
                    providerRouting: '',
                },
            },
            mcpEnabled: true,
            mcpTransport: 'streamable-http',
            mcpServerUrl: 'http://127.0.0.1:3001/mcp',
            mcpServers: [expectedLocalMcpServer],
            mcpActiveServerId: null,
        });
    });

    it('preserves OpenAI-specific selected model and legacy web-search fallback behavior', () => {
        const payload = createConnectionSettingsPayload(
            {
                geminiProvider: 'openai',
                geminiModel: 'gemini-3-flash',
                geminiOpenaiSelectedModel: 'gpt-5',
                geminiOpenaiModel: 'gpt-4.1, gpt-5',
                openaiWebSearchMode: 'chat',
            },
            { includeLegacyFallbacks: true }
        );

        expect(payload.provider).toBe('openai');
        expect(payload.selectedModel).toBe('gpt-5');
        expect(payload.openaiModel).toBe('gpt-4.1, gpt-5');
        expect(payload.openaiUseResponsesApi).toBe(false);
        expect(payload.openaiWebSearch).toBe(true);
    });

    it('normalizes provider and selected model fallback values', () => {
        expect(getConnectionProvider({ geminiUseOfficialApi: true })).toBe('official');
        expect(getConnectionProvider({})).toBe('web');
        expect(getSelectedModelForProvider({}, 'openai')).toBe('openai_custom');
        expect(getSelectedModelForProvider({}, 'deepseek')).toBe('deepseek-v4-pro');
        expect(getSelectedModelForProvider({}, 'web')).toBe('56fdd199312815e2');
    });

    it('declares the storage keys needed for connection restore', () => {
        expect(CONNECTION_STORAGE_KEYS).toContain('geminiProvider');
        expect(CONNECTION_STORAGE_KEYS).toContain('geminiModel');
        expect(CONNECTION_STORAGE_KEYS).toContain('geminiWebThinkingLevel');
        expect(CONNECTION_STORAGE_KEYS).toContain('geminiWebTemporaryChat');
        expect(CONNECTION_STORAGE_KEYS).toContain('geminiOpenaiSelectedModel');
        expect(CONNECTION_STORAGE_KEYS).toContain('geminiDeepseekApiKey');
        expect(CONNECTION_STORAGE_KEYS).toContain('geminiOpenrouterProviderRouting');
        expect(CONNECTION_STORAGE_KEYS).toContain('geminiDashscopeSelectedModel');
        expect(CONNECTION_STORAGE_KEYS).toContain('geminiAnthropicSelectedModel');
        expect(CONNECTION_STORAGE_KEYS).toContain('geminiMcpServers');
    });

    it('creates a shared storage update for connection saves', () => {
        expect(
            createConnectionStorageUpdate({
                provider: 'openai',
                webThinkingLevel: 'minimal',
                webTemporaryChat: true,
                openaiBaseUrl: 'https://api.example.test/v1',
                openaiApiKey: 'sk-test',
                openaiModel: 'gpt-5',
                openaiUseResponsesApi: true,
                openaiWebSearch: true,
                dedicatedApiProviders: {
                    deepseek: {
                        baseUrl: 'https://api.deepseek.com',
                        apiKey: 'deepseek-key',
                        model: 'deepseek-v4-pro',
                        selectedModel: 'deepseek-v4-pro',
                        thinkingLevel: 'high',
                    },
                },
                mcpEnabled: true,
                mcpServers: [{ id: 'srv', url: 'http://localhost/mcp' }],
                mcpActiveServerId: 'srv',
            })
        ).toEqual(
            expect.objectContaining({
                geminiProvider: 'openai',
                geminiUseOfficialApi: false,
                geminiWebThinkingLevel: 'minimal',
                geminiWebTemporaryChat: true,
                geminiOpenaiBaseUrl: 'https://api.example.test/v1',
                geminiOpenaiApiKey: 'sk-test',
                geminiOpenaiModel: 'gpt-5',
                geminiOpenaiUseResponsesApi: true,
                geminiOpenaiWebSearch: true,
                geminiDeepseekApiKey: 'deepseek-key',
                geminiDeepseekSelectedModel: 'deepseek-v4-pro',
                geminiDeepseekThinkingLevel: 'high',
                geminiMcpEnabled: true,
                geminiMcpTransport: 'streamable-http',
                geminiMcpServerUrl: 'http://127.0.0.1:3001/mcp',
                geminiMcpServers: [
                    expectedLocalMcpServer,
                    { id: 'srv', url: 'http://localhost/mcp' },
                ],
                geminiMcpActiveServerId: 'srv',
            })
        );
    });

    it('keeps an explicit mcpEnabled=false and does not duplicate the local server', () => {
        const update = createConnectionStorageUpdate({
            provider: 'web',
            mcpEnabled: false,
            mcpServers: [
                { id: 'srv-user', url: 'http://localhost:9000/mcp', enabled: true },
                { ...expectedLocalMcpServer, enabled: false, name: 'Old name' },
            ],
        });

        expect(update.geminiMcpEnabled).toBe(false);
        expect(update.geminiMcpServers).toEqual([
            { id: 'srv-user', url: 'http://localhost:9000/mcp', enabled: true },
            expectedLocalMcpServer,
        ]);
    });

    it('normalizes the built-in local MCP server to enabled streamable HTTP on 3001', () => {
        const servers = normalizeNcodeMcpServers([
            { id: 'srv-a', url: 'http://user-a/mcp', enabled: false },
            {
                id: NCODE_LOCAL_MCP_SERVER_ID,
                name: 'Ncode Local PC & Shell',
                transport: 'sse',
                url: 'http://127.0.0.1:3001/sse',
                enabled: false,
                toolMode: 'selected',
                enabledTools: ['pc_exec_shell'],
            },
            { id: 'srv-b', url: 'http://user-b/mcp' },
        ]);

        expect(servers.map((server) => server.id)).toEqual([
            'srv-a',
            NCODE_LOCAL_MCP_SERVER_ID,
            'srv-b',
        ]);
        expect(servers[1]).toEqual({
            ...expectedLocalMcpServer,
            toolMode: 'selected',
            enabledTools: ['pc_exec_shell'],
        });
        expect(servers[0]).toEqual({ id: 'srv-a', url: 'http://user-a/mcp', enabled: false });

        // Re-normalizing is idempotent and still appends nothing.
        expect(normalizeNcodeMcpServers(servers)).toEqual(servers);

        // An entry already pointing at the local URL is adopted, not duplicated.
        const adopted = normalizeNcodeMcpServers([
            { id: 'custom', url: 'http://127.0.0.1:3001/mcp/' },
        ]);
        expect(adopted).toEqual([expectedLocalMcpServer]);
    });

    it('creates the canonical Ncode default MCP server', () => {
        expect(createDefaultNcodeMcpServer()).toEqual(expectedLocalMcpServer);
        expect(createDefaultNcodeMcpServer({ enabled: false, name: 'x' })).toEqual(
            expectedLocalMcpServer
        );
    });

    it('creates default MCP server data and transport-specific URLs', () => {
        expect(createDefaultMcpServer('srv_test')).toEqual({
            id: 'srv_test',
            name: 'Ncode Local PC & Shell',
            transport: 'streamable-http',
            url: 'http://127.0.0.1:3001/mcp',
            headers: {},
            enabled: true,
            toolMode: 'all',
            enabledTools: [],
        });
        expect(getDefaultMcpUrlForTransport('ws')).toBe('ws://127.0.0.1:3001/mcp');
        expect(getDefaultMcpUrlForTransport('streamable-http')).toBe('http://127.0.0.1:3001/mcp');
        expect(getDefaultMcpUrlForTransport('sse')).toBe('http://127.0.0.1:3001/sse');
    });

    it('uses the shared readable ID factory for default MCP server IDs', () => {
        const server = createDefaultMcpServer();

        expect(server.id).toMatch(/^srv_[A-Z0-9-]+$/);
        expect(server.id).not.toMatch(/^srv_\d+$/);
    });
});

describe('forceMergeNcodeDefaultServer', () => {
    it('exposes the canonical built-in daemon server constant', () => {
        expect(NCODE_DEFAULT_MCP_SERVER).toEqual({
            id: NCODE_LOCAL_MCP_SERVER_ID,
            name: 'Ncode Local PC & Shell',
            transport: 'streamable-http',
            url: 'http://127.0.0.1:3001/mcp',
            enabled: true,
            autoConnect: true,
        });
        expect(Object.isFrozen(NCODE_DEFAULT_MCP_SERVER)).toBe(true);
    });

    it('adds an enabled built-in daemon when the saved list is empty or missing', () => {
        expect(forceMergeNcodeDefaultServer([])).toEqual([expectedLocalMcpServer]);
        expect(forceMergeNcodeDefaultServer(undefined)).toEqual([expectedLocalMcpServer]);
        expect(forceMergeNcodeDefaultServer(null)).toEqual([expectedLocalMcpServer]);
        expect(forceMergeNcodeDefaultServer('not-a-list')).toEqual([expectedLocalMcpServer]);
    });

    it('force-enables a disabled/stale saved daemon and preserves user servers', () => {
        const userServer = { id: 'srv-a', url: 'http://user-a/mcp', enabled: false };
        const merged = forceMergeNcodeDefaultServer([
            userServer,
            {
                id: NCODE_LOCAL_MCP_SERVER_ID,
                name: 'Renamed locally',
                transport: 'sse',
                url: 'http://127.0.0.1:3001/sse',
                enabled: false,
                autoConnect: false,
                toolMode: 'selected',
                enabledTools: ['pc_exec_shell'],
            },
            { id: 'srv-b', url: 'http://user-b/mcp' },
        ]);

        expect(merged.map((server) => server.id)).toEqual([
            'srv-a',
            NCODE_LOCAL_MCP_SERVER_ID,
            'srv-b',
        ]);
        expect(merged[1]).toEqual({
            ...expectedLocalMcpServer,
            toolMode: 'selected',
            enabledTools: ['pc_exec_shell'],
        });
        expect(merged[1].enabled).toBe(true);
        expect(merged[1].autoConnect).toBe(true);
        expect(merged[0]).toEqual(userServer);
    });

    it('collapses duplicate built-in entries (id or URL) into one', () => {
        const merged = forceMergeNcodeDefaultServer([
            { id: NCODE_LOCAL_MCP_SERVER_ID, url: NCODE_LOCAL_MCP_URL, enabled: false },
            { id: 'srv-x', url: 'http://x/mcp' },
            { id: 'custom', url: 'http://127.0.0.1:3001/mcp/' },
            {
                id: NCODE_LOCAL_MCP_SERVER_ID,
                transport: 'ws',
                url: 'ws://127.0.0.1:3001/mcp',
                enabled: true,
            },
        ]);

        expect(merged).toEqual([expectedLocalMcpServer, { id: 'srv-x', url: 'http://x/mcp' }]);
        expect(merged.filter((server) => server.id === NCODE_LOCAL_MCP_SERVER_ID)).toHaveLength(1);
    });

    it('is pure and idempotent', () => {
        const input = [
            { id: 'srv-a', url: 'http://user-a/mcp', headers: { Authorization: 'Bearer a' } },
            { id: NCODE_LOCAL_MCP_SERVER_ID, url: NCODE_LOCAL_MCP_URL, enabled: false },
        ];
        const snapshot = JSON.parse(JSON.stringify(input));

        const merged = forceMergeNcodeDefaultServer(input);
        expect(input).toEqual(snapshot);

        const mergedAgain = forceMergeNcodeDefaultServer(merged);
        expect(mergedAgain).toEqual(merged);
        expect(mergedAgain[0]).not.toBe(merged[0]);
    });
});
