// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMessageEditControl } from './message_edit.js';

vi.mock('../core/i18n.js', () => ({
    t: (key) => key,
}));

function createHarness(onEdit = vi.fn(() => true)) {
    const messageEl = document.createElement('div');
    const contentEl = document.createElement('div');
    const copyButton = document.createElement('button');
    contentEl.textContent = 'Original';
    messageEl.appendChild(contentEl);
    messageEl.appendChild(copyButton);
    document.body.appendChild(messageEl);

    const control = createMessageEditControl({
        messageEl,
        contentEl,
        getCopyButton: () => copyButton,
        getCurrentText: () => contentEl.textContent,
        onEdit,
    });
    messageEl.appendChild(control.button);

    return { contentEl, control, copyButton, messageEl, onEdit };
}

describe('createMessageEditControl', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        document.body.innerHTML = '';
    });

    it('saves trimmed edited text and restores the message view', async () => {
        const { contentEl, copyButton, messageEl, onEdit } = createHarness();

        messageEl.querySelector('.edit-btn').click();
        const textarea = messageEl.querySelector('.message-edit-input');
        textarea.value = '  Updated text  ';
        messageEl.querySelector('.message-edit-save').click();
        await Promise.resolve();

        expect(onEdit).toHaveBeenCalledWith('Updated text');
        expect(messageEl.querySelector('.message-edit')).toBeNull();
        expect(contentEl.hidden).toBe(false);
        expect(copyButton.hidden).toBe(false);
        expect(contentEl.hasAttribute('style')).toBe(false);
        expect(copyButton.hasAttribute('style')).toBe(false);
        expect(messageEl.classList.contains('editing')).toBe(false);
    });

    it('cancels an active edit when disposed', () => {
        const { contentEl, control, messageEl } = createHarness();

        messageEl.querySelector('.edit-btn').click();
        expect(messageEl.querySelector('.message-edit')).not.toBeNull();

        control.cancel();

        expect(messageEl.querySelector('.message-edit')).toBeNull();
        expect(contentEl.hidden).toBe(false);
        expect(contentEl.hasAttribute('style')).toBe(false);
        expect(messageEl.classList.contains('editing')).toBe(false);
    });

    it('consumes Escape so outer handlers do not also cancel generation', () => {
        vi.useFakeTimers();
        const { messageEl } = createHarness();
        messageEl.querySelector('.edit-btn').click();
        vi.runAllTimers();

        const keyEvent = new KeyboardEvent('keydown', {
            key: 'Escape',
            bubbles: true,
            cancelable: true,
        });
        const stopSpy = vi.spyOn(keyEvent, 'stopPropagation');
        document.dispatchEvent(keyEvent);

        expect(stopSpy).toHaveBeenCalled();
        expect(messageEl.querySelector('.message-edit')).toBeNull();
        expect(messageEl.classList.contains('editing')).toBe(false);
        vi.useRealTimers();
    });
});
