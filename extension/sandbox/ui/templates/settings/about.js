import { TemplateIcons } from '../icons.js';

export const AboutSettingsTemplate = `
<div class="setting-group" id="about-settings-group">
    <h4 data-i18n="about">About</h4>
    <div class="setting-panel">
        <div class="setting-panel-row about-version-row">
            <div class="setting-panel-header">
                <h5 class="about-title">Gemini Nexus</h5>
                <div class="about-version-meta">
                    <span id="app-current-version"></span>
                    <span id="app-update-status" class="app-update-status"></span>
                </div>
            </div>
        </div>

        <div class="about-link-row">
            <a href="https://github.com/yeahhe365/Gemini-Nexus" target="_blank" class="github-link">
                ${TemplateIcons.GITHUB}
                <span data-i18n="sourceCode">Source</span>
                <span id="star-count" class="star-badge"></span>
            </a>

            <a href="https://github.com/yeahhe365/Gemini-Nexus/releases" target="_blank" class="github-link">
                ${TemplateIcons.RELEASES}
                <span data-i18n="releases">Releases</span>
            </a>
        </div>
    </div>
</div>`;
