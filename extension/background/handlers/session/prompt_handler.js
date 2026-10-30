import {
    appendAiMessage,
    appendAiMessageIfDisplayable,
    invalidateSessionContextSummary,
    replaceSessionSnapshot,
} from '../../managers/history_manager.js';
import { keepAliveManager } from '../../managers/keep_alive.js';
import { PromptBuilder } from './prompt/builder.js';
import { ToolExecutor } from './prompt/tool_executor.js';
import {
    NCODE_MAX_GOAL_ITERATIONS,
    buildGoalAwareContinuationPrompt,
    buildNarrationNudgePrompt,
    createNarrationIntermediateAiResult,
    detectPromptLanguage,
    executePendingToolResult,
    extractGoalSignals,
    getToolResultsFiles,
    injectBrowserControlSnapshot,
    looksLikeUnexecutedBrowserActionPlan,
    persistToolOutputMessages,
    updateBrowserControlFunctionResponses,
} from './prompt/tool_loop.js';
import { toControlTabSummary } from '../../control/tabs.js';
import { classifyProviderError } from '../../managers/session/error_classifier.js';
import { ensureNcodeDefaultMcpServer } from '../../managers/session/settings_store.js';
import { forceMergeNcodeDefaultServer } from '../../../shared/settings/connection.js';

// One free retry when the model narrates a browser step without tool JSON.
const MAX_NARRATION_NUDGES = 1;

function cancellableDelay(ms, run, handler) {
    return new Promise((resolve) => {
        const timer = setTimeout(() => {
            clearInterval(checkTimer);
            resolve();
        }, ms);
        const checkTimer = setInterval(() => {
            if (handler.isRunCancelled(run)) {
                clearTimeout(timer);
                clearInterval(checkTimer);
                resolve();
            }
        }, 100);
    });
}
const REQUEST_CANCELLED_TEXT = 'Request cancelled.';

async function getStoredProvider() {
    try {
        const stored = await chrome.storage.local.get(['geminiProvider', 'geminiUseOfficialApi']);
        return stored.geminiProvider || (stored.geminiUseOfficialApi === true ? 'official' : 'web');
    } catch (error) {
        console.warn('Failed to read provider from chrome.storage:', error);
        return 'web';
    }
}

async function sendRuntimeMessage(message) {
    try {
        await chrome.runtime.sendMessage(message);
    } catch (error) {
        console.warn('[PromptHandler] sendRuntimeMessage failed:', error?.message || error);
    }
}

function getBrowserControlTaskTitle(text) {
    const normalized = String(text || '')
        .replace(/\s+/g, ' ')
        .trim();
    if (!normalized) return 'Browser control';
    return normalized.length > 28 ? `${normalized.slice(0, 27)}...` : normalized;
}

export class PromptHandler {
    /**
     * @param {GeminiSessionManager} sessionManager
     * @param {object|null} controlManager
     * @param {object|null} mcpManager
     * @param {{
     *   goalManager?: object|null,
     *   compactManager?: object|null,
     *   harnessStatus?: object|null,
     *   bridgeClient?: object|null,
     *   approvalManager?: object|null,
     * }} [deps]
     */
    constructor(
        sessionManager,
        controlManager,
        mcpManager,
        {
            goalManager = null,
            compactManager = null,
            harnessStatus = null,
            bridgeClient = null,
            approvalManager = null,
        } = {}
    ) {
        this.sessionManager = sessionManager;
        this.controlManager = controlManager;
        this.goalManager = goalManager;
        this.compactManager = compactManager;
        this.harnessStatus = harnessStatus;
        this.bridgeClient = bridgeClient;
        this.approvalManager = approvalManager;
        this.builder = new PromptBuilder(controlManager, mcpManager, {
            goalManager,
            compactManager,
        });
        this.toolExecutor = new ToolExecutor(controlManager, mcpManager, {
            approvalManager,
        });
        this.activeRun = null;
    }

    cancel() {
        this.cancelActiveRun();
    }

    createCancellationReply(request) {
        return {
            action: 'GEMINI_REPLY',
            sessionId: request?.sessionId || null,
            text: REQUEST_CANCELLED_TEXT,
            status: 'cancelled',
        };
    }

    cancelActiveRun({ notify = false } = {}) {
        const run = this.activeRun;
        if (!run || run.cancelled) return false;

        run.cancelled = true;
        // Only abort the prompt bucket, not quick-ask tabs
        if (this.sessionManager?.cancelCurrentRequest) {
            try {
                this.sessionManager.cancelCurrentRequest('prompt');
            } catch {}
        }
        if (notify) {
            sendRuntimeMessage(this.createCancellationReply(run.request));
        }
        return true;
    }

    isRunCancelled(run) {
        return !run || run.cancelled || this.activeRun !== run;
    }

    /**
     * Ncode goal loops run for sidepanel SEND_PROMPT requests only. The flag is
     * an explicit opt-out: `ncodeGoalMode` absent means enabled (fresh install),
     * `false` disables it. Quick-ask/toolbar flows never reach this handler.
     */
    isGoalModeRequest(request) {
        return Boolean(
            this.goalManager &&
            request &&
            request.action === 'SEND_PROMPT' &&
            request.ncodeGoalMode !== false
        );
    }

    /** Starts (or reuses) the persisted goal for this chat session. Never throws. */
    async startGoalForRun(request) {
        try {
            return await this.goalManager.startGoalForRequest({
                sessionId: request?.sessionId || null,
                rootGoal: request?.text,
                maxIterations: request?.ncodeMaxIterations,
            });
        } catch (error) {
            console.warn('[Ncode] Failed to start goal loop:', error?.message || error);
            return null;
        }
    }

    /**
     * Parses Ncode goal tags out of one model reply, broadcasts the live
     * preamble and applies subgoal/completion transitions.
     * @returns {Promise<{ goalSession: object|null, signals: object }>}
     */
    async applyGoalModelText(goalSession, result) {
        const text = typeof result?.text === 'string' ? result.text : '';
        const signals = extractGoalSignals(text);
        if (!this.goalManager || !goalSession || !signals.hasGoalTags) {
            return { goalSession, signals };
        }
        try {
            if (signals.preamble) {
                await this.goalManager.recordPreamble(goalSession, signals.preamble);
            }
            const applied = await this.goalManager.applyModelText(goalSession, text);
            return {
                goalSession: applied?.goalSession || goalSession,
                signals: { ...signals, ...(applied?.signals || {}) },
            };
        } catch (error) {
            console.warn('[Ncode] Failed to apply goal tags:', error?.message || error);
            return { goalSession, signals };
        }
    }

    /**
     * Runs one tool execution while poking the keep-alive stream heartbeat so a
     * long browser/PC/shell tool call (>30s of silence) does not let MV3
     * terminate the service worker mid-loop.
     */
    async executeToolResultWithKeepAlive({ result, request, loopCount, toolExecutor, onUpdate }) {
        try {
            keepAliveManager.beginStreamHeartbeat();
        } catch (error) {
            console.warn('[PromptHandler] keep-alive begin failed:', error?.message || error);
        }
        try {
            return await executePendingToolResult({
                result,
                request,
                loopCount,
                toolExecutor,
                onUpdate,
            });
        } finally {
            try {
                keepAliveManager.endStreamHeartbeat();
            } catch (error) {
                console.warn('[PromptHandler] keep-alive end failed:', error?.message || error);
            }
        }
    }

    /**
     * Post-tool compaction check (prune + summarize + checkpoint + resume).
     * A compaction failure must never break the loop; the manager logs and
     * returns a skipped result.
     */
    async maybeCompact({ request, goalSession, loopCount, run }) {
        if (
            !this.compactManager ||
            typeof this.compactManager.maybeCompactAndResume !== 'function'
        ) {
            return null;
        }
        try {
            return await this.compactManager.maybeCompactAndResume({
                request,
                goalSession: goalSession || null,
                loopCount,
                run,
                isCancelled: () => this.isRunCancelled(run),
            });
        } catch (error) {
            console.warn('[Ncode] Post-tool compaction failed:', error?.message || error);
            return null;
        }
    }

    async finishGoalSafe(goalSession, options) {
        try {
            return (await this.goalManager.finishGoal(goalSession, options)) || goalSession;
        } catch (error) {
            console.warn('[Ncode] Failed to finish goal:', error?.message || error);
            return goalSession;
        }
    }

    async advanceGoalSafe(goalSession) {
        try {
            const advanced = await this.goalManager.advanceIteration(goalSession);
            return advanced || { goalSession, exhausted: false };
        } catch (error) {
            console.warn('[Ncode] Failed to advance goal iteration:', error?.message || error);
            return { goalSession, exhausted: false };
        }
    }

    buildGoalContinuation(goalSession) {
        try {
            const prompt =
                typeof this.goalManager?.buildContinuationPrompt === 'function'
                    ? this.goalManager.buildContinuationPrompt(goalSession)
                    : '';
            if (prompt) return prompt;
        } catch (error) {
            console.warn('[Ncode] Failed to build continuation prompt:', error?.message || error);
        }
        return 'Continue the autonomous Ncode goal loop with the next tool call.';
    }

    handle(request, sendResponse) {
        this.cancelActiveRun({ notify: true });

        const run = {
            request,
            cancelled: false,
            id: `sidepanel_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        };
        this.activeRun = run;
        console.info('[Gemini Nexus] SEND_PROMPT received', {
            runId: run.id,
            sessionId: request?.sessionId || null,
            model: request?.model || null,
            enableBrowserControl: request?.enableBrowserControl === true,
            ncodeGoalMode: request?.ncodeGoalMode !== false,
            textLen: typeof request?.text === 'string' ? request.text.length : 0,
        });

        (async () => {
            const onUpdate = (partialText, partialThoughts) => {
                // Catch errors if receiver (UI) is closed/unavailable.
                // Tag with source='sidepanel' + a per-run requestId so the
                // broadcast cannot be mistaken for a toolbar quick-ask stream
                // by content/toolbar/stream.js (whose guard
                // `if (request.source && request.source !== 'toolbar') return false`
                // only rejects messages whose source is explicitly non-toolbar;
                // an undefined source previously fell through and leaked
                // sidepanel tokens into every open toolbar ask window).
                chrome.runtime
                    .sendMessage({
                        action: 'GEMINI_STREAM_UPDATE',
                        source: 'sidepanel',
                        requestId: run.id,
                        sessionId: request.sessionId || null,
                        text: partialText,
                        thoughts: partialThoughts,
                    })
                    .catch(() => {});
            };

            try {
                // The Ncode local PC & shell MCP daemon is not optional: repair
                // chrome.storage.local and force-merge/enable the canonical
                // server into THIS request before every prompt execution, even
                // when a stale sidepanel snapshot or an old saved settings blob
                // omitted or disabled it. Runs before the goal loop so tool
                // discovery sees the daemon on the very first turn.
                try {
                    await ensureNcodeDefaultMcpServer();
                    const mergedServers = forceMergeNcodeDefaultServer(
                        Array.isArray(request.mcpServers) ? request.mcpServers : []
                    );
                    request = {
                        ...request,
                        mcpServers: mergedServers,
                        mcpServerId: request.mcpServerId || mergedServers[0]?.id || null,
                        enableMcpTools:
                            request.enableMcpTools === true ||
                            mergedServers.some((server) => server.enabled !== false),
                    };
                    run.request = request;
                } catch (error) {
                    // Settings repair is best-effort: never block a prompt on it.
                    console.warn(
                        '[Ncode] Failed to force-merge the local MCP server:',
                        error?.message || error
                    );
                }

                if (request.sessionSnapshot) {
                    const provider = await getStoredProvider();
                    if (provider === 'web') {
                        throw new Error('History editing is not supported for Gemini Web Client.');
                    }
                    const snapshotSaved = await replaceSessionSnapshot(request.sessionSnapshot);
                    if (!snapshotSaved) {
                        throw new Error('Could not save edited session before sending prompt.');
                    }
                    // A history edit invalidates any previously-compressed
                    // summary (it referenced message text/indices that were
                    // just truncated). The snapshot already nulls the
                    // in-memory field, but invalidate explicitly too so a
                    // snapshot-write race cannot leave a stale persisted
                    // summary that prepareManagedContext would later load.
                    if (request.sessionSnapshot?.id) {
                        await invalidateSessionContextSummary(request.sessionSnapshot.id);
                    }
                }

                // NCODE GOAL LOOP: start/resume the persisted goal for this
                // session BEFORE building the prompt so the builder can inject
                // the goal directive and the loop can enforce completion.
                let activeGoalSession = null;
                if (this.isGoalModeRequest(request)) {
                    activeGoalSession = await this.startGoalForRun(request);
                    if (activeGoalSession) {
                        request = { ...request, ncodeGoalSession: activeGoalSession };
                        run.request = request;
                        console.info('[Ncode] Goal loop active', {
                            workflowId: activeGoalSession.workflowId,
                            iterationCount: activeGoalSession.iterationCount,
                            maxIterations: activeGoalSession.maxIterations,
                        });
                    }
                }
                const requestProvider = await getStoredProvider();

                // AUTO-LOCK: If browser control enabled and no tab locked, lock to active tab
                if (request.enableBrowserControl && this.controlManager) {
                    const targetSidePanelTabId = request.sidePanelTabId || null;
                    this.controlManager.setOwnerSidePanelTabId(targetSidePanelTabId);
                    this.controlManager.setControlTaskTitle(
                        getBrowserControlTaskTitle(request.text)
                    );
                    const currentLock = this.controlManager.getTargetTabId();
                    if (!currentLock) {
                        await this.controlManager.enableControl({
                            createDefaultTab: request.hostIsTab === true && !targetSidePanelTabId,
                        });
                        const lockedTabId = this.controlManager.getTargetTabId();
                        if (lockedTabId) {
                            try {
                                const tab = await chrome.tabs.get(lockedTabId);
                                // Notify UI to update the Tab Switcher icon so user knows which tab is locked
                                chrome.runtime
                                    .sendMessage({
                                        action: 'TAB_LOCKED',
                                        tabId: targetSidePanelTabId,
                                        tab: toControlTabSummary(tab),
                                    })
                                    .catch(() => {});
                            } catch {
                                // 静默降级:locked tab 已关闭时跳过通知
                            }
                        }
                    }
                }

                // Build the user prompt and separate system instruction.
                const buildResult = await this.builder.build(request);
                const systemInstruction = buildResult.systemInstruction;
                let currentPromptText = buildResult.userPrompt;
                let currentHistoryText = request.text;
                const continuationLanguage = detectPromptLanguage(request.text);

                let currentFiles = request.files;
                // Avoid mutating the original request object across loop iterations
                let mutableOfficialParts = request.officialUserParts || null;
                let mutableBatchId = request.officialFunctionResponseBatchId || null;
                // Compact & Resume hydration is injected into the next turn only.
                let resumeHydration =
                    typeof request.ncodeResumeHydration === 'string'
                        ? request.ncodeResumeHydration.trim()
                        : '';

                let loopCount = 0;
                let narrationNudges = 0;
                // Ncode goal loops and browser-control loops share one hard cap.
                // It is also the orchestrator's DEFAULT_MAX_ITERATIONS, so a goal
                // that never verifies completion stops instead of running forever
                // and consuming the user's Gemini web quota.
                const MAX_LOOPS = NCODE_MAX_GOAL_ITERATIONS;

                let keepLooping = true;
                let compactionCount = 0;

                while (keepLooping && loopCount < MAX_LOOPS) {
                    if (this.isRunCancelled(run)) break;

                    const systemInstructionForTurn = resumeHydration
                        ? `${systemInstruction}\n\n${resumeHydration}`
                        : systemInstruction;

                    const result = await this.sessionManager.handleSendPrompt(
                        {
                            ...request,
                            officialUserParts: mutableOfficialParts,
                            officialFunctionResponseBatchId: mutableBatchId,
                            text: currentPromptText,
                            historyPromptText: currentHistoryText,
                            systemInstruction: systemInstructionForTurn,
                            files: currentFiles,
                        },
                        onUpdate,
                        'prompt'
                    );

                    if (this.isRunCancelled(run)) break;

                    if (!result || result.status !== 'success') {
                        // If error, notify UI and break loop
                        if (result) {
                            chrome.runtime.sendMessage(result).catch(() => {});
                            // Persist error rows so reload/history export matches what
                            // the user saw (UI already saved the optimistic user message).
                            await this.persistTerminalError(request, result);
                        }
                        break;
                    }

                    if (requestProvider === 'web') {
                        try {
                            this.harnessStatus?.noteWebRequestSuccess?.();
                        } catch {}
                    }

                    // (b) Parse Ncode goal tags BEFORE executing any pending tool
                    // result: broadcast the live preamble and apply subgoal /
                    // completion transitions from this model turn.
                    let goalSignals = null;
                    if (activeGoalSession) {
                        const goalResult = await this.applyGoalModelText(activeGoalSession, result);
                        activeGoalSession = goalResult.goalSession || activeGoalSession;
                        goalSignals = goalResult.signals;
                        // Hydration is only needed for the first turn after resume.
                        resumeHydration = '';
                    }

                    const { toolResult, pendingNativeCalls } =
                        await this.executeToolResultWithKeepAlive({
                            result,
                            request,
                            loopCount,
                            toolExecutor: this.toolExecutor,
                            onUpdate,
                        });

                    if (this.isRunCancelled(run)) break;

                    if (toolResult) {
                        // Feed tool output back to the model and continue the loop.
                        loopCount++;
                        const allToolFiles = getToolResultsFiles(
                            toolResult.results || [toolResult]
                        );
                        currentFiles = allToolFiles; // Send new files if any, or clear previous files

                        const outputForModel = await injectBrowserControlSnapshot({
                            toolResult,
                            outputForModel: toolResult.outputForModel,
                            request: {
                                ...request,
                                officialUserParts: mutableOfficialParts,
                                officialFunctionResponseBatchId: mutableBatchId,
                            },
                            controlManager: this.controlManager,
                        });

                        const isOfficialFunctionResponse =
                            Array.isArray(toolResult.officialResponseParts) &&
                            toolResult.officialResponseParts.length > 0;

                        const nextToolResult = isOfficialFunctionResponse
                            ? updateBrowserControlFunctionResponses(toolResult, outputForModel)
                            : toolResult;

                        // Format observation for the model. Official native function
                        // calls use functionResponse parts instead of synthetic text.
                        currentPromptText = isOfficialFunctionResponse
                            ? ''
                            : buildGoalAwareContinuationPrompt({
                                  toolName: toolResult.toolName,
                                  output: outputForModel,
                                  language: continuationLanguage,
                                  goalSession: activeGoalSession,
                              });

                        // Save "User" message (Tool Output) to history to keep context in sync
                        // NOTE: We do NOT save the massive auto-snapshot text to the user history to keep the UI clean.
                        if (this.isRunCancelled(run)) break;
                        const persistedHistoryText = await persistToolOutputMessages({
                            request,
                            result,
                            toolResult: nextToolResult,
                            loopCount,
                            pendingNativeCalls,
                            sendRuntimeMessage,
                        });
                        if (persistedHistoryText !== null) {
                            currentHistoryText = persistedHistoryText;
                        }

                        if (isOfficialFunctionResponse) {
                            currentFiles = [];
                            mutableOfficialParts = nextToolResult.officialResponseParts;
                            mutableBatchId = nextToolResult.officialResponseBatchId;
                        } else {
                            mutableOfficialParts = null;
                            mutableBatchId = null;
                        }

                        // Wait 2-4 seconds before sending the next request.
                        // This prevents "No valid response" errors caused by rapid-fire requests.
                        await cancellableDelay(2000 + Math.random() * 2000, run, this);

                        if (this.isRunCancelled(run)) break;

                        // (c) Post-tool context compaction: prune + compaction turn
                        // + checkpoint + fresh Gemini Web conversation. Failures are
                        // logged by the manager and the loop continues unchanged.
                        const compaction = await this.maybeCompact({
                            request,
                            goalSession: activeGoalSession,
                            loopCount,
                            run,
                        });
                        if (compaction?.compacted) {
                            compactionCount++;
                            if (compaction.hydrationText) {
                                resumeHydration = compaction.hydrationText;
                            }
                        }
                    } else if (
                        request.enableBrowserControl === true &&
                        narrationNudges < MAX_NARRATION_NUDGES &&
                        looksLikeUnexecutedBrowserActionPlan(result?.text)
                    ) {
                        // Model described the next browser action but emitted no
                        // tool-call JSON. Nudge once instead of ending the loop.
                        narrationNudges++;
                        loopCount++;

                        const intermediate = createNarrationIntermediateAiResult(result);
                        if (request.sessionId) {
                            await appendAiMessageIfDisplayable(request.sessionId, intermediate);
                        }
                        chrome.runtime
                            .sendMessage({
                                action: 'AGENT_INTERMEDIATE_MESSAGE',
                                sessionId: request.sessionId || null,
                                text: intermediate.text || '',
                                thoughts: intermediate.thoughts || null,
                                suppressCopy: true,
                            })
                            .catch(() => {});

                        currentPromptText = buildNarrationNudgePrompt(continuationLanguage);
                        currentHistoryText = intermediate.text || result?.text || '';
                        currentFiles = [];
                        mutableOfficialParts = null;
                        mutableBatchId = null;

                        await cancellableDelay(1500 + Math.random() * 1500, run, this);
                        if (this.isRunCancelled(run)) break;
                    } else {
                        // No tool execution, final tool-free answer reached.
                        // Only final replies are persisted and sent as GEMINI_REPLY.
                        // Intermediate tool-call JSON is consumed by the loop and should not
                        // terminate the UI streaming state.
                        const cleanedText =
                            goalSignals?.hasGoalTags && typeof goalSignals.cleanedText === 'string'
                                ? goalSignals.cleanedText
                                : '';
                        const finalResult =
                            cleanedText && cleanedText.trim().length > 0
                                ? { ...result, text: cleanedText }
                                : result;

                        if (activeGoalSession) {
                            // (e) Autonomous Astra continuation: completed goals end
                            // the run; unfinished goals advance the iteration budget
                            // and continue with a continuation prompt.
                            const completedNow =
                                goalSignals?.completed === true ||
                                activeGoalSession.status === 'completed';
                            if (completedNow) {
                                activeGoalSession = await this.finishGoalSafe(activeGoalSession, {
                                    status: 'completed',
                                    reason: 'verified ncode_goal_complete',
                                });
                                if (request.sessionId) {
                                    await appendAiMessage(request.sessionId, finalResult);
                                }
                                chrome.runtime.sendMessage(finalResult).catch(() => {});
                                keepLooping = false;
                            } else {
                                const advanced = await this.advanceGoalSafe(activeGoalSession);
                                activeGoalSession = advanced.goalSession || activeGoalSession;
                                if (advanced.exhausted === true) {
                                    throw new Error(
                                        'Ncode goal loop exhausted after ' +
                                            (activeGoalSession?.iterationCount ?? MAX_LOOPS) +
                                            ' iterations without verified completion (' +
                                            (activeGoalSession?.failureReason ||
                                                'max_iterations_reached') +
                                            ').'
                                    );
                                }
                                loopCount++;
                                if (request.sessionId) {
                                    await appendAiMessage(request.sessionId, {
                                        ...finalResult,
                                        suppressCopy: true,
                                    });
                                }
                                chrome.runtime
                                    .sendMessage({
                                        action: 'AGENT_INTERMEDIATE_MESSAGE',
                                        sessionId: request.sessionId || null,
                                        text: finalResult.text || '',
                                        thoughts: finalResult.thoughts || null,
                                        suppressCopy: true,
                                        ncodeGoalContinuation: true,
                                    })
                                    .catch(() => {});

                                currentPromptText = this.buildGoalContinuation(activeGoalSession);
                                currentHistoryText = finalResult.text || '';
                                currentFiles = [];
                                mutableOfficialParts = null;
                                mutableBatchId = null;

                                await cancellableDelay(1500 + Math.random() * 1500, run, this);
                                if (this.isRunCancelled(run)) break;
                            }
                        } else {
                            if (request.sessionId) {
                                await appendAiMessage(request.sessionId, finalResult);
                            }

                            chrome.runtime.sendMessage(finalResult).catch(() => {});
                            keepLooping = false;
                        }
                    }
                }

                // If the loop exhausted the step cap without the model emitting a
                // final (tool-free) answer, surface a clear error instead of
                // silently finalizing with whatever the last intermediate state was.
                console.info('[Ncode] Prompt loop finished', {
                    loopCount,
                    compactionCount,
                    goalWorkflowId: activeGoalSession?.workflowId || null,
                    goalStatus: activeGoalSession?.status || null,
                });
                if (keepLooping && loopCount >= MAX_LOOPS) {
                    throw new Error(
                        (activeGoalSession
                            ? 'Ncode goal loop reached the maximum number of steps ('
                            : 'Browser-control tool loop reached the maximum number of steps (') +
                            MAX_LOOPS +
                            ') without a final answer.'
                    );
                }
            } catch (error) {
                console.error('Prompt loop error:', error);
                if (!this.isRunCancelled(run)) {
                    const { kind: errorKind, retryable } = classifyProviderError(error);
                    const errorResult = {
                        action: 'GEMINI_REPLY',
                        sessionId: request.sessionId || null,
                        text: 'Error: ' + error.message,
                        status: 'error',
                        errorKind,
                        retryable,
                    };
                    chrome.runtime.sendMessage(errorResult).catch(() => {});
                    await this.persistTerminalError(request, errorResult);
                }
            } finally {
                if (this.activeRun === run) {
                    this.activeRun = null;
                }
                sendResponse({ status: 'completed' });
            }
        })();
        return true;
    }

    /**
     * Persist a terminal error as an AI history row so reloads / bridge
     * /records match the bubble the user saw (user row is optimistic-saved
     * before SEND_PROMPT).
     */
    async persistTerminalError(request, result) {
        if (!request?.sessionId || !result || result.status !== 'error') return;
        const text = typeof result.text === 'string' ? result.text.trim() : '';
        if (!text) return;
        try {
            await appendAiMessage(request.sessionId, {
                text,
                thoughts: null,
                sources: null,
                images: null,
                suppressCopy: true,
                context: result.context || null,
            });
        } catch (error) {
            console.warn('[PromptHandler] Failed to persist error history:', error);
        }
    }
}
