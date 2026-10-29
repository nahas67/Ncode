import { describe, expect, it } from 'vitest';

import { createPrefixedId, dataUrlToBlob } from './index.js';

describe('shared utils', () => {
    it('creates readable prefixed IDs for DOM and request correlation', () => {
        const id = createPrefixedId('gen_img');

        expect(id).toMatch(/^gen_img_[A-Z0-9-]+$/);
    });

    it('decodes small data URLs to blobs', async () => {
        const blob = await dataUrlToBlob('data:image/png;base64,AAAA');

        expect(blob).toBeInstanceOf(Blob);
        expect(blob.type).toBe('image/png');
        expect(blob.size).toBe(3);
    });

    it('refuses to decode payloads over the byte limit', async () => {
        await expect(dataUrlToBlob('data:image/png;base64,' + 'A'.repeat(100), 10)).rejects.toThrow(
            /too large/i
        );
    });
});
