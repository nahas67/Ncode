# Ncode — Step-by-Step User Guide

Ncode is a **zero-API-key agentic IDE & browser/PC harness**. It drives an autonomous
coding/browsing agent from your already-logged-in `gemini.google.com` web session, giving
the model a real local PC (shell, filesystem, code search), full Chrome DOM control, an
Astra-style Goal Loop, and Compact & Resume session durability.

This guide walks you from a fresh machine to running your first autonomous task.

---

## 0. What you need

| Requirement | Notes |
|---|---|
| **Node.js ≥ 20** | Verified with v24.20.0 in this tree. Check: `node --version`. |
| **npm** | Comes with Node. |
| **Google Chrome** (or Chromium) | A Chrome profile **signed in at https://gemini.google.com** is the only "API key" Ncode needs. |
| **A trusted machine** | The PC daemon binds loopback only, but `pc_exec_shell` runs with your full privileges. |

> Chrome-branded builds ≥ 137 ignore `--load-extension`; use `chrome://extensions → Load unpacked` (or a Chrome for Testing/Chromium automation build) to load `extension/dist`.

---

## 1. Install dependencies

```bash
cd Ncode
npm run install:all
```

This installs extension deps (Vite, marked, katex, …) and the pc-daemon (no runtime deps).
Expected: exit 0.

---

## 2. Build the extension

```bash
npm run build            # alias of build:extension
```

Equivalent to:

```bash
npm --prefix extension run build
node extension/scripts/package-extension.mjs
node scripts/finalize-extension-dist.mjs
```

Result: `extension/dist/` contains **~375 loadable files**, manifest `Ncode v1.0.0`.
Verify it:

```bash
npm run verify:extension   # expect "All 33 packaged-extension checks passed"
```

---

## 3. Start the PC daemon

The daemon runs three transports at once: HTTP MCP (`:3001`), WebSocket bridge (`:8085`),
and (optional) stdio MCP.

```bash
npm run start:daemon      # HTTP 127.0.0.1:3001 + WS 127.0.0.1:8085
```

You should see diagnostics on **stderr** (stdout is JSON-RPC only). Sanity-check it:

```bash
npm run smoke:daemon      # default-port smoke test
```

Or with curl:

```bash
curl -s http://127.0.0.1:3001/mcp   # initialize → ncode-pc-daemon v1.0.0
```

> Endpoints: `GET /health`, `GET/DELETE /mcp`. Flags: `--stdio --http --no-http --ws --no-ws
> --http-port --ws-port --host --help`. Env: `NCODE_STATE_DIR`, `NCODE_HTTP_PORT`,
> `NCODE_WS_PORT`, `NCODE_HOST`, `NCODE_DEBUG`, `NCODE_WS_PING_MS`.

Leave this terminal running.

---

## 4. Load the extension into Chrome

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top-right toggle).
3. Click **Load unpacked**.
4. Select the folder `Ncode/extension/dist`.
5. Note the extension ID shown (you'll need it only for optional native logging).

---

## 5. Sign in to Gemini Web

1. Open (or refresh) **https://gemini.google.com** in a normal tab of the same Chrome profile.
2. Confirm you are logged in (the chat input is usable).
   - This is the *only* "API key" Ncode needs; the model runs against your web session.

Also open any normal tab you want Ncode to inspect/control (browser-control tools target the
active tab).

---

## 6. Open the Ncode side panel

- Click the **Ncode toolbar icon**, or press **`Alt+G`**.
- The sandboxed chat UI opens in the side panel.
- At the top of chat you'll see the **Ncode Goal & PC Harness** bar with three live
  connection lights, refreshed every 3 seconds:
  - `Gemini Web (Connected)` — logged-in web-session provider status
  - `PC Shell MCP (Port 3001 Connected)` — local daemon status + discovered tool count
  - `WS Bridge (Port 8085 Connected)` — extension ↔ daemon WebSocket (auto-reconnects)

If a light is red, start the daemon (Step 3) or sign in (Step 5); the bar re-polls
automatically (no reload needed for PC/WS).

---

## 7. Send your first task

1. Type a task in the chat input (e.g. "List the files in my current directory and tell me
   what this repo does.").
2. Press Send.
3. Watch the **Interim Preamble** ticker — Ncode emits a one-line real-time status before
   every tool call.
4. The **Subgoal checklist** (collapsible) populates as the Goal Loop breaks the task into
   subgoals; click a row to toggle it.
5. Tool calls run against:
   - **Chrome DOM** (`take_snapshot`, `click`, `fill`, `evaluate_script`, … with `chrome_*`
     aliases) for browser control.
   - **PC daemon** (`pc_exec_shell`, `pc_fs_read/write/patch`, `pc_search_code`,
     `pc_system_info`, workflow checkpoints) for local PC work.

The tool loop runs up to **30 steps per goal cycle** and continues autonomously until all
subgoals are verified done (or it hits the iteration cap of 30 and reports a truthful failure).

---

## 8. Key features

### 8.1 Goal Loop toggle
Default **on**. Disable per-run by sending with `ncodeGoalMode: false` (the toggle in the
harness bar). When on, the model is instructed to emit `<ncode_goal_update>` /
`<ncode_goal_complete>` tags and the loop drives to completion.

### 8.2 Compact & Resume
When cumulative conversation exceeds **120,000 chars**, Ncode automatically compacts:
prunes verbose tool outputs (except the last 2 turns), runs one compaction turn asking for
`completedSubgoals`, `modifiedFilesAndCommands`, `discoveredFactsAndErrors`,
`nextImmediateAction`, persists a checkpoint to **both** `chrome.storage.local` and the PC
daemon (`~/.ncode/workflows/<workflowId>.json`), then hydrates a fresh Gemini Web turn and
resumes. You can also trigger it manually with the **Compact & Resume** button.

### 8.3 Approval policy
Sensitive tools (shell, file writes/patches, git add/commit/checkout, clipboard, page script
evaluation) can be gated by `ncodeApprovalPolicy` in `chrome.storage.local`:
- `auto` (default) — no prompts
- `ask` — risky tools prompt an inline **Approve / Deny** strip in the harness bar
- `always` — prompt for all
- `never` — risky tools are refused

Timeouts and a closed side panel **deny** rather than hang.

To change it, open the extension's settings (or set it via the storage manager) and pick the
policy. See `extension/docs` and settings UI for the exact control.

### 8.4 MCP servers
The built-in `ncode-pc-daemon` (`http://127.0.0.1:3001/mcp`, 21 tools) is force-merged and
enabled on startup and before every prompt. The MCP manager reconnects automatically when
the daemon starts after Chrome (no extension reload). You can add other streamable-HTTP /
SSE MCP servers in Settings → Connections.

### 8.5 Daemon tools (quick reference)

| Tool | Purpose |
|---|---|
| `pc_exec_shell` | Run a command (Windows `cmd.exe` / macOS+Linux `/bin/sh`); captures stdout/stderr/exitCode, 32 KB head+tail truncation with full-log pointer, `timeoutMs` process-tree kill, detached `background` spawn returning `{pid, logPath}` |
| `pc_fs_read` | Read a file (1-based `startLine`/`endLine`, line numbers, binary detection) |
| `pc_fs_write` | Atomic write (temp file + rename), optional `createDirs` |
| `pc_fs_patch` | Surgical unique-string replace + unified diff (fails on 0 or >1 matches) |
| `pc_search_code` | Regex code search via `rg` (or pure-Node fallback); `fileGlob` support |
| `pc_system_info` | OS/arch/shell/cwd, Node/npm/Python/Git versions, managed bg processes, uptime |
| `workflow_save_checkpoint` / `load` / `list` | Durable checkpoints at `~/.ncode/workflows/` |
| `ask_gemini_web` | **stdio mode only**: relay a prompt over WS 8085 to the web provider (single-shot) |

Checkpoints and truncation logs live under `~/.ncode/` (override with `NCODE_STATE_DIR`).

### 8.6 Browser control
Internal Chrome tools: `take_snapshot`, `click`, `fill`, `evaluate_script`, … with `chrome_*`
aliases. These operate on the active tab. Keep Chrome open on the signed-in profile and the
MV3 worker alive (the harness arms stream heartbeats + keep-alive during long commands).

---

## 9. Development mode

Run Vite watcher + daemon together:

```bash
npm run dev
```

Daemon healthy on 3001 + Vite ready on 3000. Rebuild the extension after source changes, then
reload the unpacked extension in `chrome://extensions`.

---

## 10. Verification (all runnable from `Ncode/`)

```bash
npm run check                # full acceptance gate (9 steps, fail-fast)
npm run test:orchestrator    # 42/42 orchestrator contract checks
npm run test:pc-daemon       # 135/135 real spawned-daemon checks
npm run test:e2e             # end-to-end runtime test
npm run smoke:daemon         # default-port smoke test
npm run verify:extension     # 33/33 packaged-extension checks
cd extension && npx vitest run   # 214 files / 1603 tests
```

---

## 11. Troubleshooting

| Symptom | Fix |
|---|---|
| `Gemini Web` light stays red | Sign in at https://gemini.google.com in the same Chrome profile; refresh the tab. |
| `PC Shell MCP` light stays red | Start the daemon: `npm run start:daemon`. It auto-reconnects without reload. |
| `WS Bridge` light stays red | Daemon's WS server not running; check port 8085 not in use; restart daemon. |
| Extension won't load (`--load-extension` ignored) | Chrome ≥ 137: use `chrome://extensions → Load unpacked` → `extension/dist`. |
| Task hangs / no output | Check approval policy isn't `ask` with a closed panel (denies); check daemon logs on stderr. |
| Compaction reports failure | Daemon may be offline; `chrome.storage.local` checkpoint is authoritative; retry when daemon is up. |
| Port already in use | Override with `NCODE_HTTP_PORT` / `NCODE_WS_PORT` or kill the stale process. |

---

## 12. Security & operational notes

- Both daemon listeners bind **loopback only** (`127.0.0.1`); WS bridge and MCP endpoint are
  unauthenticated loopback services.
- `pc_exec_shell` runs with your **full privileges** — run only on a machine you trust; do
  not expose the ports.
- `ask_gemini_web` over the bridge is intentionally single-shot (no stored session history,
  no tool loop) to avoid interleaving the shared reverse-engineered web auth context.
- Compact & Resume resets the persisted Gemini Web conversation cursor
  (`conversationId`/`responseId`/`choiceId` → `null`) so the next turn opens a brand-new,
  clean chat pre-hydrated with the checkpoint summary, while the durable chat session id
  stays the same.
- The primary Gemini Web transport is the reverse-engineered `StreamGenerate` fetch; on
  auth/401/403/session-expired/parser errors it falls back once to injecting the prompt into
  a live `gemini.google.com` tab DOM (`content/gemini_dom_bridge.js`).
- The reverse-engineered transport can drift when Google changes protocol parameters;
  `extension/scripts/gemini-web-drift-check.mjs` is the canary.

---

## 13. Optional: native logging host

```bash
node pc-daemon/native-host/install-native-logger.mjs --extension-id <your-extension-id>
```

Supports Windows/macOS/Linux Chrome NativeMessagingHosts directories. Resolves `host.js`
beside itself.

---

### Quick start (TL;DR)

```bash
cd Ncode
npm run install:all
npm run build
npm run start:daemon        # keep running
# Chrome: chrome://extensions → Developer mode → Load unpacked → Ncode/extension/dist
# Open https://gemini.google.com (signed in), then open side panel (Alt+G) and type a task.
```

That's it — you're running Ncode. 🎉