import { describe, expect, it } from 'vitest';

import { exists, readJson, readProjectFile } from './project-structure/helpers.js';

describe('project runtime config', () => {
    it('keeps release version metadata synchronized', async () => {
        const packageJson = await readJson('package.json');
        const packageLock = await readJson('package-lock.json');
        const manifest = await readJson('manifest.json');
        const changelog = await readProjectFile('CHANGELOG.md');
        const firstHeading = changelog.split('\n').find((line) => line.startsWith('## '));

        expect(manifest.version).toBe(packageJson.version);
        expect(packageLock.version).toBe(packageJson.version);
        expect(packageLock.packages[''].version).toBe(packageJson.version);
        expect(firstHeading).toContain(`v${packageJson.version}`);
    });

    it('keeps type checking strict while allowing incremental JS migration', async () => {
        const tsconfig = await readJson('tsconfig.json');
        const compilerOptions = tsconfig.compilerOptions || {};

        expect(compilerOptions.strict).toBe(true);
        expect(compilerOptions.allowJs).toBe(true);
        expect(compilerOptions.checkJs).toBe(false);

        const checkedCoreFiles = [
            'scripts/package-extension.mjs',
            'background/managers/mcp/transport.js',
            'background/managers/mcp/tool_result.js',
            'background/managers/mcp/preamble.js',
            'background/managers/mcp/server_tools.js',
        ];

        for (const file of checkedCoreFiles) {
            const source = await readProjectFile(file);
            expect(source.startsWith('// @ts-check')).toBe(true);
        }
    });

    it('does not depend on remotely hosted runtime code or styles', async () => {
        const manifest = await readJson('manifest.json');
        const sandboxCsp = manifest.content_security_policy?.sandbox || '';
        const runtimeFiles = [
            'sandbox/boot/loader.js',
            'sandbox/index.html',
            'content/toolbar/view/dom.js',
        ];

        expect(sandboxCsp).not.toContain('cdn.jsdelivr.net');

        for (const file of runtimeFiles) {
            const source = await readProjectFile(file);
            expect(source).not.toMatch(/https:\/\/cdn\.jsdelivr\.net/);
        }
    });

    it('keeps extension pages free of inline scripts blocked by extension CSP', async () => {
        const manifest = await readJson('manifest.json');
        const extensionCsp = manifest.content_security_policy?.extension_pages || '';
        const extensionPages = ['sidepanel/index.html'];

        expect(extensionCsp).toContain("script-src 'self'");

        for (const file of extensionPages) {
            const source = await readProjectFile(file);
            expect(source).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/i);
        }
    });

    it('keeps vendor assets limited to extension runtime resources', async () => {
        await expect(exists('vendor/katex/katex.min.css')).resolves.toBe(true);
        await expect(exists('vendor/highlight.js/atom-one-dark.min.css')).resolves.toBe(true);
        await expect(exists('vendor/chrome-devtools-mcp')).resolves.toBe(false);
    });

    it('declares an unused-code scanner configured for extension entry points', async () => {
        const packageJson = await readJson('package.json');
        const knipConfig = await readJson('knip.json');
        const manifest = await readJson('manifest.json');
        const manifestContentScripts = manifest.content_scripts.flatMap((entry) => entry.js ?? []);

        expect(packageJson.scripts['lint:unused']).toBe('knip --no-progress');
        expect(packageJson.scripts.check).toContain('npm run lint:unused');
        expect(packageJson.devDependencies.knip).toBeDefined();
        for (const contentScript of manifestContentScripts) {
            expect(knipConfig.entry).not.toContain(contentScript);
        }
        expect(knipConfig.entry).toContain('content/**/*.js');
        expect(knipConfig.entry).toContain('shared/ui/**/*.js');
        expect(knipConfig.entry).toContain('shared/dom/**/*.js');
        expect(knipConfig.entry).toContain('vendor/gemini-watermark-remover/**/*.js');
        expect(knipConfig.entry).toEqual(
            expect.arrayContaining([
                'background/index.js',
                'sidepanel/index.html',
                'sidepanel/preload.js',
                'sandbox/index.html',
                'settings/index.html',
                'settings/index.js',
                'scripts/*.mjs',
                'scripts/*.test.js',
            ])
        );
        expect(knipConfig.project).toContain('**/*.{js,mjs,ts}');
        const ignoredFiles = knipConfig.ignore || [];
        expect(ignoredFiles).not.toEqual(
            expect.arrayContaining([
                'shared/constants.js',
                'shared/crop_utils.js',
                'shared/messaging.js',
                'shared/tool_call_text.js',
                'shared/utils.js',
                'shared/watermark_remover.js',
            ])
        );
    });

    it('keeps Chrome Web Store sample config free of release-version drift', async () => {
        const envExample = await readProjectFile('.env.chrome-webstore.example');

        expect(envExample).not.toMatch(/CHROME_WEBSTORE_ZIP_PATH=.*v\d+\.\d+\.\d+/);
    });
});
