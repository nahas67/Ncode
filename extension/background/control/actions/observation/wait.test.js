import { describe, expect, it, vi } from 'vitest';
import { ObservationActions } from './index.js';
import { WaitActions, globToRegExp } from './wait.js';

describe('ObservationActions waitFor', () => {
    it('waits for any requested text and returns the matched text', async () => {
        const connection = {
            sendCommand: vi.fn(() => Promise.resolve({ result: { value: 'Dashboard' } })),
        };
        const actions = new ObservationActions(connection, {}, {});

        const result = await actions.waitFor({ text: ['Dashboard', 'Home'], timeout: 750 });

        expect(connection.sendCommand).toHaveBeenCalledWith(
            'Runtime.evaluate',
            expect.objectContaining({
                awaitPromise: true,
                returnByValue: true,
            })
        );
        expect(result).toBe('Found text: Dashboard');
    });
});

describe('globToRegExp', () => {
    it('treats * as a greedy match including slashes', () => {
        const re = globToRegExp('https://example.com/*');
        expect(re.test('https://example.com/foo/bar')).toBe(true);
        expect(re.test('https://other.com/foo')).toBe(false);
    });

    it('escapes regex specials', () => {
        const re = globToRegExp('example.com/success');
        expect(re.test('example.com/success')).toBe(true);
        expect(re.test('exampleXcom/success')).toBe(false);
    });
});

describe('WaitActions.waitForUrl', () => {
    it('matches immediately when the current URL already fits the glob', async () => {
        const waitHelper = {
            _getCurrentUrl: vi.fn(() => Promise.resolve('https://example.com/success')),
        };
        const actions = new WaitActions({}, {}, waitHelper);

        const result = await actions.waitForUrl({ url: 'https://example.com/*', timeout: 500 });

        expect(result).toBe('URL matched: https://example.com/success');
        expect(waitHelper._getCurrentUrl).toHaveBeenCalledTimes(1);
    });

    it('times out when the URL never matches', async () => {
        const waitHelper = {
            _getCurrentUrl: vi.fn(() => Promise.resolve('https://example.com/loading')),
        };
        const actions = new WaitActions({}, {}, waitHelper);

        const result = await actions.waitForUrl({ url: '*/done', timeout: 200 });

        expect(result).toMatch(/Timed out/);
        expect(result).toContain('*/done');
    });

    it('errors on a missing pattern', async () => {
        const actions = new WaitActions({}, {}, {});
        const result = await actions.waitForUrl({ timeout: 100 });
        expect(result).toMatch(/Error/);
    });
});

describe('WaitActions.waitForLoadState', () => {
    it('enables the Page domain and waits for the requested event', async () => {
        const connection = { sendCommand: vi.fn(() => Promise.resolve({})) };
        const waitHelper = { _waitForEvent: vi.fn(() => Promise.resolve(true)) };
        const actions = new WaitActions(connection, {}, waitHelper);

        const result = await actions.waitForLoadState({ state: 'load', timeout: 500 });

        expect(connection.sendCommand).toHaveBeenCalledWith('Page.enable', {});
        const [matcher] = waitHelper._waitForEvent.mock.calls[0];
        expect(matcher('Page.loadEventFired')).toBe(true);
        expect(matcher('Page.domContentEventFired')).toBe(false);
        expect(result).toBe('Reached load state');
    });

    it('targets domContentEventFired for the domcontentloaded state', async () => {
        const connection = { sendCommand: vi.fn(() => Promise.resolve({})) };
        const waitHelper = { _waitForEvent: vi.fn(() => Promise.resolve(false)) };
        const actions = new WaitActions(connection, {}, waitHelper);

        const result = await actions.waitForLoadState({ state: 'domcontentloaded', timeout: 200 });

        const [matcher] = waitHelper._waitForEvent.mock.calls[0];
        expect(matcher('Page.domContentEventFired')).toBe(true);
        expect(result).toMatch(/Timed out/);
    });
});

describe('WaitActions.waitForTimeout', () => {
    it('waits the requested duration and reports it', async () => {
        const actions = new WaitActions({}, {}, {});
        const start = Date.now();
        const result = await actions.waitForTimeout({ timeout: 120 });
        expect(Date.now() - start).toBeGreaterThanOrEqual(110);
        expect(result).toBe('Waited 120ms');
    });

    it('caps absurd timeouts at 30 seconds', async () => {
        vi.useFakeTimers();
        try {
            const actions = new WaitActions({}, {}, {});
            const pending = actions.waitForTimeout({ timeout: 9_999_999 });
            await vi.advanceTimersByTimeAsync(30_010);
            expect(await pending).toBe('Waited 30000ms');
        } finally {
            vi.useRealTimers();
        }
    });
});
