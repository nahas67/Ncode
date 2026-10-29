import 'katex/dist/katex.min.css';
// Single hljs palette (atom-one-dark) for both themes: code blocks keep a dark
// surface in light mode too (--code-bg), and one-dark tokens are the only
// palette tuned for that surface. Import order matters — a later theme css
// would win the bare `.hljs` cascade for the whole bundle.
import 'highlight.js/styles/atom-one-dark.css';
import { debugLog } from '../../shared/logging/debug.js';
import { configureMarkdown } from '../render/config.js';

export const MARKDOWN_READY_EVENT = 'gemini-markdown-ready';

let dependencyLoadPromise = null;
let markdownReady = false;

function emitMarkdownReady() {
    if (typeof globalThis.marked === 'undefined') return;

    configureMarkdown();

    if (!markdownReady) {
        markdownReady = true;
        window.dispatchEvent(new CustomEvent(MARKDOWN_READY_EVENT));
    }
}

async function loadBundledDependencies() {
    const [markedModule, highlightModule, katexModule, autoRenderModule] = await Promise.all([
        import('marked'),
        import('highlight.js/lib/common'),
        import('katex'),
        import('katex/contrib/auto-render'),
    ]);

    globalThis.marked = markedModule.marked || markedModule.default || markedModule;
    globalThis.hljs = highlightModule.default || highlightModule;
    globalThis.katex = katexModule.default || katexModule;
    globalThis.renderMathInElement =
        autoRenderModule.default || autoRenderModule.renderMathInElement;
    emitMarkdownReady();
}

function startDependencyLoad() {
    if (!dependencyLoadPromise) {
        dependencyLoadPromise = loadBundledDependencies().catch((error) => {
            dependencyLoadPromise = null;
            throw error;
        });
    }
    return dependencyLoadPromise;
}

/**
 * Wait until Markdown dependencies are fully loaded (no soft timeout).
 * Used by toolbar renderer mode, which has no MARKDOWN_READY re-render path.
 * @returns {Promise<boolean>} true when marked is available
 */
export async function ensureMarkdownDependencies() {
    if (typeof globalThis.marked !== 'undefined') {
        emitMarkdownReady();
        return true;
    }

    try {
        await startDependencyLoad();
        return typeof globalThis.marked !== 'undefined';
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn('Markdown dependency load issue:', message);
        return false;
    }
}

export async function loadLibs() {
    try {
        // Race against a timeout so app startup is never blocked by dependency initialization.
        // Sidepanel listens for MARKDOWN_READY_EVENT and re-renders once marked arrives.
        let timedOut = false;
        let timeoutId = null;
        const dependencyPromise = startDependencyLoad()
            .then(() => true)
            .catch((error) => {
                const message = error instanceof Error ? error.message : String(error);
                console.warn('Markdown dependency load issue:', message);
                return false;
            });

        await Promise.race([
            dependencyPromise,
            new Promise((resolve) => {
                timeoutId = setTimeout(() => {
                    timedOut = true;
                    resolve(false);
                }, 5000);
            }),
        ]);

        if (timeoutId) clearTimeout(timeoutId);

        if (timedOut && typeof globalThis.marked === 'undefined') {
            console.warn('Markdown dependency load issue:', 'Initialization timeout');
        }

        debugLog('Lazy dependencies loading...');
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn('Deferred loading failed', message);
    }
}
