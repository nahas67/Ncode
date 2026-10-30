import { SessionMessageHandler } from './handlers/session/index.js';
import { UIMessageHandler } from './handlers/ui.js';

/**
 * Sets up the global runtime message listener.
 *
 * The Ncode harness actions (live status probe, Compact & Resume, goal reset,
 * subgoal toggles, approval decisions) are owned by the UI handler
 * (`background/handlers/ui.js` -> `handlers/ui_ncode.js`) because they only
 * mutate harness/UI state. Session prompts and generic UI actions keep their
 * existing handlers.
 *
 * @param {GeminiSessionManager} sessionManager
 * @param {ImageHandler} imageHandler
 * @param {BrowserControlManager} controlManager
 * @param {McpRemoteManager} mcpManager
 * @param {LogManager} logManager
 * @param {SidePanelScopeManager} sidePanelScopeManager
 * @param {{
 *   goalManager?: object|null,
 *   compactManager?: object|null,
 *   harnessStatus?: object|null,
 *   bridgeClient?: object|null,
 *   approvalManager?: object|null,
 * }} [ncodeDeps] Ncode goal/harness/compaction managers (Phase 4 wiring)
 */
export function setupMessageListener(
    sessionManager,
    imageHandler,
    controlManager,
    mcpManager,
    logManager,
    sidePanelScopeManager,
    ncodeDeps = {}
) {
    const goalManager = ncodeDeps.goalManager || null;
    const compactManager = ncodeDeps.compactManager || null;
    const harnessStatus = ncodeDeps.harnessStatus || null;
    const approvalManager = ncodeDeps.approvalManager || null;

    const sessionHandler = new SessionMessageHandler(
        sessionManager,
        imageHandler,
        controlManager,
        mcpManager,
        {
            goalManager,
            compactManager,
            harnessStatus,
            bridgeClient: ncodeDeps.bridgeClient || null,
            approvalManager,
        }
    );
    const uiHandler = new UIMessageHandler(
        imageHandler,
        controlManager,
        mcpManager,
        sidePanelScopeManager,
        sessionHandler,
        { goalManager, compactManager, harnessStatus, approvalManager }
    );

    // Abort any in-flight quick-ask when its content-script tab is closed,
    // so the upstream provider fetch does not keep streaming into a dead tab.
    chrome.tabs.onRemoved.addListener((tabId) => {
        sessionHandler.cancelQuickAskForTab(tabId);
    });

    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        // Malformed requests must not reach the handlers: property access on
        // null/non-object throws inside the listener, the runtime swallows
        // the exception, and the sender hangs forever awaiting a response.
        if (!request || typeof request !== 'object' || typeof request.action !== 'string') {
            return false;
        }

        if (request.action === 'GET_LOGS') {
            sendResponse({ logs: logManager.getLogs() });
            return true;
        }

        // Delegate to Session Handler (Prompt, Context, Quick Ask, Browser Control)
        if (sessionHandler.handle(request, sender, sendResponse)) {
            return true;
        }

        // Delegate to UI Handler (Ncode harness actions, Image, Capture, Sidepanel)
        if (uiHandler.handle(request, sender, sendResponse)) {
            return true;
        }

        return false;
    });
}
