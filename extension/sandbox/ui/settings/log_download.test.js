import { describe, expect, it } from 'vitest';
import { formatLogDownloadText } from './log_download.js';

describe('log download helpers', () => {
    it('formats log entries into a stable download payload', () => {
        expect(
            formatLogDownloadText([
                {
                    timestamp: '2026-01-02T03:04:05.000Z',
                    level: 'info',
                    context: 'ui',
                    message: 'hello',
                    data: { a: 1 },
                },
                {
                    timestamp: 1700000000000,
                    level: 'warn',
                    context: 'bg',
                    message: 'oops',
                },
            ])
        ).toBe(
            '[2026-01-02T03:04:05.000Z] [info] [ui] hello | Data: {"a":1}\n' +
                '[2023-11-14T22:13:20.000Z] [warn] [bg] oops'
        );
    });
});
