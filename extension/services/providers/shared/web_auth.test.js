import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    ensureGeminiSessionTab,
    extractGeminiWebTokensFromHtml,
    getGeminiWebAuthFromOpenTab,
    getGeminiWebSessionTokens,
    hasCompleteGeminiWebTokens,
    requireCompleteGeminiWebTokens,
} from './web_auth.js';

const LOGGED_IN_HTML =
    '<html lang="en-GB"><script>{"SNlM0e":"at-token","cfb2h":"boq_assistant-bard-web-server_20260511.16_p5","FdrFJe":"3956664217185504700","qKIAYe":"feeds/upload-dynamic","Ylro7b":"client-pctx-token"}</script><div data-index="1"></div></html>';

const TOKENS_FROM_TAB = {
    atValue: 'tab-at-token',
    blValue: 'tab-bl-token',
    fSid: 'tab-fsid-token',
    locale: 'fr-FR',
    authUserIndex: '0',
    uploadPushId: null,
    uploadClientPctx: null,
};

const originalFetch = globalThis.fetch;

/**
 * Builds a chrome mock with the APIs token acquisition touches.
 * @param {{
 *   tabs?: Record<string, Function>,
 *   scripting?: Record<string, Function>,
 * }} [overrides]
 */
function createChromeMock({ tabs = {}, scripting = {} } = {}) {
    return {
        tabs: {
            query: vi.fn(async () => []),
            get: vi.fn(async (tabId) => ({ id: tabId, status: 'complete' })),
            create: vi.fn(async (options) => ({
                id: 99,
                status: 'complete',
                url: options?.url,
            })),
            remove: vi.fn(async () => {}),
            ...tabs,
        },
        scripting: {
            executeScript: vi.fn(async () => [{ result: TOKENS_FROM_TAB }]),
            ...scripting,
        },
    };
}

/**
 * Installs a fetch mock returning the logged-in app HTML.
 * @param {string} html
 */
function mockFetchHtml(html) {
    globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve(html),
    });
}

describe('extractGeminiWebTokensFromHtml', () => {
    it('parses all request and optional upload tokens plus the account index', () => {
        expect(extractGeminiWebTokensFromHtml(LOGGED_IN_HTML)).toEqual({
            atValue: 'at-token',
            blValue: 'boq_assistant-bard-web-server_20260511.16_p5',
            fSid: '3956664217185504700',
            locale: 'en-GB',
            authUserIndex: '1',
            uploadPushId: 'feeds/upload-dynamic',
            uploadClientPctx: 'client-pctx-token',
        });
    });

    it('keeps the requested account index and returns null for missing optional tokens', () => {
        const tokens = extractGeminiWebTokensFromHtml(
            '<html><script>{"SNlM0e":"at-only"}</script></html>',
            { userIndex: '3' }
        );

        expect(tokens).toMatchObject({
            atValue: 'at-only',
            blValue: null,
            fSid: null,
            locale: 'en-US',
            authUserIndex: '3',
            uploadPushId: null,
            uploadClientPctx: null,
        });
        expect(hasCompleteGeminiWebTokens(tokens)).toBe(false);
    });

    it('never throws on non-string input', () => {
        expect(extractGeminiWebTokensFromHtml(null)).toMatchObject({ atValue: null });
    });
});

describe('requireCompleteGeminiWebTokens', () => {
    it('throws the canonical token-unavailable error naming missing fields', () => {
        expect(() =>
            requireCompleteGeminiWebTokens(
                { atValue: 'at', blValue: null, fSid: null },
                { userIndex: '2' }
            )
        ).toThrow(
            'Gemini Web request tokens unavailable for account 2: blValue, fSid. Please log in to gemini.google.com or refresh Gemini.'
        );
    });
});

describe('getGeminiWebSessionTokens', () => {
    beforeEach(() => {
        vi.stubGlobal('chrome', createChromeMock());
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it('uses the credentialed app-page fetch first and reports source fetch', async () => {
        mockFetchHtml(LOGGED_IN_HTML);
        const chromeMock = globalThis.chrome;

        await expect(getGeminiWebSessionTokens()).resolves.toEqual({
            atValue: 'at-token',
            blValue: 'boq_assistant-bard-web-server_20260511.16_p5',
            fSid: '3956664217185504700',
            locale: 'en-GB',
            authUserIndex: '1',
            uploadPushId: 'feeds/upload-dynamic',
            uploadClientPctx: 'client-pctx-token',
            source: 'fetch',
        });
        expect(globalThis.fetch).toHaveBeenCalledWith(
            'https://gemini.google.com/app',
            expect.objectContaining({ method: 'GET', credentials: 'include' })
        );
        expect(chromeMock.tabs.query).not.toHaveBeenCalled();
    });

    it('falls back to reading tokens from an already open Gemini tab', async () => {
        globalThis.fetch = vi.fn().mockRejectedValue(new Error('Failed to fetch'));
        const chromeMock = globalThis.chrome;
        chromeMock.tabs.query.mockResolvedValue([
            { id: 3, status: 'complete', url: 'https://gemini.google.com/app' },
        ]);

        await expect(getGeminiWebSessionTokens()).resolves.toEqual({
            ...TOKENS_FROM_TAB,
            source: 'tab',
        });
        expect(chromeMock.tabs.query).toHaveBeenCalledWith({
            url: 'https://gemini.google.com/*',
        });
        expect(chromeMock.scripting.executeScript).toHaveBeenCalledWith(
            expect.objectContaining({ target: { tabId: 3 }, func: expect.any(Function) })
        );
        expect(chromeMock.tabs.create).not.toHaveBeenCalled();
        expect(chromeMock.tabs.remove).not.toHaveBeenCalled();
    });

    it('creates a pinned background tab when no Gemini tab exists and cleans it up', async () => {
        globalThis.fetch = vi.fn().mockRejectedValue(new Error('Failed to fetch'));
        const chromeMock = globalThis.chrome;
        chromeMock.tabs.query.mockResolvedValue([]);
        chromeMock.tabs.create.mockResolvedValue({
            id: 11,
            status: 'complete',
            url: 'https://gemini.google.com/app',
        });

        await expect(getGeminiWebSessionTokens()).resolves.toEqual({
            ...TOKENS_FROM_TAB,
            source: 'created-tab',
        });
        expect(chromeMock.tabs.create).toHaveBeenCalledWith({
            url: 'https://gemini.google.com/app',
            active: false,
            pinned: true,
        });
        expect(chromeMock.tabs.remove).toHaveBeenCalledWith(11);
    });

    it('reports a clear token-unavailable error when every layer fails', async () => {
        mockFetchHtml('<html><script>{"SNlM0e":"at-only"}</script></html>');
        const chromeMock = globalThis.chrome;
        chromeMock.tabs.query.mockResolvedValue([]);

        await expect(getGeminiWebSessionTokens({ allowTabCreation: false })).rejects.toThrow(
            /Unable to acquire Gemini Web session tokens/
        );
        await expect(getGeminiWebSessionTokens({ allowTabCreation: false })).rejects.toThrow(
            /Gemini Web request tokens unavailable for account 0: blValue, fSid/
        );
        expect(chromeMock.tabs.create).not.toHaveBeenCalled();
    });

    it('honours an already-aborted signal without touching chrome APIs', async () => {
        const controller = new AbortController();
        controller.abort();
        const chromeMock = globalThis.chrome;

        await expect(
            getGeminiWebSessionTokens({ signal: controller.signal })
        ).rejects.toMatchObject({ name: 'AbortError' });
        expect(chromeMock.tabs.query).not.toHaveBeenCalled();
    });
});

describe('getGeminiWebAuthFromOpenTab', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it('returns null when the tabs API is unavailable', async () => {
        vi.stubGlobal('chrome', {});
        await expect(getGeminiWebAuthFromOpenTab()).resolves.toBeNull();
    });

    it('skips tabs that do not expose complete tokens and returns the first valid one', async () => {
        const executeScript = vi
            .fn()
            .mockResolvedValueOnce([{ result: { atValue: 'incomplete' } }])
            .mockResolvedValueOnce([{ result: TOKENS_FROM_TAB }]);
        vi.stubGlobal(
            'chrome',
            createChromeMock({
                tabs: {
                    query: vi.fn(async () => [
                        { id: 1, discarded: false, url: 'https://gemini.google.com/app' },
                        { id: 2, discarded: false, url: 'https://gemini.google.com/app' },
                    ]),
                },
                scripting: { executeScript },
            })
        );

        await expect(getGeminiWebAuthFromOpenTab()).resolves.toEqual({
            ...TOKENS_FROM_TAB,
            source: 'tab',
        });
        expect(executeScript).toHaveBeenCalledTimes(2);
    });
});

describe('ensureGeminiSessionTab', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it('reuses an open tab without creating or removing anything', async () => {
        const chromeMock = createChromeMock({
            tabs: {
                query: vi.fn(async () => [
                    { id: 5, status: 'complete', url: 'https://gemini.google.com/app' },
                ]),
            },
        });
        vi.stubGlobal('chrome', chromeMock);

        await expect(ensureGeminiSessionTab()).resolves.toEqual({
            tabId: 5,
            created: false,
            tokens: TOKENS_FROM_TAB,
        });
        expect(chromeMock.tabs.create).not.toHaveBeenCalled();
        expect(chromeMock.tabs.remove).not.toHaveBeenCalled();
    });

    it('creates a pinned background tab and returns created=true without removing it', async () => {
        const chromeMock = createChromeMock();
        vi.stubGlobal('chrome', chromeMock);

        await expect(ensureGeminiSessionTab()).resolves.toEqual({
            tabId: 99,
            created: true,
            tokens: TOKENS_FROM_TAB,
        });
        expect(chromeMock.tabs.create).toHaveBeenCalledTimes(1);
        expect(chromeMock.tabs.remove).not.toHaveBeenCalled();
    });

    it('throws when tab creation is disabled and no tab exists', async () => {
        vi.stubGlobal('chrome', createChromeMock());

        await expect(ensureGeminiSessionTab({ allowTabCreation: false })).rejects.toThrow(
            /No open Gemini tab is available/
        );
    });
});
