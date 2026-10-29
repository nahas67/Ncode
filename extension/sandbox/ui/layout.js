import {
    SidebarTemplate,
    HeaderTemplate,
    NcodeHarnessTemplate,
    ChatTemplate,
    FooterTemplate,
    ViewerTemplate,
    TabSelectorTemplate,
    SettingsModalTemplate,
} from './templates/index.js';

export function renderLayout() {
    const LayoutTemplate =
        SidebarTemplate +
        HeaderTemplate +
        NcodeHarnessTemplate +
        ChatTemplate +
        FooterTemplate +
        ViewerTemplate +
        TabSelectorTemplate +
        SettingsModalTemplate;
    const app = document.getElementById('app');
    if (app) app.innerHTML = LayoutTemplate;
}
