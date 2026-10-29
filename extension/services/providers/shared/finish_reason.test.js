import { describe, expect, it } from 'vitest';
import { describeFinishReason, throwIfTruncated } from './finish_reason.js';

describe('describeFinishReason', () => {
    it('flags output-limit reasons as truncation', () => {
        for (const reason of ['length', 'max_tokens', 'max_output_tokens', 'MAX_TOKENS']) {
            expect(describeFinishReason(reason)).toMatch(/truncated/i);
        }
    });

    it('flags safety and filter reasons as blocked', () => {
        for (const reason of [
            'content_filter',
            'refusal',
            'SAFETY',
            'RECITATION',
            'BLOCKLIST',
            'PROHIBITED_CONTENT',
            'SPII',
        ]) {
            expect(describeFinishReason(reason)).toMatch(/blocked/i);
        }
    });

    it('ignores normal completions and unknown values', () => {
        for (const reason of [null, undefined, '', 'stop', 'end_turn', 'STOP', 'tool_calls']) {
            expect(describeFinishReason(reason)).toBeNull();
        }
    });

    it('throwIfTruncated throws only for truncation and filter reasons', () => {
        expect(() => throwIfTruncated('length')).toThrow(/truncated/);
        expect(() => throwIfTruncated('SAFETY')).toThrow(/blocked/);
        expect(() => throwIfTruncated('stop')).not.toThrow();
        expect(() => throwIfTruncated(null)).not.toThrow();
    });
});
