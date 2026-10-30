import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NcodeCompactManager } from './ncode_compact_manager.js';
import {
    clearWebConversationCursorMemory,
    getWebConversationCursor,
    updateWebConversationCursor,
} from './session/context_manager.js';

function createStorageArea(initial = {}) {
    const data = { ...initial };
    return {
        data,
        get: vi.fn(async (keys) => {
            const result = {};
            for (const key of Array.isArray(keys) ? keys : [keys]) {
                if (Object.prototype.hasOwnProperty.call(data, key)) result[key] = data[key];
            }
            return result;
        }),
        set: vi.fn(async (update) => {
            Object.assign(data, update);
        }),
        remove: vi.fn(async (keys) => {
            for (const key of Array.isArray(keys) ? keys : [keys]) {
                delete data[key];
            }
        }),
    };
}

function installChromeStub({ storageArea }) {
    const broadcasts = [];
    vi.stubGlobal('chrome', {
        storage: { local: storageArea },
        runtime: {
            sendMessage: vi.fn(async (message) => {
                broadcasts.push(message);
                return undefined;
            }),
        },
        i18n: { getUILanguage: () => 'en-US' },
    });
    return broadcasts;
}

beforeEach(() => {
    clearWebConversationCursorMemory();
});

afterEach(() => {
    clearWebConversationCursorMemory();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('Compact & Resume Gemini Web cursor reset', () => {
    it('resets the server-side conversation cursor when resuming a web run', async () => {
        const storageArea = createStorageArea({ geminiProvider: 'web' });
        const broadcasts = installChromeStub({ storageArea });
        await updateWebConversationCursor(['conv-1', 'resp-1', 'choice-1'], { storageArea });

        const sessionManager = { resetContext: vi.fn().mockResolvedValue(undefined) };
        const manager = new NcodeCompactManager({ storageArea, sessionManager });

        const result = await manager.spawnResumeSession({
            sessionId: 'session-1',
            checkpoint: { workflowId: 'wf-1' },
            hydrationPrompt: 'HYDRATE: pending subgoals',
            inLoop: true,
        });

        expect(result).toMatchObject({
            sessionId: 'session-1',
            contextReset: true,
            cursorReset: true,
        });
        expect(sessionManager.resetContext).toHaveBeenCalledTimes(1);
        expect(await getWebConversationCursor({ storageArea })).toEqual({
            conversationId: null,
            responseId: null,
            choiceId: null,
        });

        const resumed = broadcasts.find(
            (message) =>
                message.action === 'NCODE_COMPACTION_STATE' && message.state === 'resumed_context'
        );
        expect(resumed).toBeTruthy();
        expect(resumed.detail).toMatchObject({
            contextReset: true,
            cursorReset: true,
            inLoop: true,
        });
    });

    it('keeps a user-provided Gemini cursor untouched for non-web providers', async () => {
        const storageArea = createStorageArea({ geminiProvider: 'official' });
        installChromeStub({ storageArea });
        await updateWebConversationCursor(['conv-9', 'resp-9', 'choice-9'], { storageArea });

        const manager = new NcodeCompactManager({
            storageArea,
            sessionManager: { resetContext: vi.fn() },
        });
        const result = await manager.spawnResumeSession({
            sessionId: 'session-2',
            checkpoint: { workflowId: 'wf-2' },
            hydrationPrompt: '',
            inLoop: false,
        });

        expect(result).toMatchObject({ cursorReset: false });
        expect(await getWebConversationCursor({ storageArea })).toEqual({
            conversationId: 'conv-9',
            responseId: 'resp-9',
            choiceId: 'choice-9',
        });
    });

    it('skips the reset when the compaction run was cancelled', async () => {
        const storageArea = createStorageArea({ geminiProvider: 'web' });
        installChromeStub({ storageArea });
        await updateWebConversationCursor(['conv-1', 'resp-1', 'choice-1'], { storageArea });

        const sessionManager = { resetContext: vi.fn() };
        const manager = new NcodeCompactManager({ storageArea, sessionManager });
        const result = await manager.spawnResumeSession({
            sessionId: 'session-3',
            checkpoint: { workflowId: 'wf-3' },
            hydrationPrompt: '',
            inLoop: true,
            isCancelled: () => true,
        });

        expect(result).toMatchObject({ cursorReset: false, contextReset: false });
        expect(sessionManager.resetContext).not.toHaveBeenCalled();
        expect(await getWebConversationCursor({ storageArea })).toMatchObject({
            conversationId: 'conv-1',
        });
    });
});
