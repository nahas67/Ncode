// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import { ConnectionSection, createMcpServerId } from './connection.js';

function createConnectionSectionHarness() {
    const summary = document.createElement('div');
    const list = document.createElement('div');
    const search = document.createElement('input');
    const section = Object.create(ConnectionSection.prototype);

    section.elements = {
        mcpToolsSummary: summary,
        mcpToolList: list,
        mcpToolSearch: search,
    };
    section.mcpServers = [
        {
            id: 'srv-1',
            name: 'Local',
            transport: 'sse',
            url: 'http://127.0.0.1:3006/new-sse',
            headers: {},
            enabled: true,
            toolMode: 'selected',
            enabledTools: [],
        },
    ];
    section.mcpActiveServerId = 'srv-1';
    section.mcpToolsCache = new Map();
    section.mcpToolsUiState = new Map();

    return { list, section, summary };
}

describe('ConnectionSection MCP tool cache', () => {
    it('creates readable unique MCP server ids', () => {
        const id = createMcpServerId();

        expect(id).toMatch(/^srv_[0-9A-F-]{8,}$/);
        expect(createMcpServerId()).not.toBe(id);
    });

    it('does not show a stale tool-list response after the server URL changed', () => {
        const { list, section, summary } = createConnectionSectionHarness();

        section.setMcpToolsList('srv-1', 'sse', 'http://127.0.0.1:3006/old-sse', [
            { name: 'old.tool', description: 'From the old endpoint' },
        ]);

        expect(summary.textContent).toBe(
            'No tool list loaded. Click "Refresh Tools" to load tools, then select which to expose.'
        );
        expect(list.textContent).not.toContain('old.tool');
    });
});

describe('ConnectionSection provider visibility', () => {
    it('toggles provider panels with hidden attributes', () => {
        const section = Object.create(ConnectionSection.prototype);
        section.elements = {
            apiKeyContainer: document.createElement('div'),
            webFields: document.createElement('div'),
            officialFields: document.createElement('div'),
            openaiFields: document.createElement('div'),
            dedicatedApiFields: document.createElement('div'),
        };

        section.updateVisibility('official');

        expect(section.elements.webFields.hidden).toBe(true);
        expect(section.elements.apiKeyContainer.hidden).toBe(false);
        expect(section.elements.officialFields.hidden).toBe(false);
        expect(section.elements.openaiFields.hidden).toBe(true);
        expect(section.elements.dedicatedApiFields.hidden).toBe(true);
        expect(section.elements.apiKeyContainer.style.display).toBe('');

        section.updateVisibility('web');

        expect(section.elements.webFields.hidden).toBe(false);
        expect(section.elements.apiKeyContainer.hidden).toBe(true);
    });

    it('loads dedicated provider defaults into the shared dedicated API form', () => {
        const section = Object.create(ConnectionSection.prototype);
        section.dedicatedApiProviders = {
            deepseek: {
                provider: 'deepseek',
                baseUrl: 'https://api.deepseek.com',
                apiKey: 'deepseek-key',
                model: 'deepseek-v4-pro',
                thinkingLevel: 'high',
            },
        };
        section.elements = {
            apiKeyContainer: document.createElement('div'),
            webFields: document.createElement('div'),
            officialFields: document.createElement('div'),
            openaiFields: document.createElement('div'),
            dedicatedApiFields: document.createElement('div'),
            dedicatedApiBaseUrl: document.createElement('input'),
            dedicatedApiKey: document.createElement('input'),
            dedicatedApiModel: document.createElement('input'),
            dedicatedApiRefreshModels: document.createElement('button'),
            dedicatedApiModelListStatus: document.createElement('div'),
            dedicatedApiThinkingLevel: document.createElement('select'),
            dedicatedApiWebSearchRow: document.createElement('div'),
            dedicatedApiWebSearch: document.createElement('input'),
            dedicatedApiProviderRoutingRow: document.createElement('div'),
            dedicatedApiProviderRouting: document.createElement('textarea'),
        };
        section.elements.dedicatedApiThinkingLevel.innerHTML =
            '<option value="low">Low</option><option value="high">High</option>';

        section.updateVisibility('deepseek');

        expect(section.elements.dedicatedApiFields.hidden).toBe(false);
        expect(section.elements.dedicatedApiKey.value).toBe('deepseek-key');
        expect(section.elements.dedicatedApiModel.value).toBe('deepseek-v4-pro');
        expect(section.elements.dedicatedApiThinkingLevel.value).toBe('high');
        expect(section.elements.dedicatedApiRefreshModels.hidden).toBe(true);
        expect(section.elements.dedicatedApiWebSearchRow.hidden).toBe(true);
        expect(section.elements.dedicatedApiProviderRoutingRow.hidden).toBe(true);
    });

    it('shows OpenRouter provider routing JSON in the dedicated API form', () => {
        const section = Object.create(ConnectionSection.prototype);
        section.dedicatedApiProviders = {
            openrouter: {
                provider: 'openrouter',
                baseUrl: 'https://openrouter.ai/api/v1',
                apiKey: 'openrouter-key',
                model: 'openai/gpt-5.2',
                thinkingLevel: 'medium',
                providerRouting: '{"order":["openai"]}',
            },
        };
        section.elements = {
            apiKeyContainer: document.createElement('div'),
            webFields: document.createElement('div'),
            officialFields: document.createElement('div'),
            openaiFields: document.createElement('div'),
            dedicatedApiFields: document.createElement('div'),
            dedicatedApiBaseUrl: document.createElement('input'),
            dedicatedApiKey: document.createElement('input'),
            dedicatedApiModel: document.createElement('input'),
            dedicatedApiRefreshModels: document.createElement('button'),
            dedicatedApiModelListStatus: document.createElement('div'),
            dedicatedApiThinkingLevel: document.createElement('select'),
            dedicatedApiWebSearchRow: document.createElement('div'),
            dedicatedApiWebSearch: document.createElement('input'),
            dedicatedApiProviderRoutingRow: document.createElement('div'),
            dedicatedApiProviderRouting: document.createElement('textarea'),
        };
        section.elements.dedicatedApiThinkingLevel.innerHTML =
            '<option value="low">Low</option><option value="medium">Medium</option>';

        section.updateVisibility('openrouter');

        expect(section.elements.dedicatedApiProviderRoutingRow.hidden).toBe(false);
        expect(section.elements.dedicatedApiRefreshModels.hidden).toBe(false);
        expect(section.elements.dedicatedApiProviderRouting.value).toBe('{"order":["openai"]}');
    });

    it('applies refreshed provider models to the active dedicated API form', () => {
        const section = Object.create(ConnectionSection.prototype);
        section.activeProvider = 'openrouter';
        section.dedicatedApiProviders = {
            openrouter: {
                provider: 'openrouter',
                selectedModel: 'missing-model',
            },
        };
        section.elements = {
            dedicatedApiModel: document.createElement('input'),
            dedicatedApiRefreshModels: document.createElement('button'),
            dedicatedApiModelListStatus: document.createElement('div'),
        };

        section.setProviderModelList('openrouter', ['openai/gpt-5.2', 'anthropic/claude']);

        expect(section.elements.dedicatedApiModel.value).toBe('openai/gpt-5.2, anthropic/claude');
        expect(section.dedicatedApiProviders.openrouter).toEqual(
            expect.objectContaining({
                model: 'openai/gpt-5.2, anthropic/claude',
                selectedModel: '',
            })
        );
        expect(section.elements.dedicatedApiModelListStatus.textContent).toBe('Loaded 2 models.');
    });

    it('restores and reads the Gemini Web temporary chat checkbox', () => {
        const section = Object.create(ConnectionSection.prototype);
        const providerSelect = document.createElement('select');
        providerSelect.innerHTML = '<option value="web">Web</option>';
        const webTemporaryChat = document.createElement('input');
        webTemporaryChat.type = 'checkbox';
        section.elements = {
            providerSelect,
            webTemporaryChat,
        };
        section.mcpServers = [];
        section.mcpActiveServerId = null;
        section.updateVisibility = () => {};
        section._renderMcpServerOptions = () => {};
        section._loadActiveServerIntoForm = () => {};
        section.setMcpTestStatus = () => {};
        section._saveCurrentServerEdits = () => {};

        section.setData({ provider: 'web', webTemporaryChat: true });

        expect(webTemporaryChat.checked).toBe(true);
        expect(section.getData()).toMatchObject({
            provider: 'web',
            webTemporaryChat: true,
        });
    });

    it('toggles MCP settings with a hidden attribute', () => {
        const section = Object.create(ConnectionSection.prototype);
        section.elements = {
            mcpFields: document.createElement('div'),
        };

        section.updateMcpVisibility(true);

        expect(section.elements.mcpFields.hidden).toBe(false);
        expect(section.elements.mcpFields.style.display).toBe('');

        section.updateMcpVisibility(false);

        expect(section.elements.mcpFields.hidden).toBe(true);
    });

    it('uses a class for MCP test error state', () => {
        const status = document.createElement('div');
        const section = Object.create(ConnectionSection.prototype);
        section.elements = {
            mcpTestStatus: status,
        };

        section.setMcpTestStatus('Cannot connect', true);

        expect(status.textContent).toBe('Cannot connect');
        expect(status.classList.contains('is-error')).toBe(true);
        expect(status.hasAttribute('style')).toBe(false);

        section.setMcpTestStatus('Connected', false);

        expect(status.classList.contains('is-error')).toBe(false);
        expect(status.hasAttribute('style')).toBe(false);
    });
});
