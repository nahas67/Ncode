// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sendToBackground } from '../../../../shared/messaging/index.js';
import { bindConnectionSectionEvents } from './connection_events.js';

vi.mock('../../../../shared/messaging/index.js', () => ({
    sendToBackground: vi.fn(),
}));

vi.mock('../../../core/i18n.js', () => ({
    t: (key) => key,
}));

function createSectionHarness() {
    const mcpTestConnection = document.createElement('button');
    const server = {
        id: 'srv-1',
        transport: 'sse',
        url: 'http://localhost/sse',
        headers: { Authorization: 'Bearer local' },
    };
    const section = {
        elements: {
            mcpTestConnection,
        },
        _getActiveServer: vi.fn(() => server),
        _saveCurrentServerEdits: vi.fn(() => true),
        setMcpTestStatus: vi.fn(),
    };

    return { mcpTestConnection, section, server };
}

function createModelRefreshHarness() {
    const providerSelect = document.createElement('select');
    providerSelect.innerHTML = '<option value="openrouter">OpenRouter</option>';
    providerSelect.value = 'openrouter';
    const dedicatedApiRefreshModels = document.createElement('button');
    const section = {
        activeProvider: 'openrouter',
        dedicatedApiProviders: {
            openrouter: {
                baseUrl: 'https://openrouter.ai/api/v1',
                apiKey: 'openrouter-key',
            },
        },
        elements: {
            providerSelect,
            dedicatedApiRefreshModels,
        },
        _saveDedicatedApiProviderEdits: vi.fn(),
        setProviderModelListStatus: vi.fn(),
    };

    return { dedicatedApiRefreshModels, section };
}

describe('bindConnectionSectionEvents', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('sends the active server when testing an MCP connection', () => {
        const { mcpTestConnection, section } = createSectionHarness();

        bindConnectionSectionEvents(section);
        mcpTestConnection.click();

        expect(section._saveCurrentServerEdits).toHaveBeenCalled();
        expect(section.setMcpTestStatus).toHaveBeenCalledWith('mcpTestingConnection');
        expect(sendToBackground).toHaveBeenCalledWith({
            action: 'MCP_TEST_CONNECTION',
            serverId: 'srv-1',
            transport: 'sse',
            url: 'http://localhost/sse',
            headers: { Authorization: 'Bearer local' },
        });
    });

    it('requests OpenRouter models through the dedicated provider model-list action', () => {
        const { dedicatedApiRefreshModels, section } = createModelRefreshHarness();

        bindConnectionSectionEvents(section);
        dedicatedApiRefreshModels.click();

        expect(section._saveDedicatedApiProviderEdits).toHaveBeenCalledWith('openrouter');
        expect(section.setProviderModelListStatus).toHaveBeenCalledWith('modelListFetching');
        expect(dedicatedApiRefreshModels.disabled).toBe(true);
        expect(sendToBackground).toHaveBeenCalledWith({
            action: 'GET_PROVIDER_MODELS',
            provider: 'openrouter',
            baseUrl: 'https://openrouter.ai/api/v1',
            apiKey: 'openrouter-key',
        });
    });
});
