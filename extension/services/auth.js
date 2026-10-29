import { extractFromHTML } from '../shared/utils/index.js';

// Get 'at' (SNlM0e), 'bl' (cfb2h), and user index values
// Supports fetching from specific user index URL to get correct tokens for that account.
const inflightFetch = new Map();

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

        const atValue = extractFromHTML('SNlM0e', html);
        const blValue = extractFromHTML('cfb2h', html);
        const fSid = extractFromHTML('FdrFJe', html);
        const uploadPushId = extractFromHTML('qKIAYe', html);
        const uploadClientPctx = extractFromHTML('Ylro7b', html);
        const locale = html.match(/<html[^>]*\slang="([^"]+)"/)?.[1] || 'en-US';

        let authUserIndex = userIndex;

        const authMatch = html.match(/data-index=["'](\d+)["']/);
        if (authMatch) {
            const parsed = authMatch[1];
            if (/^\d+$/.test(parsed) && Number(parsed) < 20) authUserIndex = parsed;
        }

        const missingRequestTokens = [
            ['atValue', atValue],
            ['blValue', blValue],
            ['fSid', fSid],
        ]
            .filter(([, value]) => !value)
            .map(([name]) => name);

        if (missingRequestTokens.length > 0) {
            throw new Error(
                `Gemini Web request tokens unavailable for account ${userIndex}: ${missingRequestTokens.join(', ')}. Please log in to gemini.google.com or refresh Gemini.`
            );
        }

        const result = {
            atValue,
            blValue,
            fSid,
            locale,
            authUserIndex,
            uploadPushId: uploadPushId || null,
            uploadClientPctx: uploadClientPctx || null,
        };
        return result;
    })();
    inflightFetch.set(key, task);
    try {
        return await task;
    } finally {
        inflightFetch.delete(key);
    }
}
