import { sendToBackground } from '../../shared/messaging/index.js';
import { createPrefixedId, getHighResImageUrl } from '../../shared/utils/index.js';
import { t } from '../core/i18n.js';

export function createGeneratedImage(imageData) {
    const imageElement = document.createElement('img');
    imageElement.className = 'generated-image loading';
    imageElement.alt = imageData.alt || t('generatedImage');

    imageElement.src =
        'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxIDEiPjwvc3ZnPg==';

    const requestId = createPrefixedId('gen_img');
    imageElement.dataset.reqId = requestId;

    const targetUrl = getHighResImageUrl(imageData.url);

    sendToBackground({
        action: 'FETCH_GENERATED_IMAGE',
        url: targetUrl,
        reqId: requestId,
    });

    imageElement.addEventListener('click', () => {
        if (imageElement.src && !imageElement.src.startsWith('data:image/svg')) {
            document.dispatchEvent(
                new CustomEvent('gemini-view-image', { detail: imageElement.src })
            );
        }
    });

    return imageElement;
}
