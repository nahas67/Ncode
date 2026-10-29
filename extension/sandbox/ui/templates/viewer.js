import { TemplateIcons } from './icons.js';

export const ViewerTemplate = `
    <!-- IMAGE VIEWER -->
    <div id="image-viewer" class="image-viewer">
        <div class="viewer-container" id="viewer-container">
            <img class="viewer-content" id="full-image" draggable="false" referrerpolicy="no-referrer">
        </div>

        <div class="viewer-toolbar">
            <button id="viewer-zoom-out" data-i18n-title="zoomOut" title="Zoom Out (Scroll Down)">
                ${TemplateIcons.ZOOM_OUT}
            </button>
            <span id="viewer-zoom-level">100%</span>
            <button id="viewer-zoom-in" data-i18n-title="zoomIn" title="Zoom In (Scroll Up)">
                ${TemplateIcons.ZOOM_IN}
            </button>
            <div class="viewer-divider"></div>
            <button id="viewer-reset" data-i18n-title="resetZoom" title="Fit to Screen (Double Click)">
                ${TemplateIcons.FIT_TO_SCREEN}
            </button>
            <button id="viewer-download" data-i18n-title="downloadImage" title="Download Image">
                ${TemplateIcons.DOWNLOAD}
            </button>
            <div class="viewer-divider"></div>
            <button id="viewer-close" data-i18n-title="close" title="Close (Esc)">
                ${TemplateIcons.CLOSE}
            </button>
        </div>
    </div>
`;
