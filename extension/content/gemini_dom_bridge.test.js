// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const READY_FLAG = '__NCODE_GEMINI_DOM_BRIDGE_READY__';

/**
 * Fake chrome.runtime that captures the listeners the bridge registers.
 */
function createRuntimeMock() {
    const connectListeners = [];
    const runtimeMessageListeners = [];
    return {
        runtime: {
            onConnect: {
                addListener: vi.fn((listener) => connectListeners.push(listener)),
            },
            onMessage: {
                addListener: vi.fn((listener) => runtimeMessageListeners.push(listener)),
            },
        },
        connectListeners,
        runtimeMessageListeners,
    };
}

/**
 * Minimal fake Port matching the chrome.runtime.Port surface the bridge uses.
 */
function createFakePort(name = 'ncode-gemini-dom') {
    const messageListeners = [];
    const disconnectListeners = [];
    const messages = [];

    const removeFrom = (listeners) => (listener) => {
        const index = listeners.indexOf(listener);
        if (index >= 0) listeners.splice(index, 1);
    };

    return {
        name,
        messages,
        postMessage: vi.fn((message) => messages.push(message)),
        disconnect: vi.fn(() => {
            for (const listener of [...disconnectListeners]) listener();
        }),
        onMessage: {
            addListener: (listener) => messageListeners.push(listener),
            removeListener: removeFrom(messageListeners),
        },
        onDisconnect: {
            addListener: (listener) => disconnectListeners.push(listener),
            removeListener: removeFrom(disconnectListeners),
        },
        emitMessage(message) {
            for (const listener of [...messageListeners]) listener(message);
        },
        emitDisconnect() {
            for (const listener of [...disconnectListeners]) listener();
        },
    };
}

/**
 * Loads the content script with a fresh module registry and chrome mock.
 */
async function installBridge() {
    vi.resetModules();
    const runtimeMock = createRuntimeMock();
    globalThis.chrome = { runtime: runtimeMock.runtime };
    await import('./gemini_dom_bridge.js');
    return runtimeMock;
}

/**
 * Builds the minimal Gemini composer DOM: contenteditable input + send button.
 * @param {{ withInput?: boolean }} [options]
 */
function setupComposerDom({ withInput = true } = {}) {
    document.body.innerHTML = '';

    const container = document.createElement('div');
    container.className = 'input-area-container';

    let editable = null;
    if (withInput) {
        const richTextarea = document.createElement('rich-textarea');
        editable = document.createElement('div');
        editable.setAttribute('contenteditable', 'true');
        richTextarea.appendChild(editable);
        container.appendChild(richTextarea);
    }

    const sendButton = document.createElement('button');
    sendButton.setAttribute('aria-label', 'Send');
    sendButton.textContent = 'Send';
    container.appendChild(sendButton);

    document.body.appendChild(container);
    return { container, editable, sendButton };
}

/**
 * Appends a Gemini-style response bubble (the shape the bridge scrapes).
 * @param {string} text
 */
function appendResponse(text) {
    const responseContainer = document.createElement('div');
    responseContainer.className = 'response-container';

    const messageContent = document.createElement('message-content');
    const markdown = document.createElement('div');
    markdown.className = 'markdown';
    markdown.textContent = text;

    messageContent.appendChild(markdown);
    responseContainer.appendChild(messageContent);
    document.body.appendChild(responseContainer);
    return responseContainer;
}

/**
 * @param {object[]} messages
 * @param {string} type
 * @param {string} [requestId]
 */
function findMessage(messages, type, requestId) {
    return messages.find(
        (message) => message.type === type && (!requestId || message.requestId === requestId)
    );
}

describe('Gemini live-DOM bridge content script', () => {
    beforeEach(() => {
        delete globalThis[READY_FLAG];
        document.body.innerHTML = '';
        vi.restoreAllMocks();
    });

    afterEach(() => {
        vi.useRealTimers();
        delete globalThis.chrome;
        delete globalThis[READY_FLAG];
        document.body.innerHTML = '';
    });

    it('registers the port listener and answers the one-shot ping', async () => {
        const { connectListeners, runtimeMessageListeners } = await installBridge();

        expect(connectListeners).toHaveLength(1);
        expect(runtimeMessageListeners).toHaveLength(1);

        const sendResponse = vi.fn();
        runtimeMessageListeners[0]({ action: 'NCODE_DOM_BRIDGE_PING' }, {}, sendResponse);

        expect(sendResponse).toHaveBeenCalledWith({ ok: true });
    });

    it('injects the prompt, clicks send, then streams and completes on DOM stability', async () => {
        const { connectListeners } = await installBridge();
        const { editable, sendButton } = setupComposerDom();
        const clickSpy = vi.spyOn(sendButton, 'click').mockImplementation(() => {});

        const port = createFakePort();
        connectListeners[0](port);
        port.emitMessage({
            type: 'ncode:dom-prompt',
            requestId: 'request-1',
            prompt: 'Explain mutation observers',
            settleMs: 150,
            timeoutMs: 5000,
        });

        await vi.waitFor(() => expect(clickSpy).toHaveBeenCalledTimes(1), { timeout: 2000 });
        expect(editable.textContent).toBe('Explain mutation observers');

        appendResponse('MutationObserver watches DOM changes.');

        await vi.waitFor(
            () => expect(findMessage(port.messages, 'ncode:dom-stream', 'request-1')).toBeTruthy(),
            { timeout: 2000 }
        );
        const streamMessage = findMessage(port.messages, 'ncode:dom-stream', 'request-1');
        expect(streamMessage.text).toBe('MutationObserver watches DOM changes.');

        await vi.waitFor(
            () => expect(findMessage(port.messages, 'ncode:dom-done', 'request-1')).toBeTruthy(),
            { timeout: 3000 }
        );
        expect(findMessage(port.messages, 'ncode:dom-done', 'request-1')).toMatchObject({
            type: 'ncode:dom-done',
            requestId: 'request-1',
            text: 'MutationObserver watches DOM changes.',
            mode: { model: 'unknown', extendedThinking: false },
        });
        expect(findMessage(port.messages, 'ncode:dom-error', 'request-1')).toBeUndefined();
    });

    it('reports an error when the Gemini composer input is missing', async () => {
        vi.useFakeTimers();
        const { connectListeners } = await installBridge();
        setupComposerDom({ withInput: false });

        const port = createFakePort();
        connectListeners[0](port);
        port.emitMessage({
            type: 'ncode:dom-prompt',
            requestId: 'request-2',
            prompt: 'hello',
            timeoutMs: 60000,
        });

        await vi.advanceTimersByTimeAsync(6000);

        const errorMessage = findMessage(port.messages, 'ncode:dom-error', 'request-2');
        expect(errorMessage).toBeTruthy();
        expect(errorMessage.message).toMatch(/input box was not found/i);
        expect(findMessage(port.messages, 'ncode:dom-done', 'request-2')).toBeUndefined();
    });

    it('cancels the active request when the port sends an abort message', async () => {
        const { connectListeners } = await installBridge();
        setupComposerDom();

        const port = createFakePort();
        connectListeners[0](port);
        port.emitMessage({
            type: 'ncode:dom-prompt',
            requestId: 'request-3',
            prompt: 'hello',
            timeoutMs: 60000,
        });

        port.emitMessage({ type: 'ncode:dom-abort', requestId: 'request-3' });

        const errorMessage = findMessage(port.messages, 'ncode:dom-error', 'request-3');
        expect(errorMessage).toBeTruthy();
        expect(errorMessage.message).toMatch(/aborted/i);
    });

    it('rejects a second prompt while another DOM request is in flight', async () => {
        const { connectListeners } = await installBridge();
        setupComposerDom();

        const port = createFakePort();
        connectListeners[0](port);
        port.emitMessage({
            type: 'ncode:dom-prompt',
            requestId: 'request-4',
            prompt: 'first',
            timeoutMs: 60000,
        });
        port.emitMessage({
            type: 'ncode:dom-prompt',
            requestId: 'request-5',
            prompt: 'second',
            timeoutMs: 60000,
        });

        const errorMessage = findMessage(port.messages, 'ncode:dom-error', 'request-5');
        expect(errorMessage).toMatchObject({
            type: 'ncode:dom-error',
            requestId: 'request-5',
        });
        expect(errorMessage.message).toMatch(/already in progress/i);

        port.emitMessage({ type: 'ncode:dom-abort', requestId: 'request-4' });
    });

    it('is importable without an extension runtime', async () => {
        delete globalThis.chrome;
        vi.resetModules();
        await expect(import('./gemini_dom_bridge.js')).resolves.toBeDefined();
    });
});
