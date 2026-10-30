import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureGeminiDomBridge, pingGeminiDomBridge, sendPromptViaGeminiDom } from './web_dom.js';

const GEMINI_TAB = {
    id: 7,
    status: 'complete',
    url: 'https://gemini.google.com/app',
};

/**
 * Minimal fake chrome.runtime.Port surface used by the DOM driver.
 */
function createFakePort() {
    const messageListeners = [];
    const disconnectListeners = [];
    const messages = [];

    const removeFrom = (listeners) => (listener) => {
        const index = listeners.indexOf(listener);
        if (index >= 0) listeners.splice(index, 1);
    };

    return {
        name: 'ncode-gemini-dom',
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
 * Installs a chrome mock with tabs/scripting/runtime APIs.
 * @param {{
 *   port?: object,
 *   tabs?: Record<string, Function>,
 *   scripting?: Record<string, Function>,
 * }} [overrides]
 */
function installChromeMock({ port = createFakePort(), tabs = {}, scripting = {} } = {}) {
    const chromeMock = {
        runtime: { lastError: null },
        tabs: {
            query: vi.fn(async () => [GEMINI_TAB]),
            get: vi.fn(async (tabId) => ({ id: tabId, status: 'complete' })),
            create: vi.fn(async (options) => ({ id: 9, status: 'complete', url: options?.url })),
            remove: vi.fn(async () => {}),
            sendMessage: vi.fn(async () => ({ ok: true })),
            connect: vi.fn(() => port),
            ...tabs,
        },
        scripting: {
            executeScript: vi.fn(async () => [{ result: true }]),
            ...scripting,
        },
    };
    vi.stubGlobal('chrome', chromeMock);
    return { chromeMock, port };
}

/**
 * @param {object[]} messages
 * @param {string} type
 */
function findMessage(messages, type) {
    return messages.find((message) => message.type === type);
}

describe('web_dom driver', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('reports a clear error when chrome.tabs is unavailable', async () => {
        vi.stubGlobal('chrome', { runtime: {} });

        await expect(sendPromptViaGeminiDom({ prompt: 'hello' })).rejects.toThrow(
            /chrome\.tabs \(query\/connect\) is not available/
        );
    });

    it('rejects an empty prompt before touching tabs', async () => {
        const { chromeMock } = installChromeMock();

        await expect(sendPromptViaGeminiDom({ prompt: '   ' })).rejects.toThrow(/non-empty prompt/);
        expect(chromeMock.tabs.query).not.toHaveBeenCalled();
    });

    it('reuses an existing Gemini tab, streams deltas and returns the final answer', async () => {
        const { chromeMock, port } = installChromeMock();
        const onUpdate = vi.fn();

        const resultPromise = sendPromptViaGeminiDom({
            prompt: 'What is Ncode?',
            requestId: 'dom-1',
            onUpdate,
        });

        await vi.waitFor(() => expect(port.messages.length).toBe(1));
        expect(port.messages[0]).toEqual({
            type: 'ncode:dom-prompt',
            requestId: 'dom-1',
            prompt: 'What is Ncode?',
        });
        expect(chromeMock.tabs.query).toHaveBeenCalledWith({
            url: 'https://gemini.google.com/*',
        });
        expect(chromeMock.tabs.create).not.toHaveBeenCalled();

        port.emitMessage({
            type: 'ncode:dom-stream',
            requestId: 'dom-1',
            text: 'Ncode is',
            thoughts: 'thinking',
        });
        port.emitMessage({
            type: 'ncode:dom-stream',
            requestId: 'dom-1',
            text: 'Ncode is a harness.',
        });
        port.emitMessage({
            type: 'ncode:dom-done',
            requestId: 'dom-1',
            text: 'Ncode is a harness.',
            mode: { model: 'Gemini 3 Pro', extendedThinking: true },
        });

        await expect(resultPromise).resolves.toEqual({
            text: 'Ncode is a harness.',
            thoughts: 'thinking',
            mode: { model: 'Gemini 3 Pro', extendedThinking: true },
            tabId: 7,
            createdTab: false,
        });
        expect(onUpdate).toHaveBeenNthCalledWith(1, 'Ncode is', 'thinking');
        expect(onUpdate).toHaveBeenNthCalledWith(2, 'Ncode is a harness.', 'thinking');
        expect(chromeMock.tabs.remove).not.toHaveBeenCalled();
        expect(port.disconnect).toHaveBeenCalledTimes(1);
    });

    it('creates a pinned background tab when none exists and removes it afterwards', async () => {
        const { chromeMock, port } = installChromeMock({
            tabs: {
                query: vi.fn(async () => []),
                create: vi.fn(async (options) => ({
                    id: 9,
                    status: 'complete',
                    url: options?.url,
                })),
            },
        });

        const resultPromise = sendPromptViaGeminiDom({
            prompt: 'hello',
            requestId: 'dom-2',
        });

        await vi.waitFor(() => expect(port.messages.length).toBe(1));
        expect(chromeMock.tabs.create).toHaveBeenCalledWith({
            url: 'https://gemini.google.com/app',
            active: false,
            pinned: true,
        });

        port.emitMessage({
            type: 'ncode:dom-done',
            requestId: 'dom-2',
            text: 'from created tab',
            mode: { model: 'unknown', extendedThinking: false },
        });

        await expect(resultPromise).resolves.toEqual({
            text: 'from created tab',
            thoughts: null,
            mode: { model: 'unknown', extendedThinking: false },
            tabId: 9,
            createdTab: true,
        });
        expect(chromeMock.tabs.remove).toHaveBeenCalledWith(9);
    });

    it('injects the bridge content script when it does not answer the ping', async () => {
        const { chromeMock, port } = installChromeMock({
            tabs: {
                sendMessage: vi
                    .fn()
                    .mockRejectedValueOnce(
                        new Error('Could not establish connection. Receiving end does not exist.')
                    )
                    .mockResolvedValue({ ok: true }),
            },
        });

        const resultPromise = sendPromptViaGeminiDom({
            prompt: 'hello',
            requestId: 'dom-3',
        });

        await vi.waitFor(() => expect(port.messages.length).toBe(1));
        expect(chromeMock.scripting.executeScript).toHaveBeenCalledWith({
            target: { tabId: 7 },
            files: ['content/gemini_dom_bridge.js'],
        });

        port.emitMessage({
            type: 'ncode:dom-done',
            requestId: 'dom-3',
            text: 'after injection',
        });

        await expect(resultPromise).resolves.toMatchObject({ text: 'after injection', tabId: 7 });
    });

    it('disconnects and notifies the content script when aborted', async () => {
        const { chromeMock, port } = installChromeMock();
        const controller = new AbortController();

        const resultPromise = sendPromptViaGeminiDom({
            prompt: 'long request',
            requestId: 'dom-4',
            signal: controller.signal,
        });

        await vi.waitFor(() => expect(port.messages.length).toBe(1));
        controller.abort();

        await expect(resultPromise).rejects.toMatchObject({ name: 'AbortError' });
        expect(port.disconnect).toHaveBeenCalled();
        expect(chromeMock.tabs.sendMessage).toHaveBeenCalledWith(7, {
            type: 'ncode:dom-abort',
            requestId: 'dom-4',
        });
        expect(chromeMock.tabs.remove).not.toHaveBeenCalled();
    });

    it('fails when the bridge disconnects before completing the response', async () => {
        const { port } = installChromeMock();

        const resultPromise = sendPromptViaGeminiDom({
            prompt: 'hello',
            requestId: 'dom-5',
        });

        await vi.waitFor(() => expect(port.messages.length).toBe(1));
        port.emitDisconnect();

        await expect(resultPromise).rejects.toThrow(/disconnected before the response completed/);
    });

    it('fails with a clear error when scripting is unavailable and the bridge is missing', async () => {
        vi.stubGlobal('chrome', {
            runtime: { lastError: null },
            tabs: {
                query: vi.fn(async () => [GEMINI_TAB]),
                sendMessage: vi.fn(async () => {
                    throw new Error('Could not establish connection.');
                }),
                connect: vi.fn(),
            },
        });

        await expect(ensureGeminiDomBridge(7)).rejects.toThrow(
            /chrome\.scripting\.executeScript is not available/
        );
    });

    it('ping returns false outside an extension runtime and true when the bridge answers', async () => {
        expect(await pingGeminiDomBridge(7)).toBe(false);

        installChromeMock();
        expect(await pingGeminiDomBridge(7)).toBe(true);
    });
});
