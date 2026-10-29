import { PromptHandler } from './prompt_handler.js';
import { QuickAskHandler } from './quick_ask_handler.js';
import { ContextHandler } from './context_handler.js';
import { TtsHandler } from './tts_handler.js';

export class SessionMessageHandler {
    /**
     * @param {GeminiSessionManager} sessionManager
     * @param {ImageManager} imageHandler
     * @param {BrowserControlManager} controlManager
     * @param {McpRemoteManager} mcpManager
     * @param {{
     *   goalManager?: object|null,
     *   compactManager?: object|null,
     *   harnessStatus?: object|null,
     *   bridgeClient?: object|null,
     * }} [ncodeDeps]
     */
    constructor(sessionManager, imageHandler, controlManager, mcpManager, ncodeDeps = {}) {
        this.sessionManager = sessionManager;
        this.ncodeDeps = ncodeDeps;
        this.promptHandler = new PromptHandler(sessionManager, controlManager, mcpManager, {
            goalManager: ncodeDeps.goalManager || null,
            compactManager: ncodeDeps.compactManager || null,
            harnessStatus: ncodeDeps.harnessStatus || null,
            bridgeClient: ncodeDeps.bridgeClient || null,
        });
        this.quickAskHandler = new QuickAskHandler(sessionManager, imageHandler);
        this.contextHandler = new ContextHandler(sessionManager);
        this.ttsHandler = new TtsHandler(sessionManager);
    }

    handle(request, sender, sendResponse) {
        if (request.action === 'SEND_PROMPT') {
            return this.promptHandler.handle(request, sendResponse);
        }

        if (request.action === 'QUICK_ASK') {
            return this.runQuickAsk(
                () => this.quickAskHandler.handleQuickAsk(request, sender),
                sender,
                sendResponse
            );
        }

        if (request.action === 'QUICK_ASK_IMAGE') {
            return this.runQuickAsk(
                () => this.quickAskHandler.handleQuickAskImage(request, sender),
                sender,
                sendResponse
            );
        }

        if (this.ttsHandler.handle(request, sendResponse)) {
            return true;
        }

        if (request.action === 'CANCEL_PROMPT') {
            const cancelled = this.cancelSidePanelRun();
            sendResponse({ status: cancelled ? 'cancelled' : 'no_active_request' });
            return false;
        }

        if (request.action === 'SET_CONTEXT') {
            return this.contextHandler.handleSetContext(request, sendResponse);
        }

        if (request.action === 'RESET_CONTEXT') {
            return this.contextHandler.handleResetContext(request, sendResponse);
        }

        return false;
    }

    // Called when the side panel is closed mid-stream. Aborts the upstream
    // provider fetch so tokens/quota are not wasted streaming into a closed
    // panel, and stops the prompt loop. (Side-panel SEND_PROMPT runs are not
    // tied to a content-script tab, so tab-close does not cover them.)
    // Returns whether an in-flight run was actually aborted.
    cancelSidePanelRun() {
        const cancelled = this.sessionManager.cancelCurrentRequest('prompt');
        this.promptHandler.cancel();
        return cancelled;
    }

    // Both quick-ask entry points need the same bracketing: claim the requesting
    // content-script tab as the active run before starting, then release it and
    // reply exactly once when the run settles.
    runQuickAsk(startRun, sender, sendResponse) {
        this.quickAskHandler.trackActiveTab(sender);
        startRun().finally(() => {
            this.quickAskHandler.clearActiveTab(sender);
            sendResponse({ status: 'completed' });
        });
        return true;
    }

    // Called when a content-script tab is closed mid-quick-ask. Aborts the
    // upstream fetch for that run so it does not stream into a dead tab.
    cancelQuickAskForTab(tabId) {
        if (this.quickAskHandler.isActiveTab(tabId)) {
            this.sessionManager.cancelCurrentRequest(`quickAsk:${tabId}`);
        }
    }
}
