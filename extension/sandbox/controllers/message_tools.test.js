// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';

import {
    buildToolOutputHistoryText,
    getToolOutputKey,
    getToolOutputStatus,
    getToolStatusKey,
    hasPersistedToolOutput,
} from './message_tools.js';
import {
    findRenderedToolStatus,
    hasRenderedToolOutput,
    removeRenderedToolStatus,
} from './message_tool_render_state.js';

describe('message tool helpers', () => {
    it('formats tool output history text with optional step continuation', () => {
        expect(
            buildToolOutputHistoryText({
                toolName: 'search',
                text: 'Found docs',
                step: 2,
            })
        ).toBe('[Tool Output: search]\nFound docs\n\n[Proceeding to step 2]');
    });

    it('builds stable rendered output and status keys', () => {
        const request = {
            sessionId: 'session-1',
            toolName: 'search',
            step: 2,
            callIndex: 1,
            callCount: 3,
            text: 'Found docs',
        };

        expect(getToolOutputKey(request)).toBe('session-1|search|2|1|Found docs');
        expect(getToolOutputKey({ ...request, statusKey: 'session-1|search|local:7' })).toBe(
            'status:session-1|search|local:7:output'
        );
        expect(getToolStatusKey(request)).toBe('session-1|search|1');
        expect(getToolStatusKey({ ...request, statusKey: 'session-1|search|local:7' })).toBe(
            'session-1|search|local:7'
        );
    });

    it('detects persisted tool output and failed output status', () => {
        const request = {
            toolName: 'search',
            text: 'Error executing tool: network',
        };
        const session = {
            messages: [
                {
                    role: 'user',
                    text: '[Tool Output: search]\nError executing tool: network',
                },
            ],
        };

        expect(hasPersistedToolOutput(session, request)).toBe(true);
        expect(getToolOutputStatus(request)).toBe('failed');
        expect(getToolOutputStatus({ text: 'Error: No active tab found.' })).toBe('failed');
        expect(getToolOutputStatus({ text: 'Timed out waiting for text: Dashboard' })).toBe(
            'failed'
        );
    });

    it('finds and removes rendered tool status controllers', () => {
        const historyDiv = document.createElement('div');
        const output = document.createElement('div');
        const status = document.createElement('div');
        const controller = {
            div: status,
            dispose: vi.fn(),
        };

        output.dataset.toolOutputKey = 'session|search|1||done';
        status.dataset.toolStatusKey = 'session|search';
        status.__messageController = controller;
        historyDiv.append(output, status);

        expect(hasRenderedToolOutput(historyDiv, 'session|search|1||done')).toBe(true);
        expect(findRenderedToolStatus(historyDiv, 'session|search')).toBe(controller);

        removeRenderedToolStatus(historyDiv, 'session|search');

        expect(controller.dispose).toHaveBeenCalledTimes(1);
        expect(historyDiv.contains(status)).toBe(false);
    });
});
