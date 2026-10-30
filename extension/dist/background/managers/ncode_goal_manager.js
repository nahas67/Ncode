/**
 * Ncode goal manager: owns the persisted Astra Goal Loop sessions and the
 * extension<->UI goal-state broadcast contract.
 *
 * PERSISTENCE (chrome.storage.local)
 *   ncodeGoalSessions  -> { [workflowId]: serializedGoalSession }
 *   ncodeActiveGoals   -> { [sessionId]: workflowId }
 *
 * BROADCAST CONTRACT (background -> UI)
 *   NCODE_GOAL_STATE_UPDATE { sessionId, workflowId, goalSession }
 *   NCODE_INTERIM_PREAMBLE  { sessionId, workflowId, text, ts }
 *   (+ legacy NCODE_GOAL_STATE / NCODE_PREAMBLE aliases for older sandboxes)
 *
 * The state machine itself lives in the pure orchestrator module
 * (extension/shared/orchestrator/goal_state_machine.js); this manager only wires
 * it to storage, broadcasts and the prompt loop. Every broadcast/persist failure
 * is logged and swallowed: telemetry must never break the agent loop.
 */
import {
    DEFAULT_MAX_ITERATIONS,
    GOAL_STATUSES,
    applyGoalUpdate,
    buildGoalContinuationPrompt,
    buildGoalSystemDirective,
    createDefaultSubgoals,
    createGoalSession,
    incrementIteration,
    isGoalComplete,
    isGoalExhausted,
    markGoalCompletion,
    markGoalStatus,
    normalizeGoalSession,
    parseGoalTags,
    serializeGoalSession,
} from '../../shared/orchestrator/goal_state_machine.js';
import { NCODE_ACTIONS, broadcastNcodeAction } from '../../shared/messaging/ncode_actions.js';

export const NCODE_GOAL_STORAGE_KEYS = Object.freeze({
    goalSessions: 'ncodeGoalSessions',
    activeGoals: 'ncodeActiveGoals',
});

export const NCODE_GOAL_STATE_ACTION = NCODE_ACTIONS.GOAL_STATE_UPDATE;
export const NCODE_PREAMBLE_ACTION = NCODE_ACTIONS.INTERIM_PREAMBLE;
const GOAL_SESSIONS_STORAGE_KEY = NCODE_GOAL_STORAGE_KEYS.goalSessions;
const ACTIVE_GOALS_STORAGE_KEY = NCODE_GOAL_STORAGE_KEYS.activeGoals;
const FALLBACK_ROOT_GOAL = 'Complete the user request.';

function toErrorMessage(error) {
    return error && error.message ? error.message : String(error);
}

function isChromeRuntimeAvailable() {
    return typeof chrome !== 'undefined' && Boolean(chrome?.runtime?.sendMessage);
}

async function sendRuntimeMessage(message) {
    if (!isChromeRuntimeAvailable()) return false;
    try {
        await chrome.runtime.sendMessage(message);
        return true;
    } catch {
        // UI closed / worker shutting down: goal telemetry is best-effort.
        return false;
    }
}

function sanitizeWorkflowSegment(value) {
    const segment = String(value ?? '')
        .replace(/[^a-zA-Z0-9_-]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 64);
    return segment || 'session';
}

function normalizeMaxIterations(maxIterations) {
    const numeric = Number(maxIterations);
    if (!Number.isFinite(numeric) || numeric < 1) return DEFAULT_MAX_ITERATIONS;
    return Math.trunc(numeric);
}

function normalizeRootGoal(rootGoal) {
    const text = typeof rootGoal === 'string' ? rootGoal.trim() : '';
    return text || FALLBACK_ROOT_GOAL;
}

function goalsFingerprint(goalSession) {
    try {
        return JSON.stringify({
            subgoals: goalSession?.subgoals || [],
            status: goalSession?.status || null,
            completionMarked: goalSession?.completionMarked === true,
            iterationCount: goalSession?.iterationCount ?? 0,
        });
    } catch {
        return '';
    }
}

export class NcodeGoalManager {
    /**
     * @param {{ storageArea?: object|null }} [options]
     */
    constructor({ storageArea = null } = {}) {
        this.storageArea =
            storageArea ||
            (typeof chrome !== 'undefined' && chrome?.storage?.local ? chrome.storage.local : null);
        /** @type {Map<string, object>} workflowId -> goal session */
        this.sessions = new Map();
        /** @type {Map<string, string>} sessionId -> workflowId */
        this.activeGoals = new Map();
    }

    /** Restores persisted goal sessions. Invalid rows are dropped, never thrown. */
    async restore() {
        this.sessions.clear();
        this.activeGoals.clear();
        if (!this.storageArea?.get) return { restored: 0 };

        let stored = {};
        try {
            stored = await this.storageArea.get([
                GOAL_SESSIONS_STORAGE_KEY,
                ACTIVE_GOALS_STORAGE_KEY,
            ]);
        } catch (error) {
            console.warn('[NcodeGoalManager] failed to read stored goals:', toErrorMessage(error));
            return { restored: 0 };
        }

        const rawSessions =
            stored?.[GOAL_SESSIONS_STORAGE_KEY] &&
            typeof stored[GOAL_SESSIONS_STORAGE_KEY] === 'object' &&
            !Array.isArray(stored[GOAL_SESSIONS_STORAGE_KEY])
                ? stored[GOAL_SESSIONS_STORAGE_KEY]
                : {};
        for (const [workflowId, rawSession] of Object.entries(rawSessions)) {
            try {
                const session = normalizeGoalSession(rawSession);
                this.sessions.set(workflowId, session);
            } catch (error) {
                console.warn(
                    `[NcodeGoalManager] dropping malformed stored goal ${workflowId}:`,
                    toErrorMessage(error)
                );
            }
        }

        const rawActive =
            stored?.[ACTIVE_GOALS_STORAGE_KEY] &&
            typeof stored[ACTIVE_GOALS_STORAGE_KEY] === 'object' &&
            !Array.isArray(stored[ACTIVE_GOALS_STORAGE_KEY])
                ? stored[ACTIVE_GOALS_STORAGE_KEY]
                : {};
        for (const [sessionId, workflowId] of Object.entries(rawActive)) {
            if (typeof sessionId !== 'string' || !sessionId) continue;
            if (typeof workflowId !== 'string' || !this.sessions.has(workflowId)) continue;
            this.activeGoals.set(sessionId, workflowId);
        }

        return { restored: this.sessions.size, active: this.activeGoals.size };
    }

    /** Persists every goal session + active mapping. Never throws. */
    async persist() {
        if (!this.storageArea?.set) return false;
        const serializedSessions = {};
        for (const [workflowId, session] of this.sessions) {
            try {
                serializedSessions[workflowId] = serializeGoalSession(session);
            } catch (error) {
                console.warn(
                    `[NcodeGoalManager] skipping unserializable goal ${workflowId}:`,
                    toErrorMessage(error)
                );
            }
        }
        try {
            await this.storageArea.set({
                [GOAL_SESSIONS_STORAGE_KEY]: serializedSessions,
                [ACTIVE_GOALS_STORAGE_KEY]: Object.fromEntries(this.activeGoals),
            });
            return true;
        } catch (error) {
            console.warn('[NcodeGoalManager] failed to persist goals:', toErrorMessage(error));
            return false;
        }
    }

    /** @returns {object|null} the active goal session for a chat session id */
    getActiveGoalForSession(sessionId) {
        if (!sessionId) return null;
        const workflowId = this.activeGoals.get(sessionId);
        if (!workflowId) return null;
        return this.sessions.get(workflowId) || null;
    }

    /** @returns {object|null} a goal session by workflow id */
    getGoalSession(workflowId) {
        if (!workflowId) return null;
        return this.sessions.get(workflowId) || null;
    }

    /** sessionId -> workflowId plain object (used by NCODE_GET_STATE hydration). */
    serializeActiveGoals() {
        return Object.fromEntries(this.activeGoals);
    }

    /**
     * Starts a goal for a SEND_PROMPT request, reusing an existing active and
     * non-completed/non-exhausted goal for the same session id.
     *
     * @param {{ sessionId?: string|null, rootGoal?: string, maxIterations?: number, subgoals?: object[] }} args
     * @returns {Promise<object>} the goal session
     */
    async startGoalForRequest({ sessionId = null, rootGoal, maxIterations, subgoals } = {}) {
        const existing = this.getActiveGoalForSession(sessionId);
        if (existing && !this.isTerminalGoal(existing)) {
            return existing;
        }

        const workflowId = `wf-${sanitizeWorkflowSegment(sessionId)}-${Date.now().toString(36)}`;
        const goalSession = createGoalSession({
            workflowId,
            rootGoal: normalizeRootGoal(rootGoal),
            subgoals:
                Array.isArray(subgoals) && subgoals.length > 0 ? subgoals : createDefaultSubgoals(),
            maxIterations: normalizeMaxIterations(maxIterations),
        });

        this.sessions.set(workflowId, goalSession);
        if (sessionId) this.activeGoals.set(sessionId, workflowId);
        await this.persist();
        await this.broadcastGoalState(sessionId, goalSession);
        return goalSession;
    }

    /** Attaches/updates the active goal session for a chat session. */
    async setActiveGoal(sessionId, goalSession) {
        let session;
        try {
            session = normalizeGoalSession(goalSession);
        } catch (error) {
            console.warn(
                '[NcodeGoalManager] refusing invalid goal session:',
                toErrorMessage(error)
            );
            return null;
        }
        this.sessions.set(session.workflowId, session);
        if (sessionId) this.activeGoals.set(sessionId, session.workflowId);
        await this.persist();
        await this.broadcastGoalState(sessionId, session);
        return session;
    }

    /**
     * Parses the Ncode status/update/completion tags out of one model reply,
     * applies the resulting transitions and broadcasts the new goal state.
     *
     * @param {object} goalSession
     * @param {unknown} modelText
     * @returns {Promise<{ goalSession: object, signals: object }>}
     */
    async applyModelText(goalSession, modelText) {
        const signals = {
            hasGoalTags: false,
            preamble: null,
            goalUpdate: null,
            goalUpdateError: null,
            goalComplete: false,
            cleanedText: '',
            updateApplied: false,
            completed: false,
        };

        let current = goalSession;
        let parsed;
        try {
            parsed = parseGoalTags(modelText);
        } catch (error) {
            console.warn('[NcodeGoalManager] failed to parse goal tags:', toErrorMessage(error));
            return { goalSession: current, signals };
        }

        signals.hasGoalTags = parsed.hasGoalTags === true;
        signals.preamble = parsed.preamble || null;
        // A single model turn commonly closes several milestones. Keep the last
        // update for legacy consumers and apply every update in order.
        const goalUpdates = Array.isArray(parsed.goalUpdates)
            ? parsed.goalUpdates
            : parsed.goalUpdate
              ? [parsed.goalUpdate]
              : [];
        signals.goalUpdate = parsed.goalUpdate || null;
        signals.goalUpdates = goalUpdates;
        signals.goalUpdateError = parsed.goalUpdateError || null;
        signals.goalUpdateErrors = Array.isArray(parsed.goalUpdateErrors)
            ? parsed.goalUpdateErrors
            : [];
        signals.htmlEntitiesDecoded = parsed.htmlEntitiesDecoded === true;
        signals.goalComplete = parsed.goalComplete === true;
        signals.cleanedText = parsed.cleanedText || '';

        let changed = false;
        for (const goalUpdate of goalUpdates) {
            try {
                const before = goalsFingerprint(current);
                const applied = applyGoalUpdate(current, goalUpdate);
                if (goalsFingerprint(applied) !== before) {
                    current = applied;
                    changed = true;
                    signals.updateApplied = true;
                }
            } catch (error) {
                console.warn(
                    '[NcodeGoalManager] failed to apply goal update:',
                    toErrorMessage(error)
                );
            }
        }

        try {
            if (current && isGoalComplete(current, modelText)) {
                const completed = markGoalCompletion(current, { complete: true });
                if (goalsFingerprint(completed) !== goalsFingerprint(current)) changed = true;
                current = completed;
                signals.completed = true;
            }
        } catch (error) {
            console.warn(
                '[NcodeGoalManager] failed to evaluate goal completion:',
                toErrorMessage(error)
            );
        }

        if (current) {
            this.sessions.set(current.workflowId, current);
            if (changed || signals.hasGoalTags) {
                await this.persist();
            }
            await this.broadcastGoalState(
                this.findSessionIdForWorkflow(current.workflowId),
                current
            );
        }

        return { goalSession: current, signals };
    }

    /**
     * Broadcasts one Ncode real-time preamble status line for the goal.
     * @returns {Promise<boolean>} whether the preamble was broadcast
     */
    async recordPreamble(goalSession, text) {
        const preamble = typeof text === 'string' ? text.trim() : '';
        if (!preamble || !goalSession) return false;
        await broadcastNcodeAction(NCODE_PREAMBLE_ACTION, {
            sessionId: this.findSessionIdForWorkflow(goalSession.workflowId),
            workflowId: goalSession.workflowId || null,
            text: preamble,
            ts: Date.now(),
        });
        return true;
    }

    /**
     * Terminates a goal with a GOAL_STATUSES value (defaults to completed).
     * @param {object} goalSession
     * @param {{ status?: string, reason?: string }} [options]
     */
    async finishGoal(goalSession, { status = 'completed', reason = '' } = {}) {
        let finished;
        const targetStatus = GOAL_STATUSES.includes(status) ? status : 'failed';
        try {
            finished = markGoalStatus(goalSession, targetStatus, reason);
        } catch (error) {
            console.warn('[NcodeGoalManager] failed to mark goal status:', toErrorMessage(error));
            return goalSession;
        }
        this.sessions.set(finished.workflowId, finished);
        // Keep the session + active mapping after completion: /records and the
        // resume hydration path still need to find the finished goal.
        await this.persist();
        await this.broadcastGoalState(this.findSessionIdForWorkflow(finished.workflowId), finished);
        return finished;
    }

    /**
     * Advances the goal-loop iteration counter after a tool-free turn that did
     * not complete the goal.
     *
     * @param {object} goalSession
     * @returns {Promise<{ goalSession: object, exhausted: boolean }>}
     */
    async advanceIteration(goalSession) {
        let next;
        try {
            next = incrementIteration(goalSession);
        } catch (error) {
            console.warn('[NcodeGoalManager] failed to advance iteration:', toErrorMessage(error));
            return { goalSession, exhausted: false };
        }
        let exhausted = false;
        try {
            exhausted = isGoalExhausted(next) === true;
        } catch {
            exhausted = false;
        }
        this.sessions.set(next.workflowId, next);
        await this.persist();
        await this.broadcastGoalState(this.findSessionIdForWorkflow(next.workflowId), next);
        return { goalSession: next, exhausted };
    }

    /** Removes the active goal for a chat session (UI NCODE_RESET_GOAL). */
    async resetGoalForSession(sessionId) {
        const workflowId = this.activeGoals.get(sessionId) || null;
        this.activeGoals.delete(sessionId);
        if (workflowId) this.sessions.delete(workflowId);
        await this.persist();
        await broadcastNcodeAction(NCODE_GOAL_STATE_ACTION, {
            sessionId: sessionId || null,
            workflowId,
            goalSession: null,
        });
        return Boolean(workflowId);
    }

    /**
     * Applies a manual subgoal status change coming from the harness checklist
     * (UI NCODE_SUBGOAL_TOGGLE). The status is validated by the pure state
     * machine, persisted and broadcast back to every open panel.
     *
     * @param {{ sessionId?: string|null, workflowId?: string|null, subgoalId?: string, status?: string, evidence?: string }} toggle
     * @returns {Promise<{ updated: boolean, goalSession: object|null }>}
     */
    async toggleSubgoal(toggle = {}) {
        const sessionId = toggle.sessionId || null;
        const workflowId =
            typeof toggle.workflowId === 'string' && toggle.workflowId
                ? toggle.workflowId
                : this.activeGoals.get(sessionId) || null;
        const goalSession = workflowId ? this.sessions.get(workflowId) : null;
        if (!goalSession) return { updated: false, goalSession: null };
        const beforeSubgoal = (goalSession.subgoals || []).find(
            (subgoal) => subgoal.id === toggle.subgoalId
        );

        let next;
        try {
            next = applyGoalUpdate(goalSession, {
                subgoalId: toggle.subgoalId,
                status: toggle.status,
                evidence: toggle.evidence,
            });
        } catch (error) {
            console.warn('[NcodeGoalManager] failed to toggle subgoal:', toErrorMessage(error));
            return { updated: false, goalSession };
        }
        const afterSubgoal = (next.subgoals || []).find(
            (subgoal) => subgoal.id === toggle.subgoalId
        );
        const changed =
            Boolean(beforeSubgoal) &&
            Boolean(afterSubgoal) &&
            (beforeSubgoal.status !== afterSubgoal.status ||
                beforeSubgoal.evidence !== afterSubgoal.evidence);
        if (!changed) return { updated: false, goalSession };

        this.sessions.set(next.workflowId, next);
        await this.persist();
        await this.broadcastGoalState(sessionId, next);
        return { updated: true, goalSession: next };
    }

    /** System directive appended by PromptBuilder for goal-mode requests. */
    buildDirective(goalSession) {
        try {
            return buildGoalSystemDirective(goalSession) || '';
        } catch (error) {
            console.warn(
                '[NcodeGoalManager] failed to build goal directive:',
                toErrorMessage(error)
            );
            return '';
        }
    }

    /** Continuation prompt for the autonomous Astra loop. */
    buildContinuationPrompt(goalSession) {
        try {
            return buildGoalContinuationPrompt(goalSession) || '';
        } catch (error) {
            console.warn(
                '[NcodeGoalManager] failed to build goal continuation:',
                toErrorMessage(error)
            );
            return '';
        }
    }

    /** Broadcasts one goal session to every extension page (UI). */
    async broadcastGoalState(sessionId, goalSession) {
        await broadcastNcodeAction(NCODE_GOAL_STATE_ACTION, {
            sessionId: sessionId || null,
            workflowId: goalSession?.workflowId || null,
            goalSession: goalSession || null,
        });
    }

    /** True when the goal can no longer be extended (completed/failed/exhausted). */
    isTerminalGoal(goalSession) {
        if (!goalSession) return true;
        if (goalSession.status === 'completed' || goalSession.status === 'failed') return true;
        try {
            if (isGoalExhausted(goalSession)) return true;
            if (isGoalComplete(goalSession, '')) return true;
        } catch {
            return true;
        }
        return false;
    }

    findSessionIdForWorkflow(workflowId) {
        if (!workflowId) return null;
        for (const [sessionId, mappedWorkflowId] of this.activeGoals) {
            if (mappedWorkflowId === workflowId) return sessionId;
        }
        return null;
    }
}
