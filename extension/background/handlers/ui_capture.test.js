import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleProcessCropInSidePanel } from './ui_capture.js';

describe('handleProcessCropInSidePanel forwarding', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    function setup() {
        const sendMessage = vi.fn(async () => {});
        vi.stubGlobal('chrome', { runtime: { sendMessage } });
        const context = { getTargetSidePanelTabId: vi.fn(() => 7) };
        return { sendMessage, context };
    }

    async function waitForResponse(sendResponse) {
        await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledTimes(1));
        return sendResponse.mock.calls[0][0];
    }

    it('fixes the broadcast action instead of rebroadcasting sender input', async () => {
        const { sendMessage, context } = setup();
        const sendResponse = vi.fn();

        handleProcessCropInSidePanel(
            context,
            {
                action: 'PROCESS_CROP_IN_SIDEPANEL',
                payload: {
                    action: 'SEND_PROMPT',
                    text: 'pwned',
                    area: { x: 1, y: 2 },
                    image: 'base64data',
                    mode: 'ocr',
                    imageType: 'png',
                    tabId: 9,
                },
            },
            {},
            sendResponse
        );

        await waitForResponse(sendResponse);
        expect(sendMessage).toHaveBeenCalledTimes(1);
        expect(sendMessage.mock.calls[0][0]).toEqual({
            action: 'CROP_SCREENSHOT',
            area: { x: 1, y: 2 },
            image: 'base64data',
            mode: 'ocr',
            imageType: 'png',
            tabId: 9,
        });
    });

    it('falls back to the contextual tab when the payload has no tabId', async () => {
        const { sendMessage, context } = setup();
        const sendResponse = vi.fn();

        handleProcessCropInSidePanel(
            context,
            { action: 'PROCESS_CROP_IN_SIDEPANEL', payload: { image: 'base64data' } },
            {},
            sendResponse
        );

        await waitForResponse(sendResponse);
        expect(sendMessage.mock.calls[0][0]).toMatchObject({
            action: 'CROP_SCREENSHOT',
            tabId: 7,
        });
    });
});
