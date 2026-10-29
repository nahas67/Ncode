// @ts-check
/**
 * Ncode loadable-extension verifier.
 *
 * Validates the packaged Chrome extension in `extension/dist` without launching
 * Chrome: manifest contract, MV3 background module graph, relative ESM import
 * completeness, page asset references, Ncode feature payload and test-file
 * leakage. Run after `npm run build:extension`.
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const extensionDir = path.join(rootDir, 'extension');
const distDir = path.join(extensionDir, 'dist');

let checks = 0;
let failures = 0;

function check(name, ok, detail = '') {
    checks += 1;
    if (ok) {
        console.log(`PASS ${name}${detail ? ` - ${detail}` : ''}`);
    } else {
        failures += 1;
        console.error(`FAIL ${name}${detail ? ` - ${detail}` : ''}`);
    }
}

async function exists(target) {
    try {
        await stat(target);
        return true;
    } catch {
        return false;
    }
}

async function read(dir, relativePath) {
    return readFile(path.join(dir, relativePath), 'utf8');
}

async function collectJsFiles(directory) {
    const files = [];
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) files.push(...(await collectJsFiles(absolute)));
        else if (entry.isFile() && /\.(?:js|mjs)$/.test(entry.name)) files.push(absolute);
    }
    return files;
}

const IMPORT_PATTERN =
    /(?:^|\n)\s*(?:import\s+(?:[^'"]+?\s+from\s+)?|export\s+[^'"]+?\s+from\s+)['"](\.{1,2}\/[^'"]+)['"]/g;

async function main() {
    check('dist directory exists', await exists(distDir));

    const manifest = JSON.parse(await read(distDir, 'manifest.json'));
    check('manifest v3', manifest.manifest_version === 3, `v${manifest.version}`);
    check('manifest identity is Ncode', manifest.name === 'Ncode' && manifest.version === '1.0.0');
    check(
        'MV3 module service worker declared',
        manifest.background?.service_worker === 'background/index.js' &&
            manifest.background?.type === 'module',
        manifest.background?.service_worker
    );
    check(
        'side panel + sandbox pages declared',
        manifest.side_panel?.default_path === 'sidepanel/index.html' &&
            Array.isArray(manifest.sandbox?.pages) &&
            manifest.sandbox.pages.includes('sandbox/index.html')
    );
    check(
        'required host permissions present',
        Array.isArray(manifest.permissions) &&
            ['storage', 'scripting', 'debugger', 'tabs', 'nativeMessaging'].every((permission) =>
                manifest.permissions.includes(permission)
            )
    );
    check(
        'content script bundle declared',
        (manifest.content_scripts || []).some((entry) =>
            (entry.js || []).some((file) => file === 'content/index.js' || file === 'content/youtube_summary_bundle.js')
        ) || (manifest.content_scripts || []).length > 0
    );

    const backgroundFiles = await collectJsFiles(path.join(distDir, 'background'));
    check('background module files packaged', backgroundFiles.length > 50, `${backgroundFiles.length} files`);

    const ncodeManagers = [
        'background/managers/ncode_goal_manager.js',
        'background/managers/ncode_compact_manager.js',
        'background/managers/ncode_harness_status.js',
        'background/managers/ncode_bridge_client.js',
    ];
    for (const manager of ncodeManagers) {
        check(`packaged ${manager}`, await exists(path.join(distDir, manager)));
    }

    const orchestratorFiles = [
        'shared/orchestrator/goal_state_machine.js',
        'shared/orchestrator/compact_resume_engine.js',
    ];
    for (const orchestratorFile of orchestratorFiles) {
        check(`packaged ${orchestratorFile}`, await exists(path.join(distDir, orchestratorFile)));
    }

    const goalMachineSource = await read(distDir, 'shared/orchestrator/goal_state_machine.js');
    check(
        'goal directive tags present in packaged orchestrator',
        ['ncode_preamble', 'ncode_goal_update', 'ncode_goal_complete'].every((tag) =>
            goalMachineSource.includes(tag)
        )
    );
    const constantsSource = await read(distDir, 'shared/config/constants_global.js');
    check(
        'packaged MCP defaults target 127.0.0.1:3001',
        constantsSource.includes('http://127.0.0.1:3001/mcp') &&
            constantsSource.includes("DEFAULT_PROVIDER: 'web'")
    );
    const connectionSource = await read(distDir, 'shared/settings/connection.js');
    check(
        'packaged Ncode local MCP server default',
        connectionSource.includes('Ncode Local PC & Shell') &&
            connectionSource.includes('ncode_local_pc') &&
            connectionSource.includes('normalizeNcodeMcpServers')
    );

    // Every relative ESM import inside the unpacked background/shared/services
    // trees must resolve inside dist (a missing copied module breaks the MV3
    // service worker at load time and is invisible to node --check).
    /** @type {string[]} */
    const sourceRoots = ['background', 'shared', 'services'];
    const unresolved = [];
    for (const sourceRoot of sourceRoots) {
        const absoluteRoot = path.join(distDir, sourceRoot);
        const files = await collectJsFiles(absoluteRoot);
        for (const file of files) {
            const source = await readFile(file, 'utf8');
            IMPORT_PATTERN.lastIndex = 0;
            let match;
            while ((match = IMPORT_PATTERN.exec(source)) !== null) {
                const specifier = match[1];
                if (!specifier.endsWith('.js') && !specifier.endsWith('.mjs')) continue;
                const resolved = path.resolve(path.dirname(file), specifier);
                if (!(await exists(resolved))) {
                    unresolved.push(`${path.relative(distDir, file)} -> ${specifier}`);
                }
            }
        }
    }
    check(
        'relative ESM imports resolve in packaged tree',
        unresolved.length === 0,
        unresolved.slice(0, 5).join('; ')
    );

    // Page shells must reference only existing local assets.
    const pages = ['sidepanel/index.html', 'sandbox/index.html', 'settings/index.html'];
    const missingReferences = [];
    for (const page of pages) {
        check(`packaged ${page}`, await exists(path.join(distDir, page)));
        const html = await read(distDir, page);
        const references = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((match) => match[1]);
        for (const reference of references) {
            if (/^(?:https?:|data:|#)/.test(reference)) continue;
            const clean = reference.split(/[?#]/)[0];
            const resolved = path.resolve(path.dirname(path.join(distDir, page)), clean);
            if (!(await exists(resolved))) missingReferences.push(`${page} -> ${reference}`);
        }
    }
    check('page asset references resolve', missingReferences.length === 0, missingReferences.slice(0, 5).join('; '));

    const sandboxBundleDir = path.join(distDir, 'assets');
    const assetFiles = await readdir(sandboxBundleDir).catch(() => []);
    const jsAssets = assetFiles.filter((file) => file.endsWith('.js'));
    let harnessTemplateFound = false;
    let harnessStatusHandlerFound = false;
    for (const asset of jsAssets) {
        const source = await readFile(path.join(sandboxBundleDir, asset), 'utf8');
        if (source.includes('ncode-preamble-ticker')) harnessTemplateFound = true;
        if (source.includes('NCODE_HARNESS_STATUS')) harnessStatusHandlerFound = true;
    }
    check('harness bar template bundled into sandbox UI', harnessTemplateFound);
    check('harness status message handler bundled', harnessStatusHandlerFound);
    let harnessCssFound = false;
    for (const asset of assetFiles.filter((file) => file.endsWith('.css'))) {
        const source = await readFile(path.join(sandboxBundleDir, asset), 'utf8');
        if (source.includes('ncode-harness')) {
            harnessCssFound = true;
            break;
        }
    }
    check('harness bar stylesheet bundled', harnessCssFound);

    const backgroundIndex = await read(distDir, 'background/index.js');
    check(
        'background wires goal/status/bridge managers',
        backgroundIndex.includes('NcodeGoalManager') &&
            backgroundIndex.includes('NcodeHarnessStatus') &&
            backgroundIndex.includes('NcodeBridgeClient')
    );

    // Tests must never ship.
    const allFiles = await (async () => {
        const stack = [distDir];
        const collected = [];
        while (stack.length) {
            const directory = stack.pop();
            const entries = await readdir(directory, { withFileTypes: true });
            for (const entry of entries) {
                const absolute = path.join(directory, entry.name);
                if (entry.isDirectory()) stack.push(absolute);
                else collected.push(absolute);
            }
        }
        return collected;
    })();
    const shippedTests = allFiles.filter((file) => /\.(?:test|spec)\.(?:js|ts)$/.test(file));
    check('no test files shipped', shippedTests.length === 0, shippedTests.slice(0, 3).join(', '));

    console.log(
        `\n${failures === 0 ? 'All' : failures} ${checks} packaged-extension checks ${failures === 0 ? 'passed' : 'completed with failures'}.`
    );
    process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((error) => {
    console.error('[ncode] verify-extension-dist failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
});
