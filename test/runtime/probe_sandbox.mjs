// @ts-check
/**
 * Probe: boot the COMPILED sandbox bundle (extension/dist/assets/sandbox-*.js)
 * inside jsdom with realistic browser globals, then drive the real
 * parent->sandbox and sandbox->parent message contract.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { createChromeMock } from './chrome_mock.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..', '..');
const extensionDir = path.join(rootDir, 'extension');
const distDir = path.join(extensionDir, 'dist');
const requireFromExtension = createRequire(path.join(extensionDir, 'package.json'));
const { JSDOM } = requireFromExtension('jsdom');

const html = readFileSync(path.join(distDir, 'sandbox', 'index.html'), 'utf8');
const assetMatch = html.match(/<script[^>]+src="([^"]*sandbox-[^"]+\.js)"/);
if (!assetMatch) throw new Error('compiled sandbox entry script not found in dist/sandbox/index.html');
const sandboxEntry = path.resolve(path.dirname(path.join(distDir, 'sandbox', 'index.html')), assetMatch[1]);
console.log('[sandbox-probe] compiled entry:', path.relative(rootDir, sandboxEntry));

const dom = new JSDOM(
    '<!doctype html><html lang="en"><head></head><body><div id="app"></div></body></html>',
    {
        url: 'http://127.0.0.1/sandbox/index.html?theme=dark&lang=en',
        pretendToBeVisual: true,
        runScripts: 'outside-only',
    }
);
const { window } = dom;

const sentToParent = [];
const fakeParent = {
    postMessage(message) {
        sentToParent.push(message);
    },
};

const { chrome } = createChromeMock({ extensionDir: distDir });
const originalWindow = globalThis.window;
const originalDocument = globalThis.document;

function setGlobal(name, value) {
    try {
        Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
    } catch {
        try {
            globalThis[name] = value;
        } catch {
            // Some Node globals are read-only accessors; the sandbox does not
            // depend on them in this harness path.
        }
    }
}

function installGlobals() {
    setGlobal('window', window);
    setGlobal('document', window.document);
    setGlobal('navigator', window.navigator);
    setGlobal('location', window.location);
    setGlobal('HTMLElement', window.HTMLElement);
    setGlobal('Node', window.Node);
    setGlobal('Event', window.Event);
    setGlobal('CustomEvent', window.CustomEvent);
    setGlobal('MessageEvent', window.MessageEvent);
    setGlobal('KeyboardEvent', window.KeyboardEvent);
    setGlobal('MouseEvent', window.MouseEvent);
    setGlobal('MutationObserver', window.MutationObserver);
    setGlobal('getComputedStyle', window.getComputedStyle.bind(window));
    setGlobal('requestAnimationFrame', window.requestAnimationFrame.bind(window));
    setGlobal('cancelAnimationFrame', window.cancelAnimationFrame.bind(window));
    setGlobal('localStorage', window.localStorage);
    setGlobal('chrome', chrome);
    if (typeof window.matchMedia !== 'function') {
        window.matchMedia = (query) => ({
            matches: false,
            media: query,
            onchange: null,
            addEventListener() {},
            removeEventListener() {},
            addListener() {},
            removeListener() {},
            dispatchEvent() {
                return false;
            },
        });
    }
    if (typeof window.ResizeObserver !== 'function') {
        window.ResizeObserver = class ResizeObserver {
            observe() {}
            unobserve() {}
            disconnect() {}
        };
    }
    if (typeof window.IntersectionObserver !== 'function') {
        window.IntersectionObserver = class IntersectionObserver {
            observe() {}
            unobserve() {}
            disconnect() {}
            takeRecords() {
                return [];
            }
        };
    }
}

installGlobals();
try {
    Object.defineProperty(window, 'parent', { value: fakeParent, configurable: true });
} catch (error) {
    console.warn('[sandbox-probe] could not override window.parent:', error.message);
}

process.on('uncaughtException', (error) => {
    console.error('[sandbox-probe] UNCAUGHT:', error?.stack || error);
    process.exitCode = 2;
});
process.on('unhandledRejection', (error) => {
    console.error('[sandbox-probe] UNHANDLED REJECTION:', error?.stack || error); if (error?.cause) console.error('[sandbox-probe] cause:', error.cause?.stack || error.cause);
});

function waitFor(predicate, timeoutMs, label) {
    return new Promise((resolve, reject) => {
        const deadline = Date.now() + timeoutMs;
        const tick = () => {
            try {
                const value = predicate();
                if (value) return resolve(value);
            } catch {}
            if (Date.now() > deadline) return reject(new Error(`timeout: ${label}`));
            setTimeout(tick, 25);
        };
        tick();
    });
}

function dispatchFromParent(message) {
    const event = new window.MessageEvent('message', {
        data: message,
        source: fakeParent,
        origin: 'null',
    });
    window.dispatchEvent(event);
}

try {
    await import(`${pathToFileURL(sandboxEntry).href}?probe=${Date.now()}`);
    console.log('[sandbox-probe] compiled sandbox bundle imported');
    await new Promise((resolve) => setTimeout(resolve, 1200));

    console.log('[sandbox-probe] outbound to parent:', JSON.stringify(sentToParent.map((message) => message.action)));
    const bar = await waitFor(
        () => window.document.getElementById('ncode-harness-bar'),
        8000,
        'harness bar rendered'
    );
    console.log('[sandbox-probe] harness bar rendered:', Boolean(bar));
    console.log('[sandbox-probe] bars status pills:', {
        gemini: window.document.getElementById('ncode-gemini-status')?.textContent?.trim(),
        pc: window.document.getElementById('ncode-pc-status')?.textContent?.trim(),
        preamble: window.document.getElementById('ncode-preamble-text')?.textContent?.trim(),
        goalToggle: window.document.getElementById('ncode-goal-mode-toggle')?.getAttribute('aria-pressed'),
    });

    const stateRequestCount = sentToParent.filter((message) => message.action === 'NCODE_GET_STATE').length;
    console.log('[sandbox-probe] NCODE_GET_STATE requests sent:', stateRequestCount);

    dispatchFromParent({
        action: 'BACKGROUND_MESSAGE',
        payload: {
            action: 'NCODE_HARNESS_STATUS',
            geminiWebConnected: true,
            geminiWebProvider: 'web',
            pcShellConnected: false,
            pcShellEndpoint: 'http://127.0.0.1:3001/mcp',
            pcShellToolCount: 0,
            pcShellError: 'connect ECONNREFUSED 127.0.0.1:3001',
            updatedAt: Date.now(),
        },
    });
    dispatchFromParent({
        action: 'BACKGROUND_MESSAGE',
        payload: {
            action: 'NCODE_PREAMBLE',
            sessionId: 's1',
            workflowId: 'wf1',
            text: 'Inspecting the compiled harness bar.',
            ts: Date.now(),
        },
    });
    dispatchFromParent({
        action: 'BACKGROUND_MESSAGE',
        payload: {
            action: 'NCODE_GOAL_STATE',
            sessionId: 's1',
            workflowId: 'wf1',
            goalSession: {
                workflowId: 'wf1',
                rootGoal: 'Verify the compiled UI',
                subgoals: [
                    { id: 'plan', title: 'Plan the work', role: 'planner', status: 'done', evidence: 'ok' },
                    { id: 'execute', title: 'Execute the work', role: 'pc_coder', status: 'running', evidence: 'tool running' },
                    { id: 'verify', title: 'Verify output', role: 'verifier', status: 'pending', evidence: '' },
                ],
                iterationCount: 1,
                maxIterations: 30,
                status: 'active',
                completionMarked: false,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
            },
        },
    });
    dispatchFromParent({
        action: 'BACKGROUND_MESSAGE',
        payload: {
            action: 'NCODE_COMPACTION_STATE',
            sessionId: 's1',
            workflowId: 'wf1',
            state: 'failed',
            detail: { error: 'PC daemon unreachable at 127.0.0.1:3001' },
            ts: Date.now(),
        },
    });
    await new Promise((resolve) => setTimeout(resolve, 400));

    const text = (id) => window.document.getElementById(id)?.textContent?.trim() || '';
    console.log('[sandbox-probe] after inbound messages:', {
        gemini: text('ncode-gemini-status'),
        pc: text('ncode-pc-status'),
        preamble: text('ncode-preamble-text'),
        goalRoot: text('ncode-goal-root'),
        goalListRows: window.document.querySelectorAll('#ncode-goal-list .ncode-goal-row').length,
        compactButton: text('ncode-compact-btn'),
    });
    const compactClicked = window.document.getElementById('ncode-compact-btn');
    compactClicked?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 250));
    console.log(
        '[sandbox-probe] compact click forwarded:',
        JSON.stringify(sentToParent.filter((message) => message.action === 'NCODE_COMPACT_RESUME'))
    );
    console.log('[sandbox-probe] PROBE COMPLETED');
} catch (error) {
    console.error('[sandbox-probe] FAILED:', error?.stack || error);
    process.exitCode = 1;
} finally {
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
    process.exit(process.exitCode || 0);
}
