import { describe, expect, it, vi } from 'vitest';

import { SessionMessageHandler } from './index.js';

function createHandler() {
    return new SessionMessageHandler({}, {}, null, null, {});
}

describe('SessionMessageHandler.resumeAfterCompaction', () => {
    it('starts a goal-mode run hydrated with the compacted checkpoint', () => {
        const handler = createHandler();
        const handleSpy = vi.spyOn(handler.promptHandler, 'handle').mockReturnValue(true);

        expect(
            handler.resumeAfterCompaction({
                sessionId: 'session-1',
                hydrationText: 'HYDRATE: pending subgoals [build, test]',
            })
        ).toBe(true);

        expect(handleSpy).toHaveBeenCalledTimes(1);
        const [request, sendResponse] = handleSpy.mock.calls[0];
        expect(request).toMatchObject({
            action: 'SEND_PROMPT',
            sessionId: 'session-1',
            ncodeGoalMode: true,
            ncodeResumeHydration: 'HYDRATE: pending subgoals [build, test]',
            internalResume: true,
            enableBrowserControl: false,
        });
        expect(typeof sendResponse).toBe('function');
    });

    it('falls back to a plain continuation prompt when no hydration is available', () => {
        const handler = createHandler();
        const handleSpy = vi.spyOn(handler.promptHandler, 'handle').mockReturnValue(true);

        handler.resumeAfterCompaction({ sessionId: 'session-2', hydrationText: '   ' });

        const [request] = handleSpy.mock.calls[0];
        expect(request.text).toBe('Continue the task from the compacted checkpoint.');
        expect(request.ncodeResumeHydration).toBe('');
    });

    it('does nothing without a session id', () => {
        const handler = createHandler();
        const handleSpy = vi.spyOn(handler.promptHandler, 'handle').mockReturnValue(true);

        expect(handler.resumeAfterCompaction({ hydrationText: 'HYDRATE' })).toBe(false);
        expect(handleSpy).not.toHaveBeenCalled();
    });
});
