// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ViewerController } from './viewer.js';

function renderViewer() {
    document.body.innerHTML = `
        <div id="image-viewer" class="image-viewer">
            <div id="viewer-container"></div>
            <img id="full-image" />
            <button id="viewer-zoom-in"></button>
            <button id="viewer-zoom-out"></button>
            <button id="viewer-reset"></button>
            <button id="viewer-download"></button>
            <button id="viewer-close"><svg><path d="M0 0"></path></svg></button>
            <span id="viewer-zoom-level"></span>
        </div>
    `;
}

describe('ViewerController', () => {
    beforeEach(() => {
        vi.useRealTimers();
        renderViewer();
    });

    it('zooms and pans the active image viewer', () => {
        const controller = new ViewerController();

        document.dispatchEvent(
            new CustomEvent('gemini-view-image', {
                detail: 'data:image/png;base64,AAAA',
            })
        );

        const viewer = document.getElementById('image-viewer');
        const container = document.getElementById('viewer-container');
        const fullImage = document.getElementById('full-image');
        const zoomLabel = document.getElementById('viewer-zoom-level');

        expect(viewer.classList.contains('visible')).toBe(true);
        expect(fullImage.src).toBe('data:image/png;base64,AAAA');
        expect(zoomLabel.textContent).toBe('100%');

        container.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true }));

        expect(fullImage.style.transform).toContain('scale(1.1)');
        expect(zoomLabel.textContent).toBe('110%');

        container.dispatchEvent(
            new MouseEvent('mousedown', {
                button: 0,
                clientX: 30,
                clientY: 40,
                bubbles: true,
            })
        );
        document.dispatchEvent(
            new MouseEvent('mousemove', {
                clientX: 50,
                clientY: 65,
                bubbles: true,
            })
        );

        expect(fullImage.style.transform).toContain('translate(20px, 25px)');
        controller.endPan();
        expect(container.style.cursor).toBe('grab');
    });

    it('posts a download request to the parent window', () => {
        const postMessage = vi.spyOn(window.parent, 'postMessage').mockImplementation(() => {});
        const controller = new ViewerController();

        controller.open('data:image/png;base64,BBBB');
        document.getElementById('viewer-download').click();

        expect(postMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                action: 'DOWNLOAD_IMAGE',
                payload: expect.objectContaining({
                    url: 'data:image/png;base64,BBBB',
                    filename: expect.stringMatching(/^gemini-image-\d+\.png$/),
                }),
            }),
            '*'
        );
    });

    it('closes from the nested close icon without starting image panning', () => {
        const controller = new ViewerController();
        controller.open('data:image/png;base64,CCCC');

        const viewer = document.getElementById('image-viewer');
        const closeIconPath = document.querySelector('#viewer-close path');

        closeIconPath.dispatchEvent(
            new MouseEvent('mousedown', {
                button: 0,
                bubbles: true,
                cancelable: true,
            })
        );

        expect(controller.state.panning).toBe(false);

        closeIconPath.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

        expect(viewer.classList.contains('visible')).toBe(false);
    });
});
