# Ncode

**A 100% working, zero-API-key Agentic IDE & Browser/PC Harness.**

Ncode drives an autonomous coding/browsing agent from the user's **already logged-in
`gemini.google.com` web session** — no API key, no provider account, no extra billing. The
model gets a real local PC (shell, filesystem, code search), full Chrome DOM control, an
Astra-style Goal Loop with live interim status preambles, and Compact & Resume session
durability across long runs.

Built by merging:

| Source | Role in Ncode |
| --- | --- |
| `Gemini-Nexus` | Chrome MV3 extension base: side panel chat UI, `gemini.google.com` web provider, browser-control tools, MCP client, sessions/settings |
| `gemini-browser-mcp` | Legacy WebSocket bridge foundation and CLI↔Gemini-Web prompt-injection reference (`pc-daemon/legacy-bridge/`, `reference-dom-injector.js`) |
| `chat-on-steroids` | Astra Goal Loop, Interim Preambles, Compact & Resume, and computer-use architecture specifications |

## Repository layout

```text
Ncode/
├── package.json                 # unified install / build / run / verify scripts
├── extension/                   # Chrome MV3 extension (Gemini-Nexus base, modified)
│   ├── background/              # MV3 service worker: providers, prompt loop, MCP, Ncode managers
│   ├── content/ services/ shared/ settings/ sidepanel/ sandbox/ css/ assets/ vendor/
│   ├── manifest.json            # "Ncode" v1.0.0
│   ├── scripts/                 # packaging helpers
│   └── dist/                    # ← loadable extension produced by npm run build:extension
├── pc-daemon/
│   ├── server.mjs               # zero-dependency local PC & shell MCP daemon (HTTP 3001 + WS 8085 + stdio)
│   ├── smoke_test.mjs           # 80-assertion end-to-end daemon test
│   ├── legacy-bridge/           # copied gemini-browser-mcp server.js + cli.js
│   ├── native-host/             # copied native logger host + cross-platform installer
│   └── reference-dom-injector.js
├── orchestrator/                # pure ES-module orchestration core (Phase 2)
│   ├── goal_state_machine.js    # Astra Goal Loop state machine, tags, directives
│   ├── compact_resume_engine.js # pruning, compaction prompt/summary, checkpoints, resume
│   └── smoke_test.mjs           # 36-assertion contract test
└── scripts/                     # dev runner, daemon smoke test, packaged-extension verifier, acceptance gate
```

`extension/shared/orchestrator/` contains byte-identical copies of the two orchestrator
modules so the MV3 service worker can import them through the extension's own module graph.

## Quick start

Prerequisites: **Node.js ≥ 20**, **Chrome**, and a Chrome profile **signed in at
<https://gemini.google.com>** (this is the only "API key" Ncode needs).

```bash
cd Ncode
npm run install:all        # extension deps (vite, marked, katex, …) + pc-daemon (no deps)
npm run build:extension    # vite build → package → loadable extension/dist
npm run start:daemon       # HTTP MCP 127.0.0.1:3001 + WS bridge 127.0.0.1:8085
```

Then:

1. Open `chrome://extensions` → enable **Developer mode** → **Load unpacked** →
   select `Ncode/extension/dist`.
2. Open or refresh <https://gemini.google.com> so the web session/provider is available
   (also open a normal tab you want Ncode to inspect/control).
3. Click the Ncode toolbar icon (or `Alt+G`) to open the side panel.
4. Type a task. The **Ncode Goal & PC Harness** bar at the top of the chat shows:
   - `Gemini Web (Connected)` — logged-in web-session provider status
   - `PC Shell MCP (Port 3001 Connected)` — local daemon status and discovered tool count
   - the live **Interim Preamble** ticker, the **Goal Loop** toggle (default **on**),
     a collapsible **Subgoal checklist**, and the **Compact & Resume** button.

Development (Vite watcher + daemon together):

```bash
npm run dev
```

## Phase 3 — local PC & shell MCP daemon

`pc-daemon/server.mjs` is a single-file, zero-runtime-dependency Node server running three
transports simultaneously:

| Transport | Address | Use |
| --- | --- | --- |
| Streamable HTTP MCP | `http://127.0.0.1:3001/mcp` | auto-connected by the extension's `background/managers/mcp/streamable_http.js` |
| WebSocket bridge | `ws://127.0.0.1:8085` | extension⇄daemon relay for `ask_gemini_web`; legacy `gemini-browser-mcp` compatible |
| Stdio MCP | `node pc-daemon/server.mjs --stdio` | Claude Code / Gemini CLI / other CLI agents |

Other endpoints: `GET /health`, `GET/DELETE /mcp` (method responses per MCP spec).
Flags: `--stdio --http --no-http --ws --no-ws --http-port --ws-port --host --help`.
Env: `NCODE_STATE_DIR`, `NCODE_HTTP_PORT`, `NCODE_WS_PORT`, `NCODE_HOST`, `NCODE_DEBUG`,
`NCODE_WS_PING_MS`. All diagnostics go to **stderr**; stdout is JSON-RPC only.

### Tools

| Tool | Purpose |
| --- | --- |
| `pc_exec_shell` | Run a command (Windows `cmd.exe` / macOS+Linux `/bin/sh`); captures stdout/stderr/exitCode, 32 KB head+tail truncation with full-log pointer, `timeoutMs` process-tree kill, detached `background` spawn returning `{pid, logPath}` |
| `pc_fs_read` | Read a file with 1-based inclusive `startLine`/`endLine`, line numbers, binary detection |
| `pc_fs_write` | Atomic write (temp file + rename) with optional `createDirs` |
| `pc_fs_patch` | Surgical unique-string replace + unified diff snippet (fails on 0 or >1 matches) |
| `pc_search_code` | Regex code search via `rg` when installed, else pure-Node recursive fallback; `fileGlob` support (`**`, `*`, `?`, `{a,b}`) |
| `pc_system_info` | OS/arch/shell/cwd, Node/npm/Python/Git versions, managed background processes, uptime |
| `workflow_save_checkpoint` | Atomic durable checkpoint at `~/.ncode/workflows/<workflowId>.json` |
| `workflow_load_checkpoint` | Load a persisted workflow checkpoint |
| `workflow_list_checkpoints` | List durable checkpoints |
| `ask_gemini_web` | **stdio mode only**: relay a prompt over WS 8085 to the extension's `gemini.google.com` web provider |

Checkpoints and truncation logs live under `~/.ncode/` (override with `NCODE_STATE_DIR`).

## Phase 2 — orchestrator core

### `goal_state_machine.js` (Astra Goal Loop)

- `GoalSession`: `workflowId`, `rootGoal`, `subgoals[{id,title,role,status,evidence}]`,
  `iterationCount`, `maxIterations` (default **30**), `status`
  (`active | compacting | paused | completed | failed`).
- `buildGoalSystemDirective(goalSession)` — system block instructing the web model to emit:
  - `<ncode_preamble>one-line real-time status</ncode_preamble>` before every tool call,
  - `<ncode_goal_update>{"subgoalId":…,"status":…,"evidence":…}</ncode_goal_update>` on milestones,
  - `<ncode_goal_complete>true</ncode_goal_complete>` only when all subgoals are verified done,
  - plus the standard MCP JSON tool-call block parsed by `shared/text/tool_call_text.js`.
- `parseGoalTags(modelText)` — robust extraction (multiple tags, whitespace, malformed JSON
  tolerated, tags stripped from display text).
- Pure deterministic transitions: `applyGoalUpdate`, `markGoalCompletion`, `markGoalStatus`,
  `incrementIteration`, `isGoalComplete`, `isGoalExhausted`, continuation/resume prompt builders.

### `compact_resume_engine.js` (Compact & Resume)

- Monitors cumulative conversation characters (`estimateContextChars`, `needsCompaction`,
  default threshold **120,000 chars**) against stored session turns.
- Replaces historical `take_snapshot` / `chrome_dom_snapshot` / `pc_exec_shell`-style verbose
  tool outputs (except the most recent **2** turns) with
  `[Pruned by Ncode Compactor - see checkpoint summary]`.
- Runs one dedicated compaction turn against `gemini.google.com` asking for exactly:
  `completedSubgoals`, `modifiedFilesAndCommands`, `discoveredFactsAndErrors`,
  `nextImmediateAction`.
- Persists the checkpoint to **both** `chrome.storage.local`
  (`ncodeCheckpoint:<workflowId>`, via the extension's storage manager family including
  `bridge_records.js`) **and** the PC daemon through `workflow_save_checkpoint`
  (`~/.ncode/workflows/<workflowId>.json`), then hydrates a fresh Gemini Web turn and resumes
  the tool loop automatically — or on demand from the **Compact & Resume** button.

The engine is dependency-injected and pure; the extension wiring lives in
`background/managers/ncode_goal_manager.js`, `ncode_compact_manager.js`,
`ncode_harness_status.js`, and `ncode_bridge_client.js`.

## Extension integration (Phase 4)

- **Defaults out of the box:** provider `web` (`gemini.google.com`), MCP transport
  `streamable-http`, and an enabled server named **“Ncode Local PC & Shell”** at
  `http://127.0.0.1:3001/mcp`. No manual URL entry is needed.
- **Prompt builder** injects the Ncode PC/browser harness preamble (both tool surfaces:
  internal Chrome control `take_snapshot/click/fill/evaluate_script/...` with the
  `chrome_*` aliases, and the PC daemon tools) plus the Goal directive and post-compaction
  hydration block.
- **Tool loop** (up to 30 steps per goal cycle) parses preambles/goal tags before each tool
  execution, broadcasts live status, arms the MV3 keep-alive heartbeat around long shell
  executions, checks for automatic compaction after each tool, and autonomously continues an
  active goal until completion or a truthful failure at the iteration cap.
- **Harness bar** in the sandboxed chat UI (side panel) shows connection badges, the interim
  preamble ticker, the subgoal checklist, the Goal Loop toggle, and Compact & Resume.

### UI ⇄ background message contract

| Direction | Action | Payload |
| --- | --- | --- |
| background → UI | `NCODE_HARNESS_STATUS` | `{geminiWebConnected, geminiWebProvider, pcShellConnected, pcShellEndpoint, pcShellToolCount, bridgeConnected, updatedAt}` |
| background → UI | `NCODE_GOAL_STATE` | `{sessionId, workflowId, goalSession}` |
| background → UI | `NCODE_PREAMBLE` | `{sessionId, workflowId, text, ts}` |
| background → UI | `NCODE_COMPACTION_STATE` | `{sessionId, workflowId, state, detail, ts}` |
| UI → background | `NCODE_GET_STATE` | — (probes + re-broadcasts) |
| UI → background | `NCODE_COMPACT_RESUME` | `{sessionId, force}` |
| UI → background | `NCODE_RESET_GOAL` | `{sessionId}` |

`SEND_PROMPT` accepts `ncodeGoalMode` (absent ⇒ enabled for side-panel prompts; explicit
`false` disables the Astra goal loop for that run).

## Phase 1 copies & native logging (optional)

- `gemini-browser-mcp/gemini-bridge/{server.js,cli.js}` → `pc-daemon/legacy-bridge/`
- `gemini-browser-mcp/chrome-extension/content.js` → `pc-daemon/reference-dom-injector.js`
- `Gemini-Nexus/scripts/native-logger/host.js` +
  `scripts/install-native-logger.mjs` → `pc-daemon/native-host/`
  (installer now resolves `host.js` beside itself and supports Windows/macOS/Linux Chrome
  NativeMessagingHosts directories:
  `node pc-daemon/native-host/install-native-logger.mjs --extension-id <id>`).

## Verification

Everything below is runnable from `Ncode/` and was executed against this tree:

```bash
npm run install:all          # dependencies
npm run build:extension      # Vite build + packaging + loadable extension/dist
npm run check                # complete acceptance gate (7/7)
npm run test:orchestrator    # 36/36 orchestrator contract checks
npm run test:pc-daemon       # 80/80 real spawned-daemon checks
npm run smoke:daemon         # default-port smoke test (initialize/list/pc_system_info/WS)
npm run verify:extension     # 27/27 packaged-extension checks
```

Measured results in this build:

| Gate | Result |
| --- | --- |
| `npm run install:all` | exit 0 |
| `npm run build:extension` | Vite build succeeded; package prepared; `extension/dist` = **348 loadable files**, manifest Ncode v1.0.0 |
| `npm run check` | **All 7 acceptance checks passed** (532 files syntax-checked, mirror byte-identical, no placeholders, 3 runtime suites, script contract) |
| `npm run test:orchestrator` | **All 36 checks passed** |
| `npm run test:pc-daemon` | **PASS: 80/80 checks** |
| `npm run verify:extension` | **All 27 packaged-extension checks passed** |
| Targeted vitest integration suite | **82/82 tests passed** (`ncode_managers`, `prompt_handler`, `builder`, `tool_loop`, `ncode_harness_bar`, `message_handler`, `window_actions`, `connection`) |
| curl against `http://127.0.0.1:3001/mcp` | `initialize` → `ncode-pc-daemon` v1.0.0; `tools/list` → 9 tools; `tools/call pc_system_info` → `isError:false`, `platform: win32`, `node: v24.20.0` |
| `npm run dev` | daemon healthy on 3001 + Vite ready on 3000 |

Live browser acceptance (clicking through a signed-in Chrome profile) is **not** exercised by
the automated gates above: the verified levels here are source → unit/integration tests →
Vite build → packaged payload → local daemon HTTP/WS/stdio behavior. Loading the unpacked
`extension/dist` into a signed-in Chrome is the remaining manual acceptance step.

## Security & operational notes

- Both daemon listeners bind loopback only (`127.0.0.1`); the WS bridge and MCP endpoint are
  unauthenticated loopback services. `pc_exec_shell` runs with the user's full privileges —
  run Ncode only on a machine you trust and do not expose the ports.
- `ask_gemini_web` over the bridge is intentionally single-shot (no stored session history,
  no tool loop) to avoid interleaving the shared reverse-engineered web auth context.
- A "fresh Gemini Web conversation" for Compact & Resume means resetting the web auth/context
  and re-hydrating from the durable checkpoint; the reverse-engineered transport has no
  server-side conversation id to fork.
- MCP checkpoint mirroring is best-effort (the daemon may be offline); the
  `chrome.storage.local` checkpoint is authoritative and the compaction reports failure
  rather than claiming an unpersisted checkpoint is durable.
- The reverse-engineered `gemini.google.com` transport can drift when Google changes protocol
  parameters; `extension/scripts/gemini-web-drift-check.mjs` (upstream) is the canary.

## Known limitations

- Ncode relies on the user's Gemini Web account/model availability; no API fallback is used.
- Tool execution requires Chrome to stay open on the signed-in profile and the MV3 worker to
  stay alive (the harness arms stream heartbeats and keep-alive during long commands).
- The upstream Gemini-Nexus full test suite (`npm run check` inside `extension/`) includes
  tests for repository docs/assets that were not copied into Ncode; only the Ncode
  acceptance gate (`npm run check` at the Ncode root) is authoritative here.
