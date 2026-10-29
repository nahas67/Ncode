import { BaseActionHandler } from '../base.js';

const DRAG_INTERPOLATION_MAX_STEP_PX = 48;
const DRAG_SETTLE_MOVE_COUNT = 2;

// Linear interpolation between consecutive path points, capping each segment
// at DRAG_INTERPOLATION_MAX_STEP_PX so the CDP mouseMoved stream looks smooth.
// Ported verbatim from BCB's interpolateDragPath.
export function interpolateDragPath(path) {
    const first = path[0];
    if (!first) return [];
    const interpolated = [first];
    for (let index = 1; index < path.length; index += 1) {
        const start = path[index - 1];
        const end = path[index];
        const distance = Math.hypot(end.x - start.x, end.y - start.y);
        const steps = Math.max(1, Math.ceil(distance / DRAG_INTERPOLATION_MAX_STEP_PX));
        for (let step = 1; step <= steps; step += 1) {
            const progress = step / steps;
            interpolated.push({
                x: start.x + (end.x - start.x) * progress,
                y: start.y + (end.y - start.y) * progress,
            });
        }
    }
    return interpolated;
}

export function samePoint(left, right) {
    return left.x === right.x && left.y === right.y;
}

export class DragActions extends BaseActionHandler {
    async dragElement({ uid, target_uid, dx, dy } = {}) {
        if (!uid) {
            throw new Error('drag requires a uid (the element to drag from).');
        }

        const objectId = await this.getObjectIdFromUid(uid);
        const backendNodeId = this.snapshotManager.getBackendNodeId(uid);
        const start = await this._getElementCenter({ objectId, backendNodeId });

        let end;
        if (target_uid) {
            const targetObjectId = await this.getObjectIdFromUid(target_uid);
            const targetBackendNodeId = this.snapshotManager.getBackendNodeId(target_uid);
            end = await this._getElementCenter({
                objectId: targetObjectId,
                backendNodeId: targetBackendNodeId,
            });
        } else if (Number.isFinite(dx) || Number.isFinite(dy)) {
            end = {
                x: start.x + (Number.isFinite(dx) ? dx : 0),
                y: start.y + (Number.isFinite(dy) ? dy : 0),
            };
        } else {
            throw new Error('drag requires either target_uid or dx/dy.');
        }

        return this._dragAlongPath([start, end]);
    }

    // Mirrors BCB's dragAlongPathInput: visible cursor follows original path
    // waypoints only; interpolated midpoints get a raw CDP mouseMoved. Two
    // settle moves at the tail dampen jitter before mouseReleased.
    async _dragAlongPath(path) {
        await this.bringPageToFront();

        const first = path[0];
        const last = path[path.length - 1];
        const cdpPath = interpolateDragPath(path);

        await this.moveCursorToPoint(first.x, first.y);
        await this.cmd('Input.dispatchMouseEvent', {
            type: 'mouseMoved',
            x: first.x,
            y: first.y,
        });
        await this.cmd('Input.dispatchMouseEvent', {
            type: 'mousePressed',
            button: 'left',
            buttons: 1,
            x: first.x,
            y: first.y,
        });

        let nextVisibleIndex = 1;
        for (const point of cdpPath.slice(1)) {
            if (nextVisibleIndex < path.length && samePoint(point, path[nextVisibleIndex])) {
                await this.moveCursorToPoint(path[nextVisibleIndex].x, path[nextVisibleIndex].y);
                nextVisibleIndex += 1;
            }
            await this.cmd('Input.dispatchMouseEvent', {
                type: 'mouseMoved',
                button: 'left',
                buttons: 1,
                x: point.x,
                y: point.y,
            });
        }

        while (nextVisibleIndex < path.length) {
            await this.moveCursorToPoint(path[nextVisibleIndex].x, path[nextVisibleIndex].y);
            nextVisibleIndex += 1;
        }

        for (let index = 0; index < DRAG_SETTLE_MOVE_COUNT; index += 1) {
            await this.cmd('Input.dispatchMouseEvent', {
                type: 'mouseMoved',
                button: 'left',
                buttons: 1,
                x: last.x,
                y: last.y,
            });
        }

        await this.cmd('Input.dispatchMouseEvent', {
            type: 'mouseReleased',
            button: 'left',
            x: last.x,
            y: last.y,
        });

        return `Dragged from ${Math.round(first.x)},${Math.round(first.y)} to ${Math.round(last.x)},${Math.round(last.y)}`;
    }
}
