// @ts-check
/**
 * Ncode development runner.
 *
 * Starts the two halves of the harness together:
 *   - the Vite dev server / watcher for the Chrome extension (extension/)
 *   - the zero-dependency PC & shell MCP daemon (pc-daemon/server.mjs)
 *
 * Both children inherit stdio so their output stays visible. Ctrl+C tears both
 * down; if either child exits unexpectedly the other is stopped so the shell is
 * never left with a half-running harness.
 *
 * Usage (from ./Ncode):
 *   npm run dev
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const isWindows = process.platform === 'win32';

/** @type {import('node:child_process').ChildProcess[]} */
const children = [];
let shuttingDown = false;

function startDaemon() {
    const child = spawn(process.execPath, [path.join(rootDir, 'pc-daemon', 'server.mjs')], {
        cwd: rootDir,
        stdio: 'inherit',
        env: process.env,
    });
    child.on('exit', (code, signal) => {
        if (shuttingDown) return;
        console.error(`[ncode:dev] pc-daemon exited (${signal || code}); stopping dev session.`);
        shutdown(typeof code === 'number' ? code : 1);
    });
    child.on('error', (error) => {
        console.error('[ncode:dev] failed to start pc-daemon:', error.message);
        shutdown(1);
    });
    return child;
}

function startExtensionWatcher() {
    const child = spawn(isWindows ? 'npm.cmd' : 'npm', ['--prefix', 'extension', 'run', 'dev'], {
        cwd: rootDir,
        stdio: 'inherit',
        shell: isWindows,
        env: process.env,
    });
    child.on('exit', (code, signal) => {
        if (shuttingDown) return;
        console.error(`[ncode:dev] vite watcher exited (${signal || code}); stopping dev session.`);
        shutdown(typeof code === 'number' ? code : 1);
    });
    child.on('error', (error) => {
        console.error('[ncode:dev] failed to start extension watcher:', error.message);
        shutdown(1);
    });
    return child;
}

/** @param {number} code */
function shutdown(code) {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const child of children) {
        if (!child.killed && child.exitCode === null) {
            try {
                child.kill('SIGTERM');
            } catch {
                // Best effort: the process may already be gone.
            }
        }
    }
    setTimeout(() => process.exit(code), 250).unref();
}

children.push(startDaemon(), startExtensionWatcher());

for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => shutdown(0));
}

process.on('exit', () => {
    for (const child of children) {
        if (!child.killed && child.exitCode === null) {
            try {
                child.kill();
            } catch {
                // Ignore teardown races.
            }
        }
    }
});

console.log('[ncode:dev] daemon + extension watcher starting. Side panel: chrome://extensions -> Load unpacked -> extension/dist (or use the vite dev shell).');
