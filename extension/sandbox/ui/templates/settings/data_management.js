import { TemplateIcons } from '../icons.js';

export const DataManagementSettingsTemplate = `
<div class="setting-group data-management-group">
    <h4 data-i18n="dataManagement">Data Management</h4>

    <div class="data-management-shell">
        <div class="data-management-card">
            <div class="data-management-card-main">
                <span class="data-management-card-icon">${TemplateIcons.HISTORY}</span>
                <div class="data-management-card-copy">
                    <h5 data-i18n="historyDataTitle">Chat History</h5>
                </div>
            </div>
            <div class="data-management-card-actions">
                <button id="export-history-data" type="button" class="data-action-btn data-action-btn-primary" data-i18n-title="exportHistoryData" title="Export History">
                    <span class="data-action-icon">${TemplateIcons.DOWNLOAD}</span>
                    <span data-i18n="exportHistoryData">Export History</span>
                </button>
                <button id="import-history-data" type="button" class="data-action-btn data-action-btn-danger" data-i18n-title="importHistoryData" title="Import History">
                    <span class="data-action-icon">${TemplateIcons.UPLOAD}</span>
                    <span data-i18n="importHistoryData">Import History</span>
                </button>
            </div>
        </div>

        <div class="data-management-card">
            <div class="data-management-card-main">
                <span class="data-management-card-icon">${TemplateIcons.SETTINGS}</span>
                <div class="data-management-card-copy">
                    <h5 data-i18n="settingsDataTitle">Settings Backup</h5>
                </div>
            </div>
            <div class="data-management-card-actions">
                <button id="export-settings-data" type="button" class="data-action-btn data-action-btn-primary" data-i18n-title="exportSettingsData" title="Export Settings">
                    <span class="data-action-icon">${TemplateIcons.DOWNLOAD}</span>
                    <span data-i18n="exportSettingsData">Export Settings</span>
                </button>
                <button id="import-settings-data" type="button" class="data-action-btn data-action-btn-danger" data-i18n-title="importSettingsData" title="Import Settings">
                    <span class="data-action-icon">${TemplateIcons.UPLOAD}</span>
                    <span data-i18n="importSettingsData">Import Settings</span>
                </button>
            </div>
        </div>

        <div class="data-management-card data-management-card-muted">
            <div class="data-management-card-main">
                <span class="data-management-card-icon">${TemplateIcons.DOWNLOAD}</span>
                <div class="data-management-card-copy">
                    <h5 data-i18n="debugLogs">Debug Logs</h5>
                </div>
            </div>
            <div class="data-management-card-actions">
                <button id="download-logs" type="button" class="data-action-btn data-action-btn-secondary" data-i18n-title="downloadLogs" title="Download Logs">
                    <span class="data-action-icon">${TemplateIcons.DOWNLOAD}</span>
                    <span data-i18n="downloadLogs">Download Logs</span>
                </button>
            </div>
        </div>
    </div>

    <input id="import-history-file" type="file" accept="application/json,.json" hidden>
    <input id="import-settings-file" type="file" accept="application/json,.json" hidden>
</div>`;
