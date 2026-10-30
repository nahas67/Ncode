/**
 * Ncode Gemini live-DOM bridge — isolated-world content script.
 *
 * This is the Mode B fallback for the zero-API-key Gemini Web engine. When the
 * reverse-engineered StreamGenerate fetch in `services/providers/web.js` cannot
 * obtain a usable session/token response (expired cookies, 401/403, parser
 * drift), the background connects to this script and drives the user's real
 * logged-in gemini.google.com tab instead.
 *
 * Port protocol (background side lives in `services/providers/web_dom.js`):
 *
 *   background -> content
 *     chrome.tabs.connect(tabId, { name: 'ncode-gemini-dom' })
 *     { type: 'ncode:dom-prompt', requestId, prompt, settleMs?, timeoutMs? }
 *     { type: 'ncode:dom-abort', requestId }
 *
 *   content -> background
 *     { type: 'ncode:dom-stream', requestId, text, thoughts? }  // cumulative
 *     { type: 'ncode:dom-done', requestId, text, mode: { model, extendedThinking } }
 *     { type: 'ncode:dom-error', requestId, message }
 *
 * It also answers one-shot `chrome.runtime.onMessage` probes:
 *     { action: 'NCODE_DOM_BRIDGE_PING' } -> { ok: true }
 *
 * Implementation notes:
 *   - Self-guards against double injection (manifest injection + executeScript
 *     fallback can both run) and only registers listeners when the extension
 *     runtime exists, so the file is importable in a plain jsdom test.
 *   - Never throws out of a listener: every request always terminates with
 *     exactly one done/error message (or a port disconnect).
 *   - Completions are detected from DOM stability (2.5s default) plus the
 *     absence of Gemini's localized stop button; a hard 10 minute cap bounds
 *     every request.
 */
(function installNcodeGeminiDomBridge() {
    'use strict';

    const PORT_NAME = 'ncode-gemini-dom';
    const READY_FLAG = '__NCODE_GEMINI_DOM_BRIDGE_READY__';
    const MESSAGE_TYPES = Object.freeze({
        PROMPT: 'ncode:dom-prompt',
        ABORT: 'ncode:dom-abort',
        STREAM: 'ncode:dom-stream',
        DONE: 'ncode:dom-done',
        ERROR: 'ncode:dom-error',
    });
    const PING_ACTION = 'NCODE_DOM_BRIDGE_PING';

    /** Default DOM-stability window before a response is considered finished. */
    const DEFAULT_SETTLE_MS = 2500;
    const MIN_SETTLE_MS = 100;
    const MAX_SETTLE_MS = 60000;
    /** Hard per-request cap. Extended thinking answers can legitimately be long. */
    const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
    const MIN_TIMEOUT_MS = 1000;
    const MAX_TIMEOUT_MS = 10 * 60 * 1000;
    /** Backup polling cadence in case a mutation is missed. */
    const POLL_INTERVAL_MS = 250;
    /** Bounded waits used while locating the composer / send button. */
    const INPUT_WAIT_TIMEOUT_MS = 5000;
    const SEND_WAIT_TIMEOUT_MS = 5000;

    const INPUT_SELECTORS = Object.freeze([
        'rich-textarea [contenteditable]',
        "[contenteditable='true']",
        "[contenteditable='plaintext-only']",
        'textarea',
    ]);
    /** Containers that wrap one assistant answer (newest one is the reply). */
    const RESPONSE_SELECTORS = Object.freeze([
        '.response-container',
        'model-response',
        '.model-response-text',
        'message-content',
    ]);
    /** Inner nodes that carry the answer text of a response container. */
    const RESPONSE_TEXT_SELECTORS = Object.freeze([
        '.model-response-text .markdown',
        'message-content .markdown',
        '.markdown',
    ]);
    /** Optional thinking/thoughts panels surfaced as stream metadata. */
    const THOUGHT_SELECTORS = Object.freeze([
        'model-thoughts',
        '.thoughts',
        '.thinking-content',
        'thinking-content',
    ]);
    /** Localized send-button labels used by Gemini (en/fr/ja/zh/es/de/it). */
    const SEND_LABEL_PATTERN = /(send|envoyer|送信|发送|enviar|senden|invia|提交)/i;
    /** Localized stop/cancel-generation labels. */
    const STOP_LABEL_PATTERN = /(stop|arrêter|arreter|停止|中止|cancel generation|arrêt)/i;

    let activeRequest = null;

    /**
     * @param {unknown} error
     * @returns {string}
     */
    function toErrorMessage(error) {
        return error instanceof Error ? error.message : String(error ?? 'unknown error');
    }

    /**
     * @param {number} ms
     * @returns {Promise<void>}
     */
    function sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
    }

    /**
     * Element visibility check that works both on the real Gemini page and in
     * jsdom (which does not implement layout, so offsetParent is always null).
     * @param {Element|null|undefined} element
     * @returns {boolean}
     */
    function isElementUsable(element) {
        if (!element || element.isConnected === false) return false;
        if (element.disabled === true) return false;
        if (element.hidden === true) return false;
        if (element.getAttribute?.('aria-hidden') === 'true') return false;
        try {
            const style = typeof getComputedStyle === 'function' ? getComputedStyle(element) : null;
            if (style && (style.display === 'none' || style.visibility === 'hidden')) return false;
        } catch {
            // Styling lookup is best-effort; a detached element was filtered above.
        }
        return true;
    }

    /**
     * @param {Element} element
     * @returns {string}
     */
    function readElementText(element) {
        if (!element) return '';
        const innerText = element.innerText;
        if (typeof innerText === 'string' && innerText.trim()) return innerText;
        return element.textContent || '';
    }

    /**
     * @param {unknown} value
     * @returns {string}
     */
    function normalizeText(value) {
        return String(value ?? '')
            .replace(/\r\n/g, '\n')
            .replace(/\u200b/g, '')
            .trim();
    }

    /**
     * @param {string} value
     * @returns {Element|null}
     */
    function findInputElement() {
        for (const selector of INPUT_SELECTORS) {
            let matches;
            try {
                matches = document.querySelectorAll(selector);
            } catch {
                continue;
            }
            for (const element of matches) {
                if (isElementUsable(element)) return element;
            }
        }
        return null;
    }

    /**
     * @param {Element|null} button
     * @returns {boolean}
     */
    function isStopButton(button) {
        if (!button) return false;
        const label = String(button.getAttribute?.('aria-label') || '').toLowerCase();
        const dataTestId = String(button.getAttribute?.('data-test-id') || '').toLowerCase();
        return STOP_LABEL_PATTERN.test(label) || dataTestId.includes('stop');
    }

    /**
     * Walks up from the composer until an ancestor owns at least one button.
     * @param {Element|null} inputElement
     * @returns {Element|null}
     */
    function findInputContainer(inputElement) {
        if (!inputElement) return null;
        let node = inputElement.parentElement;
        for (let depth = 0; node && depth < 8; depth++) {
            if (typeof node.querySelector === 'function' && node.querySelector('button')) {
                return node;
            }
            node = node.parentElement;
        }
        return inputElement.parentElement || null;
    }

    /**
     * Locates Gemini's send button using localized aria-labels first, then the
     * last visible non-stop button inside the composer container.
     * @param {Element|null} inputElement
     * @returns {Element|null}
     */
    function findSendButton(inputElement) {
        let labelledMatches;
        try {
            labelledMatches = document.querySelectorAll('button[aria-label]');
        } catch {
            labelledMatches = [];
        }

        let labelledButton = null;
        for (const button of labelledMatches) {
            if (!isElementUsable(button)) continue;
            if (isStopButton(button)) continue;
            const label = String(button.getAttribute('aria-label') || '');
            if (SEND_LABEL_PATTERN.test(label)) labelledButton = button;
        }
        if (labelledButton) return labelledButton;

        const container = findInputContainer(inputElement);
        if (!container) return null;
        let fallbackButton = null;
        for (const button of container.querySelectorAll('button')) {
            if (!isElementUsable(button)) continue;
            if (isStopButton(button)) continue;
            fallbackButton = button;
        }
        return fallbackButton;
    }

    /**
     * @returns {boolean} True while Gemini is still generating (stop button shown).
     */
    function hasStopButton() {
        let buttons;
        try {
            buttons = document.querySelectorAll('button');
        } catch {
            return false;
        }
        for (const button of buttons) {
            if (isStopButton(button) && isElementUsable(button)) return true;
        }
        return false;
    }

    /**
     * @param {Element} element
     * @param {string} prompt
     */
    function dispatchInputEvent(element, prompt) {
        try {
            const event =
                typeof InputEvent === 'function'
                    ? new InputEvent('input', {
                          bubbles: true,
                          cancelable: true,
                          inputType: 'insertText',
                          data: prompt,
                      })
                    : new Event('input', { bubbles: true });
            element.dispatchEvent(event);
        } catch {
            try {
                element.dispatchEvent(new Event('input', { bubbles: true }));
            } catch {
                // A detached composer is handled by the caller's error path.
            }
        }
    }

    /**
     * Injects the prompt through the native value setter (textarea/input) or
     * `document.execCommand('insertText')` (contenteditable), with a plain
     * textContent fallback, then fires a bubbling `input` event.
     * @param {Element} element
     * @param {string} prompt
     */
    function injectPrompt(element, prompt) {
        try {
            element.focus?.();
        } catch {
            // Focus is best-effort.
        }

        const tagName = String(element.tagName || '').toUpperCase();
        const isTextField =
            tagName === 'TEXTAREA' ||
            tagName === 'INPUT' ||
            (typeof HTMLTextAreaElement === 'function' && element instanceof HTMLTextAreaElement) ||
            (typeof HTMLInputElement === 'function' && element instanceof HTMLInputElement);

        if (isTextField) {
            const prototype =
                typeof HTMLTextAreaElement === 'function' && element instanceof HTMLTextAreaElement
                    ? HTMLTextAreaElement.prototype
                    : typeof HTMLInputElement === 'function' && element instanceof HTMLInputElement
                      ? HTMLInputElement.prototype
                      : null;
            const descriptor = prototype
                ? Object.getOwnPropertyDescriptor(prototype, 'value')
                : null;
            if (descriptor?.set) descriptor.set.call(element, prompt);
            else element.value = prompt;
            dispatchInputEvent(element, prompt);
            return;
        }

        let inserted = false;
        try {
            if (typeof document.execCommand === 'function') {
                inserted = document.execCommand('insertText', false, prompt) === true;
            }
        } catch {
            inserted = false;
        }

        if (!inserted) {
            try {
                element.textContent = prompt;
            } catch {
                element.innerText = prompt;
            }
            try {
                const range = document.createRange();
                range.selectNodeContents(element);
                range.collapse(false);
                const selection = window.getSelection?.();
                selection?.removeAllRanges?.();
                selection?.addRange?.(range);
            } catch {
                // Caret placement only matters for the real page.
            }
        }

        dispatchInputEvent(element, prompt);
    }

    /**
     * @returns {Array<Element>} Response candidates in document order.
     */
    function collectResponseCandidates() {
        const seen = new Set();
        const candidates = [];
        for (const selector of RESPONSE_SELECTORS) {
            let matches;
            try {
                matches = document.querySelectorAll(selector);
            } catch {
                continue;
            }
            for (const element of matches) {
                if (!element || seen.has(element)) continue;
                seen.add(element);
                candidates.push(element);
            }
        }

        candidates.sort((left, right) => {
            try {
                const position = left.compareDocumentPosition(right);
                if (position & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
                if (position & Node.DOCUMENT_POSITION_PRECEDING) return 1;
                return 0;
            } catch {
                return 0;
            }
        });
        return candidates;
    }

    /**
     * @param {Element|null} container
     * @returns {string} Extracted markdown/text for one response container.
     */
    function extractResponseText(container) {
        if (!container) return '';
        let target = null;
        try {
            if (typeof container.matches === 'function' && container.matches('.markdown')) {
                target = container;
            }
            if (!target && typeof container.querySelector === 'function') {
                for (const selector of RESPONSE_TEXT_SELECTORS) {
                    const found = container.querySelector(selector);
                    if (found) {
                        target = found;
                        break;
                    }
                }
            }
        } catch {
            target = null;
        }
        return normalizeText(readElementText(target || container));
    }

    /**
     * @returns {{ nodes: Set<Element>, latestText: string }} Baseline captured
     * before the prompt is sent, used to find the newly appended answer.
     */
    function captureResponseBaseline() {
        const candidates = collectResponseCandidates();
        const latest = candidates[candidates.length - 1] || null;
        return {
            nodes: new Set(candidates),
            latestText: latest ? extractResponseText(latest) : '',
        };
    }

    /**
     * @param {{ nodes: Set<Element>, latestText: string }} baseline
     * @returns {string} Cumulative text of the newest response, or '' while it
     * has not appeared/changed yet.
     */
    function findLatestResponseText(baseline) {
        const candidates = collectResponseCandidates();
        for (let index = candidates.length - 1; index >= 0; index--) {
            const candidate = candidates[index];
            if (baseline.nodes.has(candidate)) continue;
            const text = extractResponseText(candidate);
            if (text) return text;
        }

        const latest = candidates[candidates.length - 1];
        if (!latest) return '';
        const latestText = extractResponseText(latest);
        if (!latestText || latestText === baseline.latestText) return '';
        return latestText;
    }

    /**
     * @returns {string} Cumulative thoughts text exposed by the newest answer.
     */
    function findLatestThoughts() {
        for (const selector of THOUGHT_SELECTORS) {
            let matches;
            try {
                matches = document.querySelectorAll(selector);
            } catch {
                continue;
            }
            const latest = matches[matches.length - 1];
            const text = normalizeText(readElementText(latest));
            if (text) return text;
        }
        return '';
    }

    /**
     * Reads the model picker pill to report which mode produced the answer.
     * @returns {{ model: string, extendedThinking: boolean }}
     */
    function detectGeminiMode() {
        try {
            const pill = document.querySelector('[data-test-id="logo-pill-label-container"]');
            if (!pill) return { model: 'unknown', extendedThinking: false };

            const primary = pill.querySelector('.picker-primary-text');
            const secondary = pill.querySelector('.picker-secondary-text');
            const model = primary?.textContent?.trim() || 'unknown';
            const thinking = (secondary?.textContent || '').trim();

            return {
                model,
                extendedThinking: /extended|thinking|扩展|拡張/i.test(thinking),
            };
        } catch {
            return { model: 'unknown', extendedThinking: false };
        }
    }

    /**
     * @param {number} value
     * @param {number} fallback
     * @param {number} min
     * @param {number} max
     * @returns {number}
     */
    function clampDuration(value, fallback, min, max) {
        const numeric = Number(value);
        if (!Number.isFinite(numeric)) return fallback;
        return Math.min(max, Math.max(min, Math.floor(numeric)));
    }

    /**
     * @param {object} port
     * @param {object} message
     */
    function safePostMessage(port, message) {
        try {
            port?.postMessage?.(message);
        } catch {
            // The port is already disconnected; the background has given up too.
        }
    }

    /**
     * @param {object} state
     */
    function cleanupState(state) {
        if (!state) return;
        if (state.observer) {
            try {
                state.observer.disconnect();
            } catch {
                // Already disconnected.
            }
            state.observer = null;
        }
        if (state.pollTimer) {
            clearInterval(state.pollTimer);
            state.pollTimer = null;
        }
        if (state.timeoutTimer) {
            clearTimeout(state.timeoutTimer);
            state.timeoutTimer = null;
        }
    }

    /**
     * @param {object} state
     */
    function finishWithDone(state) {
        if (!state || state.finished) return;
        state.finished = true;
        cleanupState(state);
        if (activeRequest === state) activeRequest = null;
        safePostMessage(state.port, {
            type: MESSAGE_TYPES.DONE,
            requestId: state.requestId,
            text: state.lastText,
            mode: state.mode || detectGeminiMode(),
        });
    }

    /**
     * @param {object|null} state
     * @param {string} message
     */
    function finishWithError(state, message) {
        if (!state || state.finished) return;
        state.finished = true;
        cleanupState(state);
        if (activeRequest === state) activeRequest = null;
        safePostMessage(state.port, {
            type: MESSAGE_TYPES.ERROR,
            requestId: state.requestId,
            message: message || 'Unknown Gemini DOM bridge error.',
        });
    }

    /**
     * @param {string} reason
     * @param {string|null} [requestId] Only abort the matching request when set.
     */
    function cancelActiveRequest(reason, requestId = null) {
        const state = activeRequest;
        if (!state) return;
        if (requestId && state.requestId !== requestId) return;
        finishWithError(state, reason || 'Request aborted.');
    }

    /**
     * @param {object} state
     */
    function tickState(state) {
        if (!state || state.finished || activeRequest !== state) return;

        const text = findLatestResponseText(state.baseline);
        const now = Date.now();
        if (text && text !== state.lastText) {
            state.lastText = text;
            state.lastChangeAt = now;
            const thoughts = findLatestThoughts();
            safePostMessage(state.port, {
                type: MESSAGE_TYPES.STREAM,
                requestId: state.requestId,
                text,
                ...(thoughts ? { thoughts } : {}),
            });
        }

        if (!state.lastText) return;
        if (now - state.lastChangeAt < state.settleMs) return;

        const sendButtonReady = Boolean(findSendButton(state.inputElement));
        const generating = hasStopButton() && !sendButtonReady;
        if (generating) return;
        finishWithDone(state);
    }

    /**
     * @param {object} state
     */
    function startWatching(state) {
        if (!state || state.finished) return;
        state.lastChangeAt = Date.now();

        const body = document.body || document.documentElement;
        if (body && typeof MutationObserver === 'function') {
            try {
                state.observer = new MutationObserver(() => {
                    try {
                        tickState(state);
                    } catch (error) {
                        finishWithError(state, toErrorMessage(error));
                    }
                });
                state.observer.observe(body, {
                    childList: true,
                    subtree: true,
                    characterData: true,
                });
            } catch (error) {
                finishWithError(
                    state,
                    `Failed to observe the Gemini response DOM: ${toErrorMessage(error)}`
                );
                return;
            }
        }

        state.pollTimer = setInterval(() => {
            try {
                tickState(state);
            } catch (error) {
                finishWithError(state, toErrorMessage(error));
            }
        }, POLL_INTERVAL_MS);
    }

    /**
     * @param {object} state
     * @returns {Promise<Element|null>}
     */
    async function waitForInput(state) {
        const deadline = Date.now() + INPUT_WAIT_TIMEOUT_MS;
        while (Date.now() < deadline) {
            if (state.finished) return null;
            const input = findInputElement();
            if (input) return input;
            await sleep(100);
        }
        return null;
    }

    /**
     * @param {object} state
     * @param {Element|null} inputElement
     * @returns {Promise<Element|null>}
     */
    async function waitForSendButton(state, inputElement) {
        const deadline = Date.now() + SEND_WAIT_TIMEOUT_MS;
        while (Date.now() < deadline) {
            if (state.finished) return null;
            const sendButton = findSendButton(inputElement);
            if (sendButton) return sendButton;
            await sleep(100);
        }
        return null;
    }

    /**
     * Full request lifecycle: locate composer, inject, click send, stream DOM.
     * @param {object} port
     * @param {{ requestId?: string, prompt?: string, settleMs?: number, timeoutMs?: number }} message
     * @returns {Promise<void>}
     */
    async function handlePromptMessage(port, message) {
        const requestId = typeof message?.requestId === 'string' ? message.requestId : '';
        if (!requestId) return;

        const prompt = typeof message.prompt === 'string' ? message.prompt : '';
        if (!prompt.trim()) {
            safePostMessage(port, {
                type: MESSAGE_TYPES.ERROR,
                requestId,
                message: 'Gemini DOM bridge prompt is empty.',
            });
            return;
        }

        if (activeRequest && activeRequest.finished !== true) {
            safePostMessage(port, {
                type: MESSAGE_TYPES.ERROR,
                requestId,
                message: 'Another Ncode DOM request is already in progress in this tab.',
            });
            return;
        }

        const state = {
            port,
            requestId,
            prompt,
            settleMs: clampDuration(
                message.settleMs,
                DEFAULT_SETTLE_MS,
                MIN_SETTLE_MS,
                MAX_SETTLE_MS
            ),
            timeoutMs: clampDuration(
                message.timeoutMs,
                DEFAULT_TIMEOUT_MS,
                MIN_TIMEOUT_MS,
                MAX_TIMEOUT_MS
            ),
            mode: { model: 'unknown', extendedThinking: false },
            inputElement: null,
            baseline: { nodes: new Set(), latestText: '' },
            lastText: '',
            lastChangeAt: 0,
            observer: null,
            pollTimer: null,
            timeoutTimer: null,
            finished: false,
        };
        activeRequest = state;
        state.timeoutTimer = setTimeout(() => {
            finishWithError(
                state,
                `Timed out after ${Math.round(state.timeoutMs / 1000)}s waiting for the Gemini response.`
            );
        }, state.timeoutMs);

        try {
            state.mode = detectGeminiMode();
            const inputElement = await waitForInput(state);
            if (!inputElement) throw new Error('Gemini input box was not found on the page.');
            state.inputElement = inputElement;
            state.baseline = captureResponseBaseline();
            injectPrompt(inputElement, prompt);
            const sendButton = await waitForSendButton(state, inputElement);
            if (!sendButton) {
                throw new Error('Gemini send button was not found or stayed disabled.');
            }
            sendButton.click();
            startWatching(state);
        } catch (error) {
            finishWithError(state, toErrorMessage(error));
        }
    }

    /**
     * @param {object} port
     * @param {unknown} message
     */
    function handlePortMessage(port, message) {
        if (!message || typeof message !== 'object') return;
        if (message.type === MESSAGE_TYPES.PROMPT) {
            handlePromptMessage(port, message).catch((error) => {
                finishWithError(activeRequest, toErrorMessage(error));
            });
            return;
        }
        if (message.type === MESSAGE_TYPES.ABORT) {
            cancelActiveRequest('Request aborted by Ncode.', message.requestId || null);
        }
    }

    /**
     * @param {object} port
     */
    function handlePortConnect(port) {
        if (!port || port.name !== PORT_NAME) return;

        port.onMessage?.addListener?.((message) => {
            try {
                handlePortMessage(port, message);
            } catch (error) {
                safePostMessage(port, {
                    type: MESSAGE_TYPES.ERROR,
                    requestId: message?.requestId || null,
                    message: toErrorMessage(error),
                });
            }
        });

        port.onDisconnect?.addListener?.(() => {
            if (activeRequest?.port === port) {
                cancelActiveRequest('The Gemini DOM bridge port disconnected.');
            }
        });
    }

    /**
     * @param {unknown} message
     * @param {unknown} _sender
     * @param {Function} [sendResponse]
     * @returns {boolean}
     */
    function handleRuntimeMessage(message, _sender, sendResponse) {
        try {
            if (message?.action === PING_ACTION) {
                sendResponse?.({ ok: true });
                return false;
            }
            if (message?.type === MESSAGE_TYPES.ABORT) {
                cancelActiveRequest('Request aborted by Ncode.', message.requestId || null);
            }
        } catch {
            // A throwing listener would break the one-shot ping channel.
        }
        return false;
    }

    const runtime = typeof chrome !== 'undefined' ? chrome.runtime : null;
    if (!runtime || typeof runtime.onConnect?.addListener !== 'function') return;
    if (globalThis[READY_FLAG] === true) return;
    globalThis[READY_FLAG] = true;

    runtime.onConnect.addListener(handlePortConnect);
    if (typeof runtime.onMessage?.addListener === 'function') {
        runtime.onMessage.addListener(handleRuntimeMessage);
    }
})();
