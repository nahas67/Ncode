import { cropImage } from '../../shared/dom/crop_image.js';
import { WatermarkRemover } from '../../shared/media/watermark_remover.js';
import { t } from '../core/i18n.js';

export function handleImageFetchResult(request, { ui, imageManager }) {
    ui.updateStatus('');
    if (request.error) {
        console.error('Image fetch failed', request.error);
        ui.updateStatus(t('failedLoadImage'));
        setTimeout(() => ui.updateStatus(''), 3000);
        return;
    }

    imageManager.setFile(request.base64, request.type, request.name);
}

async function prepareGeneratedImageBase64(base64Image, { removeWatermark = true } = {}) {
    if (removeWatermark === false) return base64Image;

    try {
        return await WatermarkRemover.process(base64Image);
    } catch (error) {
        console.warn('Generated image watermark removal failed:', error);
        return base64Image;
    }
}

export async function handleGeneratedImageFetchResult(request, options = {}) {
    const imageElement = document.querySelector(`img[data-req-id="${request.reqId}"]`);
    if (!imageElement) return;

    if (request.base64) {
        imageElement.src = await prepareGeneratedImageBase64(request.base64, options);
        imageElement.classList.remove('loading');
        return;
    }

    imageElement.classList.remove('loading');
    imageElement.classList.add('load-error');
    imageElement.alt = 'Failed to load image';
    console.warn('Generated image load failed:', request.error);
}

export async function handleCropScreenshotResult(request, { ui, imageManager, app }) {
    ui.updateStatus(t('processingImage'));
    try {
        const croppedBase64 = await cropImage(request.image, request.area);
        imageManager.setFile(croppedBase64, 'image/png', 'snip.png');

        if (app.captureMode === 'ocr') {
            ui.inputFn.value = t('ocrPrompt');
            app.handleSendMessage();
            return;
        }

        if (app.captureMode === 'screenshot_translate') {
            ui.inputFn.value = t('screenshotTranslatePrompt');
            app.handleSendMessage();
            return;
        }

        ui.updateStatus('');
        ui.inputFn.focus();
    } catch (error) {
        console.error('Crop error', error);
        ui.updateStatus(t('errorScreenshot'));
    }
}

export function handleSelectionTextResult(request, { ui }) {
    if (request.text && request.text.trim()) {
        const quote = `> ${request.text.trim()}\n\n`;
        const input = ui.inputFn;
        input.value = input.value ? input.value + '\n\n' + quote : quote;
        input.focus();
        input.dispatchEvent(new Event('input'));
        return;
    }

    ui.updateStatus(t('noTextSelected'));
    setTimeout(() => ui.updateStatus(''), 2000);
}
