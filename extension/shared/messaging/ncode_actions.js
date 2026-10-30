/**
 * Canonical Ncode harness message actions.
 *
 * The Ncode UI runs inside a sandboxed iframe (`sandbox/index.html`) and cannot
 * call `chrome.runtime.sendMessage` directly. Every harness action therefore
 * traverses four hops:
 *
 *   sandbox UI  ->  sidepanel frame/actions  ->  background runtime listener
 *   sandbox UI  <-  sidepanel bridge         <-  background broadcast
 *
 * This module is the single source of truth for the action names used on that
 * pipeline so the sandbox, the sidepanel bridge and the service worker can
 * never drift apart. Legacy names emitted by older panels (or persisted runs
 * restored after an update) are accepted everywhere and canonicalised here.
 */

/** @typedef {typeof NCODE_ACTIONS[keyof typeof NCODE_ACTIONS]} NcodeAction */

export const NCODE_ACTIONS = Object.freeze({
    /** Sandbox -> background: request a live harness status probe + snapshot. */
    GET_HARNESS_STATUS: 'NCODE_GET_HARNESS_STATUS',
    /** Background -> UI broadcast: fresh 3-light connection snapshot. */
    HARNESS_STATUS_UPDATE: 'NCODE_HARNESS_STATUS_UPDATE',
    /** Sandbox -> background: manually compact the run and resume the goal. */
    TRIGGER_COMPACT_RESUME: 'NCODE_TRIGGER_COMPACT_RESUME',
    /** Background -> UI broadcast: goal session / subgoal checklist update. */
    GOAL_STATE_UPDATE: 'NCODE_GOAL_STATE_UPDATE',
    /** Background -> UI broadcast: live interim preamble ticker text. */
    INTERIM_PREAMBLE: 'NCODE_INTERIM_PREAMBLE',
    /** Sandbox -> background: flip a subgoal between pending and done. */
    SUBGOAL_TOGGLE: 'NCODE_SUBGOAL_TOGGLE',
    /** Background -> UI: a tool call needs explicit user approval. */
    APPROVAL_REQUEST: 'NCODE_APPROVAL_REQUEST',
    /** Sandbox -> background: approve or deny a pending approval request. */
    APPROVAL_RESPONSE: 'NCODE_APPROVAL_RESPONSE',
    /** Background -> UI broadcast: compaction lifecycle progress. */
    COMPACTION_STATE: 'NCODE_COMPACTION_STATE',
    /** Legacy hydration request kept for older panels. */
    GET_STATE: 'NCODE_GET_STATE',
    /** Sandbox -> background: clear the goal state for the active session. */
    RESET_GOAL: 'NCODE_RESET_GOAL',
});

/**
 * Legacy action -> canonical action.
 *
 * Older Ncode builds (and the native logger bridge payloads captured from
 * them) emit the short names on the left. They remain valid inbound requests
 * but every outbound UI broadcast uses the canonical names above.
 * @type {Readonly<Record<string, NcodeAction>>}
 */
export const NCODE_LEGACY_ACTION_ALIASES = Object.freeze({
    NCODE_HARNESS_STATUS: NCODE_ACTIONS.HARNESS_STATUS_UPDATE,
    NCODE_GOAL_STATE: NCODE_ACTIONS.GOAL_STATE_UPDATE,
    NCODE_PREAMBLE: NCODE_ACTIONS.INTERIM_PREAMBLE,
    NCODE_COMPACT_RESUME: NCODE_ACTIONS.TRIGGER_COMPACT_RESUME,
});

/**
 * Canonical action -> legacy aliases that older consumers still listen for.
 * Outbound broadcasts send the canonical action plus these aliases so an
 * extension updated in place keeps working with a stale sandbox that has not
 * reloaded yet.
 * @type {Readonly<Record<string, readonly string[]>>}
 */
export const NCODE_LEGACY_BROADCAST_ALIASES = Object.freeze({
    [NCODE_ACTIONS.HARNESS_STATUS_UPDATE]: ['NCODE_HARNESS_STATUS'],
    [NCODE_ACTIONS.GOAL_STATE_UPDATE]: ['NCODE_GOAL_STATE'],
    [NCODE_ACTIONS.INTERIM_PREAMBLE]: ['NCODE_PREAMBLE'],
    [NCODE_ACTIONS.TRIGGER_COMPACT_RESUME]: ['NCODE_COMPACT_RESUME'],
});

/** Every action name Ncode owns (canonical + legacy). */
export const NCODE_ACTION_NAMES = Object.freeze([
    ...Object.values(NCODE_ACTIONS),
    ...Object.keys(NCODE_LEGACY_ACTION_ALIASES),
]);

/**
 * True when the action belongs to the Ncode harness protocol.
 * @param {unknown} action
 * @returns {boolean}
 */
export function isNcodeAction(action) {
    return typeof action === 'string' && action.startsWith('NCODE_');
}

/**
 * Canonicalises a legacy Ncode action; unknown actions pass through.
 * @param {string} action
 * @returns {string}
 */
export function canonicalNcodeAction(action) {
    if (typeof action !== 'string') return '';
    return NCODE_LEGACY_ACTION_ALIASES[action] || action;
}

/**
 * Returns the legacy aliases that should also be delivered for a canonical
 * broadcast action.
 * @param {string} action
 * @returns {readonly string[]}
 */
export function legacyAliasesFor(action) {
    return NCODE_LEGACY_BROADCAST_ALIASES[action] || [];
}

function isChromeRuntimeAvailable() {
    return typeof chrome !== 'undefined' && Boolean(chrome?.runtime?.sendMessage);
}

/**
 * Broadcasts an Ncode harness action to extension pages (sidepanel).
 *
 * Best-effort: a closed panel / shutting-down worker must never throw into the
 * goal loop or the message listener. Broadcasts the canonical action plus any
 * legacy aliases an older sandbox may still be listening for.
 *
 * @param {string} action canonical action name
 * @param {Record<string, unknown>} [payload]
 * @returns {Promise<boolean>} true when every broadcast was dispatched
 */
export async function broadcastNcodeAction(action, payload = {}) {
    if (!isChromeRuntimeAvailable()) return false;
    const actionNames = [action, ...legacyAliasesFor(action)];
    let delivered = true;
    for (const actionName of actionNames) {
        try {
            await chrome.runtime.sendMessage({ action: actionName, ...payload });
        } catch {
            // No receivers (sidepanel closed) or worker shutting down.
            delivered = false;
        }
    }
    return delivered;
}
