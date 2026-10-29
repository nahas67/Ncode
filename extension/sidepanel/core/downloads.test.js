// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { downloadFile, downloadText } from './downloads.js';

describe('sidepanel downloads', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
        URL.createObjectURL = vi.fn(() => 'blob:logs');
        URL.revokeObjectURL = vi.fn();
    });

    afterEach(() => {
        vi.restoreAllMocks();
        delete URL.createObjectURL;
        delete URL.revokeObjectURL;
    });

    it('removes the temporary anchor when a file download click fails', () => {
        vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {
            throw new Error('click failed');
        });

        expect(() => downloadFile('https://example.com/image.png', 'image.png')).toThrow(
            'click failed'
        );

        expect(document.body.querySelectorAll('a')).toHaveLength(0);
    });

    it('revokes object URLs when a text download click fails', () => {
        vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {
            throw new Error('click failed');
        });

        expect(() => downloadText('debug logs', 'logs.txt')).toThrow('click failed');

        expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:logs');
        expect(document.body.querySelectorAll('a')).toHaveLength(0);
    });

    it('uses a custom content type for text downloads', () => {
        vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

        downloadText('{"ok":true}', 'chat.json', 'application/json');

        expect(URL.createObjectURL.mock.calls[0][0].type).toBe('application/json');
        expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:logs');
    });

    it('refuses non-image URL schemes for file downloads', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const clickSpy = vi
            .spyOn(HTMLAnchorElement.prototype, 'click')
            .mockImplementation(() => {});

        try {
            expect(downloadFile('javascript:alert(1)', 'x.png')).toBe(false);
            expect(downloadFile('data:text/html,<h1>x</h1>', 'x.html')).toBe(false);
            expect(downloadFile(null, 'x.png')).toBe(false);
            expect(clickSpy).not.toHaveBeenCalled();
            expect(document.body.querySelectorAll('a')).toHaveLength(0);
        } finally {
            warnSpy.mockRestore();
        }
    });

    it('sanitizes download filenames', () => {
        vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
        const appendSpy = vi.spyOn(document.body, 'appendChild');

        expect(downloadFile('https://example.com/a.png', '../evil|x.png')).toBe(true);

        const anchor = appendSpy.mock.calls[0][0];
        expect(anchor.getAttribute('download')).toBe('.._evil_x.png');
    });

    it('falls back to text/plain for exotic text content types', () => {
        vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

        downloadText('data', 'file.bin', 'application/x-sh');

        expect(URL.createObjectURL.mock.calls[0][0].type).toBe('text/plain');
    });
});
