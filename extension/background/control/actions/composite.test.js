import { describe, expect, it, vi } from 'vitest';
import { CompositeActions } from './composite.js';

function createComposite({ actions, snapshotManager, connection } = {}) {
    const conn = connection || {
        sendCommand: vi.fn(() => Promise.resolve({})),
        getDialog: vi.fn(() => null),
    };
    const snapshot = snapshotManager || {
        takeSnapshot: vi.fn(() => Promise.resolve('uid=2_1 RootWebArea "Done"')),
    };
    const composite = new CompositeActions(conn, snapshot, {}, actions);
    return { composite, actions, snapshotManager: snapshot, connection: conn };
}

describe('CompositeActions.runSteps validation', () => {
    it('rejects a non-array steps argument', async () => {
        const { composite } = createComposite({ actions: {} });
        const result = await composite.runSteps({ steps: 'not-an-array' });
        expect(result).toMatch(/Error: 'steps' must be a non-empty array/);
    });

    it('rejects an empty steps array', async () => {
        const { composite } = createComposite({ actions: {} });
        const result = await composite.runSteps({ steps: [] });
        expect(result).toMatch(/Error: 'steps' must be a non-empty array/);
    });

    it('rejects more than 8 steps', async () => {
        const { composite } = createComposite({ actions: {} });
        const steps = Array.from({ length: 9 }, (_, i) => ({
            tool: 'wait_for_timeout',
            args: { timeout: 1 },
        }));
        const result = await composite.runSteps({ steps });
        expect(result).toMatch(/at most 8 steps/);
    });

    it('rejects a nested run_steps', async () => {
        const { composite } = createComposite({ actions: {} });
        const result = await composite.runSteps({
            steps: [{ tool: 'run_steps', args: { steps: [] } }],
        });
        expect(result).toMatch(/cannot nest run_steps/);
    });

    it('rejects an unknown tool name', async () => {
        const { composite } = createComposite({ actions: {} });
        const result = await composite.runSteps({
            steps: [{ tool: 'bogus_tool', args: {} }],
        });
        expect(result).toMatch(/not a supported atomic tool/);
    });

    it('rejects a tab-switching tool that is not the final step', async () => {
        const { composite, actions } = createComposite({
            actions: { newPage: vi.fn(() => Promise.resolve('created')) },
        });
        const result = await composite.runSteps({
            steps: [
                { tool: 'new_page', args: { url: 'https://a.test/' } },
                { tool: 'wait_for', args: { text: ['x'] } },
            ],
        });
        expect(result).toMatch(/may only be the final step/);
        expect(actions.newPage).not.toHaveBeenCalled();
    });
});

describe('CompositeActions.runSteps execution', () => {
    it('runs two steps in order and joins their outputs', async () => {
        const callOrder = [];
        const actions = {
            navigatePage: vi.fn(async (args) => {
                callOrder.push('navigate');
                return `Navigating to ${args.url}`;
            }),
            waitFor: vi.fn(async (args) => {
                callOrder.push('wait');
                return `Found text: ${args.text[0]}`;
            }),
        };
        const { composite, snapshotManager } = createComposite({ actions });

        const result = await composite.runSteps({
            steps: [
                { tool: 'navigate_page', args: { url: 'https://example.test/' } },
                { tool: 'wait_for', args: { text: ['Loaded'] } },
            ],
        });

        expect(callOrder).toEqual(['navigate', 'wait']);
        expect(result).toContain('Completed 2 steps');
        expect(result).toContain('Step 1 (navigate_page): Navigating to https://example.test/');
        expect(result).toContain('Step 2 (wait_for): Found text: Loaded');
        // Default includeSnapshot=true -> a single snapshot is appended.
        expect(snapshotManager.takeSnapshot).toHaveBeenCalledTimes(1);
        expect(result).toContain('## Latest page snapshot');
    });

    it('forces includeSnapshot=false on every atomic call', async () => {
        const actions = {
            clickElement: vi.fn(async (args) => `Clicked ${args.uid}`),
        };
        const { composite } = createComposite({ actions });

        await composite.runSteps({
            steps: [{ tool: 'click', args: { uid: '1_5', includeSnapshot: true } }],
        });

        expect(actions.clickElement).toHaveBeenCalledWith(
            expect.objectContaining({ uid: '1_5', includeSnapshot: false })
        );
    });

    it('skips the trailing snapshot when includeSnapshot is false', async () => {
        const actions = {
            clickElement: vi.fn(async () => 'Clicked element 1_5'),
        };
        const { composite, snapshotManager } = createComposite({ actions });

        const result = await composite.runSteps({
            steps: [{ tool: 'click', args: { uid: '1_5' } }],
            includeSnapshot: false,
        });

        // Successful path with includeSnapshot:false — no trailing snapshot.
        // (Failure path always attempts a recovery snapshot; this click succeeds.)
        expect(snapshotManager.takeSnapshot).not.toHaveBeenCalled();
        expect(result).not.toContain('## Latest page snapshot');
    });

    it('stops at the first step that returns an Error string', async () => {
        const actions = {
            clickElement: vi.fn(async () => 'Error: stale UID 1_5'),
            waitFor: vi.fn(async () => 'Found text: never'),
        };
        const { composite, snapshotManager } = createComposite({ actions });

        const result = await composite.runSteps({
            steps: [
                { tool: 'click', args: { uid: '1_5' } },
                { tool: 'wait_for', args: { text: ['x'] } },
            ],
        });

        expect(result).toMatch(/^Error: step 1 \(click\) failed\./);
        expect(result).toContain('Error: stale UID 1_5');
        // Second step must never run.
        expect(actions.waitFor).not.toHaveBeenCalled();
        // Recovery snapshot on failure so the agent can continue without an
        // extra take_snapshot turn.
        expect(snapshotManager.takeSnapshot).toHaveBeenCalledTimes(1);
        expect(result).toContain('## Latest page snapshot');
    });

    it('converts a thrown atomic error into an Error string and stops', async () => {
        const actions = {
            clickElement: vi.fn(async () => {
                throw new Error('Stale Element Reference: UID 1_5');
            }),
            waitFor: vi.fn(async () => 'Found text: never'),
        };
        const { composite, snapshotManager } = createComposite({ actions });

        const result = await composite.runSteps({
            steps: [
                { tool: 'click', args: { uid: '1_5' } },
                { tool: 'wait_for', args: { text: ['x'] } },
            ],
        });

        expect(result).toMatch(/^Error: step 1 \(click\) failed\./);
        expect(result).toContain('Stale Element Reference: UID 1_5');
        expect(actions.waitFor).not.toHaveBeenCalled();
        expect(snapshotManager.takeSnapshot).toHaveBeenCalledTimes(1);
        expect(result).toContain('## Latest page snapshot');
    });
});

describe('CompositeActions.runSteps return wrappers', () => {
    it('unwraps { text, image } screenshot results and forwards the image', async () => {
        const actions = {
            takeScreenshot: vi.fn(async () => ({
                text: 'Captured screenshot (viewport).',
                image: 'base64data',
            })),
        };
        const { composite, snapshotManager } = createComposite({ actions });

        const result = await composite.runSteps({
            steps: [{ tool: 'take_screenshot', args: {} }],
        });

        // Screenshot steps participate in the joined summary, and the trailing
        // snapshot is still appended for the next interaction.
        expect(result).toContain('Captured screenshot (viewport)');
        expect(snapshotManager.takeSnapshot).toHaveBeenCalledTimes(1);
    });

    it('surfaces only the final step _meta so ControlManager can switch tabs', async () => {
        const actions = {
            newPage: vi.fn(async () => ({
                output: 'Created new page (id: 42) loading about:blank',
                _meta: { switchTabId: 42 },
            })),
        };
        const { composite } = createComposite({ actions });

        const result = await composite.runSteps({
            steps: [{ tool: 'new_page', args: { url: 'about:blank' } }],
        });

        expect(result).toEqual(
            expect.objectContaining({
                output: expect.stringContaining('Created new page (id: 42)'),
                _meta: { switchTabId: 42 },
            })
        );
    });

    it('drops intermediate _meta and keeps only the last step', async () => {
        // simulate two navigation wrappers both carrying _meta; only the final
        // step's _meta may be surfaced.
        const actions = {
            navigatePage: vi.fn(async () => ({
                output: 'Navigating to https://a.test/',
                _meta: { switchTabId: 99 },
            })),
            selectPage: vi.fn(async () => ({
                output: 'Selected page 1',
                _meta: { switchTabId: 7 },
            })),
        };
        const { composite } = createComposite({ actions });

        const result = await composite.runSteps({
            steps: [
                { tool: 'navigate_page', args: { url: 'https://a.test/' } },
                { tool: 'select_page', args: { index: 1 } },
            ],
        });

        expect(result._meta).toEqual({ switchTabId: 7 });
    });
});
