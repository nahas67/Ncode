import { describe, expect, it } from 'vitest';
import { CUSTOM_SELECTION_TOOLS_STORAGE_KEY } from '../../shared/settings/selection_tools.js';
import { createInitialRestoreMessages } from './state_messages.js';

function bootMessages(localStorageData) {
    return createInitialRestoreMessages(localStorageData, {
        theme: 'system',
        language: 'en',
        appVersion: 'test',
    });
}

function findMessage(messages, action) {
    return messages.afterTabContext.find((message) => message.action === action);
}

describe('createInitialRestoreMessages custom selection tools', () => {
    it('restores stored custom tools on first paint', () => {
        const tools = [{ id: 'a', name: 'Summarize', prompt: 'Summarize {text}' }];
        const messages = bootMessages({ [CUSTOM_SELECTION_TOOLS_STORAGE_KEY]: tools });

        expect(findMessage(messages, 'RESTORE_CUSTOM_SELECTION_TOOLS')).toEqual({
            action: 'RESTORE_CUSTOM_SELECTION_TOOLS',
            payload: tools,
        });
    });

    it('falls back to an empty list when nothing is stored', () => {
        const messages = bootMessages({});

        expect(findMessage(messages, 'RESTORE_CUSTOM_SELECTION_TOOLS')).toEqual({
            action: 'RESTORE_CUSTOM_SELECTION_TOOLS',
            payload: [],
        });
    });

    it('falls back to an empty list for corrupt non-array values', () => {
        const messages = bootMessages({ [CUSTOM_SELECTION_TOOLS_STORAGE_KEY]: 'oops' });

        expect(findMessage(messages, 'RESTORE_CUSTOM_SELECTION_TOOLS')).toEqual({
            action: 'RESTORE_CUSTOM_SELECTION_TOOLS',
            payload: [],
        });
    });
});
