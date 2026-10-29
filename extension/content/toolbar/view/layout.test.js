// @vitest-environment jsdom

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

describe('GeminiViewLayout selection-anchored positioning', () => {
    beforeAll(async () => {
        await import('./layout.js');
    });

    beforeEach(() => {
        window.innerWidth = 1000;
        window.innerHeight = 800;
        window.scrollX = 0;
        window.scrollY = 0;
        window.GeminiViewLayout.resetOffset();
    });

    function createToolbar(width, height) {
        const el = document.createElement('div');
        Object.defineProperty(el, 'offsetWidth', { value: width });
        Object.defineProperty(el, 'offsetHeight', { value: height });
        return el;
    }

    it('centers horizontally on the selection and places below it', () => {
        const el = createToolbar(200, 40);
        // Selection at x=400..600 (center 500), bottom=300
        const rect = { left: 400, top: 260, right: 600, bottom: 300, width: 200, height: 40 };

        window.GeminiViewLayout.positionElement(el, rect, false, null, {
            anchorMode: 'selection',
        });

        // Centered: 500 - 200/2 = 400. Below: 300 + 8 = 308.
        expect(el.style.left).toBe('400px');
        expect(el.style.top).toBe('308px');
        expect(el.classList.contains('placed-bottom')).toBe(true);
    });

    it('flips above the selection when below does not fit', () => {
        const el = createToolbar(200, 40);
        // Selection near the bottom: bottom=780, top=740
        const rect = { left: 400, top: 740, right: 600, bottom: 780, width: 200, height: 40 };

        window.GeminiViewLayout.positionElement(el, rect, false, null, {
            anchorMode: 'selection',
        });

        // Flip above: top = 740 - 40 - 8 = 692
        expect(el.style.top).toBe('692px');
        expect(el.classList.contains('placed-top')).toBe(true);
    });

    it('clamps to the left edge when the selection is near the left', () => {
        const el = createToolbar(200, 40);
        // Selection at x=10..50, center=30 -> center would be 30-100=-70, clamp to 10
        const rect = { left: 10, top: 260, right: 50, bottom: 300, width: 40, height: 40 };

        window.GeminiViewLayout.positionElement(el, rect, false, null, {
            anchorMode: 'selection',
        });

        expect(el.style.left).toBe('10px');
    });

    it('clamps to the right edge when the selection is near the right', () => {
        const el = createToolbar(200, 40);
        // Selection at x=960..1000, center=980 -> 980-100=880, fits. But test right edge:
        const rect = { left: 980, top: 260, right: 1000, bottom: 300, width: 20, height: 40 };

        window.GeminiViewLayout.positionElement(el, rect, false, null, {
            anchorMode: 'selection',
        });

        // 980-100=880, which fits within [10, 790]. Clamp right edge = 1000-200-10 = 790.
        // center-based value 880 > 790, so clamp to 790.
        expect(el.style.left).toBe('790px');
    });

    it('applies a remembered drag offset on subsequent selections', () => {
        const el = createToolbar(200, 40);
        const rect = { left: 400, top: 260, right: 600, bottom: 300, width: 200, height: 40 };

        // Simulate the user dragging 50px right and 20px down from the base position.
        // Base (centered below) is (400, 308); placed (450, 328) with width 200.
        window.GeminiViewLayout.rememberOffsetFromDrag(rect, 450, 328, 200);

        window.GeminiViewLayout.positionElement(el, rect, false, null, {
            anchorMode: 'selection',
        });

        expect(el.style.left).toBe('450px');
        expect(el.style.top).toBe('328px');
    });

    it('clamps the remembered offset so the toolbar never leaves the viewport', () => {
        const el = createToolbar(200, 40);
        const rect = { left: 400, top: 260, right: 600, bottom: 300, width: 200, height: 40 };

        // Drag far off-screen to the left; offset should be clamped on render.
        window.GeminiViewLayout.rememberOffsetFromDrag(rect, -1000, 328, 200);

        window.GeminiViewLayout.positionElement(el, rect, false, null, {
            anchorMode: 'selection',
        });

        expect(el.style.left).toBe('10px');
    });

    it('resets placement to default after a double-click reset', () => {
        const el = createToolbar(200, 40);
        const rect = { left: 400, top: 260, right: 600, bottom: 300, width: 200, height: 40 };

        window.GeminiViewLayout.rememberOffsetFromDrag(rect, 450, 328, 200);
        window.GeminiViewLayout.resetOffset();

        window.GeminiViewLayout.positionElement(el, rect, false, null, {
            anchorMode: 'selection',
        });

        expect(el.style.left).toBe('400px');
        expect(el.style.top).toBe('308px');
    });

    it('falls back to cursor anchoring when anchorMode is not selection', () => {
        const el = createToolbar(200, 40);
        const rect = { left: 400, top: 260, right: 600, bottom: 300, width: 200, height: 40 };
        const mousePoint = { x: 500, y: 300 };

        window.GeminiViewLayout.positionElement(el, rect, false, mousePoint);

        // Cursor mode: anchor 500/300 + offset 12 -> 512/312
        expect(el.style.left).toBe('512px');
        expect(el.style.top).toBe('312px');
    });
});
