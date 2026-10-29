// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';
import { setLanguagePreference } from '../core/i18n.js';
import { createCopyButton } from './copy_button.js';
import { copyToClipboard } from './clipboard.js';

vi.mock('./clipboard.js', () => ({
    copyToClipboard: vi.fn(),
}));

describe('copy button', () => {
    it('copies current text and briefly swaps to the check icon', async () => {
        vi.useFakeTimers();
        copyToClipboard.mockResolvedValue(undefined);
        setLanguagePreference('zh');

        const button = createCopyButton(() => 'copy me');
        const originalIcon = button.innerHTML;

        expect(button.title).toBe('复制内容');

        button.dispatchEvent(new Event('click'));
        await Promise.resolve();

        expect(copyToClipboard).toHaveBeenCalledWith('copy me');
        expect(button.innerHTML).not.toBe(originalIcon);
        expect(button.textContent).toContain('已复制');

        vi.advanceTimersByTime(2000);
        expect(button.innerHTML).toBe(originalIcon);

        vi.useRealTimers();
        setLanguagePreference('en');
    });
});
