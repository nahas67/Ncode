import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    EMPTY_WEB_CONVERSATION_CURSOR,
    NCODE_WEB_CURSOR_STORAGE_KEY,
    clearWebConversationCursorMemory,
    getWebConversationCursor,
    isWebConversationCursorFresh,
    normalizeWebConversationCursor,
    resetWebConversationCursor,
    toWebConversationIds,
    updateWebConversationCursor,
} from './context_manager.js';

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

beforeEach(() => {
    clearWebConversationCursorMemory();
});

afterEach(() => {
    clearWebConversationCursorMemory();
});

describe('Gemini Web conversation cursor', () => {
    it('normalizes arrays and objects and defaults to a null triple', () => {
        expect(normalizeWebConversationCursor(['c1', 'r1', 'x1'])).toEqual({
            conversationId: 'c1',
            responseId: 'r1',
            choiceId: 'x1',
        });
        expect(normalizeWebConversationCursor({ conversationId: 'c2', responseId: null })).toEqual({
            conversationId: 'c2',
            responseId: null,
            choiceId: null,
        });
        expect(normalizeWebConversationCursor(null)).toEqual(EMPTY_WEB_CONVERSATION_CURSOR);
        expect(normalizeWebConversationCursor(['', '  ', undefined])).toEqual(
            EMPTY_WEB_CONVERSATION_CURSOR
        );
    });

    it('reports a null triple as a fresh chat', () => {
        expect(isWebConversationCursorFresh(EMPTY_WEB_CONVERSATION_CURSOR)).toBe(true);
        expect(isWebConversationCursorFresh(['', '', ''])).toBe(true);
        expect(isWebConversationCursorFresh(['c1', 'r1', 'x1'])).toBe(false);
    });

    it('persists, reads and formats the transport id triple', async () => {
        const storageArea = createStorageArea();

        await updateWebConversationCursor(['conv-1', 'resp-1', 'choice-1'], { storageArea });
        expect(storageArea.data[NCODE_WEB_CURSOR_STORAGE_KEY]).toEqual({
            conversationId: 'conv-1',
            responseId: 'resp-1',
            choiceId: 'choice-1',
        });

        clearWebConversationCursorMemory();
        const restored = await getWebConversationCursor({ storageArea });
        expect(restored).toEqual({
            conversationId: 'conv-1',
            responseId: 'resp-1',
            choiceId: 'choice-1',
        });
        expect(toWebConversationIds(restored)).toEqual(['conv-1', 'resp-1', 'choice-1']);
        expect(isWebConversationCursorFresh(restored)).toBe(false);
    });

    it('resets to the fresh-chat triple and clears storage', async () => {
        const storageArea = createStorageArea({
            [NCODE_WEB_CURSOR_STORAGE_KEY]: {
                conversationId: 'conv-1',
                responseId: 'resp-1',
                choiceId: 'choice-1',
            },
        });
        await getWebConversationCursor({ storageArea });

        const reset = await resetWebConversationCursor({ storageArea });

        expect(reset).toEqual({
            conversationId: null,
            responseId: null,
            choiceId: null,
            reset: true,
        });
        expect(storageArea.data[NCODE_WEB_CURSOR_STORAGE_KEY]).toBeUndefined();
        expect(await getWebConversationCursor({ storageArea })).toEqual(
            EMPTY_WEB_CONVERSATION_CURSOR
        );
        expect(toWebConversationIds()).toEqual(['', '', '']);
    });

    it('never throws when the storage area fails', async () => {
        const failingArea = {
            get: vi.fn().mockRejectedValue(new Error('quota')),
            set: vi.fn().mockRejectedValue(new Error('quota')),
            remove: vi.fn().mockRejectedValue(new Error('quota')),
        };
        const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

        await expect(getWebConversationCursor({ storageArea: failingArea })).resolves.toEqual(
            EMPTY_WEB_CONVERSATION_CURSOR
        );
        await expect(
            updateWebConversationCursor(['c', 'r', 'x'], { storageArea: failingArea })
        ).resolves.toMatchObject({ conversationId: 'c' });
        await expect(
            resetWebConversationCursor({ storageArea: failingArea })
        ).resolves.toMatchObject({ reset: false });

        consoleSpy.mockRestore();
    });
});
