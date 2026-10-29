// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { resizeSelectToSelectedOption } from './model_select_width.js';

describe('resizeSelectToSelectedOption', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('sizes a select from the selected option text', () => {
        const select = document.createElement('select');
        select.innerHTML = `
            <option value="a">Short</option>
            <option value="b">Longer model name</option>
        `;
        select.selectedIndex = 1;
        document.body.appendChild(select);
        vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
            return {
                width: this.textContent.length * 10,
                height: 0,
                top: 0,
                right: 0,
                bottom: 0,
                left: 0,
                x: 0,
                y: 0,
                toJSON: () => ({}),
            };
        });

        expect(resizeSelectToSelectedOption(select)).toBe(true);

        expect(select.style.width).toBe('204px');
    });

    it('selects the first option before sizing an unselected select', () => {
        const select = document.createElement('select');
        select.innerHTML = '<option value="a">First</option>';
        select.selectedIndex = -1;
        document.body.appendChild(select);
        vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
            width: 50,
            height: 0,
            top: 0,
            right: 0,
            bottom: 0,
            left: 0,
            x: 0,
            y: 0,
            toJSON: () => ({}),
        });

        expect(resizeSelectToSelectedOption(select)).toBe(true);

        expect(select.selectedIndex).toBe(0);
        expect(select.style.width).toBe('84px');
    });
});
