import {
    DEFAULT_MCP_HTTP_URL,
    DEFAULT_MCP_SSE_URL,
    DEFAULT_MCP_TRANSPORT,
    DEFAULT_MCP_WS_URL,
    DEFAULT_OFFICIAL_BASE_URL,
    DEFAULT_OFFICIAL_MODELS,
    DEFAULT_OPENAI_MODEL,
    DEFAULT_PROVIDER,
    DEFAULT_STORED_GEMINI_MODEL,
    DEFAULT_THINKING_LEVEL,
} from '../config/constants.js';
import { createPrefixedId } from '../utils/index.js';
import { normalizeWebThinkingLevel } from '../models/web_thinking.js';
import { normalizeOpenAIWebSearchSettings } from './openai.js';
import {
    DEDICATED_API_STORAGE_KEYS,
    createDedicatedApiSettingsPayload,
    createDedicatedApiStorageUpdate,
    getDedicatedApiSelectedModel,
    isDedicatedApiProvider,
} from './dedicated_providers.js';

// Ncode's built-in local PC & shell MCP daemon (zero-dependency, ships with the
// repo). Unlike user-configured servers it is always present and enabled so the
// agent can drive the host machine and read/write workflow checkpoints.
//
// The settings id is the canonical `ncode-pc-daemon` (same name the daemon
// advertises over MCP). Tool ids are namespaced as `<serverId>__<toolName>`, so
// this id also prefixes the checkpoint tool:
// `ncode-pc-daemon__workflow_save_checkpoint`.
//
// Earlier Ncode builds persisted the settings id `ncode_local_pc`; the merge
// below recognises that legacy id by its 127.0.0.1:3001 URL and rewrites it to
// the canonical entry, so older profiles migrate without losing user servers.
export const NCODE_LOCAL_MCP_SERVER_ID = 'ncode-pc-daemon';
export const NCODE_LEGACY_LOCAL_MCP_SERVER_ID = 'ncode_local_pc';
export const NCODE_LOCAL_MCP_SERVER_NAME = 'Ncode Local PC & Shell';
export const NCODE_LOCAL_MCP_URL = 'http://127.0.0.1:3001/mcp';
const NCODE_LOCAL_MCP_TRANSPORT = 'streamable-http';

/**
 * Canonical built-in local PC & shell MCP server entry.
 *
 * `enabled` + `autoConnect` are always true: a saved/edited/stale entry can
 * never opt the built-in daemon out of the settings payload, and the MCP
 * manager reconnects it automatically once the daemon starts listening.
 */
export const NCODE_DEFAULT_MCP_SERVER = Object.freeze({
    id: NCODE_LOCAL_MCP_SERVER_ID,
    name: NCODE_LOCAL_MCP_SERVER_NAME,
    transport: NCODE_LOCAL_MCP_TRANSPORT,
    url: NCODE_LOCAL_MCP_URL,
    enabled: true,
    autoConnect: true,
});

export const CONNECTION_STORAGE_KEYS = [
    'geminiProvider',
    'geminiUseOfficialApi',
    'geminiModel',
    'geminiWebThinkingLevel',
    'geminiWebTemporaryChat',
    'geminiOfficialBaseUrl',
    'geminiApiKey',
    'geminiOfficialModel',
    'geminiThinkingLevel',
    'geminiOfficialWebSearch',
    'geminiOpenaiBaseUrl',
    'geminiOpenaiApiKey',
    'geminiOpenaiModel',
    'geminiOpenaiSelectedModel',
    'geminiOpenaiThinkingLevel',
    'geminiOpenaiUseResponsesApi',
    'geminiOpenaiWebSearchMode',
    'geminiOpenaiWebSearch',
    'geminiMcpEnabled',
    'geminiMcpTransport',
    'geminiMcpServerUrl',
    'geminiMcpServers',
    'geminiMcpActiveServerId',
    ...DEDICATED_API_STORAGE_KEYS,
];

const GEMINI_OPENAI_WEB_SEARCH_KEYS = {
    useResponsesApiKey: 'geminiOpenaiUseResponsesApi',
    webSearchKey: 'geminiOpenaiWebSearch',
    webSearchModeKey: 'geminiOpenaiWebSearchMode',
};

const LEGACY_OPENAI_WEB_SEARCH_KEYS = {
    fallbackUseResponsesApiKey: 'openaiUseResponsesApi',
    fallbackWebSearchKey: 'openaiWebSearch',
    fallbackWebSearchModeKey: 'openaiWebSearchMode',
};

export function getOpenAIWebSearchStorageKeys({ includeLegacyFallbacks = false } = {}) {
    return includeLegacyFallbacks
        ? { ...GEMINI_OPENAI_WEB_SEARCH_KEYS, ...LEGACY_OPENAI_WEB_SEARCH_KEYS }
        : GEMINI_OPENAI_WEB_SEARCH_KEYS;
}

export function getConnectionProvider(storageData = {}) {
    return (
        storageData.geminiProvider ||
        (storageData.geminiUseOfficialApi === true ? 'official' : DEFAULT_PROVIDER)
    );
}

export function getSelectedModelForProvider(
    storageData = {},
    provider = getConnectionProvider(storageData)
) {
    if (provider === 'openai') {
        return (
            storageData.geminiOpenaiSelectedModel || storageData.geminiModel || DEFAULT_OPENAI_MODEL
        );
    }

    if (isDedicatedApiProvider(provider)) {
        return getDedicatedApiSelectedModel(storageData, provider);
    }

    return storageData.geminiModel || DEFAULT_STORED_GEMINI_MODEL;
}

export function createConnectionSettingsPayload(storageData = {}, options = {}) {
    const provider = getConnectionProvider(storageData);
    const selectedModel = getSelectedModelForProvider(storageData, provider);
    const openaiSettings = normalizeOpenAIWebSearchSettings(
        storageData,
        getOpenAIWebSearchStorageKeys(options)
    );

    return {
        provider,
        useOfficialApi: storageData.geminiUseOfficialApi === true,
        selectedModel,
        webThinkingLevel: normalizeWebThinkingLevel(storageData.geminiWebThinkingLevel),
        webTemporaryChat: storageData.geminiWebTemporaryChat === true,
        openaiSelectedModel: storageData.geminiOpenaiSelectedModel || '',
        officialBaseUrl: storageData.geminiOfficialBaseUrl || DEFAULT_OFFICIAL_BASE_URL,
        apiKey: storageData.geminiApiKey || '',
        officialModel: storageData.geminiOfficialModel || DEFAULT_OFFICIAL_MODELS,
        thinkingLevel: storageData.geminiThinkingLevel || DEFAULT_THINKING_LEVEL,
        officialWebSearch: storageData.geminiOfficialWebSearch === true,
        openaiBaseUrl: storageData.geminiOpenaiBaseUrl || '',
        openaiApiKey: storageData.geminiOpenaiApiKey || '',
        openaiModel: storageData.geminiOpenaiModel || '',
        openaiThinkingLevel: storageData.geminiOpenaiThinkingLevel || DEFAULT_THINKING_LEVEL,
        openaiUseResponsesApi: openaiSettings.useResponsesApi,
        openaiWebSearch: openaiSettings.webSearch,
        dedicatedApiProviders: createDedicatedApiSettingsPayload(storageData),
        // A fresh install has MCP enabled: the Ncode local PC & shell daemon is
        // the primary tool surface, so only an explicit `false` disables it.
        mcpEnabled: storageData.geminiMcpEnabled !== false,
        mcpTransport: storageData.geminiMcpTransport || DEFAULT_MCP_TRANSPORT,
        mcpServerUrl: storageData.geminiMcpServerUrl || DEFAULT_MCP_HTTP_URL,
        mcpServers: normalizeNcodeMcpServers(storageData.geminiMcpServers),
        mcpActiveServerId: storageData.geminiMcpActiveServerId || null,
    };
}

export function createConnectionStorageUpdate(payload = {}) {
    return {
        geminiProvider: payload.provider,
        geminiUseOfficialApi: payload.provider === 'official',
        geminiWebThinkingLevel: normalizeWebThinkingLevel(payload.webThinkingLevel),
        geminiWebTemporaryChat: payload.webTemporaryChat === true,
        geminiOfficialBaseUrl: payload.officialBaseUrl || DEFAULT_OFFICIAL_BASE_URL,
        geminiApiKey: payload.apiKey || '',
        geminiOfficialModel: payload.officialModel || DEFAULT_OFFICIAL_MODELS,
        geminiThinkingLevel: payload.thinkingLevel || DEFAULT_THINKING_LEVEL,
        geminiOfficialWebSearch: payload.officialWebSearch === true,
        geminiOpenaiBaseUrl: payload.openaiBaseUrl || '',
        geminiOpenaiApiKey: payload.openaiApiKey || '',
        geminiOpenaiModel: payload.openaiModel || '',
        geminiOpenaiThinkingLevel: payload.openaiThinkingLevel || DEFAULT_THINKING_LEVEL,
        geminiOpenaiUseResponsesApi: payload.openaiUseResponsesApi === true,
        geminiOpenaiWebSearch: payload.openaiWebSearch === true,
        ...createDedicatedApiStorageUpdate(payload.dedicatedApiProviders),
        geminiMcpEnabled: payload.mcpEnabled !== false,
        geminiMcpTransport: payload.mcpTransport || DEFAULT_MCP_TRANSPORT,
        geminiMcpServerUrl: payload.mcpServerUrl || DEFAULT_MCP_HTTP_URL,
        geminiMcpServers: normalizeNcodeMcpServers(payload.mcpServers),
        geminiMcpActiveServerId: payload.mcpActiveServerId || null,
    };
}

export function getDefaultMcpUrlForTransport(transport) {
    const normalized = String(transport || DEFAULT_MCP_TRANSPORT).toLowerCase();
    if (normalized === 'ws' || normalized === 'websocket') return DEFAULT_MCP_WS_URL;
    if (normalized === 'streamable-http' || normalized === 'streamablehttp') {
        return DEFAULT_MCP_HTTP_URL;
    }
    return DEFAULT_MCP_SSE_URL;
}

/**
 * Canonical Ncode local PC & shell MCP server entry.
 *
 * `overrides` lets callers preserve user-editable fields (headers, toolMode,
 * enabledTools) when re-normalizing an existing entry; identity, transport,
 * URL and `enabled` are always forced to the canonical local values.
 */
export function createDefaultNcodeMcpServer(overrides = {}) {
    const source =
        overrides && typeof overrides === 'object' && !Array.isArray(overrides) ? overrides : {};
    const headers =
        source.headers && typeof source.headers === 'object' && !Array.isArray(source.headers)
            ? { ...source.headers }
            : {};
    return {
        ...NCODE_DEFAULT_MCP_SERVER,
        headers,
        toolMode: typeof source.toolMode === 'string' && source.toolMode ? source.toolMode : 'all',
        enabledTools: Array.isArray(source.enabledTools) ? [...source.enabledTools] : [],
    };
}

function normalizeMcpUrlForCompare(rawUrl) {
    return String(rawUrl ?? '')
        .trim()
        .replace(/\/+$/, '')
        .toLowerCase();
}

function isNcodeLocalMcpServerEntry(server) {
    if (!server || typeof server !== 'object' || Array.isArray(server)) return false;
    if (server.id === NCODE_LOCAL_MCP_SERVER_ID) return true;
    if (server.id === NCODE_LEGACY_LOCAL_MCP_SERVER_ID) return true;
    return normalizeMcpUrlForCompare(server.url) === normalizeMcpUrlForCompare(NCODE_LOCAL_MCP_URL);
}

/**
 * Force-merges the canonical Ncode local PC & shell MCP server into a saved
 * server list.
 *
 * The built-in daemon is never optional: a saved list that disables it, points
 * it at the wrong transport/URL, or omits it entirely still ends up with one
 * enabled Streamable HTTP entry on 127.0.0.1:3001. Every user server is
 * preserved with its own settings and order; duplicate built-in entries (same
 * id or same URL) collapse into the first occurrence. Pure and idempotent: the
 * input array is never mutated and re-running the merge returns the same list.
 *
 * @param {unknown} servers
 * @returns {Array<object>}
 */
export function forceMergeNcodeDefaultServer(servers) {
    const input = Array.isArray(servers) ? servers : [];
    const result = [];
    let localPlaced = false;

    for (const entry of input) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
        if (!isNcodeLocalMcpServerEntry(entry)) {
            result.push({ ...entry });
            continue;
        }
        if (localPlaced) continue; // Never duplicate the built-in local server.
        result.push(createDefaultNcodeMcpServer(entry));
        localPlaced = true;
    }

    if (!localPlaced) {
        result.unshift(createDefaultNcodeMcpServer());
    }

    return result;
}

/**
 * Normalizes a stored MCP server list for the settings payload. Same contract
 * as {@link forceMergeNcodeDefaultServer}; kept as the payload-facing name.
 *
 * @param {unknown} servers
 * @returns {Array<object>}
 */
export function normalizeNcodeMcpServers(servers) {
    return forceMergeNcodeDefaultServer(servers);
}

export function createDefaultMcpServer(id = createPrefixedId('srv')) {
    return {
        id,
        name: NCODE_LOCAL_MCP_SERVER_NAME,
        transport: DEFAULT_MCP_TRANSPORT,
        url: NCODE_LOCAL_MCP_URL,
        headers: {},
        enabled: true,
        toolMode: 'all',
        enabledTools: [],
    };
}
