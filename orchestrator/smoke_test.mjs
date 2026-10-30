#!/usr/bin/env node
/**
 * Ncode orchestrator smoke test.
 *
 * Exercises the Astra goal state machine and the Compact & Resume engine end to end
 * with plain Node (no dependencies):
 *
 *   node Ncode/orchestrator/smoke_test.mjs
 *
 * Prints one PASS line per check and exits non-zero on failure.
 */

import assert from 'node:assert/strict';

import {
    DEFAULT_MAX_ITERATIONS,
    GOAL_ROLES,
    GOAL_STATUSES,
    SUBGOAL_STATUSES,
    applyGoalUpdate,
    buildGoalContinuationPrompt,
    buildGoalResumeDirective,
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
} from './goal_state_machine.js';

import {
    CHECKPOINT_VERSION,
    COMPACTION_PRESERVE_TURNS,
    DEFAULT_CONTEXT_CHAR_THRESHOLD,
    PRUNED_PLACEHOLDER,
    PRUNE_TOOL_NAMES,
    buildCheckpointStorageKey,
    buildCompactionPrompt,
    buildContextStats,
    buildResumeHydrationPrompt,
    compactAndResume,
    createCheckpoint,
    estimateContextChars,
    estimateMessageChars,
    needsCompaction,
    parseCompactionSummary,
    pruneHistory,
} from './compact_resume_engine.js';

import {
    DEFAULT_MAX_ITERATIONS as ROUTER_DEFAULT_MAX_ITERATIONS,
    GOAL_COMPLETE_TAG,
    GOAL_PLAN_TAG,
    SubagentRouter,
} from './subagent_router.js';

const failures = [];
let passed = 0;

// The exact summary keys the compaction prompt must request. This mirrors the
// engine's internal COMPACTION_SUMMARY_FIELDS constant, which is intentionally
// not exported (the extension code has no importer for it).
const EXPECTED_SUMMARY_FIELDS = [
    'completedSubgoals',
    'modifiedFilesAndCommands',
    'discoveredFactsAndErrors',
    'nextImmediateAction',
];

async function test(name, fn) {
    try {
        await fn();
        passed += 1;
        console.log(`PASS ${name}`);
    } catch (error) {
        failures.push({ name, error });
        console.error(`FAIL ${name}`);
        console.error(error && error.stack ? error.stack : error);
    }
}

function includes(haystack, needle, message) {
    assert.ok(
        String(haystack).includes(needle),
        message || `Expected text to include ${JSON.stringify(needle)}`
    );
}

function makeSession(options = {}) {
    return createGoalSession({
        workflowId: 'wf-smoke',
        rootGoal: 'Build and verify the Ncode orchestrator.',
        ...options,
    });
}

function makeMessages() {
    return [
        { id: 'm1', role: 'user', text: 'Please build the Ncode harness.' },
        { id: 'm2', role: 'ai', text: 'Working on it.', thoughts: 'Plan first.' },
        {
            id: 'm3',
            role: 'user',
            kind: 'tool-output',
            toolName: 'take_snapshot',
            text: `[Tool Output: take_snapshot]\n${'A'.repeat(9000)}`,
            toolStartedAt: 100,
            toolCompletedAt: 200,
        },
        {
            id: 'm4',
            role: 'user',
            kind: 'tool-output',
            toolName: 'chrome_dom_snapshot',
            text: '[Tool Output: chrome_dom_snapshot]\nok',
            toolStartedAt: 300,
            toolCompletedAt: 400,
        },
        {
            id: 'm5',
            role: 'user',
            kind: 'tool-output',
            toolName: 'click',
            text: '[Tool Output: click]\nclicked',
            toolStartedAt: 500,
            toolCompletedAt: 600,
        },
        {
            id: 'm6',
            role: 'user',
            kind: 'tool-output',
            toolName: 'read_file',
            text: `[Tool Output: read_file]\n${'B'.repeat(5000)}`,
            toolStartedAt: 700,
            toolCompletedAt: 800,
        },
        { id: 'm7', role: 'ai', text: 'The harness is ready.' },
        { id: 'm8', role: 'user', text: 'Great, verify it.' },
    ];
}

function makeCompactionAnswer(summary = {}) {
    const payload = {
        completedSubgoals: ['plan'],
        modifiedFilesAndCommands: ['orchestrator/goal_state_machine.js — added the loop'],
        discoveredFactsAndErrors: ['Node 24 is required'],
        nextImmediateAction: 'Run the verifier subgoal.',
        ...summary,
    };
    return `Here is the checkpoint:\n\`\`\`json\n${JSON.stringify(payload)}\n\`\`\``;
}

function makeDeps(overrides = {}) {
    const calls = [];
    const states = [];
    const persisted = [];
    const deps = {
        calls,
        states,
        persisted,
        onState: (state) => states.push(state),
        runCompactionPrompt: async () => {
            calls.push('prompt');
            return makeCompactionAnswer();
        },
        persistCheckpoint: async (checkpoint) => {
            calls.push('persist');
            persisted.push(checkpoint);
        },
        spawnResumeSession: async ({ checkpoint, hydrationPrompt }) => {
            calls.push('spawn');
            assert.ok(checkpoint, 'spawnResumeSession received a checkpoint');
            includes(hydrationPrompt, 'ncode_goal_complete', 'hydration prompt carries goal tags');
            return { sessionId: 'session-B' };
        },
        resumeToolLoop: async ({ sessionId }) => {
            calls.push('resume');
            assert.equal(sessionId, 'session-B');
        },
        ...overrides,
    };
    return deps;
}

// Goal state machine

await test('exports the contract constants', () => {
    assert.deepEqual([...GOAL_ROLES], ['planner', 'pc_coder', 'browser_operator', 'verifier']);
    assert.deepEqual([...SUBGOAL_STATUSES], ['pending', 'running', 'done', 'failed']);
    assert.deepEqual([...GOAL_STATUSES], ['active', 'compacting', 'paused', 'completed', 'failed']);
    assert.equal(DEFAULT_MAX_ITERATIONS, 30);
    assert.equal(COMPACTION_PRESERVE_TURNS, 2);
    assert.equal(DEFAULT_CONTEXT_CHAR_THRESHOLD, 120000);
    assert.equal(PRUNED_PLACEHOLDER, '[Pruned by Ncode Compactor - see checkpoint summary]');
    assert.deepEqual(
        [...PRUNE_TOOL_NAMES],
        ['chrome_dom_snapshot', 'take_snapshot', 'pc_exec_shell', 'pc_shell', 'shell']
    );
    assert.equal(CHECKPOINT_VERSION, 1);
});

await test('createDefaultSubgoals returns the three default steps', () => {
    const subgoals = createDefaultSubgoals();
    assert.deepEqual(
        subgoals.map((subgoal) => subgoal.id),
        ['plan', 'execute', 'verify']
    );
    assert.deepEqual(
        subgoals.map((subgoal) => subgoal.role),
        ['planner', 'pc_coder', 'verifier']
    );
    assert.ok(subgoals.every((subgoal) => subgoal.status === 'pending'));
    assert.ok(subgoals.every((subgoal) => subgoal.evidence === ''));
});

await test('createGoalSession returns a fresh active session', () => {
    const session = makeSession();
    assert.equal(session.workflowId, 'wf-smoke');
    assert.equal(session.rootGoal, 'Build and verify the Ncode orchestrator.');
    assert.equal(session.iterationCount, 0);
    assert.equal(session.maxIterations, DEFAULT_MAX_ITERATIONS);
    assert.equal(session.status, 'active');
    assert.equal(session.completionMarked, false);
    assert.equal(session.subgoals.length, 3);
    assert.ok(Number.isFinite(session.createdAt));
    assert.ok(Number.isFinite(session.updatedAt));
});

await test('createGoalSession accepts explicit subgoals and maxIterations', () => {
    const subgoals = [
        {
            id: 'scan',
            title: 'Scan the repository',
            role: 'planner',
            status: 'pending',
            evidence: '',
        },
        {
            id: 'patch',
            title: 'Patch the daemon',
            role: 'pc_coder',
            status: 'pending',
            evidence: '',
        },
        {
            id: 'drive',
            title: 'Drive the browser',
            role: 'browser_operator',
            status: 'pending',
            evidence: '',
        },
    ];
    const session = makeSession({ subgoals, maxIterations: 5 });
    assert.equal(session.maxIterations, 5);
    assert.deepEqual(
        session.subgoals.map((subgoal) => subgoal.id),
        ['scan', 'patch', 'drive']
    );
});

await test('createGoalSession rejects invalid input loudly', () => {
    assert.throws(() => createGoalSession({ rootGoal: 'no workflow' }), TypeError);
    assert.throws(() => createGoalSession({ workflowId: 'wf' }), TypeError);
    assert.throws(() => createGoalSession({ workflowId: '   ', rootGoal: 'x' }), TypeError);
    assert.throws(
        () =>
            createGoalSession({
                workflowId: 'wf',
                rootGoal: 'goal',
                subgoals: 'not-an-array',
            }),
        TypeError
    );
    assert.throws(
        () =>
            createGoalSession({
                workflowId: 'wf',
                rootGoal: 'goal',
                subgoals: [
                    { id: 'a', title: 'A', role: 'hacker', status: 'pending', evidence: '' },
                ],
            }),
        TypeError
    );
    assert.throws(
        () =>
            createGoalSession({
                workflowId: 'wf',
                rootGoal: 'goal',
                subgoals: [
                    { id: 'a', title: 'A', role: 'planner', status: 'blocked', evidence: '' },
                ],
            }),
        TypeError
    );
    assert.throws(
        () =>
            createGoalSession({
                workflowId: 'wf',
                rootGoal: 'goal',
                subgoals: [
                    { id: 'a', title: 'A', role: 'planner', status: 'pending', evidence: '' },
                    { id: 'a', title: 'B', role: 'verifier', status: 'pending', evidence: '' },
                ],
            }),
        TypeError
    );
    assert.throws(() => makeSession({ maxIterations: 0 }), TypeError);
});

await test('system directive carries goal, checklist, iteration and all tags', () => {
    const session = makeSession();
    const directive = buildGoalSystemDirective(session);
    includes(directive, 'gemini.google.com');
    includes(directive, 'logged-in');
    includes(directive, 'autonomous');
    includes(directive, session.rootGoal);
    includes(directive, 'Iteration: 0 of 30');
    for (const subgoal of session.subgoals) {
        includes(directive, subgoal.id);
        includes(directive, subgoal.role);
        includes(directive, subgoal.status);
    }
    includes(directive, '<ncode_preamble>');
    includes(directive, '</ncode_preamble>');
    includes(directive, '<ncode_goal_update>');
    includes(directive, '</ncode_goal_update>');
    includes(directive, '<ncode_goal_complete>true</ncode_goal_complete>');
    includes(directive, '"tool"');
    includes(directive, '"args"');
    assert.match(directive, /immediately\s+BEFORE every tool call/i);
    assert.match(directive, /never invent completion/i);
    assert.match(directive, /keep working through tool calls/i);
});

await test('parseGoalTags extracts preamble, update and completion', () => {
    const modelText = [
        'Working on the plan.',
        '<ncode_preamble>Inspecting the workspace layout.</ncode_preamble>',
        '{"tool":"chrome_dom_snapshot","args":{"tabId":1}}',
        '<ncode_goal_update>{"subgoalId":"plan","status":"running","evidence":"Reading files."}</ncode_goal_update>',
        'More work.',
        '<ncode_goal_complete>true</ncode_goal_complete>',
    ].join('\n');
    const parsed = parseGoalTags(modelText);
    assert.equal(parsed.preamble, 'Inspecting the workspace layout.');
    assert.deepEqual(parsed.goalUpdate, {
        subgoalId: 'plan',
        status: 'running',
        evidence: 'Reading files.',
    });
    assert.equal(parsed.goalComplete, true);
    assert.equal(parsed.hasGoalTags, true);
    assert.equal(parsed.goalUpdateError, null);
    includes(parsed.cleanedText, 'Working on the plan.');
    includes(parsed.cleanedText, '{"tool":"chrome_dom_snapshot","args":{"tabId":1}}');
    includes(parsed.cleanedText, 'More work.');
    assert.ok(!parsed.cleanedText.includes('<ncode_'), 'tags are stripped from cleanedText');
});

await test('parseGoalTags tolerates whitespace, repeats and malformed JSON', () => {
    const primed = parseGoalTags(
        'Start.\n<ncode_preamble>\n  Step one\n  continues here\n</ncode_preamble>\nEnd.'
    );
    assert.equal(primed.preamble, 'Step one\n  continues here');
    assert.equal(primed.goalUpdate, null);
    assert.equal(primed.hasGoalTags, true);

    const repeated = parseGoalTags(
        '<ncode_goal_update>{"subgoalId":"plan","status":"running"}</ncode_goal_update>\n' +
            '<ncode_goal_update>{"subgoalId":"plan","status":"done","evidence":"Files read."}</ncode_goal_update>'
    );
    assert.deepEqual(repeated.goalUpdate, {
        subgoalId: 'plan',
        status: 'done',
        evidence: 'Files read.',
    });
    assert.equal(Array.isArray(repeated.goalUpdates), true);
    assert.equal(repeated.goalUpdates.length, 2, 'every repeated goal update is preserved');

    let malformed;
    assert.doesNotThrow(() => {
        malformed = parseGoalTags(
            'Plan.\n<ncode_goal_update>{this is not json}</ncode_goal_update>'
        );
    });
    assert.equal(malformed.goalUpdate, null);
    assert.equal(typeof malformed.goalUpdateError, 'string');
    assert.ok(malformed.goalUpdateError.length > 0);
    assert.equal(malformed.goalComplete, false);
    includes(malformed.cleanedText, 'Plan.');

    const empty = parseGoalTags('');
    assert.equal(empty.preamble, null);
    assert.equal(empty.cleanedText, '');
    assert.equal(empty.hasGoalTags, false);
});

await test('parseGoalTags keeps every milestone update from one model turn', () => {
    const parsed = parseGoalTags(
        '<ncode_preamble>Closing two milestones.</ncode_preamble>\n' +
            '<ncode_goal_update>{"subgoalId":"execute","status":"done","evidence":"Tool ran."}</ncode_goal_update>\n' +
            '<ncode_goal_update>{"subgoalId":"verify","status":"done","evidence":"Output parsed."}</ncode_goal_update>\n' +
            '<ncode_goal_complete>true</ncode_goal_complete>\nAll milestones verified.'
    );
    assert.equal(parsed.goalUpdates.length, 2);
    assert.deepEqual(
        parsed.goalUpdates.map((update) => [update.subgoalId, update.status]),
        [
            ['execute', 'done'],
            ['verify', 'done'],
        ]
    );
    // Last update remains the single-update compatibility view.
    assert.equal(parsed.goalUpdate.subgoalId, 'verify');
    assert.equal(parsed.goalComplete, true);
    includes(parsed.cleanedText, 'All milestones verified.');
});

await test('parseGoalTags recovers HTML-escaped status tags from Gemini Web', () => {
    const escaped = [
        'Wrapped by the web markdown renderer.',
        '&lt;ncode_preamble&gt;Inspecting the machine.&lt;/ncode_preamble&gt;',
        '&lt;ncode_goal_update&gt;{"subgoalId":"plan","status":"done","evidence":"ok"}&lt;/ncode_goal_update&gt;',
        '&lt;ncode_goal_complete&gt;true&lt;/ncode_goal_complete&gt;',
    ].join('\n');
    const parsed = parseGoalTags(escaped);
    assert.equal(parsed.htmlEntitiesDecoded, true);
    assert.equal(parsed.hasGoalTags, true);
    assert.equal(parsed.preamble, 'Inspecting the machine.');
    assert.equal(parsed.goalUpdates.length, 1);
    assert.equal(parsed.goalUpdates[0].subgoalId, 'plan');
    assert.equal(parsed.goalComplete, true);
    assert.ok(!parsed.cleanedText.includes('&lt;ncode_'));
});

await test('multi-milestone turn completes a goal through applyGoalUpdate + isGoalComplete', () => {
    let session = createGoalSession({
        workflowId: 'wf-multi-milestones',
        rootGoal: 'Ship the verified change.',
        subgoals: [
            { id: 'plan', title: 'Plan', role: 'planner', status: 'done', evidence: 'plan-ok' },
            { id: 'execute', title: 'Execute', role: 'pc_coder', status: 'running', evidence: 'in progress' },
            { id: 'verify', title: 'Verify', role: 'verifier', status: 'pending', evidence: '' },
        ],
    });
    const modelText =
        '<ncode_goal_update>{"subgoalId":"execute","status":"done","evidence":"tests green"}</ncode_goal_update>\n' +
        '<ncode_goal_update>{"subgoalId":"verify","status":"done","evidence":"output checked"}</ncode_goal_update>\n' +
        '<ncode_goal_complete>true</ncode_goal_complete>';
    const parsed = parseGoalTags(modelText);
    for (const update of parsed.goalUpdates) session = applyGoalUpdate(session, update);
    assert.equal(
        session.subgoals.every((subgoal) => subgoal.status === 'done'),
        true
    );
    assert.equal(isGoalComplete(session, modelText), true);
});

await test('parseGoalTags strips tags while preserving surrounding prose', () => {
    const parsed = parseGoalTags(
        'Alpha\n<ncode_preamble>Checking.</ncode_preamble>\nOmega\n<ncode_goal_complete>false</ncode_goal_complete>'
    );
    assert.equal(parsed.cleanedText.includes('Alpha'), true);
    assert.equal(parsed.cleanedText.includes('Omega'), true);
    assert.equal(parsed.cleanedText.includes('<ncode_'), false);
    assert.equal(parsed.goalComplete, false);
});

await test('applyGoalUpdate changes one subgoal immutably', () => {
    const session = makeSession();
    const updated = applyGoalUpdate(session, {
        subgoalId: 'plan',
        status: 'running',
        evidence: 'Reading the workspace.',
    });
    assert.notEqual(updated, session);
    assert.equal(session.subgoals[0].status, 'pending', 'input session is not mutated');
    assert.equal(updated.subgoals[0].status, 'running');
    assert.equal(updated.subgoals[0].evidence, 'Reading the workspace.');
    assert.equal(updated.subgoals[1].status, 'pending');
    assert.equal(updated.status, 'active');
    assert.equal(updated.completionMarked, false);
    assert.ok(updated.updatedAt >= session.updatedAt);
});

await test('applyGoalUpdate ignores unknown ids, bad statuses and non-objects', () => {
    const session = makeSession();
    for (const update of [
        { subgoalId: 'does-not-exist', status: 'done' },
        { subgoalId: 'plan', status: 'blocked' },
        null,
        undefined,
        'nope',
        {},
    ]) {
        const result = applyGoalUpdate(session, update);
        assert.deepEqual(
            result.subgoals.map((subgoal) => subgoal.status),
            session.subgoals.map((subgoal) => subgoal.status)
        );
        assert.equal(result.status, 'active');
    }
});

await test('a failed subgoal keeps the goal active for retries', () => {
    const session = makeSession();
    const failed = applyGoalUpdate(session, {
        subgoalId: 'execute',
        status: 'failed',
        evidence: 'Daemon refused the connection.',
    });
    assert.equal(failed.subgoals[1].status, 'failed');
    assert.equal(failed.status, 'active');
    assert.equal(failed.completionMarked, false);
});

await test('updates never mark completion', () => {
    let session = makeSession();
    for (const subgoal of session.subgoals) {
        session = applyGoalUpdate(session, {
            subgoalId: subgoal.id,
            status: 'done',
            evidence: `completed ${subgoal.id}`,
        });
    }
    assert.ok(session.subgoals.every((subgoal) => subgoal.status === 'done'));
    assert.equal(session.completionMarked, false);
});

await test('isGoalComplete requires done subgoals and an explicit completion tag', () => {
    let session = makeSession();
    for (const subgoal of session.subgoals) {
        session = applyGoalUpdate(session, {
            subgoalId: subgoal.id,
            status: 'done',
            evidence: 'verified',
        });
    }
    assert.equal(isGoalComplete(session, 'All done.'), false);
    assert.equal(isGoalComplete(session, '<ncode_goal_complete>true</ncode_goal_complete>'), true);

    const pendingSession = makeSession();
    assert.equal(
        isGoalComplete(pendingSession, '<ncode_goal_complete>true</ncode_goal_complete>'),
        false
    );

    const marked = markGoalCompletion(session, { complete: true });
    assert.equal(marked.completionMarked, true);
    assert.equal(marked.status, 'completed');
    assert.equal(isGoalComplete(marked, 'No explicit tag, but already verified.'), true);

    const unmarked = markGoalCompletion(marked, { complete: false });
    assert.equal(unmarked.completionMarked, false);
    assert.equal(unmarked.status, 'active');
});

await test('iteration cap fails the session with a recorded reason', () => {
    let session = makeSession({ maxIterations: 2 });
    session = incrementIteration(session);
    assert.equal(session.iterationCount, 1);
    assert.equal(session.status, 'active');
    assert.equal(isGoalExhausted(session), false);

    session = incrementIteration(session);
    assert.equal(session.iterationCount, 2);
    assert.equal(session.status, 'failed');
    assert.equal(session.failureReason, 'max_iterations_reached');
    assert.equal(isGoalExhausted(session), true);

    const serialized = serializeGoalSession(session);
    assert.equal(serialized.failureReason, 'max_iterations_reached');
    const restored = normalizeGoalSession(serialized);
    assert.equal(restored.iterationCount, 2);
    assert.equal(restored.status, 'failed');
    assert.equal(restored.failureReason, 'max_iterations_reached');
});

await test('markGoalStatus validates the status vocabulary', () => {
    const session = makeSession();
    assert.throws(() => markGoalStatus(session, 'sleeping'), TypeError);
    const paused = markGoalStatus(session, 'paused');
    assert.equal(paused.status, 'paused');
    assert.equal(session.status, 'active');
    const completed = markGoalStatus(session, 'completed');
    assert.equal(completed.status, 'completed');
    assert.equal(completed.completionMarked, true);
    const failed = markGoalStatus(session, 'failed', 'provider unavailable');
    assert.equal(failed.status, 'failed');
    assert.equal(failed.failureReason, 'provider unavailable');
    const recovered = markGoalStatus(failed, 'active');
    assert.equal(recovered.status, 'active');
    assert.equal('failureReason' in recovered, false);
});

await test('normalizeGoalSession round-trips a serialized session', () => {
    const session = applyGoalUpdate(makeSession(), {
        subgoalId: 'plan',
        status: 'done',
        evidence: 'Plan written.',
    });
    const serialized = serializeGoalSession(session);
    assert.equal(typeof serialized, 'object');
    assert.equal(typeof serialized.createdAt, 'number');
    assert.doesNotThrow(() => JSON.stringify(serialized));
    const normalized = normalizeGoalSession(serialized);
    assert.deepEqual(normalized, session);

    assert.throws(() => normalizeGoalSession(null), TypeError);
    assert.throws(() => normalizeGoalSession({ workflowId: 'wf' }), TypeError);
    assert.throws(
        () => normalizeGoalSession({ workflowId: 'wf', rootGoal: 'goal', subgoals: 'nope' }),
        TypeError
    );
    assert.throws(
        () =>
            normalizeGoalSession({
                workflowId: 'wf',
                rootGoal: 'goal',
                subgoals: [],
                status: 'sleeping',
            }),
        TypeError
    );
});

await test('continuation and resume prompts carry the goal loop contract', () => {
    const session = makeSession();
    const continuation = buildGoalContinuationPrompt(session);
    includes(continuation, session.rootGoal);
    includes(continuation, '`plan`');
    includes(continuation, 'Iteration 0 of 30');
    includes(continuation, '<ncode_preamble>');
    includes(continuation, '<ncode_goal_update>');
    includes(continuation, '<ncode_goal_complete>');
    includes(continuation, 'remaining');
    includes(continuation, 'blocked');

    const resume = buildGoalResumeDirective(session);
    includes(resume, 'Compact & Resume');
    includes(resume, session.rootGoal);
    includes(resume, 'iteration: 0 of 30');
    includes(resume, 'completion already marked: no');
    includes(resume, '<ncode_preamble>');
    includes(resume, '<ncode_goal_update>');
    includes(resume, '<ncode_goal_complete>');
});

// Compact & Resume engine

await test('estimateMessageChars counts text and ignores image payloads', () => {
    assert.equal(estimateMessageChars({ text: 'hello' }), 5);
    assert.equal(
        estimateMessageChars({
            text: 'hello',
            image: ['Z'.repeat(100000)],
            attachments: [{ base64: 'Q'.repeat(100000) }],
        }),
        5
    );
    assert.equal(
        estimateMessageChars({ text: 'x', args: { path: 'C:/work' }, output: 'done' }),
        12
    );
    const nestedImagePayload = estimateMessageChars({
        text: 'ok',
        content: [
            { type: 'text', text: 'abc' },
            { type: 'image_url', image_url: { url: `data:${'Z'.repeat(200000)}` } },
        ],
    });
    assert.ok(nestedImagePayload < 200, 'nested image payloads are not counted');
    assert.equal(estimateMessageChars({ text: 'a', thoughts: 'bb', toolOutput: 'ccc' }), 1 + 2 + 3);
    assert.equal(estimateMessageChars(null), 0);
    assert.equal(
        estimateMessageChars(makeMessages()),
        estimateContextChars(makeMessages()),
        'estimateMessageChars also accepts a message list'
    );
});

await test('context stats and compaction threshold react to the message list', () => {
    const messages = makeMessages();
    const chars = estimateContextChars(messages);
    const stats = buildContextStats(messages);
    assert.ok(chars > 10000);
    assert.equal(stats.chars, chars);
    assert.equal(stats.approxTokens, Math.ceil(chars / 4));
    assert.equal(stats.messageCount, messages.length);
    assert.equal(stats.prunableCount, 3);
    assert.equal(needsCompaction(messages), false);
    assert.equal(needsCompaction(messages, { thresholdChars: 10 }), true);
    assert.equal(needsCompaction([], { thresholdChars: 0 }), true);
});

await test('pruneHistory preserves recent rows and replaces verbose tool output', () => {
    const messages = makeMessages();
    const result = pruneHistory(messages, { preserveRecentTurns: 1 });
    assert.equal(result.prunedCount, 3);
    assert.ok(result.prunedChars > 0);
    assert.deepEqual(result.prunedToolNames, ['take_snapshot', 'chrome_dom_snapshot', 'read_file']);

    const prunedIds = ['m3', 'm4', 'm6'];
    for (const id of prunedIds) {
        const row = result.messages.find((message) => message.id === id);
        assert.equal(row.text, PRUNED_PLACEHOLDER);
        assert.equal(row.pruned, true);
    }
    const snapshotRow = result.messages.find((message) => message.id === 'm3');
    assert.equal(snapshotRow.kind, 'tool-output');
    assert.equal(snapshotRow.toolName, 'take_snapshot');
    assert.equal(snapshotRow.role, 'user');
    assert.equal(snapshotRow.toolStartedAt, 100);
    assert.equal(snapshotRow.toolCompletedAt, 200);

    const clickRow = messages.find((message) => message.id === 'm5');
    assert.equal(
        result.messages.find((message) => message.id === 'm5'),
        clickRow
    );

    for (const id of ['m7', 'm8']) {
        assert.equal(
            result.messages.find((message) => message.id === id),
            messages.find((message) => message.id === id),
            'recent messages are preserved by identity'
        );
    }

    assert.ok(messages[2].text.length > 9000, 'input messages are not mutated');
    assert.equal(result.messages[0], messages[0], 'non-tool messages are preserved by identity');
});

await test('compaction prompt requests exactly the summary JSON fields', () => {
    const session = makeSession();
    const messages = makeMessages();
    const pruned = pruneHistory(messages, { preserveRecentTurns: 1 });
    const stats = buildContextStats(pruned.messages);
    const prompt = buildCompactionPrompt({
        goalSession: session,
        messages: pruned.messages,
        stats,
    });
    includes(prompt, '```json');
    for (const field of EXPECTED_SUMMARY_FIELDS) {
        includes(prompt, `"${field}"`);
    }
    includes(prompt, session.rootGoal);
    includes(prompt, PRUNED_PLACEHOLDER);
    includes(prompt, '[pruned]');
    includes(prompt, 'ONLY one fenced');
    includes(prompt, 'nextImmediateAction');
});

await test('parseCompactionSummary reads a fenced JSON checkpoint', () => {
    const parsed = parseCompactionSummary(makeCompactionAnswer());
    assert.equal(parsed.parseError, null);
    assert.deepEqual(parsed.completedSubgoals, ['plan']);
    assert.deepEqual(parsed.modifiedFilesAndCommands, [
        'orchestrator/goal_state_machine.js — added the loop',
    ]);
    assert.deepEqual(parsed.discoveredFactsAndErrors, ['Node 24 is required']);
    assert.equal(parsed.nextImmediateAction, 'Run the verifier subgoal.');
});

await test('parseCompactionSummary never throws on malformed or partial answers', () => {
    const malformedJson = parseCompactionSummary('```json\n{"completedSubgoals": [oops}\n```');
    assert.equal(typeof malformedJson.parseError, 'string');
    assert.deepEqual(malformedJson.completedSubgoals, []);
    assert.deepEqual(malformedJson.modifiedFilesAndCommands, []);

    const bulletFallback = parseCompactionSummary(
        'Compaction finished without a JSON block.\n- Install the pc-daemon before the next step.'
    );
    assert.equal(typeof bulletFallback.parseError, 'string');
    assert.equal(bulletFallback.nextImmediateAction, 'Install the pc-daemon before the next step.');

    const empty = parseCompactionSummary('');
    assert.equal(typeof empty.parseError, 'string');
    assert.equal(empty.nextImmediateAction, '');

    const bareJson = parseCompactionSummary(
        '{"completedSubgoals":"plan","nextImmediateAction":"Retry the shell tool."}'
    );
    assert.equal(bareJson.parseError, null);
    assert.deepEqual(bareJson.completedSubgoals, ['plan']);
    assert.equal(bareJson.nextImmediateAction, 'Retry the shell tool.');
});

await test('checkpoint round-trips through storage and hydration', () => {
    const session = makeSession();
    const stats = buildContextStats(makeMessages());
    const summary = parseCompactionSummary(makeCompactionAnswer());
    const checkpoint = createCheckpoint({
        workflowId: session.workflowId,
        goalSession: session,
        summary,
        stats,
        prunedChars: 12000,
        reason: 'context-threshold',
        sessionId: 'session-A',
    });

    assert.equal(checkpoint.workflowId, 'wf-smoke');
    assert.equal(checkpoint.version, CHECKPOINT_VERSION);
    assert.equal(typeof checkpoint.checkpointId, 'string');
    assert.ok(checkpoint.checkpointId.length > 0);
    assert.ok(Number.isFinite(checkpoint.createdAt));
    assert.equal(checkpoint.reason, 'context-threshold');
    assert.equal(checkpoint.sessionId, 'session-A');
    assert.equal(checkpoint.goalSession.workflowId, session.workflowId);
    assert.deepEqual(checkpoint.completedSubgoals, ['plan']);
    assert.equal(checkpoint.nextImmediateAction, 'Run the verifier subgoal.');
    assert.equal(checkpoint.prunedChars, 12000);
    assert.equal(checkpoint.contextChars, stats.chars);
    assert.equal(checkpoint.approxTokens, stats.approxTokens);
    assert.equal('parseError' in checkpoint, false);

    assert.equal(buildCheckpointStorageKey('wf-smoke'), 'ncodeCheckpoint:wf-smoke');
    assert.throws(() => buildCheckpointStorageKey(''), TypeError);

    const roundTripped = JSON.parse(JSON.stringify(checkpoint));
    const hydration = buildResumeHydrationPrompt(roundTripped);
    includes(hydration, 'Compact & Resume');
    includes(hydration, 'Run the verifier subgoal.');
    includes(hydration, 'orchestrator/goal_state_machine.js — added the loop');
    includes(hydration, 'Node 24 is required');
    includes(hydration, session.rootGoal);
    includes(hydration, '<ncode_preamble>');
    includes(hydration, '<ncode_goal_update>');
    includes(hydration, '<ncode_goal_complete>');
    includes(hydration, 'Continue autonomously');

    assert.throws(() => buildResumeHydrationPrompt(null), TypeError);
});

await test('compaction without a goal session keeps working end to end', () => {
    const messages = makeMessages();
    const pruned = pruneHistory(messages, { preserveRecentTurns: 1 });
    const stats = buildContextStats(pruned.messages);
    const prompt = buildCompactionPrompt({
        goalSession: null,
        messages: pruned.messages,
        stats,
    });
    includes(prompt, 'No Astra goal session');
    for (const field of EXPECTED_SUMMARY_FIELDS) {
        includes(prompt, `"${field}"`);
    }

    const summary = parseCompactionSummary(makeCompactionAnswer());
    const checkpoint = createCheckpoint({
        workflowId: 'wf-no-goal',
        goalSession: null,
        summary,
        stats,
        prunedChars: pruned.prunedChars,
        reason: 'manual',
    });
    assert.equal(checkpoint.workflowId, 'wf-no-goal');
    assert.equal(checkpoint.goalSession, null);
    const hydration = buildResumeHydrationPrompt(JSON.parse(JSON.stringify(checkpoint)));
    includes(hydration, 'No Astra goal loop session');
    includes(hydration, 'Run the verifier subgoal.');
    includes(hydration, '<ncode_preamble>');

    assert.throws(
        () => createCheckpoint({ goalSession: null, summary, stats }),
        TypeError,
        'a checkpoint still needs a workflowId'
    );
    assert.throws(
        () =>
            createCheckpoint({
                workflowId: 'wf-bad',
                goalSession: 'not-a-session',
            }),
        TypeError
    );
});

await test('compactAndResume happy path orchestrates deps in order', async () => {
    const goalSession = makeSession();
    const messages = makeMessages();
    const deps = makeDeps();
    const result = await compactAndResume({
        goalSession,
        messages,
        thresholdChars: 100,
        preserveRecentTurns: 1,
        reason: 'manual-smoke',
        deps,
    });

    assert.equal(result.compacted, true);
    assert.equal(result.reason, 'manual-smoke');
    assert.equal(result.resumedSessionId, 'session-B');
    assert.equal(result.resumeError, null);
    assert.ok(result.checkpoint);
    assert.equal(result.checkpoint.version, CHECKPOINT_VERSION);
    assert.equal(result.checkpoint.reason, 'manual-smoke');
    assert.equal(result.checkpoint.goalSession.status, 'compacting');
    assert.equal(result.prunedCount, 3);
    assert.ok(result.prunedChars > 0);
    assert.equal(result.goalSession.status, 'active');
    assert.equal(result.goalSession.completionMarked, false);
    assert.equal(deps.persisted.length, 1);
    assert.equal(deps.persisted[0].checkpointId, result.checkpoint.checkpointId);
    assert.deepEqual(deps.calls, ['prompt', 'persist', 'spawn', 'resume']);
    assert.deepEqual(deps.states, ['pruning', 'compacting', 'persisting', 'done']);
});

await test('compactAndResume skips deps below the threshold', async () => {
    const goalSession = makeSession();
    const deps = makeDeps({
        runCompactionPrompt: async () => {
            throw new Error('must not compact below the threshold');
        },
    });
    const result = await compactAndResume({
        goalSession,
        messages: [{ id: 'small', role: 'user', text: 'hello' }],
        deps,
    });
    assert.equal(result.compacted, false);
    assert.equal(result.reason, 'below-threshold');
    assert.equal(result.checkpoint, null);
    assert.equal(result.resumedSessionId, null);
    assert.equal(result.prunedCount, 0);
    assert.deepEqual(deps.calls, []);
    assert.deepEqual(deps.states, []);
});

await test('compactAndResume force mode validates deps synchronously', () => {
    const goalSession = makeSession();
    assert.throws(
        () => compactAndResume({ goalSession, messages: [], force: true, deps: {} }),
        TypeError
    );
    assert.throws(() => compactAndResume({ goalSession, messages: [], force: true }), TypeError);
});

await test('compactAndResume force mode compacts below the threshold', async () => {
    const goalSession = makeSession();
    const deps = makeDeps();
    const result = await compactAndResume({
        goalSession,
        messages: [{ id: 'small', role: 'user', text: 'hello' }],
        force: true,
        deps,
    });
    assert.equal(result.compacted, true);
    assert.equal(result.reason, 'forced');
    assert.equal(result.resumedSessionId, 'session-B');
    assert.deepEqual(deps.calls, ['prompt', 'persist', 'spawn', 'resume']);
});

await test('compactAndResume contains failures without losing the goal', async () => {
    const goalSession = makeSession();
    const deps = makeDeps({
        runCompactionPrompt: async () => {
            throw new Error('model exploded');
        },
    });
    const result = await compactAndResume({
        goalSession,
        messages: makeMessages(),
        thresholdChars: 100,
        deps,
    });
    assert.equal(result.compacted, false);
    assert.equal(result.reason, 'failed');
    assert.equal(result.checkpoint, null);
    assert.equal(result.resumedSessionId, null);
    assert.equal(result.goalSession.status, 'active');
    includes(result.error, 'model exploded');
    assert.deepEqual(deps.calls, []);
    assert.deepEqual(deps.states, ['pruning', 'compacting', 'failed']);
});

await test('compactAndResume keeps the checkpoint when resume hiccups', async () => {
    const goalSession = makeSession();
    const deps = makeDeps({
        resumeToolLoop: async () => {
            throw new Error('resume hiccup');
        },
    });
    const result = await compactAndResume({
        goalSession,
        messages: makeMessages(),
        thresholdChars: 100,
        deps,
    });
    assert.equal(result.compacted, true);
    assert.ok(result.checkpoint);
    assert.equal(result.resumedSessionId, 'session-B');
    includes(result.resumeError, 'resume hiccup');
    assert.equal(result.goalSession.status, 'active');
    assert.deepEqual(deps.states, ['pruning', 'compacting', 'persisting', 'done']);
});

await test('compactAndResume surfaces a spawn failure but keeps the checkpoint', async () => {
    const goalSession = makeSession();
    const deps = makeDeps({
        spawnResumeSession: async () => ({}),
    });
    const result = await compactAndResume({
        goalSession,
        messages: makeMessages(),
        thresholdChars: 100,
        deps,
    });
    assert.equal(result.compacted, false);
    assert.equal(result.reason, 'failed');
    assert.ok(result.checkpoint, 'the persisted checkpoint is returned');
    includes(result.error, 'did not return a sessionId');
    assert.equal(result.goalSession.status, 'active');
    assert.deepEqual(deps.calls, ['prompt', 'persist']);
});

await test('compactAndResume does not report an unpersisted checkpoint as durable', async () => {
    const goalSession = makeSession();
    const deps = makeDeps({
        persistCheckpoint: async () => {
            throw new Error('storage offline');
        },
    });
    const result = await compactAndResume({
        goalSession,
        messages: makeMessages(),
        thresholdChars: 100,
        deps,
    });
    assert.equal(result.compacted, false);
    assert.equal(result.reason, 'failed');
    assert.equal(result.checkpoint, null);
    assert.equal(result.goalSession.status, 'active');
    includes(result.error, 'storage offline');
    assert.deepEqual(deps.states, ['pruning', 'compacting', 'failed']);
});

await test('compactAndResume never throws for a non-force missing-deps call', async () => {
    const goalSession = makeSession();
    let result;
    await assert.doesNotReject(async () => {
        result = await compactAndResume({
            goalSession,
            messages: makeMessages(),
            thresholdChars: 100,
        });
    });
    assert.equal(result.compacted, false);
    assert.equal(result.reason, 'failed');
    assert.equal(result.goalSession.status, 'active');
});

await test('compactAndResume rejects an invalid goal session or message list', () => {
    assert.throws(() => compactAndResume({ messages: [] }), TypeError);
    assert.throws(
        () => compactAndResume({ goalSession: makeSession(), messages: 'nope' }),
        TypeError
    );
});

// Four-role subagent router

function makeRouterPlan() {
    return [
        { id: 'inspect', title: 'Inspect the repository', role: 'planner', dependsOn: [] },
        {
            id: 'patch',
            title: 'Patch the module',
            role: 'pc_coder',
            dependsOn: ['inspect'],
            successCriteria: 'node --check exits 0',
        },
        { id: 'verify', title: 'Verify the result', role: 'verifier', dependsOn: ['patch'] },
    ];
}

async function makeRoutedSession(router) {
    let session = router.createGoalSession({
        workflowId: 'wf-smoke-router',
        rootGoal: 'Route the smoke test through four roles.',
    });
    const planned = router.plan(
        `<${GOAL_PLAN_TAG}>${JSON.stringify(makeRouterPlan())}</${GOAL_PLAN_TAG}>`
    );
    assert.equal(planned.ok, true, planned.errors.join(' '));
    session = router.applyPlan(session, planned.nodes);
    return session;
}

await test('subagent router plans a DAG and schedules ready nodes in order', async () => {
    const router = new SubagentRouter();
    const session = await makeRoutedSession(router);
    assert.equal(ROUTER_DEFAULT_MAX_ITERATIONS, 30);
    assert.deepEqual(
        session.subgoals.map((subgoal) => subgoal.id),
        ['inspect', 'patch', 'verify']
    );
    assert.equal(router.nextSubgoal(session).id, 'inspect');
    const blocked = router.applySubgoalResult(session, { subgoalId: 'verify', status: 'running' });
    assert.equal(blocked.accepted, false);
    includes(blocked.reasons.join(' '), 'dependencies_not_done:patch');
});

await test('subagent router verifier refuses unproven completion and accepts evidence', async () => {
    const router = new SubagentRouter();
    let session = await makeRoutedSession(router);
    const unproven = router.completionGate(session, { complete: true });
    assert.equal(unproven.allowed, false);
    includes(unproven.reasons.join(' '), 'subgoals_not_done');

    session = router.applySubgoalResult(session, {
        subgoalId: 'inspect',
        status: 'done',
        evidence: 'repository mapped',
    }).goalSession;
    const refusedEvidence = router.applySubgoalResult(session, {
        subgoalId: 'patch',
        status: 'done',
        evidence: 'trust me, it works',
    });
    assert.equal(refusedEvidence.accepted, false);
    includes(refusedEvidence.reasons.join(' '), 'unstructured_pc_evidence');

    session = router.applySubgoalResult(session, {
        subgoalId: 'patch',
        status: 'done',
        evidence: {
            summary: 'Tests pass',
            command: 'node --check orchestrator/subagent_router.js',
            exitCode: 0,
            changedFiles: ['orchestrator/subagent_router.js'],
            gitDiff: '+routed',
        },
    }).goalSession;
    session = router.applySubgoalResult(session, {
        subgoalId: 'verify',
        status: 'done',
        evidence: 'exit code and diff checked',
    }).goalSession;

    const noTag = router.completionGate(session);
    assert.deepEqual(noTag.reasons, ['missing_completion_tag']);
    const gate = router.completionGate(session, {
        modelText: `Done.\n<${GOAL_COMPLETE_TAG}>true</${GOAL_COMPLETE_TAG}>`,
    });
    assert.equal(gate.allowed, true);
    assert.equal(gate.completionTag, `<${GOAL_COMPLETE_TAG}>true</${GOAL_COMPLETE_TAG}>`);
    const marked = router.markGoalComplete(session, { complete: true });
    assert.equal(marked.goalSession.status, 'completed');
    assert.equal(marked.goalSession.completionMarked, true);
});

await test('subagent router harness snapshot matches the goal-session contract', async () => {
    const router = new SubagentRouter();
    const session = await makeRoutedSession(router);
    const snapshot = router.toHarnessSnapshot(session);
    assert.deepEqual(Object.keys(snapshot), [
        'workflowId',
        'rootGoal',
        'subgoals',
        'iterationCount',
        'maxIterations',
        'status',
        'completionMarked',
        'createdAt',
        'updatedAt',
    ]);
    assert.deepEqual(Object.keys(snapshot.subgoals[0]), [
        'id',
        'title',
        'role',
        'status',
        'evidence',
    ]);
    const serialized = router.serializeState(session);
    const restored = router.hydrateState(JSON.parse(JSON.stringify(serialized)));
    assert.deepEqual(router.toHarnessSnapshot(restored), snapshot);
    assert.deepEqual(restored.subgoals[1].dependsOn, ['inspect']);
});

// Summary

if (failures.length > 0) {
    console.error(`\n${failures.length} smoke check(s) failed, ${passed} passed.`);
    process.exitCode = 1;
} else {
    console.log(`\nAll ${passed} orchestrator smoke checks passed.`);
}
