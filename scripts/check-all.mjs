// @ts-check
/**
 * Ncode acceptance gate.
 *
 * Runs the complete static + runtime verification that does not require a live
 * Chrome profile:
 *   1. syntax-check every authored JavaScript/ESM file in the Ncode tree
 *   2. verify the extension mirror of the orchestrator is byte-identical
 *   3. reject lazy placeholders/TODO stubs in Ncode-authored sources
 *   4. run the orchestrator contract smoke test
 *   5. run the PC daemon smoke test (real spawned daemons)
 *   6. verify the packaged/loadable extension in extension/dist
 *   7. verify the unified root scripts exist
 *
 * Usage (from ./Ncode):  npm run check
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

let checks = 0;
let failures = 0;

function report(name, ok, detail = '') {
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
        await readdir(path.dirname(target));
        await readFile(target);
        return true;
    } catch {
        return false;
    }
}

const SKIP_DIRECTORY_NAMES = new Set([
    'node_modules',
    'dist',
    'artifacts',
    '.git',
    'vendor',
    '__pycache__',
]);

async function collectFiles(directory, predicate) {
    const collected = [];
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            if (SKIP_DIRECTORY_NAMES.has(entry.name)) continue;
            collected.push(...(await collectFiles(absolute, predicate)));
        } else if (entry.isFile() && predicate(absolute)) {
            collected.push(absolute);
        }
    }
    return collected;
}

function nodeCheck(file) {
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    if (result.status === 0) return { ok: true };
    return { ok: false, detail: (result.stderr || result.stdout || '').split('\n')[0].slice(0, 220) };
}

function runNodeScript(relativePath, timeoutMs = 300000) {
    const absolute = path.join(rootDir, relativePath);
    const result = spawnSync(process.execPath, [absolute], {
        cwd: rootDir,
        encoding: 'utf8',
        timeout: timeoutMs,
    });
    return {
        ok: result.status === 0,
        status: result.status,
        tail: `${result.stdout || ''}${result.stderr || ''}`.trim().split('\n').slice(-3).join(' | '),
    };
}

function sha256(buffer) {
    return createHash('sha256').update(buffer).digest('hex');
}

const PLACEHOLDER_PATTERNS = [
    { label: 'TODO', pattern: /\bTODO\b/ },
    { label: 'FIXME', pattern: /\bFIXME\b/ },
    { label: 'implement later', pattern: /implement(?:ed)?\s+later/i },
    { label: 'coming soon', pattern: /coming\s+soon/i },
    { label: 'not implemented yet', pattern: /not\s+implemented\s+yet/i },
    { label: 'lazy ellipsis placeholder', pattern: /\/\/\s*\.\.\.\s*$/m },
];

const AUTHORED_FILE_PATTERNS = [
    /^orchestrator\/.*\.(?:js|mjs)$/,
    /^pc-daemon\/(?:server\.mjs|smoke_test\.mjs)$/,
    /^scripts\/.*\.mjs$/,
    /^extension\/background\/managers\/ncode_.*\.js$/,
    /^extension\/background\/handlers\/session\/prompt\/.*\.js$/,
    /^extension\/background\/handlers\/session\/prompt_handler\.js$/,
    /^extension\/background\/handlers\/session\/index\.js$/,
    /^extension\/background\/messages\.js$/,
    /^extension\/background\/index\.js$/,
    /^extension\/background\/managers\/bridge_records\.js$/,
    /^extension\/shared\/settings\/connection\.js$/,
    /^extension\/shared\/config\/constants_global\.js$/,
    /^extension\/shared\/orchestrator\/.*\.js$/,
    /^extension\/sandbox\/ui\/ncode_harness_bar\.js$/,
    /^extension\/sandbox\/ui\/templates\/ncode_harness\.js$/,
    /^extension\/sandbox\/ui\/ui_controller\.js$/,
    /^extension\/sandbox\/controllers\/(?:message_handler|prompt)\.js$/,
    /^extension\/sidepanel\/core\/window_actions\.js$/,
    /^extension\/manifest\.json$/,
];

const REQUIRED_ROOT_SCRIPTS = ['install:all', 'build:extension', 'start:daemon', 'dev'];

async function main() {
    // 1. Syntax check every authored JS/ESM file.
    const jsFiles = await collectFiles(rootDir, (file) => /\.(?:js|mjs)$/.test(file));
    const syntaxFailures = [];
    for (const file of jsFiles) {
        const result = nodeCheck(file);
        if (!result.ok) syntaxFailures.push(`${path.relative(rootDir, file)}: ${result.detail}`);
    }
    report(
        'syntax-check authored JS/ESM',
        syntaxFailures.length === 0,
        `${jsFiles.length} files${syntaxFailures.length ? `; ${syntaxFailures[0]}` : ''}`
    );

    // 2. Orchestrator source and extension mirror are byte-identical.
    const mirrorPairs = [
        ['orchestrator/goal_state_machine.js', 'extension/shared/orchestrator/goal_state_machine.js'],
        ['orchestrator/compact_resume_engine.js', 'extension/shared/orchestrator/compact_resume_engine.js'],
    ];
    const mirrorFailures = [];
    for (const [source, mirror] of mirrorPairs) {
        const [sourceBytes, mirrorBytes] = await Promise.all([
            readFile(path.join(rootDir, source)),
            readFile(path.join(rootDir, mirror)),
        ]);
        if (sha256(sourceBytes) !== sha256(mirrorBytes)) mirrorFailures.push(`${mirror} differs`);
    }
    report('orchestrator mirror byte-identical', mirrorFailures.length === 0, mirrorFailures.join('; '));

    // 3. Placeholder scan on Ncode-authored sources only.
    const authored = jsFiles.filter((file) => {
        const relative = path.relative(rootDir, file).split(path.sep).join('/');
        // The gate itself documents the forbidden patterns; scanning it would
        // always self-match.
        if (relative === 'scripts/check-all.mjs') return false;
        return AUTHORED_FILE_PATTERNS.some((pattern) => pattern.test(relative));
    });
    const placeholderHits = [];
    for (const file of authored) {
        const source = await readFile(file, 'utf8');
        for (const { label, pattern } of PLACEHOLDER_PATTERNS) {
            if (pattern.test(source)) {
                placeholderHits.push(`${path.relative(rootDir, file)} (${label})`);
            }
        }
    }
    report('no lazy placeholders in authored sources', placeholderHits.length === 0, placeholderHits.slice(0, 5).join('; '));

    // 4. Orchestrator contract smoke test.
    const orchestratorSmoke = runNodeScript('orchestrator/smoke_test.mjs');
    report('orchestrator smoke test', orchestratorSmoke.ok, orchestratorSmoke.ok ? '' : orchestratorSmoke.tail);

    // 5. PC daemon smoke test.
    const daemonSmoke = runNodeScript('pc-daemon/smoke_test.mjs', 420000);
    report('pc-daemon smoke test', daemonSmoke.ok, daemonSmoke.ok ? '' : daemonSmoke.tail);

    // 6. Packaged extension verification.
    const extensionVerify = runNodeScript('scripts/verify-extension-dist.mjs', 180000);
    report('packaged extension verified', extensionVerify.ok, extensionVerify.ok ? '' : extensionVerify.tail);

    // 7. Unified scripts exist.
    const rootPackage = JSON.parse(await readFile(path.join(rootDir, 'package.json'), 'utf8'));
    const missingScripts = REQUIRED_ROOT_SCRIPTS.filter((script) => !rootPackage.scripts?.[script]);
    report('root package unified scripts', missingScripts.length === 0, missingScripts.join(', '));

    console.log(
        `\n${failures === 0 ? 'All' : failures} ${checks} acceptance checks ${failures === 0 ? 'passed' : 'completed with failures'}.`
    );
    process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((error) => {
    console.error('[ncode] check-all failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
});
