export class ViewerController {
    constructor() {
        this.state = this.createInitialState();

        this.queryElements();
        this.initListeners();
    }

    createInitialState() {
        return {
            scale: 1,
            panning: false,
            pointX: 0,
            pointY: 0,
            startX: 0,
            startY: 0,
        };
    }

    queryElements() {
        this.viewer = document.getElementById('image-viewer');
        if (!this.viewer) return;

        this.container = document.getElementById('viewer-container');
        this.fullImage = document.getElementById('full-image');

        this.zoomInButton = document.getElementById('viewer-zoom-in');
        this.zoomOutButton = document.getElementById('viewer-zoom-out');
        this.resetButton = document.getElementById('viewer-reset');
        this.downloadButton = document.getElementById('viewer-download');
        this.closeButton = document.getElementById('viewer-close');
        this.zoomLabel = document.getElementById('viewer-zoom-level');
    }

    initListeners() {
        if (!this.viewer) return;

        this.container.addEventListener('mousedown', (event) => this.startPan(event));
        document.addEventListener('mousemove', (event) => this.pan(event));
        document.addEventListener('mouseup', () => this.endPan());
        this.container.addEventListener('wheel', (event) => this.handleWheel(event), {
            passive: false,
        });
        this.container.addEventListener('dblclick', (event) => {
            if (event.target === this.fullImage || event.target === this.container) {
                this.resetTransform();
            }
        });

        this.zoomInButton.addEventListener('click', () => this.zoomIn());
        this.zoomOutButton.addEventListener('click', () => this.zoomOut());
        this.resetButton.addEventListener('click', () => this.resetTransform());
        this.closeButton.addEventListener('mousedown', (event) => event.stopPropagation());
        this.closeButton.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            this.close();
        });
        this.downloadButton.addEventListener('click', () => this.downloadImage());

        this.viewer.addEventListener('click', (event) => {
            if (event.target === this.viewer) this.close();
        });

        document.addEventListener('gemini-view-image', (event) => {
            this.open(event.detail);
        });

        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape' && this.viewer.classList.contains('visible')) {
                this.close();
            }
        });
    }

    open(src) {
        if (this.fullImage) {
            this.fullImage.src = src;
            this.viewer.classList.add('visible');
            this.resetTransform();
        }
    }

    close() {
        if (this.viewer) {
            this.viewer.classList.remove('visible');
            setTimeout(() => {
                if (this.fullImage) this.fullImage.src = '';
                this.resetState();
            }, 200);
        }
    }

    resetState() {
        this.state = this.createInitialState();
    }

    resetTransform() {
        this.state.scale = 1;
        this.state.pointX = 0;
        this.state.pointY = 0;
        this.updateTransform();
    }

    updateTransform() {
        if (!this.fullImage) return;
        this.fullImage.style.transform = `translate(${this.state.pointX}px, ${this.state.pointY}px) scale(${this.state.scale})`;
        this.zoomLabel.textContent = `${Math.round(this.state.scale * 100)}%`;
    }

    handleWheel(event) {
        event.preventDefault();
        const delta = -Math.sign(event.deltaY);
        const step = 0.1;
        const newScale = this.state.scale + delta * step;
        this.setScale(newScale);
    }

    zoomIn() {
        this.setScale(this.state.scale + 0.25);
    }

    zoomOut() {
        this.setScale(this.state.scale - 0.25);
    }

    setScale(scale) {
        const min = 0.1;
        const max = 5;
        this.state.scale = Math.min(Math.max(scale, min), max);
        this.updateTransform();
    }

    startPan(event) {
        if (event.button !== 0 || event.target?.closest?.('#viewer-close')) return;
        event.preventDefault();
        this.state.panning = true;
        this.state.startX = event.clientX - this.state.pointX;
        this.state.startY = event.clientY - this.state.pointY;
        this.container.style.cursor = 'grabbing';
    }

    pan(event) {
        if (!this.state.panning) return;
        event.preventDefault();
        this.state.pointX = event.clientX - this.state.startX;
        this.state.pointY = event.clientY - this.state.startY;
        this.updateTransform();
    }

    endPan() {
        this.state.panning = false;
        this.container.style.cursor = 'grab';
    }

    downloadImage() {
        const src = this.fullImage.src;
        if (!src) return;

        window.parent.postMessage(
            {
                action: 'DOWNLOAD_IMAGE',
                payload: {
                    url: src,
                    filename: `gemini-image-${Date.now()}.png`,
                },
            },
            '*'
        );
    }
}
