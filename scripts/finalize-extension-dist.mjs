// @ts-check
/**
 * Ncode build finalizer.
 *
 * The upstream Gemini-Nexus packaging step assembles a loadable Chrome
 * extension inside `extension/artifacts/chrome-extension` (manifest, background,
 * content bundles, services, shared, vendor and the Vite-built pages). Ncode's
 * unified build contract is `./Ncode/extension/dist`, so this script mirrors the
 * packaged artifact into `dist/` after validating that the payload is complete.
 *
 * Usage (from ./Ncode):
 *   node scripts/finalize-extension-dist.mjs
 */
import { cp, mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const extensionDir = path.join(rootDir, 'extension');
const packageDir = path.join(extensionDir, 'artifacts', 'chrome-extension');
const distDir = path.join(extensionDir, 'dist');

const REQUIRED_PATHS = [
    'manifest.json',
    'logo.png',
    'background/index.js',
    'shared/config/constants.js',
    'services/providers/web.js',
    'content/index.js',
    'sidepanel/index.html',
    'sidepanel/preload.js',
    'sandbox/index.html',
    'settings/index.html',
    'css/ncode_harness.css',
    'assets',
    'vendor',
];

const FORBIDDEN_RELATIVE_SEGMENTS = ['/node_modules/', '/artifacts/', '/.git/'];

async function exists(target) {
    try {
        await stat(target);
        return true;
    } catch {
        return false;
    }
}

async function collectFiles(directory) {
    /** @type {string[]} */
    const files = [];
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            files.push(...(await collectFiles(absolute)));
        } else if (entry.isFile()) {
            files.push(absolute);
        }
    }
    return files;
}

async function main() {
    if (!(await exists(packageDir))) {
        throw new Error(
            `Missing packaged extension at ${path.relative(rootDir, packageDir)}. ` +
                'Run `npm run build:extension` (it runs vite build + package-extension first).'
        );
    }

    for (const relativePath of REQUIRED_PATHS) {
        const absolute = path.join(packageDir, relativePath);
        if (!(await exists(absolute))) {
            throw new Error(
                `Packaged extension is incomplete: missing ${relativePath}. ` +
                    'Re-run `node extension/scripts/package-extension.mjs`.'
            );
        }
    }

    const manifest = JSON.parse(await readFile(path.join(packageDir, 'manifest.json'), 'utf8'));
    if (manifest.manifest_version !== 3) {
        throw new Error('Packaged manifest.json is not Manifest V3.');
    }

    const packagedFiles = await collectFiles(packageDir);
    for (const file of packagedFiles) {
        const relativePath = `/${path.relative(packageDir, file).split(path.sep).join('/')}`;
        if (FORBIDDEN_RELATIVE_SEGMENTS.some((segment) => relativePath.includes(segment))) {
            throw new Error(`Packaged extension contains forbidden path: ${relativePath}`);
        }
        if (/\.(?:test|spec)\.(?:js|ts)$/.test(file)) {
            throw new Error(`Packaged extension contains a test file: ${relativePath}`);
        }
    }

    await rm(distDir, { recursive: true, force: true });
    await mkdir(distDir, { recursive: true });
    await cp(packageDir, distDir, { recursive: true });

    const buildInfo = {
        name: 'ncode-extension',
        version: manifest.version,
        builtAt: new Date().toISOString(),
        payloadFiles: packagedFiles.length,
        sourceArtifact: path.relative(rootDir, packageDir).split(path.sep).join('/'),
    };
    const { writeFile } = await import('node:fs/promises');
    await writeFile(
        path.join(distDir, 'ncode-build-info.json'),
        `${JSON.stringify(buildInfo, null, 2)}\n`,
        'utf8'
    );

    console.log(
        `[ncode] Loadable extension ready at ${path.relative(rootDir, distDir)} ` +
            `(${packagedFiles.length + 1} files, v${manifest.version}).`
    );
    console.log('[ncode] Load it with chrome://extensions -> Developer mode -> Load unpacked -> dist');
}

main().catch((error) => {
    console.error('[ncode] finalize-extension-dist failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
});
