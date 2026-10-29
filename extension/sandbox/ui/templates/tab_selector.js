import { TemplateIcons } from './icons.js';

export const TabSelectorTemplate = `
    <!-- BROWSER CONTROL BAR -->
    <div id="browser-control-bar" class="browser-control-bar" hidden>
        <button id="browser-control-target" class="browser-control-target" type="button" data-i18n-title="selectTabTooltip" title="Select a tab to control">
            <span id="browser-control-icon-wrap" class="browser-control-icon-wrap">
                <span id="browser-control-fallback-icon">${TemplateIcons.BROWSER_TAB}</span>
                <img id="browser-control-favicon" alt="" hidden>
            </span>
            <span class="browser-control-copy">
                <span id="browser-control-title" class="browser-control-title" data-i18n="browserControlNoTab">Choose a tab to control</span>
                <span id="browser-control-meta" class="browser-control-meta"></span>
            </span>
        </button>
        <span id="browser-control-status" class="browser-control-status" data-i18n="browserControlReady">Ready</span>
        <button id="browser-control-stop" class="browser-control-stop icon-btn small" type="button" data-i18n-title="stopBrowserControl" title="Stop browser control">✕</button>
    </div>

    <!-- TAB SELECTOR MODAL -->
    <div id="tab-selector-modal" class="settings-modal" role="dialog" aria-modal="true" aria-labelledby="tab-selector-title">
        <div class="settings-content">
            <div class="settings-header">
                <h3 id="tab-selector-title" data-i18n="selectTab">Select Active Tab</h3>
                <button id="close-tab-selector" class="icon-btn small" data-i18n-title="close" title="Close">✕</button>
            </div>
            <div class="settings-body">
                <div id="tab-list" class="history-list"></div>
            </div>
        </div>
    </div>
`;
