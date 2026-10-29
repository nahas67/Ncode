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
