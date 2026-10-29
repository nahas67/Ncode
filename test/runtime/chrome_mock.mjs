// @ts-check
/**
 * Realistic Chrome extension API mock used by the Ncode compiled-runtime tests.
 *
 * This is NOT a business-logic mock: it only emulates the browser surface a real
 * MV3 extension runs against (events, dual callback/Promise storage areas,
 * runtime messaging, tabs, alarms, native messaging ports, …). The modules under
 * test are the actual compiled artifacts from `extension/dist`.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

function createEvent(name) {
    const listeners = [];
    return {
        name,
        addListener(listener) {
            if (typeof listener === 'function' && !listeners.includes(listener)) {
                listeners.push(listener);
            }
        },
        removeListener(listener) {
            const index = listeners.indexOf(listener);
            if (index !== -1) listeners.splice(index, 1);
        },
        hasListener(listener) {
            return listeners.includes(listener);
        },
        hasListeners() {
            return listeners.length > 0;
        },
        async emit(...args) {
            const results = [];
            for (const listener of [...listeners]) {
                results.push(await listener(...args));
            }
            return results;
        },
        get listeners() {
            return [...listeners];
        },
    };
}

function normalizeKeys(keys) {
    if (keys === null || keys === undefined) return null;
    if (typeof keys === 'string') return [keys];
    if (Array.isArray(keys)) return keys;
    if (typeof keys === 'object') return Object.keys(keys);
    return [];
}

function createStorageArea(store, onChanged, areaName, state) {
    function read(keys) {
        const result = {};
        const wanted = normalizeKeys(keys);
        if (wanted === null) {
            Object.assign(result, store);
        } else if (typeof keys === 'object' && !Array.isArray(keys)) {
            for (const [key, fallback] of Object.entries(keys)) {
                result[key] = key in store ? store[key] : fallback;
            }
        } else {
            for (const key of wanted) {
                if (key in store) result[key] = store[key];
            }
        }
        return result;
    }

    function write(items) {
        const changes = {};
        for (const [key, value] of Object.entries(items || {})) {
            changes[key] = { oldValue: store[key], newValue: value, areaName };
            store[key] = value;
        }
        if (Object.keys(changes).length > 0) {
            state.storageWrites.push(changes);
            void onChanged.emit(changes, areaName);
        }
    }

    function makeDual(operation) {
        return function dual(first, second) {
            if (typeof second === 'function') {
                try {
                    second(operation(first));
                } catch (error) {
                    state.lastError = error;
                    throw error;
                }
                return undefined;
            }
            return Promise.resolve(operation(first));
        };
    }

    return {
        get: makeDual(read),
        getBytesInUse: makeDual((keys) => {
            const wanted = normalizeKeys(keys) || Object.keys(store);
            return wanted.reduce((sum, key) => sum + String(store[key] ?? '').length, 0);
        }),
        set: makeDual((items) => {
            write(items);
        }),
        remove: makeDual((keys) => {
            const wanted = normalizeKeys(keys);
            const changes = {};
            for (const key of wanted || []) {
                if (!(key in store)) continue;
                changes[key] = { oldValue: store[key], newValue: undefined, areaName };
                delete store[key];
            }
            if (Object.keys(changes).length > 0) {
                state.storageWrites.push(changes);
                void onChanged.emit(changes, areaName);
            }
        }),
        clear: makeDual(() => {
            for (const key of Object.keys(store)) delete store[key];
        }),
        QUOTA_BYTES: 10 * 1024 * 1024,
    };
}

function createNativePort() {
    return {
        name: 'com.gemini_nexus.logger',
        onMessage: createEvent('port.onMessage'),
        onDisconnect: createEvent('port.onDisconnect'),
        postMessage() {},
        disconnect() {},
    };
}

export function loadManifest(extensionDir) {
    return JSON.parse(readFileSync(path.join(extensionDir, 'manifest.json'), 'utf8'));
}

/**
 * @param {{ extensionDir: string, manifest?: any, tabUrl?: string }} options
 */
export function createChromeMock({ extensionDir, manifest = loadManifest(extensionDir), tabUrl }) {
    const storageData = {};
    const sessionData = {};
    const storageChanged = createEvent('storage.onChanged');
    const state = {
        storageWrites: [],
        runtimeMessages: [],
        nativePorts: [],
        alarms: new Map(),
        lastError: null,
        storageData,
        sessionData,
        manifest,
        unknownApiCalls: [],
    };
    const chrome = {
        runtime: {
            id: 'ncodee2etestextensionidabcdefgh',
            lastError: undefined,
            getManifest: () => manifest,
            getURL: (relativePath) => `chrome-extension://ncodee2etest/${String(relativePath).replace(/^\//, '')}`,
            sendMessage: async (message) => {
                state.runtimeMessages.push(message);
                return undefined;
            },
            connectNative: (hostName) => {
                const port = createNativePort();
                port.name = hostName;
                state.nativePorts.push(port);
                return port;
            },
            onMessage: createEvent('runtime.onMessage'),
            onInstalled: createEvent('runtime.onInstalled'),
            onStartup: createEvent('runtime.onStartup'),
            onSuspend: createEvent('runtime.onSuspend'),
            onConnect: createEvent('runtime.onConnect'),
            onMessageExternal: createEvent('runtime.onMessageExternal'),
            onUpdateAvailable: createEvent('runtime.onUpdateAvailable'),
            setUninstallURL() {},
        },
        storage: {
            local: createStorageArea(storageData, storageChanged, 'local', state),
            session: createStorageArea(sessionData, storageChanged, 'session', state),
            sync: createStorageArea({}, storageChanged, 'sync', state),
            onChanged: storageChanged,
        },
        tabs: {
            query: async (queryInfo) => {
                if (queryInfo && queryInfo.url) {
                    return [{ id: 42, url: tabUrl || 'https://gemini.google.com/app', title: 'Gemini', active: true }];
                }
                return [{ id: 42, url: tabUrl || 'https://gemini.google.com/app', title: 'Gemini', active: true }];
            },
            get: async (tabId) => ({
                id: tabId,
                url: tabUrl || 'https://gemini.google.com/app',
                title: 'Gemini',
                windowId: 1,
                active: true,
            }),
            create: async (options) => ({ id: 43, url: options?.url || 'about:blank', windowId: 1 }),
            remove: async () => {},
            sendMessage: async () => undefined,
            update: async (tabId) => ({ id: tabId }),
            reload: async () => {},
            goBack: async () => {},
            goForward: async () => {},
            captureVisibleTab: async () => 'data:image/png;base64,',
            group: async () => 1,
            ungroup: async () => {},
            onRemoved: createEvent('tabs.onRemoved'),
            onUpdated: createEvent('tabs.onUpdated'),
            onActivated: createEvent('tabs.onActivated'),
            onCreated: createEvent('tabs.onCreated'),
        },
        alarms: {
            create: (name, info) => {
                state.alarms.set(name, info);
            },
            get: (name, callback) => {
                const alarm = state.alarms.has(name) ? { name, ...state.alarms.get(name) } : null;
                if (typeof callback === 'function') {
                    callback(alarm);
                    return undefined;
                }
                return Promise.resolve(alarm);
            },
            clear: async (name) => state.alarms.delete(name),
            clearAll: async () => {
                state.alarms.clear();
            },
            onAlarm: createEvent('alarms.onAlarm'),
        },
        action: {
            onClicked: createEvent('action.onClicked'),
            setBadgeText: async () => {},
            setTitle: async () => {},
            setIcon: async () => {},
        },
        commands: { onCommand: createEvent('commands.onCommand') },
        contextMenus: {
            create() {
                return 1;
            },
            removeAll(callback) {
                if (typeof callback === 'function') callback();
            },
            onClicked: createEvent('contextMenus.onClicked'),
        },
        scripting: {
            executeScript: async () => [{ result: null }],
            insertCSS: async () => {},
        },
        debugger: {
            attach: async () => {},
            detach: async () => {},
            sendCommand: async () => ({}),
            onAttach: createEvent('debugger.onAttach'),
            onDetach: createEvent('debugger.onDetach'),
            onEvent: createEvent('debugger.onEvent'),
        },
        downloads: {
            search: async () => [],
            onChanged: createEvent('downloads.onChanged'),
            onCreated: createEvent('downloads.onCreated'),
        },
        i18n: {
            getUILanguage: () => 'en-US',
            getMessage: (key) => key,
        },
        sidePanel: {
            setPanelBehavior: async () => {},
            setOptions: async () => {},
            open: async () => {},
        },
        windows: {
            create: async () => ({ id: 1 }),
            getCurrent: async () => ({ id: 1 }),
        },
        tabGroups: {
            update: async () => {},
            get: async () => ({ id: 1 }),
        },
        permissions: {
            contains: async () => true,
            request: async () => true,
        },
        bookmarks: {
            search: async () => [],
        },
        history: { search: async () => [] },
    };

    /**
     * Deliver an incoming external message (sidepanel/content script → background)
     * through the real `chrome.runtime.onMessage` listener, honouring the
     * listener's `return true` async contract.
     */
    async function sendToBackground(message, sender = { id: 'ncodee2etest', url: 'chrome-extension://ncodee2etest/sidepanel/index.html' }) {
        return new Promise((resolve) => {
            let settled = false;
            const sendResponse = (response) => {
                if (settled) return;
                settled = true;
                resolve(response);
            };
            const listeners = chrome.runtime.onMessage.listeners;
            let asyncAllowed = false;
            for (const listener of listeners) {
                const keepOpen = listener(message, sender, sendResponse);
                if (keepOpen === true) asyncAllowed = true;
            }
            if (settled) return;
            // If a listener claimed async, wait for sendResponse; otherwise resolve immediately.
            if (!asyncAllowed) resolve(undefined);
        });
    }

    /** Emit a background→UI broadcast (chrome.runtime.sendMessage from the SW). */
    function broadcast(message) {
        state.runtimeMessages.push(message);
        return Promise.resolve(undefined);
    }

    return { chrome, state, sendToBackground, broadcast, events: { storageChanged } };
}

/** Wait until predicate() is truthy or the timeout elapses. */
export async function waitFor(predicate, { timeoutMs = 8000, intervalMs = 25, label = 'condition' } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const value = predicate();
        if (value) return value;
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    throw new Error(`Timed out waiting for ${label}`);
}

export function createDeferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
    });
    promise.catch(() => {});
    return { promise, resolve, reject };
}
