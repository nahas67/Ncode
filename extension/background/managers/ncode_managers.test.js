import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NcodeGoalManager } from './ncode_goal_manager.js';
import { NcodeHarnessStatus } from './ncode_harness_status.js';
import { NcodeBridgeClient } from './ncode_bridge_client.js';
import { NcodeCompactManager } from './ncode_compact_manager.js';

function createStorageArea(initial = {}) {
    const data = { ...initial };
    return {
        data,
        async get(keys) {
            if (keys === null || keys === undefined) return { ...data };
            const result = {};
            for (const key of Array.isArray(keys) ? keys : [keys]) {
                result[key] = data[key];
            }
            return result;
        },
        async set(values) {
            Object.assign(data, values);
        },
    };
}

function installChromeStub({ storageArea = null } = {}) {
    const broadcasts = [];
    globalThis.chrome = {
        runtime: {
            async sendMessage(message) {
                broadcasts.push(message);
            },
        },
        storage: storageArea ? { local: storageArea } : undefined,
    };
    return broadcasts;
}

describe('NcodeGoalManager', () => {
    let storageArea;
    let broadcasts;

    beforeEach(() => {
        storageArea = createStorageArea();
        broadcasts = installChromeStub({ storageArea });
    });

    it('creates, reuses and persists a goal session per chat session', async () => {
        const manager = new NcodeGoalManager({ storageArea });
        expect(manager.getActiveGoalForSession('s1')).toBeNull();

        const goal = await manager.startGoalForRequest({
            sessionId: 's1',
            rootGoal: 'Build the extension',
        });

        expect(goal.workflowId).toMatch(/^wf-s1-/);
        expect(goal.subgoals).toHaveLength(3);
        expect(manager.getActiveGoalForSession('s1').workflowId).toBe(goal.workflowId);
        expect(storageArea.data.ncodeActiveGoals.s1).toBe(goal.workflowId);
        expect(storageArea.data.ncodeGoalSessions[goal.workflowId]).toBeTruthy();

        const reused = await manager.startGoalForRequest({ sessionId: 's1', rootGoal: 'ignored' });
        expect(reused.workflowId).toBe(goal.workflowId);

        const other = await manager.startGoalForRequest({ sessionId: 's2', rootGoal: 'Another' });
        expect(other.workflowId).not.toBe(goal.workflowId);
        expect(manager.serializeActiveGoals()).toEqual({
            s1: goal.workflowId,
            s2: other.workflowId,
        });
        expect(broadcasts.some((message) => message.action === 'NCODE_GOAL_STATE')).toBe(true);
    });

    it('parses tags, applies subgoal updates, broadcasts preambles and marks completion', async () => {
        const manager = new NcodeGoalManager({ storageArea });
        const goal = await manager.startGoalForRequest({ sessionId: 's1', rootGoal: 'Ship it' });

        const applied = await manager.applyModelText(
            goal,
            '<ncode_preamble>Planning the work</ncode_preamble>\n' +
                '<ncode_goal_update>{"subgoalId":"plan","status":"done","evidence":"plan written"}</ncode_goal_update>\n' +
                'Working.'
        );
        expect(applied.signals.preamble).toBe('Planning the work');
        expect(applied.signals.updateApplied).toBe(true);
        expect(applied.signals.completed).toBe(false);
        expect(applied.goalSession.subgoals[0].status).toBe('done');
        expect(applied.goalSession.subgoals[0].evidence).toBe('plan written');
        expect(broadcasts.some((message) => message.action === 'NCODE_GOAL_STATE')).toBe(true);

        expect(await manager.recordPreamble(applied.goalSession, 'Live status')).toBe(true);
        expect(
            broadcasts.some(
                (message) => message.action === 'NCODE_PREAMBLE' && message.text === 'Live status'
            )
        ).toBe(true);

        const allDone = {
            ...applied.goalSession,
            subgoals: applied.goalSession.subgoals.map((subgoal) => ({
                ...subgoal,
                status: 'done',
            })),
        };
        const completed = await manager.applyModelText(
            allDone,
            'Done.\n<ncode_goal_complete>true</ncode_goal_complete>'
        );
        expect(completed.signals.completed).toBe(true);
        expect(completed.goalSession.status).toBe('completed');
    });

    it('advances iterations and reports exhaustion at the max iteration cap', async () => {
        const manager = new NcodeGoalManager({ storageArea });
        const goal = await manager.startGoalForRequest({
            sessionId: 's1',
            rootGoal: 'Loop',
            maxIterations: 2,
        });

        const first = await manager.advanceIteration(goal);
        expect(first.exhausted).toBe(false);
        expect(first.goalSession.iterationCount).toBe(1);

        const second = await manager.advanceIteration(first.goalSession);
        expect(second.exhausted).toBe(true);
        expect(second.goalSession.status).toBe('failed');
        expect(second.goalSession.failureReason).toBe('max_iterations_reached');
    });

    it('restores persisted goals and resets a session goal', async () => {
        const manager = new NcodeGoalManager({ storageArea });
        const goal = await manager.startGoalForRequest({ sessionId: 's1', rootGoal: 'Restore me' });
        await manager.persist();

        const restoredManager = new NcodeGoalManager({ storageArea });
        const result = await restoredManager.restore();
        expect(result.restored).toBeGreaterThanOrEqual(1);
        expect(restoredManager.getActiveGoalForSession('s1').workflowId).toBe(goal.workflowId);

        expect(await restoredManager.resetGoalForSession('s1')).toBe(true);
        expect(restoredManager.getActiveGoalForSession('s1')).toBeNull();
        expect(broadcasts.some((message) => message.action === 'NCODE_GOAL_STATE')).toBe(true);
    });

    it('never throws on malformed restored goal rows', async () => {
        storageArea = createStorageArea({
            ncodeGoalSessions: { broken: { nope: true } },
            ncodeActiveGoals: { s1: 'broken' },
        });
        installChromeStub({ storageArea });
        const manager = new NcodeGoalManager({ storageArea });

        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            const result = await manager.restore();
            expect(result.restored).toBe(0);
            expect(manager.getActiveGoalForSession('s1')).toBeNull();
        } finally {
            warnSpy.mockRestore();
        }
    });
});

describe('NcodeHarnessStatus', () => {
    let storageArea;

    beforeEach(() => {
        storageArea = createStorageArea({ geminiProvider: 'web' });
        installChromeStub({ storageArea });
    });

    it('reports both surfaces as healthy when the probes succeed', async () => {
        const harness = new NcodeHarnessStatus({
            mcpManager: {
                async listToolsForServer(serverId, transport, url) {
                    expect(serverId).toBe('ncode_local_pc');
                    expect(transport).toBe('streamable-http');
                    expect(url).toBe('http://127.0.0.1:3001/mcp');
                    return [{ name: 'pc_exec_shell' }, { name: 'pc_system_info' }];
                },
            },
            bridgeClient: { getStatus: () => ({ connected: true, url: 'ws://127.0.0.1:8085' }) },
            storageArea,
            tabsApi: {
                async query() {
                    return [{ id: 7, url: 'https://gemini.google.com/app' }];
                },
            },
            probeTimeoutMs: 500,
        });

        const status = await harness.probeAndBroadcast();
        expect(status).toMatchObject({
            geminiWebConnected: true,
            geminiWebProvider: 'web',
            pcShellConnected: true,
            pcShellEndpoint: 'http://127.0.0.1:3001/mcp',
            pcShellToolCount: 2,
            pcShellError: null,
            bridgeConnected: true,
            bridgeEndpoint: 'ws://127.0.0.1:8085',
        });
        expect(typeof status.updatedAt).toBe('number');
    });

    it('marks Gemini web disconnected when the provider is not web', async () => {
        storageArea = createStorageArea({ geminiProvider: 'official' });
        installChromeStub({ storageArea });
        const harness = new NcodeHarnessStatus({
            mcpManager: {
                async listToolsForServer() {
                    return [];
                },
            },
            storageArea,
            tabsApi: {
                async query() {
                    return [{ id: 7 }];
                },
            },
            probeTimeoutMs: 500,
        });
        const status = await harness.probeAndBroadcast();
        expect(status.geminiWebConnected).toBe(false);
        expect(status.pcShellConnected).toBe(true);
    });

    it('degrades without throwing when the daemon fails or hangs', async () => {
        const failing = new NcodeHarnessStatus({
            mcpManager: {
                async listToolsForServer() {
                    throw new Error('ECONNREFUSED');
                },
            },
            storageArea,
            tabsApi: {
                async query() {
                    throw new Error('no tabs');
                },
            },
            probeTimeoutMs: 200,
        });
        const failedStatus = await failing.probeAndBroadcast();
        expect(failedStatus.pcShellConnected).toBe(false);
        expect(failedStatus.pcShellError).toContain('ECONNREFUSED');
        expect(failedStatus.geminiWebConnected).toBe(false);

        const hanging = new NcodeHarnessStatus({
            mcpManager: { listToolsForServer: () => new Promise(() => {}) },
            storageArea,
            tabsApi: {
                async query() {
                    return [];
                },
            },
            probeTimeoutMs: 50,
        });
        const hungStatus = await hanging.probeAndBroadcast();
        expect(hungStatus.pcShellConnected).toBe(false);
        expect(hungStatus.pcShellError).toContain('Timed out');
    });

    it('starts and stops its probe interval idempotently', async () => {
        const harness = new NcodeHarnessStatus({
            mcpManager: {
                async listToolsForServer() {
                    return [];
                },
            },
            storageArea,
            tabsApi: {
                async query() {
                    return [];
                },
            },
            probeTimeoutMs: 100,
        });
        harness.start({ immediate: false });
        const firstTimer = harness.timer;
        harness.start({ immediate: false });
        expect(harness.timer).toBe(firstTimer);
        harness.stop();
        expect(harness.timer).toBeNull();
    });
});

describe('NcodeBridgeClient', () => {
    class FakeWebSocket {
        static instances = [];

        constructor(url) {
            this.url = url;
            this.readyState = 0;
            this.listeners = {};
            this.sent = [];
            FakeWebSocket.instances.push(this);
        }

        addEventListener(type, handler) {
            (this.listeners[type] ||= []).push(handler);
        }

        emit(type, event = {}) {
            for (const handler of this.listeners[type] || []) handler(event);
        }

        send(data) {
            this.sent.push(JSON.parse(data));
        }

        close() {
            this.readyState = 3;
            this.emit('close', {});
        }

        open() {
            this.readyState = 1;
            this.emit('open', {});
        }

        message(payload) {
            this.emit('message', { data: JSON.stringify(payload) });
        }
    }

    beforeEach(() => {
        installChromeStub();
        FakeWebSocket.instances = [];
    });

    it('registers, answers pings and serves ask_gemini_web requests', async () => {
        const asked = [];
        const client = new NcodeBridgeClient({
            wsFactory: () => new FakeWebSocket('ws://127.0.0.1:8085'),
            askWeb: async (prompt) => {
                asked.push(prompt);
                return 'Gemini answer';
            },
            now: () => 4242,
        });

        expect(client.getStatus().connected).toBe(false);
        client.connect();
        const socket = FakeWebSocket.instances[0];
        socket.open();
        expect(socket.sent[0]).toEqual({
            type: 'register',
            role: 'extension',
            client: 'ncode-extension',
            version: '1.0.0',
        });

        socket.message({ type: 'registered' });
        expect(client.getStatus().registered).toBe(true);

        socket.message({ type: 'ping' });
        expect(socket.sent.at(-1)).toEqual({ type: 'pong', ts: 4242 });

        socket.message({ type: 'ask_gemini_web', id: 'ask-1', prompt: 'Say hi' });
        await vi.waitFor(() =>
            expect(socket.sent.at(-1)).toEqual({
                type: 'ask_gemini_web_result',
                id: 'ask-1',
                ok: true,
                text: 'Gemini answer',
            })
        );
        expect(asked).toEqual(['Say hi']);

        socket.message({ type: 'ask_gemini_web', id: 'ask-2', prompt: '   ' });
        await vi.waitFor(() =>
            expect(socket.sent.at(-1)).toMatchObject({
                type: 'ask_gemini_web_result',
                id: 'ask-2',
                ok: false,
            })
        );

        client.disconnect();
        expect(client.getStatus().connected).toBe(false);
    });

    it('reports an askWeb failure as an error result instead of throwing', async () => {
        const client = new NcodeBridgeClient({
            wsFactory: () => new FakeWebSocket('ws://127.0.0.1:8085'),
            askWeb: async () => {
                throw new Error('web session expired');
            },
        });
        client.connect();
        const socket = FakeWebSocket.instances[0];
        socket.open();
        socket.message({ type: 'ask_gemini_web', id: 'ask-3', prompt: 'Hi' });
        await vi.waitFor(() =>
            expect(socket.sent.at(-1)).toEqual({
                type: 'ask_gemini_web_result',
                id: 'ask-3',
                ok: false,
                error: 'web session expired',
            })
        );
        client.disconnect();
    });
});

describe('NcodeCompactManager', () => {
    let storageArea;

    beforeEach(() => {
        storageArea = createStorageArea({
            geminiSessions: [
                {
                    id: 'session-1',
                    messages: [
                        { role: 'user', text: 'Hello' },
                        { role: 'ai', text: 'Hi' },
                    ],
                },
            ],
        });
        installChromeStub({ storageArea });
    });

    it('skips compaction below the threshold and for unknown sessions', async () => {
        const manager = new NcodeCompactManager({ storageArea, thresholdChars: 100000 });
        const below = await manager.maybeCompactAndResume({
            request: { sessionId: 'session-1' },
        });
        expect(below).toEqual({ compacted: false, reason: 'below_threshold' });

        expect(await manager.maybeCompactAndResume({ request: { sessionId: null } })).toEqual({
            compacted: false,
            reason: 'no_session_id',
        });
        expect(await manager.compactNow({ sessionId: 'missing' })).toEqual({
            compacted: false,
            reason: 'session_not_found',
        });
    });
});
