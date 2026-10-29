// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cropImage } from '../../shared/dom/crop_image.js';
import { WatermarkRemover } from '../../shared/media/watermark_remover.js';
import {
    handleCropScreenshotResult,
    handleGeneratedImageFetchResult,
    handleImageFetchResult,
    handleSelectionTextResult,
} from './message_results.js';

vi.mock('../../shared/dom/crop_image.js', () => ({
    cropImage: vi.fn(),
}));

vi.mock('../../shared/media/watermark_remover.js', () => ({
    WatermarkRemover: {
        process: vi.fn((base64Image) =>
            Promise.resolve(base64Image.replace('raw-image', 'clean-image'))
        ),
    },
}));

vi.mock('../core/i18n.js', () => ({
    t: (key) => key,
}));

function createUiHarness() {
    return {
        inputFn: document.createElement('textarea'),
        updateStatus: vi.fn(),
    };
}

describe('message result helpers', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        document.body.innerHTML = '';
    });

    it('stores fetched user images on success', () => {
        const ui = createUiHarness();
        const imageManager = { setFile: vi.fn() };

        handleImageFetchResult(
            { base64: 'data:image/png;base64,abc', type: 'image/png', name: 'shot.png' },
            { ui, imageManager }
        );

        expect(ui.updateStatus).toHaveBeenCalledWith('');
        expect(imageManager.setFile).toHaveBeenCalledWith(
            'data:image/png;base64,abc',
            'image/png',
            'shot.png'
        );
    });

    it('auto-cleans fetched generated images and removes their loading state', async () => {
        document.body.innerHTML = '<img data-req-id="req-1" class="generated-image loading">';

        await handleGeneratedImageFetchResult({
            reqId: 'req-1',
            base64: 'data:image/png;base64,raw-image',
        });

        const imageElement = document.querySelector('img[data-req-id="req-1"]');
        expect(WatermarkRemover.process).toHaveBeenCalledWith('data:image/png;base64,raw-image');
        expect(imageElement.src).toContain('data:image/png;base64,clean-image');
        expect(imageElement.classList.contains('loading')).toBe(false);
        expect(imageElement.hasAttribute('style')).toBe(false);
    });

    it('keeps generated image pixels untouched when auto-clean is disabled', async () => {
        document.body.innerHTML = '<img data-req-id="req-1" class="generated-image loading">';

        await handleGeneratedImageFetchResult(
            {
                reqId: 'req-1',
                base64: 'data:image/png;base64,raw-image',
            },
            { removeWatermark: false }
        );

        const imageElement = document.querySelector('img[data-req-id="req-1"]');
        expect(WatermarkRemover.process).not.toHaveBeenCalled();
        expect(imageElement.src).toContain('data:image/png;base64,raw-image');
        expect(imageElement.classList.contains('loading')).toBe(false);
    });

    it('runs OCR captures through the cropped image and sends the prompt', async () => {
        cropImage.mockResolvedValue('cropped-image');
        const ui = createUiHarness();
        const imageManager = { setFile: vi.fn() };
        const app = {
            captureMode: 'ocr',
            handleSendMessage: vi.fn(),
        };

        await handleCropScreenshotResult(
            { image: 'screen-image', area: { x: 1, y: 2, width: 3, height: 4 } },
            { ui, imageManager, app }
        );

        expect(cropImage).toHaveBeenCalledWith('screen-image', { x: 1, y: 2, width: 3, height: 4 });
        expect(imageManager.setFile).toHaveBeenCalledWith('cropped-image', 'image/png', 'snip.png');
        expect(ui.inputFn.value).toBe('ocrPrompt');
        expect(app.handleSendMessage).toHaveBeenCalled();
    });

    it('quotes selected text into the input', () => {
        const ui = createUiHarness();
        ui.inputFn.value = 'Existing prompt';
        const focus = vi.spyOn(ui.inputFn, 'focus');
        const dispatch = vi.spyOn(ui.inputFn, 'dispatchEvent');

        handleSelectionTextResult({ text: ' selected text ' }, { ui });

        expect(ui.inputFn.value).toBe('Existing prompt\n\n> selected text\n\n');
        expect(focus).toHaveBeenCalled();
        expect(dispatch).toHaveBeenCalledWith(expect.any(Event));
    });
});
