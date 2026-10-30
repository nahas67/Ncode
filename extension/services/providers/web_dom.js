/**
 * Gemini live-DOM driver (Mode B) — background-side controller.
 *
 * Mode A (`services/providers/web.js`) talks to Gemini's internal
 * StreamGenerate RPC with scraped session tokens. When that path is blocked
 * (expired cookies, 401/403, parser drift, "No valid response found"), Mode B
 * drives the user's real gemini.google.com tab through the companion content
 * script `content/gemini_dom_bridge.js`:
 *
 *   1. reuse an open Gemini tab (creating a pinned background tab if needed),
 *   2. make sure the DOM bridge content script is present (ping, then inject),
 *   3. connect to it over the `ncode-gemini-dom` port, send the prompt,
 *   4. forward stream deltas to `onUpdate` and resolve with the final answer.
 *
 * A tab opened by this module is always closed again afterwards; a tab that
 * already existed is left untouched. Every Chrome API is looked up lazily so
 * unit tests can run without a real extension runtime.
 */
import { generateUUID } from '../../shared/utils/index.js';
import { debugLog } from '../../shared/logging/debug.js';

/** Port name shared with content/gemini_dom_bridge.js. */
const GEMINI_DOM_PORT_NAME = 'ncode-gemini-dom';
/** Content script injected on demand when the manifest copy is missing. */
const GEMINI_DOM_BRIDGE_FILE = 'content/gemini_dom_bridge.js';
/** chrome.tabs.query URL filter for Gemini tabs. */
const GEMINI_DOM_TAB_URL_PATTERN = 'https://gemini.google.com/*';
/** App page opened in the pinned background tab when no Gemini tab exists. */
const GEMINI_DOM_APP_URL = 'https://gemini.google.com/app';
/** Ping round-trip budget before treating the bridge as missing. */
const DOM_BRIDGE_PING_TIMEOUT_MS = 2000;
/** How often to re-ping after injecting the bridge. */
const DOM_BRIDGE_INJECT_RETRIES = 10;
/** Delay between bridge re-pings after injection. */
const DOM_BRIDGE_INJECT_RETRY_DELAY_MS = 150;
/** How long to wait for a Gemini tab to report status 'complete'. */
const DOM_TAB_LOAD_TIMEOUT_MS = 30000;
/** Polling interval while waiting for tab load completion. */
const DOM_TAB_POLL_INTERVAL_MS = 250;
/**
 * Background-side hard cap. Slightly above the content script's own 10 minute
 * cap so the bridge's descriptive timeout wins the race in normal operation.
 */
const DOM_REQUEST_TIMEOUT_MS = 10 * 60 * 1000 + 30000;

/**
 * @returns {object|null} chrome.tabs API, or null outside an extension context.
 */
function getChromeTabsApi() {
    if (typeof chrome === 'undefined') return null;
    return chrome?.tabs || null;
}

/**
 * @returns {object|null} chrome.scripting API, or null outside an extension context.
 */
function getChromeScriptingApi() {
    if (typeof chrome === 'undefined') return null;
    return chrome?.scripting || null;
}

/**
 * @param {string} [message]
 * @returns {Error}
 */
function createAbortError(message = 'Gemini DOM request aborted.') {
    const error = new Error(message);
    error.name = 'AbortError';
    return error;
}

/**
 * @param {AbortSignal|null|undefined} signal
 */
function throwIfAborted(signal) {
    if (signal?.aborted) throw createAbortError();
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

/**
 * Races a promise against a timeout.
 * @template T
 * @param {Promise<T>|T} promise
 * @param {number} timeoutMs
 * @param {string} message
 * @returns {Promise<T>}
 */
function withTimeout(promise, timeoutMs, message) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
        Promise.resolve(promise).then(
            (value) => {
                clearTimeout(timer);
                resolve(value);
            },
            (error) => {
                clearTimeout(timer);
                reject(error);
            }
        );
    });
}

/**
 * Probes the live-DOM bridge in one tab.
 *
 * @param {number} tabId
 * @returns {Promise<boolean>} True when the content script answered the ping.
 */
export async function pingGeminiDomBridge(tabId) {
    const tabsApi = getChromeTabsApi();
    if (!tabsApi?.sendMessage || !Number.isInteger(tabId)) return false;

    try {
        const response = await withTimeout(
            tabsApi.sendMessage(tabId, { action: 'NCODE_DOM_BRIDGE_PING' }),
            DOM_BRIDGE_PING_TIMEOUT_MS,
            'Gemini DOM bridge ping timed out.'
        );
        return response?.ok === true;
    } catch {
        return false;
    }
}

/**
 * Ensures the DOM bridge content script is alive in the target tab.
 *
 * The manifest already injects it on gemini.google.com, but extension reloads
 * and tabs opened before installation do not have it. In that case this injects
 * `content/gemini_dom_bridge.js` via chrome.scripting and re-pings.
 *
 * @param {number} tabId
 * @returns {Promise<boolean>} Always true on success (throws otherwise).
 */
export async function ensureGeminiDomBridge(tabId) {
    if (!Number.isInteger(tabId)) {
        throw new Error('Gemini DOM bridge requires a valid tab id.');
    }
    if (await pingGeminiDomBridge(tabId)) return true;

    const scriptingApi = getChromeScriptingApi();
    if (!scriptingApi?.executeScript) {
        throw new Error(
            'Gemini DOM bridge is unavailable: chrome.scripting.executeScript is not available in this context.'
        );
    }

    try {
        await scriptingApi.executeScript({
            target: { tabId },
            files: [GEMINI_DOM_BRIDGE_FILE],
        });
    } catch (error) {
        throw new Error(
            `Gemini DOM bridge injection failed in tab ${tabId}: ${
                error instanceof Error ? error.message : String(error)
            }`
        );
    }

    for (let attempt = 0; attempt < DOM_BRIDGE_INJECT_RETRIES; attempt++) {
        if (await pingGeminiDomBridge(tabId)) return true;
        await sleep(DOM_BRIDGE_INJECT_RETRY_DELAY_MS);
    }

    throw new Error(
        `Gemini DOM bridge did not respond in tab ${tabId} after injecting ${GEMINI_DOM_BRIDGE_FILE}.`
    );
}

/**
 * Finds an existing usable Gemini tab.
 * @param {object} tabsApi
 * @returns {Promise<object|null>}
 */
async function findGeminiTab(tabsApi) {
    if (typeof tabsApi?.query !== 'function') return null;
    let tabs;
    try {
        tabs = await tabsApi.query({ url: GEMINI_DOM_TAB_URL_PATTERN });
    } catch {
        return null;
    }
    const candidates = (Array.isArray(tabs) ? tabs : []).filter(
        (tab) => Number.isInteger(tab?.id) && tab?.discarded !== true
    );
    return candidates.find((tab) => tab.status === 'complete') || candidates[0] || null;
}

/**
 * Waits for a tab to finish loading (best-effort: tabs.get failures stop the
 * wait instead of surfacing an error).
 * @param {number} tabId
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<void>}
 */
async function waitForGeminiTabComplete(tabId, { timeoutMs = DOM_TAB_LOAD_TIMEOUT_MS } = {}) {
    const tabsApi = getChromeTabsApi();
    if (typeof tabsApi?.get !== 'function') return;

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        let tab;
        try {
            tab = await tabsApi.get(tabId);
        } catch {
            return;
        }
        if (tab?.status === 'complete' || tab?.status === undefined) return;
        await sleep(DOM_TAB_POLL_INTERVAL_MS);
    }
}

/**
 * Reuses an open Gemini tab or opens a pinned background tab.
 * @param {object} tabsApi
 * @returns {Promise<{ tabId: number, created: boolean }>}
 */
async function ensureGeminiDomTab(tabsApi) {
    const existingTab = await findGeminiTab(tabsApi);
    if (existingTab) {
        if (existingTab.status && existingTab.status !== 'complete') {
            await waitForGeminiTabComplete(existingTab.id);
        }
        return { tabId: existingTab.id, created: false };
    }

    if (typeof tabsApi?.create !== 'function') {
        throw new Error(
            'Gemini DOM bridge is unavailable: no open gemini.google.com tab exists and chrome.tabs.create is not available.'
        );
    }

    let createdTab;
    try {
        createdTab = await tabsApi.create({
            url: GEMINI_DOM_APP_URL,
            active: false,
            pinned: true,
        });
    } catch (error) {
        throw new Error(
            `Failed to open a background Gemini tab: ${
                error instanceof Error ? error.message : String(error)
            }`
        );
    }

    if (!Number.isInteger(createdTab?.id)) {
        throw new Error(
            'Failed to open a background Gemini tab: chrome.tabs.create returned no tab id.'
        );
    }

    await waitForGeminiTabComplete(createdTab.id);
    return { tabId: createdTab.id, created: true };
}

/**
 * Runs one prompt over the DOM bridge port and resolves with the final answer.
 *
 * @param {{
 *   tabId: number,
 *   prompt: string,
 *   requestId: string,
 *   signal?: AbortSignal|null,
 *   onUpdate?: ((text: string, thoughts: string|null) => void)|null,
 * }} options
 * @returns {Promise<{ text: string, thoughts: string|null, mode: object|null }>}
 */
function runDomPromptRequest({ tabId, prompt, requestId, signal, onUpdate }) {
    return new Promise((resolve, reject) => {
        const tabsApi = getChromeTabsApi();
        if (typeof tabsApi?.connect !== 'function') {
            reject(
                new Error(
                    'Gemini DOM bridge is unavailable: chrome.tabs.connect is not available in this context.'
                )
            );
            return;
        }

        let port;
        try {
            port = tabsApi.connect(tabId, { name: GEMINI_DOM_PORT_NAME });
        } catch (error) {
            reject(
                new Error(
                    `Failed to connect to the Gemini DOM bridge: ${
                        error instanceof Error ? error.message : String(error)
                    }`
                )
            );
            return;
        }

        if (!port || typeof port.postMessage !== 'function') {
            reject(new Error('Failed to connect to the Gemini DOM bridge: no port was returned.'));
            return;
        }

        let settled = false;
        let lastText = '';
        let lastThoughts = null;
        let timer = null;
        let removeAbortListener = () => {};
        let removeMessageListener = () => {};
        let removeDisconnectListener = () => {};

        const cleanup = () => {
            if (timer) {
                clearTimeout(timer);
                timer = null;
            }
            try {
                removeAbortListener();
            } catch {
                // Listener may already be gone.
            }
            try {
                removeMessageListener();
            } catch {
                // Port event may already be disconnected.
            }
            try {
                removeDisconnectListener();
            } catch {
                // Port event may already be disconnected.
            }
            try {
                port.disconnect?.();
            } catch {
                // The port can be closed from the other side first.
            }
        };

        const fail = (error) => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(error);
        };

        const succeed = (value) => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve(value);
        };

        const handleMessage = (message) => {
            if (!message || message.requestId !== requestId) return;

            switch (message.type) {
                case 'ncode:dom-stream': {
                    if (typeof message.text === 'string') lastText = message.text;
                    if (message.thoughts !== undefined) lastThoughts = message.thoughts;
                    try {
                        onUpdate?.(lastText, lastThoughts);
                    } catch (error) {
                        debugLog('[Gemini DOM] onUpdate callback threw:', error);
                    }
                    return;
                }
                case 'ncode:dom-done': {
                    const finalText =
                        typeof message.text === 'string' && message.text ? message.text : lastText;
                    if (!finalText) {
                        fail(
                            new Error(
                                'Gemini DOM bridge completed without returning any response text.'
                            )
                        );
                        return;
                    }
                    succeed({
                        text: finalText,
                        thoughts: message.thoughts ?? lastThoughts,
                        mode: message.mode || null,
                    });
                    return;
                }
                case 'ncode:dom-error': {
                    fail(new Error(message.message || 'Gemini DOM bridge reported an error.'));
                    return;
                }
                default:
                    return;
            }
        };

        const handleDisconnect = () => {
            fail(new Error('Gemini DOM bridge disconnected before the response completed.'));
        };

        const handleAbort = () => {
            try {
                port.postMessage({ type: 'ncode:dom-abort', requestId });
            } catch {
                // The content script might already be gone; the disconnect below covers it.
            }
            try {
                const abortPromise = tabsApi.sendMessage?.(tabId, {
                    type: 'ncode:dom-abort',
                    requestId,
                });
                if (abortPromise && typeof abortPromise.catch === 'function') {
                    abortPromise.catch(() => {});
                }
            } catch {
                // One-shot abort notifications are best-effort.
            }
            fail(createAbortError());
        };

        port.onMessage?.addListener?.(handleMessage);
        if (port.onMessage?.removeListener) {
            removeMessageListener = () => port.onMessage.removeListener(handleMessage);
        }
        port.onDisconnect?.addListener?.(handleDisconnect);
        if (port.onDisconnect?.removeListener) {
            removeDisconnectListener = () => port.onDisconnect.removeListener(handleDisconnect);
        }

        if (signal) {
            if (signal.aborted) {
                handleAbort();
                return;
            }
            signal.addEventListener('abort', handleAbort, { once: true });
            removeAbortListener = () => signal.removeEventListener('abort', handleAbort);
        }

        timer = setTimeout(() => {
            fail(
                new Error(
                    `Gemini DOM bridge request timed out after ${Math.round(
                        DOM_REQUEST_TIMEOUT_MS / 1000
                    )}s.`
                )
            );
        }, DOM_REQUEST_TIMEOUT_MS);

        try {
            port.postMessage({
                type: 'ncode:dom-prompt',
                requestId,
                prompt,
            });
        } catch (error) {
            fail(
                new Error(
                    `Failed to send the prompt to the Gemini DOM bridge: ${
                        error instanceof Error ? error.message : String(error)
                    }`
                )
            );
        }
    });
}

/**
 * Sends one prompt through the user's live gemini.google.com tab (Mode B).
 *
 * Resolves with the final answer once the content script reports completion.
 * Stream deltas are forwarded through `onUpdate` as cumulative text. A tab
 * created by this call is always closed again in `finally`; a pre-existing tab
 * is kept open. Aborting `signal` disconnects the port and notifies the content
 * script so it stops watching the DOM.
 *
 * @param {{
 *   prompt: string,
 *   signal?: AbortSignal|null,
 *   onUpdate?: ((text: string, thoughts: string|null) => void)|null,
 *   requestId?: string,
 * }} options
 * @returns {Promise<{
 *   text: string,
 *   thoughts: string|null,
 *   mode: { model: string, extendedThinking: boolean }|null,
 *   tabId: number,
 *   createdTab: boolean,
 * }>}
 */
export async function sendPromptViaGeminiDom({ prompt, signal, onUpdate, requestId } = {}) {
    const tabsApi = getChromeTabsApi();
    if (!tabsApi || typeof tabsApi.query !== 'function' || typeof tabsApi.connect !== 'function') {
        throw new Error(
            'Gemini DOM bridge is unavailable: chrome.tabs (query/connect) is not available in this context.'
        );
    }

    const promptText = typeof prompt === 'string' ? prompt.trim() : '';
    if (!promptText) {
        throw new Error('Gemini DOM bridge requires a non-empty prompt.');
    }

    throwIfAborted(signal);

    const domRequestId = typeof requestId === 'string' && requestId ? requestId : generateUUID();
    let tabId = null;
    let createdTab = false;

    try {
        const target = await ensureGeminiDomTab(tabsApi);
        tabId = target.tabId;
        createdTab = target.created === true;
        throwIfAborted(signal);

        await ensureGeminiDomBridge(tabId);
        throwIfAborted(signal);

        debugLog(`[Gemini DOM] Sending prompt over bridge (tab ${tabId}, created=${createdTab})`);
        const result = await runDomPromptRequest({
            tabId,
            prompt: promptText,
            requestId: domRequestId,
            signal,
            onUpdate,
        });

        return {
            text: result.text,
            thoughts: result.thoughts ?? null,
            mode: result.mode || null,
            tabId,
            createdTab,
        };
    } finally {
        if (createdTab && Number.isInteger(tabId) && typeof tabsApi.remove === 'function') {
            try {
                await tabsApi.remove(tabId);
            } catch (error) {
                debugLog('[Gemini DOM] Failed to close temporary Gemini tab:', error);
            }
        }
    }
}
