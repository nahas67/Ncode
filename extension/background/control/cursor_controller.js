// Owns the agent cursor lifecycle on the background side: injects the overlay
// script into the controlled tab on demand, drives it toward each target
// coordinate, awaits animation arrival, and cleans up on detach/navigation.
// Visual feedback is best-effort — every method fails open so a missing or
// unresponsive overlay never blocks the real CDP action.

const CURSOR_SCRIPT_FILES = ['content/cursor/cursor_content.js'];
const ARRIVAL_TIMEOUT_MS = 1500;
const PING_TIMEOUT_MS = 200;

class CursorController {
    constructor() {
        this.moveSequence = 0;
        this.injectedTabs = new Set();
        this.arrivalWaiters = new Map();

        if (typeof chrome !== 'undefined') {
            chrome.runtime.onMessage.addListener((message) => {
                if (
                    message?.action === 'CURSOR_ARRIVED' &&
                    Number.isInteger(message.moveSequence)
                ) {
                    const resolveArrival = this.arrivalWaiters.get(message.moveSequence);
                    if (resolveArrival) {
                        this.arrivalWaiters.delete(message.moveSequence);
                        resolveArrival();
                    }
                }
                return false;
            });

            chrome.debugger.onDetach.addListener((source) => {
                const tabId = source?.tabId;
                if (!Number.isInteger(tabId)) return;
                this.injectedTabs.delete(tabId);
                this.hideCursor(tabId);
            });

            chrome.tabs.onRemoved.addListener((tabId) => {
                this.injectedTabs.delete(tabId);
                this.hideCursor(tabId);
            });

            chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
                // Navigation reloads the page and discards the injected overlay.
                if (changeInfo.url || changeInfo.status === 'loading') {
                    this.injectedTabs.delete(tabId);
                    this.hideCursor(tabId);
                }
            });
        }
    }

    async ensureInjected(tabId) {
        if (this.injectedTabs.has(tabId)) {
            try {
                await this.sendTabMessage(tabId, { action: 'CURSOR_PING' }, PING_TIMEOUT_MS);
                return true;
            } catch {
                this.injectedTabs.delete(tabId);
            }
        }

        try {
            await chrome.scripting.executeScript({
                target: { tabId },
                files: CURSOR_SCRIPT_FILES,
            });
            this.injectedTabs.add(tabId);
            return true;
        } catch {
            return false;
        }
    }

    async moveCursorTo(tabId, x, y) {
        if (!Number.isInteger(tabId)) return;

        const injected = await this.ensureInjected(tabId);
        if (!injected) return;

        const sequence = ++this.moveSequence;
        const arrival = this.waitForArrival(sequence);

        try {
            await this.sendTabMessage(tabId, {
                action: 'CURSOR_MOVE',
                x,
                y,
                moveSequence: sequence,
                animate: true,
            });
        } catch {
            this.arrivalWaiters.delete(sequence);
            return;
        }

        await arrival;
    }

    async hideCursor(tabId) {
        if (!Number.isInteger(tabId)) return;
        try {
            await this.sendTabMessage(tabId, { action: 'CURSOR_HIDE' });
        } catch {
            // Tab may already be gone; nothing to hide.
        }
    }

    async showThinking(tabId) {
        if (!Number.isInteger(tabId)) return;
        const injected = await this.ensureInjected(tabId);
        if (!injected) return;
        this.thinkTurnId = (this.thinkTurnId ?? 0) + 1;
        try {
            await this.sendTabMessage(tabId, { action: 'CURSOR_THINK', turnId: this.thinkTurnId });
        } catch {
            // Best-effort: a subsequent CURSOR_MOVE will still drive the overlay.
        }
    }

    sendTabMessage(tabId, message, timeoutMs) {
        if (timeoutMs == null) {
            return chrome.tabs.sendMessage(tabId, message);
        }

        return new Promise((resolve, reject) => {
            let settled = false;
            const timer = setTimeout(() => {
                if (settled) return;
                settled = true;
                reject(new Error('cursor message timeout'));
            }, timeoutMs);

            chrome.tabs.sendMessage(tabId, message, (response) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                if (chrome.runtime.lastError) {
                    reject(new Error(chrome.runtime.lastError.message));
                } else {
                    resolve(response);
                }
            });
        });
    }

    waitForArrival(moveSequence) {
        return new Promise((resolve) => {
            this.arrivalWaiters.set(moveSequence, resolve);
            setTimeout(() => {
                if (this.arrivalWaiters.has(moveSequence)) {
                    this.arrivalWaiters.delete(moveSequence);
                    resolve();
                }
            }, ARRIVAL_TIMEOUT_MS);
        });
    }
}

export const cursorController = new CursorController();
