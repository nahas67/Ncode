import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setupMessageListener } from './messages.js';

describe('setupMessageListener request guard', () => {
    let messageListener;

    beforeEach(() => {
        vi.clearAllMocks();
        messageListener = null;
        globalThis.chrome = {
            tabs: {
                onRemoved: { addListener: vi.fn() },
            },
            runtime: {
                onMessage: {
                    addListener: vi.fn((listener) => {
                        messageListener = listener;
                    }),
                },
            },
        };
        setupMessageListener({}, {}, {}, {}, { getLogs: () => [] }, {});
    });

    it('drops null and non-object requests without throwing', () => {
        const sendResponse = vi.fn();

        expect(messageListener(null, {}, sendResponse)).toBe(false);
        expect(messageListener('SEND_PROMPT', {}, sendResponse)).toBe(false);
        expect(messageListener(42, {}, sendResponse)).toBe(false);
        expect(messageListener({ action: null }, {}, sendResponse)).toBe(false);
        expect(sendResponse).not.toHaveBeenCalled();
    });

    it('still routes well-formed requests', () => {
        const sendResponse = vi.fn();

        messageListener({ action: 'GET_LOGS' }, {}, sendResponse);

        expect(sendResponse).toHaveBeenCalledWith({ logs: [] });
    });
});
