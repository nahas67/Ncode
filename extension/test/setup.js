import { beforeEach } from 'vitest';

function createMemoryStorage() {
    const store = new Map();

    return {
        get length() {
            return store.size;
        },
        clear() {
            store.clear();
        },
        getItem(key) {
            const normalizedKey = String(key);
            return store.has(normalizedKey) ? store.get(normalizedKey) : null;
        },
        key(index) {
            return Array.from(store.keys())[index] ?? null;
        },
        removeItem(key) {
            store.delete(String(key));
        },
        setItem(key, value) {
            store.set(String(key), String(value));
        },
    };
}

const localStorageStub = createMemoryStorage();

Object.defineProperty(globalThis, 'localStorage', {
    value: localStorageStub,
    configurable: true,
});

if (typeof window !== 'undefined') {
    Object.defineProperty(window, 'localStorage', {
        value: localStorageStub,
        configurable: true,
    });
}

beforeEach(() => {
    localStorageStub.clear();
});
