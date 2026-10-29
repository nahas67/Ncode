// @ts-check
/**
 * Ncode end-to-end daemon smoke test (Phase 5 acceptance).
 *
 * Boots ./Ncode/pc-daemon/server.mjs on its default ports (127.0.0.1:3001 HTTP
 * MCP, 127.0.0.1:8085 WebSocket bridge), then exercises the same JSON-RPC calls
 * the Chrome extension performs:
 *   1. GET  /health
 *   2. POST /mcp initialize
 *   3. POST /mcp tools/list
 *   4. POST /mcp tools/call pc_system_info
 *   5. WebSocket register handshake on 8085
 *
 * Exit code 0 means the daemon is reachable and answering at the unified
 * contract endpoints. Usage (from ./Ncode):
 *   npm run smoke:daemon
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const HTTP_URL = 'http://127.0.0.1:3001/mcp';
const HEALTH_URL = 'http://127.0.0.1:3001/health';
const WS_URL = 'ws://127.0.0.1:8085';

const checks = [];

function record(name, ok, detail) {
    checks.push({ name, ok, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`);
}

async function rpc(id, method, params) {
    const response = await fetch(HTTP_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params: params || {} }),
    });
    const text = await response.text();
    if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${text.slice(0, 300)}`);
    }
    const parsed = JSON.parse(text);
    if (parsed.error) {
        throw new Error(`JSON-RPC error for ${method}: ${JSON.stringify(parsed.error)}`);
    }
    return parsed.result;
}

async function waitForDaemon(timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs;
    let lastError = null;
    while (Date.now() < deadline) {
        try {
            const response = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(2000) });
            if (response.ok) return await response.json();
        } catch (error) {
            lastError = error;
        }
        await new Promise((resolve) => setTimeout(resolve, 300));
    }
    throw new Error(`daemon did not become ready: ${lastError?.message || 'timeout'}`);
}

async function checkWebSocket() {
    return new Promise((resolve) => {
        let settled = false;
        const finish = (ok, detail) => {
            if (settled) return;
            settled = true;
            try {
                socket.close();
            } catch {
                // Ignore close races.
            }
            resolve({ ok, detail });
        };

        const socket = new WebSocket(WS_URL);
        const timer = setTimeout(() => finish(false, 'no register acknowledgement within 8s'), 8000);

        socket.addEventListener('open', () => {
            socket.send(
                JSON.stringify({
                    type: 'register',
                    role: 'extension',
                    client: 'ncode-smoke-test',
                    version: '1.0.0',
                })
            );
        });
        socket.addEventListener('message', (event) => {
            try {
                const message = JSON.parse(String(event.data));
                if (message && message.type === 'registered') {
                    clearTimeout(timer);
                    finish(true, 'registered on 8085');
                }
            } catch {
                // Ignore non-JSON frames in the smoke test.
            }
        });
        socket.addEventListener('error', () => {
            clearTimeout(timer);
            finish(false, 'websocket error');
        });
        socket.addEventListener('close', () => {
            clearTimeout(timer);
            finish(false, 'websocket closed before register');
        });
    });
}

async function main() {
    const child = spawn(process.execPath, [path.join(rootDir, 'pc-daemon', 'server.mjs')], {
        cwd: rootDir,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env },
    });

    let daemonLog = '';
    child.stdout?.on('data', (chunk) => {
        daemonLog += chunk.toString();
    });
    child.stderr?.on('data', (chunk) => {
        daemonLog += chunk.toString();
    });

    try {
        const health = await waitForDaemon();
        record('health endpoint', health?.ok === true, `name=${health?.name} tools=${health?.tools}`);

        const initialize = await rpc(1, 'initialize', {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: { name: 'ncode-smoke-test', version: '1.0.0' },
        });
        record(
            'initialize',
            initialize?.serverInfo?.name === 'ncode-pc-daemon' &&
                typeof initialize?.capabilities?.tools === 'object',
            `server=${initialize?.serverInfo?.name}`
        );

        await fetch(HTTP_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }),
        }).catch(() => {});

        const tools = await rpc(2, 'tools/list', {});
        const names = new Set((tools?.tools || []).map((tool) => tool.name));
        const expected = [
            'pc_exec_shell',
            'pc_fs_read',
            'pc_fs_write',
            'pc_fs_patch',
            'pc_search_code',
            'pc_system_info',
            'workflow_save_checkpoint',
            'workflow_load_checkpoint',
        ];
        const missing = expected.filter((name) => !names.has(name));
        record('tools/list', missing.length === 0, `${names.size} tools${missing.length ? `, missing: ${missing.join(',')}` : ''}`);

        const systemInfo = await rpc(3, 'tools/call', { name: 'pc_system_info', arguments: {} });
        const text = systemInfo?.content?.[0]?.text || '';
        let parsed = null;
        try {
            parsed = JSON.parse(text);
        } catch {
            parsed = null;
        }
        record(
            'tools/call pc_system_info',
            systemInfo?.isError !== true && parsed?.platform === process.platform,
            `platform=${parsed?.platform} node=${parsed?.node}`
        );

        const ws = await checkWebSocket();
        record('websocket bridge register', ws.ok, ws.detail);
    } catch (error) {
        record('daemon smoke test', false, error instanceof Error ? error.message : String(error));
    } finally {
        child.kill('SIGTERM');
        await new Promise((resolve) => setTimeout(resolve, 500));
        if (child.exitCode === null) child.kill();
        const failures = checks.filter((check) => !check.ok);
        if (failures.length > 0) {
            console.error('\n--- daemon stderr/stdout (tail) ---');
            console.error(daemonLog.slice(-4000));
            console.error(`\n${failures.length} smoke check(s) failed.`);
            process.exitCode = 1;
        } else {
            console.log('\nAll daemon smoke checks passed.');
        }
    }
}

main();
