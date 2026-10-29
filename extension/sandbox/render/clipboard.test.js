// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { copyToClipboard } from './clipboard.js';

describe('copyToClipboard', () => {
    beforeEach(() => {
        Object.defineProperty(window, 'origin', {
            configurable: true,
            value: 'null',
        });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
        document.body.innerHTML = '';
    });

    it('uses a CSS class for the fallback textarea presentation', async () => {
        vi.stubGlobal('navigator', {});
        document.execCommand = vi.fn(() => {
            const textArea = document.querySelector('textarea.clipboard-staging-input');
            expect(textArea).toBeTruthy();
            expect(textArea.hasAttribute('style')).toBe(false);
            expect(textArea.value).toBe('copy me');
            return true;
        });

        await copyToClipboard('copy me');

        expect(document.execCommand).toHaveBeenCalledWith('copy');
        expect(document.querySelector('textarea.clipboard-staging-input')).toBeNull();
    });
});
