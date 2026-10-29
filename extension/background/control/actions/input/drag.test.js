import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DragActions, interpolateDragPath, samePoint } from './drag.js';

// box model content = [x1,y1, x2,y2, x3,y3, x4,y4]; center = ((x1+x3)/2, (y1+y3)/2)
const BOX = [0, 10, 20, 10, 20, 30, 0, 30]; // center (10, 20)

function createActions({ box = BOX } = {}) {
    const connection = {
        sendCommand: vi.fn((method) => {
            if (method === 'DOM.resolveNode') {
                return Promise.resolve({ object: { objectId: 'obj-1' } });
            }
            if (method === 'DOM.getBoxModel') {
                return Promise.resolve({ model: { content: box } });
            }
            return Promise.resolve({ result: { value: true } });
        }),
    };
    const snapshotManager = { getBackendNodeId: vi.fn(() => 123) };
    return { actions: new DragActions(connection, snapshotManager), connection };
}

function mouseEvents(connection) {
    return connection.sendCommand.mock.calls
        .filter(([method]) => method === 'Input.dispatchMouseEvent')
        .map(([, params]) => params);
}

describe('interpolateDragPath', () => {
    it('linearly interpolates each segment capped at 48px steps', () => {
        expect(
            interpolateDragPath([
                { x: 0, y: 0 },
                { x: 96, y: 0 },
            ])
        ).toEqual([
            { x: 0, y: 0 },
            { x: 48, y: 0 },
            { x: 96, y: 0 },
        ]);
    });

    it('uses at least one step for sub-threshold distances', () => {
        expect(
            interpolateDragPath([
                { x: 0, y: 0 },
                { x: 5, y: 0 },
            ])
        ).toEqual([
            { x: 0, y: 0 },
            { x: 5, y: 0 },
        ]);
    });

    it('returns empty for an empty path', () => {
        expect(interpolateDragPath([])).toEqual([]);
    });
});

describe('samePoint', () => {
    it('compares by coordinate equality', () => {
        expect(samePoint({ x: 1, y: 2 }, { x: 1, y: 2 })).toBe(true);
        expect(samePoint({ x: 1, y: 2 }, { x: 1, y: 3 })).toBe(false);
    });
});

describe('DragActions.dragElement', () => {
    beforeEach(() => {
        globalThis.chrome = { storage: { local: { get: vi.fn(() => Promise.resolve({})) } } };
    });
    afterEach(() => {
        delete globalThis.chrome;
        vi.restoreAllMocks();
    });

    it('emits the full BCB drag CDP sequence for a dx/dy offset', async () => {
        const { actions, connection } = createActions();
        // start (10,20), end (106,20); distance 96 -> 2 steps -> midpoints (58,20),(106,20)
        const result = await actions.dragElement({ uid: '1_2', dx: 96, dy: 0 });

        expect(result).toBe('Dragged from 10,20 to 106,20');
        expect(mouseEvents(connection)).toEqual([
            { type: 'mouseMoved', x: 10, y: 20 }, // first, no button field
            { type: 'mousePressed', button: 'left', buttons: 1, x: 10, y: 20 },
            { type: 'mouseMoved', button: 'left', buttons: 1, x: 58, y: 20 },
            { type: 'mouseMoved', button: 'left', buttons: 1, x: 106, y: 20 },
            { type: 'mouseMoved', button: 'left', buttons: 1, x: 106, y: 20 }, // settle 1
            { type: 'mouseMoved', button: 'left', buttons: 1, x: 106, y: 20 }, // settle 2
            { type: 'mouseReleased', button: 'left', x: 106, y: 20 }, // no buttons field
        ]);
    });

    it('resolves end from target_uid center', async () => {
        const { actions, connection } = createActions();
        // both uids resolve to the same box center (10,20) via the mock.
        const result = await actions.dragElement({ uid: '1_2', target_uid: '1_3' });

        expect(result).toBe('Dragged from 10,20 to 10,20');
        // Pressed then released at the same point; sequence shape still完整.
        const events = mouseEvents(connection);
        expect(events.at(-1)).toEqual({ type: 'mouseReleased', button: 'left', x: 10, y: 20 });
        expect(events[1]).toEqual({
            type: 'mousePressed',
            button: 'left',
            buttons: 1,
            x: 10,
            y: 20,
        });
    });

    it('throws when neither target_uid nor dx/dy is provided', async () => {
        const { actions } = createActions();
        await expect(actions.dragElement({ uid: '1_2' })).rejects.toThrow(/target_uid or dx\/dy/);
    });

    it('throws when uid is missing', async () => {
        const { actions } = createActions();
        await expect(actions.dragElement({ dx: 10 })).rejects.toThrow(/uid/);
    });

    it('brings the page to front before the first mouse event', async () => {
        const { actions, connection } = createActions();
        await actions.dragElement({ uid: '1_2', dx: 10, dy: 0 });

        const calls = connection.sendCommand.mock.calls.map(([m]) => m);
        const frontIndex = calls.indexOf('Page.bringToFront');
        const firstMouseIndex = calls.indexOf('Input.dispatchMouseEvent');
        expect(frontIndex).toBeGreaterThanOrEqual(0);
        expect(firstMouseIndex).toBeGreaterThan(frontIndex);
    });
});
