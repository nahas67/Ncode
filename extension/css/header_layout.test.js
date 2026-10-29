import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';

const readCss = (file) => {
    const relativePath = file.startsWith('./') ? file : `./${file}`;
    return readFile(new URL(relativePath, import.meta.url), 'utf8');
};

describe('header layout styles', () => {
    it('keeps hidden icon buttons out of the rendered layout', async () => {
        const componentsCss = await readCss('./components.css');

        // [hidden] must be forced to display:none so hidden icon buttons never render.
        expect(componentsCss).toMatch(/\[hidden\]\s*{[^}]*display:\s*none\s*!important/s);
    });

    it('keeps the top header compact like AMC instead of leaving large edge padding', async () => {
        const headerCss = await readCss('./header.css');

        expect(headerCss).toMatch(/\.header\s*{[^}]*padding:\s*6px 12px 6px 8px/s);
        expect(headerCss).toMatch(
            /body\.layout-wide\s+\.header\s*{[^}]*padding-left:\s*calc\(var\(--sidebar-width\) \+ var\(--layout-gutter\)\)/s
        );
        expect(headerCss).toMatch(
            /body\.layout-wide\.sidebar-collapsed\s+\.header\s*{[^}]*padding-left:\s*calc\(var\(--sidebar-collapsed-width\) \+ var\(--layout-gutter-tight\)\)/s
        );
        expect(headerCss).toMatch(/\.header \.icon-btn\s*{[^}]*width:\s*36px/s);
        expect(headerCss).not.toContain('padding: 16px 40px 16px 20px');
    });

    it('keeps browser control status visible on narrow screens', async () => {
        const headerCss = await readCss('./header.css');

        expect(headerCss).toMatch(
            /@media\s*\(max-width:\s*600px\)[\s\S]*\.browser-control-bar\s*{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\) auto auto/s
        );
        expect(headerCss).not.toMatch(
            /@media\s*\(max-width:\s*600px\)[\s\S]*\.browser-control-status\s*{[^}]*display:\s*none/s
        );
        expect(headerCss).toMatch(
            /@media\s*\(max-width:\s*600px\)[\s\S]*\.browser-control-status\s*{[^}]*font-size:\s*10px/s
        );
    });

    it('styles the model selector like the AMC custom picker instead of a native pill select', async () => {
        const headerCss = await readCss('./header.css');

        expect(headerCss).toMatch(/\.model-picker-trigger\s*{[^}]*min-height:\s*36px/s);
        expect(headerCss).toMatch(
            /\.model-picker-trigger\s*{[^}]*border-radius:\s*var\(--radius-md\)/s
        );
        expect(headerCss).toMatch(/\.model-picker-menu\s*{[^}]*position:\s*absolute/s);
        expect(headerCss).toMatch(/\.model-picker-menu\s*{[^}]*max-width:\s*320px/s);
        expect(headerCss).toMatch(/\.model-picker-option\s*{[^}]*min-height:\s*54px/s);
        expect(headerCss).toMatch(/\.model-picker-option-id\s*{[^}]*font-family:\s*ui-monospace/s);
        expect(headerCss).toMatch(/\.model-native-select\s*{[^}]*position:\s*absolute/s);
        expect(headerCss).not.toContain('#model-select:hover');
        // Focus ring uses a real token (never the undefined --bg-primary).
        expect(headerCss).toMatch(/\.model-picker-trigger:focus-visible\s*{[^}]*var\(--bg-body\)/s);
        expect(headerCss).not.toContain('var(--bg-primary)');
        expect(headerCss).toMatch(
            /\.browser-control-status\s*{[^}]*color-mix\(in srgb,\s*var\(--primary\)/s
        );
        expect(headerCss).toMatch(
            /\.browser-control-bar\.is-attached\s*{[^}]*var\(--success-border\)/s
        );
    });
});
