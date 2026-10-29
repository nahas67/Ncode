import { DOM_IDS } from '../constants.js';
import { getSettingsElement } from '../dom.js';

export class AboutSection {
    constructor(callbacks) {
        this.callbacks = callbacks || {};
        this.elements = {};
        this.queryElements();
        this.bindEvents();
    }

    queryElements() {
        this.elements = {
            aboutGroup: getSettingsElement(DOM_IDS.ABOUT_GROUP),
            starEl: getSettingsElement(DOM_IDS.STAR_COUNT),
            currentVersionEl: getSettingsElement(DOM_IDS.APP_CURRENT_VERSION),
            updateStatusEl: getSettingsElement(DOM_IDS.APP_UPDATE_STATUS),
        };
    }

    bindEvents() {
        document.addEventListener('click', (event) => {
            const link = event.target.closest('#about-settings-group a[href]');
            if (!link) return;

            if (this.elements.aboutGroup && !this.elements.aboutGroup.contains(link)) return;

            const href = link.getAttribute('href');
            if (!href || !/^https?:\/\//i.test(href)) return;

            event.preventDefault();
            event.stopPropagation();
            window.parent.postMessage(
                {
                    action: 'OPEN_EXTERNAL_URL',
                    payload: { url: href },
                },
                '*'
            );
        });
    }

    displayStars(count) {
        const { starEl } = this.elements;
        if (!starEl) return;

        if (count) {
            const formatted = count > 999 ? (count / 1000).toFixed(1) + 'k' : count;
            starEl.textContent = `★ ${formatted}`;
            starEl.classList.add('is-visible');
            starEl.dataset.fetched = 'true';
        } else {
            starEl.classList.remove('is-visible');
        }
    }

    hasFetchedStars() {
        return this.elements.starEl && this.elements.starEl.dataset.fetched === 'true';
    }

    setCurrentVersion(version) {
        if (this.elements.currentVersionEl) {
            this.elements.currentVersionEl.textContent = version || '';
        }
    }

    getCurrentVersion() {
        return this.elements.currentVersionEl ? this.elements.currentVersionEl.textContent : null;
    }

    displayUpdateStatus(latest, current, isUpdateAvailable) {
        const { updateStatusEl } = this.elements;
        if (!updateStatusEl) return;

        updateStatusEl.replaceChildren();
        updateStatusEl.classList.remove('is-muted');

        if (isUpdateAvailable) {
            const link = document.createElement('a');
            link.href = 'https://github.com/yeahhe365/Gemini-Nexus/releases';
            link.target = '_blank';
            link.className = 'app-update-link';
            link.textContent = `Update available: ${latest}`;
            updateStatusEl.appendChild(link);
        } else {
            updateStatusEl.textContent = `(Latest: ${latest})`;
            updateStatusEl.classList.add('is-muted');
        }
    }
}
