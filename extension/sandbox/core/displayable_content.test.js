import { describe, expect, it } from 'vitest';

import { hasDisplayableText, hasDisplayableThoughts } from './displayable_content.js';

describe('displayable content helpers', () => {
    it('treats blank strings as empty text', () => {
        expect(hasDisplayableText('')).toBe(false);
        expect(hasDisplayableText('   ')).toBe(false);
        expect(hasDisplayableText('Answer')).toBe(true);
    });

    it('keeps non-string thought payloads truthy or falsy by value', () => {
        expect(hasDisplayableThoughts(null)).toBe(false);
        expect(hasDisplayableThoughts('  ')).toBe(false);
        expect(hasDisplayableThoughts({ summary: 'thinking' })).toBe(true);
    });
});
