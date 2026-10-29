import { SettingsController } from '../sandbox/ui/settings/index.js';
import { SettingsPageTemplate } from '../sandbox/ui/templates/settings/index.js';
import { applyTranslations } from '../sandbox/core/i18n.js';
import { StandaloneSettingsBridge } from './bridge.js';

document.getElementById('app').innerHTML = SettingsPageTemplate;
applyTranslations();

const controller = new SettingsController();
const bridge = new StandaloneSettingsBridge(controller);
bridge.init();
bridge.restoreInitialState();

document.addEventListener('gemini-language-changed', () => {
    applyTranslations();
});

document.getElementById('close-settings')?.addEventListener('click', () => {
    window.close();
});
