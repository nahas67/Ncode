import {
    extractGeminiWebTokensFromHtml,
    requireCompleteGeminiWebTokens,
} from './providers/shared/web_auth.js';

// Get 'at' (SNlM0e), 'bl' (cfb2h), and user index values
// Supports fetching from specific user index URL to get correct tokens for that account.
const inflightFetch = new Map();

/**
 * Fetches the logged-in Gemini app HTML and parses the Web session tokens.
 *
 * The actual HTML → token parsing lives in
 * `services/providers/shared/web_auth.js` so the live-DOM fallback and the
 * direct background fetch share one implementation. This wrapper keeps the
 * historical API (`userIndex` positional argument + in-flight de-duplication).
 *
 * @param {string} [userIndex='0'] Gemini account index to authenticate as.
 * @param {{ signal?: AbortSignal|null }} [options]
 * @returns {Promise<{
 *   atValue: string,
 *   blValue: string,
 *   fSid: string,
 *   locale: string,
 *   authUserIndex: string,
 *   uploadPushId: string|null,
 *   uploadClientPctx: string|null,
 * }>}
 */
export async function fetchRequestParams(userIndex = '0', { signal } = {}) {
    const key = String(userIndex || '0');
    if (inflightFetch.has(key)) return inflightFetch.get(key);
    const task = (async () => {
        let url = 'https://gemini.google.com/app';
        if (userIndex && userIndex !== '0') {
            url = `https://gemini.google.com/u/${userIndex}/app`;
        }
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);
        if (signal) {
            if (signal.aborted) controller.abort();
            else signal.addEventListener('abort', () => controller.abort(), { once: true });
        }
        let response;
        try {
            response = await fetch(url, {
                method: 'GET',
                credentials: 'include',
                signal: controller.signal,
            });
        } finally {
            clearTimeout(timeout);
        }
        if (response.ok === false)
            throw new Error(`Failed to fetch Gemini Web params (HTTP ${response.status})`);
        const html = await response.text();

        const tokens = extractGeminiWebTokensFromHtml(html, { userIndex });
        return requireCompleteGeminiWebTokens(tokens, { userIndex });
    })();
    inflightFetch.set(key, task);
    try {
        return await task;
    } finally {
        inflightFetch.delete(key);
    }
}
