import { describe, expect, it, vi } from 'vitest';
import { ScreenshotActions } from './screenshot.js';

function createActions(captureResponse) {
    const connection = { sendCommand: vi.fn(() => Promise.resolve(captureResponse)) };
    return { actions: new ScreenshotActions(connection, {}, {}), connection };
}

describe('ScreenshotActions.takeScreenshot', () => {
    it('captures the viewport by default and returns { text, image }', async () => {
        const { actions, connection } = createActions({ data: 'BASE64PNG' });

        const result = await actions.takeScreenshot({});

        expect(result).toEqual({ text: 'Captured screenshot (viewport).', image: 'BASE64PNG' });
        expect(connection.sendCommand).toHaveBeenCalledWith('Page.captureScreenshot', {
            format: 'png',
        });
    });

    it('uses captureBeyondViewport for fullPage', async () => {
        const { actions, connection } = createActions({ data: 'X' });

        await actions.takeScreenshot({ fullPage: true });

        expect(connection.sendCommand).toHaveBeenCalledWith('Page.captureScreenshot', {
            format: 'png',
            captureBeyondViewport: true,
        });
    });

    it('uses a clip when crop coordinates are provided', async () => {
        const { actions, connection } = createActions({ data: 'X' });

        await actions.takeScreenshot({ x: 10, y: 20, width: 100, height: 50 });

        expect(connection.sendCommand).toHaveBeenCalledWith('Page.captureScreenshot', {
            format: 'png',
            clip: { x: 10, y: 20, width: 100, height: 50, scale: 1 },
        });
    });

    it('returns an error string when no image data comes back', async () => {
        const { actions } = createActions({});

        const result = await actions.takeScreenshot({});

        expect(result).toMatch(/no image data/);
    });

    it('surfaces capture failures as an error string', async () => {
        const connection = {
            sendCommand: vi.fn(() => Promise.reject(new Error('no target'))),
        };
        const actions = new ScreenshotActions(connection, {}, {});

        const result = await actions.takeScreenshot({});

        expect(result).toMatch(/Error capturing screenshot/);
    });
});
