import { t } from '../../../core/i18n.js';
import { DOM_IDS } from '../constants.js';
import { getSettingsElement } from '../dom.js';

export class DataManagementSection {
    constructor(callbacks) {
        this.callbacks = callbacks || {};
        this.elements = {};
        this.queryElements();
        this.bindEvents();
    }

    queryElements() {
        this.elements = {
            btnDownloadLogs: getSettingsElement(DOM_IDS.DOWNLOAD_LOGS),
            btnExportHistory: getSettingsElement(DOM_IDS.EXPORT_HISTORY_DATA),
            btnImportHistory: getSettingsElement(DOM_IDS.IMPORT_HISTORY_DATA),
            inputImportHistory: getSettingsElement(DOM_IDS.IMPORT_HISTORY_FILE),
            btnExportSettings: getSettingsElement(DOM_IDS.EXPORT_SETTINGS_DATA),
            btnImportSettings: getSettingsElement(DOM_IDS.IMPORT_SETTINGS_DATA),
            inputImportSettings: getSettingsElement(DOM_IDS.IMPORT_SETTINGS_FILE),
        };
    }

    bindEvents() {
        if (this.elements.btnDownloadLogs) {
            this.elements.btnDownloadLogs.addEventListener('click', () => {
                if (this.callbacks.onDownloadLogs) this.callbacks.onDownloadLogs();
            });
        }

        if (this.elements.btnExportHistory) {
            this.elements.btnExportHistory.addEventListener('click', () => {
                if (this.callbacks.onExportHistory) this.callbacks.onExportHistory();
            });
        }

        if (this.elements.btnImportHistory && this.elements.inputImportHistory) {
            this.elements.btnImportHistory.addEventListener('click', () => {
                this.elements.inputImportHistory.click();
            });
            this.elements.inputImportHistory.addEventListener('change', () => {
                this.importJsonFile(this.elements.inputImportHistory, (payload) => {
                    if (this.callbacks.onImportHistory) this.callbacks.onImportHistory(payload);
                });
            });
        }

        if (this.elements.btnExportSettings) {
            this.elements.btnExportSettings.addEventListener('click', () => {
                if (this.callbacks.onExportSettings) this.callbacks.onExportSettings();
            });
        }

        if (this.elements.btnImportSettings && this.elements.inputImportSettings) {
            this.elements.btnImportSettings.addEventListener('click', () => {
                this.elements.inputImportSettings.click();
            });
            this.elements.inputImportSettings.addEventListener('change', () => {
                this.importJsonFile(this.elements.inputImportSettings, (payload) => {
                    if (this.callbacks.onImportSettings) this.callbacks.onImportSettings(payload);
                });
            });
        }
    }

    importJsonFile(input, onLoaded) {
        const file = input?.files?.[0];
        if (!file) return;

        const resetInput = () => {
            input.value = '';
        };
        const fail = () => {
            alert(t('dataImportFailed'));
            resetInput();
        };

        try {
            const reader = new FileReader();
            reader.onload = () => {
                try {
                    const payload = JSON.parse(String(reader.result || ''));
                    onLoaded(payload);
                    resetInput();
                } catch {
                    fail();
                }
            };
            reader.onerror = fail;
            reader.readAsText(file);
        } catch {
            fail();
        }
    }
}
