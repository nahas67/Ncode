// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';
import { cleanupStructuredSourceText, createSourcesElement, getSourceDomain } from './sources.js';

vi.mock('../core/i18n.js', () => ({
    t: (key) =>
        ({
            sourcesLabel: 'Sources',
            showLessSources: 'Show less',
            showMoreSources: 'Show {count} more',
        })[key] || key,
}));

describe('source rendering utilities', () => {
    it('extracts readable domains from source URLs', () => {
        expect(getSourceDomain('https://www.example.com/path')).toBe('example.com');
        expect(getSourceDomain('not a url')).toBe('');
    });

    it('removes trailing structured source URL blocks from AI text', () => {
        const text = [
            'Answer body.',
            '',
            'Sources:',
            'https://example.com/a',
            'https://example.com/b',
        ].join('\n');

        expect(
            cleanupStructuredSourceText(text, [
                { url: 'https://example.com/a' },
                { url: 'https://example.com/b' },
            ])
        ).toBe('Answer body.');
    });

    it('creates a compact source list with hidden overflow links', () => {
        const element = createSourcesElement([
            { title: 'First', url: 'https://one.example/a' },
            { title: 'Second', url: 'https://two.example/b' },
            { title: 'Third', url: 'https://three.example/c' },
        ]);

        expect(element?.querySelector('.sources-label')?.textContent).toBe('Sources');
        expect(element?.querySelectorAll('.source-link')).toHaveLength(3);
        expect(element?.querySelectorAll('.source-link-hidden')).toHaveLength(1);
        expect(element?.querySelector('.sources-toggle')?.getAttribute('aria-label')).toBe(
            'Show 1 more'
        );
    });
});
