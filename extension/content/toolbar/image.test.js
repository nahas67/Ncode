// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

async function installImageDetector() {
    await import('./image.js');
}

function createImage({
    width,
    height,
    alt = '',
    className = '',
    src = 'https://example.test/i.png',
}) {
    const image = document.createElement('img');
    image.width = width;
    image.height = height;
    image.alt = alt;
    image.className = className;
    image.src = src;
    image.getBoundingClientRect = vi.fn(() => ({
        left: 10,
        top: 20,
        right: 10 + width,
        bottom: 20 + height,
        width,
        height,
    }));
    document.body.appendChild(image);
    return image;
}

describe('GeminiImageDetector', () => {
    beforeEach(async () => {
        vi.resetModules();
        vi.useFakeTimers();
        document.body.innerHTML = '';
        await installImageDetector();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('shows image tools on captcha-sized images with captcha metadata', () => {
        const onShow = vi.fn();
        const detector = new window.GeminiImageDetector({ onShow });
        const image = createImage({
            width: 82,
            height: 32,
            alt: 'captcha verification code',
            className: 'captcha-img',
        });

        detector.setEnabled(true);
        image.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));

        // Advance timers to trigger the delayed show callback
        vi.advanceTimersByTime(600);

        expect(onShow).toHaveBeenCalledWith({
            left: 10,
            top: 20,
            right: 92,
            bottom: 52,
            width: 82,
            height: 32,
        });
        expect(detector.getCurrentImage()).toBe(image);
    });

    it('shows image tools on small verification-code images with nearby label text', () => {
        const onShow = vi.fn();
        const detector = new window.GeminiImageDetector({ onShow });
        const wrapper = document.createElement('label');
        wrapper.textContent = '验证码';
        document.body.appendChild(wrapper);
        const image = createImage({ width: 90, height: 34, alt: '' });
        wrapper.appendChild(image);

        detector.setEnabled(true);
        image.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));

        vi.advanceTimersByTime(600);

        expect(onShow).toHaveBeenCalledTimes(1);
    });

    it('keeps small icons hidden from image tools', () => {
        const onShow = vi.fn();
        const detector = new window.GeminiImageDetector({ onShow });
        const image = createImage({
            width: 32,
            height: 32,
            alt: 'site logo icon',
            className: 'logo-icon',
        });

        detector.setEnabled(true);
        image.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));

        vi.advanceTimersByTime(600);

        expect(onShow).not.toHaveBeenCalled();
        expect(detector.getCurrentImage()).toBeNull();
    });

    it('keeps small button icons hidden from image tools', () => {
        const onShow = vi.fn();
        const detector = new window.GeminiImageDetector({ onShow });
        // A small <img> living inside a <button> — a UI control icon, not
        // content to analyze. It lacks icon/logo/button keywords, so without
        // the interactive-element guard it would slip through the OCR filter.
        const button = document.createElement('button');
        button.className = 'action';
        document.body.appendChild(button);
        const image = createImage({ width: 48, height: 24, alt: 'edit' });
        button.appendChild(image);

        detector.setEnabled(true);
        image.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));

        vi.advanceTimersByTime(600);

        expect(onShow).not.toHaveBeenCalled();
        expect(detector.getCurrentImage()).toBeNull();
    });

    it('keeps small link icons hidden from image tools', () => {
        const onShow = vi.fn();
        const detector = new window.GeminiImageDetector({ onShow });
        const link = document.createElement('a');
        link.href = '#';
        document.body.appendChild(link);
        const image = createImage({ width: 44, height: 22, alt: 'open' });
        link.appendChild(image);

        detector.setEnabled(true);
        image.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));

        vi.advanceTimersByTime(600);

        expect(onShow).not.toHaveBeenCalled();
    });

    it('still shows image tools for large images inside buttons', () => {
        const onShow = vi.fn();
        const detector = new window.GeminiImageDetector({ onShow });
        const button = document.createElement('button');
        document.body.appendChild(button);
        const image = createImage({ width: 160, height: 120, alt: 'photo' });
        button.appendChild(image);

        detector.setEnabled(true);
        image.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));

        vi.advanceTimersByTime(600);

        expect(onShow).toHaveBeenCalledTimes(1);
    });
});
