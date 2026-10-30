// @ts-check
/**
 * Ncode end-to-end runtime test.
 *
 * Runs without a live Chrome profile and without network access:
 *   1. packaged extension verification (`extension/dist/manifest.json`, assets,
 *      manifest-referenced files, css/ and no test leakage);
 *   2. boots a real `pc-daemon/server.mjs` on ephemeral ports and drives its
 *      Streamable-HTTP MCP endpoint (initialize, tools/list, pc_exec_shell echo,
 *      stateful per-workflow cwd);
 *   3. exercises the real three-layer message pipeline: sandbox postMessage ->
 *      sidepanel frame/bridge/window_actions -> background runtime listener ->
 *      broadcast back to the sandbox frame (+ sandbox AppMessageBridge dispatch
 *      to the UI controller), including an approval request/response round-trip;
 *   4. exercises Compact & Resume against the real compact manager + context
 *      manager: checkpoint written to chrome.storage.local and mirrored through
 *      the running daemon to `<state-dir>/workflows/<workflowId>.json`, web
 *      conversation cursor reset to null/null/null, hydration text carries the
 *      pending subgoal and next action.
 *
 * Usage (from the repository root):
 *   node test/runtime/e2e.mjs
 *
 * Output: one `PASS <id> <description>` or `FAIL <id> <description> <error>` line
 * per check, a final summary, and a non-zero exit code on any failure.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { spawn } from 'node:child_process';
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    rmSync,
    statSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createChromeMock, waitFor } from './chrome_mock.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..', '..');
const extensionDir = path.join(rootDir, 'extension');
const distDir = path.join(extensionDir, 'dist');
const daemonPath = path.join(rootDir, 'pc-daemon', 'server.mjs');

const HTTP_TIMEOUT_MS = 5000;
const TOTAL_BUDGET_MS = 120_000;
const startedAt = Date.now();

let checks = 0;
let failures = 0;
/** @type {string[]} */
const failureLines = [];

/** @param {string} id @param {string} description @param {boolean} ok @param {unknown} [error] */
function check(id, description, ok, error) {
    checks += 1;
    if (ok) {
        console.log(`PASS ${id} ${description}`);
        return true;
    }
    failures += 1;
    const tail = error === undefined ? '' : ` :: ${formatError(error)}`;
    const line = `FAIL ${id} ${description}${tail}`;
    failureLines.push(line);
    console.error(line);
    return false;
}

function formatError(error) {
    if (error === null || error === undefined) return '';
    const text = error instanceof Error ? error.stack || error.message : String(error);
    return text.replace(/\r?\n/g, ' | ').slice(0, 900);
}

function section(title) {
    console.log(`\n--- ${title} ---`);
}

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function nodeCheck(file) {
    const { spawnSync } = process.getBuiltinModule('node:child_process');
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    return result.status === 0;
}

async function withTimeout(promise, timeoutMs, label) {
    let timer = null;
    try {
        return await Promise.race([
            promise,
            new Promise((_resolve, reject) => {
                timer = setTimeout(
                    () => reject(new Error(`Timed out after ${timeoutMs}ms: ${label}`)),
                    timeoutMs
                );
                timer.unref?.();
            }),
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

function collectFiles(directory) {
    /** @type {string[]} */
    const files = [];
    if (!existsSync(directory)) return files;
    const stack = [directory];
    while (stack.length > 0) {
        const current = stack.pop();
        for (const entry of readdirSync(current, { withFileTypes: true })) {
            const absolute = path.join(current, entry.name);
            if (entry.isDirectory()) stack.push(absolute);
            else if (entry.isFile()) files.push(absolute);
        }
    }
    return files;
}

// ---------------------------------------------------------------------------
// 1. Packaged extension (dist) verification
// ---------------------------------------------------------------------------

const REQUIRED_HOST_PERMISSIONS = [
    'http://127.0.0.1/*',
    'http://localhost/*',
    'ws://127.0.0.1/*',
    'https://gemini.google.com/*',
];

function collectManifestReferences(manifest) {
    /** @type {string[]} */
    const references = [];
    const add = (reference) => {
        if (typeof reference !== 'string' || reference.length === 0) return;
        if (/^(?:https?:|data:|chrome-extension:)/i.test(reference)) return;
        references.push(reference.replace(/^\/+/, ''));
    };
    add(manifest.background?.service_worker);
    add(manifest.side_panel?.default_path);
    for (const page of manifest.sandbox?.pages || []) add(page);
    for (const icon of Object.values(manifest.icons || {})) add(icon);
    for (const icon of Object.values(manifest.action?.default_icon || {})) add(icon);
    for (const entry of manifest.content_scripts || []) {
        for (const file of entry.js || []) add(file);
        for (const file of entry.css || []) add(file);
    }
    for (const resource of manifest.web_accessible_resources || []) {
        for (const file of resource.resources || []) add(file);
    }
    return [...new Set(references)];
}

async function runDistChecks() {
    section('extension/dist packaged extension');
    if (!check('dist.exists', 'extension/dist exists', existsSync(distDir))) return;

    const distManifestPath = path.join(distDir, 'manifest.json');
    let manifest = null;
    try {
        manifest = JSON.parse(readFileSync(distManifestPath, 'utf8'));
        check('dist.manifest.json', 'dist manifest.json is valid JSON', true);
    } catch (error) {
        check('dist.manifest.json', 'dist manifest.json is valid JSON', false, error);
        return;
    }

    const sourceManifest = JSON.parse(
        readFileSync(path.join(extensionDir, 'manifest.json'), 'utf8')
    );
    check(
        'dist.manifest.identity',
        'dist manifest name+version mirror extension/manifest.json',
        manifest.name === sourceManifest.name && manifest.version === sourceManifest.version,
        `${manifest.name}@${manifest.version} vs ${sourceManifest.name}@${sourceManifest.version}`
    );
    check(
        'dist.manifest.mv3',
        'dist manifest is MV3 with a module service worker and side panel/sandbox pages',
        manifest.manifest_version === 3 &&
            manifest.background?.service_worker === 'background/index.js' &&
            manifest.background?.type === 'module' &&
            manifest.side_panel?.default_path === 'sidepanel/index.html' &&
            (manifest.sandbox?.pages || []).includes('sandbox/index.html')
    );

    const hostPermissions = manifest.host_permissions || [];
    const missingHosts = REQUIRED_HOST_PERMISSIONS.filter(
        (pattern) => !hostPermissions.includes(pattern)
    );
    check(
        'dist.manifest.host_permissions',
        'dist manifest explicitly declares the local daemon + Gemini Web origin patterns',
        missingHosts.length === 0,
        `missing: ${missingHosts.join(', ')}`
    );

    const geminiBridgeEntry = (manifest.content_scripts || []).find((entry) =>
        (entry.js || []).includes('content/gemini_dom_bridge.js')
    );
    check(
        'dist.manifest.gemini_dom_bridge',
        'content/gemini_dom_bridge.js is an unbundled content script for https://gemini.google.com/*',
        Boolean(geminiBridgeEntry) &&
            (geminiBridgeEntry.matches || []).includes('https://gemini.google.com/*') &&
            existsSync(path.join(distDir, 'content', 'gemini_dom_bridge.js')),
        geminiBridgeEntry ? 'entry present but file missing' : 'content_scripts entry missing'
    );

    const originReference = (() => {
        const entry = (manifest.content_scripts || []).find((candidate) =>
            (candidate.js || []).includes('content/index.js')
        );
        return entry ? 'content/index.js' : null;
    })();
    check(
        'dist.manifest.content_bundle',
        'a page content-script bundle is declared',
        Boolean(originReference) || (manifest.content_scripts || []).length > 0
    );

    const missingManifestFiles = [];
    for (const reference of collectManifestReferences(manifest)) {
        if (reference.includes('*')) {
            const baseDirectory = reference.split('*')[0].replace(/\/?$/, '');
            const parent = baseDirectory.includes('/')
                ? path.dirname(path.join(distDir, baseDirectory))
                : distDir;
            if (!existsSync(parent)) missingManifestFiles.push(reference);
            continue;
        }
        if (!existsSync(path.join(distDir, reference))) missingManifestFiles.push(reference);
    }
    check(
        'dist.manifest.files_present',
        'every manifest-referenced content script/background/sandbox/icon resource exists inside dist',
        missingManifestFiles.length === 0,
        missingManifestFiles.slice(0, 8).join(', ')
    );

    const htmlPages = ['sidepanel/index.html', 'sandbox/index.html', 'settings/index.html'];
    const missingHtmlReferences = [];
    for (const page of htmlPages) {
        const absolutePage = path.join(distDir, page);
        if (!existsSync(absolutePage)) {
            missingHtmlReferences.push(`${page} (missing page)`);
            continue;
        }
        const html = readFileSync(absolutePage, 'utf8');
        for (const match of html.matchAll(/\b(?:src|href)="([^"]+)"/g)) {
            const reference = match[1];
            if (/^(?:https?:|data:|#)/.test(reference)) continue;
            const clean = reference.split(/[?#]/)[0];
            const resolved = path.resolve(path.dirname(absolutePage), clean);
            if (!existsSync(resolved)) missingHtmlReferences.push(`${page} -> ${reference}`);
        }
    }
    check(
        'dist.pages.assets',
        'sidepanel/sandbox/settings HTML only reference existing local assets',
        missingHtmlReferences.length === 0,
        missingHtmlReferences.slice(0, 8).join('; ')
    );

    check(
        'dist.css.ncode_harness',
        'dist/css/ncode_harness.css exists (full css/ directory packaged)',
        existsSync(path.join(distDir, 'css', 'ncode_harness.css'))
    );
    check(
        'dist.layout',
        'dist ships background/content/sandbox/sidepanel/services/shared/settings/css/assets/vendor/logo.png',
        [
            'background',
            'content',
            'sandbox',
            'sidepanel',
            'services',
            'shared',
            'settings',
            'css',
            'assets',
            'vendor',
            'logo.png',
        ].every((entry) => existsSync(path.join(distDir, entry)))
    );

    const distFiles = collectFiles(distDir);
    const shippedTests = distFiles.filter((file) => /\.(?:test|spec)\.(?:js|ts)$/.test(file));
    check(
        'dist.no_tests',
        'dist ships no *.test.js / test fixture files',
        shippedTests.length === 0,
        shippedTests.slice(0, 3).join(', ')
    );
    check(
        'dist.no_node_modules',
        'dist contains no node_modules directory',
        !distFiles.some((file) => file.split(path.sep).includes('node_modules'))
    );

    const buildInfoPath = path.join(distDir, 'ncode-build-info.json');
    let buildInfoOk = false;
    let buildInfoDetail = 'missing';
    if (existsSync(buildInfoPath)) {
        try {
            const buildInfo = JSON.parse(readFileSync(buildInfoPath, 'utf8'));
            buildInfoOk =
                buildInfo.version === sourceManifest.version && Number(buildInfo.payloadFiles) > 0;
            buildInfoDetail = `v${buildInfo.version}, ${buildInfo.payloadFiles} files`;
        } catch (error) {
            buildInfoDetail = formatError(error);
        }
    }
    check(
        'dist.build_info',
        'dist/ncode-build-info.json records the source version and payload file count',
        buildInfoOk,
        buildInfoDetail
    );
}

// ---------------------------------------------------------------------------
// 2. PC daemon over Streamable HTTP MCP
// ---------------------------------------------------------------------------

function startDaemon({ stateDir }) {
    const child = spawn(
        process.execPath,
        [daemonPath, '--http-port', '0', '--ws-port', '0', '--no-ws'],
        {
            cwd: rootDir,
            env: { ...process.env, NCODE_STATE_DIR: stateDir, NCODE_DEBUG: '0' },
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
        }
    );
    let stderr = '';
    let stdout = '';
    /** @type {{code:number|null, signal:string|null}|null} */
    let exitInfo = null;
    /** @type {((info:{code:number|null, signal:string|null})=>void)[]} */
    const exitWaiters = [];
    child.stderr.on('data', (chunk) => {
        stderr += chunk.toString('utf8');
    });
    child.stdout.on('data', (chunk) => {
        stdout += chunk.toString('utf8');
    });
    child.on('exit', (code, signal) => {
        exitInfo = { code, signal };
        for (const waiter of exitWaiters.splice(0)) waiter(exitInfo);
    });
    const handle = {
        child,
        get stderr() {
            return stderr;
        },
        get stdout() {
            return stdout;
        },
        bannerLine() {
            return (
                stderr.split(/\r?\n/).find((line) => line.includes('[ncode-pc-daemon] http=')) ||
                null
            );
        },
        async waitForBanner(timeoutMs = 15_000) {
            const line = await waitFor(() => handle.bannerLine(), {
                timeoutMs,
                intervalMs: 25,
                label: 'pc-daemon startup banner',
            });
            if (!line) {
                throw new Error(
                    `pc-daemon printed no startup banner.\nstderr tail:\n${stderr.slice(-4000)}`
                );
            }
            const match = line.match(/http=(http:\/\/[^\s]+?)\/mcp/);
            if (!match) throw new Error(`Unable to parse daemon banner: ${line}`);
            return { line, httpBaseUrl: match[1] };
        },
        async stop() {
            if (exitInfo) return exitInfo;
            try {
                child.kill('SIGTERM');
            } catch {
                // ignore
            }
            const info = await withTimeout(
                new Promise((resolve) => {
                    if (exitInfo) return resolve(exitInfo);
                    exitWaiters.push(resolve);
                }),
                6000,
                'daemon exit'
            ).catch(() => null);
            if (!info) {
                try {
                    child.kill('SIGKILL');
                } catch {
                    // ignore
                }
            }
            return info;
        },
    };
    return handle;
}

async function httpJson(url, { method = 'GET', body = undefined, headers = undefined } = {}) {
    const response = await fetch(url, {
        method,
        headers: {
            Accept: 'application/json, text/event-stream',
            ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
            ...(headers || {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    const text = await response.text();
    let json = null;
    try {
        json = text ? JSON.parse(text) : null;
    } catch {
        json = null;
    }
    return { status: response.status, headers: response.headers, text, json };
}

function extractToolResult(result) {
    const content = result && Array.isArray(result.content) ? result.content : null;
    if (!content) {
        return { isError: true, text: JSON.stringify(result ?? null), payload: null };
    }
    const text = content
        .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
        .map((part) => part.text)
        .join('\n');
    let payload = null;
    try {
        payload = JSON.parse(text);
    } catch {
        payload = null;
    }
    return { isError: result.isError === true, text, payload };
}

function createMcpClient(httpBaseUrl) {
    let nextId = 1;
    async function post(payload) {
        return httpJson(`${httpBaseUrl}/mcp`, { method: 'POST', body: payload });
    }
    async function request(method, params) {
        const response = await post({ jsonrpc: '2.0', id: nextId++, method, params });
        if (!response.json) {
            throw new Error(
                `MCP ${method} returned no JSON (status ${response.status}): ${response.text.slice(0, 300)}`
            );
        }
        if (response.json.error) {
            throw new Error(`MCP ${method} failed: ${JSON.stringify(response.json.error)}`);
        }
        return response.json.result;
    }
    return {
        httpBaseUrl,
        request,
        async initialize() {
            return request('initialize', {
                protocolVersion: '2025-03-26',
                capabilities: {},
                clientInfo: { name: 'ncode-e2e', version: '1.0.0' },
            });
        },
        async notifyInitialized() {
            return post({ jsonrpc: '2.0', method: 'notifications/initialized' });
        },
        async listTools() {
            const result = await request('tools/list', {});
            return (result && result.tools) || [];
        },
        async callTool(name, args = {}) {
            const result = await request('tools/call', { name, arguments: args });
            return { ...extractToolResult(result), result };
        },
    };
}

/** @type {{ handle: any, client: any, stateDir: string|null }} */
const daemonRuntime = { handle: null, client: null, stateDir: null };

async function runDaemonChecks() {
    section('pc-daemon Streamable HTTP MCP');
    if (!check('daemon.entry', 'pc-daemon/server.mjs exists and parses', existsSync(daemonPath) && nodeCheck(daemonPath))) {
        return;
    }
    const stateDir = mkdtempSync(path.join(os.tmpdir(), 'ncode-e2e-state-'));
    daemonRuntime.stateDir = stateDir;
    const handle = startDaemon({ stateDir });
    daemonRuntime.handle = handle;
    try {
        const { httpBaseUrl } = await handle.waitForBanner();
        check('daemon.boot', 'pc-daemon booted on ephemeral HTTP port', true, '');
        const client = createMcpClient(httpBaseUrl);
        daemonRuntime.client = client;

        const init = await withTimeout(client.initialize(), HTTP_TIMEOUT_MS, 'MCP initialize');
        check(
            'daemon.mcp.initialize',
            'MCP initialize returns protocol version + server info',
            Boolean(init?.protocolVersion) && Boolean(init?.serverInfo?.name),
            JSON.stringify(init?.serverInfo || null)
        );
        const initialized = await withTimeout(
            client.notifyInitialized(),
            HTTP_TIMEOUT_MS,
            'MCP notifications/initialized'
        );
        check(
            'daemon.mcp.initialized',
            'notifications/initialized is accepted (202 Accepted)',
            initialized.status === 202,
            `status ${initialized.status}`
        );

        const tools = await withTimeout(client.listTools(), HTTP_TIMEOUT_MS, 'MCP tools/list');
        const toolNames = tools.map((tool) => tool.name);
        const requiredTools = [
            'pc_exec_shell',
            'pc_system_info',
            'workflow_save_checkpoint',
            'workflow_load_checkpoint',
            'workflow_list_checkpoints',
            'pc_shell_session',
        ];
        const missingTools = requiredTools.filter((name) => !toolNames.includes(name));
        check(
            'daemon.mcp.tools_list',
            'tools/list exposes the PC shell + workflow checkpoint tools',
            missingTools.length === 0,
            missingTools.join(', ')
        );

        const execShellTool = tools.find((tool) => tool.name === 'pc_exec_shell');
        const workflowIdSchema = execShellTool?.inputSchema?.properties?.workflowId;
        check(
            'daemon.mcp.stateful_shell_support',
            'pc_exec_shell schema accepts a per-workflowId stateful session (cwd/env persistence)',
            Boolean(workflowIdSchema) && typeof workflowIdSchema.type === 'string',
            execShellTool ? 'workflowId property missing from pc_exec_shell inputSchema' : 'pc_exec_shell missing'
        );

        const echo = await withTimeout(
            client.callTool('pc_exec_shell', { command: 'echo ncode-e2e-ok' }),
            HTTP_TIMEOUT_MS,
            'pc_exec_shell echo'
        );
        check(
            'daemon.exec.echo',
            'pc_exec_shell runs echo and captures stdout/exitCode',
            echo.isError === false &&
                echo.payload?.exitCode === 0 &&
                String(echo.payload?.stdout || '').includes('ncode-e2e-ok'),
            echo.text.slice(0, 400)
        );

        const cwdProbe = path.join(stateDir, 'cwd-probe');
        mkdirSync(cwdProbe, { recursive: true });
        const cd = await withTimeout(
            client.callTool('pc_exec_shell', {
                workflowId: 'e2e-workflow',
                command: `cd ${cwdProbe}`,
            }),
            HTTP_TIMEOUT_MS,
            'pc_exec_shell stateful cd'
        );
        const pwd = await withTimeout(
            client.callTool('pc_exec_shell', { workflowId: 'e2e-workflow', command: 'pwd' }),
            HTTP_TIMEOUT_MS,
            'pc_exec_shell stateful pwd'
        );
        const reportedCwd = String(pwd.payload?.cwd || pwd.payload?.stdout || '').trim();
        check(
            'daemon.exec.stateful_cwd',
            'pc_exec_shell workflowId keeps the cwd across calls',
            cd.isError === false &&
                pwd.isError === false &&
                path.normalize(reportedCwd) === path.normalize(cwdProbe),
            `reported=${reportedCwd} expected=${cwdProbe} :: ${pwd.text.slice(0, 300)}`
        );
    } catch (error) {
        check('daemon.harness', 'pc-daemon HTTP MCP harness completed', false, error);
    }
}

// ---------------------------------------------------------------------------
// 3. Three-layer sandbox -> sidepanel -> background -> sandbox pipeline
// ---------------------------------------------------------------------------

function createEventWindow(name) {
    /** @type {Map<string, Set<Function>>} */
    const listeners = new Map();
    const windowShim = {
        name,
        parent: null,
        location: { href: `chrome-extension://ncodee2etest/${name}` },
        addEventListener(type, listener) {
            if (typeof listener !== 'function') return;
            if (!listeners.has(type)) listeners.set(type, new Set());
            listeners.get(type).add(listener);
        },
        removeEventListener(type, listener) {
            listeners.get(type)?.delete(listener);
        },
        dispatchEvent(type, event) {
            for (const listener of [...(listeners.get(type) || [])]) {
                try {
                    listener(event);
                } catch (error) {
                    console.error(`[e2e] ${name} ${type} listener threw:`, error);
                }
            }
        },
        postMessage(message) {
            // Sandbox postMessage: deliver the message event to this window and
            // temporarily expose it as the global window so `window.parent`
            // checks inside the real sandbox handler keep working.
            const previousWindow = globalThis.window;
            globalThis.window = windowShim;
            try {
                windowShim.dispatchEvent('message', {
                    data: message,
                    source: windowShim.parent,
                    origin: 'null',
                });
            } finally {
                globalThis.window = previousWindow;
            }
        },
        listenersFor(type) {
            return [...(listeners.get(type) || [])];
        },
    };
    return windowShim;
}

/**
 * Context-aware chrome.runtime message bus: every listener is tagged with the
 * ALS context it was registered from, and outbound sendMessage calls are
 * delivered to listeners in every *other* context (matching Chrome's rule that
 * the sending context does not receive its own message).
 */
function createMessageBus(chrome) {
    const als = new AsyncLocalStorage();
    /** @type {{context: string, listener: Function}[]} */
    const listeners = [];
    /** @type {{context: string, message: any}[]} */
    const sendLog = [];
    const runtimeEvent = {
        addListener(listener) {
            listeners.push({ context: als.getStore() || 'neutral', listener });
        },
        removeListener(listener) {
            const index = listeners.findIndex((entry) => entry.listener === listener);
            if (index !== -1) listeners.splice(index, 1);
        },
        hasListener(listener) {
            return listeners.some((entry) => entry.listener === listener);
        },
        hasListeners() {
            return listeners.length > 0;
        },
        get listeners() {
            return listeners.map((entry) => entry.listener);
        },
    };
    chrome.runtime.onMessage = runtimeEvent;

    function invokeListener(entry, message) {
        return new Promise((resolve) => {
            let settled = false;
            let timer = null;
            const finish = (value) => {
                if (settled) return;
                settled = true;
                if (timer) clearTimeout(timer);
                resolve(value);
            };
            timer = setTimeout(() => finish(undefined), HTTP_TIMEOUT_MS);
            timer.unref?.();
            const sendResponse = (value) => finish(value);
            let keepOpen = false;
            try {
                keepOpen = als.run(entry.context, () =>
                    entry.listener(
                        message,
                        {
                            id: 'ncodee2etest',
                            url: 'chrome-extension://ncodee2etest/sidepanel/index.html',
                        },
                        sendResponse
                    )
                );
            } catch (error) {
                console.error('[e2e] runtime message listener threw:', error);
                finish(undefined);
                return;
            }
            if (keepOpen !== true && !settled) {
                queueMicrotask(() => finish(undefined));
            }
        });
    }

    chrome.runtime.sendMessage = async (message) => {
        const context = als.getStore() || 'neutral';
        sendLog.push({ context, message });
        let response;
        for (const entry of [...listeners]) {
            if (entry.context === context) continue;
            const value = await invokeListener(entry, message);
            if (value !== undefined && response === undefined) response = value;
        }
        return response;
    };

    return {
        runAs(context, callback) {
            return als.run(context, callback);
        },
        currentContext() {
            return als.getStore() || 'neutral';
        },
        sendLog,
        listeners,
        runtimeEvent,
    };
}

function registerLooseGlobals({ windowShim, documentShim, localStorageShim, chromeShim }) {
    globalThis.window = windowShim;
    globalThis.document = documentShim;
    globalThis.localStorage = localStorageShim;
    globalThis.chrome = chromeShim;
}

/** @type {Record<string, any>} */
const forwardingState = {};

async function runForwardingChecks() {
    section('three-layer message forwarding (sandbox -> sidepanel -> background)');
    /** @type {any} */
    let modules;
    try {
        modules = {
            ncodeActions: await import(
                pathToFileURL(path.join(extensionDir, 'shared/messaging/ncode_actions.js')).href
            ),
            frame: await import(
                pathToFileURL(path.join(extensionDir, 'sidepanel/core/frame.js')).href
            ),
            bridge: await import(
                pathToFileURL(path.join(extensionDir, 'sidepanel/core/bridge.js')).href
            ),
            messaging: await import(
                pathToFileURL(path.join(extensionDir, 'sandbox/boot/messaging.js')).href
            ),
            backgroundMessages: await import(
                pathToFileURL(path.join(extensionDir, 'background/messages.js')).href
            ),
            approvalManager: await import(
                pathToFileURL(
                    path.join(extensionDir, 'background/managers/ncode_approval_manager.js')
                ).href
            ),
        };
    } catch (error) {
        check('fwd.modules', 'message pipeline modules import with browser shims', false, error);
        return;
    }
    check('fwd.modules', 'message pipeline modules import with browser shims', true);

    const { NCODE_ACTIONS, broadcastNcodeAction } = modules.ncodeActions;
    const { FrameManager } = modules.frame;
    const { MessageBridge } = modules.bridge;
    const { AppMessageBridge } = modules.messaging;
    const { setupMessageListener } = modules.backgroundMessages;
    const { NcodeApprovalManager } = modules.approvalManager;

    const { chrome, state } = createChromeMock({ extensionDir });
    // Background modules resolve the extension API from the global scope, so the
    // mock must be installed before the runtime listener (re)registers.
    globalThis.chrome = chrome;
    const bus = createMessageBus(chrome);

    const sandboxWindow = createEventWindow('sandbox');
    const sidepanelWindow = createEventWindow('sidepanel');
    sandboxWindow.parent = sidepanelWindow;

    /** @type {any[]} */
    const frameMessages = [];
    const rawSandboxPostMessage = sandboxWindow.postMessage.bind(sandboxWindow);
    sandboxWindow.postMessage = (message) => {
        frameMessages.push(message);
        rawSandboxPostMessage(message);
    };

    const iframeElement = {
        src: '',
        classList: {
            values: new Set(),
            add(value) {
                this.values.add(value);
            },
            remove(value) {
                this.values.delete(value);
            },
            contains(value) {
                return this.values.has(value);
            },
        },
        contentWindow: sandboxWindow,
    };
    const documentShim = {
        getElementById(id) {
            if (id === 'sandbox-frame') return iframeElement;
            return {
                classList: { add() {}, remove() {}, contains: () => false },
                contentWindow: null,
            };
        },
        createElement() {
            return {
                style: {},
                classList: { add() {}, remove() {} },
                setAttribute() {},
                appendChild() {},
            };
        },
        body: { appendChild() {}, removeChild() {} },
        addEventListener() {},
    };
    const localStorageShim = {
        getItem: () => null,
        setItem() {},
        removeItem() {},
    };

    const backgroundCalls = { harness: [], compact: [], toggle: [], reset: [] };
    const broadcast = (action, payload) => broadcastNcodeAction(action, payload);
    const goalSessionFixture = {
        workflowId: 'wf-ui-e2e',
        rootGoal: 'Reach the UI through every layer',
        subgoals: [
            { id: 'sg-1', title: 'Reach background', role: 'milestone', status: 'done', evidence: '' },
            { id: 'sg-2', title: 'Reach sandbox UI', role: 'milestone', status: 'running', evidence: '' },
        ],
        iterationCount: 1,
        maxIterations: 10,
        status: 'active',
        completionMarked: false,
    };
    const goalManagerStub = {
        getActiveGoalForSession: () => goalSessionFixture,
        getGoalSession: () => goalSessionFixture,
        serializeActiveGoals: () => ({ 'session-ui': 'wf-ui-e2e' }),
        toggleSubgoal: async (args) => {
            backgroundCalls.toggle.push(args);
            return { updated: true, goalSession: goalSessionFixture };
        },
        resetGoalForSession: async () => {
            backgroundCalls.reset.push(true);
            return { reset: true };
        },
    };
    const harnessStatusStub = {
        async handleGetHarnessStatus(options = {}) {
            backgroundCalls.harness.push(options);
            await broadcast(NCODE_ACTIONS.HARNESS_STATUS_UPDATE, {
                status: {
                    provider: 'web',
                    web: { connected: true },
                    pcShell: { connected: true, toolCount: 12 },
                },
                ts: Date.now(),
            });
            return { ok: true };
        },
    };
    const compactManagerStub = {
        async compactNow(args = {}) {
            backgroundCalls.compact.push(args);
            await broadcast(NCODE_ACTIONS.COMPACTION_STATE, {
                sessionId: args.sessionId || null,
                workflowId: 'wf-ui-e2e',
                state: 'requested',
                detail: { force: args.force === true },
                ts: Date.now(),
            });
            return { compacted: true, sessionId: args.sessionId || null };
        },
    };
    const approvalManager = new NcodeApprovalManager({
        storageArea: chrome.storage.local,
        broadcast: (action, payload) => broadcast(action, payload),
        timeoutMs: 5000,
    });
    await bus.runAs('background', () => approvalManager.setPolicy('ask'));

    bus.runAs('background', () => {
        setupMessageListener(
            {},
            {},
            {},
            {},
            { getLogs: () => [] },
            {},
            {
                goalManager: goalManagerStub,
                compactManager: compactManagerStub,
                harnessStatus: harnessStatusStub,
                approvalManager,
                bridgeClient: null,
            }
        );
    });

    /** @param {Record<string, any>} overrides */
    function makeUiStub(overrides = {}) {
        /** @type {{method: string, args: any[]}[]} */
        const calls = [];
        const record = (method) =>
            function (...args) {
                calls.push({ method, args });
            };
        const stub = {
            modelSelect: null,
            settings: {},
            sidebar: {},
            ...overrides,
            updateNcodeHarnessStatus: record('updateNcodeHarnessStatus'),
            updateNcodeGoalSession: record('updateNcodeGoalSession'),
            updateNcodePreamble: record('updateNcodePreamble'),
            updateNcodeCompactionState: record('updateNcodeCompactionState'),
            updateNcodeApprovalRequest: record('updateNcodeApprovalRequest'),
        };
        return { stub, calls };
    }

    const { stub: uiStub, calls: uiCalls } = makeUiStub();
    const appStub = { handleIncomingMessage() {} };

    // Build the sidepanel frame + bridge exactly as the real sidepanel boot does.
    registerLooseGlobals({
        windowShim: sidepanelWindow,
        documentShim,
        localStorageShim,
        chromeShim: chrome,
    });
    const frameManager = new FrameManager();
    frameManager.init();
    check(
        'fwd.frame.init',
        'sidepanel FrameManager wires the sandbox iframe URL and BridgeManager listens',
        iframeElement.src.includes('sandbox/index.html?theme='),
        iframeElement.src
    );
    const bridgeState = {
        getCurrentTabId: () => 42,
        getMessageTargetTabId: () => 42,
        save() {},
        saveMany() {},
        updateSessions() {},
        setHostTabId() {},
        markUiReady() {},
    };
    const bridge = new MessageBridge(frameManager, bridgeState);
    bus.runAs('sidepanel', () => bridge.init());

    // Build the sandbox AppMessageBridge against the sandbox window.
    const previousWindow = globalThis.window;
    globalThis.window = sandboxWindow;
    const appMessageBridge = new AppMessageBridge();
    appMessageBridge.setApp(appStub);
    appMessageBridge.setUI(uiStub);
    globalThis.window = previousWindow;
    check(
        'fwd.sandbox.bridge_init',
        'sandbox AppMessageBridge registers its parent-message listener',
        sandboxWindow.listenersFor('message').length > 0
    );

    const waitForBackgroundCall = (bucket, timeoutMs = HTTP_TIMEOUT_MS) =>
        waitFor(() => backgroundCalls[bucket].length > 0, {
            timeoutMs,
            intervalMs: 10,
            label: `background ${bucket} call`,
        });

    /** @param {string} action @param {Record<string, any>} [payload] */
    async function dispatchFromSandbox(action, payload = {}) {
        await bus.runAs('sidepanel', () =>
            bridge.handleWindowMessage({
                source: sandboxWindow,
                origin: 'null',
                data: { action, payload },
            })
        );
    }

    function framePayloads(action) {
        return frameMessages
            .filter((message) => message?.action === 'BACKGROUND_MESSAGE')
            .map((message) => message.payload)
            .filter((payload) => payload && payload.action === action);
    }

    // --- sandbox -> sidepanel -> background: request actions -----------------
    try {
        await dispatchFromSandbox(NCODE_ACTIONS.GET_HARNESS_STATUS, { ts: Date.now() });
        await waitForBackgroundCall('harness');
        await waitFor(() => framePayloads(NCODE_ACTIONS.HARNESS_STATUS_UPDATE).length > 0, {
            timeoutMs: HTTP_TIMEOUT_MS,
            intervalMs: 10,
            label: 'harness status broadcast in sandbox frame',
        });
        check(
            'fwd.get_harness_status.reaches_background',
            'NCODE_GET_HARNESS_STATUS traverses sidepanel bridge into the background listener',
            backgroundCalls.harness.length === 1 && backgroundCalls.harness[0].force === false
        );
        check(
            'fwd.get_harness_status.broadcast_to_sandbox',
            'background HARNESS_STATUS_UPDATE broadcast reaches the sandbox frame via BACKGROUND_MESSAGE',
            framePayloads(NCODE_ACTIONS.HARNESS_STATUS_UPDATE).length > 0
        );
        await waitFor(() => framePayloads(NCODE_ACTIONS.GET_HARNESS_STATUS).length > 0, {
            timeoutMs: HTTP_TIMEOUT_MS,
            intervalMs: 10,
            label: 'harness status ack',
        });
        const ack = framePayloads(NCODE_ACTIONS.GET_HARNESS_STATUS)[0];
        check(
            'fwd.get_harness_status.ack',
            'background ack for GET_HARNESS_STATUS returns to the sandbox frame',
            ack?.status === 'processed' && ack?.action === NCODE_ACTIONS.GET_HARNESS_STATUS
        );
    } catch (error) {
        check('fwd.get_harness_status', 'NCODE_GET_HARNESS_STATUS round-trip', false, error);
    }

    try {
        await dispatchFromSandbox(NCODE_ACTIONS.TRIGGER_COMPACT_RESUME, {
            sessionId: 'session-ui',
            force: true,
        });
        await waitForBackgroundCall('compact');
        await waitFor(() => framePayloads(NCODE_ACTIONS.TRIGGER_COMPACT_RESUME).length > 0, {
            timeoutMs: HTTP_TIMEOUT_MS,
            intervalMs: 10,
            label: 'compact resume ack',
        });
        const ack = framePayloads(NCODE_ACTIONS.TRIGGER_COMPACT_RESUME)[0];
        check(
            'fwd.compact_resume.round_trip',
            'NCODE_TRIGGER_COMPACT_RESUME reaches compactNow and returns a BACKGROUND_MESSAGE ack',
            backgroundCalls.compact[0]?.sessionId === 'session-ui' &&
                backgroundCalls.compact[0]?.force === true &&
                ack?.status === 'processed' &&
                ack?.compacted === true
        );
        check(
            'fwd.compact_state.to_sandbox',
            'NCODE_COMPACTION_STATE broadcast reaches the sandbox frame',
            framePayloads(NCODE_ACTIONS.COMPACTION_STATE).length > 0
        );
    } catch (error) {
        check('fwd.compact_resume', 'NCODE_TRIGGER_COMPACT_RESUME round-trip', false, error);
    }

    try {
        await dispatchFromSandbox(NCODE_ACTIONS.SUBGOAL_TOGGLE, {
            sessionId: 'session-ui',
            workflowId: 'wf-ui-e2e',
            subgoalId: 'sg-2',
            status: 'done',
            evidence: 'e2e toggled it',
        });
        await waitForBackgroundCall('toggle');
        await waitFor(() => framePayloads(NCODE_ACTIONS.SUBGOAL_TOGGLE).length > 0, {
            timeoutMs: HTTP_TIMEOUT_MS,
            intervalMs: 10,
            label: 'subgoal toggle ack',
        });
        const ack = framePayloads(NCODE_ACTIONS.SUBGOAL_TOGGLE)[0];
        check(
            'fwd.subgoal_toggle.round_trip',
            'NCODE_SUBGOAL_TOGGLE reaches goalManager.toggleSubgoal and acks to the sandbox',
            backgroundCalls.toggle[0]?.subgoalId === 'sg-2' &&
                backgroundCalls.toggle[0]?.status === 'done' &&
                ack?.updated === true
        );
    } catch (error) {
        check('fwd.subgoal_toggle', 'NCODE_SUBGOAL_TOGGLE round-trip', false, error);
    }

    // --- background -> sidepanel -> sandbox broadcasts -----------------------
    const broadcastCases = [
        [NCODE_ACTIONS.HARNESS_STATUS_UPDATE, { status: { provider: 'web' }, ts: Date.now() }],
        [
            NCODE_ACTIONS.GOAL_STATE_UPDATE,
            { sessionId: 'session-ui', workflowId: 'wf-ui-e2e', goalSession: goalSessionFixture },
        ],
        [NCODE_ACTIONS.INTERIM_PREAMBLE, { sessionId: 'session-ui', text: 'Checking the harness' }],
        [
            NCODE_ACTIONS.COMPACTION_STATE,
            { sessionId: 'session-ui', workflowId: 'wf-ui-e2e', state: 'resumed' },
        ],
        [
            NCODE_ACTIONS.APPROVAL_REQUEST,
            {
                requestId: 'approval-fixture',
                sessionId: 'session-ui',
                workflowId: 'wf-ui-e2e',
                toolName: 'pc_exec_shell',
                title: 'Approve pc_exec_shell',
                detail: 'echo hi',
                reason: 'This tool can change your machine.',
            },
        ],
    ];
    for (const [action, payload] of broadcastCases) {
        try {
            const before = framePayloads(action).length;
            await bus.runAs('background', () => broadcastNcodeAction(action, payload));
            await waitFor(() => framePayloads(action).length > before, {
                timeoutMs: HTTP_TIMEOUT_MS,
                intervalMs: 10,
                label: `${action} sandbox frame broadcast`,
            });
            const delivered = framePayloads(action).at(-1);
            check(
                `fwd.broadcast.${action}`,
                `${action} broadcast reaches the sandbox frame as BACKGROUND_MESSAGE`,
                Boolean(delivered) && delivered.requestId === payload.requestId
            );
        } catch (error) {
            check(`fwd.broadcast.${action}`, `${action} broadcast reaches the sandbox frame`, false, error);
        }
    }

    // Legacy aliases must be canonicalised on the way back to the sandbox.
    try {
        const before = framePayloads(NCODE_ACTIONS.GOAL_STATE_UPDATE).length;
        await bus.runAs('background', () =>
            chrome.runtime.sendMessage({
                action: 'NCODE_GOAL_STATE',
                sessionId: 'session-ui',
                workflowId: 'wf-ui-e2e',
                goalSession: goalSessionFixture,
            })
        );
        await waitFor(() => framePayloads(NCODE_ACTIONS.GOAL_STATE_UPDATE).length > before, {
            timeoutMs: HTTP_TIMEOUT_MS,
            intervalMs: 10,
            label: 'legacy goal state canonicalisation',
        });
        check(
            'fwd.legacy_alias.canonicalized',
            'legacy NCODE_GOAL_STATE broadcast is canonicalised to NCODE_GOAL_STATE_UPDATE',
            framePayloads(NCODE_ACTIONS.GOAL_STATE_UPDATE).length > before
        );
    } catch (error) {
        check('fwd.legacy_alias.canonicalized', 'legacy NCODE_GOAL_STATE canonicalisation', false, error);
    }

    // --- sandbox AppMessageBridge dispatch to the UI controller --------------
    try {
        const uiExpectations = [
            [NCODE_ACTIONS.HARNESS_STATUS_UPDATE, 'updateNcodeHarnessStatus'],
            [NCODE_ACTIONS.GOAL_STATE_UPDATE, 'updateNcodeGoalSession'],
            [NCODE_ACTIONS.INTERIM_PREAMBLE, 'updateNcodePreamble'],
            [NCODE_ACTIONS.APPROVAL_REQUEST, 'updateNcodeApprovalRequest'],
        ];
        const missed = uiExpectations.filter(
            ([, method]) => !uiCalls.some((call) => call.method === method)
        );
        check(
            'fwd.sandbox.ui_dispatch',
            'sandbox AppMessageBridge dispatches harness/goal/preamble/approval messages to UI controller methods',
            missed.length === 0,
            missed.map(([action]) => action).join(', ')
        );
        // Explicit dispatch (not only through the frame) confirms the mapping.
        const dispatchCallsBefore = uiCalls.length;
        globalThis.window = sandboxWindow;
        try {
            appMessageBridge.handleMessage({
                source: sandboxWindow.parent,
                data: {
                    action: 'BACKGROUND_MESSAGE',
                    payload: { action: 'NCODE_HARNESS_STATUS', status: { provider: 'web' } },
                },
            });
        } finally {
            globalThis.window = previousWindow;
        }
        check(
            'fwd.sandbox.legacy_dispatch',
            'sandbox AppMessageBridge canonicalises legacy NCODE_HARNESS_STATUS to updateNcodeHarnessStatus',
            uiCalls
                .slice(dispatchCallsBefore)
                .some((call) => call.method === 'updateNcodeHarnessStatus')
        );
    } catch (error) {
        check('fwd.sandbox.ui_dispatch', 'sandbox AppMessageBridge UI dispatch', false, error);
    }

    // --- approval request/response full round-trip ---------------------------
    try {
        /** @type {Promise<any>|null} */
        let approvalPromise = null;
        bus.runAs('background', () => {
            approvalPromise = approvalManager.requestToolApproval({
                sessionId: 'session-ui',
                workflowId: 'wf-ui-e2e',
                toolName: 'pc_exec_shell',
                toolArgs: { command: 'echo approval-run' },
            });
        });
        await waitFor(
            () =>
                uiCalls.filter((call) => call.method === 'updateNcodeApprovalRequest').length > 0
                    ? true
                    : false,
            { timeoutMs: HTTP_TIMEOUT_MS, intervalMs: 10, label: 'approval request UI dispatch' }
        );
        const approvalCall = uiCalls
            .filter((call) => call.method === 'updateNcodeApprovalRequest')
            .at(-1);
        const approvalRequest = approvalCall?.args?.[0] || {};
        check(
            'fwd.approval_request.to_sandbox',
            'NCODE_APPROVAL_REQUEST broadcast reaches the sandbox approval strip with a requestId',
            typeof approvalRequest.requestId === 'string' &&
                approvalRequest.toolName === 'pc_exec_shell'
        );
        await bus.runAs('sidepanel', () =>
            sidepanelWindow.dispatchEvent('message', {
                source: sandboxWindow,
                origin: 'null',
                data: {
                    action: NCODE_ACTIONS.APPROVAL_RESPONSE,
                    payload: { requestId: approvalRequest.requestId, approved: true, reason: null },
                },
            })
        );
        const decision = await withTimeout(
            approvalPromise,
            HTTP_TIMEOUT_MS,
            'approval decision resolution'
        );
        check(
            'fwd.approval_round_trip',
            'NCODE_APPROVAL_RESPONSE from the sandbox resolves the background approval promise',
            decision?.required === true &&
                decision?.approved === true &&
                decision?.requestId === approvalRequest.requestId,
            JSON.stringify(decision || null)
        );
        await waitFor(() => framePayloads(NCODE_ACTIONS.APPROVAL_RESPONSE).length > 0, {
            timeoutMs: HTTP_TIMEOUT_MS,
            intervalMs: 10,
            label: 'approval response ack',
        });
        check(
            'fwd.approval_response.ack',
            'background approval ack returns to the sandbox frame',
            framePayloads(NCODE_ACTIONS.APPROVAL_RESPONSE)[0]?.status === 'processed'
        );
    } catch (error) {
        check('fwd.approval_round_trip', 'approval request/response round-trip', false, error);
    }

    forwardingState.chrome = chrome;
    forwardingState.state = state;
    forwardingState.bus = bus;
    forwardingState.frameMessages = frameMessages;
    forwardingState.uiCalls = uiCalls;
    forwardingState.uiStub = uiStub;
    forwardingState.sandboxWindow = sandboxWindow;
    forwardingState.sidepanelWindow = sidepanelWindow;
}

// ---------------------------------------------------------------------------
// 4. Compact & Resume cursor reset (real compact manager + context manager)
// ---------------------------------------------------------------------------

async function runCompactionChecks() {
    section('Compact & Resume cursor reset');
    if (!daemonRuntime.client) {
        check('compact.harness', 'running pc-daemon is available for checkpoint mirror', false, 'daemon unavailable');
        return;
    }
    let compact; // module namespace
    try {
        compact = {
            compactManager: await import(
                pathToFileURL(
                    path.join(extensionDir, 'background/managers/ncode_compact_manager.js')
                ).href
            ),
            contextManager: await import(
                pathToFileURL(
                    path.join(extensionDir, 'background/managers/session/context_manager.js')
                ).href
            ),
            engine: await import(
                pathToFileURL(
                    path.join(extensionDir, 'shared/orchestrator/compact_resume_engine.js')
                ).href
            ),
            goalMachine: await import(
                pathToFileURL(
                    path.join(extensionDir, 'shared/orchestrator/goal_state_machine.js')
                ).href
            ),
            connection: await import(
                pathToFileURL(path.join(extensionDir, 'shared/settings/connection.js')).href
            ),
        };
    } catch (error) {
        check('compact.modules', 'compact manager / context manager / orchestrator import', false, error);
        return;
    }
    const { NcodeCompactManager } = compact.compactManager;
    const {
        clearWebConversationCursorMemory,
        getWebConversationCursor,
        updateWebConversationCursor,
        NCODE_WEB_CURSOR_STORAGE_KEY,
    } = compact.contextManager;
    const { buildCheckpointStorageKey } = compact.engine;
    const { createGoalSession } = compact.goalMachine;
    const { NCODE_LOCAL_MCP_SERVER_ID } = compact.connection;

    const { chrome } = createChromeMock({ extensionDir });
    clearWebConversationCursorMemory();

    const workflowId = 'wf-e2e-compact';
    const sessionId = 'session-e2e-compact';
    const pendingSubgoalTitle = 'Verify e2e hydration output';
    const nextImmediateAction = 'Run the remaining e2e assertions';
    const compactShellCwd = path.join(daemonRuntime.stateDir || os.tmpdir(), 'compact-cwd-probe');
    mkdirSync(compactShellCwd, { recursive: true });
    const goalSession = createGoalSession({
        workflowId,
        rootGoal: 'Prove Compact & Resume resets the Gemini Web cursor',
        subgoals: [
            { id: 'sg-1', title: 'Save a durable checkpoint', role: 'pc_coder', status: 'done' },
            {
                id: 'sg-2',
                title: pendingSubgoalTitle,
                role: 'verifier',
                status: 'pending',
            },
        ],
        maxIterations: 10,
    });
    const messages = [];
    for (let index = 0; index < 6; index += 1) {
        messages.push({
            role: 'assistant',
            kind: 'tool-output',
            toolName: 'pc_exec_shell',
            text: `tool output ${index}: ${'y'.repeat(4000)}`,
        });
    }
    messages.push({ role: 'user', text: 'Please compact and continue.' });
    messages.push({ role: 'assistant', text: 'Continuing after compaction.' });

    chrome.storage.local.set({
        geminiProvider: 'web',
        geminiSessions: [{ id: sessionId, title: 'E2E compact session', messages }],
    });
    await updateWebConversationCursor(
        { conversationId: 'c1', responseId: 'r1', choiceId: 'x1' },
        { storageArea: chrome.storage.local }
    );
    const seededCursor = await getWebConversationCursor({ storageArea: chrome.storage.local });
    check(
        'compact.cursor.seed',
        'web conversation cursor seeded to c1/r1/x1 in chrome.storage.local',
        seededCursor.conversationId === 'c1' &&
            seededCursor.responseId === 'r1' &&
            seededCursor.choiceId === 'x1'
    );

    /** @type {{toolId: string, args: any}[]} */
    const mcpCalls = [];
    /** @type {{toolId: string, args: any}[]} */
    const shellProbeCalls = [];
    /** @type {string[]} */
    const passedThroughPrompts = [];
    let resetContextCalled = false;
    const sessionManager = {
        async handleSendPrompt(request) {
            passedThroughPrompts.push(request?.text || '');
            return {
                status: 'success',
                text: JSON.stringify({
                    completedSubgoals: ['Save a durable checkpoint'],
                    pendingSubgoals: [pendingSubgoalTitle],
                    modifiedFiles: ['test/runtime/e2e.mjs'],
                    modifiedFilesAndCommands: ['node test/runtime/e2e.mjs'],
                    keyFindings: ['Compact & Resume persists six canonical fields'],
                    nextStep: nextImmediateAction,
                }),
            };
        },
        async resetContext() {
            resetContextCalled = true;
            return true;
        },
    };
    const mcpManager = {
        async callToolById(toolId, args) {
            mcpCalls.push({ toolId, args });
            const plainToolName = String(toolId).includes('__')
                ? String(toolId).slice(String(toolId).indexOf('__') + 2)
                : String(toolId);
            if (plainToolName === 'pc_shell_session') {
                shellProbeCalls.push({ toolId, args });
                return {
                    isError: false,
                    text: JSON.stringify({
                        workflowId: args?.workflowId || null,
                        cwd: compactShellCwd,
                    }),
                };
            }
            if (plainToolName !== 'workflow_save_checkpoint') {
                return { isError: true, text: `unexpected MCP tool ${toolId}` };
            }
            const call = await daemonRuntime.client.callTool('workflow_save_checkpoint', args);
            return { isError: call.isError, text: call.text };
        },
    };
    const goalManager = {
        getActiveGoalForSession: () => goalSession,
        getGoalSession: () => goalSession,
        serializeActiveGoals: () => ({ [sessionId]: workflowId }),
    };

    globalThis.chrome = chrome;
    const manager = new NcodeCompactManager({
        sessionManager,
        mcpManager,
        goalManager,
        storageArea: chrome.storage.local,
        thresholdChars: 2000,
        preserveRecentTurns: 2,
    });

    const result = await withTimeout(
        manager.compactNow({ sessionId, force: true }),
        30_000,
        'compactNow'
    );
    check(
        'compact.result.compacted',
        'compactNow({force:true}) reports a compacted result',
        result?.compacted === true,
        JSON.stringify({
            compacted: result?.compacted,
            reason: result?.reason,
            error: result?.error,
        })
    );
    check(
        'compact.prompt.used_provider',
        'compaction turn ran through the web provider session manager and reset the provider context',
        passedThroughPrompts.length === 1 && resetContextCalled
    );

    const checkpointKey = buildCheckpointStorageKey(result?.workflowId || workflowId);
    const stored = await chrome.storage.local.get([checkpointKey]);
    const storedCheckpoint = stored?.[checkpointKey] || null;
    check(
        'compact.checkpoint.storage',
        'checkpoint persisted to chrome.storage.local under buildCheckpointStorageKey(workflowId)',
        Boolean(storedCheckpoint) &&
            storedCheckpoint.workflowId === (result?.workflowId || workflowId) &&
            typeof storedCheckpoint.checkpointId === 'string',
        `key=${checkpointKey}`
    );

    const checkpointFile = path.join(
        daemonRuntime.stateDir || '',
        'workflows',
        `${result?.workflowId || workflowId}.json`
    );
    let daemonCheckpoint = null;
    try {
        daemonCheckpoint = JSON.parse(readFileSync(checkpointFile, 'utf8'));
    } catch (error) {
        daemonCheckpoint = null;
    }
    const saveCalls = mcpCalls.filter(
        (call) => call.toolId === `${NCODE_LOCAL_MCP_SERVER_ID}__workflow_save_checkpoint`
    );
    check(
        'compact.checkpoint.daemon_file',
        'checkpoint mirrored through workflow_save_checkpoint into <state-dir>/workflows/<workflowId>.json',
        Boolean(daemonCheckpoint?.checkpoint) &&
            daemonCheckpoint.checkpoint.workflowId === (result?.workflowId || workflowId) &&
            saveCalls.length === 1,
        `file=${checkpointFile} calls=${JSON.stringify(mcpCalls.map((call) => call.toolId))}`
    );

    const CANONICAL_CHECKPOINT_FIELDS = [
        'completedSubgoals',
        'pendingSubgoals',
        'modifiedFiles',
        'currentCwd',
        'keyFindings',
        'nextStep',
    ];
    const missingCheckpointFields = CANONICAL_CHECKPOINT_FIELDS.filter(
        (field) => !(storedCheckpoint && field in storedCheckpoint)
    );
    check(
        'compact.checkpoint.six_fields',
        'checkpoint carries the six canonical Compact & Resume fields incl. daemon shell cwd',
        missingCheckpointFields.length === 0 &&
            storedCheckpoint.currentCwd === compactShellCwd &&
            Array.isArray(storedCheckpoint.pendingSubgoals) &&
            storedCheckpoint.pendingSubgoals.includes(pendingSubgoalTitle) &&
            storedCheckpoint.nextStep === nextImmediateAction,
        `missing=${missingCheckpointFields.join(',')} currentCwd=${storedCheckpoint?.currentCwd}`
    );
    check(
        'compact.shell_context.probe',
        'compact manager enriched checkpoint.currentCwd via the namespaced pc_shell_session MCP probe',
        shellProbeCalls.length === 1 &&
            shellProbeCalls[0].toolId === `${NCODE_LOCAL_MCP_SERVER_ID}__pc_shell_session` &&
            shellProbeCalls[0].args?.action === 'info' &&
            shellProbeCalls[0].args?.workflowId === (result?.workflowId || workflowId),
        JSON.stringify(shellProbeCalls.map((call) => call.toolId))
    );

    const cursorAfter = await getWebConversationCursor({ storageArea: chrome.storage.local });
    const cursorStorage = await chrome.storage.local.get([NCODE_WEB_CURSOR_STORAGE_KEY]);
    check(
        'compact.cursor.reset',
        'Compact & Resume resets the Gemini Web cursor to conversationId/responseId/choiceId = null',
        cursorAfter.conversationId === null &&
            cursorAfter.responseId === null &&
            cursorAfter.choiceId === null &&
            cursorStorage?.[NCODE_WEB_CURSOR_STORAGE_KEY] === undefined,
        JSON.stringify(cursorAfter)
    );

    const hydrationText = String(result?.hydrationText || '');
    check(
        'compact.hydration.pending_subgoal',
        'returned hydration text carries pendingSubgoals/currentCwd/nextStep for the next turn',
        hydrationText.includes('## Pending subgoals') &&
            hydrationText.includes(pendingSubgoalTitle) &&
            hydrationText.includes('## Current working directory') &&
            hydrationText.includes(compactShellCwd) &&
            hydrationText.includes('## Next step') &&
            hydrationText.includes(nextImmediateAction),
        hydrationText.slice(0, 400)
    );
    check(
        'compact.hydration.goal_checklist',
        'hydration text includes the goal-loop checklist and output-tag contract',
        hydrationText.includes('Subgoal checklist') &&
            hydrationText.includes('ncode_goal_update') &&
            hydrationText.includes('ncode_preamble')
    );
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

async function main() {
    console.log(`Ncode e2e runtime test (${new Date().toISOString()})`);
    console.log(`node ${process.version} on ${process.platform} ${process.arch}`);
    const watchdog = setTimeout(() => {
        console.error(
            `FAIL e2e.timeout whole e2e run exceeded ${TOTAL_BUDGET_MS}ms (started ${startedAt})`
        );
        cleanup();
        process.exit(1);
    }, TOTAL_BUDGET_MS);
    watchdog.unref();

    try {
        await runDistChecks().catch((error) =>
            check('dist.harness', 'dist verification harness completed', false, error)
        );
        await runDaemonChecks().catch((error) =>
            check('daemon.harness', 'pc-daemon harness completed', false, error)
        );
        await runForwardingChecks().catch((error) =>
            check('fwd.harness', 'message-forwarding harness completed', false, error)
        );
        await runCompactionChecks().catch((error) =>
            check('compact.harness', 'compaction harness completed', false, error)
        );
    } finally {
        clearTimeout(watchdog);
        await cleanup();
    }

    const durationMs = Date.now() - startedAt;
    console.log(
        `\n${failures === 0 ? 'All' : failures} ${checks} e2e checks ${
            failures === 0 ? 'passed' : 'completed with failures'
        } in ${(durationMs / 1000).toFixed(1)}s.`
    );
    if (failures > 0) {
        console.error(`\nFailed checks:\n${failureLines.join('\n')}`);
        process.exitCode = 1;
    } else {
        process.exitCode = 0;
    }
}

function cleanup() {
    try {
        globalThis.chrome = undefined;
        globalThis.window = undefined;
        globalThis.document = undefined;
        globalThis.localStorage = undefined;
    } catch {
        // ignore
    }
    if (daemonRuntime.handle) {
        try {
            daemonRuntime.handle.child.kill('SIGTERM');
        } catch {
            // ignore
        }
        daemonRuntime.handle = null;
    }
    if (daemonRuntime.stateDir) {
        try {
            rmSync(daemonRuntime.stateDir, { recursive: true, force: true });
        } catch {
            // ignore
        }
        daemonRuntime.stateDir = null;
    }
}

main().catch(async (error) => {
    console.error('[e2e] fatal:', error?.stack || error);
    cleanup();
    process.exit(1);
});
