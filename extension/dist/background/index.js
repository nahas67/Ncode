import { GeminiSessionManager } from './managers/session_manager.js';
import { ImageManager } from './managers/image_manager.js';
import { BrowserControlManager } from './managers/control_manager.js';
import { McpRemoteManager } from './managers/mcp_remote_manager.js';
import { LogManager, setupConsoleInterception } from './managers/log_manager.js';
import { NativeLoggerSink } from './managers/native_logger_sink.js';
import { createBridgeRecordHandlers } from './managers/bridge_records.js';
import { SidePanelScopeManager } from './managers/sidepanel_scope_manager.js';
import { NcodeGoalManager } from './managers/ncode_goal_manager.js';
import { NcodeCompactManager } from './managers/ncode_compact_manager.js';
import { NcodeHarnessStatus } from './managers/ncode_harness_status.js';
import { NcodeApprovalManager } from './managers/ncode_approval_manager.js';
import { NcodeBridgeClient } from './managers/ncode_bridge_client.js';
import { DEFAULT_STORED_GEMINI_MODEL } from '../shared/config/constants.js';
import { setupContextMenus } from './menus.js';
import { setupMessageListener } from './messages.js';
import { keepAliveManager } from './managers/keep_alive.js';
import { setupContentScriptInjection } from './content_injection.js';
import { setupPageShortcutCommands } from './page_shortcut_commands.js';
import {
    showQuickAskForTab,
    startAreaOcrForTab as startAreaOcrForTabWithManager,
    startAreaSnipForTab as startAreaSnipForTabWithManager,
} from './page_shortcut_tab_actions.js';
import { toggleSidePanelControl } from './handlers/ui_sidepanel.js';

// Unpacked (dev) loads default native logging ON so local agents can tail
// ~/Library/Logs/gemini-nexus.log without a settings UI. Store-built packages
// (manifest has update_url) stay off until geminiNativeLogEnabled is set true.
function isUnpackedExtension() {
    try {
        return !('update_url' in chrome.runtime.getManifest());
    } catch {
        return false;
    }
}

const defaultNativeLogEnabled = isUnpackedExtension();
const nativeLoggerSink = new NativeLoggerSink({
    minLevel: 'info',
    enabled: defaultNativeLogEnabled,
});
const logManager = new LogManager([nativeLoggerSink]);

// Local HTTP bridge RPC handlers (host listens on 127.0.0.1:17321 by default).
nativeLoggerSink.setRequestHandler('ping', async () => ({ pong: true, ts: Date.now() }));
nativeLoggerSink.setRequestHandler('get_logs', async (params = {}) => {
    const limit = Math.max(1, Math.min(Number(params.limit) || 100, 1000));
    let logs = logManager.getLogs();
    if (params.level) {
        const want = String(params.level).toUpperCase();
        logs = logs.filter((e) => String(e.level).toUpperCase() === want);
    }
    return { logs: logs.slice(-limit) };
});
nativeLoggerSink.setRequestHandler('get_status', async () => {
    let manifest = {};
    try {
        manifest = chrome.runtime.getManifest() || {};
    } catch {
        // ignore
    }
    return {
        version: manifest.version || null,
        name: manifest.name || 'Gemini Nexus',
        unpacked: isUnpackedExtension(),
        nativeLogEnabled: nativeLoggerSink.enabled,
        logCount: logManager.getLogs().length,
        ts: Date.now(),
    };
});

// Full usage records for local agents (chat history, groups, logs).
const bridgeRecords = createBridgeRecordHandlers({
    getLogs: () => logManager.getLogs(),
});
for (const method of [
    'get_sessions',
    'get_session',
    'get_groups',
    'get_storage_keys',
    'get_records',
    'get_ncode_state',
]) {
    nativeLoggerSink.setRequestHandler(method, (params) => bridgeRecords[method](params));
}

function applyNativeLogSettings(result = {}) {
    if (result.geminiNativeLogEnabled === false) {
        nativeLoggerSink.setEnabled(false);
    } else if (result.geminiNativeLogEnabled === true || defaultNativeLogEnabled) {
        nativeLoggerSink.setEnabled(true);
        // Persist the unpacked default so storage matches runtime and reloads stay on.
        if (result.geminiNativeLogEnabled !== true && defaultNativeLogEnabled) {
            chrome.storage.local.set({ geminiNativeLogEnabled: true });
        }
    } else {
        nativeLoggerSink.setEnabled(false);
    }
    if (result.geminiNativeLogLevel) nativeLoggerSink.setMinLevel(result.geminiNativeLogLevel);
}

chrome.storage.local.get(['geminiNativeLogEnabled', 'geminiNativeLogLevel'], (result) => {
    applyNativeLogSettings(result);
});
chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.geminiNativeLogEnabled) {
        nativeLoggerSink.setEnabled(changes.geminiNativeLogEnabled.newValue === true);
    }
    if (changes.geminiNativeLogLevel) {
        nativeLoggerSink.setMinLevel(changes.geminiNativeLogLevel.newValue);
    }
});

// Eager connect so the native host (HTTP bridge) starts even before first log.
if (defaultNativeLogEnabled) {
    nativeLoggerSink.connect();
}

setupConsoleInterception(logManager);

console.info('[Gemini Nexus] Background Service Worker Started');
console.info(
    '[Gemini Nexus] Local debug bridge: http://127.0.0.1:17321/health (requires native logger host)'
);

// Side panel sandbox can keep isGenerating=true across SW restarts. Notify
// open extension pages so they unstick the send button.
try {
    chrome.runtime
        .sendMessage({ action: 'SERVICE_WORKER_STARTED', ts: Date.now() })
        .catch(() => {});
} catch {
    // No receivers yet — ignore.
}

const sessionManager = new GeminiSessionManager();
const imageManager = new ImageManager();
const controlManager = new BrowserControlManager();
const sidePanelScopeManager = new SidePanelScopeManager();
const mcpManager = new McpRemoteManager({
    clientName: 'gemini-nexus',
    clientVersion: chrome.runtime.getManifest().version,
});

// Ncode Phase 4 managers: goal loop, harness status, compaction and the local
// PC bridge. They are constructed after the chrome managers above so their
// probes can reuse them.

/**
 * askWeb handler for the pc-daemon WebSocket bridge (ws://127.0.0.1:8085).
 *
 * LIMITATION: this is a single-shot Gemini Web completion. It runs a synthetic
 * request with no stored session history and no tool loop, because unattended
 * tool execution would need an owned sidepanel run + tool stream. Local agents
 * that need full agentic tool use should drive the extension through the
 * sidepanel / MCP tools instead.
 *
 * Bridge asks are serialized: the reverse-engineered web session shares one
 * auth context with sidepanel runs, so two overlapping synthetic requests would
 * interleave their token/context updates.
 */
let bridgeAskChain = Promise.resolve();

function askGeminiWebViaBridge(prompt) {
    const run = () => runBridgeAsk(prompt);
    const task = bridgeAskChain.then(run, run);
    bridgeAskChain = task.then(
        () => undefined,
        () => undefined
    );
    return task;
}

async function runBridgeAsk(prompt) {
    const text = typeof prompt === 'string' ? prompt : String(prompt ?? '');
    const result = await sessionManager.handleSendPrompt(
        {
            action: 'SEND_PROMPT',
            text,
            provider: 'web',
            model: DEFAULT_STORED_GEMINI_MODEL,
            systemInstruction: '',
            sessionId: null,
            files: null,
        },
        () => {},
        'ncodeBridgeAsk'
    );
    if (!result || result.status !== 'success') {
        throw new Error(result?.text || 'Gemini Web request failed.');
    }
    return typeof result.text === 'string' ? result.text : String(result.text ?? '');
}

const goalManager = new NcodeGoalManager();
const compactManager = new NcodeCompactManager({ sessionManager, mcpManager, goalManager });
const bridgeClient = new NcodeBridgeClient({ askWeb: askGeminiWebViaBridge });
const harnessStatus = new NcodeHarnessStatus({ mcpManager, bridgeClient, goalManager });
const approvalManager = new NcodeApprovalManager();

// Restore persisted goals, start the status probe loop and connect the local
// PC bridge. All three are no-op-safe and never throw out of the worker.
goalManager.restore().catch((error) => {
    console.warn('[Ncode] Failed to restore goal sessions:', error?.message || error);
});
approvalManager.ensureInitialized().catch((error) => {
    console.warn('[Ncode] Failed to init approval policy:', error?.message || error);
});
harnessStatus.start();
bridgeClient.connect();

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
sidePanelScopeManager.init();
chrome.action.onClicked.addListener((tab) => {
    if (!tab?.id || !tab.windowId) return;
    sidePanelScopeManager.toggleForTab(tab.id, tab.windowId).catch((error) => {
        console.error('Could not toggle side panel from action click:', error);
    });
});

async function startAreaOcrForTab(tab) {
    await startAreaOcrForTabWithManager(tab, imageManager);
}

async function startAreaSnipForTab(tab) {
    await startAreaSnipForTabWithManager(tab, imageManager);
}

async function toggleBrowserControlForTab(tab) {
    if (!tab?.id || !tab.windowId) return;
    const context = {
        controlManager,
        sidePanelScopeManager,
        getTargetSidePanelTabId: () => tab.id,
    };
    await toggleSidePanelControl(context, { action: 'TOGGLE_SIDE_PANEL_CONTROL' }, { tab });
}

chrome.commands?.onCommand?.addListener((command, tab) => {
    if (command === 'quick-ask') {
        showQuickAskForTab(tab).catch((error) => {
            console.error('Could not open quick ask from command:', error);
        });
        return;
    }

    if (command === 'area-ocr') {
        startAreaOcrForTab(tab).catch((error) => {
            console.error('Could not start area OCR from command:', error);
        });
        return;
    }

    if (command === 'browser-control') {
        toggleBrowserControlForTab(tab).catch((error) => {
            console.error('Could not toggle browser control from command:', error);
        });
    }
});

setupPageShortcutCommands({
    showQuickAskForTab,
    startAreaOcrForTab,
    startAreaSnipForTab,
});

setupContextMenus();
setupContentScriptInjection();
setupMessageListener(
    sessionManager,
    imageManager,
    controlManager,
    mcpManager,
    logManager,
    sidePanelScopeManager,
    { goalManager, compactManager, harnessStatus, bridgeClient, approvalManager }
);

// Keep-alive 401/403 must invalidate AuthManager memory as well as storage;
// otherwise getOrFetchContext keeps serving the dead in-memory tokens.
keepAliveManager.setSessionExpiredHandler(() => sessionManager.clearContext());
keepAliveManager.init();

// Detach the debugger before the MV3 service worker is terminated so the
// controlled tab is not left stuck on the "Started debugging" infobar with no
// live SW to detach it. After restart, connection.attached is false and a
// leaked attachment has no recovery path (the user had to close the tab).
// chrome.runtime.onSuspend is an Event object — register the callback with
// addListener, not by calling onSuspend(cb) (the latter throws
// "chrome.runtime.onSuspend is not a function").
chrome.runtime.onSuspend?.addListener?.(() => {
    try {
        controlManager.suspendCleanup();
    } catch (error) {
        console.warn('[Gemini Nexus] onSuspend cleanup failed:', error);
    }
});
