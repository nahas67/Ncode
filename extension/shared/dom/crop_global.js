(function () {
    function cropImage(base64, area) {
        return new Promise((resolve, reject) => {
            // Validate area to avoid OOM / NaN canvas
            const rawX = Number(area?.x);
            const rawY = Number(area?.y);
            const rawW = Number(area?.width);
            const rawH = Number(area?.height);
            let rawScale = Number(area?.pixelRatio) || 1;
            if (
                !Number.isFinite(rawX) ||
                !Number.isFinite(rawY) ||
                !Number.isFinite(rawW) ||
                !Number.isFinite(rawH)
            ) {
                reject(new Error('Invalid crop area: non-finite coordinates.'));
                return;
            }
            if (rawW <= 0 || rawH <= 0) {
                reject(new Error('Invalid crop area: width/height must be > 0.'));
                return;
            }
            // Clamp scale and limit canvas to ~16MP to avoid OOM
            rawScale = Math.min(Math.max(rawScale, 0.5), 3);
            const MAX_PIXELS = 16 * 1024 * 1024;
            let w = Math.round(rawW * rawScale);
            let h = Math.round(rawH * rawScale);
            const pixels = w * h;
            if (pixels > MAX_PIXELS) {
                const factor = Math.sqrt(MAX_PIXELS / pixels);
                w = Math.round(w * factor);
                h = Math.round(h * factor);
            }
            if (typeof base64 !== 'string' || base64.length > 20 * 1024 * 1024) {
                reject(new Error('Invalid or too large image data for cropping.'));
                return;
            }
            const imageElement = new Image();
            let timedOut = false;
            const timer = setTimeout(() => {
                timedOut = true;
                imageElement.src = '';
                reject(new Error('Image load timeout for cropping.'));
            }, 10000);
            imageElement.onload = () => {
                clearTimeout(timer);
                if (timedOut) return;
                const canvas = document.createElement('canvas');
                const canvasContext = canvas.getContext('2d');
                if (!canvasContext) {
                    reject(new Error('Canvas 2D context is unavailable.'));
                    return;
                }

                const scale = rawScale;
                canvas.width = w;
                canvas.height = h;

                canvasContext.drawImage(
                    imageElement,
                    rawX * scale,
                    rawY * scale,
                    rawW * scale,
                    rawH * scale,
                    0,
                    0,
                    canvas.width,
                    canvas.height
                );

                // A cross-origin image (no CORS) taints the canvas, so
                // toDataURL() throws a SecurityError. Previously this threw
                // out of the onload handler as an uncaught rejection with no
                // user feedback. Catch it here and surface a clear error so
                // the caller can show the user that this image can't be cropped
                // instead of failing silently.
                try {
                    resolve(canvas.toDataURL('image/png'));
                } catch (error) {
                    const reason =
                        error?.name === 'SecurityError' ||
                        /taint|security/i.test(error?.message || '')
                            ? 'This cross-origin image cannot be cropped due to browser security (canvas taint).'
                            : error?.message || 'Failed to read cropped image from canvas.';
                    reject(new Error(reason));
                }
            };
            imageElement.onerror = () => {
                clearTimeout(timer);
                reject(new Error('Failed to load image for cropping.'));
            };
            imageElement.src = base64;
        });
    }

    globalThis.GeminiNexusCrop = {
        ...(globalThis.GeminiNexusCrop || {}),
        cropImage,
    };
})();
