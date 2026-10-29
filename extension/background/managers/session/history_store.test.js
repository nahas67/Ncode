import { afterEach, describe, expect, it, vi } from 'vitest';
import { getHistory } from './history_store.js';

describe('history_store', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('reads the session message history by sessionId', async () => {
        globalThis.chrome = {
            storage: {
                local: {
                    get: vi.fn().mockResolvedValue({
                        geminiSessions: [
                            { id: 'sess-1', messages: [{ role: 'user', text: 'hi' }] },
                        ],
                    }),
                },
            },
        };

        await expect(getHistory('sess-1')).resolves.toEqual([{ role: 'user', text: 'hi' }]);
    });

    it('returns an empty array when no sessionId is given', async () => {
        await expect(getHistory(null)).resolves.toEqual([]);
    });

    it('returns an empty array and does not throw when storage rejects', async () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        globalThis.chrome = {
            storage: { local: { get: vi.fn().mockRejectedValue(new Error('quota')) } },
        };

        await expect(getHistory('sess-1')).resolves.toEqual([]);
        expect(warnSpy).toHaveBeenCalled();
    });
});
