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
├── extension/                   # Chrome MV3 extension (Gemini-Nexus base, extended for Ncode)
│   ├── background/              # MV3 service worker: providers, prompt loop, MCP, Ncode managers
│   ├── content/                 # content scripts incl. the Gemini live-DOM bridge fallback
│   ├── services/ shared/ settings/ sidepanel/ sandbox/ css/ assets/ vendor/
│   ├── manifest.json            # "Ncode" v1.0.0
│   ├── scripts/                 # packaging helpers + project contract tests
│   ├── test/runtime/            # e2e harness (also root test/runtime/e2e.mjs)
│   └── dist/                    # ← loadable extension produced by npm run build:extension
├── pc-daemon/
│   ├── server.mjs               # zero-dependency local IDE/PC MCP daemon (HTTP 3001 + WS 8085 + stdio)
│   ├── smoke_test.mjs           # 135-check end-to-end daemon test (stateful shell, bg procs, git, desktop)
│   ├── legacy-bridge/           # copied gemini-browser-mcp server.js + cli.js
│   └── native-host/             # copied native logger host + cross-platform installer
├── orchestrator/                # pure ES-module orchestration core
│   ├── goal_state_machine.js    # Astra Goal Loop state machine, tags, directives
│   ├── compact_resume_engine.js # pruning, compaction prompt/summary, checkpoints, resume hydration
│   ├── subagent_router.js       # 4-role planner / PC-coder / browser-operator / verifier DAG router
│   └── smoke_test.mjs           # 42-check contract test
├── test/runtime/e2e.mjs         # end-to-end runtime test (daemon + 3-layer messaging + compact/resume)
└── scripts/                     # dev runner, daemon smoke test, packaged-extension verifier, acceptance gate
```

`extension/shared/orchestrator/` contains byte-identical copies of the three orchestrator
modules (`goal_state_machine.js`, `compact_resume_engine.js`, `subagent_router.js`) so the
MV3 service worker can import them through the extension's own module graph; the acceptance
gate fails if any mirror drifts.

## Quick start

Prerequisites: **Node.js ≥ 20**, **Chrome**, and a Chrome profile **signed in at
<https://gemini.google.com>** (this is the only "API key" Ncode needs).

```bash
cd Ncode
npm run install:all        # extension deps (vite, marked, katex, …) + pc-daemon (no deps)
npm run build              # alias of build:extension → vite build → package → loadable extension/dist
npm run start:daemon       # HTTP MCP 127.0.0.1:3001 + WS bridge 127.0.0.1:8085
```

Then:

1. Open `chrome://extensions` → enable **Developer mode** → **Load unpacked** →
   select `Ncode/extension/dist`.
2. Open or refresh <https://gemini.google.com> so the web session/provider is available
   (also open a normal tab you want Ncode to inspect/control).
3. Click the Ncode toolbar icon (or `Alt+G`) to open the side panel.
4. Type a task. The **Ncode Goal & PC Harness** bar at the top of the chat shows three
   live connection lights, refreshed every 3 seconds:
   - `Gemini Web (Connected)` — logged-in web-session provider status
   - `PC Shell MCP (Port 3001 Connected)` — local daemon status and discovered tool count
   - `WS Bridge (Port 8085 Connected)` — extension ↔ daemon WebSocket bridge (auto-reconnects)
   plus the live **Interim Preamble** ticker, the **Goal Loop** toggle (default **on**),
   a collapsible **Subgoal checklist** (click a row to toggle it), the **Compact & Resume**
   button, and an inline **Approve / Deny** strip when the tool-approval policy requires it.

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
npm run check                # complete acceptance gate (9/9 steps, fail-fast)
npm run test:orchestrator    # 42/42 orchestrator contract checks
npm run test:pc-daemon       # 135/135 real spawned-daemon checks
npm run test:e2e             # end-to-end runtime test (daemon + 3-layer messaging + compact/resume)
npm run smoke:daemon         # default-port smoke test (initialize/list/pc_system_info/WS)
npm run verify:extension     # 33/33 packaged-extension checks
```

Measured results in this build:

| Gate | Result |
| --- | --- |
| `npm run install:all` | exit 0 |
| `npm run build:extension` | Vite build succeeded; package prepared; `extension/dist` = **375 loadable files**, manifest Ncode v1.0.0 |
| `npm run verify:extension` | **All 33 packaged-extension checks passed** (identity vs source manifest, explicit loopback/Gemini host permissions, Gemini live-DOM bridge entry, every manifest-referenced file, css/ + vendor/ + assets/ packaged, no tests/node_modules) |
| `npm run test:orchestrator` | **All 42 checks passed** |
| `npm run test:pc-daemon` | **PASS: 135/135 checks** (stateful shell, background processes, IDE/git suite, real screenshot + clipboard) |
| `npm run test:e2e` | **52/52 e2e checks passed** (pc-daemon MCP over HTTP, stateful cwd, 3-layer sandbox↔sidepanel↔background forwarding for every Ncode action, approval round-trip, Compact & Resume cursor reset + checkpoint mirror) |
| `npm run check` | **All 9 acceptance checks passed** (file syntax scan, 3 orchestrator mirrors byte-identical, no placeholders, build, dist verify, orchestrator smoke, daemon smoke, e2e, root script contract) |
| `cd extension && npx vitest run` | **214 files / 1603 tests passed** |
| curl against `http://127.0.0.1:3001/mcp` | `initialize` → `ncode-pc-daemon` v1.0.0; `tools/list` → 21 tools; `tools/call pc_system_info` → `isError:false`, `platform: win32`, `node: v24.20.0` |
| `npm run dev` | daemon healthy on 3001 + Vite ready on 3000 |

Live browser acceptance was also exercised on this tree with a real Chromium build
(Chrome for Testing via `agent-browser --extension extension/dist`):

- `extension/dist` loads as an unpacked MV3 extension (manifest valid, including
  `ws://127.0.0.1/*` and the `content/gemini_dom_bridge.js` content script).
- The side panel renders the sandboxed chat UI and the three-light harness bar.
- With `pc-daemon` started afterwards, the bar flipped **PC Shell MCP (Port 3001 Connected)**
  and **WS Bridge (Port 8085 Connected)** live, without a page reload (3-second status poll
  across the sandbox → sidepanel → background chain; WS bridge auto-reconnect), while
  **Gemini Web** correctly stayed disconnected in the fresh profile with no signed-in tab.
- Screenshots: `artifacts/e2e/real-chrome-sidepanel-live.png`,
  `artifacts/e2e/real-chrome-sandbox.png` (regenerate with the same `agent-browser` flow).

## Security & operational notes

- Both daemon listeners bind loopback only (`127.0.0.1`); the WS bridge and MCP endpoint are
  unauthenticated loopback services. `pc_exec_shell` runs with the user's full privileges —
  run Ncode only on a machine you trust and do not expose the ports.
- Sensitive PC tools (shell, file writes/patches, git add/commit/checkout, clipboard, page
  script evaluation) can be gated by `ncodeApprovalPolicy` in `chrome.storage.local`:
  `auto` (default, no prompts), `ask` (risky tools prompt the harness bar), `always`, or
  `never` (risky tools are refused). Timeouts and closed panels deny rather than hang.
- `ask_gemini_web` over the bridge is intentionally single-shot (no stored session history,
  no tool loop) to avoid interleaving the shared reverse-engineered web auth context.
- Compact & Resume resets the persisted Gemini Web conversation cursor
  (`conversationId`/`responseId`/`choiceId` → `null`) so the next turn opens a **brand-new,
  clean `gemini.google.com` chat** pre-hydrated with the checkpoint summary, while the durable
  chat session id stays the same.
- The primary Gemini Web transport is the reverse-engineered `StreamGenerate` fetch. When it
  fails with an auth/401/403/session-expired/parser error, Ncode automatically falls back once
  to injecting the prompt into a live `gemini.google.com` tab DOM (`content/gemini_dom_bridge.js`)
  and streams the answer back into the same tool loop.
- The built-in local MCP server (`ncode-pc-daemon`, `http://127.0.0.1:3001/mcp`) is
  force-merged and enabled on startup and before every prompt; legacy `ncode_local_pc`
  settings entries are migrated by URL. The MCP manager reconnects automatically when the
  daemon starts after Chrome (no extension reload).
- MCP checkpoint mirroring is best-effort (the daemon may be offline); the
  `chrome.storage.local` checkpoint is authoritative and the compaction reports failure
  rather than claiming an unpersisted checkpoint is durable.
- The reverse-engineered `gemini.google.com` transport can drift when Google changes protocol
  parameters; `extension/scripts/gemini-web-drift-check.mjs` (upstream) is the canary.

## Known limitations

- Ncode relies on the user's Gemini Web account/model availability; no API fallback is used.
- Tool execution requires Chrome to stay open on the signed-in profile and the MV3 worker to
  stay alive (the harness arms stream heartbeats and keep-alive during long commands).
- The Gemini live-DOM fallback currently forwards prompt text only (image attachments stay on
  the primary transport); image-edit flows therefore require Mode A to be healthy.
- Chrome-branded builds ≥ 137 ignore `--load-extension`; use `chrome://extensions → Load
  unpacked` (or a Chrome for Testing/Chromium automation build) to load `extension/dist`.
