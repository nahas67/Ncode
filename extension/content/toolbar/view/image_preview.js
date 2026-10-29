(function () {
    const ICONS = window.GeminiToolbarIcons || {};

    class ImagePreviewController {
        constructor({ resultText, askWindow }) {
            this.resultText = resultText;
            this.askWindow = askWindow;
            this.imagePreview = null;
            this.previewImage = null;
            this.previewState = this.createInitialState();
            this.bindResultImagePreview();
        }

        createInitialState() {
            return {
                scale: 1,
                pointX: 0,
                pointY: 0,
                panning: false,
                startX: 0,
                startY: 0,
            };
        }

        bindResultImagePreview() {
            if (!this.resultText) return;

            this._boundResultClick = (event) => {
                const imageElement = event.target?.closest?.(
                    '.generated-image, .markdown-body img'
                );
                if (!imageElement || !this.resultText.contains(imageElement)) return;
                if (imageElement.classList.contains('loading')) return;

                const src = imageElement.currentSrc || imageElement.src;
                if (!src || src.startsWith('data:image/svg+xml')) return;

                event.preventDefault();
                event.stopPropagation();
                this.open(src, imageElement.alt || 'Image');
            };
            this.resultText.addEventListener('click', this._boundResultClick);
        }

        ensurePreview() {
            if (this.imagePreview) return this.imagePreview;

            const preview = document.createElement('div');
            preview.className = 'gemini-image-preview';
            preview.setAttribute('role', 'dialog');
            preview.setAttribute('aria-modal', 'true');
            preview.hidden = true;

            const image = document.createElement('img');
            image.className = 'gemini-image-preview-img';
            image.draggable = false;

            const closeButton = document.createElement('button');
            closeButton.type = 'button';
            closeButton.className = 'gemini-image-preview-close';
            closeButton.setAttribute('aria-label', 'Close image preview');
            closeButton.innerHTML = ICONS.CLOSE || 'x';

            preview.appendChild(image);
            preview.appendChild(closeButton);

            preview.addEventListener('click', (event) => {
                if (event.target === preview) this.close();
            });
            closeButton.addEventListener('mousedown', (event) => {
                event.stopPropagation();
            });
            closeButton.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                this.close();
            });
            preview.addEventListener('wheel', (event) => this.handleWheel(event), {
                passive: false,
            });
            preview.addEventListener('mousedown', (event) => this.startPan(event));

            // Keep bound references so the document-level listeners added on
            // first open can be removed again on destroy(). Previously these
            // were anonymous and only ever added, never removed — every
            // rebuild/language-change stacked another set on document.
            this._boundPan = (event) => this.pan(event);
            this._boundEndPan = () => this.endPan();
            this._boundKeyDown = (event) => {
                if (event.key === 'Escape' && preview.classList.contains('visible')) {
                    this.close();
                }
            };
            document.addEventListener('mousemove', this._boundPan);
            document.addEventListener('mouseup', this._boundEndPan);
            document.addEventListener('keydown', this._boundKeyDown);

            const parent = this.askWindow?.parentNode || document.body;
            parent.appendChild(preview);
            this.imagePreview = preview;
            this.previewImage = image;
            return preview;
        }

        destroy() {
            // Remove the document-level pan/keydown listeners that
            // ensurePreview() attached, so rebuilding the toolbar (e.g. on a
            // language change) does not leave orphaned listeners on document.
            if (this._boundPan) {
                document.removeEventListener('mousemove', this._boundPan);
                this._boundPan = null;
            }
            if (this._boundEndPan) {
                document.removeEventListener('mouseup', this._boundEndPan);
                this._boundEndPan = null;
            }
            if (this._boundKeyDown) {
                document.removeEventListener('keydown', this._boundKeyDown);
                this._boundKeyDown = null;
            }
            // Remove the resultText click delegation if we can identify it.
            if (this._boundResultClick && this.resultText) {
                this.resultText.removeEventListener('click', this._boundResultClick);
                this._boundResultClick = null;
            }
            // Drop the preview DOM so a stale element is not reused.
            if (this.imagePreview && this.imagePreview.isConnected) {
                this.imagePreview.remove();
            }
            this.imagePreview = null;
            this.previewImage = null;
            this.resetState();
        }

        open(src, alt) {
            const preview = this.ensurePreview();
            this.previewImage.src = src;
            this.previewImage.alt = alt;
            preview.hidden = false;
            preview.classList.add('visible');
            this.resetTransform();
        }

        close() {
            if (!this.imagePreview) return;
            this.imagePreview.classList.remove('visible');
            this.imagePreview.hidden = true;
            if (this.previewImage) this.previewImage.removeAttribute('src');
            this.resetState();
        }

        resetState() {
            this.previewState = this.createInitialState();
        }

        resetTransform() {
            this.previewState.scale = 1;
            this.previewState.pointX = 0;
            this.previewState.pointY = 0;
            this.updateTransform();
        }

        updateTransform() {
            if (!this.previewImage) return;
            const { pointX, pointY, scale } = this.previewState;
            this.previewImage.style.transform = `translate(${pointX}px, ${pointY}px) scale(${scale})`;
        }

        handleWheel(event) {
            event.preventDefault();
            const direction = event.deltaY < 0 ? 1 : -1;
            const nextScale = this.previewState.scale + direction * 0.1;
            this.previewState.scale = Math.min(Math.max(nextScale, 0.2), 5);
            this.updateTransform();
        }

        startPan(event) {
            if (event.button !== 0 || event.target?.closest?.('.gemini-image-preview-close')) {
                return;
            }
            event.preventDefault();
            this.previewState.panning = true;
            this.previewState.startX = event.clientX - this.previewState.pointX;
            this.previewState.startY = event.clientY - this.previewState.pointY;
            if (this.imagePreview) this.imagePreview.classList.add('is-panning');
        }

        pan(event) {
            if (!this.previewState.panning) return;
            event.preventDefault();
            this.previewState.pointX = event.clientX - this.previewState.startX;
            this.previewState.pointY = event.clientY - this.previewState.startY;
            this.updateTransform();
        }

        endPan() {
            this.previewState.panning = false;
            if (this.imagePreview) this.imagePreview.classList.remove('is-panning');
        }
    }

    window.GeminiImagePreviewController = ImagePreviewController;
})();
