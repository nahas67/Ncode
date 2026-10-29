import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BrowserConnection } from './connection.js';

function createChromeMock({ attachBehavior = 'success' } = {}) {
    const attachCallback = ({ tabId }, _version, cb) => {
        if (attachBehavior === 'success') {
            // Defer to mimic async chrome API + allow event-loop interleaving.
            setTimeout(() => cb(), 0);
        } else if (attachBehavior === 'error') {
            setTimeout(() => {
                chrome.runtime.lastError = { message: 'restricted URL' };
                cb();
                delete chrome.runtime.lastError;
            }, 0);
        }
    };

    const detachCallback = ({ tabId }, cb) => {
        setTimeout(() => {
            delete chrome.runtime.lastError;
            cb();
        }, 0);
    };

    globalThis.chrome = {
        runtime: {},
        debugger: {
            attach: vi.fn(attachCallback),
            detach: vi.fn(detachCallback),
            sendCommand: vi.fn((_target, _method, _params, cb) => cb({})),
            onEvent: { addListener: vi.fn(), removeListener: vi.fn() },
            onDetach: { addListener: vi.fn(), removeListener: vi.fn() },
        },
    };
}

describe('BrowserConnection', () => {
    beforeEach(() => {
        createChromeMock();
    });

    afterEach(() => {
        delete globalThis.chrome;
        vi.restoreAllMocks();
    });

    it('attaches to a tab and exposes currentTabId', async () => {
        const connection = new BrowserConnection();
        const result = await connection.attach(33);

        expect(result).toBe(true);
        expect(connection.attached).toBe(true);
        expect(connection.currentTabId).toBe(33);
        expect(chrome.debugger.attach).toHaveBeenCalledTimes(1);
    });

    it('serializes concurrent attach() calls to the same tab (single-flight)', async () => {
        const connection = new BrowserConnection();

        const [a, b] = await Promise.all([connection.attach(33), connection.attach(33)]);

        expect(a).toBe(true);
        expect(b).toBe(true);
        expect(connection.currentTabId).toBe(33);
        // Second call hits the already-attached fast path after the first resolves.
        expect(chrome.debugger.attach).toHaveBeenCalledTimes(1);
    });

    it('serializes concurrent attach() calls to different tabs without interleaving', async () => {
        const connection = new BrowserConnection();

        await Promise.all([connection.attach(11), connection.attach(22)]);

        // Both tabs get attached, and the final state reflects the last request.
        expect(connection.currentTabId).toBe(22);
        expect(chrome.debugger.attach).toHaveBeenCalledTimes(2);
        // Detach of the first tab happened exactly once (tab switch).
        expect(chrome.debugger.detach).toHaveBeenCalledTimes(1);
    });

    it('fires onAttach callbacks with the tab id on a fresh attach', async () => {
        const connection = new BrowserConnection();
        const calls = [];
        connection.onAttach((tabId) => calls.push(tabId));

        await connection.attach(33);

        expect(calls).toEqual([33]);
    });

    it('does not fire onAttach on the same-tab reattach fast path', async () => {
        const connection = new BrowserConnection();
        const calls = [];
        connection.onAttach((tabId) => calls.push(tabId));

        await connection.attach(33);
        await connection.attach(33); // already-attached fast path, no new session

        expect(calls).toEqual([33]);
    });

    it('fires onAttach again when switching to a different tab (new session)', async () => {
        const connection = new BrowserConnection();
        const calls = [];
        connection.onAttach((tabId) => calls.push(tabId));

        await connection.attach(11);
        await connection.attach(22); // detaches 11, attaches 22 -> new session

        expect(calls).toEqual([11, 22]);
    });

    it('does not fire onAttach when attach fails', async () => {
        createChromeMock({ attachBehavior: 'error' });
        const connection = new BrowserConnection();
        const calls = [];
        connection.onAttach((tabId) => calls.push(tabId));

        await connection.attach(33);

        expect(calls).toEqual([]);
    });
});
