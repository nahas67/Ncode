/**
 * Ncode approval manager.
 *
 * Sensitive PC tools (shell, file writes, git commits, clipboard writes, page
 * script evaluation) can be gated behind an explicit user decision. The
 * background asks the sandbox harness bar, which renders an approval strip and
 * answers with NCODE_APPROVAL_RESPONSE. The tool loop awaits that answer.
 *
 * Policy (chrome.storage.local: `ncodeApprovalPolicy`)
 *   'auto'   (default) every tool runs without prompting
 *   'ask'    risky tools require approval, read-only tools run directly
 *   'always' every tool requires approval
 *   'never'  risky tools are denied outright (headless / unattended safety)
 *
 * Timing out or closing the panel denies the request: the loop continues with a
 * tool failure instead of hanging forever.
 */
import { NCODE_ACTIONS, broadcastNcodeAction } from '../../shared/messaging/ncode_actions.js';

export const NCODE_APPROVAL_POLICY_STORAGE_KEY = 'ncodeApprovalPolicy';
export const NCODE_APPROVAL_POLICIES = Object.freeze(['auto', 'ask', 'always', 'never']);
export const NCODE_APPROVAL_DEFAULT_POLICY = 'auto';
export const NCODE_APPROVAL_DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Tools whose effect is hard to undo on the user's machine. `ask` policy gates
 * exactly this list; everything else stays automatic.
 */
export const NCODE_RISKY_TOOL_PATTERNS = Object.freeze([
    /^pc_exec_shell$/,
    /^pc_bg_process$/,
    /^pc_fs_write$/,
    /^pc_fs_patch$/,
    /^pc_git_(?:add|commit|checkout|reset)$/,
    /^pc_clipboard$/,
    /^pc_desktop_screenshot$/,
    /^evaluate$/,
    /^script_?evaluation$/,
    /^execute_script$/,
]);

function toErrorMessage(error) {
    return error && error.message ? error.message : String(error);
}

function normalizePolicy(policy) {
    return NCODE_APPROVAL_POLICIES.includes(policy) ? policy : NCODE_APPROVAL_DEFAULT_POLICY;
}

function createRequestId() {
    try {
        if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
            return `approval_${crypto.randomUUID()}`;
        }
    } catch {
        // Fall through to the timestamp form.
    }
    return `approval_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * True when `toolName` is on the risky-tool list.
 * @param {string} toolName
 * @returns {boolean}
 */
export function isRiskyToolName(toolName) {
    if (typeof toolName !== 'string' || !toolName) return false;
    return NCODE_RISKY_TOOL_PATTERNS.some((pattern) => pattern.test(toolName));
}

export class NcodeApprovalManager {
    /**
     * @param {{
     *   storageArea?: { get?: Function, set?: Function }|null,
     *   timeoutMs?: number,
     *   broadcast?: (action: string, payload: object) => Promise<boolean>,
     * }} [options]
     */
    constructor({
        storageArea = null,
        timeoutMs = NCODE_APPROVAL_DEFAULT_TIMEOUT_MS,
        broadcast = null,
    } = {}) {
        this.storageArea =
            storageArea ||
            (typeof chrome !== 'undefined' && chrome?.storage?.local ? chrome.storage.local : null);
        this.timeoutMs = Math.max(1000, Number(timeoutMs) || NCODE_APPROVAL_DEFAULT_TIMEOUT_MS);
        this.broadcastFn =
            typeof broadcast === 'function'
                ? broadcast
                : (action, payload) => broadcastNcodeAction(action, payload);
        /** @type {Map<string, {resolve: Function, timer: any, request: object}>} */
        this.pending = new Map();
        this.policy = NCODE_APPROVAL_DEFAULT_POLICY;
    }

    /** Loads the persisted policy once (best-effort). */
    async ensureInitialized() {
        if (!this.storageArea?.get) return this.policy;
        try {
            const stored = await this.storageArea.get([NCODE_APPROVAL_POLICY_STORAGE_KEY]);
            this.policy = normalizePolicy(stored?.[NCODE_APPROVAL_POLICY_STORAGE_KEY]);
        } catch (error) {
            console.warn('[Ncode] Failed to read approval policy:', toErrorMessage(error));
        }
        return this.policy;
    }

    /** Persists a new approval policy (settings UI / tests). */
    async setPolicy(policy) {
        this.policy = normalizePolicy(policy);
        try {
            await this.storageArea?.set?.({ [NCODE_APPROVAL_POLICY_STORAGE_KEY]: this.policy });
        } catch (error) {
            console.warn('[Ncode] Failed to persist approval policy:', toErrorMessage(error));
        }
        return this.policy;
    }

    getPolicy() {
        return this.policy;
    }

    /**
     * Returns whether a tool call needs an explicit approval under the current
     * policy. Reads the policy lazily so a settings change applies to the next
     * tool call without a worker restart.
     *
     * @param {string} toolName
     * @returns {Promise<boolean>}
     */
    async isApprovalRequired(toolName) {
        if (!this.policy) await this.ensureInitialized();
        if (this.policy === 'always') return true;
        if (this.policy === 'ask' || this.policy === 'never') return isRiskyToolName(toolName);
        return false;
    }

    /**
     * Tool-executor entry point: resolves to {required:false} for automatic
     * tools, otherwise waits for the sandbox decision.
     *
     * @param {{ sessionId?: string|null, workflowId?: string|null, toolName: string, toolArgs?: object }} request
     * @returns {Promise<{required: boolean, approved: boolean, requestId: string|null, reason: string|null}>}
     */
    async requestToolApproval({
        sessionId = null,
        workflowId = null,
        toolName,
        toolArgs = {},
    } = {}) {
        const required = await this.isApprovalRequired(toolName);
        if (!required) {
            return { required: false, approved: true, requestId: null, reason: null };
        }
        if (this.policy === 'never') {
            return {
                required: true,
                approved: false,
                requestId: null,
                reason: 'Approval policy is "never": risky tool calls are blocked.',
            };
        }
        const decision = await this.requestApproval({
            sessionId,
            workflowId,
            toolName,
            toolArgs,
            reason: 'This tool can change your machine.',
        });
        return { required: true, ...decision };
    }

    /**
     * Broadcasts an approval request and waits for NCODE_APPROVAL_RESPONSE.
     *
     * @param {{ sessionId?: string|null, workflowId?: string|null, toolName: string, toolArgs?: object, reason?: string, timeoutMs?: number }} request
     * @returns {Promise<{approved: boolean, requestId: string, reason: string|null}>}
     */
    async requestApproval({
        sessionId = null,
        workflowId = null,
        toolName,
        toolArgs = {},
        reason = '',
        timeoutMs,
    } = {}) {
        const requestId = createRequestId();
        const effectiveTimeout = Math.max(
            1000,
            Number(timeoutMs) || this.timeoutMs || NCODE_APPROVAL_DEFAULT_TIMEOUT_MS
        );

        const decision = new Promise((resolve) => {
            const timer = setTimeout(() => {
                this.pending.delete(requestId);
                resolve({
                    approved: false,
                    requestId,
                    reason: 'Approval request timed out.',
                });
            }, effectiveTimeout);
            this.pending.set(requestId, { resolve, timer, request: { toolName, sessionId } });
        });

        const payload = {
            requestId,
            sessionId,
            workflowId,
            toolName,
            title: `Approve ${toolName}`,
            detail: summarizeToolArgs(toolArgs),
            reason,
            ts: Date.now(),
        };
        try {
            await this.broadcastFn(NCODE_ACTIONS.APPROVAL_REQUEST, payload);
        } catch (error) {
            console.warn('[Ncode] Failed to broadcast approval request:', toErrorMessage(error));
            this.resolveApproval({
                requestId,
                approved: false,
                reason: 'Approval request could not be delivered to the UI.',
            });
        }

        return decision;
    }

    /**
     * Resolves a pending approval request. Unknown/stale ids return false.
     *
     * @param {{ requestId?: string|null, approved?: boolean, reason?: string|null }} response
     * @returns {boolean}
     */
    resolveApproval({ requestId = null, approved = false, reason = null } = {}) {
        if (!requestId || !this.pending.has(requestId)) return false;
        const entry = this.pending.get(requestId);
        this.pending.delete(requestId);
        try {
            clearTimeout(entry.timer);
        } catch {
            // Timer already fired.
        }
        entry.resolve({
            approved: approved === true,
            requestId,
            reason: typeof reason === 'string' ? reason : null,
        });
        return true;
    }

    /** Number of in-flight approval requests (tests / diagnostics). */
    getPendingCount() {
        return this.pending.size;
    }

    /** Denies every pending request (worker shutdown / run cancellation). */
    clearAll(reason = 'Approval request cancelled.') {
        for (const requestId of [...this.pending.keys()]) {
            this.resolveApproval({ requestId, approved: false, reason });
        }
    }
}

function summarizeToolArgs(toolArgs) {
    if (!toolArgs || typeof toolArgs !== 'object') return '';
    const entries = Object.entries(toolArgs).slice(0, 4);
    const summary = entries
        .map(([key, value]) => {
            const text =
                typeof value === 'string'
                    ? value
                    : (() => {
                          try {
                              return JSON.stringify(value);
                          } catch {
                              return String(value);
                          }
                      })();
            return `${key}: ${String(text).slice(0, 200)}`;
        })
        .join('\n');
    return summary.slice(0, 800);
}
