// @ts-check
/**
 * Probe: real compiled background service worker executes a full goal-mode tool
 * loop against the live pc-daemon, with only the remote Gemini Web HTTP surface
 * stubbed (the extension's own auth token fetch, streaming parse, prompt builder,
 * tool executor, MCP client, goal manager and compaction checks are all real).
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createChromeMock } from './chrome_mock.mjs';
import { NCODE_LOCAL_MCP_SERVER_ID } from '../../extension/shared/settings/connection.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..', '..');
const distDir = path.join(rootDir, 'extension', 'dist');
const realFetch = globalThis.fetch;

const DAEMON_URL = 'http://127.0.0.1:3001/mcp';
const MODEL = '56fdd199312815e2';
const SESSION_ID = 'e2e-session';
const SEARCH_PATTERN = 'createGoalSession';

const { chrome, state } = createChromeMock({ extensionDir: distDir });
globalThis.chrome = chrome;
if (typeof globalThis.self === 'undefined') globalThis.self = globalThis;

// --- Seed the extension storage exactly like a configured fresh install ---
await chrome.storage.local.set({
    geminiProvider: 'web',
    geminiModel: MODEL,
    geminiMcpEnabled: true,
    geminiMcpTransport: 'streamable-http',
    geminiMcpServerUrl: DAEMON_URL,
    geminiMcpServers: [
        {
            id: NCODE_LOCAL_MCP_SERVER_ID,
            name: 'Ncode Local PC & Shell',
            transport: 'streamable-http',
            url: DAEMON_URL,
            headers: {},
            enabled: true,
            toolMode: 'all',
            enabledTools: [],
        },
    ],
    geminiSessions: [
        {
            id: SESSION_ID,
            title: 'E2E goal run',
            timestamp: Date.now(),
            messages: [{ role: 'user', text: 'Inspect the machine and report the OS, then verify the repository search works.' }],
        },
    ],
});

// --- Scripted Gemini Web surface (the only remote stub) ---
const geminiRequests = [];
const scriptedResponses = [
    `<ncode_preamble>Inspecting the local machine state now.</ncode_preamble>
<ncode_goal_update>{"subgoalId":"plan","status":"done","evidence":"Called pc_system_info to read real OS facts."}</ncode_goal_update>
I will inspect the machine.

\`\`\`json
{"tool":"pc_system_info","args":{}}
\`\`\``,
    `<ncode_preamble>Machine facts verified; confirming the goal.</ncode_preamble>
<ncode_goal_update>{"subgoalId":"execute","status":"done","evidence":"pc_system_info returned platform win32 and node v24."}</ncode_goal_update>
<ncode_goal_update>{"subgoalId":"verify","status":"done","evidence":"Tool result parsed successfully in the continuation prompt."}</ncode_goal_update>
<ncode_goal_complete>true</ncode_goal_complete>
The machine was inspected successfully: Windows x64, Node v24, and the harness MCP tool executed inside the real goal loop.`,
];
let streamIndex = 0;

function buildGeminiPayloadLine(text) {
    // Parser contract: envelope item[2] = JSON string of the payload;
    // payload[4] = candidates, candidates[0] = candidate, candidate[1][0] = text.
    const candidate = ['choice-e2e', [text], null, null, null];
    const payload = [null, ['conv-e2e', 'resp-e2e'], null, null, [candidate]];
    const envelopeEntry = ['wrb.fr', null, JSON.stringify(payload)];
    return `${JSON.stringify([envelopeEntry])}\n`;
}

const GEMINI_HTML = `<!doctype html><html lang="en-US"><body>
<script>window.WIZ_global_data={"SNlM0e":"at-e2e-token","cfb2h":"bl-e2e-token","FdrFJe":"fsid-e2e-token","qKIAYe":"push-e2e-token","Ylro7b":"pctx-e2e-token"};</script>
<div data-index="0"></div></body></html>`;

function streamResponse(text) {
    const encoder = new TextEncoder();
    const body = new ReadableStream({
        start(controller) {
            controller.enqueue(encoder.encode(buildGeminiPayloadLine(text)));
            controller.close();
        },
    });
    return new Response(body, { status: 200, headers: { 'Content-Type': 'text/plain' } });
}

globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input?.url || String(input);
    if (url.startsWith('https://gemini.google.com') && !url.includes('StreamGenerate')) {
        return new Response(GEMINI_HTML, { status: 200, headers: { 'Content-Type': 'text/html' } });
    }
    if (url.includes('StreamGenerate')) {
        const bodyText = typeof init.body?.toString === 'function' ? init.body.toString() : String(init.body || '');
        geminiRequests.push({ url: url.slice(0, 120), body: bodyText });
        const responseText = scriptedResponses[Math.min(streamIndex, scriptedResponses.length - 1)];
        streamIndex += 1;
        return streamResponse(responseText);
    }
    if (url.startsWith('http://127.0.0.1:3001')) {
        return realFetch(input, init);
    }
    return realFetch(input, init);
};

function decodePrompt(bodyText) {
    const params = new URLSearchParams(bodyText);
    const fReq = params.get('f.req');
    if (!fReq) return '';
    try {
        const outer = JSON.parse(fReq);
        const inner = JSON.parse(outer[1]);
        const messageStruct = inner[0];
        return Array.isArray(messageStruct) ? String(messageStruct[0]) : '';
    } catch {
        return '';
    }
}

process.on('uncaughtException', (error) => {
    console.error('[loop-probe] UNCAUGHT:', error?.stack || error);
    process.exitCode = 2;
});
process.on('unhandledRejection', (error) => {
    console.error('[loop-probe] UNHANDLED REJECTION:', error?.stack || error);
});

const entry = path.join(distDir, 'background', 'index.js');
await import(`${pathToFileURL(entry).href}?loop=${Date.now()}`);
await new Promise((resolve) => setTimeout(resolve, 300));
console.log('[loop-probe] compiled background booted; listeners=', chrome.runtime.onMessage.listeners.length);

const request = {
    action: 'SEND_PROMPT',
    text: 'Inspect the machine and report the OS, then verify the repository search works.',
    historyPromptText: 'Inspect the machine and report the OS, then verify the repository search works.',
    files: null,
    model: MODEL,
    enableBrowserControl: false,
    includePageContext: false,
    enableMcpTools: true,
    ncodeGoalMode: true,
    sessionId: SESSION_ID,
    mcpServers: [
        {
            id: NCODE_LOCAL_MCP_SERVER_ID,
            name: 'Ncode Local PC & Shell',
            transport: 'streamable-http',
            url: DAEMON_URL,
            headers: {},
            enabled: true,
            toolMode: 'all',
            enabledTools: [],
        },
    ],
    mcpTransport: 'streamable-http',
    mcpServerUrl: DAEMON_URL,
    mcpServerId: NCODE_LOCAL_MCP_SERVER_ID,
    mcpToolMode: 'all',
    mcpEnabledTools: [],
};

let responseValue = 'NO_RESPONSE';
const responsePromise = new Promise((resolve) => {
    let settled = false;
    const sendResponse = (value) => {
        if (settled) return;
        settled = true;
        responseValue = value;
        resolve(value);
    };
    for (const listener of chrome.runtime.onMessage.listeners) {
        listener(request, { id: 'e2e' }, sendResponse);
    }
    setTimeout(() => {
        if (!settled) {
            settled = true;
            resolve('TIMEOUT');
        }
    }, 45000);
});

await Promise.race([responsePromise, new Promise((resolve) => setTimeout(resolve, 45000))]);
await new Promise((resolve) => setTimeout(resolve, 500));

const actions = state.runtimeMessages.map((message) => message.action);
console.log('[loop-probe] SEND_PROMPT sendResponse=', JSON.stringify(responseValue));
console.log('[loop-probe] broadcasts count=', state.runtimeMessages.length, 'actions=', JSON.stringify(actions));
console.log('[loop-probe] gemini StreamGenerate requests=', geminiRequests.length);
geminiRequests.forEach((call, index) => {
    const prompt = decodePrompt(call.body);
    console.log(`[loop-probe] --- request ${index + 1} prompt head (${prompt.length} chars) ---`);
    console.log(prompt.slice(0, 500).replace(/\n/g, ' | '));
    if (index === 1) {
        console.log(`[loop-probe] --- request 2 tool-output evidence ---`);
        console.log(prompt.includes('pc_system_info') ? 'contains pc_system_info' : 'MISSING pc_system_info');
        console.log(prompt.includes('win32') ? 'contains real tool output win32' : 'MISSING win32 tool output');
        console.log(prompt.includes('Tool Output') ? 'contains Tool Output wrapper' : 'MISSING Tool Output wrapper');
    }
});

const byAction = (action) => state.runtimeMessages.filter((message) => message.action === action);
const toolStatuses = byAction('TOOL_CALL_STATUS_MESSAGE');
console.log('[loop-probe] tool statuses=', JSON.stringify(toolStatuses.map((item) => ({ tool: item.toolName, status: item.status }))));
const preambles = byAction('NCODE_PREAMBLE');
console.log('[loop-probe] preambles=', JSON.stringify(preambles.map((item) => item.text)));
const goalStates = byAction('NCODE_GOAL_STATE');
console.log('[loop-probe] goal states=', goalStates.length, 'last status=', goalStates.at(-1)?.goalSession?.status, 'subgoals=', JSON.stringify((goalStates.at(-1)?.goalSession?.subgoals || []).map((item) => `${item.id}:${item.status}`)));
const replies = byAction('GEMINI_REPLY');
console.log('[loop-probe] replies=', JSON.stringify(replies.map((item) => ({ status: item.status, text: String(item.text).slice(0, 160) }))));
const statusBroadcasts = byAction('NCODE_HARNESS_STATUS');
console.log('[loop-probe] harness status=', statusBroadcasts.length ? JSON.stringify(statusBroadcasts.at(-1)).slice(0, 400) : 'none');
console.log('[loop-probe] first prompt has goal directive=', decodePrompt(geminiRequests[0]?.body || '').includes('Ncode Astra Goal Loop'));
console.log('[loop-probe] first prompt has pc tools=', decodePrompt(geminiRequests[0]?.body || '').includes('pc_system_info'));
process.exit(0);
