// @ts-check
/** Probe: real compiled extension MCP client against the live daemon on 3001. */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..', '..');
const distDir = path.join(rootDir, 'extension', 'dist');

const url = 'http://127.0.0.1:3001/mcp';
const server = {
    id: 'ncode_local_pc',
    name: 'Ncode Local PC & Shell',
    transport: 'streamable-http',
    url,
    headers: {},
    enabled: true,
    toolMode: 'all',
    enabledTools: [],
};

try {
    const moduleUrl = pathToFileURL(
        path.join(distDir, 'background', 'managers', 'mcp_remote_manager.js')
    ).href;
    const started = Date.now();
    console.log('[mcp-probe] importing compiled client:', moduleUrl.slice(-70));
    const { McpRemoteManager } = await import(`${moduleUrl}?t=${Date.now()}`);
    console.log('[mcp-probe] import ok in', Date.now() - started, 'ms');
    const manager = new McpRemoteManager({ clientName: 'ncode-e2e', clientVersion: '1.0.0' });

    const tools = await manager.listToolsForServer(server.id, server.transport, server.url, {});
    console.log('[mcp-probe] tools/list ok:', tools.length, tools.map((tool) => tool.name).join(', '));

    const legacyConfig = {
        enableMcpTools: true,
        mcpEnabled: true,
        mcpTransport: 'streamable-http',
        mcpServerUrl: url,
        mcpServerId: 'ncode_local_pc',
        mcpToolMode: 'all',
        mcpEnabledTools: [],
    };
    const info = await manager.callTool(legacyConfig, 'pc_system_info', {});
    console.log('[mcp-probe] callTool pc_system_info isError=', info.isError, 'text head=', String(info.text).slice(0, 240));

    const echo = await manager.callTool(legacyConfig, 'pc_exec_shell', { command: 'echo ncode-e2e-ok' });
    console.log('[mcp-probe] callTool pc_exec_shell isError=', echo.isError, 'text=', String(echo.text).replace(/\s+/g, ' ').slice(0, 240));

    const write = await manager.callTool(legacyConfig, 'pc_fs_write', {
        filePath: path.join(rootDir, 'test', 'runtime', '.e2e-probe.txt'),
        content: 'probe-ok\n',
    });
    console.log('[mcp-probe] callTool pc_fs_write isError=', write.isError, 'text=', String(write.text).slice(0, 160));
    const read = await manager.callTool(legacyConfig, 'pc_fs_read', {
        filePath: path.join(rootDir, 'test', 'runtime', '.e2e-probe.txt'),
    });
    console.log('[mcp-probe] callTool pc_fs_read isError=', read.isError, 'text=', String(read.text).replace(/\s+/g, ' ').slice(0, 200));

    const byId = await manager.callToolById(
        'ncode_local_pc__pc_search_code',
        { directory: path.join(rootDir, 'orchestrator'), pattern: 'createGoalSession', fileGlob: '*.js' },
        [server]
    );
    console.log('[mcp-probe] callToolById search isError=', byId.isError, 'text head=', String(byId.text).replace(/\s+/g, ' ').slice(0, 200));
    console.log('[mcp-probe] ALL MCP PROBES COMPLETED');
} catch (error) {
    console.error('[mcp-probe] FAILED:', error?.stack || error);
    process.exitCode = 1;
}
