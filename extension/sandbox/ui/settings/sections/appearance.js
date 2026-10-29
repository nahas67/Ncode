import { getSettingsElement } from '../dom.js';

export class AppearanceSection {
    constructor(callbacks) {
        this.callbacks = callbacks || {};
        this.elements = {};
        this.queryElements();
        this.bindEvents();
    }

    queryElements() {
        this.elements = {
            themeSelect: getSettingsElement('theme-select'),
            languageSelect: getSettingsElement('language-select'),
        };
    }

    bindEvents() {
        const { themeSelect, languageSelect } = this.elements;

        if (themeSelect) {
            themeSelect.addEventListener('change', (event) =>
                this.fire('onThemeChange', event.target.value)
            );
        }
        if (languageSelect) {
            languageSelect.addEventListener('change', (event) =>
                this.fire('onLanguageChange', event.target.value)
            );
        }

        window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
            if (themeSelect && themeSelect.value === 'system') {
                this.applyVisualTheme('system');
            }
        });
    }

    setTheme(theme) {
        if (this.elements.themeSelect) this.elements.themeSelect.value = theme;
        this.applyVisualTheme(theme);
    }

    setLanguage(lang) {
        if (this.elements.languageSelect) this.elements.languageSelect.value = lang;
    }

    applyVisualTheme(theme) {
        let applied = theme;
        if (theme === 'system') {
            applied = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
        }
        document.documentElement.setAttribute('data-theme', applied);
    }

    fire(event, data) {
        if (this.callbacks[event]) this.callbacks[event](data);
    }
}
