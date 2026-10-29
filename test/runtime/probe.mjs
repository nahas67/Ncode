// @ts-check
/**
 * Exploratory compiled-runtime probe: boots `extension/dist/background/index.js`
 * under the realistic chrome mock and reports what breaks. Not part of the final
 * suite — kept as a lightweight diagnostic during the audit.
 */
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createChromeMock } from './chrome_mock.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..', '..');
const extensionDir = path.join(rootDir, 'extension');
const distDir = path.join(extensionDir, 'dist');

const { chrome, state } = createChromeMock({ extensionDir: distDir });
globalThis.chrome = chrome;
if (typeof globalThis.self === 'undefined') globalThis.self = globalThis;

process.on('uncaughtException', (error) => {
    console.error('[probe] UNCAUGHT EXCEPTION:', error.stack || error);
    process.exitCode = 2;
});
process.on('unhandledRejection', (error) => {
    console.error('[probe] UNHANDLED REJECTION:', error?.stack || error);
});

const entry = path.join(distDir, 'background', 'index.js');
console.log('[probe] importing compiled service worker entry:', path.relative(rootDir, entry));
try {
    await import(`${pathToFileURL(entry).href}?probe=${Date.now()}`);
    console.log('[probe] background module graph imported successfully');
} catch (error) {
    console.error('[probe] IMPORT FAILED:', error?.stack || error);
    process.exit(1);
}

await new Promise((resolve) => setTimeout(resolve, 750));
console.log('[probe] storage writes after boot:', state.storageWrites.length);
console.log('[probe] runtime.onMessage listeners:', chrome.runtime.onMessage.listeners.length);
console.log('[probe] tabs.onRemoved listeners:', chrome.tabs.onRemoved.listeners.length);
console.log('[probe] native ports opened:', state.nativePorts.length);
console.log('[probe] alarms:', [...state.alarms.keys()]);

const response = await Promise.race([
    chrome.runtime.onMessage.listeners.length > 0
        ? (async () => {
              return new Promise((resolve) => {
                  let settled = false;
                  const sendResponse = (value) => {
                      if (settled) return;
                      settled = true;
                      resolve(value);
                  };
                  for (const listener of chrome.runtime.onMessage.listeners) {
                      listener({ action: 'NCODE_GET_STATE' }, {}, sendResponse);
                  }
                  setTimeout(() => {
                      if (!settled) {
                          settled = true;
                          resolve('NO_RESPONSE');
                      }
                  }, 8000);
              });
          })()
        : Promise.resolve('NO_LISTENER'),
    new Promise((resolve) => setTimeout(() => resolve('TIMEOUT'), 12000)),
]);
console.log('[probe] NCODE_GET_STATE response:', JSON.stringify(response).slice(0, 800));
await new Promise((resolve) => setTimeout(resolve, 500));
console.log('[probe] broadcasts:', JSON.stringify(state.runtimeMessages.map((m) => m.action)).slice(0, 1200));
console.log('[probe] sample broadcast payloads:', JSON.stringify(state.runtimeMessages.slice(-4)).slice(0, 2000));
process.exit(0);
