import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ensureNcodeDefaultMcpServer, getConnectionSettings } from './settings_store.js';
import {
    NCODE_LOCAL_MCP_SERVER_ID,
    createDefaultNcodeMcpServer,
} from '../../../shared/settings/connection.js';

const canonicalLocalServer = createDefaultNcodeMcpServer();

function installChromeStorageMock(getStoredSettings) {
    globalThis.chrome = {
        storage: {
            local: {
                get: vi.fn(async () => getStoredSettings()),
                set: vi.fn(async () => {}),
            },
        },
    };
}

describe('getConnectionSettings', () => {
    let storedSettings;

    beforeEach(() => {
        storedSettings = {};
        globalThis.chrome = {
            storage: {
                local: {
                    get: vi.fn(async () => storedSettings),
                    set: vi.fn(async () => {}),
                },
            },
        };
    });

    afterEach(() => {
        delete globalThis.chrome;
        vi.restoreAllMocks();
    });

    it('rotates official API keys from the stored pointer and wraps to the first key', async () => {
        storedSettings = {
            geminiProvider: 'official',
            geminiApiKey: ' key-a, key-b, key-c ',
            geminiApiKeyPointer: 2,
        };

        const settings = await getConnectionSettings();

        expect(settings.apiKey).toBe('key-c');
        expect(chrome.storage.local.set).toHaveBeenCalledWith({ geminiApiKeyPointer: 0 });
    });

    it('resets an out-of-bounds official API key pointer before advancing it', async () => {
        storedSettings = {
            geminiProvider: 'official',
            geminiApiKey: 'key-a,key-b',
            geminiApiKeyPointer: 9,
        };

        const settings = await getConnectionSettings();

        expect(settings.apiKey).toBe('key-a');
        expect(chrome.storage.local.set).toHaveBeenCalledWith({ geminiApiKeyPointer: 1 });
    });

    it('continues with the selected official API key when pointer persistence fails', async () => {
        storedSettings = {
            geminiProvider: 'official',
            geminiApiKey: 'key-a,key-b',
            geminiApiKeyPointer: 0,
        };
        chrome.storage.local.set.mockRejectedValueOnce(new Error('Storage quota exceeded'));
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

        try {
            const settings = await getConnectionSettings();

            expect(settings.apiKey).toBe('key-a');
            expect(warnSpy).toHaveBeenCalledWith(
                '[Gemini Nexus] Failed to persist Official API key rotation pointer:',
                expect.any(Error)
            );
        } finally {
            warnSpy.mockRestore();
        }
    });

    it('restores Gemini Web thinking level with a fast default', async () => {
        storedSettings = {
            geminiProvider: 'web',
            geminiWebThinkingLevel: 'minimal',
        };

        await expect(getConnectionSettings()).resolves.toEqual(
            expect.objectContaining({
                provider: 'web',
                webThinkingLevel: 'minimal',
            })
        );

        storedSettings = { geminiProvider: 'web' };
        await expect(getConnectionSettings()).resolves.toEqual(
            expect.objectContaining({
                webThinkingLevel: 'minimal',
            })
        );
    });

    it('restores the Gemini Web temporary chat switch', async () => {
        storedSettings = {
            geminiProvider: 'web',
            geminiWebTemporaryChat: true,
        };

        await expect(getConnectionSettings()).resolves.toEqual(
            expect.objectContaining({
                provider: 'web',
                webTemporaryChat: true,
            })
        );

        storedSettings = { geminiProvider: 'web' };
        await expect(getConnectionSettings()).resolves.toEqual(
            expect.objectContaining({
                webTemporaryChat: false,
            })
        );
    });

    it('lets routed toolbar requests override the stored provider for one request', async () => {
        storedSettings = {
            geminiProvider: 'web',
            geminiOpenaiBaseUrl: 'https://api.x.ai/v1',
            geminiOpenaiApiKey: 'xai-key',
            geminiOpenaiModel: 'grok-4.3',
        };

        await expect(getConnectionSettings({ provider: 'openai' })).resolves.toEqual(
            expect.objectContaining({
                provider: 'openai',
                openaiBaseUrl: 'https://api.x.ai/v1',
                openaiApiKey: 'xai-key',
                openaiModel: 'grok-4.3',
            })
        );
    });

    it('restores dedicated provider credentials and allows provider overrides', async () => {
        storedSettings = {
            geminiProvider: 'web',
            geminiDeepseekApiKey: 'deepseek-key',
            geminiDeepseekModel: 'deepseek-v4-pro',
            geminiDeepseekThinkingLevel: 'high',
        };

        await expect(getConnectionSettings({ provider: 'deepseek' })).resolves.toEqual(
            expect.objectContaining({
                provider: 'deepseek',
                dedicatedApiProviders: expect.objectContaining({
                    deepseek: expect.objectContaining({
                        apiKey: 'deepseek-key',
                        model: 'deepseek-v4-pro',
                        thinkingLevel: 'high',
                    }),
                }),
            })
        );
    });

    it('returns safe defaults and does not throw when storage rejects', async () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        chrome.storage.local.get.mockRejectedValue(new Error('storage quota exceeded'));

        const settings = await getConnectionSettings();

        expect(settings.provider).toBe('web');
        expect(settings.openaiBaseUrl).toBe('');
        expect(settings.openaiApiKey).toBe('');
        expect(settings.openaiModel).toBe('');
        expect(warnSpy).toHaveBeenCalled();
        expect(chrome.storage.local.set).not.toHaveBeenCalled();
    });

    it('force-merges and persists the built-in daemon server while loading saved settings', async () => {
        storedSettings = {
            geminiProvider: 'web',
            geminiMcpServers: [
                { id: 'srv-user', url: 'http://localhost:9000/mcp', enabled: true },
                { ...createDefaultNcodeMcpServer(), enabled: false, transport: 'sse' },
            ],
        };

        const settings = await getConnectionSettings();

        expect(settings.provider).toBe('web');
        expect(chrome.storage.local.set).toHaveBeenCalledWith({
            geminiMcpServers: [
                { id: 'srv-user', url: 'http://localhost:9000/mcp', enabled: true },
                canonicalLocalServer,
            ],
        });
    });

    it('does not rewrite MCP servers when the saved list is already canonical', async () => {
        storedSettings = { geminiMcpServers: [canonicalLocalServer] };

        await getConnectionSettings();

        expect(chrome.storage.local.set).not.toHaveBeenCalled();
    });
});

describe('ensureNcodeDefaultMcpServer', () => {
    let storedSettings;

    beforeEach(() => {
        storedSettings = {};
        installChromeStorageMock(() => storedSettings);
    });

    afterEach(() => {
        delete globalThis.chrome;
        vi.restoreAllMocks();
    });

    it('persists the enabled built-in daemon on a fresh profile', async () => {
        const servers = await ensureNcodeDefaultMcpServer();

        expect(servers).toEqual([canonicalLocalServer]);
        expect(chrome.storage.local.set).toHaveBeenCalledWith({
            geminiMcpServers: [canonicalLocalServer],
        });
    });

    it('force-enables a disabled saved daemon entry and keeps user servers', async () => {
        storedSettings = {
            geminiMcpServers: [
                { id: 'srv-user', url: 'http://localhost:9000/mcp' },
                {
                    ...createDefaultNcodeMcpServer(),
                    enabled: false,
                    name: 'Renamed',
                    autoConnect: false,
                },
            ],
        };

        const servers = await ensureNcodeDefaultMcpServer();

        expect(servers.map((server) => server.id)).toEqual(['srv-user', NCODE_LOCAL_MCP_SERVER_ID]);
        expect(servers[1]).toEqual(canonicalLocalServer);
        expect(chrome.storage.local.set).toHaveBeenCalledWith({ geminiMcpServers: servers });
    });

    it('does not write when the saved list already contains the canonical daemon', async () => {
        storedSettings = { geminiMcpServers: [canonicalLocalServer] };

        const servers = await ensureNcodeDefaultMcpServer();

        expect(servers).toEqual([canonicalLocalServer]);
        expect(chrome.storage.local.set).not.toHaveBeenCalled();
    });

    it('returns the merged default and never throws when storage rejects', async () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        chrome.storage.local.get.mockRejectedValue(new Error('storage unavailable'));
        chrome.storage.local.set.mockRejectedValue(new Error('storage unavailable'));

        await expect(ensureNcodeDefaultMcpServer()).resolves.toEqual([canonicalLocalServer]);
        expect(warnSpy).toHaveBeenCalled();
    });

    it('survives a failed persist (quota) and still returns the merged list', async () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        chrome.storage.local.set.mockRejectedValue(new Error('Storage quota exceeded'));

        await expect(ensureNcodeDefaultMcpServer()).resolves.toEqual([canonicalLocalServer]);
        expect(warnSpy).toHaveBeenCalledWith(
            '[Gemini Nexus] Failed to persist the built-in Ncode MCP server:',
            expect.any(Error)
        );
    });
});

describe('service-worker startup MCP sync', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        delete globalThis.chrome;
        vi.resetModules();
        vi.restoreAllMocks();
    });

    it('seeds the enabled built-in daemon as soon as the module is imported', async () => {
        const storageGet = vi.fn(async () => ({}));
        const storageSet = vi.fn(async () => {});
        vi.stubGlobal('chrome', { storage: { local: { get: storageGet, set: storageSet } } });
        vi.resetModules();

        await import('./settings_store.js');

        await vi.waitFor(() => {
            expect(storageSet).toHaveBeenCalledWith({
                geminiMcpServers: [canonicalLocalServer],
            });
        });
    });
});
