/**
 * Ncode harness actions handled on the background/UI boundary.
 *
 * These are the requests the sandbox harness bar posts up through the sidepanel
 * bridge: live status probes, manual Compact & Resume, goal reset, subgoal
 * checklist toggles and approval decisions. They live in the UI handler (not the
 * session prompt handler) because they only mutate Ncode harness state.
 *
 * Every action is canonicalised first so legacy panels (and messages replayed
 * from an older build) keep working, and every branch answers exactly once so
 * the sandbox never waits on a hung request.
 */
import { NCODE_ACTIONS, canonicalNcodeAction } from '../../shared/messaging/ncode_actions.js';

function toErrorMessage(error) {
    return error && error.message ? error.message : String(error);
}

/**
 * Broadcasts a terminal compaction failure so the harness bar recovers
 * immediately instead of waiting for its request-timeout ack.
 *
 * @param {string|null} sessionId
 * @param {string} errorMessage
 */
export function broadcastCompactionFailure(sessionId, errorMessage) {
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

/**
 * Builds the Ncode action handler bound to the current background managers.
 *
 * @param {{
 *   goalManager?: object|null,
 *   compactManager?: object|null,
 *   harnessStatus?: object|null,
 *   approvalManager?: object|null,
 *   sessionHandler?: object|null,
 * }} deps
 * @returns {(request: object, sendResponse: Function) => boolean} handler that
 *   returns true when it owns the request (and will answer asynchronously)
 */
export function createNcodeUiActionHandler(deps = {}) {
    const goalManager = deps.goalManager || null;
    const compactManager = deps.compactManager || null;
    const harnessStatus = deps.harnessStatus || null;
    const approvalManager = deps.approvalManager || null;
    const sessionHandler = deps.sessionHandler || null;

    function handleGetHarnessStatus(request, sendResponse) {
        (async () => {
            try {
                if (harnessStatus && typeof harnessStatus.handleGetHarnessStatus === 'function') {
                    await harnessStatus.handleGetHarnessStatus({
                        force: request.force === true,
                    });
                } else if (harnessStatus && typeof harnessStatus.handleGetState === 'function') {
                    await harnessStatus.handleGetState();
                } else if (goalManager && typeof goalManager.serializeActiveGoals === 'function') {
                    const active = goalManager.serializeActiveGoals() || {};
                    for (const [sessionId, workflowId] of Object.entries(active)) {
                        const goalSession =
                            typeof goalManager.getGoalSession === 'function'
                                ? goalManager.getGoalSession(workflowId)
                                : null;
                        if (!goalSession) continue;
                        chrome.runtime
                            .sendMessage({
                                action: NCODE_ACTIONS.GOAL_STATE_UPDATE,
                                sessionId,
                                workflowId,
                                goalSession,
                            })
                            .catch(() => {});
                    }
                }
                sendResponse({ status: 'processed', action: NCODE_ACTIONS.GET_HARNESS_STATUS });
            } catch (error) {
                console.warn('[Ncode] NCODE_GET_HARNESS_STATUS failed:', toErrorMessage(error));
                sendResponse({
                    status: 'error',
                    action: NCODE_ACTIONS.GET_HARNESS_STATUS,
                    error: toErrorMessage(error),
                });
            }
        })();
        return true;
    }

    function handleTriggerCompactResume(request, sendResponse) {
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
                    action: NCODE_ACTIONS.TRIGGER_COMPACT_RESUME,
                    compacted: result?.compacted === true,
                    resumed: result?.resumed === true,
                    workflowId: result?.workflowId || null,
                    reason: result?.reason || null,
                    error: result?.error || null,
                });
                if (result?.compacted === true) {
                    // A manual compaction runs outside an active prompt loop, so
                    // nothing is executing afterwards. Resume the pending
                    // subgoals with the compacted checkpoint hydrated into the
                    // first turn of a fresh Gemini Web conversation.
                    try {
                        sessionHandler?.resumeAfterCompaction?.({
                            sessionId: result.sessionId || sessionId,
                            hydrationText: result.hydrationText || '',
                        });
                    } catch (resumeError) {
                        console.warn(
                            '[Ncode] Failed to resume the loop after manual compaction:',
                            toErrorMessage(resumeError)
                        );
                    }
                } else {
                    broadcastCompactionFailure(
                        sessionId,
                        result?.error || result?.reason || 'Nothing to compact.'
                    );
                }
            } catch (error) {
                console.warn('[Ncode] NCODE_TRIGGER_COMPACT_RESUME failed:', toErrorMessage(error));
                sendResponse({
                    status: 'error',
                    action: NCODE_ACTIONS.TRIGGER_COMPACT_RESUME,
                    error: toErrorMessage(error),
                });
                broadcastCompactionFailure(sessionId, toErrorMessage(error));
            }
        })();
        return true;
    }

    function handleResetGoal(request, sendResponse) {
        (async () => {
            try {
                if (!goalManager || typeof goalManager.resetGoalForSession !== 'function') {
                    sendResponse({ status: 'error', error: 'Goal manager unavailable.' });
                    return;
                }
                const reset = await goalManager.resetGoalForSession(request.sessionId || null);
                sendResponse({ status: 'processed', action: NCODE_ACTIONS.RESET_GOAL, reset });
            } catch (error) {
                console.warn('[Ncode] NCODE_RESET_GOAL failed:', toErrorMessage(error));
                sendResponse({
                    status: 'error',
                    action: NCODE_ACTIONS.RESET_GOAL,
                    error: toErrorMessage(error),
                });
            }
        })();
        return true;
    }

    function handleSubgoalToggle(request, sendResponse) {
        (async () => {
            try {
                if (!goalManager || typeof goalManager.toggleSubgoal !== 'function') {
                    sendResponse({ status: 'error', error: 'Goal manager unavailable.' });
                    return;
                }
                const result = await goalManager.toggleSubgoal({
                    sessionId: request.sessionId || null,
                    workflowId: request.workflowId || null,
                    subgoalId: request.subgoalId || null,
                    status: request.status || null,
                    evidence: request.evidence,
                });
                sendResponse({
                    status: result?.updated ? 'processed' : 'skipped',
                    action: NCODE_ACTIONS.SUBGOAL_TOGGLE,
                    updated: result?.updated === true,
                    goalSession: result?.goalSession || null,
                });
            } catch (error) {
                console.warn('[Ncode] NCODE_SUBGOAL_TOGGLE failed:', toErrorMessage(error));
                sendResponse({
                    status: 'error',
                    action: NCODE_ACTIONS.SUBGOAL_TOGGLE,
                    error: toErrorMessage(error),
                });
            }
        })();
        return true;
    }

    function handleApprovalResponse(request, sendResponse) {
        (async () => {
            try {
                if (!approvalManager || typeof approvalManager.resolveApproval !== 'function') {
                    sendResponse({ status: 'error', error: 'Approval manager unavailable.' });
                    return;
                }
                const resolved = approvalManager.resolveApproval({
                    requestId: request.requestId || null,
                    approved: request.approved === true,
                    reason: request.reason || null,
                });
                sendResponse({
                    status: resolved ? 'processed' : 'ignored',
                    action: NCODE_ACTIONS.APPROVAL_RESPONSE,
                    resolved,
                });
            } catch (error) {
                console.warn('[Ncode] NCODE_APPROVAL_RESPONSE failed:', toErrorMessage(error));
                sendResponse({
                    status: 'error',
                    action: NCODE_ACTIONS.APPROVAL_RESPONSE,
                    error: toErrorMessage(error),
                });
            }
        })();
        return true;
    }

    /**
     * @param {object} request chrome.runtime message
     * @param {Function} sendResponse
     * @returns {boolean} true when this handler owns (and will answer) the request
     */
    return function handleNcodeUiAction(request, sendResponse) {
        if (!request || typeof request !== 'object') return false;
        const action = canonicalNcodeAction(request.action);
        switch (action) {
            case NCODE_ACTIONS.GET_HARNESS_STATUS:
                return handleGetHarnessStatus(request, sendResponse);
            case NCODE_ACTIONS.TRIGGER_COMPACT_RESUME:
                return handleTriggerCompactResume(request, sendResponse);
            case NCODE_ACTIONS.RESET_GOAL:
                return handleResetGoal(request, sendResponse);
            case NCODE_ACTIONS.SUBGOAL_TOGGLE:
                return handleSubgoalToggle(request, sendResponse);
            case NCODE_ACTIONS.APPROVAL_RESPONSE:
                return handleApprovalResponse(request, sendResponse);
            default:
                return false;
        }
    };
}
