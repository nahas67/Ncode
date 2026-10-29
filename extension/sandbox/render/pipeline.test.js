// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { transformMarkdown } from './pipeline.js';

describe('transformMarkdown sanitization', () => {
    afterEach(() => {
        delete globalThis.marked;
    });

    it('removes scriptable HTML emitted by Markdown rendering', () => {
        globalThis.marked = {
            parse() {
                return [
                    '<p>hello</p>',
                    '<img src="x" onerror="alert(1)">',
                    '<a href="javascript:alert(1)" onclick="alert(2)">bad</a>',
                    '<script>alert(3)</script>',
                ].join('');
            },
        };

        const html = transformMarkdown('ignored');

        expect(html).toContain('<p>hello</p>');
        expect(html).not.toContain('<script');
        expect(html).not.toContain('onerror');
        expect(html).not.toContain('onclick');
        expect(html).not.toContain('javascript:');
    });

    it('escapes raw text while Markdown dependencies are unavailable', () => {
        const html = transformMarkdown('<img src=x onerror=alert(1)>');

        expect(html).toBe('&lt;img src=x onerror=alert(1)&gt;');
    });

    it('falls back to escaped text when Markdown parsing throws', () => {
        globalThis.marked = {
            parse() {
                throw new Error('boom');
            },
        };
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        const html = transformMarkdown('<img src=x onerror=alert(1)>');

        expect(html).toBe('&lt;img src=x onerror=alert(1)&gt;');
        errorSpy.mockRestore();
    });
});
