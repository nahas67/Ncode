// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DataManagementSection } from './data_management.js';

describe('DataManagementSection', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        document.body.innerHTML = `
            <button id="download-logs"></button>
            <button id="export-history-data"></button>
            <button id="import-history-data"></button>
            <input id="import-history-file" type="file">
            <button id="export-settings-data"></button>
            <button id="import-settings-data"></button>
            <input id="import-settings-file" type="file">
        `;
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('fires data export callbacks and opens import file pickers', () => {
        const callbacks = {
            onDownloadLogs: vi.fn(),
            onExportHistory: vi.fn(),
            onExportSettings: vi.fn(),
        };
        new DataManagementSection(callbacks);
        const historyInput = document.getElementById('import-history-file');
        const settingsInput = document.getElementById('import-settings-file');
        const historyClick = vi.spyOn(historyInput, 'click').mockImplementation(() => {});
        const settingsClick = vi.spyOn(settingsInput, 'click').mockImplementation(() => {});

        document.getElementById('download-logs').click();
        document.getElementById('export-history-data').click();
        document.getElementById('export-settings-data').click();
        document.getElementById('import-history-data').click();
        document.getElementById('import-settings-data').click();

        expect(callbacks.onDownloadLogs).toHaveBeenCalled();
        expect(callbacks.onExportHistory).toHaveBeenCalled();
        expect(callbacks.onExportSettings).toHaveBeenCalled();
        expect(historyClick).toHaveBeenCalled();
        expect(settingsClick).toHaveBeenCalled();
    });

    it('reads selected JSON import files before firing import callbacks', () => {
        const callbacks = {
            onImportHistory: vi.fn(),
        };
        new DataManagementSection(callbacks);
        const input = document.getElementById('import-history-file');
        Object.defineProperty(input, 'files', {
            value: [{ name: 'history.json' }],
            configurable: true,
        });
        vi.stubGlobal(
            'FileReader',
            class {
                readAsText() {
                    this.result = '{"type":"GeminiNexus-History","history":[]}';
                    this.onload();
                }
            }
        );

        input.dispatchEvent(new Event('change'));

        expect(callbacks.onImportHistory).toHaveBeenCalledWith({
            type: 'GeminiNexus-History',
            history: [],
        });
        expect(input.value).toBe('');
    });

    it('alerts when an import file cannot be parsed', () => {
        const callbacks = {
            onImportSettings: vi.fn(),
        };
        const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
        new DataManagementSection(callbacks);
        const input = document.getElementById('import-settings-file');
        Object.defineProperty(input, 'files', {
            value: [{ name: 'settings.json' }],
            configurable: true,
        });
        vi.stubGlobal(
            'FileReader',
            class {
                readAsText() {
                    this.result = 'not json';
                    this.onload();
                }
            }
        );

        input.dispatchEvent(new Event('change'));

        expect(callbacks.onImportSettings).not.toHaveBeenCalled();
        expect(alertSpy).toHaveBeenCalledWith('Failed to read import file.');
    });
});
