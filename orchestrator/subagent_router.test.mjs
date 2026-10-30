#!/usr/bin/env node
/**
 * Ncode four-role subagent router test suite.
 *
 * Exercises the planner DAG recovery/validation, PC coder and browser operator tool
 * whitelists, ready-node scheduling, retry handling, evidence verification, the
 * completion gate, the harness-bar goal-session shape and the source/mirror sync.
 *
 * Runs with plain Node, no dependencies:
 *
 *   node Ncode/orchestrator/subagent_router.test.mjs
 *
 * Prints one PASS line per check and exits non-zero on failure.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { normalizeGoalSession } from './goal_state_machine.js';

import {
    BROWSER_TOOL_NAMES,
    DEFAULT_MAX_ATTEMPTS,
    DEFAULT_MAX_ITERATIONS,
    GOAL_COMPLETE_TAG,
    GOAL_PLAN_TAG,
    GOAL_ROLES,
    GOAL_STATUSES,
    GOAL_UPDATE_TAG,
    MAX_PLAN_SUBGOALS,
    PC_CODER_TOOL_NAMES,
    PREAMBLE_TAG,
    ROLE_PROMPTS,
    ROLE_TOOL_WHITELISTS,
    SUBGOAL_STATUSES,
    SubagentRouter,
    advanceIteration,
    applyPlan,
    applySubgoalResult,
    buildContinuationPrompt,
    buildPlanPrompt,
    buildRolePrompt,
    buildVerifierPrompt,
    completionGate,
    createGoalSession,
    hasGoalCompletionTag,
    hydrateState,
    listReadySubgoals,
    markGoalComplete,
    nextSubgoal,
    parseGoalPlan,
    serializeGoalPlan,
    serializeState,
    toHarnessSnapshot,
    validateGoalPlan,
    verifySubgoalCompletion,
} from './subagent_router.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const ROUTER_SOURCE_PATH = path.join(__dirname, 'subagent_router.js');
const ROUTER_MIRROR_PATH = path.join(
    PROJECT_ROOT,
    'extension',
    'shared',
    'orchestrator',
    'subagent_router.js'
);

const failures = [];
let passed = 0;

/**
 * @param {string} name
 * @param {() => unknown | Promise<unknown>} fn
 */
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

/**
 * @param {unknown} haystack
 * @param {string} needle
 * @param {string} [message]
 */
function includes(haystack, needle, message) {
    assert.ok(
        String(haystack).includes(needle),
        message || `Expected text to include ${JSON.stringify(needle)}`
    );
}

/** The canonical four-step DAG used across scheduling and completion tests. */
function samplePlan() {
    return [
        {
            id: 'inspect',
            title: 'Inspect the repository layout',
            role: 'planner',
            dependsOn: [],
            successCriteria: 'Relevant files, commands and constraints are listed.',
            tools: ['pc_fs_tree', 'pc_fs_read'],
        },
        {
            id: 'patch',
            title: 'Patch the subagent router',
            role: 'pc_coder',
            dependsOn: ['inspect'],
            successCriteria: 'pc_exec_shell reports exit code 0 for node --check.',
        },
        {
            id: 'drive',
            title: 'Confirm the page still renders',
            role: 'browser_operator',
            dependsOn: ['patch'],
            successCriteria: 'A screenshot of the rendered page is recorded.',
        },
        {
            id: 'verify',
            title: 'Run the independent final check',
            role: 'verifier',
            dependsOn: ['drive'],
            successCriteria: 'Every recorded evidence check passes.',
        },
    ];
}

/**
 * @param {unknown[]} nodes
 * @returns {string}
 */
function planTag(nodes) {
    return `<${GOAL_PLAN_TAG}>${JSON.stringify(nodes)}</${GOAL_PLAN_TAG}>`;
}

/**
 * @param {SubagentRouter} router
 * @param {unknown[]} [nodes]
 * @returns {ReturnType<typeof createGoalSession>}
 */
function routedSession(router, nodes = samplePlan()) {
    let session = router.createGoalSession({
        workflowId: 'wf-router-test',
        rootGoal: 'Ship the verified subagent router change.',
    });
    const planned = router.plan(planTag(nodes));
    assert.equal(planned.ok, true, planned.errors.join(' '));
    session = router.applyPlan(session, planned.nodes);
    return session;
}

/** Verified pc_coder evidence: command exit code 0 plus a real diff. */
const PC_EVIDENCE = {
    summary: 'Tests pass',
    command: 'npm test',
    exitCode: 0,
    changedFiles: ['orchestrator/subagent_router.js'],
    gitDiff: '+export const routed = true;\n-export const routed = false;',
    toolCalls: [{ name: 'pc_exec_shell', ok: true }],
};

/** Verified browser evidence: a real screenshot plus successful control actions. */
const BROWSER_EVIDENCE = {
    summary: 'Page renders',
    screenshot: { path: 'C:/Users/ncode/shots/page.png', bytes: 4096 },
    toolCalls: [
        { name: 'click', ok: true },
        { name: 'take_screenshot', ok: true },
    ],
};

/**
 * Drives the canonical DAG to completion with verifiable evidence.
 * @param {SubagentRouter} router
 * @returns {ReturnType<typeof createGoalSession>}
 */
function completeSampleSession(router) {
    let session = routedSession(router);
    let result = router.applySubgoalResult(session, {
        subgoalId: 'inspect',
        status: 'running',
    });
    assert.equal(result.accepted, true);
    result = router.applySubgoalResult(result.goalSession, {
        subgoalId: 'inspect',
        status: 'done',
        evidence: 'mapped the repository',
    });
    assert.equal(result.accepted, true, result.reasons.join(' '));
    result = router.applySubgoalResult(result.goalSession, {
        subgoalId: 'patch',
        status: 'done',
        evidence: PC_EVIDENCE,
    });
    assert.equal(result.accepted, true, result.reasons.join(' '));
    result = router.applySubgoalResult(result.goalSession, {
        subgoalId: 'drive',
        status: 'done',
        evidence: BROWSER_EVIDENCE,
    });
    assert.equal(result.accepted, true, result.reasons.join(' '));
    result = router.applySubgoalResult(result.goalSession, {
        subgoalId: 'verify',
        status: 'done',
        evidence: 'All evidence checks passed against the recorded diff and screenshot.',
    });
    assert.equal(result.accepted, true, result.reasons.join(' '));
    assert.equal(result.completionReady, true);
    session = result.goalSession;
    return session;
}

// ---------------------------------------------------------------------------
// Contract constants and role whitelists
// ---------------------------------------------------------------------------

await test('exports the four-role contract constants', () => {
    assert.deepEqual([...GOAL_ROLES], ['planner', 'pc_coder', 'browser_operator', 'verifier']);
    assert.deepEqual([...SUBGOAL_STATUSES], ['pending', 'running', 'done', 'failed']);
    assert.deepEqual([...GOAL_STATUSES], ['active', 'compacting', 'paused', 'completed', 'failed']);
    assert.equal(GOAL_PLAN_TAG, 'ncode_goal_plan');
    assert.equal(GOAL_UPDATE_TAG, 'ncode_goal_update');
    assert.equal(GOAL_COMPLETE_TAG, 'ncode_goal_complete');
    assert.equal(PREAMBLE_TAG, 'ncode_preamble');
    assert.equal(DEFAULT_MAX_ITERATIONS, 30);
    assert.equal(DEFAULT_MAX_ATTEMPTS, 3);
    assert.equal(MAX_PLAN_SUBGOALS, 24);
});

await test('pc_coder whitelist is the exact PC daemon tool contract', () => {
    assert.deepEqual(
        [...ROLE_TOOL_WHITELISTS.pc_coder],
        [
            'pc_exec_shell',
            'pc_bg_process',
            'pc_shell_session',
            'pc_fs_tree',
            'pc_fs_read',
            'pc_fs_write',
            'pc_fs_patch',
            'pc_search_code',
            'pc_git_status_diff',
            'pc_git_status',
            'pc_git_diff',
            'pc_git_add',
            'pc_git_commit',
            'pc_git_checkout',
            'pc_git_log',
            'pc_desktop_screenshot',
            'pc_clipboard',
        ]
    );
    assert.equal(PC_CODER_TOOL_NAMES.length, 17);
    assert.equal(PC_CODER_TOOL_NAMES.includes('pc_shell_session'), true);
    assert.equal(PC_CODER_TOOL_NAMES.includes('pc_git_checkout'), true);
    assert.equal(PC_CODER_TOOL_NAMES.includes('pc_git_log'), true);
    assert.equal(Object.isFrozen(ROLE_TOOL_WHITELISTS.pc_coder), true);
});

await test('browser_operator whitelist uses the exact control dispatcher tool names', () => {
    // Mirrors extension/background/control/dispatcher.js TOOL_METHOD_MAP keys.
    const dispatcherToolNames = [
        'navigate_page',
        'new_page',
        'close_page',
        'list_pages',
        'select_page',
        'click',
        'hover',
        'fill',
        'fill_form',
        'press_key',
        'type_text',
        'attach_file',
        'drag',
        'scroll',
        'take_snapshot',
        'wait_for',
        'handle_dialog',
        'evaluate_script',
        'take_screenshot',
        'wait_for_url',
        'wait_for_load_state',
        'wait_for_timeout',
        'list_downloads',
        'wait_for_download',
        'run_steps',
    ];
    assert.deepEqual([...BROWSER_TOOL_NAMES].sort(), [...dispatcherToolNames].sort());
    assert.deepEqual(
        [...ROLE_TOOL_WHITELISTS.browser_operator].sort(),
        [...dispatcherToolNames].sort()
    );
    for (const required of [
        'take_snapshot',
        'click',
        'fill',
        'evaluate_script',
        'take_screenshot',
    ]) {
        assert.equal(BROWSER_TOOL_NAMES.includes(required), true, required);
    }
});

await test('role prompts carry each role contract and the shared tags', () => {
    assert.deepEqual(Object.keys(ROLE_PROMPTS), [...GOAL_ROLES]);
    for (const role of GOAL_ROLES) {
        assert.ok(ROLE_PROMPTS[role].length > 200, `${role} prompt is substantive`);
    }
    includes(ROLE_PROMPTS.planner, `<${GOAL_PLAN_TAG}>`);
    includes(ROLE_PROMPTS.planner, 'dependsOn');
    includes(ROLE_PROMPTS.planner, 'acyclic');
    includes(ROLE_PROMPTS.pc_coder, 'pc_exec_shell');
    includes(ROLE_PROMPTS.pc_coder, 'exit code');
    includes(ROLE_PROMPTS.browser_operator, 'take_snapshot');
    includes(ROLE_PROMPTS.browser_operator, 'take_screenshot');
    includes(ROLE_PROMPTS.browser_operator, 'click');
    includes(ROLE_PROMPTS.verifier, 'exit code');
    includes(ROLE_PROMPTS.verifier, 'git diff');
    includes(ROLE_PROMPTS.verifier, 'screenshot');
    includes(ROLE_PROMPTS.verifier, `<${GOAL_COMPLETE_TAG}>true</${GOAL_COMPLETE_TAG}>`);
    assert.equal(Object.isFrozen(ROLE_PROMPTS), true);
});

await test('router registers the four roles and supports overrides', () => {
    const router = new SubagentRouter();
    assert.deepEqual(router.listRoles(), [...GOAL_ROLES]);
    assert.deepEqual([...router.getToolWhitelist('pc_coder')], [...PC_CODER_TOOL_NAMES]);

    assert.equal(router.registerRole('planner', { prompt: 'CUSTOM PLANNER CONTRACT' }), router);
    assert.equal(router.getRole('planner').prompt, 'CUSTOM PLANNER CONTRACT');
    assert.equal(router.getRole('planner').name, 'planner');

    router.registerRole('verifier', { tools: ['pc_git_diff'] });
    assert.deepEqual([...router.getToolWhitelist('verifier')], ['pc_git_diff']);

    assert.throws(() => router.getRole('hacker'), TypeError);
    assert.throws(() => router.registerRole('Bad Name', { prompt: 'x' }), TypeError);
    assert.throws(() => router.registerRole('planner', { prompt: '   ' }), TypeError);
    assert.throws(() => router.registerRole('planner', { tools: 'pc_fs_read' }), TypeError);
    assert.throws(() => new SubagentRouter({ maxAttempts: 0 }), TypeError);
});

// ---------------------------------------------------------------------------
// Planner plan parsing and recovery
// ---------------------------------------------------------------------------

await test('parses a tag-wrapped planner DAG', () => {
    const parsed = parseGoalPlan(`Working on the plan now.\n${planTag(samplePlan())}\nDone.`);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.source, 'tag');
    assert.equal(parsed.plan.length, 4);
    assert.equal(parsed.plan[1].dependsOn[0], 'inspect');
    assert.deepEqual(parsed.errors, []);
});

await test('recovers a fenced JSON plan from prose', () => {
    const parsed = parseGoalPlan(
        [
            'Here is the decomposition:',
            '```json',
            JSON.stringify(samplePlan()),
            '```',
            'Ready.',
        ].join('\n')
    );
    assert.equal(parsed.ok, true);
    assert.equal(parsed.source, 'fence');
    assert.equal(parsed.plan.length, 4);
});

await test('recovers a bare JSON array from prose', () => {
    const parsed = parseGoalPlan(`Sure: ${JSON.stringify(samplePlan())} — those are the steps.`);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.source, 'prose');
    assert.equal(parsed.plan[0].id, 'inspect');
});

await test('recovers HTML-escaped plan tags from Gemini Web markdown', () => {
    const escaped =
        '&lt;ncode_goal_plan&gt;' +
        JSON.stringify([{ id: 'inspect', title: 'Look around', role: 'planner' }]) +
        '&lt;/ncode_goal_plan&gt;';
    const parsed = parseGoalPlan(escaped);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.source, 'tag');
    assert.equal(parsed.plan.length, 1);
});

await test('tolerates prose brackets before the real plan array', () => {
    const parsed = parseGoalPlan(`Step [1] first, then the plan: ${JSON.stringify(samplePlan())}`);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.plan.length, 4);
});

await test('falls back to a fenced plan when the tag body is not JSON', () => {
    const parsed = parseGoalPlan(
        [
            `<${GOAL_PLAN_TAG}>I will think about it</${GOAL_PLAN_TAG}>`,
            '```json',
            JSON.stringify(samplePlan()),
            '```',
        ].join('\n')
    );
    assert.equal(parsed.ok, true);
    assert.equal(parsed.source, 'fence');
    assert.ok(parsed.warnings.length > 0);
});

await test('reports malformed plan JSON without throwing', () => {
    const malformed = parseGoalPlan(`<${GOAL_PLAN_TAG}>[{"id": "broken", },]</${GOAL_PLAN_TAG}>`);
    assert.equal(malformed.ok, false);
    assert.equal(malformed.plan, null);
    assert.equal(typeof malformed.errors[0], 'string');
    includes(malformed.errors.join(' '), 'No JSON array could be recovered');

    assert.doesNotThrow(() => parseGoalPlan(null));
    assert.doesNotThrow(() => parseGoalPlan(42));
    const empty = parseGoalPlan('   ');
    assert.equal(empty.ok, false);
    includes(empty.errors.join(' '), 'empty');
});

await test('router.plan returns a validated plan with ready roots and serialized tag', () => {
    const router = new SubagentRouter();
    const planned = router.plan(planTag(samplePlan()));
    assert.equal(planned.ok, true);
    assert.deepEqual(planned.errors, []);
    assert.deepEqual(planned.readyIds, ['inspect']);
    assert.deepEqual(planned.order, ['inspect', 'patch', 'drive', 'verify']);
    includes(planned.serialized, `<${GOAL_PLAN_TAG}>`);
    includes(planned.serialized, '</ncode_goal_plan>');
    const reparsed = router.plan(planned.serialized);
    assert.equal(reparsed.ok, true);
    assert.deepEqual(reparsed.order, planned.order);
});

await test('router.plan reports invalid plans instead of throwing', () => {
    const router = new SubagentRouter();
    const planned = router.plan(planTag([{ id: 'a', title: 'A', role: 'hacker' }]));
    assert.equal(planned.ok, false);
    assert.equal(planned.serialized, '');
    includes(planned.errors.join(' '), 'role must be one of');
});

// ---------------------------------------------------------------------------
// Plan validation and serialization
// ---------------------------------------------------------------------------

await test('validates a well-formed DAG and computes the topological order', () => {
    const validated = validateGoalPlan(samplePlan());
    assert.equal(validated.ok, true);
    assert.deepEqual(validated.order, ['inspect', 'patch', 'drive', 'verify']);
    assert.deepEqual(validated.nodes[1].dependsOn, ['inspect']);
    assert.deepEqual(validated.nodes[1].tools, [...PC_CODER_TOOL_NAMES]);
    assert.equal(validated.nodes[0].successCriteria.length > 0, true);
});

await test('rejects duplicate plan ids', () => {
    const validated = validateGoalPlan([
        { id: 'dup', title: 'One', role: 'planner' },
        { id: 'dup', title: 'Two', role: 'pc_coder' },
    ]);
    assert.equal(validated.ok, false);
    includes(validated.errors.join(' '), 'Duplicate subgoal id "dup"');
});

await test('rejects missing and invalid plan fields', () => {
    const missing = validateGoalPlan([{ id: '', title: '', role: '' }]);
    assert.equal(missing.ok, false);
    includes(missing.errors.join(' '), '.id must be a non-empty string');
    includes(missing.errors.join(' '), '.title must be a non-empty string');
    includes(missing.errors.join(' '), '.role must be a non-empty string');

    const badId = validateGoalPlan([{ id: 'has spaces', title: 'X', role: 'planner' }]);
    assert.equal(badId.ok, false);
    includes(badId.errors.join(' '), 'must be at most');

    const badRole = validateGoalPlan([{ id: 'x', title: 'X', role: 'copilot' }]);
    assert.equal(badRole.ok, false);
    includes(badRole.errors.join(' '), 'role must be one of');

    const empty = validateGoalPlan([]);
    assert.equal(empty.ok, false);
    includes(empty.errors.join(' '), 'at least one subgoal');
});

await test('rejects unknown, self-referencing and cyclic dependencies', () => {
    const unknown = validateGoalPlan([
        { id: 'a', title: 'A', role: 'planner', dependsOn: ['ghost'] },
    ]);
    assert.equal(unknown.ok, false);
    includes(unknown.errors.join(' '), 'depends on unknown subgoal "ghost"');

    const self = validateGoalPlan([{ id: 'a', title: 'A', role: 'planner', dependsOn: ['a'] }]);
    assert.equal(self.ok, false);
    includes(self.errors.join(' '), 'cannot depend on itself');

    const cycle = validateGoalPlan([
        { id: 'a', title: 'A', role: 'planner', dependsOn: ['c'] },
        { id: 'b', title: 'B', role: 'pc_coder', dependsOn: ['a'] },
        { id: 'c', title: 'C', role: 'verifier', dependsOn: ['b'] },
    ]);
    assert.equal(cycle.ok, false);
    includes(cycle.errors.join(' '), 'Dependency cycle detected among: a, b, c');
    assert.deepEqual(cycle.order, []);
});

await test('rejects invalid non-array plan input loudly', () => {
    assert.throws(() => validateGoalPlan('not-an-array'), TypeError);
    assert.throws(() => validateGoalPlan(null), TypeError);
    assert.throws(() => validateGoalPlan({ nodes: [] }), TypeError);
});

await test('rejects oversized plans', () => {
    const nodes = Array.from({ length: MAX_PLAN_SUBGOALS + 1 }, (_, index) => ({
        id: `step_${index}`,
        title: `Step ${index}`,
        role: 'planner',
    }));
    const validated = validateGoalPlan(nodes);
    assert.equal(validated.ok, false);
    includes(validated.errors.join(' '), `at most ${MAX_PLAN_SUBGOALS} subgoals`);
});

await test('drops out-of-role tools and defaults omitted tools to the whitelist', () => {
    const validated = validateGoalPlan([
        {
            id: 'patch',
            title: 'Patch a file',
            role: 'pc_coder',
            tools: ['pc_fs_read', 'take_screenshot', 'pc_fs_read'],
        },
        { id: 'look', title: 'Look at the page', role: 'browser_operator' },
    ]);
    assert.equal(validated.ok, true);
    assert.deepEqual(validated.nodes[0].tools, ['pc_fs_read']);
    assert.deepEqual(validated.nodes[1].tools, [...BROWSER_TOOL_NAMES]);
    includes(validated.warnings.join(' '), 'take_screenshot');
    includes(validated.warnings.join(' '), 'was dropped');
});

await test('serializes a validated plan into the exact tag contract', () => {
    const serialized = serializeGoalPlan(samplePlan());
    assert.ok(serialized.startsWith(`<${GOAL_PLAN_TAG}>`));
    assert.ok(serialized.endsWith(`</${GOAL_PLAN_TAG}>`));
    const json = serialized.slice(GOAL_PLAN_TAG.length + 2, -1 * (GOAL_PLAN_TAG.length + 3));
    const payload = JSON.parse(json);
    assert.deepEqual(
        payload.map((node) => node.id),
        ['inspect', 'patch', 'drive', 'verify']
    );
    assert.deepEqual(Object.keys(payload[0]), [
        'id',
        'title',
        'role',
        'dependsOn',
        'successCriteria',
        'tools',
    ]);
    const reparsed = parseGoalPlan(serialized);
    assert.equal(reparsed.ok, true);
    const revalidated = validateGoalPlan(reparsed.plan);
    assert.equal(revalidated.ok, true);
    assert.deepEqual(revalidated.order, ['inspect', 'patch', 'drive', 'verify']);
});

await test('refuses to serialize an invalid plan', () => {
    assert.throws(() => serializeGoalPlan([{ id: 'a', title: 'A', role: 'robot' }]), TypeError);
    assert.throws(() => serializeGoalPlan('nope'), TypeError);
});

// ---------------------------------------------------------------------------
// Session creation and DAG scheduling
// ---------------------------------------------------------------------------

await test('createGoalSession returns a fresh active session with the harness shape', () => {
    const session = new SubagentRouter().createGoalSession({
        workflowId: 'wf-create',
        rootGoal: 'Build the thing',
    });
    assert.deepEqual(Object.keys(session), [
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
    assert.equal(session.workflowId, 'wf-create');
    assert.equal(session.rootGoal, 'Build the thing');
    assert.deepEqual(session.subgoals, []);
    assert.equal(session.iterationCount, 0);
    assert.equal(session.maxIterations, DEFAULT_MAX_ITERATIONS);
    assert.equal(session.status, 'active');
    assert.equal(session.completionMarked, false);
    assert.ok(Number.isFinite(session.createdAt));
    assert.ok(Number.isFinite(session.updatedAt));
});

await test('createGoalSession validates input and accepts an initial plan', () => {
    assert.throws(() => createGoalSession({ rootGoal: 'no workflow' }), TypeError);
    assert.throws(() => createGoalSession({ workflowId: 'wf' }), TypeError);
    assert.throws(() => createGoalSession('nope'), TypeError);
    const session = createGoalSession({
        workflowId: 'wf-plan',
        rootGoal: 'Planned goal',
        maxIterations: 5,
        subgoals: samplePlan(),
    });
    assert.equal(session.maxIterations, 5);
    assert.deepEqual(
        session.subgoals.map((subgoal) => subgoal.id),
        ['inspect', 'patch', 'drive', 'verify']
    );
    assert.deepEqual(session.subgoals[1].dependsOn, ['inspect']);
    assert.equal(session.subgoals[1].status, 'pending');
});

await test('applyPlan attaches the DAG in topological order and preserves done work', () => {
    const router = new SubagentRouter();
    let session = router.createGoalSession({
        workflowId: 'wf-apply',
        rootGoal: 'Apply a plan',
    });
    session = router.applyPlan(session, router.plan(planTag(samplePlan())).nodes);
    assert.deepEqual(
        session.subgoals.map((subgoal) => subgoal.id),
        ['inspect', 'patch', 'drive', 'verify']
    );
    session = router.applySubgoalResult(session, {
        subgoalId: 'inspect',
        status: 'done',
        evidence: 'repo mapped',
    }).goalSession;
    assert.equal(session.subgoals[0].status, 'done');

    const replanned = router.applyPlan(session, samplePlan());
    assert.equal(replanned.subgoals[0].status, 'done');
    assert.equal(replanned.subgoals[0].evidence, session.subgoals[0].evidence);
    assert.equal(replanned.subgoals[1].status, 'pending');
    assert.throws(
        () => router.applyPlan(session, [{ id: 'a', title: 'A', role: 'hacker' }]),
        TypeError
    );
});

await test('listReadySubgoals exposes only roots whose dependencies are done', () => {
    const router = new SubagentRouter();
    const session = routedSession(router, [
        { id: 'a', title: 'A', role: 'planner', dependsOn: [] },
        { id: 'b', title: 'B', role: 'planner', dependsOn: [] },
        { id: 'c', title: 'C', role: 'pc_coder', dependsOn: ['a', 'b'] },
    ]);
    assert.deepEqual(
        listReadySubgoals(session).map((subgoal) => subgoal.id),
        ['a', 'b']
    );
    assert.equal(nextSubgoal(session).id, 'a');
});

await test('nextSubgoal follows ready-node order across the DAG', () => {
    const router = new SubagentRouter();
    let session = routedSession(router);
    const order = [];

    let next = nextSubgoal(session);
    while (next) {
        order.push(next.id);
        if (next.id === 'patch') {
            session = router.applySubgoalResult(session, {
                subgoalId: next.id,
                status: 'done',
                evidence: PC_EVIDENCE,
            }).goalSession;
        } else if (next.id === 'drive') {
            session = router.applySubgoalResult(session, {
                subgoalId: next.id,
                status: 'done',
                evidence: BROWSER_EVIDENCE,
            }).goalSession;
        } else {
            session = router.applySubgoalResult(session, {
                subgoalId: next.id,
                status: 'done',
                evidence: `completed ${next.id}`,
            }).goalSession;
        }
        next = nextSubgoal(session);
    }
    assert.deepEqual(order, ['inspect', 'patch', 'drive', 'verify']);
    assert.equal(nextSubgoal(session), null);
});

await test('nextSubgoal resumes an in-flight running subgoal before starting new work', () => {
    const router = new SubagentRouter();
    let session = routedSession(router, [
        { id: 'a', title: 'A', role: 'planner', dependsOn: [] },
        { id: 'b', title: 'B', role: 'planner', dependsOn: [] },
        { id: 'c', title: 'C', role: 'verifier', dependsOn: ['a', 'b'] },
    ]);
    session = router.applySubgoalResult(session, {
        subgoalId: 'a',
        status: 'done',
        evidence: 'a ok',
    }).goalSession;
    const started = router.applySubgoalResult(session, { subgoalId: 'b', status: 'running' });
    assert.equal(started.accepted, true);
    assert.equal(nextSubgoal(started.goalSession).id, 'b');
    assert.deepEqual(
        listReadySubgoals(started.goalSession),
        [],
        'a running step is not a ready pending step'
    );
});

await test('applySubgoalResult refuses to start a blocked dependent step', () => {
    const router = new SubagentRouter();
    const session = routedSession(router);
    const result = router.applySubgoalResult(session, { subgoalId: 'drive', status: 'running' });
    assert.equal(result.accepted, false);
    includes(result.reasons.join(' '), 'dependencies_not_done:patch');
    assert.equal(result.subgoal.status, 'pending');
});

await test('applySubgoalResult rejects unknown ids, invalid statuses and bad input', () => {
    const router = new SubagentRouter();
    const session = routedSession(router);
    assert.throws(
        () => router.applySubgoalResult(session, { subgoalId: 'ghost', status: 'done' }),
        TypeError
    );
    assert.throws(
        () => router.applySubgoalResult(session, { subgoalId: 'inspect', status: 'skipped' }),
        TypeError
    );
    assert.throws(() => router.applySubgoalResult(session, null), TypeError);
    assert.throws(() => router.applySubgoalResult(session, {}), TypeError);
});

await test('advanceIteration caps the loop and fails the session', () => {
    const router = new SubagentRouter();
    let session = router.createGoalSession({
        workflowId: 'wf-iter',
        rootGoal: 'Iterate',
        maxIterations: 2,
    });
    session = router.advanceIteration(session);
    assert.equal(session.iterationCount, 1);
    assert.equal(session.status, 'active');
    session = router.advanceIteration(session);
    assert.equal(session.iterationCount, 2);
    assert.equal(session.status, 'failed');
    assert.equal(session.failureReason, 'max_iterations_reached');
});

// ---------------------------------------------------------------------------
// Retries and failure handling
// ---------------------------------------------------------------------------

await test('verifier refusal retries a subgoal and fails it after max attempts', () => {
    const router = new SubagentRouter({ maxAttempts: 2 });
    let session = routedSession(router);
    session = router.applySubgoalResult(session, {
        subgoalId: 'inspect',
        status: 'done',
        evidence: 'repo mapped',
    }).goalSession;

    const first = router.applySubgoalResult(session, {
        subgoalId: 'patch',
        status: 'done',
        evidence: 'I patched it, trust me',
    });
    assert.equal(first.accepted, false);
    assert.equal(first.retrying, true);
    assert.equal(first.exhausted, false);
    assert.equal(first.subgoal.status, 'pending');
    assert.equal(first.subgoal.attempts, 1);
    includes(first.reasons.join(' '), 'unstructured_pc_evidence');
    includes(first.subgoal.lastError, 'unstructured_pc_evidence');

    const second = router.applySubgoalResult(first.goalSession, {
        subgoalId: 'patch',
        status: 'done',
        evidence: 'Still trust me',
    });
    assert.equal(second.accepted, false);
    assert.equal(second.retrying, false);
    assert.equal(second.exhausted, true);
    assert.equal(second.subgoal.status, 'failed');
    assert.equal(second.subgoal.attempts, 2);
    assert.equal(second.goalSession.status, 'failed');
    assert.equal(second.goalSession.failureReason, 'blocked_by_failed_subgoals');
});

await test('a reported failure retries while attempts remain and then stalls the goal', () => {
    const router = new SubagentRouter({ maxAttempts: 2 });
    const session = routedSession(router);
    const first = router.applySubgoalResult(session, {
        subgoalId: 'inspect',
        status: 'failed',
        evidence: { summary: 'pc_fs_tree is unavailable' },
    });
    assert.equal(first.accepted, true);
    assert.equal(first.retrying, true);
    assert.equal(first.exhausted, false);
    assert.equal(first.subgoal.status, 'pending');
    assert.deepEqual(first.reasons, ['retry_scheduled']);
    assert.equal(first.goalSession.status, 'active');

    const second = router.applySubgoalResult(first.goalSession, {
        subgoalId: 'inspect',
        status: 'failed',
        evidence: { summary: 'pc_fs_tree is still unavailable' },
    });
    assert.equal(second.retrying, false);
    assert.equal(second.exhausted, true);
    assert.equal(second.subgoal.status, 'failed');
    assert.deepEqual(second.reasons, ['max_attempts_reached']);
    assert.equal(second.goalSession.status, 'failed');
    assert.equal(second.goalSession.failureReason, 'blocked_by_failed_subgoals');
});

await test('a transient failure keeps the goal active while other work can run', () => {
    const router = new SubagentRouter({ maxAttempts: 2 });
    const session = routedSession(router, [
        { id: 'a', title: 'A', role: 'planner', dependsOn: [] },
        { id: 'b', title: 'B', role: 'pc_coder', dependsOn: [] },
    ]);
    const failed = router.applySubgoalResult(session, {
        subgoalId: 'a',
        status: 'failed',
        evidence: { summary: 'temporary error' },
    });
    assert.equal(failed.goalSession.status, 'active');
    assert.deepEqual(
        listReadySubgoals(failed.goalSession).map((subgoal) => subgoal.id),
        ['a', 'b'],
        'the retried step and the untouched root are both ready'
    );
    assert.equal(nextSubgoal(failed.goalSession).id, 'a', 'the retry keeps its schedule slot');
});

// ---------------------------------------------------------------------------
// Verifier evidence gate
// ---------------------------------------------------------------------------

await test('verifier refuses missing evidence', () => {
    for (const evidence of [null, undefined, '', {}, { summary: '   ' }]) {
        const result = verifySubgoalCompletion({ role: 'pc_coder' }, evidence);
        assert.equal(result.verified, false);
        includes(result.reasons.join(' '), 'missing_evidence');
    }
    assert.deepEqual(verifySubgoalCompletion(null, PC_EVIDENCE).reasons, ['missing_subgoal']);
});

await test('verifier refuses non-zero, missing and invalid terminal exit codes', () => {
    const nonZero = verifySubgoalCompletion(
        { role: 'pc_coder' },
        { command: 'npm test', exitCode: 1, summary: 'tests failed' }
    );
    assert.equal(nonZero.verified, false);
    includes(nonZero.reasons.join(' '), 'terminal_exit_code_non_zero:1');

    const missing = verifySubgoalCompletion(
        { role: 'pc_coder' },
        { command: 'npm test', summary: 'tests ran' }
    );
    assert.equal(missing.verified, false);
    includes(missing.reasons.join(' '), 'terminal_exit_code_missing');

    const invalid = verifySubgoalCompletion(
        { role: 'pc_coder' },
        { command: 'npm test', exitCode: 'ENOENT' }
    );
    assert.equal(invalid.verified, false);
    includes(invalid.reasons.join(' '), 'terminal_exit_code_invalid');
});

await test('verifier refuses changed files without a git diff', () => {
    const result = verifySubgoalCompletion(
        { role: 'pc_coder' },
        { summary: 'patched files', changedFiles: ['a.js', 'b.js'], gitDiff: '   ' }
    );
    assert.equal(result.verified, false);
    includes(result.reasons.join(' '), 'git_diff_missing');
});

await test('verifier refuses browser steps without a screenshot', () => {
    const browserStep = verifySubgoalCompletion(
        { role: 'pc_coder' },
        { summary: 'clicked the button', toolCalls: [{ name: 'click', ok: true }] }
    );
    assert.equal(browserStep.verified, false);
    includes(browserStep.reasons.join(' '), 'browser_screenshot_missing');

    const browserRole = verifySubgoalCompletion(
        { role: 'browser_operator' },
        { summary: 'opened the page', toolCalls: [{ name: 'click', ok: true }] }
    );
    assert.equal(browserRole.verified, false);
    includes(browserRole.reasons.join(' '), 'browser_screenshot_missing');
});

await test('verifier refuses narrative-only pc_coder claims', () => {
    const narrative = verifySubgoalCompletion(
        { role: 'pc_coder' },
        'I definitely changed the files and everything works'
    );
    assert.equal(narrative.verified, false);
    includes(narrative.reasons.join(' '), 'unstructured_pc_evidence');

    const plannerNarrative = verifySubgoalCompletion(
        { role: 'planner' },
        'Repository mapped and constraints listed.'
    );
    assert.equal(plannerNarrative.verified, true);

    const verifierNarrative = verifySubgoalCompletion(
        { role: 'verifier' },
        'All five checks passed against the recorded diff.'
    );
    assert.equal(verifierNarrative.verified, true);
});

await test('verifier refuses failed tool calls', () => {
    const result = verifySubgoalCompletion(
        { role: 'pc_coder' },
        { summary: 'ran tools', toolCalls: [{ name: 'pc_exec_shell', ok: false }] }
    );
    assert.equal(result.verified, false);
    includes(result.reasons.join(' '), 'tool_call_failed:pc_exec_shell');
});

await test('verifier accepts structured pc_coder and browser evidence', () => {
    assert.deepEqual(verifySubgoalCompletion({ role: 'pc_coder' }, PC_EVIDENCE), {
        verified: true,
        reasons: [],
    });
    assert.deepEqual(verifySubgoalCompletion({ role: 'browser_operator' }, BROWSER_EVIDENCE), {
        verified: true,
        reasons: [],
    });
    assert.deepEqual(
        verifySubgoalCompletion(
            { role: 'pc_coder' },
            { summary: 'wrote the file', changedFiles: ['a.js'], gitDiff: '+a' }
        ),
        { verified: true, reasons: [] }
    );
    const jsonString = verifySubgoalCompletion({ role: 'pc_coder' }, JSON.stringify(PC_EVIDENCE));
    assert.equal(jsonString.verified, true);
    const nestedScreenshot = verifySubgoalCompletion(
        { role: 'browser_operator' },
        { summary: 'page live', survey: true, screenshot: { dataUrl: 'data:image/png;base64,AAA' } }
    );
    assert.equal(nestedScreenshot.verified, true);
});

await test('verifier trusts evidence already recorded as verified', () => {
    const result = verifySubgoalCompletion(
        { role: 'pc_coder' },
        '\u2713 Tests pass \u00b7 command=npm test \u00b7 exit=0'
    );
    assert.deepEqual(result, { verified: true, reasons: [] });
});

await test('hasGoalCompletionTag recovers the explicit completion signal', () => {
    assert.equal(
        hasGoalCompletionTag(`Done.\n<${GOAL_COMPLETE_TAG}>true</${GOAL_COMPLETE_TAG}>`),
        true
    );
    assert.equal(hasGoalCompletionTag(`<${GOAL_COMPLETE_TAG}> yes </${GOAL_COMPLETE_TAG}>`), true);
    assert.equal(
        hasGoalCompletionTag('&lt;ncode_goal_complete&gt;true&lt;/ncode_goal_complete&gt;'),
        true
    );
    assert.equal(hasGoalCompletionTag(`<${GOAL_COMPLETE_TAG}>false</${GOAL_COMPLETE_TAG}>`), false);
    assert.equal(hasGoalCompletionTag('Everything is done, honest.'), false);
    assert.equal(hasGoalCompletionTag(null), false);
});

// ---------------------------------------------------------------------------
// Completion gate
// ---------------------------------------------------------------------------

await test('completion gate refuses a session with pending subgoals', () => {
    const router = new SubagentRouter();
    const session = routedSession(router);
    const gate = router.completionGate(session, { complete: true });
    assert.equal(gate.allowed, false);
    includes(gate.reasons.join(' '), 'subgoals_not_done:inspect:pending');
    assert.equal(gate.completionTag, '');
});

await test('completion gate refuses an all-done session without the explicit tag', () => {
    const router = new SubagentRouter();
    const session = completeSampleSession(router);
    const gate = router.completionGate(session);
    assert.equal(gate.allowed, false);
    assert.deepEqual(gate.reasons, ['missing_completion_tag']);

    const withText = router.completionGate(session, { modelText: 'All done!' });
    assert.equal(withText.allowed, false);
    includes(withText.reasons.join(' '), 'missing_completion_tag');
});

await test('completion gate refuses unverified evidence restored from a snapshot', () => {
    const session = hydrateState({
        workflowId: 'wf-restored',
        rootGoal: 'Restore and finish',
        subgoals: [
            { id: 'step', title: 'Old step', role: 'pc_coder', status: 'done', evidence: 'done' },
            {
                id: 'check',
                title: 'Verify',
                role: 'verifier',
                status: 'done',
                evidence: 'looks fine',
            },
        ],
        iterationCount: 3,
        maxIterations: 30,
        status: 'active',
        completionMarked: false,
        createdAt: 1,
        updatedAt: 2,
    });
    const gate = completionGate(session, { complete: true });
    assert.equal(gate.allowed, false);
    includes(gate.reasons.join(' '), 'unverified_evidence:step');
});

await test('completion gate refuses an empty plan', () => {
    const router = new SubagentRouter();
    const session = router.createGoalSession({ workflowId: 'wf-empty', rootGoal: 'Nothing' });
    const gate = router.completionGate(session, { complete: true });
    assert.equal(gate.allowed, false);
    includes(gate.reasons.join(' '), 'no_subgoals_planned');
});

await test('completion gate allows a verified all-done session with the tag', () => {
    const router = new SubagentRouter();
    const session = completeSampleSession(router);
    const gate = router.completionGate(session, {
        modelText: `Finished.\n<${GOAL_COMPLETE_TAG}>true</${GOAL_COMPLETE_TAG}>`,
    });
    assert.equal(gate.allowed, true);
    assert.deepEqual(gate.reasons, []);
    assert.equal(gate.completionTag, `<${GOAL_COMPLETE_TAG}>true</${GOAL_COMPLETE_TAG}>`);

    const relaxed = router.completionGate(session, { requireExplicitCompletion: false });
    assert.equal(relaxed.allowed, true);
});

await test('markGoalComplete only marks complete when the gate allows it', () => {
    const router = new SubagentRouter();
    const session = routedSession(router);
    const refused = router.markGoalComplete(session, { complete: true });
    assert.equal(refused.allowed, false);
    assert.equal(refused.goalSession.status, 'active');
    assert.equal(refused.goalSession.completionMarked, false);

    const finished = completeSampleSession(router);
    const marked = router.markGoalComplete(finished, { complete: true });
    assert.equal(marked.allowed, true);
    assert.equal(marked.goalSession.status, 'completed');
    assert.equal(marked.goalSession.completionMarked, true);
    assert.equal(marked.completionTag, `<${GOAL_COMPLETE_TAG}>true</${GOAL_COMPLETE_TAG}>`);
    assert.ok(marked.goalSession.updatedAt >= finished.updatedAt);

    const idempotent = router.completionGate(marked.goalSession);
    assert.deepEqual(idempotent, {
        allowed: true,
        reasons: [],
        completionTag: `<${GOAL_COMPLETE_TAG}>true</${GOAL_COMPLETE_TAG}>`,
    });
});

// ---------------------------------------------------------------------------
// Harness snapshot and serialization round-trips
// ---------------------------------------------------------------------------

await test('toHarnessSnapshot matches the NcodeHarnessBar goal-session contract exactly', () => {
    const router = new SubagentRouter();
    const session = completeSampleSession(router);
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
    assert.deepEqual(
        snapshot.subgoals.map((subgoal) => subgoal.id),
        ['inspect', 'patch', 'drive', 'verify']
    );
    assert.deepEqual(
        snapshot.subgoals.map((subgoal) => subgoal.role),
        ['planner', 'pc_coder', 'browser_operator', 'verifier']
    );
    assert.deepEqual(
        snapshot.subgoals.map((subgoal) => subgoal.status),
        ['done', 'done', 'done', 'done']
    );
    assert.equal(snapshot.workflowId, 'wf-router-test');
    assert.equal(snapshot.rootGoal, 'Ship the verified subagent router change.');
    assert.equal(snapshot.maxIterations, DEFAULT_MAX_ITERATIONS);
    assert.equal(snapshot.completionMarked, false);
    assert.equal(
        snapshot.subgoals[1].evidence,
        '\u2713 Tests pass \u00b7 command=npm test \u00b7 exit=0 \u00b7 files=1 \u00b7 diff=present \u00b7 tools=pc_exec_shell:ok'
    );
    assert.equal(
        snapshot.subgoals[2].evidence,
        '\u2713 Page renders \u00b7 screenshot=present \u00b7 tools=click:ok,take_screenshot:ok \u00b7 browser=yes'
    );
});

await test('toHarnessSnapshot is accepted by the goal-state machine normalizer', () => {
    const router = new SubagentRouter();
    const session = completeSampleSession(router);
    const snapshot = router.toHarnessSnapshot(session);
    const normalized = normalizeGoalSession(snapshot);
    assert.deepEqual(normalized, snapshot);
    assert.equal(normalized.subgoals.length, 4);
    assert.equal(
        normalized.subgoals.every((subgoal) => typeof subgoal.evidence === 'string'),
        true
    );
});

await test('serializeState keeps full routing fidelity and round-trips through JSON', () => {
    const router = new SubagentRouter();
    let session = routedSession(router);
    session = router.applySubgoalResult(session, {
        subgoalId: 'inspect',
        status: 'done',
        evidence: 'repo mapped',
    }).goalSession;
    session = router.applySubgoalResult(session, {
        subgoalId: 'patch',
        status: 'done',
        evidence: 'trust me',
    }).goalSession;

    const serialized = serializeState(session);
    assert.equal(serialized.version, 1);
    assert.equal(serialized.workflowId, 'wf-router-test');
    assert.deepEqual(serialized.subgoals[1].dependsOn, ['inspect']);
    assert.equal(serialized.subgoals[1].attempts, 1);
    includes(serialized.subgoals[1].lastError, 'unstructured_pc_evidence');
    assert.deepEqual(serialized.subgoals[1].tools, [...PC_CODER_TOOL_NAMES]);
    assert.doesNotThrow(() => JSON.stringify(serialized));

    const restored = hydrateState(JSON.parse(JSON.stringify(serialized)));
    assert.deepEqual(restored, session);
    assert.deepEqual(nextSubgoal(restored).id, 'patch', 'restored loop resumes the retry');
});

await test('hydrateState rebuilds a schedulable session from the narrow snapshot', () => {
    const router = new SubagentRouter();
    const session = completeSampleSession(router);
    const snapshot = JSON.parse(JSON.stringify(router.toHarnessSnapshot(session)));
    const restored = hydrateState(snapshot);
    assert.equal(restored.subgoals.length, 4);
    assert.deepEqual(restored.subgoals[0].dependsOn, []);
    assert.equal(restored.subgoals[0].attempts, 0);
    assert.equal(restored.subgoals[0].lastError, '');
    assert.deepEqual(restored.subgoals[1].tools, [...PC_CODER_TOOL_NAMES]);
    assert.deepEqual(
        restored.subgoals.map((subgoal) => subgoal.status),
        ['done', 'done', 'done', 'done']
    );
    const gate = completionGate(restored, { complete: true });
    assert.equal(gate.allowed, true, 'verified evidence survives the narrow snapshot');
});

await test('hydrateState validates structural session data', () => {
    assert.throws(() => hydrateState(null), TypeError);
    assert.throws(() => hydrateState({ workflowId: 'wf' }), TypeError);
    assert.throws(
        () => hydrateState({ workflowId: 'wf', rootGoal: 'x', subgoals: 'nope' }),
        TypeError
    );
    assert.throws(
        () =>
            hydrateState({
                workflowId: 'wf',
                rootGoal: 'x',
                subgoals: [{ id: 'a', title: 'A', role: 'hacker' }],
            }),
        TypeError
    );
    assert.throws(
        () =>
            hydrateState({
                workflowId: 'wf',
                rootGoal: 'x',
                subgoals: [
                    { id: 'a', title: 'A', role: 'planner' },
                    { id: 'a', title: 'B', role: 'verifier' },
                ],
            }),
        TypeError
    );
    assert.throws(
        () =>
            hydrateState({
                workflowId: 'wf',
                rootGoal: 'x',
                subgoals: [{ id: 'a', title: 'A', role: 'planner', dependsOn: ['ghost'] }],
            }),
        TypeError
    );
    assert.throws(
        () =>
            hydrateState({
                workflowId: 'wf',
                rootGoal: 'x',
                subgoals: [
                    { id: 'a', title: 'A', role: 'planner', dependsOn: ['b'] },
                    { id: 'b', title: 'B', role: 'verifier', dependsOn: ['a'] },
                ],
            }),
        TypeError
    );
    assert.throws(
        () =>
            hydrateState({
                workflowId: 'wf',
                rootGoal: 'x',
                subgoals: [{ id: 'a', title: 'A', role: 'planner', status: 'sleeping' }],
            }),
        TypeError
    );
});

await test('hydrateState accepts a goal-state-machine default checklist', () => {
    const session = hydrateState({
        workflowId: 'wf-state-machine',
        rootGoal: 'Continue the goal loop',
        subgoals: [
            {
                id: 'plan',
                title: 'Plan the approach',
                role: 'planner',
                status: 'done',
                evidence: 'plan ok',
            },
            {
                id: 'execute',
                title: 'Execute the plan',
                role: 'pc_coder',
                status: 'running',
                evidence: '',
            },
            {
                id: 'verify',
                title: 'Verify the result',
                role: 'verifier',
                status: 'pending',
                evidence: '',
            },
        ],
        iterationCount: 2,
        maxIterations: 30,
        status: 'compacting',
        completionMarked: false,
        createdAt: 10,
        updatedAt: 20,
    });
    assert.equal(session.status, 'compacting');
    assert.equal(nextSubgoal(session).id, 'execute');
    assert.deepEqual(
        listReadySubgoals(session).map((subgoal) => subgoal.id),
        ['verify'],
        'dependency-free restored steps stay schedulable in stored order'
    );
});

// ---------------------------------------------------------------------------
// Model-facing prompts
// ---------------------------------------------------------------------------

await test('continuation prompt carries goal, DAG, role, tools, evidence and tags', () => {
    const router = new SubagentRouter();
    const session = routedSession(router);
    const prompt = router.buildContinuationPrompt(session);
    includes(prompt, 'Ship the verified subagent router change.');
    includes(prompt, 'wf-router-test');
    includes(prompt, 'iteration: 0 of 30');
    includes(prompt, 'inspect [planner/pending]');
    includes(prompt, 'Work on subgoal inspect');
    includes(prompt, ROLE_PROMPTS.planner);
    includes(prompt, 'pc_fs_read');
    includes(prompt, 'Evidence contract');
    includes(prompt, `<${PREAMBLE_TAG}>`);
    includes(prompt, `<${GOAL_UPDATE_TAG}>`);
    includes(prompt, `<${GOAL_COMPLETE_TAG}>true</${GOAL_COMPLETE_TAG}>`);
    includes(prompt, 'Never mark a subgoal done without the evidence');
});

await test('continuation prompt for an unplanned session asks the planner for a DAG', () => {
    const router = new SubagentRouter();
    const session = router.createGoalSession({ workflowId: 'wf-plan-prompt', rootGoal: 'Plan me' });
    const prompt = router.buildContinuationPrompt(session);
    includes(prompt, 'No subgoal plan exists yet');
    includes(prompt, `<${GOAL_PLAN_TAG}>`);
    includes(prompt, ROLE_PROMPTS.planner);
});

await test('plan prompt documents the tag schema and planner role limits', () => {
    const router = new SubagentRouter();
    const session = router.createGoalSession({ workflowId: 'wf-plan', rootGoal: 'Decompose me' });
    const prompt = router.buildPlanPrompt(session);
    includes(prompt, 'Decompose me');
    includes(prompt, ROLE_PROMPTS.planner);
    includes(prompt, `<${GOAL_PLAN_TAG}>`);
    includes(prompt, '"dependsOn"');
    includes(prompt, '"successCriteria"');
    includes(prompt, 'pc_fs_read');
    includes(prompt, 'do not emit the completion tag');
});

await test('verifier prompt includes the target subgoal, criteria and gate rules', () => {
    const router = new SubagentRouter();
    const session = routedSession(router);
    const prompt = router.buildVerifierPrompt(session, 'patch');
    includes(prompt, ROLE_PROMPTS.verifier);
    includes(prompt, 'Patch the subagent router');
    includes(prompt, 'pc_exec_shell reports exit code 0 for node --check.');
    includes(prompt, 'exit code');
    includes(prompt, 'git diff');
    includes(prompt, 'screenshot');
    includes(prompt, '"subgoalId":"patch"');
    includes(prompt, `<${GOAL_COMPLETE_TAG}>true</${GOAL_COMPLETE_TAG}>`);

    const byObject = router.buildVerifierPrompt(session, session.subgoals[2]);
    includes(byObject, 'Confirm the page still renders');
    assert.throws(() => router.buildVerifierPrompt(session, 'ghost'), TypeError);
    assert.throws(() => router.buildVerifierPrompt(session, null), TypeError);
});

await test('buildRolePrompt renders the role fragment and its tool whitelist', () => {
    const router = new SubagentRouter();
    const prompt = router.buildRolePrompt('pc_coder');
    includes(prompt, ROLE_PROMPTS.pc_coder);
    includes(prompt, 'pc_exec_shell');
    includes(prompt, 'pc_git_commit');
    includes(buildRolePrompt('browser_operator'), 'take_screenshot');
    assert.throws(() => buildRolePrompt('hacker'), TypeError);
});

await test('a registered role override is used by plans and prompts', () => {
    const router = new SubagentRouter();
    router.registerRole('planner', {
        prompt: 'CUSTOM PLANNER CONTRACT: inspect, then decompose.',
        tools: ['pc_fs_read'],
    });
    const planned = router.plan(
        planTag([{ id: 'inspect', title: 'Inspect', role: 'planner', tools: ['pc_fs_read'] }])
    );
    assert.equal(planned.ok, true);
    const session = router.applyPlan(
        router.createGoalSession({ workflowId: 'wf-custom', rootGoal: 'Custom roles' }),
        planned.nodes
    );
    includes(router.buildPlanPrompt(session), 'CUSTOM PLANNER CONTRACT');
    includes(router.buildContinuationPrompt(session), 'CUSTOM PLANNER CONTRACT');
    assert.deepEqual([...router.getToolWhitelist('planner')], ['pc_fs_read']);
    assert.equal(
        router.plan(
            planTag([{ id: 'inspect', title: 'Inspect', role: 'planner', tools: ['pc_fs_tree'] }])
        ).nodes[0].tools.length,
        0,
        'custom whitelist is enforced during validation'
    );
});

// ---------------------------------------------------------------------------
// Orchestrator source and extension mirror sync
// ---------------------------------------------------------------------------

await test('extension mirror is byte-identical to the orchestrator source', async () => {
    const [sourceBytes, mirrorBytes] = await Promise.all([
        readFile(ROUTER_SOURCE_PATH),
        readFile(ROUTER_MIRROR_PATH),
    ]);
    assert.ok(sourceBytes.length > 10000, 'the router source is substantive');
    assert.equal(sourceBytes.length, mirrorBytes.length);
    assert.equal(
        createHash('sha256').update(sourceBytes).digest('hex'),
        createHash('sha256').update(mirrorBytes).digest('hex')
    );
    assert.equal(sourceBytes.equals(mirrorBytes), true);
});

await test('extension mirror loads as ESM and exports the same API', async () => {
    const mirror = await import(pathToFileURL(ROUTER_MIRROR_PATH).href);
    const source = await import(pathToFileURL(ROUTER_SOURCE_PATH).href);
    assert.deepEqual(Object.keys(mirror).sort(), Object.keys(source).sort());
    const router = new mirror.SubagentRouter();
    const planned = router.plan(planTag(samplePlan()));
    assert.equal(planned.ok, true);
    assert.deepEqual(planned.order, ['inspect', 'patch', 'drive', 'verify']);
    assert.equal(mirror.ROLE_TOOL_WHITELISTS.pc_coder.length, 17);
});

/**
 * @param {string} filePath
 * @returns {string}
 */
function pathToFileUrl(filePath) {
    return pathToFileURL(filePath).href;
}

// Summary

if (failures.length > 0) {
    console.error(`\n${failures.length} subagent router check(s) failed, ${passed} passed.`);
    process.exitCode = 1;
} else {
    console.log(`\nAll ${passed} subagent router checks passed.`);
}
