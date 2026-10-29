// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const loadMocks = vi.hoisted(() => {
    let markedGate = Promise.resolve();
    return {
        configureMarkdown: vi.fn(),
        setMarkedGate(promise) {
            markedGate = promise;
        },
        async markedModule() {
            await markedGate;
            return {
                marked: {
                    parse: vi.fn((text) => text),
                    use: vi.fn(),
                    Renderer: class {},
                },
            };
        },
    };
});

vi.mock('katex/dist/katex.min.css', () => ({}));
vi.mock('highlight.js/styles/atom-one-dark.css', () => ({}));
vi.mock('../../shared/logging/debug.js', () => ({
    debugLog: vi.fn(),
}));
vi.mock('../render/config.js', () => ({
    configureMarkdown: loadMocks.configureMarkdown,
}));
vi.mock('marked', () => loadMocks.markedModule());
vi.mock('highlight.js/lib/common', () => ({
    default: { getLanguage: () => false },
}));
vi.mock('katex', () => ({
    default: {},
}));
vi.mock('katex/contrib/auto-render', () => ({
    default: vi.fn(),
}));

describe('markdown dependency loader', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.useRealTimers();
        delete globalThis.marked;
        delete globalThis.hljs;
        delete globalThis.katex;
        delete globalThis.renderMathInElement;
        loadMocks.configureMarkdown.mockReset();
        loadMocks.setMarkedGate(Promise.resolve());
    });

    afterEach(() => {
        vi.useRealTimers();
        delete globalThis.marked;
        delete globalThis.hljs;
        delete globalThis.katex;
        delete globalThis.renderMathInElement;
    });

    it('ensureMarkdownDependencies waits until marked is available', async () => {
        let releaseMarked;
        loadMocks.setMarkedGate(
            new Promise((resolve) => {
                releaseMarked = resolve;
            })
        );

        const { ensureMarkdownDependencies } = await import('./loader.js');
        const readyPromise = ensureMarkdownDependencies();
        let settled = null;
        readyPromise.then((value) => {
            settled = value;
        });

        await Promise.resolve();
        await Promise.resolve();
        expect(settled).toBeNull();
        expect(typeof globalThis.marked).toBe('undefined');

        releaseMarked();
        await expect(readyPromise).resolves.toBe(true);
        expect(typeof globalThis.marked.parse).toBe('function');
        expect(loadMocks.configureMarkdown).toHaveBeenCalled();
    });

    it('ensureMarkdownDependencies returns true immediately when marked is already loaded', async () => {
        globalThis.marked = { parse: vi.fn(), use: vi.fn(), Renderer: class {} };
        const { ensureMarkdownDependencies } = await import('./loader.js');

        await expect(ensureMarkdownDependencies()).resolves.toBe(true);
        expect(loadMocks.configureMarkdown).toHaveBeenCalled();
    });

    it('loadLibs resolves via soft timeout when dependency load is still pending', async () => {
        vi.useFakeTimers();
        // Never resolve marked so the soft 5s timeout is the only completion path.
        // Module-graph caching can make import('marked') instant in other cases;
        // this test still verifies loadLibs does not hang forever.
        loadMocks.setMarkedGate(new Promise(() => {}));

        const { loadLibs } = await import('./loader.js');
        const loadPromise = loadLibs();
        await vi.advanceTimersByTimeAsync(5000);
        await expect(loadPromise).resolves.toBeUndefined();
    });
});
