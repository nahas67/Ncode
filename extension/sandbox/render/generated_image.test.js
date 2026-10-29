// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sendToBackground } from '../../shared/messaging/index.js';
import { getHighResImageUrl } from '../../shared/utils/index.js';
import { createGeneratedImage } from './generated_image.js';

vi.mock('../../shared/messaging/index.js', () => ({
    sendToBackground: vi.fn(),
}));

vi.mock('../../shared/utils/index.js', () => ({
    createPrefixedId: (prefix) => `${prefix}_1`,
    getHighResImageUrl: vi.fn((url) => `high-res:${url}`),
}));

vi.mock('../core/i18n.js', () => ({
    t: (key) => key,
}));

describe('createGeneratedImage', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('uses CSS classes for its loading placeholder presentation', () => {
        const image = createGeneratedImage({
            url: 'https://example.test/generated.png',
            alt: 'Generated preview',
        });

        expect(image.className).toBe('generated-image loading');
        expect(image.hasAttribute('style')).toBe(false);
        expect(image.alt).toBe('Generated preview');
        expect(getHighResImageUrl).toHaveBeenCalledWith('https://example.test/generated.png');
        expect(sendToBackground).toHaveBeenCalledWith({
            action: 'FETCH_GENERATED_IMAGE',
            url: 'high-res:https://example.test/generated.png',
            reqId: image.dataset.reqId,
        });
    });
});
