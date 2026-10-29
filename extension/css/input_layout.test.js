import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';

const readCss = (file) => readFile(new URL(`./${file}`, import.meta.url), 'utf8');

describe('input layout styles', () => {
    it('keeps the wide composer inset from the sidebar edge like AMC', async () => {
        const inputCss = await readCss('input.css');
        const baseCss = await readCss('base.css');

        expect(baseCss).toMatch(/--sidebar-width:\s*16\.2rem/);
        expect(baseCss).toMatch(/--sidebar-collapsed-width:\s*52\.2px/);
        expect(baseCss).toMatch(/--composer-max-width:\s*40\.32rem/);

        expect(inputCss).toMatch(/\.footer\s*{[^}]*box-sizing:\s*border-box/s);
        expect(inputCss).toMatch(
            /body\.layout-wide\s+\.footer\s*{[^}]*padding-left:\s*calc\(var\(--sidebar-width\) \+ var\(--layout-gutter\)\)/s
        );
        expect(inputCss).toMatch(
            /body\.layout-wide\.sidebar-collapsed\s+\.footer\s*{[^}]*padding-left:\s*calc\(var\(--sidebar-collapsed-width\) \+ var\(--layout-gutter-tight\)\)/s
        );
        expect(inputCss).not.toContain('body.layout-wide .footer {\n    padding-left: 16.2rem;');
    });

    it('keeps the composer close to AMC with a single dense rounded shell', async () => {
        const inputCss = await readCss('input.css');
        const attachmentsCss = await readCss('input_attachments.css');

        expect(inputCss).toMatch(
            /\.input-wrapper\s*{[^}]*max-width:\s*var\(--composer-max-width\)/s
        );
        expect(inputCss).toMatch(
            /\.input-wrapper\s*{[^}]*border:\s*1px solid var\(--border-color\)/s
        );
        expect(inputCss).toMatch(/\.input-wrapper\s*{[^}]*border-radius:\s*var\(--radius-xl\)/s);
        expect(inputCss).toMatch(/\.input-wrapper\s*{[^}]*background:\s*var\(--bg-input\)/s);
        expect(inputCss).toMatch(/\.composer-actions\s*{[^}]*justify-content:\s*space-between/s);
        expect(inputCss).toMatch(/\.composer-textarea-shell\s*{[^}]*cursor:\s*text/s);
        expect(inputCss).toMatch(/#prompt\s*{[^}]*min-height:\s*26px/s);
        expect(inputCss).toMatch(
            /#upload-btn,\s*#new-chat-composer-btn,\s*#send\s*{[^}]*width:\s*40px/s
        );
        // Composer new-chat button shares the upload button's icon-button treatment.
        expect(inputCss).toMatch(
            /#upload-btn,\s*#new-chat-composer-btn\s*{[^}]*color:\s*var\(--text-secondary\)/s
        );
        expect(inputCss).toMatch(/#new-chat-composer-btn svg\s*{[^}]*width:\s*20px/s);
        expect(inputCss).not.toContain('.input-row');

        expect(attachmentsCss).toMatch(/\.image-preview\s*{[^}]*padding:\s*0 4px 8px/s);
        expect(attachmentsCss).toMatch(/\.preview-item\s*{[^}]*width:\s*64px/s);
        // Remove control is always discoverable on touch; fine pointers can fade on hover.
        expect(attachmentsCss).toMatch(/\.preview-remove-btn\s*{[^}]*opacity:\s*0\.92/s);
        expect(attachmentsCss).toMatch(
            /@media\s*\(hover:\s*hover\)\s*and\s*\(pointer:\s*fine\)[\s\S]*\.preview-remove-btn\s*{[^}]*opacity:\s*0/s
        );
    });

    it('uses primary toggles + menus instead of a horizontal scroll shell', async () => {
        const inputCss = await readCss('input.css');

        expect(inputCss).toMatch(/\.tools-primary\s*{/s);
        expect(inputCss).toMatch(/\.tool-btn\.tool-toggle\.active/s);
        expect(inputCss).toMatch(/\.tools-menu\s*{/s);
        expect(inputCss).toMatch(/body:not\(\.has-page-context\)\s+\.context-aware/s);
        expect(inputCss).not.toMatch(/\.tools-scroll-shell\s*{/s);
        expect(inputCss).toMatch(/\.capture-dropdown\s*{[^}]*flex-shrink:\s*0/s);
    });

    it('masks the browser-control cursor icon with currentColor and focuses tools', async () => {
        const inputCss = await readCss('input.css');

        expect(inputCss).toMatch(
            /\.tool-btn\s+\.tool-icon-browser-control\s*,\s*\.tool-disclosure-icon\s+\.tool-icon-browser-control\s*{[^}]*mask-image:\s*url\(['"]?\.\.\/assets\/cursors\/cursor-chat\.png['"]?\)/s
        );
        expect(inputCss).toMatch(
            /\.tool-btn\s+\.tool-icon-browser-control\s*,\s*\.tool-disclosure-icon\s+\.tool-icon-browser-control\s*{[^}]*background-color:\s*currentColor/s
        );
        expect(inputCss).not.toMatch(/filter:\s*brightness\(0\)/);
        expect(inputCss).toMatch(/\.tool-btn:focus-visible\s*{/s);
        // Narrow sidepanel hides text labels only — not the mask-based icon span.
        expect(inputCss).toMatch(
            /@media\s*\(max-width:\s*600px\)[\s\S]*\.tools-primary\s+\.tool-btn\s+span:not\(\.tool-icon-img\)/s
        );
        expect(inputCss).not.toMatch(
            /@media\s*\(max-width:\s*600px\)[\s\S]*\.tools-primary\s+\.tool-btn\s+span\s*,/s
        );
    });

    it('matches AMC send button styles and generating states', async () => {
        const inputCss = await readCss('input.css');
        const statesCss = await readCss('input_states.css');

        expect(inputCss).toMatch(/#send\s*{[^}]*width:\s*36px[^}]*height:\s*36px/is);
        expect(inputCss).toMatch(/#send\s*{[^}]*background:\s*#3964fe/is);
        expect(inputCss).toMatch(
            /\[data-theme=['"]dark['"]\]\s+#send\s*{[^}]*background:\s*#679efe/is
        );
        expect(inputCss).toMatch(/#send:hover\s*{[^}]*background:\s*#3358e0/is);
        expect(inputCss).toMatch(
            /\[data-theme=['"]dark['"]\]\s+#send:hover\s*{[^}]*background:\s*#5a8de0/is
        );
        expect(inputCss).toMatch(/#send\.is-empty:not\(\.generating\)\s*{[^}]*opacity:\s*0\.4/s);
        expect(inputCss).toMatch(/#send svg\s*{[^}]*width:\s*16px[^}]*height:\s*16px/s);

        expect(statesCss).toMatch(
            /#send\.generating\s*{[^}]*background:\s*#dc2626[^}]*color:\s*#ffffff/is
        );
        expect(statesCss).toMatch(
            /\[data-theme=['"]dark['"]\]\s+#send\.generating\s*{[^}]*background:\s*#7f1d1d/is
        );
        expect(statesCss).toMatch(/#send\.generating::before\s*{[^}]*display:\s*none/s);
    });
});
