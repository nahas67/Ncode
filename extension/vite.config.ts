import { readFile } from 'node:fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { defineConfig, type Plugin } from 'vite';

// Define __dirname for ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function copySidepanelPreload(): Plugin {
    return {
        name: 'copy-sidepanel-preload',
        apply: 'build',
        async generateBundle() {
            const source = await readFile(path.resolve(__dirname, 'sidepanel/preload.js'), 'utf8');
            this.emitFile({
                type: 'asset',
                fileName: 'sidepanel/preload.js',
                source,
            });
        },
    };
}

export default defineConfig(() => {
    return {
        // Chrome extension pages (especially sandboxed ones) must load assets
        // via relative URLs. Absolute `/assets/...` breaks sandbox module
        // preloads → shell paints but no click handlers (dead send button).
        base: './',
        server: {
            port: 3000,
            host: '0.0.0.0',
        },
        plugins: [copySidepanelPreload()],
        build: {
            chunkSizeWarningLimit: 1600,
            rollupOptions: {
                input: {
                    sidepanel: path.resolve(__dirname, 'sidepanel/index.html'),
                    sandbox: path.resolve(__dirname, 'sandbox/index.html'),
                    settings: path.resolve(__dirname, 'settings/index.html'),
                },
            },
        },
        test: {
            setupFiles: ['./test/setup.js'],
            exclude: ['**/node_modules/**', '**/dist/**', '**/artifacts/**'],
            // Deliberately no global test.environment: background logic tests
            // run in node while DOM tests opt in per file via
            // `// @vitest-environment jsdom`. New DOM tests must add the pragma.
        },
    };
});
