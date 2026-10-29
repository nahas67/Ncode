// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';
import { createGeneratedImagesGrid, createUserImagesGrid } from './message_media.js';

vi.mock('./generated_image.js', () => ({
    createGeneratedImage: vi.fn((image) => {
        const img = document.createElement('img');
        img.dataset.generatedUrl = image.url;
        return img;
    }),
}));

describe('message media helpers', () => {
    it('creates a user image grid and dispatches view events on click', () => {
        const received = [];
        document.addEventListener(
            'gemini-view-image',
            (event) => {
                received.push(event.detail);
            },
            { once: true }
        );

        const grid = createUserImagesGrid(['data:image/png;base64,a', 'data:image/png;base64,b']);
        const images = grid.querySelectorAll('img');

        expect(grid.className).toBe('user-images-grid');
        expect(grid.hasAttribute('style')).toBe(false);
        expect(images).toHaveLength(2);
        expect(images[0].className).toBe('chat-image chat-image-compact');
        expect(images[0].hasAttribute('style')).toBe(false);

        images[0].dispatchEvent(new Event('click'));

        expect(received).toEqual(['data:image/png;base64,a']);
    });

    it('returns null for user image input without string sources', () => {
        expect(createUserImagesGrid([{ url: 'not-for-user-grid' }])).toBeNull();
    });

    it('renders non-image user attachments as file cards without image tags', () => {
        const grid = createUserImagesGrid([
            {
                base64: 'data:application/pdf;base64,AAAA',
                type: 'application/pdf',
                name: '<report>.pdf',
            },
        ]);

        expect(grid.className).toBe('user-images-grid');
        expect(grid.querySelectorAll('img')).toHaveLength(0);

        const card = grid.querySelector('.chat-file-card');
        expect(card).toBeTruthy();
        expect(card.querySelector('.chat-file-name').textContent).toBe('<report>.pdf');
        expect(card.querySelector('.chat-file-type').textContent).toBe('application/pdf');
    });

    it('creates a generated image grid from every generated image object', () => {
        const grid = createGeneratedImagesGrid([
            { url: 'first.png', alt: 'first' },
            { url: 'second.png', alt: 'second' },
        ]);

        expect(grid.className).toBe('generated-images-grid');
        expect([...grid.querySelectorAll('img')].map((img) => img.dataset.generatedUrl)).toEqual([
            'first.png',
            'second.png',
        ]);
    });

    it('returns null for generated images without object attachments', () => {
        expect(createGeneratedImagesGrid(['data:image/png;base64,a'])).toBeNull();
        expect(createGeneratedImagesGrid([])).toBeNull();
    });
});
