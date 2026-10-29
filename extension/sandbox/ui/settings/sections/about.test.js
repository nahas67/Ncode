// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AboutSection } from './about.js';

describe('AboutSection', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        document.body.innerHTML = `
            <div id="about-settings-group">
                <span id="star-count"></span>
                <span id="app-current-version"></span>
                <span id="app-update-status"></span>
            </div>
        `;
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('renders update versions as text inside the release link', () => {
        const section = new AboutSection();

        section.displayUpdateStatus('<img src=x onerror="alert(1)">2.0.0', '1.0.0', true);

        const updateStatus = document.getElementById('app-update-status');
        const link = updateStatus.querySelector('a.app-update-link');
        expect(link).not.toBeNull();
        expect(link.textContent).toBe('Update available: <img src=x onerror="alert(1)">2.0.0');
        expect(updateStatus.querySelector('img')).toBeNull();
        expect(updateStatus.classList.contains('is-muted')).toBe(false);
        expect(updateStatus.hasAttribute('style')).toBe(false);
    });

    it('uses classes for star and latest-version presentation states', () => {
        const section = new AboutSection();

        section.displayStars(1200);
        const star = document.getElementById('star-count');
        expect(star.textContent).toBe('★ 1.2k');
        expect(star.classList.contains('is-visible')).toBe(true);
        expect(star.hasAttribute('style')).toBe(false);

        section.displayStars(0);
        expect(star.classList.contains('is-visible')).toBe(false);
        expect(star.hasAttribute('style')).toBe(false);

        section.displayUpdateStatus('1.0.0', '1.0.0', false);
        const updateStatus = document.getElementById('app-update-status');
        expect(updateStatus.classList.contains('is-muted')).toBe(true);
        expect(updateStatus.hasAttribute('style')).toBe(false);
    });

    it('does not own data import and export controls', () => {
        new AboutSection({
            onExportHistory: vi.fn(),
            onExportSettings: vi.fn(),
        });

        expect(document.getElementById('export-history-data')).toBeNull();
        expect(document.getElementById('import-history-file')).toBeNull();
        expect(document.getElementById('download-logs')).toBeNull();
    });
});
