import { BaseActionHandler } from '../base.js';

const MAX_SCROLL_DELTA = 100000;

function clampScrollDelta(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return 0;
    return Math.max(-MAX_SCROLL_DELTA, Math.min(MAX_SCROLL_DELTA, Math.trunc(num)));
}

// Mirrors BCB's cua_scroll: bring to front, move the visible cursor onto the
// target point, then dispatch a single mouseWheel. deltaX/deltaY are CSS
// pixels (positive = right/down). With a uid the wheel lands on that element's
// center; without one it lands on the viewport center (BCB's no-node path).
export class ScrollActions extends BaseActionHandler {
    async scrollElement({ uid, scroll_x = 0, scroll_y = 0 } = {}) {
        await this.bringPageToFront();

        const deltaX = clampScrollDelta(scroll_x);
        const deltaY = clampScrollDelta(scroll_y);

        let x;
        let y;
        let where;
        if (uid) {
            const objectId = await this.getObjectIdFromUid(uid);
            const backendNodeId = this.snapshotManager.getBackendNodeId(uid);
            ({ x, y } = await this._getElementCenter({ objectId, backendNodeId }));
            where = ` on ${uid}`;
        } else {
            ({ x, y } = await this._getViewportCenter());
            where = ' (viewport center)';
        }

        await this.moveCursorToPoint(x, y);
        await this.cmd('Input.dispatchMouseEvent', {
            type: 'mouseWheel',
            x,
            y,
            deltaX,
            deltaY,
        });

        return `Scrolled (${deltaX},${deltaY}) at ${Math.round(x)},${Math.round(y)}${where}`;
    }
}
