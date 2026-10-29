import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
    collectPackagedAssetReferences,
    createPackagedManifest,
    findMissingPackagedAssetReferences,
    formatContentBundle,
    getUnbundledContentScriptFiles,
    normalizePackagedAssetReference,
    rewriteHtmlAssetPathsToRelative,
    shouldExcludeFromPackage,
} from './package-extension.mjs';

describe('package-extension', () => {
    it('excludes test files from packaged source directories', () => {
        expect(shouldExcludeFromPackage('services/parser.test.js')).toBe(true);
        expect(
            shouldExcludeFromPackage('background/managers/session/context_manager.test.js')
        ).toBe(true);
        expect(shouldExcludeFromPackage('shared/text/tool_call_text.test.js')).toBe(true);
    });

    it('keeps runtime source files in the package', () => {
        expect(shouldExcludeFromPackage('services/parser.js')).toBe(false);
        expect(shouldExcludeFromPackage('background/index.js')).toBe(false);
        expect(shouldExcludeFromPackage('shared/text/tool_call_text.js')).toBe(false);
        expect(shouldExcludeFromPackage('dist/assets/app.js')).toBe(false);
    });

    it('rewrites packaged manifest to use the bundled content entry', () => {
        const manifest = {
            name: 'Gemini Nexus',
            content_scripts: [
                {
                    matches: ['<all_urls>'],
                    js: ['content/overlay.js', 'content/index.js'],
                    run_at: 'document_end',
                },
                {
                    matches: ['<all_urls>'],
                    js: ['content/shortcut_frame_bridge.js'],
                    run_at: 'document_start',
                    all_frames: true,
                },
                {
                    matches: ['https://gemini.google.com/*'],
                    js: ['content/gemini_watermark_bridge.js'],
                    run_at: 'document_start',
                },
                {
                    matches: ['https://gemini.google.com/*'],
                    js: [
                        'content/gemini_watermark_page.js',
                        'vendor/gemini-watermark-remover/content_main.js',
                    ],
                    run_at: 'document_start',
                    world: 'MAIN',
                },
            ],
        };

        expect(createPackagedManifest(manifest).content_scripts).toEqual([
            {
                matches: ['<all_urls>'],
                js: ['content/index.js'],
                run_at: 'document_end',
            },
            {
                matches: ['<all_urls>'],
                js: ['content/shortcut_frame_bridge.js'],
                run_at: 'document_start',
                all_frames: true,
            },
            {
                matches: ['https://gemini.google.com/*'],
                js: ['content/gemini_watermark_bridge.js'],
                run_at: 'document_start',
            },
            {
                matches: ['https://gemini.google.com/*'],
                js: [
                    'content/gemini_watermark_page.js',
                    'vendor/gemini-watermark-remover/content_main.js',
                ],
                run_at: 'document_start',
                world: 'MAIN',
            },
        ]);
    });

    it('formats content bundle segments in deterministic order', () => {
        const bundle = formatContentBundle([
            { relativePath: 'content/first.js', source: 'window.first = true;' },
            { relativePath: 'content/second.js', source: 'window.second = window.first;' },
        ]);

        expect(bundle).toContain('// ----- content/first.js -----');
        expect(bundle).toContain('// ----- content/second.js -----');
        expect(bundle.indexOf('window.first = true;')).toBeLessThan(
            bundle.indexOf('window.second = window.first;')
        );
        expect(bundle.endsWith('\n')).toBe(true);
    });

    it('does not copy vendored content scripts twice when packaging unbundled entries', () => {
        expect(
            getUnbundledContentScriptFiles({
                content_scripts: [
                    {
                        matches: ['<all_urls>'],
                        js: ['content/index.js'],
                    },
                    {
                        matches: ['<all_urls>'],
                        js: ['content/shortcut_frame_bridge.js'],
                        all_frames: true,
                    },
                    {
                        matches: ['https://gemini.google.com/*'],
                        js: ['content/gemini_watermark_bridge.js'],
                        run_at: 'document_start',
                    },
                    {
                        matches: ['https://gemini.google.com/*'],
                        js: [
                            'content/gemini_watermark_page.js',
                            'vendor/gemini-watermark-remover/content_main.js',
                        ],
                        world: 'MAIN',
                    },
                ],
            })
        ).toEqual([
            'content/shortcut_frame_bridge.js',
            'content/gemini_watermark_bridge.js',
            'content/gemini_watermark_page.js',
        ]);
    });

    it('reports missing packaged Vite assets referenced by extension HTML', async () => {
        const packageRoot = await mkdtemp(path.join(tmpdir(), 'gemini-nexus-package-'));

        try {
            await mkdir(path.join(packageRoot, 'sidepanel'), { recursive: true });
            await mkdir(path.join(packageRoot, 'assets'), { recursive: true });
            await writeFile(
                path.join(packageRoot, 'sidepanel/index.html'),
                [
                    '<link rel="stylesheet" href="/assets/sidepanel.css">',
                    '<link rel="stylesheet" href="./assets/theme.css?v=1">',
                    '<script type="module" src="/assets/sidepanel.js"></script>',
                ].join('\n'),
                'utf8'
            );
            await writeFile(path.join(packageRoot, 'assets/sidepanel.js'), '', 'utf8');

            expect(
                await findMissingPackagedAssetReferences(packageRoot, ['sidepanel/index.html'])
            ).toEqual([
                'sidepanel/index.html -> assets/sidepanel.css',
                'sidepanel/index.html -> assets/theme.css',
            ]);

            await writeFile(path.join(packageRoot, 'assets/sidepanel.css'), '', 'utf8');
            await writeFile(path.join(packageRoot, 'assets/theme.css'), '', 'utf8');

            expect(
                await findMissingPackagedAssetReferences(packageRoot, ['sidepanel/index.html'])
            ).toEqual([]);
        } finally {
            await rm(packageRoot, { recursive: true, force: true });
        }
    });

    it('requires packaged settings HTML asset references to exist', async () => {
        const packageRoot = await mkdtemp(path.join(tmpdir(), 'gemini-nexus-settings-package-'));

        try {
            await mkdir(path.join(packageRoot, 'settings'), { recursive: true });
            await writeFile(
                path.join(packageRoot, 'settings/index.html'),
                '<script type="module" src="/assets/settings.js"></script>',
                'utf8'
            );

            expect(
                await findMissingPackagedAssetReferences(packageRoot, ['settings/index.html'])
            ).toEqual(['settings/index.html -> assets/settings.js']);

            await mkdir(path.join(packageRoot, 'assets'), { recursive: true });
            await writeFile(path.join(packageRoot, 'assets/settings.js'), '', 'utf8');

            expect(
                await findMissingPackagedAssetReferences(packageRoot, ['settings/index.html'])
            ).toEqual([]);
        } finally {
            await rm(packageRoot, { recursive: true, force: true });
        }
    });

    it('normalizes absolute and relative asset references to package-root paths', () => {
        expect(normalizePackagedAssetReference('/assets/a.js')).toBe('assets/a.js');
        expect(normalizePackagedAssetReference('../assets/a.js')).toBe('assets/a.js');
        expect(normalizePackagedAssetReference('./assets/a.js')).toBe('assets/a.js');
        expect(normalizePackagedAssetReference('assets/a.js')).toBe('assets/a.js');
        expect(normalizePackagedAssetReference('preload.js')).toBeNull();
        expect(
            collectPackagedAssetReferences(
                '<script src="../assets/sandbox.js"></script><link href="/assets/x.css">'
            )
        ).toEqual(['assets/sandbox.js', 'assets/x.css']);
    });

    it('rewrites absolute /assets paths to relative paths for nested HTML pages', () => {
        const html =
            '<script type="module" src="/assets/sandbox.js"></script>\n' +
            '<link rel="stylesheet" href="/assets/x.css">';
        expect(rewriteHtmlAssetPathsToRelative(html, 'sandbox/index.html')).toBe(
            '<script type="module" src="../assets/sandbox.js"></script>\n' +
                '<link rel="stylesheet" href="../assets/x.css">'
        );
        expect(rewriteHtmlAssetPathsToRelative(html, 'sidepanel/index.html')).toContain(
            '../assets/sandbox.js'
        );
    });
});
