import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ScrollActions } from './scroll.js';

const BOX = [0, 10, 20, 10, 20, 30, 0, 30]; // center (10, 20)

function createActions({ box = BOX, layoutMetrics = null } = {}) {
    const connection = {
        sendCommand: vi.fn((method) => {
            if (method === 'DOM.resolveNode') {
                return Promise.resolve({ object: { objectId: 'obj-1' } });
            }
            if (method === 'DOM.getBoxModel') {
                return Promise.resolve({ model: { content: box } });
            }
            if (method === 'Page.getLayoutMetrics') {
                return Promise.resolve(
                    layoutMetrics || { cssLayoutViewport: { clientWidth: 800, clientHeight: 600 } }
                );
            }
            return Promise.resolve({ result: { value: true } });
        }),
    };
    const snapshotManager = { getBackendNodeId: vi.fn(() => 123) };
    return { actions: new ScrollActions(connection, snapshotManager), connection };
}

function mouseWheel(connection) {
    const call = connection.sendCommand.mock.calls.find(
        ([method, params]) => method === 'Input.dispatchMouseEvent' && params?.type === 'mouseWheel'
    );
    return call?.[1];
}

describe('ScrollActions.scrollElement', () => {
    beforeEach(() => {
        globalThis.chrome = { storage: { local: { get: vi.fn(() => Promise.resolve({})) } } };
    });
    afterEach(() => {
        delete globalThis.chrome;
        vi.restoreAllMocks();
    });

    it('wheels on the element center when uid is given', async () => {
        const { actions, connection } = createActions();
        const result = await actions.scrollElement({ uid: '1_2', scroll_x: 0, scroll_y: 300 });

        expect(result).toBe('Scrolled (0,300) at 10,20 on 1_2');
        expect(mouseWheel(connection)).toEqual({
            type: 'mouseWheel',
            x: 10,
            y: 20,
            deltaX: 0,
            deltaY: 300,
        });
    });

    it('wheels on the viewport center when no uid is given', async () => {
        const { actions, connection } = createActions();
        const result = await actions.scrollElement({ scroll_y: -240 });

        expect(result).toBe('Scrolled (0,-240) at 400,300 (viewport center)');
        expect(mouseWheel(connection)).toEqual({
            type: 'mouseWheel',
            x: 400,
            y: 300,
            deltaX: 0,
            deltaY: -240,
        });
    });

    it('defaults deltaX/deltaY to 0', async () => {
        const { actions, connection } = createActions();
        await actions.scrollElement({ uid: '1_2' });

        expect(mouseWheel(connection)).toMatchObject({ deltaX: 0, deltaY: 0 });
    });

    it('brings the page to front before wheeling', async () => {
        const { actions, connection } = createActions();
        await actions.scrollElement({ uid: '1_2', scroll_y: 100 });

        const calls = connection.sendCommand.mock.calls.map(([m]) => m);
        expect(calls).toContain('Page.bringToFront');
        expect(calls.indexOf('Input.dispatchMouseEvent')).toBeGreaterThan(
            calls.indexOf('Page.bringToFront')
        );
    });
});
