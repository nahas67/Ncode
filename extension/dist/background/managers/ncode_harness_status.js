/**
 * Ncode harness status: probes the two tool surfaces the agent relies on and
 * broadcasts a truthful snapshot for the sidepanel harness bar.
 *
 *   NCODE_HARNESS_STATUS {
 *     geminiWebConnected, geminiWebProvider: 'web',
 *     pcShellConnected, pcShellEndpoint, pcShellToolCount, pcShellError,
 *     bridgeConnected, bridgeEndpoint, updatedAt
 *   }
 *
 * Both probes are best-effort: a dead local daemon or a closed Gemini tab must
 * degrade the badge, never throw into the service worker or the prompt loop.
 *
 * Gemini Web liveness (there is no direct health endpoint for the reverse
 * engineered web session):
 *   - the persisted connection provider must be `web` (logged-in
 *     gemini.google.com path), and
 *   - at least one gemini.google.com tab exists OR a real web request
 *     succeeded recently (`noteWebRequestSuccess()` is called by PromptHandler
 *     after a successful Web send).
 *
 * PC shell liveness:
 *   - `McpRemoteManager.listToolsForServer()` against the canonical local MCP
 *     server (Streamable HTTP on 127.0.0.1:3001), raced against a short timeout
 *     so a hung daemon socket cannot stall the probe loop.
 */
import {
    NCODE_LOCAL_MCP_SERVER_ID,
    NCODE_LOCAL_MCP_URL,
} from '../../shared/settings/connection.js';
import { NCODE_ACTIONS, broadcastNcodeAction } from '../../shared/messaging/ncode_actions.js';
import { NCODE_BRIDGE_URL } from './ncode_bridge_client.js';

export const NCODE_HARNESS_STATUS_ACTION = NCODE_ACTIONS.HARNESS_STATUS_UPDATE;
export const NCODE_GOAL_STATE_ACTION = NCODE_ACTIONS.GOAL_STATE_UPDATE;
export const NCODE_HARNESS_PROBE_INTERVAL_MS = 20000;
export const NCODE_HARNESS_PROBE_TIMEOUT_MS = 4000;
/**
 * Minimum age of the cached probe before a UI status request re-probes the
 * daemons. The sandbox polls every 3s; without this TTL every tick would open a
 * fresh MCP connection and race the regular probe loop.
 */
export const NCODE_HARNESS_STATUS_CACHE_MS = 2500;
const GEMINI_WEB_URL_PATTERN = 'https://gemini.google.com/*';
const WEB_SUCCESS_TTL_MS = 5 * 60 * 1000;

function toErrorMessage(error) {
    return error && error.message ? error.message : String(error);
}

export class NcodeHarnessStatus {
    /**
     * @param {{
     *   mcpManager?: object|null,
     *   bridgeClient?: object|null,
     *   goalManager?: object|null,
     *   intervalMs?: number,
     *   probeTimeoutMs?: number,
     *   storageArea?: object|null,
     *   tabsApi?: object|null,
     * }} [options]
     */
    constructor({
        mcpManager = null,
        bridgeClient = null,
        goalManager = null,
        intervalMs = NCODE_HARNESS_PROBE_INTERVAL_MS,
        probeTimeoutMs = NCODE_HARNESS_PROBE_TIMEOUT_MS,
        storageArea = null,
        tabsApi = null,
    } = {}) {
        this.mcpManager = mcpManager;
        this.bridgeClient = bridgeClient;
        this.goalManager = goalManager;
        this.intervalMs = Math.max(1000, Number(intervalMs) || NCODE_HARNESS_PROBE_INTERVAL_MS);
        this.probeTimeoutMs = Math.max(
            250,
            Number(probeTimeoutMs) || NCODE_HARNESS_PROBE_TIMEOUT_MS
        );
        this.storageArea =
            storageArea ||
            (typeof chrome !== 'undefined' && chrome?.storage?.local ? chrome.storage.local : null);
        this.tabsApi =
            tabsApi || (typeof chrome !== 'undefined' && chrome?.tabs ? chrome.tabs : null);

        this.timer = null;
        this.lastWebRequestSuccessAt = 0;
        this.lastStatus = this._createEmptyStatus();
        this.lastProbeAt = 0;
        this.activeProbe = null;
    }

    /** Records a successful Gemini Web send (called by PromptHandler). */
    noteWebRequestSuccess() {
        this.lastWebRequestSuccessAt = Date.now();
    }

    /** Starts the periodic probe loop. Idempotent (duplicate-safe). */
    start({ immediate = true } = {}) {
        if (this.timer) return;
        this.timer = setInterval(() => {
            this.probeAndBroadcast({ force: true }).catch(() => {});
        }, this.intervalMs);
        if (immediate) {
            this.probeAndBroadcast({ force: true }).catch(() => {});
        }
    }

    /** Stops the periodic probe loop. */
    stop() {
        if (!this.timer) return;
        clearInterval(this.timer);
        this.timer = null;
    }

    getLastStatus() {
        return { ...this.lastStatus };
    }

    /**
     * Runs both probes (coalescing concurrent calls) and broadcasts the result.
     * Never throws.
     * @param {{ force?: boolean }} [options] when false, a still-fresh cached
     *   snapshot is re-broadcast instead of re-probing the daemons.
     * @returns {Promise<object>} the broadcast status snapshot
     */
    async probeAndBroadcast({ force = false } = {}) {
        if (this.activeProbe) return this.activeProbe;
        const cacheAge = Date.now() - this.lastProbeAt;
        if (
            !force &&
            this.lastProbeAt > 0 &&
            cacheAge >= 0 &&
            cacheAge < NCODE_HARNESS_STATUS_CACHE_MS
        ) {
            await this.broadcast(this.lastStatus);
            return { ...this.lastStatus };
        }
        this.activeProbe = (async () => {
            let status;
            try {
                status = await this.probe();
            } catch (error) {
                status = { ...this._createEmptyStatus(), probeError: toErrorMessage(error) };
            }
            this.lastStatus = status;
            this.lastProbeAt = Date.now();
            await this.broadcast(status);
            return status;
        })();
        try {
            return await this.activeProbe;
        } finally {
            this.activeProbe = null;
        }
    }

    /** Builds the status snapshot without broadcasting. Never throws. */
    async probe() {
        const [geminiWeb, pcShell] = await Promise.all([
            this.probeGeminiWeb(),
            this.probePcShell(),
        ]);
        const bridgeStatus = this._readBridgeStatus();
        return {
            geminiWebConnected: geminiWeb.connected === true,
            geminiWebProvider: 'web',
            geminiWebDetail: geminiWeb.detail || null,
            pcShellConnected: pcShell.connected === true,
            pcShellEndpoint: NCODE_LOCAL_MCP_URL,
            pcShellToolCount: pcShell.toolCount || 0,
            pcShellError: pcShell.error || null,
            bridgeConnected: bridgeStatus.connected === true,
            bridgeEndpoint: bridgeStatus.url || NCODE_BRIDGE_URL,
            bridgeError: bridgeStatus.lastError || null,
            updatedAt: Date.now(),
        };
    }

    /** @returns {Promise<{connected: boolean, detail: string|null}>} */
    async probeGeminiWeb() {
        let provider = 'web';
        try {
            if (this.storageArea?.get) {
                const stored = await this.storageArea.get([
                    'geminiProvider',
                    'geminiUseOfficialApi',
                ]);
                provider =
                    stored?.geminiProvider ||
                    (stored?.geminiUseOfficialApi === true ? 'official' : 'web');
            }
        } catch (error) {
            // Storage failure: keep the default provider assumption, never throw.
            provider = 'web';
        }

        if (provider !== 'web') {
            return { connected: false, detail: `provider is ${provider}, not web` };
        }

        let hasGeminiTab = false;
        try {
            if (this.tabsApi?.query) {
                const tabs = await this.tabsApi.query({ url: GEMINI_WEB_URL_PATTERN });
                hasGeminiTab = Array.isArray(tabs) && tabs.length > 0;
            }
        } catch {
            // Tabs API unavailable (e.g. unit tests): fall back to the recent flag.
            hasGeminiTab = false;
        }

        const recentSuccess =
            this.lastWebRequestSuccessAt > 0 &&
            Date.now() - this.lastWebRequestSuccessAt < WEB_SUCCESS_TTL_MS;
        if (hasGeminiTab || recentSuccess) {
            return {
                connected: true,
                detail: hasGeminiTab ? 'gemini.google.com tab open' : 'recent web request ok',
            };
        }
        return { connected: false, detail: 'no gemini.google.com tab or recent request' };
    }

    /** @returns {Promise<{connected: boolean, toolCount: number, error: string|null}>} */
    async probePcShell() {
        if (!this.mcpManager || typeof this.mcpManager.listToolsForServer !== 'function') {
            return {
                connected: false,
                toolCount: 0,
                error: 'MCP manager unavailable',
            };
        }

        try {
            const tools = await this._withTimeout(
                this.mcpManager.listToolsForServer(
                    NCODE_LOCAL_MCP_SERVER_ID,
                    'streamable-http',
                    NCODE_LOCAL_MCP_URL
                ),
                this.probeTimeoutMs
            );
            return {
                connected: true,
                toolCount: Array.isArray(tools) ? tools.length : 0,
                error: null,
            };
        } catch (error) {
            return {
                connected: false,
                toolCount: 0,
                error: toErrorMessage(error),
            };
        }
    }

    /** Broadcasts the given (or last) status snapshot. Never throws. */
    async broadcast(status = this.lastStatus) {
        const payload = status && typeof status === 'object' ? status : this._createEmptyStatus();
        await broadcastNcodeAction(NCODE_HARNESS_STATUS_ACTION, payload);
    }

    /**
     * Handles a UI NCODE_GET_HARNESS_STATUS / NCODE_GET_STATE request: re-probe
     * (cache-aware) + broadcast harness status, then re-broadcast the current
     * goal sessions so a freshly opened panel can hydrate its goal bar.
     * @param {{ force?: boolean }} [options]
     */
    async handleGetState(options = {}) {
        const status = await this.probeAndBroadcast({
            force: options?.force === true,
        });
        await this.broadcastGoalStates();
        return status;
    }

    /** Alias used by the background message handler for the canonical action. */
    async handleGetHarnessStatus(options = {}) {
        return this.handleGetState(options);
    }

    /** Re-broadcasts every active goal session (no-op without a goal manager). */
    async broadcastGoalStates() {
        const goalManager = this.goalManager;
        if (!goalManager || typeof goalManager.serializeActiveGoals !== 'function') return;
        let active = {};
        try {
            active = goalManager.serializeActiveGoals() || {};
        } catch {
            return;
        }
        for (const [sessionId, workflowId] of Object.entries(active)) {
            let goalSession = null;
            try {
                goalSession =
                    typeof goalManager.getGoalSession === 'function'
                        ? goalManager.getGoalSession(workflowId)
                        : null;
            } catch {
                goalSession = null;
            }
            if (!goalSession) continue;
            await broadcastNcodeAction(NCODE_GOAL_STATE_ACTION, {
                sessionId,
                workflowId,
                goalSession,
            });
        }
    }

    _readBridgeStatus() {
        const client = this.bridgeClient;
        if (!client) {
            return { connected: false, url: NCODE_BRIDGE_URL, lastError: null };
        }
        try {
            const status =
                typeof client.getStatus === 'function'
                    ? client.getStatus()
                    : { connected: client.connected === true, url: NCODE_BRIDGE_URL };
            return status || { connected: false, url: NCODE_BRIDGE_URL, lastError: null };
        } catch (error) {
            return { connected: false, url: NCODE_BRIDGE_URL, lastError: toErrorMessage(error) };
        }
    }

    _createEmptyStatus() {
        return {
            geminiWebConnected: false,
            geminiWebProvider: 'web',
            geminiWebDetail: null,
            pcShellConnected: false,
            pcShellEndpoint: NCODE_LOCAL_MCP_URL,
            pcShellToolCount: 0,
            pcShellError: null,
            bridgeConnected: false,
            bridgeEndpoint: NCODE_BRIDGE_URL,
            bridgeError: null,
            updatedAt: Date.now(),
        };
    }

    _withTimeout(promise, timeoutMs) {
        return new Promise((resolve, reject) => {
            let settled = false;
            const timer = setTimeout(() => {
                if (settled) return;
                settled = true;
                reject(new Error(`Timed out after ${timeoutMs}ms probing the PC shell daemon.`));
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
}
