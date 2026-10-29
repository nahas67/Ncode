import { SessionMessageHandler } from './handlers/session/index.js';
import { UIMessageHandler } from './handlers/ui.js';

/**
 * Sets up the global runtime message listener.
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
        }
    );
    const uiHandler = new UIMessageHandler(
        imageHandler,
        controlManager,
        mcpManager,
        sidePanelScopeManager,
        sessionHandler
    );

    // Handles the Ncode harness UI actions (goal/harness/compaction state).
    // Async and always replies exactly once so the UI never hangs.
    function broadcastCompactionFailure(sessionId, errorMessage) {
        // The harness bar waits for the NCODE_COMPACTION_STATE ack after the
        // Compact & Resume button. An early error (manager unavailable, thrown
        // compaction, nothing to compact) must broadcast a terminal state so the
        // bar recovers immediately instead of waiting for its ack timeout.
        try {
            chrome.runtime
                .sendMessage({
                    action: 'NCODE_COMPACTION_STATE',
                    sessionId: sessionId || null,
                    workflowId: null,
                    state: 'failed',
                    detail: { error: errorMessage || 'Compaction failed.' },
                    ts: Date.now(),
                })
                .catch(() => {});
        } catch {
            // Broadcast is best-effort; the UI also self-recovers on ack timeout.
        }
    }

    function handleNcodeAction(request, sendResponse) {
        if (request.action === 'NCODE_GET_STATE') {
            (async () => {
                try {
                    if (harnessStatus && typeof harnessStatus.handleGetState === 'function') {
                        await harnessStatus.handleGetState();
                    } else if (
                        goalManager &&
                        typeof goalManager.serializeActiveGoals === 'function'
                    ) {
                        const active = goalManager.serializeActiveGoals() || {};
                        for (const [sessionId, workflowId] of Object.entries(active)) {
                            const goalSession =
                                typeof goalManager.getGoalSession === 'function'
                                    ? goalManager.getGoalSession(workflowId)
                                    : null;
                            if (!goalSession) continue;
                            chrome.runtime
                                .sendMessage({
                                    action: 'NCODE_GOAL_STATE',
                                    sessionId,
                                    workflowId,
                                    goalSession,
                                })
                                .catch(() => {});
                        }
                    }
                    sendResponse({ status: 'processed' });
                } catch (error) {
                    console.warn('[Ncode] NCODE_GET_STATE failed:', error?.message || error);
                    sendResponse({ status: 'error', error: error?.message || String(error) });
                }
            })();
            return true;
        }

        if (request.action === 'NCODE_COMPACT_RESUME') {
            (async () => {
                const sessionId = request.sessionId || request.ncodeSessionId || null;
                try {
                    if (!compactManager || typeof compactManager.compactNow !== 'function') {
                        sendResponse({ status: 'error', error: 'Compaction manager unavailable.' });
                        broadcastCompactionFailure(sessionId, 'Compaction manager unavailable.');
                        return;
                    }
                    const result = await compactManager.compactNow({
                        sessionId,
                        force: request.force === true,
                    });
                    sendResponse({
                        status: result?.compacted ? 'processed' : 'skipped',
                        compacted: result?.compacted === true,
                        reason: result?.reason || null,
                        error: result?.error || null,
                    });
                    if (result?.compacted !== true) {
                        broadcastCompactionFailure(
                            sessionId,
                            result?.error || result?.reason || 'Nothing to compact.'
                        );
                    }
                } catch (error) {
                    console.warn('[Ncode] NCODE_COMPACT_RESUME failed:', error?.message || error);
                    sendResponse({ status: 'error', error: error?.message || String(error) });
                    broadcastCompactionFailure(sessionId, error?.message || String(error));
                }
            })();
            return true;
        }

        if (request.action === 'NCODE_RESET_GOAL') {
            (async () => {
                try {
                    if (!goalManager || typeof goalManager.resetGoalForSession !== 'function') {
                        sendResponse({ status: 'error', error: 'Goal manager unavailable.' });
                        return;
                    }
                    const sessionId = request.sessionId || null;
                    const reset = await goalManager.resetGoalForSession(sessionId);
                    sendResponse({ status: 'processed', reset });
                } catch (error) {
                    console.warn('[Ncode] NCODE_RESET_GOAL failed:', error?.message || error);
                    sendResponse({ status: 'error', error: error?.message || String(error) });
                }
            })();
            return true;
        }

        return false;
    }

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

        // Ncode harness actions must run before the generic handlers.
        if (handleNcodeAction(request, sendResponse)) {
            return true;
        }

        // Delegate to Session Handler (Prompt, Context, Quick Ask, Browser Control)
        if (sessionHandler.handle(request, sender, sendResponse)) {
            return true;
        }

        // Delegate to UI Handler (Image, Capture, Sidepanel)
        if (uiHandler.handle(request, sender, sendResponse)) {
            return true;
        }

        return false;
    });
}
