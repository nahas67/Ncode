import { describe, expect, it, vi } from 'vitest';

import {
    NCODE_APPROVAL_DEFAULT_TIMEOUT_MS,
    NcodeApprovalManager,
    isRiskyToolName,
} from './ncode_approval_manager.js';

function createStorageArea(initial = {}) {
    const data = { ...initial };
    return {
        data,
        get: vi.fn(async (keys) => {
            const result = {};
            for (const key of keys) {
                if (Object.prototype.hasOwnProperty.call(data, key)) result[key] = data[key];
            }
            return result;
        }),
        set: vi.fn(async (update) => {
            Object.assign(data, update);
        }),
    };
}

describe('isRiskyToolName', () => {
    it('flags mutating PC tools and leaves read-only tools automatic', () => {
        expect(isRiskyToolName('pc_exec_shell')).toBe(true);
        expect(isRiskyToolName('pc_fs_write')).toBe(true);
        expect(isRiskyToolName('pc_fs_patch')).toBe(true);
        expect(isRiskyToolName('pc_git_commit')).toBe(true);
        expect(isRiskyToolName('pc_clipboard')).toBe(true);
        expect(isRiskyToolName('pc_fs_read')).toBe(false);
        expect(isRiskyToolName('pc_search_code')).toBe(false);
        expect(isRiskyToolName('pc_git_status_diff')).toBe(false);
        expect(isRiskyToolName('')).toBe(false);
    });
});

describe('NcodeApprovalManager policy', () => {
    it('defaults to auto (no prompts)', async () => {
        const manager = new NcodeApprovalManager({ storageArea: createStorageArea() });
        await manager.ensureInitialized();

        expect(manager.getPolicy()).toBe('auto');
        await expect(manager.isApprovalRequired('pc_exec_shell')).resolves.toBe(false);
    });

    it('restores the persisted ask policy and gates only risky tools', async () => {
        const storageArea = createStorageArea({ ncodeApprovalPolicy: 'ask' });
        const manager = new NcodeApprovalManager({ storageArea });
        await manager.ensureInitialized();

        expect(manager.getPolicy()).toBe('ask');
        await expect(manager.isApprovalRequired('pc_exec_shell')).resolves.toBe(true);
        await expect(manager.isApprovalRequired('pc_fs_read')).resolves.toBe(false);
    });

    it('persists policy changes and supports always/never', async () => {
        const storageArea = createStorageArea();
        const manager = new NcodeApprovalManager({ storageArea });
        await manager.ensureInitialized();

        await manager.setPolicy('always');
        expect(storageArea.data.ncodeApprovalPolicy).toBe('always');
        await expect(manager.isApprovalRequired('pc_system_info')).resolves.toBe(true);

        await manager.setPolicy('never');
        const decision = await manager.requestToolApproval({ toolName: 'pc_exec_shell' });
        expect(decision).toMatchObject({ required: true, approved: false });
        expect(decision.reason).toContain('never');

        await manager.setPolicy('unknown-policy-value');
        expect(manager.getPolicy()).toBe('auto');
    });
});

describe('NcodeApprovalManager request lifecycle', () => {
    it('broadcasts an approval request and resolves on approve', async () => {
        const broadcasts = [];
        const manager = new NcodeApprovalManager({
            storageArea: createStorageArea({ ncodeApprovalPolicy: 'ask' }),
            broadcast: async (action, payload) => {
                broadcasts.push({ action, payload });
                return true;
            },
        });
        await manager.ensureInitialized();

        const pending = manager.requestToolApproval({
            sessionId: 'session-1',
            workflowId: 'wf-1',
            toolName: 'pc_exec_shell',
            toolArgs: { command: 'npm run dev' },
        });

        // The request must be visible before the UI answers.
        await Promise.resolve();
        expect(broadcasts).toHaveLength(1);
        expect(broadcasts[0].action).toBe('NCODE_APPROVAL_REQUEST');
        expect(broadcasts[0].payload).toMatchObject({
            sessionId: 'session-1',
            workflowId: 'wf-1',
            toolName: 'pc_exec_shell',
            requestId: expect.any(String),
        });
        expect(broadcasts[0].payload.detail).toContain('npm run dev');
        expect(manager.getPendingCount()).toBe(1);

        const { requestId } = broadcasts[0].payload;
        expect(manager.resolveApproval({ requestId, approved: true })).toBe(true);
        await expect(pending).resolves.toMatchObject({
            required: true,
            approved: true,
            requestId,
        });
        expect(manager.getPendingCount()).toBe(0);

        // Stale/unknown ids are ignored.
        expect(manager.resolveApproval({ requestId, approved: true })).toBe(false);
    });

    it('denies on an explicit reject response', async () => {
        const broadcasts = [];
        const manager = new NcodeApprovalManager({
            storageArea: createStorageArea({ ncodeApprovalPolicy: 'ask' }),
            broadcast: async (action, payload) => {
                broadcasts.push({ action, payload });
                return true;
            },
        });
        await manager.ensureInitialized();

        const pending = manager.requestToolApproval({ toolName: 'pc_fs_write' });
        await Promise.resolve();
        manager.resolveApproval({
            requestId: broadcasts[0].payload.requestId,
            approved: false,
            reason: 'user denied',
        });

        await expect(pending).resolves.toMatchObject({
            required: true,
            approved: false,
            reason: 'user denied',
        });
    });

    it('times out as a denial instead of hanging the tool loop', async () => {
        vi.useFakeTimers();
        try {
            const manager = new NcodeApprovalManager({
                storageArea: createStorageArea({ ncodeApprovalPolicy: 'ask' }),
                timeoutMs: 2500,
                broadcast: async () => true,
            });
            await manager.ensureInitialized();

            const pending = manager.requestApproval({ toolName: 'pc_exec_shell' });
            await Promise.resolve();
            expect(manager.getPendingCount()).toBe(1);

            vi.advanceTimersByTime(NCODE_APPROVAL_DEFAULT_TIMEOUT_MS);
            await expect(pending).resolves.toMatchObject({
                approved: false,
                reason: expect.stringContaining('timed out'),
            });
            expect(manager.getPendingCount()).toBe(0);
        } finally {
            vi.useRealTimers();
        }
    });

    it('clears every pending request on cancellation', async () => {
        const manager = new NcodeApprovalManager({
            storageArea: createStorageArea({ ncodeApprovalPolicy: 'ask' }),
            broadcast: async () => true,
        });
        await manager.ensureInitialized();

        const first = manager.requestApproval({ toolName: 'pc_exec_shell' });
        const second = manager.requestApproval({ toolName: 'pc_fs_write' });
        await Promise.resolve();
        expect(manager.getPendingCount()).toBe(2);

        manager.clearAll();
        await expect(first).resolves.toMatchObject({ approved: false });
        await expect(second).resolves.toMatchObject({ approved: false });
        expect(manager.getPendingCount()).toBe(0);
    });
});
