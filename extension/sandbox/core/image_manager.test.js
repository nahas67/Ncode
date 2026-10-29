// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';
import { ImageManager } from './image_manager.js';

function createHarness() {
    document.body.innerHTML = `
        <input id="image-input" type="file">
        <div id="image-preview"></div>
        <div id="input-wrapper"></div>
        <textarea id="prompt"></textarea>
    `;

    const manager = new ImageManager({
        imageInput: document.getElementById('image-input'),
        imagePreview: document.getElementById('image-preview'),
        inputWrapper: document.getElementById('input-wrapper'),
        inputFn: document.getElementById('prompt'),
    });

    vi.spyOn(manager.inputFn, 'focus').mockImplementation(() => {});
    return manager;
}

describe('ImageManager', () => {
    it('renders non-image file names as text, not HTML', () => {
        const manager = createHarness();

        manager.addFile(
            'data:application/pdf;base64,AAAA',
            'application/pdf',
            '<img src=x onerror=alert(1)>spec.pdf'
        );

        const card = document.querySelector('.file-item-card');
        expect(card).toBeTruthy();
        expect(card.querySelector('img')).toBeNull();
        expect(card.querySelector('span').textContent).toBe('<img src=x onerror=alert(1)>spec.pdf');
    });

    it('renders preview remove controls as accessible composer buttons', () => {
        const manager = createHarness();

        manager.addFile('data:image/png;base64,AAAA', 'image/png', 'sample.png');

        const removeButton = document.querySelector('.preview-remove-btn');
        expect(removeButton.tagName).toBe('BUTTON');
        expect(removeButton.type).toBe('button');
        expect(removeButton.getAttribute('aria-label')).toBe('Remove attachment');
    });

    it('notifies when attachment list changes', () => {
        document.body.innerHTML = `
            <input id="image-input" type="file">
            <div id="image-preview"></div>
            <div id="input-wrapper"></div>
            <textarea id="prompt"></textarea>
        `;
        const onFilesChanged = vi.fn();
        const manager = new ImageManager(
            {
                imageInput: document.getElementById('image-input'),
                imagePreview: document.getElementById('image-preview'),
                inputWrapper: document.getElementById('input-wrapper'),
                inputFn: document.getElementById('prompt'),
            },
            { onFilesChanged }
        );
        vi.spyOn(manager.inputFn, 'focus').mockImplementation(() => {});

        manager.addFile('data:image/png;base64,AAAA', 'image/png', 'sample.png');
        expect(onFilesChanged).toHaveBeenLastCalledWith(true, expect.any(Array));

        manager.clearFile();
        expect(onFilesChanged).toHaveBeenLastCalledWith(false, []);
    });
});
