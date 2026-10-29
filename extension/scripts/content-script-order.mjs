import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

function isYouTubeEntry(entry) {
    return Array.isArray(entry.js) && entry.js.includes('content/youtube_summary.js');
}

function readManifestContentScriptEntries() {
    const manifest = JSON.parse(readFileSync(path.join(rootDir, 'manifest.json'), 'utf8'));
    return manifest.content_scripts.filter(
        (entry) =>
            entry.world !== 'MAIN' &&
            entry.all_frames !== true &&
            !entry.js?.includes('content/gemini_watermark_bridge.js')
    );
}

const bundleEntries = readManifestContentScriptEntries();

// Main bundle, loaded on every page. Excludes the YouTube summary subsystem,
// which ships as its own on-demand bundle (see YOUTUBE_SCRIPT_ORDER).
export const CONTENT_SCRIPT_ORDER = bundleEntries
    .filter((entry) => !isYouTubeEntry(entry))
    .flatMap((entry) => entry.js ?? []);

// YouTube summary subsystem, injected only on youtube.com via a dedicated
// content_scripts entry so other pages do not pay for it.
export const YOUTUBE_SCRIPT_ORDER = bundleEntries
    .filter((entry) => isYouTubeEntry(entry))
    .flatMap((entry) => entry.js ?? []);
