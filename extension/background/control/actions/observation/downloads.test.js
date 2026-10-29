import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
    DownloadActions,
    downloadMatchesFilters,
    formatDownloadEntry,
    isInterestingDownload,
    IGNORE_EXISTING_LOOKBACK_MS,
} from './downloads.js';

describe('download helpers', () => {
    it('formatDownloadEntry includes id state file url', () => {
        const line = formatDownloadEntry({
            id: 7,
            state: 'in_progress',
            filename: '/tmp/win.iso',
            url: 'https://ms.com/win.iso',
            bytesReceived: 10,
            totalBytes: 100,
        });
        expect(line).toContain('id=7');
        expect(line).toContain('state=in_progress');
        expect(line).toContain('file=/tmp/win.iso');
        expect(line).toContain('progress=10/100');
    });

    it('downloadMatchesFilters is case-insensitive on filename/url', () => {
        const item = {
            id: 1,
            state: 'complete',
            filename: '/Users/x/Windows11.ISO',
            url: 'https://DOWNLOAD.microsoft.com/x',
        };
        expect(downloadMatchesFilters(item, { filenameContains: 'windows11' })).toBe(true);
        expect(downloadMatchesFilters(item, { urlContains: 'microsoft.com' })).toBe(true);
        expect(downloadMatchesFilters(item, { status: 'in_progress' })).toBe(false);
    });
});

describe('isInterestingDownload', () => {
    const waitStartedMs = Date.parse('2026-01-01T12:00:00.000Z');

    it('accepts brand-new ids when ignoreExisting is true', () => {
        const item = {
            id: 99,
            state: 'in_progress',
            filename: '/tmp/new.iso',
            startTime: '2026-01-01T12:00:01.000Z',
        };
        expect(
            isInterestingDownload(item, {
                ignoreExisting: true,
                baselineIds: new Set([1, 2]),
                waitStartedMs,
            })
        ).toBe(true);
    });

    it('rejects old baseline in_progress (unrelated download)', () => {
        const item = {
            id: 5,
            state: 'in_progress',
            filename: '/tmp/other.iso',
            // Started long before the wait window
            startTime: '2026-01-01T11:00:00.000Z',
        };
        expect(
            isInterestingDownload(item, {
                ignoreExisting: true,
                baselineIds: new Set([5]),
                waitStartedMs,
            })
        ).toBe(false);
    });

    it('accepts recent baseline complete (fast finish after click, before wait)', () => {
        const recentStart = new Date(waitStartedMs - 3_000).toISOString();
        const item = {
            id: 5,
            state: 'complete',
            filename: '/tmp/setup.exe',
            startTime: recentStart,
        };
        expect(
            isInterestingDownload(item, {
                ignoreExisting: true,
                baselineIds: new Set([5]),
                waitStartedMs,
            })
        ).toBe(true);
        expect(IGNORE_EXISTING_LOOKBACK_MS).toBeGreaterThan(3_000);
    });

    it('accepts recent baseline in_progress from the preceding click', () => {
        const recentStart = new Date(waitStartedMs - 1_000).toISOString();
        const item = {
            id: 8,
            state: 'in_progress',
            filename: '/tmp/win.iso',
            startTime: recentStart,
        };
        expect(
            isInterestingDownload(item, {
                ignoreExisting: true,
                baselineIds: new Set([8]),
                waitStartedMs,
            })
        ).toBe(true);
    });

    it('ignoreExisting=false accepts old baseline items', () => {
        const item = {
            id: 5,
            state: 'complete',
            filename: '/tmp/old.iso',
            startTime: '2020-01-01T00:00:00.000Z',
        };
        expect(
            isInterestingDownload(item, {
                ignoreExisting: false,
                baselineIds: new Set([5]),
                waitStartedMs,
            })
        ).toBe(true);
    });

    it('respects filenameContains filter', () => {
        const item = {
            id: 99,
            state: 'in_progress',
            filename: '/tmp/other.bin',
            startTime: '2026-01-01T12:00:01.000Z',
        };
        expect(
            isInterestingDownload(item, {
                ignoreExisting: true,
                baselineIds: new Set(),
                waitStartedMs,
                filenameContains: 'win.iso',
            })
        ).toBe(false);
    });
});

describe('DownloadActions', () => {
    beforeEach(() => {
        vi.stubGlobal('chrome', {
            downloads: {
                search: vi.fn(),
                onCreated: { addListener: vi.fn(), removeListener: vi.fn() },
                onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
            },
        });
    });

    it('listDownloads formats recent items', async () => {
        chrome.downloads.search.mockResolvedValue([
            {
                id: 3,
                state: 'complete',
                filename: '/tmp/a.iso',
                url: 'https://a.test/a.iso',
            },
        ]);
        const actions = new DownloadActions();
        const out = await actions.listDownloads({ limit: 5 });
        expect(out).toContain('0: id=3');
        expect(out).toContain('a.iso');
    });

    it('listDownloads returns empty message when none match', async () => {
        chrome.downloads.search.mockResolvedValue([]);
        const actions = new DownloadActions();
        expect(await actions.listDownloads({})).toBe('No matching downloads.');
    });

    it('waitForDownload resolves immediately when an in-progress download matches', async () => {
        chrome.downloads.search.mockResolvedValue([
            {
                id: 9,
                state: 'in_progress',
                filename: '/tmp/setup.exe',
                url: 'https://example.com/setup.exe',
                startTime: new Date().toISOString(),
            },
        ]);
        const actions = new DownloadActions();
        const out = await actions.waitForDownload({
            ignoreExisting: false,
            filenameContains: 'setup',
            timeout: 2000,
        });
        expect(out).toContain('Download ready');
        expect(out).toContain('id=9');
    });

    it('waitForDownload ignores old baseline in_progress by default', async () => {
        const oldStart = new Date(Date.now() - 60 * 60 * 1000).toISOString();
        // First search = baseline, second = immediate poll (same items).
        chrome.downloads.search.mockResolvedValue([
            {
                id: 3,
                state: 'in_progress',
                filename: '/tmp/unrelated.iso',
                url: 'https://example.com/unrelated.iso',
                startTime: oldStart,
            },
        ]);
        const actions = new DownloadActions();
        const out = await actions.waitForDownload({ timeout: 500, ignoreExisting: true });
        expect(out).toContain('Timed out');
        expect(out).toContain('list_downloads');
        expect(out).toContain('ignoreExisting:false');
    });

    it('waitForDownload accepts recent baseline download from preceding click', async () => {
        const recentStart = new Date(Date.now() - 2_000).toISOString();
        chrome.downloads.search.mockResolvedValue([
            {
                id: 11,
                state: 'in_progress',
                filename: '/tmp/win11.iso',
                url: 'https://ms.com/win11.iso',
                startTime: recentStart,
            },
        ]);
        const actions = new DownloadActions();
        const out = await actions.waitForDownload({
            timeout: 2000,
            ignoreExisting: true,
            filenameContains: 'win11',
        });
        expect(out).toContain('Download ready');
        expect(out).toContain('id=11');
    });

    it('waitForDownload times out with a list_downloads hint', async () => {
        chrome.downloads.search.mockResolvedValue([]);
        const actions = new DownloadActions();
        const out = await actions.waitForDownload({ timeout: 500, ignoreExisting: true });
        expect(out).toContain('Timed out');
        expect(out).toContain('list_downloads');
    });
});
