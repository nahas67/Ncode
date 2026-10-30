import { NCODE_ACTIONS } from '../../shared/messaging/ncode_actions.js';

const COLLAPSED_STORAGE_KEY = 'ncodeHarnessCollapsed';
const GOAL_MODE_STORAGE_KEY = 'ncodeGoalModeEnabled';
const COMPACTION_REQUEST_TIMEOUT_MS = 90 * 1000;
const COMPACTION_STALL_TIMEOUT_MS = 5 * 60 * 1000;
const COMPACTION_DONE_VISIBLE_MS = 2500;

/**
 * The harness bar re-probes the three connection lights on this cadence. The
 * sandbox cannot talk to `chrome.*`, so every tick posts
 * NCODE_GET_HARNESS_STATUS up the iframe -> sidepanel -> background chain and
 * the background answers with a NCODE_HARNESS_STATUS_UPDATE broadcast.
 */
const HARNESS_STATUS_POLL_INTERVAL_MS = 3000;

/** Default endpoints shown in the light labels before the first probe. */
const DEFAULT_PC_SHELL_ENDPOINT = 'http://127.0.0.1:3001/mcp';
const DEFAULT_WS_BRIDGE_ENDPOINT = 'ws://127.0.0.1:8085';

const COMPACTION_BUSY_STATES = new Set([
    'requested',
    'forced',
    'pruning',
    'compacting',
    'persisting',
    'resuming',
]);
const COMPACTION_BUSY_LABELS = {
    requested: 'Starting compact…',
    forced: 'Compacting…',
    pruning: 'Pruning…',
    compacting: 'Compacting…',
    persisting: 'Persisting…',
    resuming: 'Resuming…',
};
const COMPACTION_IDLE_LABEL = 'Compact & Resume';
const COMPACTION_FAILED_LABEL = 'Retry Compact';

const SUBGOAL_STATUS_ICONS = {
    pending: '○',
    running: '◐',
    done: '✓',
    failed: '✕',
};
const SUBGOAL_STATUS_LABELS = {
    pending: 'Pending',
    running: 'Running',
    done: 'Done',
    failed: 'Failed',
};

function readStoredFlag(storageKey, fallbackValue) {
    try {
        const storedValue = globalThis.localStorage?.getItem(storageKey);
        if (storedValue === null || storedValue === undefined) return fallbackValue;
        return storedValue === 'true';
    } catch {
        // Sandboxed iframes with an opaque origin deny storage access.
        return fallbackValue;
    }
}

function writeStoredFlag(storageKey, enabled) {
    try {
        globalThis.localStorage?.setItem(storageKey, enabled ? 'true' : 'false');
    } catch {
        // Preferences stay session-local when storage is unavailable.
    }
}

function normalizeConnection(status = {}) {
    const source = status && typeof status === 'object' ? status : {};
    return {
        geminiWebConnected: source.geminiWebConnected === true,
        geminiWebProvider:
            typeof source.geminiWebProvider === 'string' ? source.geminiWebProvider : '',
        geminiWebDetail:
            typeof source.geminiWebDetail === 'string' && source.geminiWebDetail
                ? source.geminiWebDetail
                : null,
        pcShellConnected: source.pcShellConnected === true,
        pcShellEndpoint: typeof source.pcShellEndpoint === 'string' ? source.pcShellEndpoint : '',
        pcShellToolCount: Number.isFinite(source.pcShellToolCount) ? source.pcShellToolCount : 0,
        pcShellError:
            typeof source.pcShellError === 'string' && source.pcShellError
                ? source.pcShellError
                : null,
        bridgeConnected: source.bridgeConnected === true,
        bridgeEndpoint:
            typeof source.bridgeEndpoint === 'string' && source.bridgeEndpoint
                ? source.bridgeEndpoint
                : DEFAULT_WS_BRIDGE_ENDPOINT,
        bridgeError:
            typeof source.bridgeError === 'string' && source.bridgeError
                ? source.bridgeError
                : null,
        updatedAt: Number.isFinite(source.updatedAt) ? source.updatedAt : Date.now(),
    };
}

function normalizeSubgoalStatus(status) {
    const normalized = typeof status === 'string' ? status.toLowerCase() : '';
    if (['done', 'completed', 'complete', 'success', 'succeeded'].includes(normalized)) {
        return 'done';
    }
    if (['running', 'in_progress', 'in-progress', 'active', 'working'].includes(normalized)) {
        return 'running';
    }
    if (['failed', 'error', 'blocked', 'cancelled', 'canceled'].includes(normalized)) {
        return 'failed';
    }
    return 'pending';
}

function normalizeSubgoal(subgoal) {
    const source = subgoal && typeof subgoal === 'object' ? subgoal : {};
    return {
        id: typeof source.id === 'string' ? source.id : '',
        title: typeof source.title === 'string' ? source.title : '',
        role: typeof source.role === 'string' ? source.role : '',
        status: normalizeSubgoalStatus(source.status),
        evidence: typeof source.evidence === 'string' ? source.evidence : '',
    };
}

function normalizeGoalSession(goalSession) {
    if (!goalSession || typeof goalSession !== 'object') return null;
    return {
        workflowId: typeof goalSession.workflowId === 'string' ? goalSession.workflowId : '',
        rootGoal: typeof goalSession.rootGoal === 'string' ? goalSession.rootGoal : '',
        subgoals: Array.isArray(goalSession.subgoals)
            ? goalSession.subgoals.map(normalizeSubgoal)
            : [],
        iterationCount: Number.isFinite(goalSession.iterationCount)
            ? goalSession.iterationCount
            : 0,
        maxIterations: Number.isFinite(goalSession.maxIterations) ? goalSession.maxIterations : 0,
        status: typeof goalSession.status === 'string' ? goalSession.status : 'pending',
        completionMarked: goalSession.completionMarked === true,
        createdAt: Number.isFinite(goalSession.createdAt) ? goalSession.createdAt : null,
        updatedAt: Number.isFinite(goalSession.updatedAt) ? goalSession.updatedAt : null,
    };
}

function formatCompactionDetail(detail) {
    if (typeof detail === 'string') return detail.trim();
    if (!detail || typeof detail !== 'object') return '';

    const parts = [];
    if (typeof detail.error === 'string' && detail.error) {
        parts.push(detail.error);
    }
    if (typeof detail.reason === 'string' && detail.reason) {
        parts.push(detail.reason.replace(/[_-]+/g, ' '));
    }
    if (Number.isFinite(detail.prunedChars) && detail.prunedChars > 0) {
        parts.push(`pruned ${detail.prunedChars} chars`);
    }
    if (Number.isFinite(detail.messageCount) && detail.messageCount > 0) {
        parts.push(`${detail.messageCount} messages`);
    }
    if (typeof detail.checkpointId === 'string' && detail.checkpointId) {
        parts.push(`checkpoint ${detail.checkpointId}`);
    }
    if (detail.contextReset === true) {
        parts.push('fresh web context');
    }
    return parts.slice(0, 2).join(' · ');
}

function formatStateLabel(state) {
    return String(state || '')
        .replace(/[_-]+/g, ' ')
        .replace(/\b[a-z]/g, (letter) => letter.toUpperCase())
        .trim();
}

function normalizeCompactionState(payload) {
    const source = payload && typeof payload === 'object' ? payload : {};
    const state = typeof source.state === 'string' ? source.state.toLowerCase() : '';
    return {
        sessionId: source.sessionId ?? null,
        workflowId: source.workflowId ?? null,
        state,
        detail: formatCompactionDetail(source.detail),
        checkpoint:
            source.checkpoint && typeof source.checkpoint === 'object' ? source.checkpoint : null,
        local: source.local === true,
    };
}

function getEndpointPort(endpoint) {
    if (typeof endpoint !== 'string') return '3001';
    const match = endpoint.match(/:(\d{2,5})(?:\/|$)/);
    return match ? match[1] : '3001';
}

function capitalizeLabel(value) {
    const text = String(value || '');
    return text ? text.charAt(0).toUpperCase() + text.slice(1) : '';
}

function formatRoleLabel(role) {
    const normalized = String(role || '')
        .replace(/[_-]+/g, ' ')
        .trim();
    return normalized || 'task';
}

function formatGoalMeta(goalSession) {
    if (!goalSession) return '';
    const statusLabel = capitalizeLabel(
        String(goalSession.status || 'pending').replace(/[_-]+/g, ' ')
    );
    const iterationCount = goalSession.iterationCount || 0;
    const maxIterations = goalSession.maxIterations || 0;
    const iterationLabel =
        maxIterations > 0
            ? `Iteration ${iterationCount}/${maxIterations}`
            : `Iteration ${iterationCount}`;
    return `${statusLabel} · ${iterationLabel}`;
}

export class NcodeHarnessBar {
    constructor(options = {}) {
        const { elements = {}, callbacks = {} } = options;
        const getElement = (id) => document.getElementById(id);

        this.elements = {
            bar: elements.bar || getElement('ncode-harness-bar'),
            geminiStatus: elements.geminiStatus || getElement('ncode-gemini-status'),
            pcStatus: elements.pcStatus || getElement('ncode-pc-status'),
            bridgeStatus: elements.bridgeStatus || getElement('ncode-bridge-status'),
            goalModeToggle: elements.goalModeToggle || getElement('ncode-goal-mode-toggle'),
            preambleTicker: elements.preambleTicker || getElement('ncode-preamble-ticker'),
            preambleText: elements.preambleText || getElement('ncode-preamble-text'),
            goalToggle: elements.goalToggle || getElement('ncode-goal-toggle'),
            compactBtn: elements.compactBtn || getElement('ncode-compact-btn'),
            compactionStatus: elements.compactionStatus || getElement('ncode-compaction-status'),
            approval: elements.approval || getElement('ncode-approval'),
            approvalTitle: elements.approvalTitle || getElement('ncode-approval-title'),
            approvalDetail: elements.approvalDetail || getElement('ncode-approval-detail'),
            approvalApprove: elements.approvalApprove || getElement('ncode-approval-approve'),
            approvalDeny: elements.approvalDeny || getElement('ncode-approval-deny'),
            goalPanel: elements.goalPanel || getElement('ncode-goal-panel'),
            goalRoot: elements.goalRoot || getElement('ncode-goal-root'),
            goalMeta: elements.goalMeta || getElement('ncode-goal-meta'),
            goalList: elements.goalList || getElement('ncode-goal-list'),
            goalReset: elements.goalReset || getElement('ncode-goal-reset'),
        };

        this.state = {
            connection: null,
            preamble: null,
            goalSession: null,
            compactionState: null,
            approval: null,
            collapsed: false,
            goalModeEnabled: true,
        };

        this.sessionId = null;
        this.callbacks = {};
        this.initialized = false;
        this.initialStateRequested = false;
        this.statusPollTimer = null;
        this.compactionRequestTimer = null;
        this.compactionDoneTimer = null;
        this.assignCallbacks(callbacks);
    }

    init(callbacks = {}) {
        if (this.initialized) return this;
        this.initialized = true;
        this.assignCallbacks(callbacks);
        this.restorePreferences();
        this.bindHandlers();
        this.markHarnessPresent();
        this.renderGoalMode();
        this.renderConnection();
        this.renderPreamble();
        this.renderGoalSession();
        this.renderCompaction();
        this.renderApproval();
        this.observeBarLayout();
        this.startStatusPolling();
        return this;
    }

    assignCallbacks(callbacks) {
        if (!callbacks || typeof callbacks !== 'object') return;
        for (const callbackName of ['onCompactResume', 'onResetGoal', 'onGoalModeChange']) {
            if (typeof callbacks[callbackName] === 'function') {
                this.callbacks[callbackName] = callbacks[callbackName];
            }
        }
    }

    restorePreferences() {
        this.state.collapsed = readStoredFlag(COLLAPSED_STORAGE_KEY, false);
        this.state.goalModeEnabled = readStoredFlag(GOAL_MODE_STORAGE_KEY, true);
    }

    markHarnessPresent() {
        document.body?.classList.add('ncode-harness-present');
    }

    /**
     * Keeps `--ncode-harness-offset` in sync with the real bar bottom edge so
     * the fixed-position empty state always clears the bar, even when the bar
     * wraps onto several rows at narrow sidepanel widths.
     */
    observeBarLayout() {
        this.syncBarOffset();
        if (typeof ResizeObserver !== 'undefined' && this.elements.bar) {
            this.barResizeObserver = new ResizeObserver(() => this.syncBarOffset());
            this.barResizeObserver.observe(this.elements.bar);
        }
        if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
            window.addEventListener('resize', () => this.syncBarOffset());
        }
        if (typeof MutationObserver !== 'undefined' && document.body) {
            this.bodyClassObserver = new MutationObserver(() => this.syncBarOffset());
            this.bodyClassObserver.observe(document.body, {
                attributes: true,
                attributeFilter: ['class'],
            });
        }
    }

    syncBarOffset() {
        const barElement = this.elements.bar;
        if (!barElement || typeof barElement.getBoundingClientRect !== 'function') return;
        const barRect = barElement.getBoundingClientRect();
        const barBottom = Math.ceil(barRect.bottom || 0);
        if (barBottom > 0) {
            document.documentElement.style.setProperty('--ncode-harness-offset', `${barBottom}px`);
        }
    }

    bindHandlers() {
        this.elements.goalModeToggle?.addEventListener('click', () => {
            this.setGoalModeEnabled(!this.state.goalModeEnabled);
        });
        this.elements.goalToggle?.addEventListener('click', () => {
            this.setCollapsed(!this.state.collapsed);
        });
        this.elements.compactBtn?.addEventListener('click', () => {
            this.requestCompactResume();
        });
        this.elements.goalReset?.addEventListener('click', () => {
            this.requestResetGoal();
        });
        this.elements.approvalApprove?.addEventListener('click', () => {
            this.requestApprovalResponse(true);
        });
        this.elements.approvalDeny?.addEventListener('click', () => {
            this.requestApprovalResponse(false);
        });
        this.elements.bar?.addEventListener('keydown', (event) => {
            this.handleKeydown(event);
        });
    }

    handleKeydown(event) {
        if (event.key !== 'Escape') return;
        if (!this.isGoalPanelExpanded()) return;
        event.preventDefault();
        this.setCollapsed(true);
        this.elements.goalToggle?.focus?.();
    }

    setConnectionStatus(status) {
        this.state.connection = normalizeConnection(status);
        this.renderConnection();
    }

    setPreamble(payload) {
        const source = payload && typeof payload === 'object' ? payload : {};
        const text = typeof source.text === 'string' ? source.text.trim() : '';
        this.state.preamble = {
            text,
            ts: Number.isFinite(source.ts) ? source.ts : Date.now(),
            sessionId: source.sessionId ?? null,
            workflowId: source.workflowId ?? null,
        };
        if (this.state.preamble.sessionId != null) {
            this.sessionId = this.state.preamble.sessionId;
        }
        this.renderPreamble();
    }

    setGoalSession(goalSession, sessionId) {
        this.state.goalSession = normalizeGoalSession(goalSession);
        if (sessionId !== undefined) {
            this.sessionId = sessionId;
        }
        this.renderGoalSession();
    }

    setCompactionState(payload) {
        this.clearCompactionTimers();
        this.state.compactionState = payload ? normalizeCompactionState(payload) : null;
        if (this.state.compactionState?.sessionId != null) {
            this.sessionId = this.state.compactionState.sessionId;
        }
        this.renderCompaction();
        const stateName = this.state.compactionState?.state || '';
        if (COMPACTION_BUSY_STATES.has(stateName)) {
            this.compactionRequestTimer = setTimeout(() => {
                this.handleCompactionStall();
            }, COMPACTION_STALL_TIMEOUT_MS);
        } else if (stateName === 'done') {
            this.compactionDoneTimer = setTimeout(() => {
                this.compactionDoneTimer = null;
                if (this.state.compactionState?.state === 'done') {
                    this.state.compactionState = null;
                    this.renderCompaction();
                }
            }, COMPACTION_DONE_VISIBLE_MS);
        }
    }

    /** Re-enables the compact button when the harness reports no progress at all. */
    handleCompactionStall() {
        this.compactionRequestTimer = null;
        if (!this.isCompactionBusy()) return;
        this.state.compactionState = {
            sessionId: this.getActiveSessionId(),
            workflowId: this.state.goalSession?.workflowId || null,
            state: 'failed',
            detail: 'Compaction stalled — no progress reported',
            checkpoint: null,
            local: this.state.compactionState?.local === true,
        };
        this.renderCompaction();
    }

    isGoalModeEnabled() {
        return this.state.goalModeEnabled === true;
    }

    setGoalModeEnabled(enabled) {
        const nextEnabled = enabled === true;
        this.state.goalModeEnabled = nextEnabled;
        writeStoredFlag(GOAL_MODE_STORAGE_KEY, nextEnabled);
        this.renderGoalMode();
        document.dispatchEvent(
            new CustomEvent('ncode-goal-mode-changed', { detail: { enabled: nextEnabled } })
        );
        if (typeof this.callbacks.onGoalModeChange === 'function') {
            this.callbacks.onGoalModeChange(nextEnabled);
        }
        return nextEnabled;
    }

    setCollapsed(collapsed) {
        this.state.collapsed = collapsed === true;
        writeStoredFlag(COLLAPSED_STORAGE_KEY, this.state.collapsed);
        this.applyGoalPanelVisibility();
    }

    isCompactionBusy() {
        return COMPACTION_BUSY_STATES.has(this.state.compactionState?.state || '');
    }

    /**
     * Requests a harness status snapshot from the background. Idempotent for the
     * boot hydration call so a slow first probe cannot queue duplicates; the 3s
     * poller calls `requestStatus()` directly instead.
     */
    requestInitialState() {
        if (this.initialStateRequested) return;
        this.initialStateRequested = true;
        this.requestStatus();
    }

    /** Posts NCODE_GET_HARNESS_STATUS up to the sidepanel bridge. */
    requestStatus() {
        this.postToParent(NCODE_ACTIONS.GET_HARNESS_STATUS, { ts: Date.now() });
        return true;
    }

    /**
     * Starts the 3 second live connection-light poll. Safe to call twice and a
     * no-op when the sandbox has no parent frame (unit tests).
     */
    startStatusPolling() {
        if (this.statusPollTimer) return this.statusPollTimer;
        const setIntervalFn = globalThis.setInterval;
        if (typeof setIntervalFn !== 'function') return null;
        this.statusPollTimer = setIntervalFn(() => {
            this.requestStatus();
        }, HARNESS_STATUS_POLL_INTERVAL_MS);
        return this.statusPollTimer;
    }

    /** Stops the live connection-light poll. */
    stopStatusPolling() {
        if (!this.statusPollTimer) return;
        globalThis.clearInterval?.(this.statusPollTimer);
        this.statusPollTimer = null;
    }

    /** Releases every timer owned by the bar (page teardown / tests). */
    teardown() {
        this.stopStatusPolling();
        this.clearCompactionTimers();
    }

    requestCompactResume() {
        if (this.isCompactionBusy()) return false;
        const sessionId = this.getActiveSessionId();
        this.clearCompactionTimers();
        this.state.compactionState = {
            sessionId,
            workflowId: this.state.goalSession?.workflowId || null,
            state: 'compacting',
            detail: 'Requesting compact & resume…',
            checkpoint: null,
            local: true,
        };
        this.renderCompaction();
        this.compactionRequestTimer = setTimeout(() => {
            this.compactionRequestTimer = null;
            if (this.state.compactionState?.local !== true) return;
            this.state.compactionState = {
                sessionId,
                workflowId: this.state.goalSession?.workflowId || null,
                state: 'failed',
                detail: 'Compact & resume request timed out',
                checkpoint: null,
                local: true,
            };
            this.renderCompaction();
        }, COMPACTION_REQUEST_TIMEOUT_MS);

        const payload = { sessionId, force: true };
        if (typeof this.callbacks.onCompactResume === 'function') {
            this.callbacks.onCompactResume(payload);
        } else {
            this.postToParent(NCODE_ACTIONS.TRIGGER_COMPACT_RESUME, payload);
        }
        return true;
    }

    requestResetGoal() {
        const payload = { sessionId: this.getActiveSessionId() };
        if (typeof this.callbacks.onResetGoal === 'function') {
            this.callbacks.onResetGoal(payload);
        } else {
            this.postToParent(NCODE_ACTIONS.RESET_GOAL, payload);
        }
        this.state.goalSession = null;
        this.renderGoalSession();
        return true;
    }

    /**
     * Asks the background to flip a subgoal status. `requestedStatus` defaults
     * to the natural toggle (done <-> pending).
     * @param {string} subgoalId
     * @param {'pending'|'done'} [requestedStatus]
     */
    requestSubgoalToggle(subgoalId, requestedStatus) {
        if (typeof subgoalId !== 'string' || !subgoalId) return false;
        const subgoal = (this.state.goalSession?.subgoals || []).find(
            (candidate) => candidate.id === subgoalId
        );
        if (!subgoal) return false;
        const nextStatus =
            requestedStatus === 'pending' || requestedStatus === 'done'
                ? requestedStatus
                : subgoal.status === 'done'
                  ? 'pending'
                  : 'done';
        const payload = {
            sessionId: this.getActiveSessionId(),
            workflowId: this.state.goalSession?.workflowId || null,
            subgoalId,
            status: nextStatus,
        };
        if (typeof this.callbacks.onSubgoalToggle === 'function') {
            this.callbacks.onSubgoalToggle(payload);
        } else {
            this.postToParent(NCODE_ACTIONS.SUBGOAL_TOGGLE, payload);
        }
        // Optimistic local paint; the authoritative NCODE_GOAL_STATE_UPDATE
        // broadcast follows from the background.
        subgoal.status = nextStatus;
        this.renderGoalSession();
        return true;
    }

    /**
     * Shows an approval request raised by the background tool loop.
     * @param {{requestId?: string, toolName?: string, title?: string, detail?: string, reason?: string}} request
     */
    setApprovalRequest(request) {
        if (!request || typeof request !== 'object' || !request.requestId) {
            return false;
        }
        this.state.approval = {
            requestId: String(request.requestId),
            toolName: typeof request.toolName === 'string' ? request.toolName : '',
            title:
                typeof request.title === 'string' && request.title
                    ? request.title
                    : `Approve ${request.toolName || 'tool call'}`,
            detail:
                typeof request.detail === 'string'
                    ? request.detail
                    : typeof request.reason === 'string'
                      ? request.reason
                      : '',
        };
        this.renderApproval();
        return true;
    }

    /** Clears the approval strip (approved, denied or timed out). */
    clearApprovalRequest() {
        this.state.approval = null;
        this.renderApproval();
    }

    /**
     * Sends the user's decision for the pending approval request.
     * @param {boolean} approved
     */
    requestApprovalResponse(approved) {
        const approval = this.state.approval;
        if (!approval) return false;
        const payload = {
            requestId: approval.requestId,
            approved: approved === true,
            sessionId: this.getActiveSessionId(),
        };
        this.clearApprovalRequest();
        if (typeof this.callbacks.onApprovalResponse === 'function') {
            this.callbacks.onApprovalResponse(payload);
        } else {
            this.postToParent(NCODE_ACTIONS.APPROVAL_RESPONSE, payload);
        }
        return true;
    }

    getActiveSessionId() {
        return (
            this.sessionId ??
            this.state.preamble?.sessionId ??
            this.state.compactionState?.sessionId ??
            null
        );
    }

    postToParent(action, payload) {
        const message = payload === undefined ? { action } : { action, payload };
        window.parent?.postMessage?.(message, '*');
    }

    clearCompactionTimers() {
        if (this.compactionRequestTimer) {
            clearTimeout(this.compactionRequestTimer);
            this.compactionRequestTimer = null;
        }
        if (this.compactionDoneTimer) {
            clearTimeout(this.compactionDoneTimer);
            this.compactionDoneTimer = null;
        }
    }

    renderConnection() {
        const connection = this.state.connection;
        const geminiConnected = connection ? connection.geminiWebConnected : null;
        const geminiTitle = connection
            ? connection.geminiWebConnected
                ? connection.geminiWebDetail || 'Gemini Web session is connected'
                : 'Gemini Web session is not connected'
            : 'Checking the Gemini Web session';
        this.renderStatusPill(
            this.elements.geminiStatus,
            geminiConnected,
            connection
                ? connection.geminiWebConnected
                    ? 'Gemini Web (Connected)'
                    : 'Gemini Web (Disconnected)'
                : 'Gemini Web (Checking)',
            geminiTitle
        );

        const endpointPort = getEndpointPort(connection?.pcShellEndpoint);
        const pcConnected = connection ? connection.pcShellConnected : null;
        const pcTitle = connection
            ? connection.pcShellConnected
                ? [
                      connection.pcShellEndpoint || `Port ${endpointPort}`,
                      connection.pcShellToolCount > 0
                          ? `${connection.pcShellToolCount} tools available`
                          : 'no tools reported',
                  ].join(' · ')
                : connection.pcShellError || 'PC Shell MCP daemon is not reachable'
            : 'Checking the PC Shell MCP connection';
        this.renderStatusPill(
            this.elements.pcStatus,
            pcConnected,
            connection
                ? `PC Shell MCP (Port ${endpointPort} ${
                      connection.pcShellConnected ? 'Connected' : 'Disconnected'
                  })`
                : 'PC Shell MCP (Checking)',
            pcTitle
        );

        const bridgeEndpoint = connection?.bridgeEndpoint || DEFAULT_WS_BRIDGE_ENDPOINT;
        const bridgePort = getEndpointPort(bridgeEndpoint);
        const bridgeConnected = connection ? connection.bridgeConnected : null;
        const bridgeTitle = connection
            ? connection.bridgeConnected
                ? `${bridgeEndpoint} · websocket bridge connected`
                : connection.bridgeError || 'WS bridge is not reachable'
            : 'Checking the WS bridge connection';
        this.renderStatusPill(
            this.elements.bridgeStatus,
            bridgeConnected,
            connection
                ? `WS Bridge (Port ${bridgePort} ${
                      connection.bridgeConnected ? 'Connected' : 'Disconnected'
                  })`
                : 'WS Bridge (Checking)',
            bridgeTitle
        );
    }

    renderStatusPill(pillElement, connected, label, title) {
        if (!pillElement) return;
        pillElement.classList.toggle('is-connected', connected === true);
        pillElement.classList.toggle('connected', connected === true);
        pillElement.classList.toggle('is-disconnected', connected === false);
        pillElement.classList.toggle('disconnected', connected === false);
        pillElement.classList.toggle('is-unknown', connected === null);
        pillElement.classList.toggle('unknown', connected === null);
        pillElement.title = title;
        const textElement = pillElement.querySelector?.('.ncode-status-text');
        if (textElement) {
            textElement.textContent = label;
        } else {
            pillElement.textContent = label;
        }
    }

    renderPreamble() {
        const preambleText = this.state.preamble?.text || '';
        const isIdle = preambleText.length === 0;
        if (this.elements.preambleText) {
            this.elements.preambleText.textContent = isIdle ? 'Idle' : preambleText;
        }
        const ticker = this.elements.preambleTicker;
        if (!ticker) return;
        ticker.classList.toggle('is-idle', isIdle);
        ticker.title = isIdle ? 'Live Ncode preamble (idle)' : preambleText;
        if (isIdle) return;
        ticker.classList.remove('is-updated');
        void ticker.offsetWidth;
        ticker.classList.add('is-updated');
    }

    renderGoalMode() {
        const toggle = this.elements.goalModeToggle;
        if (!toggle) return;
        const enabled = this.isGoalModeEnabled();
        toggle.classList.toggle('is-on', enabled);
        toggle.setAttribute('aria-pressed', enabled ? 'true' : 'false');
        toggle.title = `Astra Goal Loop autonomy is ${enabled ? 'on' : 'off'}`;
        toggle.setAttribute(
            'aria-label',
            `Toggle Goal Loop autonomy (currently ${enabled ? 'on' : 'off'})`
        );
    }

    renderGoalSession() {
        const goalSession = this.state.goalSession;
        const subgoals = goalSession?.subgoals || [];
        const doneCount = subgoals.filter((subgoal) => subgoal.status === 'done').length;
        const totalCount = subgoals.length;

        const toggle = this.elements.goalToggle;
        if (toggle) {
            toggle.hidden = totalCount === 0;
            const countLabel = `Subgoals ${doneCount}/${totalCount}`;
            const countElement = toggle.querySelector?.('.ncode-goal-toggle-label');
            if (countElement) {
                countElement.textContent = countLabel;
            } else {
                toggle.textContent = countLabel;
            }
            toggle.title = `Toggle the subgoal checklist (${doneCount} of ${totalCount} complete)`;
            toggle.setAttribute(
                'aria-label',
                `Toggle subgoals (${doneCount} of ${totalCount} done)`
            );
        }

        if (this.elements.goalRoot) {
            this.elements.goalRoot.textContent = goalSession?.rootGoal || '';
        }
        if (this.elements.goalMeta) {
            this.elements.goalMeta.textContent = formatGoalMeta(goalSession);
        }
        this.renderGoalList(subgoals);
        this.applyGoalPanelVisibility();
    }

    renderGoalList(subgoals) {
        const listElement = this.elements.goalList;
        if (!listElement) return;
        if (typeof listElement.replaceChildren === 'function') {
            listElement.replaceChildren();
        } else {
            listElement.textContent = '';
        }
        if (subgoals.length === 0) return;
        const fragment = document.createDocumentFragment();
        for (const subgoal of subgoals) {
            fragment.appendChild(this.createGoalRow(subgoal));
        }
        listElement.appendChild(fragment);
    }

    createGoalRow(subgoal) {
        const row = document.createElement('li');
        row.className = `ncode-goal-row is-${subgoal.status} ${subgoal.status}`;
        if (subgoal.id) row.dataset.goalId = subgoal.id;

        const roleBadge = document.createElement('span');
        roleBadge.className = 'ncode-goal-role';
        roleBadge.textContent = formatRoleLabel(subgoal.role);

        const statusIcon = document.createElement('span');
        statusIcon.className = 'ncode-goal-status-icon';
        statusIcon.setAttribute('aria-hidden', 'true');
        statusIcon.textContent =
            SUBGOAL_STATUS_ICONS[subgoal.status] || SUBGOAL_STATUS_ICONS.pending;

        const titleElement = document.createElement('span');
        titleElement.className = 'ncode-goal-title';
        titleElement.textContent = subgoal.title || 'Untitled subgoal';
        if (subgoal.evidence) titleElement.title = subgoal.evidence;

        const statusText = document.createElement('span');
        statusText.className = 'ncode-visually-hidden';
        const statusLabel = SUBGOAL_STATUS_LABELS[subgoal.status] || SUBGOAL_STATUS_LABELS.pending;
        statusText.textContent = `${statusLabel}${subgoal.evidence ? `: ${subgoal.evidence}` : ''}`;

        row.append(roleBadge, statusIcon, titleElement, statusText);
        row.title = subgoal.evidence || `${subgoal.title || 'Untitled subgoal'} · ${statusLabel}`;
        if (subgoal.id) {
            row.setAttribute('role', 'button');
            row.setAttribute('tabindex', '0');
            row.setAttribute('aria-pressed', subgoal.status === 'done' ? 'true' : 'false');
            row.addEventListener('click', () => {
                this.requestSubgoalToggle(subgoal.id);
            });
            row.addEventListener('keydown', (event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                this.requestSubgoalToggle(subgoal.id);
            });
        }
        return row;
    }

    /**
     * Renders the explicit approval strip raised for a sensitive tool call.
     * Hidden whenever no request is pending.
     */
    renderApproval() {
        const approval = this.state.approval;
        const container = this.elements.approval;
        if (!container) return;
        container.hidden = approval === null;
        if (approval === null) return;
        if (this.elements.approvalTitle) {
            this.elements.approvalTitle.textContent = approval.title;
        }
        if (this.elements.approvalDetail) {
            this.elements.approvalDetail.textContent = approval.detail;
        }
        if (this.elements.approvalApprove) {
            this.elements.approvalApprove.setAttribute(
                'aria-label',
                `Approve ${approval.toolName || 'tool call'}`
            );
        }
        if (this.elements.approvalDeny) {
            this.elements.approvalDeny.setAttribute(
                'aria-label',
                `Deny ${approval.toolName || 'tool call'}`
            );
        }
    }

    applyGoalPanelVisibility() {
        const hasGoal = this.state.goalSession !== null;
        const panelHidden = !hasGoal || this.state.collapsed;
        if (this.elements.goalPanel) {
            this.elements.goalPanel.hidden = panelHidden;
        }
        if (this.elements.goalToggle) {
            this.elements.goalToggle.setAttribute('aria-expanded', panelHidden ? 'false' : 'true');
        }
    }

    isGoalPanelExpanded() {
        const panel = this.elements.goalPanel;
        if (!panel) return false;
        return panel.hidden !== true;
    }

    renderCompaction() {
        const compaction = this.state.compactionState;
        const stateName = compaction?.state || '';
        const isBusy = COMPACTION_BUSY_STATES.has(stateName);
        const compactButton = this.elements.compactBtn;

        if (compactButton) {
            const buttonLabel = isBusy
                ? COMPACTION_BUSY_LABELS[stateName] || 'Compacting…'
                : stateName === 'failed'
                  ? COMPACTION_FAILED_LABEL
                  : COMPACTION_IDLE_LABEL;
            compactButton.disabled = isBusy;
            compactButton.setAttribute('aria-busy', isBusy ? 'true' : 'false');
            compactButton.classList.toggle('is-busy', isBusy);
            compactButton.classList.toggle('is-error', stateName === 'failed');
            const labelElement = compactButton.querySelector?.('.ncode-compact-label');
            if (labelElement) {
                labelElement.textContent = buttonLabel;
            } else {
                compactButton.textContent = buttonLabel;
            }
            compactButton.setAttribute(
                'aria-label',
                isBusy ? buttonLabel : 'Compact context and resume the goal loop'
            );
            compactButton.title =
                stateName === 'failed' && compaction?.detail
                    ? compaction.detail
                    : 'Compact context and resume the goal loop';
        }

        const statusElement = this.elements.compactionStatus;
        if (!statusElement) return;
        let statusText = '';
        if (isBusy) {
            statusText = compaction?.detail || COMPACTION_BUSY_LABELS[stateName] || 'Compacting…';
        } else if (stateName === 'failed') {
            statusText = compaction?.detail || 'Compaction failed';
        } else if (stateName === 'done') {
            statusText = compaction?.detail
                ? `Compaction complete · ${compaction.detail}`
                : 'Compaction complete';
        } else if (stateName === 'degraded') {
            statusText = compaction?.detail
                ? `Heuristic summary · ${compaction.detail}`
                : 'Heuristic summary used';
        } else if (stateName === 'resumed' || stateName === 'resumed_context') {
            statusText = compaction?.detail || 'Context resumed';
        } else if (stateName) {
            statusText = compaction?.detail || formatStateLabel(stateName);
        }
        statusElement.textContent = statusText;
        statusElement.hidden = statusText === '';
        statusElement.classList.toggle('is-error', stateName === 'failed');
        statusElement.classList.toggle('is-busy', isBusy);
        statusElement.classList.toggle('is-warning', stateName === 'degraded');
    }
}
