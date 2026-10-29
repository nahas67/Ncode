import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BaseActionHandler } from './base.js';

function createHandler() {
    const connection = { sendCommand: vi.fn(() => Promise.resolve({})) };
    return { handler: new BaseActionHandler(connection, {}, {}), connection };
}

describe('BaseActionHandler.bringPageToFront', () => {
    beforeEach(() => {
        globalThis.chrome = { storage: { local: { get: vi.fn(() => Promise.resolve({})) } } };
    });
    afterEach(() => {
        delete globalThis.chrome;
        vi.restoreAllMocks();
    });

    it('sends Page.bringToFront when BACKGROUND_INTERACTION_ENABLED is unset (default false)', async () => {
        const { handler, connection } = createHandler();
        await handler.bringPageToFront();
        expect(connection.sendCommand).toHaveBeenCalledWith('Page.bringToFront', {});
    });

    it('skips Page.bringToFront when BACKGROUND_INTERACTION_ENABLED is true', async () => {
        globalThis.chrome.storage.local.get = vi.fn(() =>
            Promise.resolve({ BACKGROUND_INTERACTION_ENABLED: true })
        );
        const { handler, connection } = createHandler();
        await handler.bringPageToFront();
        expect(connection.sendCommand).not.toHaveBeenCalled();
    });

    it('caches the focus-steal flag so repeated calls hit storage once', async () => {
        const get = vi.fn(() => Promise.resolve({}));
        globalThis.chrome.storage.local.get = get;
        const { handler } = createHandler();
        await handler._shouldSuppressFocusSteal();
        await handler._shouldSuppressFocusSteal();
        await handler._shouldSuppressFocusSteal();
        expect(get).toHaveBeenCalledTimes(1);
    });

    it('does not let a missing chrome.runtime crash the action', async () => {
        delete globalThis.chrome;
        const { handler, connection } = createHandler();
        await handler.bringPageToFront();
        // Falls open: storage read fails -> suppress=false -> still brings to front.
        expect(connection.sendCommand).toHaveBeenCalledWith('Page.bringToFront', {});
    });
});

describe('BaseActionHandler.getObjectIdFromUid recovery', () => {
    it('refreshes snapshot once and retries the same UID', async () => {
        const snapshotManager = {
            snapshotMap: new Map(),
            getBackendNodeId: vi
                .fn()
                .mockImplementationOnce(() => {
                    throw new Error(
                        "Element '2_15' not found in current snapshot. Please verify the UID or take a new snapshot."
                    );
                })
                .mockImplementationOnce(() => 999),
            takeSnapshot: vi.fn(async () => 'uid=3_1 RootWebArea "Home"'),
        };
        const connection = {
            sendCommand: vi.fn(async (method) => {
                if (method === 'DOM.resolveNode') {
                    return { object: { objectId: 'obj-1' } };
                }
                return {};
            }),
        };
        const handler = new BaseActionHandler(connection, snapshotManager, {});
        handler._doHighlight = vi.fn(async () => {});

        const objectId = await handler.getObjectIdFromUid('2_15');
        expect(objectId).toBe('obj-1');
        expect(snapshotManager.takeSnapshot).toHaveBeenCalledTimes(1);
        expect(snapshotManager.getBackendNodeId).toHaveBeenCalledTimes(2);
    });

    it('attaches recovery snapshot when retry still fails', async () => {
        const snapshotManager = {
            getBackendNodeId: vi.fn(() => {
                throw new Error(
                    "Element '2_15' not found in current snapshot. Please verify the UID or take a new snapshot."
                );
            }),
            takeSnapshot: vi.fn(async () => 'uid=9_1 RootWebArea "Next"'),
        };
        const handler = new BaseActionHandler({ sendCommand: vi.fn() }, snapshotManager, {});

        await expect(handler.getObjectIdFromUid('2_15')).rejects.toThrow(/## Latest page snapshot/);
        await expect(handler.getObjectIdFromUid('2_15')).rejects.toThrow(/uid=9_1/);
    });
});
