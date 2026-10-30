// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';
import { AppMessageBridge } from './messaging.js';

describe('AppMessageBridge settings restore', () => {
    it('restores the text selection blacklist into settings state', () => {
        const bridge = new AppMessageBridge();
        const ui = {
            settings: {
                updateTextSelectionBlacklist: vi.fn(),
            },
        };
        const app = {
            setHostContext: vi.fn(),
            handleIncomingMessage: vi.fn(),
        };

        bridge.setUI(ui);
        bridge.setApp(app);
        bridge.dispatch('RESTORE_TEXT_SELECTION_BLACKLIST', 'github.com', {});

        expect(ui.settings.updateTextSelectionBlacklist).toHaveBeenCalledWith('github.com');
        expect(app.handleIncomingMessage).not.toHaveBeenCalled();
    });

    it('opens the embedded settings modal when requested by the sidepanel host', () => {
        const bridge = new AppMessageBridge();
        const ui = {
            settings: {
                open: vi.fn(),
            },
        };
        const app = {
            setHostContext: vi.fn(),
            handleIncomingMessage: vi.fn(),
        };

        bridge.setUI(ui);
        bridge.setApp(app);
        bridge.dispatch('OPEN_SETTINGS_MODAL', null, {});

        expect(ui.settings.open).toHaveBeenCalled();
        expect(app.handleIncomingMessage).not.toHaveBeenCalled();
    });

    it('applies host context from the sidepanel frame host', () => {
        const bridge = new AppMessageBridge();
        const ui = {
            setHostContext: vi.fn(),
            settings: {},
        };
        const app = {
            setHostContext: vi.fn(),
            handleIncomingMessage: vi.fn(),
        };

        bridge.setUI(ui);
        bridge.setApp(app);
        bridge.dispatch('SET_HOST_CONTEXT', { isTab: true }, {});

        expect(ui.setHostContext).toHaveBeenCalledWith({ isTab: true });
        expect(app.setHostContext).toHaveBeenCalledWith({ isTab: true });
        expect(app.handleIncomingMessage).not.toHaveBeenCalled();
    });

    it('restores the persisted sidebar expanded state into the sidebar controller', () => {
        const bridge = new AppMessageBridge();
        const ui = {
            settings: {},
            sidebar: {
                restoreSidebarExpanded: vi.fn(),
            },
        };
        const app = {
            handleIncomingMessage: vi.fn(),
        };

        bridge.setUI(ui);
        bridge.setApp(app);
        bridge.dispatch('RESTORE_SIDEBAR_EXPANDED', false, {});

        expect(ui.sidebar.restoreSidebarExpanded).toHaveBeenCalledWith(false);
        expect(app.handleIncomingMessage).not.toHaveBeenCalled();
    });

    it('ignores non-object window messages', () => {
        const bridge = new AppMessageBridge();
        const app = {
            handleIncomingMessage: vi.fn(),
        };

        bridge.setUI({ settings: {} });
        bridge.setApp(app);
        bridge.handleMessage({ data: null, source: window.parent });

        expect(app.handleIncomingMessage).not.toHaveBeenCalled();
    });

    it('restores image-tools blacklist without touching chrome.storage', () => {
        const bridge = new AppMessageBridge();
        const ui = {
            settings: {
                updateImageTools: vi.fn(),
                updateImageToolsBlacklist: vi.fn(),
            },
        };
        const app = { handleIncomingMessage: vi.fn() };

        bridge.setUI(ui);
        bridge.setApp(app);
        bridge.dispatch('RESTORE_IMAGE_TOOLS', true, {});
        bridge.dispatch('RESTORE_IMAGE_TOOLS_BLACKLIST', 'example.com', {});

        expect(ui.settings.updateImageTools).toHaveBeenCalledWith(true);
        expect(ui.settings.updateImageToolsBlacklist).toHaveBeenCalledWith('example.com');
        expect(app.handleIncomingMessage).not.toHaveBeenCalled();
    });

    it('continues flushing when one queued restore handler throws', () => {
        const bridge = new AppMessageBridge();
        const ui = {
            settings: {
                updateImageTools: vi.fn(() => {
                    throw new Error("Cannot read properties of undefined (reading 'local')");
                }),
                updateTextSelection: vi.fn(),
            },
        };
        const app = { handleIncomingMessage: vi.fn() };
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        // Queue before app/ui are ready.
        bridge.handleMessage({
            data: { action: 'RESTORE_IMAGE_TOOLS', payload: true },
            source: window.parent,
        });
        bridge.handleMessage({
            data: { action: 'RESTORE_TEXT_SELECTION', payload: false },
            source: window.parent,
        });
        bridge.setUI(ui);
        bridge.setApp(app);

        expect(ui.settings.updateImageTools).toHaveBeenCalled();
        expect(ui.settings.updateTextSelection).toHaveBeenCalledWith(false);
        errorSpy.mockRestore();
    });

    it('recovers a transiently failing restore on the retry pass', () => {
        const bridge = new AppMessageBridge();
        const ui = {
            settings: {
                updateImageTools: vi
                    .fn()
                    .mockImplementationOnce(() => {
                        throw new Error('transient storage hiccup');
                    })
                    .mockImplementation(() => {}),
                updateTextSelection: vi.fn(),
            },
        };
        const app = { handleIncomingMessage: vi.fn() };
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        bridge.handleMessage({
            data: { action: 'RESTORE_IMAGE_TOOLS', payload: true },
            source: window.parent,
        });
        bridge.setUI(ui);
        bridge.setApp(app);

        expect(ui.settings.updateImageTools).toHaveBeenCalledTimes(2);
        expect(bridge.failedActions).toEqual([]);
        expect(errorSpy).not.toHaveBeenCalled();
        errorSpy.mockRestore();
    });

    it('records persistently failing restores for telemetry', () => {
        const bridge = new AppMessageBridge();
        const ui = {
            settings: {
                updateImageTools: vi.fn(() => {
                    throw new Error('permanent failure');
                }),
            },
        };
        const app = { handleIncomingMessage: vi.fn() };
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        bridge.handleMessage({
            data: { action: 'RESTORE_IMAGE_TOOLS', payload: true },
            source: window.parent,
        });
        bridge.setUI(ui);
        bridge.setApp(app);

        expect(ui.settings.updateImageTools).toHaveBeenCalledTimes(2);
        expect(bridge.failedActions).toEqual(['RESTORE_IMAGE_TOOLS']);
        expect(errorSpy).toHaveBeenCalledTimes(1);
        errorSpy.mockRestore();
    });

    it('ignores messages that do not come from the parent frame', () => {
        const bridge = new AppMessageBridge();
        const ui = {
            updateTheme: vi.fn(),
            settings: {},
        };
        const app = { handleIncomingMessage: vi.fn() };

        bridge.setUI(ui);
        bridge.setApp(app);
        bridge.handleMessage({
            data: { action: 'RESTORE_THEME', payload: 'dark' },
            source: {},
        });
        bridge.handleMessage({
            data: { action: 'RESTORE_THEME', payload: 'dark' },
            source: null,
        });

        expect(ui.updateTheme).not.toHaveBeenCalled();
        expect(app.handleIncomingMessage).not.toHaveBeenCalled();
    });

    it('ignores live-artifact channel messages from nested preview iframes', () => {
        const bridge = new AppMessageBridge();
        const app = { handleIncomingMessage: vi.fn() };

        bridge.setUI({ settings: {} });
        bridge.setApp(app);
        bridge.handleMessage({
            data: { channel: 'artifact', event: 'ready' },
            source: window.parent,
        });

        expect(app.handleIncomingMessage).not.toHaveBeenCalled();
    });
});

describe('AppMessageBridge Ncode harness routing', () => {
    function createBridge() {
        const bridge = new AppMessageBridge();
        const ui = {
            updateNcodeHarnessStatus: vi.fn(),
            updateNcodeGoalSession: vi.fn(),
            updateNcodePreamble: vi.fn(),
            updateNcodeCompactionState: vi.fn(),
            updateNcodeApprovalRequest: vi.fn(),
            settings: {},
        };
        const app = { handleIncomingMessage: vi.fn() };
        bridge.setUI(ui);
        bridge.setApp(app);
        return { bridge, ui, app };
    }

    it('routes nested BACKGROUND_MESSAGE status updates to the harness bar', () => {
        const { bridge, ui, app } = createBridge();

        bridge.dispatch(
            'BACKGROUND_MESSAGE',
            {
                action: 'NCODE_HARNESS_STATUS_UPDATE',
                geminiWebConnected: true,
                pcShellConnected: false,
                bridgeConnected: true,
            },
            {}
        );

        expect(ui.updateNcodeHarnessStatus).toHaveBeenCalledTimes(1);
        expect(ui.updateNcodeHarnessStatus.mock.calls[0][0]).toMatchObject({
            action: 'NCODE_HARNESS_STATUS_UPDATE',
            bridgeConnected: true,
        });
        expect(app.handleIncomingMessage).not.toHaveBeenCalled();
    });

    it('canonicalises legacy short Ncode names before routing', () => {
        const { bridge, ui } = createBridge();

        bridge.dispatch(
            'BACKGROUND_MESSAGE',
            { action: 'NCODE_HARNESS_STATUS', pcShellConnected: true },
            {}
        );
        bridge.dispatch(
            'BACKGROUND_MESSAGE',
            { action: 'NCODE_PREAMBLE', text: 'Editing', ts: 2 },
            {}
        );

        expect(ui.updateNcodeHarnessStatus).toHaveBeenCalledTimes(1);
        expect(ui.updateNcodePreamble).toHaveBeenCalledWith(
            expect.objectContaining({ text: 'Editing' })
        );
    });

    it('routes goal state, compaction and approval messages', () => {
        const { bridge, ui } = createBridge();

        bridge.dispatch(
            'BACKGROUND_MESSAGE',
            {
                action: 'NCODE_GOAL_STATE_UPDATE',
                sessionId: 'session-1',
                goalSession: { workflowId: 'wf-1', rootGoal: 'Ship it', subgoals: [] },
            },
            {}
        );
        bridge.dispatch(
            'BACKGROUND_MESSAGE',
            { action: 'NCODE_COMPACTION_STATE', state: 'resuming' },
            {}
        );
        bridge.dispatch(
            'BACKGROUND_MESSAGE',
            {
                action: 'NCODE_APPROVAL_REQUEST',
                requestId: 'approval-1',
                toolName: 'pc_exec_shell',
            },
            {}
        );

        expect(ui.updateNcodeGoalSession).toHaveBeenCalledWith(
            expect.objectContaining({ workflowId: 'wf-1' }),
            'session-1'
        );
        expect(ui.updateNcodeCompactionState).toHaveBeenCalledWith(
            expect.objectContaining({ state: 'resuming' })
        );
        expect(ui.updateNcodeApprovalRequest).toHaveBeenCalledWith(
            expect.objectContaining({ requestId: 'approval-1' })
        );
    });

    it('still forwards unrelated BACKGROUND_MESSAGE payloads to the app controller', () => {
        const { bridge, ui, app } = createBridge();

        bridge.dispatch('BACKGROUND_MESSAGE', { action: 'SERVICE_WORKER_STARTED', ts: 1 }, {});

        expect(app.handleIncomingMessage).toHaveBeenCalledTimes(1);
        expect(ui.updateNcodeHarnessStatus).not.toHaveBeenCalled();
    });
});
