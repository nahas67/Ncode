/**
 * Ncode bridge client: service worker side of the local PC daemon's WebSocket
 * bridge (ws://127.0.0.1:8085).
 *
 * WHY THIS FILE EXISTS:
 * - The pc-daemon exposes an MCP server (HTTP 3001) *plus* a WebSocket bridge so
 *   local tools/agents can ask the extension to run a prompt through the user's
 *   logged-in gemini.google.com session ("ask the browser").
 * - MV3 service workers are event-driven and can be suspended at any time; the
 *   socket therefore reconnects with exponential backoff (1s..30s) for as long
 *   as this worker instance is alive. A suspended worker simply loses the
 *   socket and re-establishes it the next time the module is evaluated
 *   (background/index.js calls connect() on startup).
 *
 * PROTOCOL (fixed contract with pc-daemon/server.mjs):
 *   -> {"type":"register","role":"extension","client":"ncode-extension","version":"1.0.0"}
 *   <- {"type":"registered", ...}            (acknowledgement, optional fields)
 *   <- {"type":"ping"}                       -> {"type":"pong","ts":<ms>}
 *   <- {"type":"ask_gemini_web","id":"...","prompt":"...","timeoutMs":1234}
 *      -> {"type":"ask_gemini_web_result","id":"...","ok":true,"text":"..."}
 *      -> {"type":"ask_gemini_web_result","id":"...","ok":false,"error":"..."}
 *
 * This class contains no chrome.* API calls. The WebSocket constructor and the
 * askWeb handler are injected so the module stays unit-testable and unbound
 * from extension-specific globals.
 */

export const NCODE_BRIDGE_URL = 'ws://127.0.0.1:8085';
export const NCODE_BRIDGE_CLIENT_NAME = 'ncode-extension';
const NCODE_BRIDGE_REGISTER_VERSION = '1.0.0';

const DEFAULT_MIN_RECONNECT_MS = 1000;
const DEFAULT_MAX_RECONNECT_MS = 30000;
const WS_CONNECTING = 0;
const WS_OPEN = 1;

const REGISTER_MESSAGE = Object.freeze({
    type: 'register',
    role: 'extension',
    client: NCODE_BRIDGE_CLIENT_NAME,
    version: NCODE_BRIDGE_REGISTER_VERSION,
});

const PONG_MESSAGE = 'pong';
const PING_MESSAGE = 'ping';

function toErrorMessage(error) {
    return error && error.message ? error.message : String(error);
}

export class NcodeBridgeClient {
    /**
     * @param {{
     *   url?: string,
     *   askWeb?: ((prompt: string) => Promise<string>|string)|null,
     *   wsFactory?: (() => any)|null,
     *   minReconnectMs?: number,
     *   maxReconnectMs?: number,
     *   now?: () => number,
     * }} [options]
     */
    constructor({
        url = NCODE_BRIDGE_URL,
        askWeb = null,
        wsFactory = null,
        minReconnectMs = DEFAULT_MIN_RECONNECT_MS,
        maxReconnectMs = DEFAULT_MAX_RECONNECT_MS,
        now = () => Date.now(),
    } = {}) {
        this.url = url;
        this.askWeb = typeof askWeb === 'function' ? askWeb : null;
        this.wsFactory =
            typeof wsFactory === 'function'
                ? wsFactory
                : () => {
                      const WebSocketCtor = globalThis.WebSocket;
                      if (typeof WebSocketCtor !== 'function') {
                          throw new Error('WebSocket is unavailable in this worker.');
                      }
                      return new WebSocketCtor(this.url);
                  };
        this.minReconnectMs = Math.max(1, Number(minReconnectMs) || DEFAULT_MIN_RECONNECT_MS);
        this.maxReconnectMs = Math.max(
            this.minReconnectMs,
            Number(maxReconnectMs) || DEFAULT_MAX_RECONNECT_MS
        );
        this.now = typeof now === 'function' ? now : () => Date.now();

        this.socket = null;
        this.connected = false;
        this.registered = false;
        this.stopped = false;
        this.reconnectAttempt = 0;
        this.reconnectTimer = null;
        this.lastError = null;
        this.lastConnectedAt = 0;
        this.lastMessageAt = 0;
        this.lastPongAt = 0;
    }

    /** Replaces (or clears) the injected askWeb handler. */
    setAskWebHandler(askWeb) {
        this.askWeb = typeof askWeb === 'function' ? askWeb : null;
    }

    /**
     * Opens the socket if it is not already open/connecting. Safe to call
     * repeatedly (e.g. from every service-worker startup).
     */
    connect() {
        this.stopped = false;
        if (
            this.socket &&
            (this.socket.readyState === WS_OPEN || this.socket.readyState === WS_CONNECTING)
        ) {
            return;
        }
        this._clearReconnectTimer();

        let socket;
        try {
            socket = this.wsFactory();
        } catch (error) {
            this.lastError = toErrorMessage(error);
            this._scheduleReconnect();
            return;
        }
        if (!socket) {
            this.lastError = 'WebSocket factory returned no socket.';
            this._scheduleReconnect();
            return;
        }

        this.socket = socket;
        this._attach(socket, 'open', () => this._handleOpen(socket));
        this._attach(socket, 'message', (event) => this._handleMessage(event));
        this._attach(socket, 'close', () => this._handleClose(socket));
        this._attach(socket, 'error', (event) => this._handleError(event));
    }

    /** Stops reconnecting and closes the socket. */
    disconnect() {
        this.stopped = true;
        this._clearReconnectTimer();
        const socket = this.socket;
        this.socket = null;
        this.connected = false;
        this.registered = false;
        if (socket) {
            try {
                socket.close();
            } catch (error) {
                this._warn('close failed', error);
            }
        }
    }

    /** Snapshot for harness status / diagnostics. Never throws. */
    getStatus() {
        return {
            connected: this.connected === true,
            registered: this.registered === true,
            url: this.url,
            reconnectAttempts: this.reconnectAttempt,
            lastError: this.lastError,
            lastConnectedAt: this.lastConnectedAt || null,
            lastMessageAt: this.lastMessageAt || null,
            lastPongAt: this.lastPongAt || null,
        };
    }

    _attach(socket, eventName, handler) {
        try {
            if (socket && typeof socket.addEventListener === 'function') {
                socket.addEventListener(eventName, handler);
                return;
            }
            if (socket && `on${eventName}` in socket) {
                socket[`on${eventName}`] = handler;
            }
        } catch (error) {
            // Injected/fake sockets may not support listeners; log and move on.
            this._warn(`failed to attach ${eventName} listener`, error);
        }
    }

    _handleOpen(socket) {
        if (socket !== this.socket) return;
        this.connected = true;
        this.registered = false;
        this.reconnectAttempt = 0;
        this.lastConnectedAt = this.now();
        this.lastError = null;
        this._send({ ...REGISTER_MESSAGE });
    }

    _handleMessage(event) {
        this.lastMessageAt = this.now();
        let message;
        try {
            const raw = event && typeof event === 'object' && 'data' in event ? event.data : event;
            message = typeof raw === 'string' ? JSON.parse(raw) : raw;
        } catch (error) {
            this._warn('ignoring malformed frame', error);
            return;
        }
        if (!message || typeof message !== 'object') return;

        if (message.type === 'registered') {
            this.registered = true;
            return;
        }

        if (message.type === PING_MESSAGE) {
            this.lastPongAt = this.now();
            this._send({ type: PONG_MESSAGE, ts: this.lastPongAt });
            return;
        }

        if (message.type === 'ask_gemini_web') {
            // Fire-and-forget: the result is delivered as its own frame.
            this._handleAsk(message).catch((error) =>
                this._warn('ask_gemini_web handler failed', error)
            );
        }
    }

    async _handleAsk(message) {
        const id = message.id ?? message.requestId ?? null;
        if (id === null || id === undefined) {
            this._warn('ask_gemini_web without an id; dropping request');
            return;
        }

        const prompt = typeof message.prompt === 'string' ? message.prompt : '';
        if (!prompt.trim()) {
            this._send({
                type: 'ask_gemini_web_result',
                id,
                ok: false,
                error: 'ask_gemini_web requires a non-empty prompt.',
            });
            return;
        }

        if (!this.askWeb) {
            this._send({
                type: 'ask_gemini_web_result',
                id,
                ok: false,
                error: 'askWeb handler is not wired in the extension.',
            });
            return;
        }

        try {
            const timeoutMs = Number(message.timeoutMs);
            let text;
            if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
                text = await this._withTimeout(this.askWeb(prompt), timeoutMs);
            } else {
                text = await this.askWeb(prompt);
            }
            this._send({
                type: 'ask_gemini_web_result',
                id,
                ok: true,
                text: typeof text === 'string' ? text : String(text ?? ''),
            });
        } catch (error) {
            this._send({
                type: 'ask_gemini_web_result',
                id,
                ok: false,
                error: toErrorMessage(error),
            });
        }
    }

    _withTimeout(promise, timeoutMs) {
        return new Promise((resolve, reject) => {
            let settled = false;
            const timer = setTimeout(() => {
                if (settled) return;
                settled = true;
                reject(new Error(`Timed out after ${timeoutMs}ms waiting for Gemini Web.`));
            }, timeoutMs);
            Promise.resolve(promise).then(
                (value) => {
                    if (settled) return;
                    settled = true;
                    clearTimeout(timer);
                    resolve(value);
                },
                (error) => {
                    if (settled) return;
                    settled = true;
                    clearTimeout(timer);
                    reject(error);
                }
            );
        });
    }

    _handleClose(socket) {
        if (this.socket && socket !== this.socket) return;
        this.socket = null;
        this.connected = false;
        this.registered = false;
        if (this.stopped) return;
        this._scheduleReconnect();
    }

    _handleError(event) {
        this.lastError =
            event && typeof event === 'object' && 'message' in event && event.message
                ? String(event.message)
                : 'WebSocket bridge error';
        // Browser sockets fire 'close' after 'error'; reconnection is scheduled
        // from _handleClose so a single failure never arms two timers.
        this._warn(this.lastError);
    }

    _scheduleReconnect() {
        if (this.stopped || this.reconnectTimer) return;
        const attempt = this.reconnectAttempt;
        const delay = Math.min(this.maxReconnectMs, this.minReconnectMs * 2 ** attempt);
        this.reconnectAttempt = attempt + 1;
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            if (this.stopped) return;
            this.connect();
        }, delay);
    }

    _clearReconnectTimer() {
        if (!this.reconnectTimer) return;
        try {
            clearTimeout(this.reconnectTimer);
        } catch {
            // Ignore timer cleanup failures.
        }
        this.reconnectTimer = null;
    }

    _send(payload) {
        const socket = this.socket;
        if (!socket || socket.readyState !== WS_OPEN) return false;
        try {
            socket.send(JSON.stringify(payload));
            return true;
        } catch (error) {
            this._warn('send failed', error);
            return false;
        }
    }

    // console.warn only: the extension LogManager intercepts console output and
    // persists it, so keep the noise bounded.
    _warn(message, error) {
        try {
            if (error) {
                console.warn(`[NcodeBridge] ${message}:`, toErrorMessage(error));
            } else {
                console.warn(`[NcodeBridge] ${message}`);
            }
        } catch {
            // Never let logging break the socket loop.
        }
    }
}
