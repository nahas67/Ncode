/**
 * Shared provider utilities for Gemini Web authentication.
 *
 * Two authentication layers exist for the reverse-engineered Web client:
 *
 * 1. Mode A (direct background StreamGenerate fetch) needs the per-session
 *    tokens embedded in the logged-in gemini.google.com/app HTML:
 *    `SNlM0e` (at), `cfb2h` (bl), `FdrFJe` (f.sid) plus the optional upload
 *    tokens `qKIAYe` / `Ylro7b`.
 * 2. Mode B (live DOM bridge) drives a real Gemini tab, so it only needs an
 *    actual gemini.google.com tab — no tokens at all.
 *
 * This module owns token acquisition for Mode A. It first tries a credentialed
 * fetch of the app page (the same path the extension always used), then falls
 * back to reading `window.WIZ_global_data` from an already open Gemini tab, and
 * finally creates a pinned background tab when none exists. Every step is
 * service-worker safe: no user gesture, no DOM access outside executeScript.
 */
import { extractFromHTML } from '../../../shared/utils/index.js';

/** Gemini Web origin used for session-token acquisition. */
const GEMINI_WEB_ORIGIN = 'https://gemini.google.com';
/** Logged-in Gemini app page scraped for session tokens. */
const GEMINI_WEB_APP_URL = `${GEMINI_WEB_ORIGIN}/app`;
/** chrome.tabs.query URL filter matching any Gemini tab. */
const GEMINI_WEB_TAB_URL_PATTERN = `${GEMINI_WEB_ORIGIN}/*`;
/** Fetch timeout for the credentialed app-page request. */
const GEMINI_WEB_FETCH_TIMEOUT_MS = 8000;
/** How long to wait for a created/found tab to expose tokens. */
const GEMINI_WEB_TAB_WAIT_TIMEOUT_MS = 30000;
/** Polling interval while waiting for a tab to load or expose tokens. */
const GEMINI_WEB_TAB_POLL_INTERVAL_MS = 250;
/** Token fields required to build a StreamGenerate request. */
const REQUIRED_WEB_TOKEN_FIELDS = ['atValue', 'blValue', 'fSid'];

/**
 * Gemini Web client capabilities constant
 */
export const WEB_CLIENT_CAPABILITIES = Object.freeze([4, 5, 6, 8]);

/**
 * Assert that a specific auth token exists in context
 * @throws {Error} If token is missing
 */
export function assertAuthToken(context, fieldName) {
    if (!context?.[fieldName]) {
        throw new Error(`Missing Gemini Web auth token: ${fieldName}`);
    }
}

/**
 * Drop `contextIds` from a fetched Web auth context before storing or reusing it.
 * The ids are single-use per request; persisting them makes the next request reuse
 * a stale batch. Returns the remaining auth fields.
 * @param {Record<string, unknown>} context
 */
export function stripNativeContextIds(context = {}) {
    const { contextIds, ...authContext } = context;
    return authContext;
}

/**
 * Parses the Gemini Web session tokens out of the logged-in app HTML.
 *
 * Pure helper: it performs no I/O and never throws. Missing optional tokens are
 * returned as `null`; missing required tokens are still returned as `null` so
 * callers can decide how to fall back. `authUserIndex` comes from the requested
 * account index unless the page exposes a `data-index` account switcher.
 *
 * @param {string} html Raw HTML of the gemini.google.com app page.
 * @param {{ userIndex?: string }} [options] Requested account index (defaults to '0').
 * @returns {{
 *   atValue: string|null,
 *   blValue: string|null,
 *   fSid: string|null,
 *   locale: string,
 *   authUserIndex: string,
 *   uploadPushId: string|null,
 *   uploadClientPctx: string|null,
 * }}
 */
export function extractGeminiWebTokensFromHtml(html, { userIndex = '0' } = {}) {
    const source = typeof html === 'string' ? html : '';
    const atValue = extractFromHTML('SNlM0e', source) || null;
    const blValue = extractFromHTML('cfb2h', source) || null;
    const fSid = extractFromHTML('FdrFJe', source) || null;
    const uploadPushId = extractFromHTML('qKIAYe', source) || null;
    const uploadClientPctx = extractFromHTML('Ylro7b', source) || null;
    const locale = source.match(/<html[^>]*\slang="([^"]+)"/)?.[1] || 'en-US';

    let authUserIndex = String(userIndex || '0');
    const authMatch = source.match(/data-index=["'](\d+)["']/);
    if (authMatch) {
        const parsed = authMatch[1];
        if (/^\d+$/.test(parsed) && Number(parsed) < 20) authUserIndex = parsed;
    }

    return {
        atValue,
        blValue,
        fSid,
        locale,
        authUserIndex,
        uploadPushId,
        uploadClientPctx,
    };
}

/**
 * @param {{ atValue?: string|null, blValue?: string|null, fSid?: string|null }} [tokens]
 * @returns {boolean} True when the required StreamGenerate tokens are present.
 */
export function hasCompleteGeminiWebTokens(tokens = {}) {
    return REQUIRED_WEB_TOKEN_FIELDS.every((field) => Boolean(tokens?.[field]));
}

/**
 * Throws the canonical "tokens unavailable" error when required tokens are
 * missing. Kept in this shared module so services/auth.js and the tab-creation
 * fallback produce the same message (the error classifier matches it).
 *
 * @template T
 * @param {T} tokens
 * @param {{ userIndex?: string }} [options]
 * @returns {T}
 */
export function requireCompleteGeminiWebTokens(tokens, { userIndex } = {}) {
    if (hasCompleteGeminiWebTokens(tokens)) return tokens;

    const accountIndex = userIndex ?? tokens?.authUserIndex ?? '0';
    const missingRequestTokens = REQUIRED_WEB_TOKEN_FIELDS.filter((field) => !tokens?.[field]);
    throw new Error(
        `Gemini Web request tokens unavailable for account ${accountIndex}: ${missingRequestTokens.join(', ')}. Please log in to gemini.google.com or refresh Gemini.`
    );
}

/**
 * The function below is serialized by chrome.scripting.executeScript and runs in
 * the isolated world of the Gemini page, so it must not reference module scope.
 * It reads the same WIZ_global_data tokens the page itself uses.
 *
 * @returns {object|null} Raw token record, or null when the page cannot expose it.
 */
function readGeminiTokensFromPageContext() {
    try {
        const wiz =
            (typeof window !== 'undefined' && window.WIZ_global_data) ||
            (typeof globalThis !== 'undefined' && globalThis.WIZ_global_data) ||
            {};
        const pathname = typeof location !== 'undefined' ? String(location.pathname || '') : '';
        const accountMatch = pathname.match(/\/u\/(\d+)(?:\/|$)/);
        const htmlLang =
            typeof document !== 'undefined' && document.documentElement
                ? document.documentElement.lang || ''
                : '';

        return {
            atValue: wiz.SNlM0e || null,
            blValue: wiz.cfb2h || null,
            fSid: wiz.FdrFJe || null,
            uploadPushId: wiz.qKIAYe || null,
            uploadClientPctx: wiz.Ylro7b || null,
            locale: htmlLang || 'en-US',
            authUserIndex: accountMatch ? accountMatch[1] : '0',
        };
    } catch {
        return null;
    }
}

/**
 * @returns {object|null} chrome.tabs API when running in an extension context.
 */
function getChromeTabsApi() {
    if (typeof chrome === 'undefined') return null;
    return chrome?.tabs || null;
}

/**
 * @returns {object|null} chrome.scripting API when running in an extension context.
 */
function getChromeScriptingApi() {
    if (typeof chrome === 'undefined') return null;
    return chrome?.scripting || null;
}

/**
 * @param {unknown} error
 * @returns {boolean}
 */
function isAbortError(error) {
    return Boolean(error) && error?.name === 'AbortError';
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function toErrorMessage(error) {
    return error instanceof Error ? error.message : String(error ?? 'unknown error');
}

/**
 * @param {AbortSignal|null|undefined} signal
 */
function throwIfAborted(signal) {
    if (!signal?.aborted) return;
    const error = new Error('Gemini Web session token acquisition aborted.');
    error.name = 'AbortError';
    throw error;
}

/**
 * Abortable delay used by the tab polling loops.
 * @param {number} ms
 * @param {AbortSignal|null|undefined} signal
 * @returns {Promise<void>}
 */
function delay(ms, signal) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            const error = new Error('Gemini Web session token acquisition aborted.');
            error.name = 'AbortError';
            reject(error);
            return;
        }

        const cleanup = () => {
            clearTimeout(timer);
            signal?.removeEventListener?.('abort', onAbort);
        };
        const onAbort = () => {
            cleanup();
            const error = new Error('Gemini Web session token acquisition aborted.');
            error.name = 'AbortError';
            reject(error);
        };
        const timer = setTimeout(
            () => {
                cleanup();
                resolve();
            },
            Math.max(0, Number(ms) || 0)
        );
        signal?.addEventListener?.('abort', onAbort, { once: true });
    });
}

/**
 * @param {string|null|undefined} url
 * @returns {string} Account index parsed from `/u/<index>/`, defaulting to '0'.
 */
function parseAuthUserIndexFromUrl(url) {
    const match = String(url || '').match(/\/u\/(\d+)(?:\/|$)/);
    return match ? match[1] : '0';
}

/**
 * Normalizes a token record read from a tab and validates the required fields.
 * @param {object|null|undefined} rawTokens
 * @param {{ url?: string }} [tab]
 * @returns {object|null} Normalized token record, or null when incomplete.
 */
function normalizeTabTokens(rawTokens, tab = {}) {
    if (!rawTokens || typeof rawTokens !== 'object') return null;

    const tokens = {
        atValue: rawTokens.atValue || null,
        blValue: rawTokens.blValue || null,
        fSid: rawTokens.fSid || null,
        locale: rawTokens.locale || 'en-US',
        authUserIndex:
            rawTokens.authUserIndex || parseAuthUserIndexFromUrl(tab?.url || tab?.pendingUrl),
        uploadPushId: rawTokens.uploadPushId || null,
        uploadClientPctx: rawTokens.uploadClientPctx || null,
    };
    return hasCompleteGeminiWebTokens(tokens) ? tokens : null;
}

/**
 * Fetches the logged-in Gemini app HTML with cookies and parses the session
 * tokens. This is the original Mode A path, now exposed as a reusable helper.
 *
 * @param {{ signal?: AbortSignal|null, userIndex?: string }} [options]
 * @returns {Promise<object>} Token record (without `source`).
 */
async function fetchGeminiWebSessionTokens({ signal, userIndex = '0' } = {}) {
    throwIfAborted(signal);

    const accountIndex = String(userIndex || '0');
    const url =
        accountIndex !== '0' ? `${GEMINI_WEB_ORIGIN}/u/${accountIndex}/app` : GEMINI_WEB_APP_URL;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), GEMINI_WEB_FETCH_TIMEOUT_MS);
    const onExternalAbort = () => controller.abort();
    if (signal) {
        if (signal.aborted) controller.abort();
        else signal.addEventListener('abort', onExternalAbort, { once: true });
    }

    try {
        let response;
        try {
            response = await fetch(url, {
                method: 'GET',
                credentials: 'include',
                signal: controller.signal,
            });
        } catch (error) {
            if (isAbortError(error) && !signal?.aborted) {
                throw new Error(`Timed out fetching Gemini Web session tokens from ${url}.`);
            }
            throw error;
        }

        if (response?.ok === false) {
            throw new Error(`Failed to fetch Gemini Web params (HTTP ${response.status})`);
        }

        const html = await response.text();
        const tokens = extractGeminiWebTokensFromHtml(html, { userIndex: accountIndex });
        return requireCompleteGeminiWebTokens(tokens, { userIndex: accountIndex });
    } finally {
        clearTimeout(timeout);
        signal?.removeEventListener?.('abort', onExternalAbort);
    }
}

/**
 * Reads Gemini Web session tokens from an open gemini.google.com tab.
 * Best-effort: returns null when no tab, no scripting permission, or the tab
 * does not expose the required tokens.
 *
 * @param {{ signal?: AbortSignal|null }} [options]
 * @returns {Promise<object|null>} Token record with `source: 'tab'`, or null.
 */
export async function getGeminiWebAuthFromOpenTab({ signal } = {}) {
    throwIfAborted(signal);

    const tabsApi = getChromeTabsApi();
    const scriptingApi = getChromeScriptingApi();
    if (!tabsApi?.query || !scriptingApi?.executeScript) return null;

    let tabs;
    try {
        tabs = await tabsApi.query({ url: GEMINI_WEB_TAB_URL_PATTERN });
    } catch {
        return null;
    }

    const candidates = (Array.isArray(tabs) ? tabs : []).filter(
        (tab) => Number.isInteger(tab?.id) && tab?.discarded !== true
    );

    for (const tab of candidates) {
        throwIfAborted(signal);
        const tokens = await readGeminiWebTokensFromTab(tab, { signal });
        if (tokens) return { ...tokens, source: 'tab' };
    }
    return null;
}

/**
 * Runs executeScript against one tab and normalizes the token result.
 * @param {{ id: number, url?: string, pendingUrl?: string }} tab
 * @param {{ signal?: AbortSignal|null }} [options]
 * @returns {Promise<object|null>}
 */
async function readGeminiWebTokensFromTab(tab, { signal } = {}) {
    throwIfAborted(signal);
    const scriptingApi = getChromeScriptingApi();
    if (!scriptingApi?.executeScript || !Number.isInteger(tab?.id)) return null;

    try {
        const results = await scriptingApi.executeScript({
            target: { tabId: tab.id },
            func: readGeminiTokensFromPageContext,
        });
        const rawTokens = Array.isArray(results)
            ? results.find((result) => result && result.result)?.result
            : results?.result;
        return normalizeTabTokens(rawTokens, tab);
    } catch {
        return null;
    }
}

/**
 * Waits until a tab reports `status === 'complete'`.
 * @param {number} tabId
 * @param {{ signal?: AbortSignal|null, timeoutMs?: number }} [options]
 * @returns {Promise<void>}
 */
async function waitForTabComplete(
    tabId,
    { signal, timeoutMs = GEMINI_WEB_TAB_WAIT_TIMEOUT_MS } = {}
) {
    const tabsApi = getChromeTabsApi();
    if (!tabsApi?.get) return;

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        throwIfAborted(signal);
        let tab = null;
        try {
            tab = await tabsApi.get(tabId);
        } catch {
            return;
        }
        if (tab?.status === 'complete' || tab?.status === undefined) return;
        await delay(GEMINI_WEB_TAB_POLL_INTERVAL_MS, signal);
    }
}

/**
 * Polls a tab until it exposes complete session tokens.
 * @param {{ id: number, url?: string, pendingUrl?: string }} tab
 * @param {{ signal?: AbortSignal|null, timeoutMs?: number }} [options]
 * @returns {Promise<object|null>}
 */
async function waitForTabSessionTokens(
    tab,
    { signal, timeoutMs = GEMINI_WEB_TAB_WAIT_TIMEOUT_MS } = {}
) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        throwIfAborted(signal);
        const tokens = await readGeminiWebTokensFromTab(tab, { signal });
        if (tokens) return tokens;
        await delay(GEMINI_WEB_TAB_POLL_INTERVAL_MS, signal);
    }
    return null;
}

/**
 * Removes a tab without surfacing failures (the caller is usually already in a
 * fallback path and must not mask the original error).
 * @param {number} tabId
 * @returns {Promise<void>}
 */
async function removeTabQuietly(tabId) {
    const tabsApi = getChromeTabsApi();
    if (!tabsApi?.remove || !Number.isInteger(tabId)) return;
    try {
        await tabsApi.remove(tabId);
    } catch {
        // Best-effort cleanup: a tab the user closed concurrently is fine.
    }
}

/**
 * Reuses an open Gemini tab or creates a pinned background tab, then waits for
 * it to finish loading and expose the session tokens.
 *
 * The returned `created` flag lets callers clean up a tab they caused to be
 * opened while leaving a user tab untouched.
 *
 * @param {{
 *   signal?: AbortSignal|null,
 *   allowTabCreation?: boolean,
 *   waitForTokens?: boolean,
 *   timeoutMs?: number,
 * }} [options]
 * @returns {Promise<{ tabId: number, created: boolean, tokens: object|null }>}
 */
export async function ensureGeminiSessionTab({
    signal,
    allowTabCreation = true,
    waitForTokens = true,
    timeoutMs = GEMINI_WEB_TAB_WAIT_TIMEOUT_MS,
} = {}) {
    throwIfAborted(signal);

    const tabsApi = getChromeTabsApi();
    if (!tabsApi?.query) {
        throw new Error(
            'Unable to ensure a Gemini session tab: chrome.tabs API is not available in this context.'
        );
    }

    let tabs = [];
    try {
        tabs = await tabsApi.query({ url: GEMINI_WEB_TAB_URL_PATTERN });
    } catch {
        tabs = [];
    }

    const existingTab = (Array.isArray(tabs) ? tabs : []).find(
        (tab) => Number.isInteger(tab?.id) && tab?.discarded !== true
    );
    if (existingTab) {
        await waitForTabComplete(existingTab.id, { signal, timeoutMs });
        const tokens = waitForTokens
            ? await waitForTabSessionTokens(existingTab, { signal, timeoutMs })
            : await readGeminiWebTokensFromTab(existingTab, { signal });
        return { tabId: existingTab.id, created: false, tokens };
    }

    if (allowTabCreation === false || typeof tabsApi.create !== 'function') {
        throw new Error(
            'No open Gemini tab is available and creating a background Gemini session tab is disabled.'
        );
    }

    let createdTab;
    try {
        createdTab = await tabsApi.create({
            url: GEMINI_WEB_APP_URL,
            active: false,
            pinned: true,
        });
    } catch (error) {
        throw new Error(`Failed to open a background Gemini session tab: ${toErrorMessage(error)}`);
    }

    if (!Number.isInteger(createdTab?.id)) {
        throw new Error(
            'Failed to open a background Gemini session tab: chrome.tabs.create returned no tab id.'
        );
    }

    await waitForTabComplete(createdTab.id, { signal, timeoutMs });
    const tokens = waitForTokens
        ? await waitForTabSessionTokens(createdTab, { signal, timeoutMs })
        : await readGeminiWebTokensFromTab(createdTab, { signal });

    return { tabId: createdTab.id, created: true, tokens };
}

/**
 * Acquires the Gemini Web session tokens used by the reverse-engineered
 * StreamGenerate request, trying every available layer in order:
 *
 *   1. credentialed fetch of gemini.google.com/app            → source 'fetch'
 *   2. token read from an already open Gemini tab             → source 'tab'
 *   3. pinned background tab created just for the read        → source 'created-tab'
 *
 * A tab created by layer 3 is always cleaned up again. The function never
 * throws generic Chrome API errors; when every layer fails it throws one
 * combined error that names the underlying causes.
 *
 * @param {{
 *   signal?: AbortSignal|null,
 *   allowTabDiscovery?: boolean,
 *   allowTabCreation?: boolean,
 *   userIndex?: string,
 * }} [options]
 * @returns {Promise<{
 *   atValue: string,
 *   blValue: string,
 *   fSid: string,
 *   locale: string,
 *   authUserIndex: string,
 *   uploadPushId: string|null,
 *   uploadClientPctx: string|null,
 *   source: 'fetch'|'tab'|'created-tab',
 * }>}
 */
export async function getGeminiWebSessionTokens({
    signal,
    allowTabDiscovery = true,
    allowTabCreation = true,
    userIndex = '0',
} = {}) {
    throwIfAborted(signal);

    let fetchError = null;
    try {
        const tokens = await fetchGeminiWebSessionTokens({ signal, userIndex });
        return { ...tokens, source: 'fetch' };
    } catch (error) {
        if (isAbortError(error)) throw error;
        fetchError = error;
    }

    if (allowTabDiscovery !== true) {
        throw new Error(
            `Unable to acquire Gemini Web session tokens from gemini.google.com/app: ${toErrorMessage(
                fetchError
            )}. Please log in to gemini.google.com.`
        );
    }

    let tabError = null;
    try {
        const tabTokens = await getGeminiWebAuthFromOpenTab({ signal });
        if (tabTokens) return tabTokens;
        tabError = new Error('No open Gemini tab exposed the required Web session tokens.');
    } catch (error) {
        if (isAbortError(error)) throw error;
        tabError = error;
    }

    if (allowTabCreation === true) {
        let createdSession = null;
        try {
            createdSession = await ensureGeminiSessionTab({
                signal,
                allowTabCreation: true,
            });
            if (createdSession?.tokens) {
                return { ...createdSession.tokens, source: 'created-tab' };
            }
            throw new Error(
                createdSession?.tabId
                    ? `Gemini tab ${createdSession.tabId} did not expose the required Web session tokens.`
                    : 'Failed to open a Gemini session tab.'
            );
        } catch (error) {
            if (isAbortError(error)) throw error;
            tabError = error;
        } finally {
            if (createdSession?.created === true && Number.isInteger(createdSession?.tabId)) {
                await removeTabQuietly(createdSession.tabId);
            }
        }
    }

    throw new Error(
        `Unable to acquire Gemini Web session tokens from gemini.google.com. Fetch failed: ${toErrorMessage(
            fetchError
        )}. Tab discovery failed: ${toErrorMessage(
            tabError
        )}. Please log in to gemini.google.com and open the Gemini page.`
    );
}
