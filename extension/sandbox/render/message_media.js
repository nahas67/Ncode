import { createGeneratedImage } from './generated_image.js';
import { normalizeUserAttachments } from '../../shared/attachments/index.js';

export function createUserImagesGrid(attachment) {
    const userAttachments = normalizeUserAttachments(attachment);
    if (userAttachments.length === 0) return null;

    const imagesContainer = document.createElement('div');
    imagesContainer.className = 'user-images-grid';

    userAttachments.forEach((file) => {
        if (!file.type.startsWith('image/')) {
            const card = document.createElement('div');
            card.className = 'chat-file-card';

            const icon = document.createElement('span');
            icon.className = 'chat-file-icon';
            icon.textContent = 'FILE';

            const details = document.createElement('span');
            details.className = 'chat-file-details';

            const name = document.createElement('span');
            name.className = 'chat-file-name';
            name.textContent = file.name;

            const type = document.createElement('span');
            type.className = 'chat-file-type';
            type.textContent = file.type;

            details.appendChild(name);
            details.appendChild(type);
            card.appendChild(icon);
            card.appendChild(details);
            imagesContainer.appendChild(card);
            return;
        }

        const src = file.base64;
        const imageElement = document.createElement('img');
        imageElement.src = src;
        imageElement.className =
            userAttachments.length > 1 ? 'chat-image chat-image-compact' : 'chat-image';

        imageElement.addEventListener('click', () => {
            document.dispatchEvent(new CustomEvent('gemini-view-image', { detail: src }));
        });
        imagesContainer.appendChild(imageElement);
    });

    return imagesContainer;
}

export function createGeneratedImagesGrid(attachment) {
    if (!Array.isArray(attachment) || attachment.length === 0) {
        return null;
    }

    const generatedImages = attachment.filter(
        (item) => item && typeof item === 'object' && typeof item.url === 'string'
    );
    if (generatedImages.length === 0) {
        return null;
    }

    const grid = document.createElement('div');
    grid.className = 'generated-images-grid';
    generatedImages.forEach((image) => {
        grid.appendChild(createGeneratedImage(image));
    });
    return grid;
}
