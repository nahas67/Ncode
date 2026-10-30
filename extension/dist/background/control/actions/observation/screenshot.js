import { BaseActionHandler } from '../base.js';

// Mirrors BCB's tab_screenshot via CDP Page.captureScreenshot. Returns
// { text, image } so tool_executor turns `image` (raw base64 PNG) into a
// Gemini image part. Supports fullPage (captureBeyondViewport) and an
// optional crop clip (viewport coordinates).
export class ScreenshotActions extends BaseActionHandler {
    async takeScreenshot({ fullPage = false, x, y, width, height } = {}) {
        const params = { format: 'png' };

        const hasCrop =
            Number.isFinite(x) &&
            Number.isFinite(y) &&
            Number.isFinite(width) &&
            Number.isFinite(height);

        if (hasCrop) {
            params.clip = { x, y, width, height, scale: 1 };
        } else if (fullPage) {
            params.captureBeyondViewport = true;
        }

        let response;
        try {
            response = await this.cmd('Page.captureScreenshot', params);
        } catch (error) {
            return `Error capturing screenshot: ${error.message}`;
        }

        const data = response?.data;
        if (!data) {
            return 'Error: screenshot capture returned no image data.';
        }

        const mode = hasCrop ? 'cropped' : fullPage ? 'full page' : 'viewport';
        return {
            text: `Captured screenshot (${mode}).`,
            image: data,
        };
    }
}
