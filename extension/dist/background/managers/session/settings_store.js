import {
    DEFAULT_CONTEXT_MODE,
    DEFAULT_CONTEXT_RECENT_TURNS,
    DEFAULT_OFFICIAL_BASE_URL,
    DEFAULT_OFFICIAL_MODELS,
    DEFAULT_THINKING_LEVEL,
} from '../../../shared/config/constants.js';
import {
    forceMergeNcodeDefaultServer,
    getConnectionProvider,
    getOpenAIWebSearchStorageKeys,
    CONNECTION_STORAGE_KEYS,
} from '../../../shared/settings/connection.js';
import { normalizeWebThinkingLevel } from '../../../shared/models/web_thinking.js';
import { normalizeOpenAIWebSearchSettings } from '../../../shared/settings/openai.js';
import {
    createDedicatedApiSettingsPayload,
    isDedicatedApiProvider,
} from '../../../shared/settings/dedicated_providers.js';
import { debugLog } from '../../../shared/logging/debug.js';

const MCP_SERVERS_STORAGE_KEY = 'geminiMcpServers';

let pointerRotationQueue = Promise.resolve();

function normalizeProviderOverride(provider) {
    const normalized = String(provider || '').trim();
    return normalized === 'web' ||
        normalized === 'official' ||
        normalized === 'openai' ||
        isDedicatedApiProvider(normalized)
        ? normalized
        : null;
}

function mcpServerListsMatch(storedServers, mergedServers) {
    if (!Array.isArray(storedServers) || storedServers.length !== mergedServers.length) {
        return false;
    }
    try {
        return JSON.stringify(storedServers) === JSON.stringify(mergedServers);
    } catch {
        return false;
    }
}

async function syncNcodeDefaultMcpServer(rawServers) {
    const mergedServers = forceMergeNcodeDefaultServer(rawServers);
    if (mcpServerListsMatch(rawServers, mergedServers)) return mergedServers;

    try {
        await chrome.storage.local.set({ [MCP_SERVERS_STORAGE_KEY]: mergedServers });
    } catch (error) {
        console.warn('[Gemini Nexus] Failed to persist the built-in Ncode MCP server:', error);
    }
    return mergedServers;
}

/**
 * Force-merges the built-in Ncode local PC & shell MCP server into
 * chrome.storage.local and persists the merged list when it changed.
 *
 * PromptHandler calls this before every prompt run so a saved profile that
 * disabled, renamed or deleted the daemon (or whose entry points at another
 * transport/URL) is repaired without reloading the extension. The merge always
 * re-enables the daemon and keeps every user-configured server untouched.
 *
 * Never throws: a broken storage area must not block prompt execution.
 *
 * @returns {Promise<Array<object>>} the force-merged MCP server list
 */
export async function ensureNcodeDefaultMcpServer() {
    try {
        const stored = await chrome.storage.local.get([MCP_SERVERS_STORAGE_KEY]);
        return await syncNcodeDefaultMcpServer(stored?.[MCP_SERVERS_STORAGE_KEY]);
    } catch (error) {
        console.warn('[Gemini Nexus] Failed to read the built-in Ncode MCP server:', error);
        return forceMergeNcodeDefaultServer([]);
    }
}

export async function getConnectionSettings(options = {}) {
    let stored;
    let storageReadSucceeded = false;
    try {
        stored = await chrome.storage.local.get([
            ...CONNECTION_STORAGE_KEYS,
            'geminiApiKeyPointer',
            'geminiContextMode',
            'geminiContextRecentTurns',
        ]);
        storageReadSucceeded = true;
    } catch (error) {
        console.warn('[Gemini Nexus] Failed to read connection settings:', error);
        stored = {};
    }

    const provider = normalizeProviderOverride(options.provider) || getConnectionProvider(stored);

    let activeApiKey = stored.geminiApiKey || '';

    if (provider === 'official' && activeApiKey.includes(',')) {
        const apiKeys = activeApiKey
            .split(',')
            .map((apiKey) => apiKey.trim())
            .filter((apiKey) => apiKey);

        if (apiKeys.length > 0) {
            let pointer = stored.geminiApiKeyPointer || 0;

            if (typeof pointer !== 'number' || pointer >= apiKeys.length || pointer < 0) {
                pointer = 0;
            }

            activeApiKey = apiKeys[pointer];

            const nextPointer = (pointer + 1) % apiKeys.length;
            // Serialize pointer writes to avoid concurrent read-modify-write races
            const toWrite = nextPointer;
            const writeTask = pointerRotationQueue
                .then(() => chrome.storage.local.set({ geminiApiKeyPointer: toWrite }))
                .catch((error) => {
                    console.warn(
                        '[Gemini Nexus] Failed to persist Official API key rotation pointer:',
                        error
                    );
                });
            pointerRotationQueue = writeTask.catch(() => {});
            await writeTask.catch(() => {});

            debugLog(`[Gemini Nexus] Rotating Official API Key (Index: ${pointer})`);
        }
    } else {
        activeApiKey = activeApiKey.trim();
    }

    const openaiSettings = normalizeOpenAIWebSearchSettings(
        stored,
        getOpenAIWebSearchStorageKeys()
    );

    // Loading saved settings is the startup/restore read path: the built-in
    // local daemon server is force-merged+enabled and persisted right here so a
    // stale saved list cannot hide the PC shell from the first prompt.
    if (storageReadSucceeded) {
        await syncNcodeDefaultMcpServer(stored?.geminiMcpServers);
    }

    return {
        provider: provider,
        webThinkingLevel: normalizeWebThinkingLevel(stored.geminiWebThinkingLevel),
        webTemporaryChat: stored.geminiWebTemporaryChat === true,
        officialBaseUrl: stored.geminiOfficialBaseUrl || DEFAULT_OFFICIAL_BASE_URL,
        apiKey: activeApiKey,
        officialModel: stored.geminiOfficialModel || DEFAULT_OFFICIAL_MODELS,
        thinkingLevel: stored.geminiThinkingLevel || DEFAULT_THINKING_LEVEL,
        officialWebSearch: stored.geminiOfficialWebSearch === true,
        openaiBaseUrl: stored.geminiOpenaiBaseUrl || '',
        openaiApiKey: stored.geminiOpenaiApiKey || '',
        openaiModel: stored.geminiOpenaiModel || '',
        openaiThinkingLevel: stored.geminiOpenaiThinkingLevel || DEFAULT_THINKING_LEVEL,
        openaiUseResponsesApi: openaiSettings.useResponsesApi,
        openaiWebSearch: openaiSettings.webSearch,
        dedicatedApiProviders: createDedicatedApiSettingsPayload(stored),
        contextMode: stored.geminiContextMode || DEFAULT_CONTEXT_MODE,
        contextRecentTurns: stored.geminiContextRecentTurns || DEFAULT_CONTEXT_RECENT_TURNS,
    };
}

// MV3 service-worker start: background/index.js imports this module while
// booting the worker, so seed/repair the persisted built-in daemon server
// before the first prompt restores a saved profile. Best-effort and skipped
// outside the extension runtime (unit tests import the module without chrome).
if (typeof chrome !== 'undefined' && chrome?.storage?.local) {
    ensureNcodeDefaultMcpServer().catch((error) => {
        debugLog('[Gemini Nexus] Built-in Ncode MCP server startup sync failed:', error);
    });
}
