// @ts-check
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const defaultZipPath = path.join(
    rootDir,
    'artifacts',
    `gemini-nexus-v${process.env.npm_package_version ?? 'local'}.zip`
);

/**
 * @param {string} value
 */
export function maskSecret(value) {
    if (!value) return '';
    if (value.length <= 8) return '***';
    return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

/**
 * @param {{ publisherId: string, itemId: string }} config
 */
export function buildChromeWebStoreUrls({ publisherId, itemId }) {
    const name = `publishers/${encodeURIComponent(publisherId)}/items/${encodeURIComponent(itemId)}`;
    return {
        upload: `https://chromewebstore.googleapis.com/upload/v2/${name}:upload`,
        publish: `https://chromewebstore.googleapis.com/v2/${name}:publish`,
    };
}

/**
 * @param {Record<string, string | undefined>} env
 */
export function getChromeWebStoreConfig(env = process.env) {
    const config = {
        publisherId: env.CHROME_WEBSTORE_PUBLISHER_ID?.trim() ?? '',
        itemId: env.CHROME_WEBSTORE_ITEM_ID?.trim() ?? '',
        accessToken: env.CHROME_WEBSTORE_ACCESS_TOKEN?.trim() ?? '',
        zipPath: env.CHROME_WEBSTORE_ZIP_PATH?.trim() || defaultZipPath,
    };
    const missing = [];
    if (!config.publisherId) missing.push('CHROME_WEBSTORE_PUBLISHER_ID');
    if (!config.itemId) missing.push('CHROME_WEBSTORE_ITEM_ID');
    if (!config.accessToken) missing.push('CHROME_WEBSTORE_ACCESS_TOKEN');

    if (missing.length > 0) {
        throw new Error(`Missing Chrome Web Store configuration: ${missing.join(', ')}`);
    }

    return config;
}

/**
 * @param {string} filePath
 */
async function loadEnvFile(filePath) {
    let source;
    try {
        source = await readFile(filePath, 'utf8');
    } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
            return;
        }
        throw error;
    }

    for (const line of source.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
        if (!match) continue;
        const [, key, rawValue] = match;
        if (process.env[key] !== undefined) continue;
        process.env[key] = rawValue.replace(/^['"]|['"]$/g, '');
    }
}

async function uploadAndPublish() {
    await loadEnvFile(path.join(rootDir, '.env.chrome-webstore'));

    const config = getChromeWebStoreConfig();
    const urls = buildChromeWebStoreUrls(config);
    const zip = await readFile(config.zipPath);

    console.log(
        `Uploading ${path.relative(rootDir, config.zipPath)} to Chrome Web Store item ${config.itemId}`
    );
    const uploadResponse = await fetch(urls.upload, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${config.accessToken}`,
            'Content-Type': 'application/zip',
        },
        body: zip,
    });

    if (!uploadResponse.ok) {
        throw new Error(
            `Chrome Web Store upload failed (${uploadResponse.status}): ${await uploadResponse.text()}`
        );
    }

    console.log('Upload accepted. Submitting item for publishing.');
    const publishResponse = await fetch(urls.publish, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${config.accessToken}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
    });

    if (!publishResponse.ok) {
        throw new Error(
            `Chrome Web Store publish failed (${publishResponse.status}): ${await publishResponse.text()}`
        );
    }

    console.log('Chrome Web Store publish request submitted.');
    console.log(await publishResponse.text());
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    uploadAndPublish().catch((error) => {
        console.error(error instanceof Error ? error.message : error);
        process.exit(1);
    });
}
