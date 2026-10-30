import { BaseActionHandler } from '../base.js';

// Simple URL glob -> RegExp: escape regex specials, then "*" -> ".*".
// Matches BCB's playwright_wait_for_url intent (a glob pattern over the URL).
export function globToRegExp(pattern) {
    const escaped = String(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`^${escaped.replace(/\*/g, '.*')}$`);
}

const POLL_INTERVAL_MS = 200;
const WAIT_FOR_URL_DEFAULT_MS = 10_000;
const WAIT_FOR_LOAD_DEFAULT_MS = 10_000;
const WAIT_FOR_TIMEOUT_DEFAULT_MS = 1000;
const WAIT_FOR_TIMEOUT_MAX_MS = 30_000;

export class WaitActions extends BaseActionHandler {
    async waitFor({ text, timeout = 5000 }) {
        const targets = Array.isArray(text) ? text : [text];
        const normalizedTargets = targets
            .map((value) => String(value || '').trim())
            .filter(Boolean);

        if (normalizedTargets.length === 0) {
            return "Error: 'text' must include at least one non-empty value.";
        }

        const timeoutMs = Number.isFinite(timeout) && timeout > 0 ? timeout : 5000;
        const result = await this.cmd('Runtime.evaluate', {
            expression: `
                (async () => {
                    const targets = ${JSON.stringify(normalizedTargets)};
                    const timeoutMs = ${JSON.stringify(timeoutMs)};
                    const getPageText = () => document.body ? document.body.innerText || document.body.textContent || '' : '';
                    const findMatch = () => targets.find((target) => getPageText().includes(target)) || null;
                    const existing = findMatch();
                    if (existing) return existing;

                    return await new Promise((resolve) => {
                        const startedAt = Date.now();
                        let done = false;
                        let observer = null;

                        const finish = (value) => {
                            if (done) return;
                            done = true;
                            if (observer) observer.disconnect();
                            resolve(value);
                        };

                        const check = () => {
                            const match = findMatch();
                            if (match) finish(match);
                        };

                        if (document.body) {
                            observer = new MutationObserver(check);
                            observer.observe(document.body, {
                                childList: true,
                                subtree: true,
                                characterData: true,
                            });
                        }

                        setTimeout(() => finish(null), Math.max(0, timeoutMs - (Date.now() - startedAt)));
                    });
                })()
            `,
            awaitPromise: true,
            returnByValue: true,
        });

        const matchedText = result?.result?.value;
        if (matchedText) {
            return `Found text: ${matchedText}`;
        }

        return `Timed out waiting for text: ${normalizedTargets.join(', ')}`;
    }

    // Mirrors BCB's playwright_wait_for_url: wait until the tab URL matches a glob.
    async waitForUrl({ url, timeout = WAIT_FOR_URL_DEFAULT_MS } = {}) {
        if (!url || typeof url !== 'string') {
            return "Error: 'url' must be a non-empty glob pattern.";
        }
        const timeoutMs =
            Number.isFinite(timeout) && timeout > 0 ? timeout : WAIT_FOR_URL_DEFAULT_MS;
        const re = globToRegExp(url);
        const startedAt = Date.now();

        const test = async () => {
            const current = await this.waitHelper._getCurrentUrl();
            return { current, ok: re.test(current) };
        };

        let last = await test();
        while (!last.ok && Date.now() - startedAt < timeoutMs) {
            await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
            last = await test();
        }

        return last.ok
            ? `URL matched: ${last.current}`
            : `Timed out waiting for URL matching ${url} (last: ${last.current || 'unknown'})`;
    }

    // Mirrors BCB's playwright_wait_for_load_state: 'load' | 'domcontentloaded'.
    async waitForLoadState({ state = 'load', timeout = WAIT_FOR_LOAD_DEFAULT_MS } = {}) {
        const target =
            state === 'domcontentloaded' ? 'Page.domContentEventFired' : 'Page.loadEventFired';
        const timeoutMs =
            Number.isFinite(timeout) && timeout > 0 ? timeout : WAIT_FOR_LOAD_DEFAULT_MS;

        try {
            await this.cmd('Page.enable', {});
        } catch {
            // Page domain may already be enabled or unavailable; continue best-effort.
        }

        const reached = await this.waitHelper._waitForEvent(
            (method) => method === target,
            timeoutMs
        );
        return reached ? `Reached ${state} state` : `Timed out waiting for ${state} state`;
    }

    // Mirrors BCB's playwright_wait_for_timeout: fixed wait, capped for safety.
    async waitForTimeout({ timeout = WAIT_FOR_TIMEOUT_DEFAULT_MS } = {}) {
        let ms = Number.isFinite(timeout) && timeout > 0 ? timeout : WAIT_FOR_TIMEOUT_DEFAULT_MS;
        ms = Math.min(ms, WAIT_FOR_TIMEOUT_MAX_MS);
        await new Promise((resolve) => setTimeout(resolve, ms));
        return `Waited ${ms}ms`;
    }
}
