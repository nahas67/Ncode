export async function captureDisplayStill() {
    const mediaDevices = navigator.mediaDevices;
    if (!mediaDevices || typeof mediaDevices.getDisplayMedia !== 'function') {
        throw new Error('Screen capture is not supported in this browser.');
    }

    const stream = await mediaDevices.getDisplayMedia({
        video: true,
        audio: false,
    });

    try {
        const video = document.createElement('video');
        video.srcObject = stream;
        video.muted = true;
        video.playsInline = true;

        const metadataReady = new Promise((resolve, reject) => {
            const cleanup = () => {
                video.removeEventListener('loadedmetadata', handleReady);
                video.removeEventListener('error', handleError);
            };
            const handleReady = () => {
                cleanup();
                resolve();
            };
            const handleError = () => {
                cleanup();
                reject(new Error('Failed to read selected screen.'));
            };

            video.addEventListener('loadedmetadata', handleReady, { once: true });
            video.addEventListener('error', handleError, { once: true });
        });
        await video.play();
        await metadataReady;

        const width = video.videoWidth || 1;
        const height = video.videoHeight || 1;
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Failed to prepare screen capture.');
        context.drawImage(video, 0, 0, width, height);

        return {
            action: 'FETCH_IMAGE_RESULT',
            base64: canvas.toDataURL('image/png'),
            type: 'image/png',
            name: 'screen_capture.png',
        };
    } finally {
        stream.getTracks().forEach((track) => track.stop());
    }
}
