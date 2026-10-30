import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
    BROWSER_TOOL_NAMES,
    GOAL_PLAN_TAG,
    PC_CODER_TOOL_NAMES,
    ROLE_PROMPTS,
    ROLE_TOOL_WHITELISTS,
    SubagentRouter,
    completionGate,
    hydrateState,
    serializeGoalPlan,
    serializeState,
    toHarnessSnapshot,
    verifySubgoalCompletion,
} from './subagent_router.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const mirrorPath = path.join(here, 'subagent_router.js');
const sourcePath = path.resolve(here, '../../../orchestrator/subagent_router.js');

const PLAN = [
    { id: 'inspect', title: 'Inspect the repo', role: 'planner', dependsOn: [] },
    {
        id: 'patch',
        title: 'Patch the module',
        role: 'pc_coder',
        dependsOn: ['inspect'],
        successCriteria: 'npm test exits 0',
    },
    { id: 'verify', title: 'Independent check', role: 'verifier', dependsOn: ['patch'] },
];

const PC_EVIDENCE = {
    summary: 'Tests pass',
    command: 'npm test',
    exitCode: 0,
    changedFiles: ['shared/orchestrator/subagent_router.js'],
    gitDiff: '+routed',
};

function planTag(nodes) {
    return `<${GOAL_PLAN_TAG}>${JSON.stringify(nodes)}</${GOAL_PLAN_TAG}>`;
}

describe('subagent_router mirror sync', () => {
    it('is byte-identical with the orchestrator source of truth', () => {
        const mirror = readFileSync(mirrorPath);
        const source = readFileSync(sourcePath);
        expect(mirror.length).toBe(source.length);
        expect(mirror.length).toBeGreaterThan(10000);
        expect(mirror.equals(source)).toBe(true);
    });

    it('keeps the four role contracts in the mirrored copy', () => {
        expect(Object.keys(ROLE_PROMPTS)).toEqual([
            'planner',
            'pc_coder',
            'browser_operator',
            'verifier',
        ]);
        expect([...ROLE_TOOL_WHITELISTS.pc_coder]).toEqual([...PC_CODER_TOOL_NAMES]);
        expect(PC_CODER_TOOL_NAMES).toHaveLength(17);
        expect(PC_CODER_TOOL_NAMES).toContain('pc_shell_session');
        expect(BROWSER_TOOL_NAMES).toContain('take_snapshot');
        expect(BROWSER_TOOL_NAMES).toContain('take_screenshot');
        expect(ROLE_PROMPTS.planner).toContain(GOAL_PLAN_TAG);
    });

    it('parses, schedules and verifies a DAG through the mirrored module', () => {
        const router = new SubagentRouter();
        let session = router.createGoalSession({
            workflowId: 'wf-mirror',
            rootGoal: 'Mirror the router',
        });
        const planned = router.plan(planTag(PLAN));
        expect(planned.ok).toBe(true);
        expect(planned.order).toEqual(['inspect', 'patch', 'verify']);
        expect(serializeGoalPlan(PLAN)).toBe(planned.serialized);
        session = router.applyPlan(session, planned.nodes);

        expect(router.nextSubgoal(session).id).toBe('inspect');
        session = router.applySubgoalResult(session, {
            subgoalId: 'inspect',
            status: 'done',
            evidence: 'repo mapped',
        }).goalSession;
        session = router.applySubgoalResult(session, {
            subgoalId: 'patch',
            status: 'done',
            evidence: PC_EVIDENCE,
        }).goalSession;
        expect(router.nextSubgoal(session).id).toBe('verify');
        session = router.applySubgoalResult(session, {
            subgoalId: 'verify',
            status: 'done',
            evidence: 'checks passed against the recorded diff',
        }).goalSession;

        const snapshot = toHarnessSnapshot(session);
        expect(Object.keys(snapshot)).toEqual([
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
        expect(Object.keys(snapshot.subgoals[0])).toEqual([
            'id',
            'title',
            'role',
            'status',
            'evidence',
        ]);

        const refused = completionGate(snapshot, { complete: true });
        expect(refused.allowed).toBe(true);
        const restored = hydrateState(serializeState(session));
        expect(toHarnessSnapshot(restored)).toEqual(snapshot);
        expect(verifySubgoalCompletion({ role: 'pc_coder' }, {}).verified).toBe(false);
    });
});
