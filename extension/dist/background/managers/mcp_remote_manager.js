import { normalizeMcpToolResult } from './mcp/tool_result.js';
import { filterToolsForPreamble, formatToolsPreamble } from './mcp/preamble.js';
import { getActiveMcpServers, parseToolId, tagToolsForServer } from './mcp/server_tools.js';
import {
    listPromptsForConnection,
    listResourceTemplatesForConnection,
    listResourcesForConnection,
    listToolsForConnection,
} from './mcp/tool_listing.js';
import { McpConnectionClient } from './mcp/connection_client.js';
import { createReconnectPolicy } from './mcp/reconnect_policy.js';

export class McpRemoteManager {
    constructor({
        clientName = 'gemini-nexus',
        clientVersion = '0.0.0',
        reconnectPolicy = null,
    } = {}) {
        this.connectionClient = new McpConnectionClient({ clientName, clientVersion });
        this.reconnectPolicy = reconnectPolicy || createReconnectPolicy();
    }

    isEnabled(config) {
        const enabled = config && (config.enableMcpTools === true || config.mcpEnabled === true);
        return !!(enabled && config.mcpServerUrl);
    }

    isMultiEnabled(config) {
        if (!config || config.enableMcpTools !== true) return false;
        const servers = config.mcpServers;
        if (!Array.isArray(servers)) return false;
        return servers.some(
            (serverConfig) =>
                serverConfig &&
                serverConfig.enabled !== false &&
                serverConfig.url &&
                serverConfig.url.trim()
        );
    }

    async disconnect(serverId) {
        this.reconnectPolicy.invalidate(serverId);
        return this.connectionClient.disconnect(serverId);
    }

    /**
     * Drops any cached connection/failure state for one server (or all servers)
     * so the next list/status call dials again immediately, without waiting for
     * the reconnect backoff window.
     */
    async reconnect(serverId) {
        this.reconnectPolicy.invalidate(serverId);
        if (serverId) await this.connectionClient.disconnect(serverId);
        return true;
    }

    async _sendRpc(conn, method, params) {
        return this.connectionClient.sendRpc(conn, method, params);
    }

    async _ensureConnectedForServer(serverId, transport, url, headers = {}) {
        return this.connectionClient.ensureConnectedForServer(serverId, transport, url, headers);
    }

    async _ensureConnected(config) {
        if (!this.isEnabled(config)) {
            throw new Error('MCP is not enabled or server URL is missing.');
        }
        const serverId = config.mcpServerId || '_legacy_';
        return await this._ensureConnectedForServer(
            serverId,
            config.mcpTransport,
            config.mcpServerUrl,
            config.mcpHeaders
        );
    }

    async _listToolsForConnection(conn) {
        return listToolsForConnection(conn, (method, params) =>
            this._sendRpc(conn, method, params)
        );
    }

    async _listPromptsForConnection(conn) {
        return listPromptsForConnection(conn, (method, params) =>
            this._sendRpc(conn, method, params)
        );
    }

    async _listResourcesForConnection(conn) {
        return listResourcesForConnection(conn, (method, params) =>
            this._sendRpc(conn, method, params)
        );
    }

    async _listResourceTemplatesForConnection(conn) {
        return listResourceTemplatesForConnection(conn, (method, params) =>
            this._sendRpc(conn, method, params)
        );
    }

    async listTools(config) {
        const conn = await this._ensureConnected(config);
        return this._listToolsForConnection(conn);
    }

    async listPrompts(config) {
        const conn = await this._ensureConnected(config);
        return this._listPromptsForConnection(conn);
    }

    async getPrompt(config, name, args = {}) {
        const conn = await this._ensureConnected(config);
        return this._sendRpc(conn, 'prompts/get', { name, arguments: args || {} });
    }

    async listResources(config) {
        const conn = await this._ensureConnected(config);
        return this._listResourcesForConnection(conn);
    }

    async readResource(config, uri) {
        const conn = await this._ensureConnected(config);
        return this._sendRpc(conn, 'resources/read', { uri });
    }

    async listResourceTemplates(config) {
        const conn = await this._ensureConnected(config);
        return this._listResourceTemplatesForConnection(conn);
    }

    /**
     * Lists tools for one server through the per-server reconnect policy: a
     * failed/cached connection is retried after the short invalidation TTL, and
     * `forceNewConnection` (or an explicit reconnect) bypasses the backoff so a
     * daemon started after Chrome is picked up without reloading the extension.
     */
    async listToolsForServer(serverId, transport, url, headers = {}, options = {}) {
        return this.reconnectPolicy.execute(serverId, options, {
            connect: () =>
                this.connectionClient.ensureConnectedForServer(serverId, transport, url, headers),
            disconnect: () => this.connectionClient.disconnect(serverId),
            use: (conn) => this._listToolsForConnection(conn),
        });
    }

    async listAllActiveTools(servers) {
        const activeServers = getActiveMcpServers(servers);
        if (activeServers.length === 0) return [];

        const results = await Promise.allSettled(
            activeServers.map(async (server) => {
                const tools = await this.listToolsForServer(
                    server.id,
                    server.transport,
                    server.url,
                    server.headers
                );
                return tagToolsForServer(server, tools);
            })
        );

        const allTools = [];
        for (let i = 0; i < results.length; i++) {
            const result = results[i];
            if (result.status === 'fulfilled') {
                allTools.push(...result.value);
            } else {
                console.error('[MCP] Server', activeServers[i].id, 'failed:', result.reason);
            }
        }
        return allTools;
    }

    async callTool(config, toolName, args) {
        const conn = await this._ensureConnected(config);

        const result = await this._sendRpc(conn, 'tools/call', {
            name: toolName,
            arguments: args || {},
        });

        return normalizeMcpToolResult(result);
    }

    async callToolById(toolId, args, servers) {
        const { serverId, toolName } = parseToolId(toolId);

        const server = servers.find((serverConfig) => serverConfig.id === serverId);
        if (!server) {
            throw new Error(`Server not found: ${serverId}`);
        }

        const conn = await this._ensureConnectedForServer(
            serverId,
            server.transport,
            server.url,
            server.headers
        );
        const result = await this._sendRpc(conn, 'tools/call', {
            name: toolName,
            arguments: args || {},
        });

        return normalizeMcpToolResult(result);
    }

    async buildToolsPreamble(config) {
        const servers = config.mcpServers;
        const isMulti = this.isMultiEnabled(config);

        let allTools = [];
        if (isMulti) {
            allTools = await this.listAllActiveTools(servers);
        } else {
            allTools = await this.listTools(config);
        }

        const enabledTools = filterToolsForPreamble(allTools, { isMulti, servers, config });
        return formatToolsPreamble(enabledTools);
    }
}
