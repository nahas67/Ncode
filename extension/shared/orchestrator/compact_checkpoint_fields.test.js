import { describe, expect, it } from 'vitest';

import {
    buildResumeHydrationPrompt,
    createCheckpoint,
    parseCompactionSummary,
} from './compact_resume_engine.js';

const GOAL_SESSION = {
    workflowId: 'wf-fields',
    rootGoal: 'Ship the Ncode harness',
    status: 'active',
    iterationCount: 3,
    maxIterations: 30,
    completionMarked: false,
    subgoals: [
        { id: 'plan', title: 'Plan the work', role: 'planner', status: 'done' },
        { id: 'code', title: 'Implement the daemon tools', role: 'pc_coder', status: 'running' },
        { id: 'verify', title: 'Verify in Chrome', role: 'verifier', status: 'pending' },
    ],
};

describe('Ncode checkpoint structured state', () => {
    it('carries the six canonical Compact & Resume fields', () => {
        const summary = parseCompactionSummary(
            [
                '```json',
                JSON.stringify({
                    completedSubgoals: ['plan'],
                    modifiedFilesAndCommands: [
                        'pc-daemon/server.mjs — added stateful shell',
                        'npm --prefix extension test (passed)',
                    ],
                    discoveredFactsAndErrors: ['Node 24 is required'],
                    nextImmediateAction: 'Run the git verifier subgoal.',
                }),
                '```',
            ].join('\n')
        );

        const checkpoint = createCheckpoint({
            workflowId: 'wf-fields',
            goalSession: GOAL_SESSION,
            summary,
            prunedChars: 5000,
            currentCwd: 'C:\\Users\\example\\project',
        });

        expect(checkpoint.completedSubgoals).toEqual(['plan']);
        expect(checkpoint.pendingSubgoals).toEqual([
            'code: Implement the daemon tools',
            'verify: Verify in Chrome',
        ]);
        expect(checkpoint.modifiedFiles).toEqual(['pc-daemon/server.mjs']);
        expect(checkpoint.currentCwd).toBe('C:\\Users\\example\\project');
        expect(checkpoint.keyFindings).toEqual(['Node 24 is required']);
        expect(checkpoint.nextStep).toBe('Run the git verifier subgoal.');

        // Legacy aliases stay intact for older consumers.
        expect(checkpoint.nextImmediateAction).toBe('Run the git verifier subgoal.');
        expect(checkpoint.discoveredFactsAndErrors).toEqual(['Node 24 is required']);
    });

    it('renders every canonical field in the resume hydration prompt', () => {
        const checkpoint = createCheckpoint({
            workflowId: 'wf-fields',
            goalSession: GOAL_SESSION,
            summary: parseCompactionSummary(
                JSON.stringify({
                    completedSubgoals: ['plan'],
                    modifiedFilesAndCommands: ['extension/manifest.json — host permissions'],
                    discoveredFactsAndErrors: ['Daemon listens on 3001'],
                    nextImmediateAction: 'Open the sidepanel and check the lights.',
                })
            ),
            currentCwd: '/home/user/project',
        });

        const hydration = buildResumeHydrationPrompt(checkpoint);

        expect(hydration).toContain('Compact & Resume');
        expect(hydration).toContain('## Pending subgoals');
        expect(hydration).toContain('code: Implement the daemon tools');
        expect(hydration).toContain('## Current working directory');
        expect(hydration).toContain('/home/user/project');
        expect(hydration).toContain('## Key findings');
        expect(hydration).toContain('Daemon listens on 3001');
        expect(hydration).toContain('## Next step');
        expect(hydration).toContain('Open the sidepanel and check the lights.');
        expect(hydration).toContain('<ncode_goal_complete>true</ncode_goal_complete>');
    });

    it('accepts model answers that already use the canonical field names', () => {
        const summary = parseCompactionSummary(
            JSON.stringify({
                completedSubgoals: ['plan'],
                pendingSubgoals: ['code: implement'],
                modifiedFiles: ['src/index.js'],
                currentCwd: '/repo',
                keyFindings: ['fact'],
                nextStep: 'run tests',
            })
        );

        const checkpoint = createCheckpoint({ workflowId: 'wf-canonical', summary });

        expect(checkpoint.pendingSubgoals).toEqual(['code: implement']);
        expect(checkpoint.modifiedFiles).toEqual(['src/index.js']);
        expect(checkpoint.currentCwd).toBe('/repo');
        expect(checkpoint.keyFindings).toEqual(['fact']);
        expect(checkpoint.nextStep).toBe('run tests');
        expect(checkpoint.discoveredFactsAndErrors).toEqual(['fact']);
        expect(checkpoint.nextImmediateAction).toBe('run tests');
    });
});
