import { describe, expect, it } from 'vitest';

import { escapeHtml } from './escape.js';

describe('escapeHtml', () => {
    it('escapes HTML special characters to prevent injection', () => {
        expect(escapeHtml('<script>alert(1)</script>')).toBe(
            '&lt;script&gt;alert(1)&lt;/script&gt;'
        );
    });

    it('escapes quotes so values cannot break out of attribute contexts', () => {
        expect(escapeHtml('"onmouseover="alert(1)')).toBe('&quot;onmouseover=&quot;alert(1)');
        expect(escapeHtml("'><img src=x onerror=alert(1)>")).toContain('&#039;');
    });

    it('escapes ampersands first to avoid double-encoding later replacements', () => {
        expect(escapeHtml('a & b')).toBe('a &amp; b');
        expect(escapeHtml('<a>')).toBe('&lt;a&gt;');
    });

    it('returns empty string for null/undefined without throwing', () => {
        expect(escapeHtml(null)).toBe('');
        expect(escapeHtml(undefined)).toBe('');
        expect(escapeHtml('')).toBe('');
    });

    it('coerces non-string values to string before escaping', () => {
        expect(escapeHtml(42)).toBe('42');
    });

    it('preserves falsy non-nullish values instead of swallowing them', () => {
        expect(escapeHtml(0)).toBe('0');
        expect(escapeHtml(false)).toBe('false');
        expect(escapeHtml(NaN)).toBe('NaN');
    });
});
