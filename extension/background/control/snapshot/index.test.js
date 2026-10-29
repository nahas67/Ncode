import { describe, expect, it, vi } from 'vitest';
import { EXTENSION_UI_HIDE_SELECTOR, SnapshotManager } from './index.js';

function createSnapshotConnection(getNodes) {
    let listener = null;
    return {
        onDetach: vi.fn(),
        addListener: vi.fn((callback) => {
            listener = callback;
        }),
        emit(method, params = {}) {
            listener?.(method, params);
        },
        sendCommand: vi.fn((method) => {
            if (method === 'Accessibility.getFullAXTree') {
                return Promise.resolve({ nodes: getNodes() });
            }
            return Promise.resolve({});
        }),
    };
}

describe('SnapshotManager extension UI hiding', () => {
    it('hides then restores extension hosts around Accessibility.getFullAXTree', async () => {
        const callOrder = [];
        const connection = {
            onDetach: vi.fn(),
            addListener: vi.fn(),
            sendCommand: vi.fn(async (method, params) => {
                callOrder.push(method);
                if (method === 'Runtime.evaluate') {
                    callOrder.push(
                        params?.expression?.includes('aria-hidden')
                            ? 'eval-hide-or-restore'
                            : 'eval-other'
                    );
                    return { result: { value: 1 } };
                }
                if (method === 'Accessibility.getFullAXTree') {
                    return {
                        nodes: [
                            {
                                nodeId: 'root',
                                role: { value: 'RootWebArea' },
                                name: { value: 'Page' },
                                childIds: [],
                            },
                        ],
                    };
                }
                return {};
            }),
        };

        const manager = new SnapshotManager(connection);
        const snapshot = await manager.takeSnapshot();

        expect(snapshot).toContain('RootWebArea');
        const axIndex = callOrder.indexOf('Accessibility.getFullAXTree');
        expect(axIndex).toBeGreaterThan(-1);
        // Two Runtime.evaluate calls (hide + restore) surround the AX tree fetch.
        const evalIndexes = callOrder
            .map((name, index) => (name === 'Runtime.evaluate' ? index : -1))
            .filter((index) => index >= 0);
        expect(evalIndexes.length).toBeGreaterThanOrEqual(2);
        expect(evalIndexes[0]).toBeLessThan(axIndex);
        expect(evalIndexes[evalIndexes.length - 1]).toBeGreaterThan(axIndex);
        expect(EXTENSION_UI_HIDE_SELECTOR).toContain('gemini-nexus-toolbar-host');
        expect(EXTENSION_UI_HIDE_SELECTOR).toContain('data-gemini-nexus-ui');
    });
});

describe('SnapshotManager descendant lookup', () => {
    it('only returns AX nodes that are descendants of the requested root UID', async () => {
        const nodes = [
            {
                nodeId: 'root',
                role: { value: 'RootWebArea' },
                name: { value: 'Page' },
                childIds: ['select-b', 'select-a'],
            },
            {
                nodeId: 'select-b',
                backendDOMNodeId: 201,
                role: { value: 'combobox' },
                name: { value: 'Billing state' },
                childIds: ['option-b-ca'],
            },
            {
                nodeId: 'option-b-ca',
                backendDOMNodeId: 202,
                role: { value: 'option' },
                name: { value: 'CA' },
            },
            {
                nodeId: 'select-a',
                backendDOMNodeId: 101,
                role: { value: 'combobox' },
                name: { value: 'Shipping state' },
                childIds: ['option-a-ca'],
            },
            {
                nodeId: 'option-a-ca',
                backendDOMNodeId: 102,
                role: { value: 'option' },
                name: { value: 'CA' },
            },
        ];
        const connection = createSnapshotConnection(() => nodes);
        const manager = new SnapshotManager(connection);

        await manager.takeSnapshot();
        const shippingUid = [...manager.uidToAxNode.entries()].find(
            ([, node]) => node.nodeId === 'select-a'
        )?.[0];

        const optionUid = manager.findDescendant(shippingUid, (node) => node.name?.value === 'CA');

        expect(manager.getAXNode(optionUid).nodeId).toBe('option-a-ca');
    });
});

describe('SnapshotManager stable UIDs', () => {
    it('keeps the same UID for the same backend node across same-document snapshots', async () => {
        const firstNodes = [
            {
                nodeId: 'root-1',
                role: { value: 'RootWebArea' },
                name: { value: 'Page' },
                childIds: ['button-1'],
            },
            {
                nodeId: 'button-1',
                backendDOMNodeId: 501,
                role: { value: 'button' },
                name: { value: 'Save' },
            },
        ];
        const secondNodes = [
            {
                nodeId: 'root-2',
                role: { value: 'RootWebArea' },
                name: { value: 'Page updated' },
                childIds: ['button-2'],
            },
            {
                nodeId: 'button-2',
                backendDOMNodeId: 501,
                role: { value: 'button' },
                name: { value: 'Save' },
            },
        ];
        let nodes = firstNodes;
        const connection = createSnapshotConnection(() => nodes);
        const manager = new SnapshotManager(connection);

        await manager.takeSnapshot();
        const firstUid = [...manager.uidToAxNode.entries()].find(
            ([, node]) => node.backendDOMNodeId === 501
        )?.[0];

        nodes = secondNodes;
        await manager.takeSnapshot();
        const secondUid = [...manager.uidToAxNode.entries()].find(
            ([, node]) => node.backendDOMNodeId === 501
        )?.[0];

        expect(secondUid).toBe(firstUid);
        expect(manager.getBackendNodeId(firstUid)).toBe(501);
    });

    it('clears stable UID mappings after a cross-document navigation starts', async () => {
        const nodes = [
            {
                nodeId: 'root',
                role: { value: 'RootWebArea' },
                name: { value: 'Page' },
                childIds: ['button'],
            },
            {
                nodeId: 'button',
                backendDOMNodeId: 501,
                role: { value: 'button' },
                name: { value: 'Save' },
            },
        ];
        const connection = createSnapshotConnection(() => nodes);
        const manager = new SnapshotManager(connection);

        await manager.takeSnapshot();
        const firstUid = [...manager.uidToAxNode.entries()].find(
            ([, node]) => node.backendDOMNodeId === 501
        )?.[0];

        connection.emit('Page.frameStartedNavigating', {
            navigationType: 'differentDocument',
        });
        await manager.takeSnapshot();
        const secondUid = [...manager.uidToAxNode.entries()].find(
            ([, node]) => node.backendDOMNodeId === 501
        )?.[0];

        expect(secondUid).not.toBe(firstUid);
    });

    it('throws Stale Element Reference after nav reset empties maps (version bump)', async () => {
        const nodes = [
            {
                nodeId: 'root',
                role: { value: 'RootWebArea' },
                name: { value: 'Page' },
                childIds: ['button'],
            },
            {
                nodeId: 'button',
                backendDOMNodeId: 501,
                role: { value: 'button' },
                name: { value: 'Save' },
            },
        ];
        const connection = createSnapshotConnection(() => nodes);
        const manager = new SnapshotManager(connection);

        await manager.takeSnapshot();
        const uid = [...manager.uidToAxNode.entries()].find(
            ([, node]) => node.backendDOMNodeId === 501
        )?.[0];
        expect(manager.getBackendNodeId(uid)).toBe(501);

        connection.emit('Page.frameStartedNavigating', {
            navigationType: 'differentDocument',
        });

        expect(() => manager.getBackendNodeId(uid)).toThrow(/Stale Element Reference/);
    });

    it('detects UID resolution error messages', () => {
        expect(
            SnapshotManager.isUidResolutionError(
                "Element '3_64' not found in current snapshot. Please verify the UID"
            )
        ).toBe(true);
        expect(
            SnapshotManager.isUidResolutionError(
                new Error("Stale Element Reference: UID '1_2' belongs to an older snapshot")
            )
        ).toBe(true);
        expect(SnapshotManager.isUidResolutionError('Error: Target tab is outside')).toBe(false);
    });
});
