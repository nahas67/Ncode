/**
 * Minimal download observation tools (chrome.downloads).
 * Enough for agent tasks like ISO / installer downloads without full BCB DownloadStore.
 */

const MAX_WAIT_MS = 120_000;
const DEFAULT_WAIT_MS = 30_000;
const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 50;

/**
 * When ignoreExisting=true, baseline downloads are skipped unless they started
 * within this lookback window (covers: click → download starts → wait_for_download
 * a moment later). Older in-progress/complete items are treated as unrelated.
 */
export const IGNORE_EXISTING_LOOKBACK_MS = 15_000;

function clampInt(value, min, max, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.trunc(n)));
}

function downloadsApiAvailable() {
    return (
        typeof chrome !== 'undefined' &&
        chrome.downloads &&
        typeof chrome.downloads.search === 'function'
    );
}

/**
 * @param {chrome.downloads.DownloadItem} item
 */
export function formatDownloadEntry(item) {
    if (!item) return '';
    const parts = [
        `id=${item.id}`,
        `state=${item.state || 'unknown'}`,
        item.filename ? `file=${item.filename}` : null,
        item.url ? `url=${item.url}` : null,
        item.bytesReceived != null && item.totalBytes != null && item.totalBytes > 0
            ? `progress=${item.bytesReceived}/${item.totalBytes}`
            : null,
        item.error ? `error=${item.error}` : null,
    ].filter(Boolean);
    return parts.join(' | ');
}

/**
 * @param {chrome.downloads.DownloadItem} item
 * @param {{ filenameContains?: string, urlContains?: string, status?: string }} filters
 */
export function downloadMatchesFilters(item, filters = {}) {
    if (!item) return false;
    if (filters.status && item.state !== filters.status) return false;
    if (filters.filenameContains) {
        const name = String(item.filename || '');
        if (!name.toLowerCase().includes(String(filters.filenameContains).toLowerCase())) {
            return false;
        }
    }
    if (filters.urlContains) {
        const url = String(item.url || item.finalUrl || '');
        if (!url.toLowerCase().includes(String(filters.urlContains).toLowerCase())) {
            return false;
        }
    }
    return true;
}

/**
 * Whether a download item should satisfy wait_for_download.
 *
 * ignoreExisting=true (default):
 *   - always accept brand-new ids (not in baseline)
 *   - accept baseline ids only if startTime is within lookback of wait start
 *     (download kicked off by a click just before this call)
 *   - never accept long-running unrelated baseline downloads
 *
 * ignoreExisting=false:
 *   - accept any matching in_progress/complete item
 *
 * @param {chrome.downloads.DownloadItem|null|undefined} item
 * @param {{
 *   ignoreExisting?: boolean,
 *   baselineIds?: Set<number>,
 *   waitStartedMs?: number,
 *   lookbackMs?: number,
 *   filenameContains?: string,
 *   urlContains?: string,
 * }} opts
 */
export function isInterestingDownload(item, opts = {}) {
    if (!item || !Number.isInteger(item.id)) return false;
    if (item.state !== 'in_progress' && item.state !== 'complete') return false;
    if (
        !downloadMatchesFilters(item, {
            filenameContains: opts.filenameContains,
            urlContains: opts.urlContains,
        })
    ) {
        return false;
    }

    const ignoreExisting = opts.ignoreExisting !== false;
    if (!ignoreExisting) return true;

    const baselineIds = opts.baselineIds instanceof Set ? opts.baselineIds : new Set();
    if (!baselineIds.has(item.id)) return true;

    // Baseline item: only accept if it started recently (likely the preceding click).
    const waitStartedMs =
        typeof opts.waitStartedMs === 'number' && Number.isFinite(opts.waitStartedMs)
            ? opts.waitStartedMs
            : Date.now();
    const lookbackMs =
        typeof opts.lookbackMs === 'number' && Number.isFinite(opts.lookbackMs)
            ? opts.lookbackMs
            : IGNORE_EXISTING_LOOKBACK_MS;
    const startMs = Date.parse(item.startTime || '');
    if (!Number.isFinite(startMs)) return false;
    return startMs >= waitStartedMs - lookbackMs;
}

export class DownloadActions {
    /**
     * List recent browser downloads.
     * @param {{ limit?: number, filenameContains?: string, urlContains?: string, status?: string }} args
     */
    async listDownloads(args = {}) {
        if (!downloadsApiAvailable()) {
            return 'Error: chrome.downloads API is unavailable. Ensure the extension has the "downloads" permission and reload it.';
        }

        const limit = clampInt(args.limit, 1, MAX_LIST_LIMIT, DEFAULT_LIST_LIMIT);
        const query = {
            orderBy: ['-startTime'],
            limit: Math.min(100, limit * 3),
        };
        if (args.status && typeof args.status === 'string') {
            query.state = args.status;
        }

        let items = [];
        try {
            items = await chrome.downloads.search(query);
        } catch (error) {
            return `Error: downloads.search failed: ${error?.message || error}`;
        }

        const filters = {
            filenameContains: args.filenameContains,
            urlContains: args.urlContains,
            status: args.status,
        };
        const matched = items
            .filter((item) => downloadMatchesFilters(item, filters))
            .slice(0, limit);

        if (matched.length === 0) {
            return 'No matching downloads.';
        }

        return matched.map((item, index) => `${index}: ${formatDownloadEntry(item)}`).join('\n');
    }

    /**
     * Wait until a download starts or completes.
     * @param {{
     *   timeout?: number,
     *   filenameContains?: string,
     *   urlContains?: string,
     *   ignoreExisting?: boolean,
     * }} args
     */
    async waitForDownload(args = {}) {
        if (!downloadsApiAvailable()) {
            return 'Error: chrome.downloads API is unavailable. Ensure the extension has the "downloads" permission and reload it.';
        }

        const timeoutMs = clampInt(args.timeout, 500, MAX_WAIT_MS, DEFAULT_WAIT_MS);
        const ignoreExisting = args.ignoreExisting !== false;
        const filters = {
            filenameContains: args.filenameContains,
            urlContains: args.urlContains,
        };
        const waitStartedMs = Date.now();

        const baselineIds = new Set();
        if (ignoreExisting) {
            try {
                const existing = await chrome.downloads.search({
                    orderBy: ['-startTime'],
                    limit: 100,
                });
                for (const item of existing) {
                    if (Number.isInteger(item?.id)) baselineIds.add(item.id);
                }
            } catch {
                // continue without baseline
            }
        }

        const isInteresting = (item) =>
            isInterestingDownload(item, {
                ignoreExisting,
                baselineIds,
                waitStartedMs,
                filenameContains: filters.filenameContains,
                urlContains: filters.urlContains,
            });

        // Immediate poll (download may already be mid-flight from a prior click).
        try {
            const current = await chrome.downloads.search({
                orderBy: ['-startTime'],
                limit: 30,
            });
            const hit = current.find(isInteresting);
            if (hit) {
                return `Download ready.\n${formatDownloadEntry(hit)}`;
            }
        } catch {
            // fall through to listeners
        }

        return await new Promise((resolve) => {
            let settled = false;
            const cleanup = () => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                try {
                    chrome.downloads.onCreated.removeListener(onCreated);
                } catch {
                    /* ignore */
                }
                try {
                    chrome.downloads.onChanged.removeListener(onChanged);
                } catch {
                    /* ignore */
                }
            };

            const finish = (item) => {
                cleanup();
                resolve(`Download ready.\n${formatDownloadEntry(item)}`);
            };

            const onCreated = (item) => {
                if (isInteresting(item)) finish(item);
            };

            const onChanged = (delta) => {
                if (!delta || !Number.isInteger(delta.id)) return;
                chrome.downloads.search({ id: delta.id }, (items) => {
                    const item = Array.isArray(items) ? items[0] : null;
                    if (item && isInteresting(item)) finish(item);
                });
            };

            const timer = setTimeout(() => {
                cleanup();
                resolve(
                    `Error: Timed out after ${timeoutMs}ms waiting for a download` +
                        (filters.filenameContains
                            ? ` matching filename "${filters.filenameContains}"`
                            : '') +
                        (filters.urlContains ? ` matching url "${filters.urlContains}"` : '') +
                        '. Call list_downloads to inspect recent activity' +
                        (ignoreExisting
                            ? ', or pass ignoreExisting:false to accept an already-listed download.'
                            : '.')
                );
            }, timeoutMs);

            chrome.downloads.onCreated.addListener(onCreated);
            chrome.downloads.onChanged.addListener(onChanged);
        });
    }
}
