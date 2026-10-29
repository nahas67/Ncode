import { describe, expect, it } from 'vitest';
import {
    buildChromeWebStoreUrls,
    getChromeWebStoreConfig,
    maskSecret,
} from './chrome-webstore-publish.mjs';

describe('chrome-webstore-publish', () => {
    it('builds Chrome Web Store upload and publish URLs from publisher and item ids', () => {
        expect(
            buildChromeWebStoreUrls({
                publisherId: '1234567890',
                itemId: 'abcdefghijklmnopabcdefghijklmnop',
            })
        ).toEqual({
            upload: 'https://chromewebstore.googleapis.com/upload/v2/publishers/1234567890/items/abcdefghijklmnopabcdefghijklmnop:upload',
            publish:
                'https://chromewebstore.googleapis.com/v2/publishers/1234567890/items/abcdefghijklmnopabcdefghijklmnop:publish',
        });
    });

    it('loads the required publishing configuration from environment variables', () => {
        expect(
            getChromeWebStoreConfig({
                CHROME_WEBSTORE_PUBLISHER_ID: '1234567890',
                CHROME_WEBSTORE_ITEM_ID: 'abcdefghijklmnopabcdefghijklmnop',
                CHROME_WEBSTORE_ACCESS_TOKEN: 'ya29.secret-token',
                CHROME_WEBSTORE_ZIP_PATH: '/tmp/extension.zip',
            })
        ).toEqual({
            publisherId: '1234567890',
            itemId: 'abcdefghijklmnopabcdefghijklmnop',
            accessToken: 'ya29.secret-token',
            zipPath: '/tmp/extension.zip',
        });
    });

    it('reports missing required configuration without printing secret values', () => {
        expect(() =>
            getChromeWebStoreConfig({
                CHROME_WEBSTORE_ACCESS_TOKEN: 'ya29.secret-token',
            })
        ).toThrow(/CHROME_WEBSTORE_PUBLISHER_ID, CHROME_WEBSTORE_ITEM_ID/);

        expect(maskSecret('ya29.secret-token')).toBe('ya29...oken');
    });
});
