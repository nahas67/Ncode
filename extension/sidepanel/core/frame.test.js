// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FrameManager } from './frame.js';

describe('FrameManager', () => {
    beforeEach(() => {
        document.body.innerHTML = `
            <div id="skeleton"></div>
            <iframe id="sandbox-frame"></iframe>
        `;
        localStorage.clear();
        globalThis.chrome = {
            runtime: {
                getURL: vi.fn((path) => `chrome-extension://test-id/${path}`),
            },
        };
    });

    it('loads the sandbox iframe with an absolute extension URL', () => {
        localStorage.setItem('geminiTheme', 'dark');
        localStorage.setItem('geminiLanguage', 'zh-CN');

        const manager = new FrameManager();
        manager.init();

        expect(chrome.runtime.getURL).toHaveBeenCalledWith(
            'sandbox/index.html?theme=dark&lang=zh-CN'
        );
        expect(document.getElementById('sandbox-frame').src).toBe(
            'chrome-extension://test-id/sandbox/index.html?theme=dark&lang=zh-CN'
        );
    });

    it('passes the cached sidebar expanded state to the sandbox URL', () => {
        localStorage.setItem('geminiTheme', 'dark');
        localStorage.setItem('geminiLanguage', 'zh-CN');
        localStorage.setItem('geminiSidebarExpanded', 'false');

        const manager = new FrameManager();
        manager.init();

        expect(chrome.runtime.getURL).toHaveBeenCalledWith(
            'sandbox/index.html?theme=dark&lang=zh-CN&sidebarExpanded=false'
        );
    });

    it('falls back to the local sandbox URL when chrome.runtime is unavailable', () => {
        delete globalThis.chrome;
        localStorage.setItem('geminiTheme', 'light');
        localStorage.setItem('geminiLanguage', 'en');

        const manager = new FrameManager();
        manager.init();

        expect(document.getElementById('sandbox-frame').src).toBe(
            'http://localhost:3000/sandbox/index.html?theme=light&lang=en'
        );
    });

    it('posts to the sandbox contentWindow with wildcard origin (opaque sandbox)', () => {
        const contentWindow = { postMessage: vi.fn() };
        Object.defineProperty(document.getElementById('sandbox-frame'), 'contentWindow', {
            configurable: true,
            get: () => contentWindow,
        });

        const manager = new FrameManager();
        const payload = { action: 'BACKGROUND_MESSAGE', payload: { action: 'GEMINI_REPLY' } };
        manager.postMessage(payload);

        // Must not use chrome-extension:// (silent drop) or 'null' (Chrome throws).
        expect(contentWindow.postMessage).toHaveBeenCalledWith(payload, '*');
        expect(contentWindow.postMessage).not.toHaveBeenCalledWith(
            expect.anything(),
            expect.stringMatching(/^chrome-extension:/)
        );
        expect(contentWindow.postMessage).not.toHaveBeenCalledWith(expect.anything(), 'null');
    });

    it('still posts with * when chrome.runtime is unavailable in local dev', () => {
        delete globalThis.chrome;
        const contentWindow = { postMessage: vi.fn() };
        Object.defineProperty(document.getElementById('sandbox-frame'), 'contentWindow', {
            configurable: true,
            get: () => contentWindow,
        });

        const manager = new FrameManager();
        const payload = { action: 'RESTORE_THEME', payload: 'dark' };
        manager.postMessage(payload);

        expect(contentWindow.postMessage).toHaveBeenCalledWith(payload, '*');
    });

    it('no-ops when the sandbox iframe has no contentWindow', () => {
        const iframe = document.getElementById('sandbox-frame');
        const contentWindow = { postMessage: vi.fn() };
        let windowRef = null;
        Object.defineProperty(iframe, 'contentWindow', {
            configurable: true,
            get: () => windowRef,
        });

        const manager = new FrameManager();
        expect(() => manager.postMessage({ action: 'PING' })).not.toThrow();
        expect(contentWindow.postMessage).not.toHaveBeenCalled();

        // Restore a window-like object so jsdom teardown can close the iframe.
        windowRef = contentWindow;
    });
});
