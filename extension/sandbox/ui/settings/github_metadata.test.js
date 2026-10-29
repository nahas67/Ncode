import { describe, expect, it, vi } from 'vitest';

import { compareVersionStrings, fetchGithubMetadata } from './github_metadata.js';

describe('github metadata helpers', () => {
    it('compares version labels with or without a v prefix', () => {
        expect(compareVersionStrings('v1.2.3', '1.2.2')).toBe(1);
        expect(compareVersionStrings('1.2.3', 'v1.2.3')).toBe(0);
        expect(compareVersionStrings('v1.2.0', 'v1.3.0')).toBe(-1);
    });

    it('loads stars and latest release metadata in parallel', async () => {
        const fetchImpl = vi.fn(async (url) => {
            if (String(url).endsWith('/releases/latest')) {
                return {
                    ok: true,
                    json: async () => ({ tag_name: 'v9.9.9' }),
                };
            }

            return {
                ok: true,
                json: async () => ({ stargazers_count: 42 }),
            };
        });

        await expect(fetchGithubMetadata(fetchImpl)).resolves.toEqual({
            stars: 42,
            latestVersion: 'v9.9.9',
        });
        expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it('keeps the available result when one metadata request fails', async () => {
        const fetchImpl = vi.fn(async (url) => {
            if (String(url).endsWith('/releases/latest')) {
                return {
                    ok: true,
                    json: async () => ({ tag_name: 'v9.9.9' }),
                };
            }

            throw new Error('stars unavailable');
        });

        await expect(fetchGithubMetadata(fetchImpl)).resolves.toEqual({
            stars: null,
            latestVersion: 'v9.9.9',
        });
    });
});
