# ncode-pc-daemon

Unified local PC & shell MCP daemon for Ncode — a single zero-dependency Node.js
process (Node built-ins only) that exposes:

| Transport | Default address | Purpose |
| --- | --- | --- |
| Streamable HTTP MCP | `http://127.0.0.1:3001/mcp` | Primary MCP transport for the Ncode extension / agents |
| WebSocket bridge | `ws://127.0.0.1:8085` | Browser-extension relay (`ask_gemini_web`, legacy `gemini-browser-mcp` compatibility, liveness pings) |
| stdio MCP (`--stdio`) | stdin/stdout | Newline-delimited JSON-RPC MCP for local CLI hosts |

The daemon owns the complete local IDE & PC harness:

* **Stateful shell** — `pc_exec_shell` sessions keyed by `workflowId` remember cwd,
  environment variables and the `pushd` stack; `cd`/`pushd`/`popd`/`export`/`set`/
  `unset`/`pwd` are executed against the session without spawning a shell. Also
  `pc_shell_session` (`info`/`reset`/`list`) and `pc_bg_process` for detached,
  registry-backed background processes.
* **Filesystem & search** — `pc_fs_read`, `pc_fs_write`, `pc_fs_patch`,
  gitignore-aware `pc_fs_tree` and regex `pc_search_code` (context lines,
  case-insensitive, bounded results).
* **Git suite** — `pc_git_status`, `pc_git_diff`, `pc_git_status_diff`,
  `pc_git_add`, `pc_git_commit`, `pc_git_checkout`, `pc_git_log`; every command is
  a `spawnSync` argv array, never an interpolated shell string.
* **Desktop computer-use** — `pc_desktop_screenshot` and `pc_clipboard` through
  OS-native CLIs, with clear degradation errors on headless machines.
* **Durability** — `workflow_*` checkpoints, shell sessions and the background
  process registry are persisted under the state directory and survive restarts.
* **Browser relay** — `ask_gemini_web` (stdio mode) plus legacy
  `gemini-browser-mcp` compatibility over the WebSocket bridge.

It has **no runtime npm dependencies**, never writes non-JSON-RPC text to stdout,
and all logging goes to stderr through a `[ncode-pc-daemon] [level] ...` prefixed
logger.

## Quick start

```bash
# Default: HTTP MCP on 3001 + WebSocket bridge on 8085
node server.mjs

# stdio MCP + WebSocket bridge (no HTTP listener)
node server.mjs --stdio

# stdio MCP + HTTP MCP + WebSocket bridge
node server.mjs --stdio --http

npm start        # node server.mjs
npm run stdio    # node server.mjs --stdio
npm run smoke    # node smoke_test.mjs
```

On startup a single machine-readable banner is printed to stderr:

```
[ncode-pc-daemon] http=http://127.0.0.1:3001/mcp ws=ws://127.0.0.1:8085 stdio=false
```

Disabled listeners are reported as `http=off` / `ws=off`, and `stdio=true|false`
matches the CLI. Ports passed as `0` are ephemeral; the banner always reports the
actual bound ports.

## CLI

| Flag | Meaning |
| --- | --- |
| *(none)* | HTTP MCP (`/mcp`) + WebSocket bridge |
| `--stdio` | stdio MCP transport + WebSocket bridge; HTTP stays **off** unless `--http` is also given |
| `--http` | Force the HTTP listener on (also with `--stdio`) |
| `--no-http` | Disable the HTTP listener |
| `--ws` | Force the WebSocket bridge on (default in every mode) |
| `--no-ws` | Disable the WebSocket bridge |
| `--http-port <port>` | HTTP MCP port (default `3001`, `0` = ephemeral) |
| `--ws-port <port>` | WebSocket bridge port (default `8085`, `0` = ephemeral) |
| `--host <host>` | Bind host (default `127.0.0.1`) |
| `-h`, `--help` | Usage on stderr |

`--http`/`--no-http` and `--ws`/`--no-ws` are last-one-wins. Env fallbacks:
`NCODE_HTTP_PORT`, `NCODE_WS_PORT`, `NCODE_HOST`, `NCODE_STATE_DIR`.

Exit codes: `0` graceful shutdown, `1` fatal startup error, `2` bad CLI usage.

## HTTP endpoints

All responses are JSON, CORS-friendly (`Access-Control-Allow-Origin: *`,
`Access-Control-Allow-Headers` covers `Content-Type`, `Accept`,
`MCP-Protocol-Version`, `MCP-Session-Id`, `Last-Event-ID`, `Authorization`), and
`OPTIONS` preflight is answered with `204`. The server is **stateless**: it never
emits an `MCP-Session-Id` header, which keeps restarts and reconnects safe.

| Method + path | Behaviour |
| --- | --- |
| `POST /mcp` | JSON-RPC 2.0 request(s). Single message or batch array. Notifications (no `id`) get `202` with no body. |
| `GET /mcp` | `405` with a JSON-RPC error body (`Allow: POST, DELETE, OPTIONS`). No GET SSE stream. |
| `DELETE /mcp` | `200 {}` (stateless — there is no session to terminate). |
| `GET /health` | `{ok:true, name, version, uptimeMs, tools:<count>}` |
| `GET /` | Small JSON description + endpoint list. |
| `OPTIONS *` | `204` CORS preflight. |
| `GET /health` on the WS port | Same health payload plus `ws:{clients, extensionConnected}`. |

### MCP methods

`initialize`, `notifications/initialized`, `ping`, `tools/list`, `tools/call`
(plus `logging/setLevel` as a no-op because `logging` capability is advertised).

* `initialize` echoes the requested protocol version when supported
  (`2025-11-25`, `2025-06-18`, `2025-03-26`, `2024-11-05`, `2024-10-07`,
  `2024-06-20`), otherwise answers `2025-03-26`. Capabilities:
  `{tools:{listChanged:false}, logging:{}}`. `serverInfo`:
  `{name:"ncode-pc-daemon", version:"1.0.0"}` plus a long `instructions` string
  describing the harness and workflow durability rules.
* `tools/call` **never** fails at the transport layer for tool-level problems:
  every tool error is returned as `{"content":[{"type":"text","text":"Error: ..."}],"isError":true}`.
* Malformed JSON → `-32700`, invalid request envelope → `-32600`,
  unknown method → `-32601`, internal crash → `-32603`.

### curl examples

```bash
curl -s http://127.0.0.1:3001/health

curl -s -X POST http://127.0.0.1:3001/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"curl","version":"1.0.0"}}}'

curl -s -X POST http://127.0.0.1:3001/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'

curl -s -X POST http://127.0.0.1:3001/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"pc_system_info","arguments":{}}}'
```

## stdio transport

`--stdio` reads one JSON-RPC message per line from stdin and writes one JSON-RPC
response per line to stdout. Requests without `id` are notifications and produce
no output. The entire stdout channel is reserved for JSON-RPC; nothing else is
ever written there (logs go to stderr). When stdin closes (MCP host disconnected)
the daemon shuts down gracefully with exit code `0`.

## Tools

`pc_*` tools are always listed (21 of them). `ask_gemini_web` is listed only in
stdio mode (`--stdio`); over HTTP it is reported as an unknown tool.

| Group | Tools |
| --- | --- |
| Shell | `pc_exec_shell`, `pc_shell_session`, `pc_bg_process` |
| Filesystem | `pc_fs_read`, `pc_fs_write`, `pc_fs_patch`, `pc_fs_tree` |
| Search | `pc_search_code` |
| Git | `pc_git_status`, `pc_git_diff`, `pc_git_status_diff`, `pc_git_add`, `pc_git_commit`, `pc_git_checkout`, `pc_git_log` |
| Desktop | `pc_desktop_screenshot`, `pc_clipboard` |
| System | `pc_system_info` |
| Workflow | `workflow_save_checkpoint`, `workflow_load_checkpoint`, `workflow_list_checkpoints` |
| Browser (stdio only) | `ask_gemini_web` |

### `pc_exec_shell`

Run a command in the user's shell: `cmd.exe /d /s /c` on Windows, `/bin/sh -lc`
on macOS/Linux.

* `command` (required, non-empty string)
* `workflowId` optional. When present the call runs in a **stateful session**:
  cwd, environment variables and the `pushd` stack persist across calls and
  daemon restarts (`<stateDir>/shell-sessions.json`).
* `cwd` optional (supports `~`). Without `workflowId` it defaults to the user
  home directory; with `workflowId` it becomes the persistent session cwd. A
  nonexistent or non-directory cwd is a clear tool error.
* `env` optional object of environment overrides. With `workflowId` the values
  are merged into the persistent session env (`null` removes a variable);
  without it they only apply to this call.
* `timeoutMs` optional, default `120000`, clamped to max `600000`
* `background` optional boolean (default `false`) — registers the command in the
  `pc_bg_process` registry and returns `{id, pid, logPath, started:true}`.

**Shell builtins are intercepted without spawning.** `cd`, `chdir`, `pushd`,
`popd`, `export`, `set`, `unset` and `pwd` are evaluated against the session
state, so `cd src` sticks for the next call. Leading builtins before a real
command are applied first (`cd src && npm test` runs `npm test` in `src`), and
`pwd` prints the session cwd. Quotes, `~`, `$VAR`/`%VAR%` references in builtin
arguments are expanded. When no `workflowId` is given the same interception
happens against an ephemeral session, so stateless calls keep behaving exactly
like one-shot shell invocations. Intercepted calls return
`{intercepted:true, spawn:false, builtins:[...], sessionCwd, session}` and do not
write a log file.

Foreground result:

```json
{
  "command": "node --version",
  "cwd": "C:\\Users\\user",
  "exitCode": 0,
  "signal": null,
  "timedOut": false,
  "durationMs": 84,
  "stdout": "v24.20.0\r\n",
  "stderr": "",
  "stdoutTruncated": false,
  "stderrTruncated": false,
  "logPath": "C:\\Users\\user\\.ncode\\logs\\exec_2026-10-29T11-30-00-000Z_ab12cd34.log",
  "bytes": { "stdout": 10, "stderr": 0 },
  "workflowId": "add-auth",
  "sessionCwd": "C:\\Users\\user\\projects\\app",
  "executedCommand": "npm test",
  "intercepted": false,
  "spawn": true,
  "builtins": ["cd"]
}
```

* Each stream is captured up to **32 KB** (16 KB head + 16 KB tail). When
  truncated, the middle is replaced with
  `[truncated: full log at <logPath>]` and the complete output is always written
  to `<stateDir>/logs/<id>.log`.
* On timeout the **entire process tree** is killed (`taskkill /pid <pid> /T /F`
  on Windows, process-group `SIGKILL` on POSIX) and `timedOut:true` is reported.
* `background:true` spawns detached, redirects stdout+stderr to a log file and
  returns `{id, pid, logPath, started:true, command, cwd, detached:true}`.
  Background children intentionally survive daemon exit and are managed through
  `pc_bg_process`.

### `pc_shell_session`

`{action: "info"|"reset"|"list", workflowId?}` — inspect the stateful shells used
by `pc_exec_shell`.

* `info` → `{workflowId, cwd, previousCwd, pushdStack, env, envCount, calls,
  createdAt, updatedAt, backgroundProcesses}`. Creates (and persists) the session
  when it does not exist yet (`created:true`).
* `reset` → deletes the session and returns it to the default state
  (`cwd = home`, empty env, empty stack).
* `list` → all sessions with `{workflowId, cwd, envCount, pushdDepth, calls,
  updatedAt}` plus `sessionsPath`.

Session env is bounded (256 variables / 256 KB) and session ids are restricted to
`[A-Za-z0-9._-]` so the persisted file can never escape the state directory.

### `pc_bg_process`

`{action: "start"|"status"|"logs"|"kill"|"list"}` — manage detached background
processes (dev servers, watchers, long builds).

* `start` — `{command, cwd?, workflowId?, name?, env?}`. With `workflowId` and no
  `cwd` the background process inherits the session cwd and env. Returns
  `{id, pid, logPath, started:true, detached:true, ...status fields}`. stdout +
  stderr are appended to `<stateDir>/logs/<id>.log`; the registry is persisted to
  `<stateDir>/bg-processes.json`, so `status`/`logs`/`kill` keep working after a
  daemon restart. On Windows the log-owning launcher is the generated
  `<stateDir>/bg-runner.mjs` (a detached Node process), which is what makes
  detached logging reliable for shell grandchildren there.
* `status` — `{id}` → `{pid, running, exitCode, signal, startedAt, endedAt,
  uptimeMs, logBytes, logPath, command, cwd, workflowId, name}`.
* `logs` — `{id, tailBytes?, offset?}` → bounded tail (`tailBytes` 1–65536,
  default 65536) plus `{text, bytes, totalBytes, offset, truncated, logPath,
  running}`. `offset` reads from an absolute byte offset instead of the tail.
* `kill` — `{id, signal?}` (`SIGTERM` default, `SIGINT`, `SIGKILL`) kills the
  whole process tree, escalates to `SIGKILL` if the tree survives, waits up to
  3 s and returns the updated record. Windows always force-kills the tree.
* `list` — `{workflowId?}` → `{count, running, processes, registryPath}`.

### `pc_fs_read`

`{filePath (required), startLine?, endLine?}` — 1-based inclusive line range,
line-numbered output (`12| const x = 1;`). Caps: 2000 lines / 256 KB per read,
64 MB file limit, binary files (NUL byte) rejected. `~` is expanded.

```json
{
  "filePath": "C:\\work\\src\\index.js",
  "totalLines": 40,
  "startLine": 10,
  "endLine": 12,
  "requestedEndLine": 12,
  "lines": 3,
  "truncated": false,
  "bytes": 912,
  "content": "10| import fs from 'node:fs';\n11| \n12| export default fs;"
}
```

### `pc_fs_write`

`{filePath, content, createDirs? (default true)}` — atomic write (temp file in
the same directory + rename), refuses directory targets, creates parent
directories by default. Returns `{filePath, bytes, created}`.

```json
{ "filePath": "C:\\work\\notes.md", "bytes": 42, "created": true }
```

### `pc_fs_patch`

`{filePath, searchBlock, replaceBlock}` — exact literal replacement that
requires **exactly one** occurrence. `searchBlock` must be non-empty. 0 matches
→ error telling you to copy the exact text; 2+ matches → error with the
occurrence count and a request for more unique context. Writes atomically and
returns a unified diff (3 context lines, `---`/`+++`/`@@` headers) plus
`{occurrences:1, bytes, changed, matchAtOffset}`.

```json
{
  "filePath": "C:\\work\\src\\index.js",
  "occurrences": 1,
  "bytes": 930,
  "changed": true,
  "matchAtOffset": 214,
  "diff": "--- a/C:/work/src/index.js\n+++ b/C:/work/src/index.js\n@@ -10,5 +10,5 @@\n const a = 1;\n-const b = 2;\n+const b = 3;\n \n export { a, b };"
}
```

### `pc_fs_tree`

`{directory, depth? (0-12, default 4), respectGitignore? (default true), maxEntries? (1-20000, default 2000)}`
— fast nested directory tree for IDE context.

* `.gitignore` files are honoured (including `.gitignore` files in parent
  directories of the requested root, nested `.gitignore` files, negation `!`,
  `**`, `*`, `?`, character classes, anchored and directory-only patterns).
  `.git` is always skipped; symlinks are reported but never followed.
* Every file node carries its size in bytes; directories carry `children`.
* Returns `{directory, gitRoot, depth, respectGitignore, maxEntries, totalNodes,
  directories, files, symlinks, ignored, truncated, durationMs, tree, flatFiles}`
  where `flatFiles` is a bounded list of repo-relative POSIX paths.
* Depth and total-entry caps keep responses bounded; `truncated` is set when the
  entry cap was hit.


### `pc_search_code`

`{directory (required), pattern (required JS regex), fileGlob?, caseInsensitive? (default false), contextLines? (0-10, default 0), maxResults? (1-200, default 200)}`

Uses `rg` when `rg --version` succeeds
(`--line-number --with-filename --no-messages --color never --max-count <maxResults>`,
plus `--ignore-case`), otherwise a pure-Node recursive walker (needed on machines
without ripgrep). The fallback skips `node_modules`, `.git`, `dist`, `artifacts`,
`build`, ignores files over 2 MB and binary files, honours `fileGlob`
(`**`, `*`, `?`, `{a,b}`), caps at `maxResults` matches and 30 s. `contextLines`
adds a `context: [{line, text, isMatch}]` window around every match (both engines,
built from a bounded per-file read cache).

```json
{
  "matches": [
    {
      "file": "C:\\work\\src\\index.js",
      "line": 12,
      "text": "export default fs;",
      "context": [
        { "line": 10, "text": "import fs from 'node:fs';", "isMatch": false },
        { "line": 11, "text": "", "isMatch": false },
        { "line": 12, "text": "export default fs;", "isMatch": true }
      ]
    }
  ],
  "count": 1,
  "engine": "node",
  "truncated": false,
  "timedOut": false,
  "scannedFiles": 27,
  "skippedFiles": 3,
  "directory": "C:\\work\\src",
  "pattern": "export default",
  "fileGlob": "*.js",
  "contextLines": 2,
  "caseInsensitive": false,
  "maxResults": 200,
  "durationMs": 14
}
```

### Git suite

All git tools take a `directory` (repository root or a subdirectory of it),
resolve the repository with `git rev-parse --show-toplevel`, and fail with
`Not a git repository: ...` when the path is not inside a repository. Commands
are always spawned as **argv arrays** (`spawnSync('git', [...])`) — paths,
messages and branch names are never interpolated into a shell string.

* **`pc_git_status`** `{directory}` → `{directory, root, branch, detached,
  noCommits, upstream, ahead, behind, clean, counts:{changes, staged, unstaged,
  untracked}, changes:[{code, indexStatus, worktreeStatus, path, originalPath}],
  truncated, porcelain}`.
* **`pc_git_diff`** `{directory, staged?, path?, contextLines?}` → `{directory,
  root, staged, contextLines, path, diff, truncated, totalChars, filesChanged,
  stat}`. Diffs are capped at 200 KB (`truncated:true` beyond that).
* **`pc_git_status_diff`** `{directory, maxCommits? (default 10)}` → the composite
  `{status, diff:{unstaged, staged, stat, stagedStat, filesChanged, truncated},
  commits:[...], commitCount, branch, clean, directory, root}` — one call for a
  Coder Agent's status/diff/history context.
* **`pc_git_add`** `{directory, paths: string[]}` → `{added, status}`. Paths that
  start with `-` or resolve outside the repository root are rejected.
* **`pc_git_commit`** `{directory, message, all?}` → `{committed:true, hash,
  shortHash, subject, all, output, status}`. `all:true` maps to `git commit -a`.
* **`pc_git_checkout`** `{directory, branch, create?}` → `{branch, created,
  output}`; `create:true` maps to `git checkout -b`.
* **`pc_git_log`** `{directory, maxCount? (default 20)}` → `{count, commits:
  [{hash, shortHash, author, authorEmail, date, subject}]}`. Empty repositories
  return an empty list instead of an error.

### `pc_desktop_screenshot`

`{format?: "png", savePath?}` — capture the desktop and return
`{filePath, base64, width, height, bytes, mimeType, format, captureTool,
capturedAt, platform}`.

* Windows: PowerShell `System.Windows.Forms` `CopyFromScreen` over the virtual
  screen (multi-monitor), saved as PNG.
* macOS: `screencapture -x -t png <path>`.
* Linux: `grim` (Wayland), then `gnome-screenshot`, then ImageMagick `import`,
  then `scrot`.
* `savePath` defaults to `<stateDir>/screenshots/screenshot_<timestamp>.png`;
  parent directories are created. PNG dimensions are read from the PNG header.
* When no desktop is reachable (headless session, missing CLI, capture failure)
  the tool fails with an explicit error describing the platform facility that
  failed and the usual headless cause.

### `pc_clipboard`

`{action: "read"|"write", text?}` — text clipboard access through OS-native
tooling: Windows PowerShell `Get-Clipboard`/`Set-Clipboard` (UTF-8-safe base64
transport, empty string clears the clipboard), macOS `pbpaste`/`pbcopy`, Linux
`wl-paste`/`wl-copy` with `xclip` and `xsel` fallbacks.

* `read` → `{action:"read", text, chars, bytes, empty, tool, platform}`
* `write` → `{action:"write", ok:true, chars, bytes, tool, platform}`
* Headless/missing-CLI environments produce a clear error naming the attempted
  backends.

### `pc_system_info`

No arguments. Returns platform, release, arch, shell, cwd, homedir, `node`
version, `npm`/`python`/`git` versions (one short spawn each, `null` on failure),
`stateDir`, `logsDir`, checkpoint count (`workflows`), `shellSessions`
(`{count, sessions:[...]}` summaries), managed `backgroundProcesses`
(`[{id, pid, command, logPath, startedAt, alive, workflowId?, name?}]`, dead
entries flagged `alive:false`), `toolCount`, daemon `uptimeMs` and `pid`.

### `workflow_save_checkpoint`

`{workflowId, checkpoint (object), pretty? (default false)}` — atomically writes
`<stateDir>/workflows/<workflowId>.json` as `{savedAt, checkpoint}`. `workflowId`
is sanitized to `[A-Za-z0-9._-]` (path separators and `.`/`..` are rejected) and
capped at 128 chars. Returns `{workflowId, path, bytes, savedAt}`.

```json
{
  "workflowId": "add-auth",
  "path": "C:\\Users\\user\\.ncode\\workflows\\add-auth.json",
  "bytes": 188,
  "savedAt": "2026-10-29T11:31:02.123Z"
}
```

### `workflow_load_checkpoint`

`{workflowId}` — reads and parses the checkpoint. Missing file or corrupt JSON
produce clear tool errors. Returns `{workflowId, checkpoint, savedAt, path}`.
Call this after a daemon restart / context reset to resume exactly where the
workflow stopped.

### `workflow_list_checkpoints`

No arguments. Lists `*.json` checkpoints with
`{workflowId, savedAt, bytes, path}` (sorted newest first, `corrupt:true` for
unparseable files) plus `{count, directory}`. Used for harness status output.

### `ask_gemini_web` (stdio mode only)

`{prompt (required), timeoutMs? (default 120000, max 600000)}` — relays a prompt
through the WebSocket bridge to the registered Ncode browser extension and
returns the Gemini web response text. If no registered extension is connected it
waits until the timeout and then fails with a clear error explaining how to load
the extension. Result: `{text, requestId, chars, durationMs, timeoutMs}`.

## WebSocket bridge protocol

The daemon implements RFC 6455 itself (SHA-1 handshake via `crypto`, frame
codec, text/ping/pong/close, no fragmentation, masked client frames required,
1 MB inbound message bound). Multiple clients are supported; only clients
registered as the extension receive asks and liveness pings.

### Ncode native protocol (fixed)

1. Extension connects to `ws://127.0.0.1:8085`.
2. Extension → daemon:
   `{"type":"register","role":"extension","client":"ncode-extension","version":"1.0.0"}`
3. Daemon → extension:
   `{"type":"registered","ok":true,"server":"ncode-pc-daemon"}`
4. Daemon → extension every 20 s: `{"type":"ping","ts":1729...}`
   Extension replies `{"type":"pong","ts":1729...}`. A single missed pong does
   not drop the client; a client is dropped after **3 missed pongs**
   (≈60 s without any pong). WS-level ping frames are answered with pong frames.
5. Daemon → extension ask:
   `{"type":"ask_gemini_web","id":"<random>","prompt":"...","timeoutMs":120000}`
6. Extension → daemon:
   `{"type":"ask_gemini_web_result","id":"<same>","ok":true,"text":"..."}`
   or `{"type":"ask_gemini_web_result","id":"<same>","ok":false,"error":"..."}`

The daemon also answers `GET /health` on the WS port (outside the upgrade) and
sends a close frame (1001) to every client on shutdown.

### Legacy `gemini-browser-mcp` adapter

The adapter (`normalizeWsMessage` in `server.mjs`) translates the legacy
protocol from `legacy-bridge/server.js` and the gemini-browser-mcp extension:

| Legacy shape | Translation |
| --- | --- |
| `{action:"identify", role:"extension"}` | register as legacy extension |
| `{action:"ping"}` | liveness pong |
| `{action:"ask", prompt, requestId}` (to daemon) | relayed to the extension; answer `{text, requestId}` |
| `{text, requestId}` or `{action:"response", text, requestId}` (from extension) | ask result |
| `{type:"register", role, client, version}` | register (name containing `gemini-browser` → legacy protocol) |
| `{type:"query", prompt, requestId}` | relayed ask |
| `{type:"response", text, requestId}` | ask result |

Asks sent to a legacy extension use `{action:"ask", requestId, prompt, timeoutMs}`
so an unmodified gemini-browser-mcp extension keeps working. An unidentified
client that sends a response shape is treated as the legacy extension (just like
the old bridge, which assumed the first connection was the extension).

## Env vars

| Variable | Default | Meaning |
| --- | --- | --- |
| `NCODE_HTTP_PORT` | `3001` | HTTP MCP port |
| `NCODE_WS_PORT` | `8085` | WebSocket bridge port |
| `NCODE_HOST` | `127.0.0.1` | Bind host for both listeners |
| `NCODE_STATE_DIR` | `~/.ncode` | State root (`logs/`, `workflows/`, shell session + background registries, `screenshots/`) |
| `NCODE_DEBUG` | unset | `1`/`true` enables debug logs on stderr |
| `NCODE_WS_PING_MS` | `20000` | Advanced/testing override for the ping interval |

## State layout

```
<stateDir>/
  logs/                          foreground output and background process logs (<id>.log)
  workflows/<workflowId>.json    durable checkpoints: {savedAt, checkpoint}
  shell-sessions.json            stateful shell sessions: {savedAt, sessions:{<workflowId>:{cwd, env, pushdStack, ...}}}
  bg-processes.json              managed background process registry: {savedAt, processes:[...]}
  bg-runner.mjs                  generated Windows detached-log launcher (regenerated when outdated)
  screenshots/                   default pc_desktop_screenshot destination
```

`<stateDir>` defaults to `~/.ncode` (override with `NCODE_STATE_DIR`). All state
files are written atomically (same-directory temp file + rename). Log files for
foreground commands are always written, even when the returned text was not
truncated. Shell sessions are saved on every mutation; the background registry is
saved on start/exit/kill and refreshed by a 60 s sweep, so `pc_bg_process
status|logs|kill` and `pc_shell_session info` keep working after the daemon
restarts. Detached background processes themselves keep running across daemon
exit by design.

## Diagnostics & smoke test

```bash
node --check server.mjs
node smoke_test.mjs     # npm run smoke
```

`smoke_test.mjs` starts real daemon instances on ephemeral ports and asserts:
initialize serverInfo/instructions, tools/list contents for both HTTP and stdio,
`tools/call pc_system_info`, checkpoint save/load round-trip, fs
write/read/patch/tree (gitignore, depth, sizes), shell echo + long-output
truncation + timeout, stateful shell sessions over HTTP and stdio (`cd`, `pwd`,
`export`, `set`/`unset`, `pushd`/`popd`, `env` param, stateless isolation,
`pc_shell_session info|list|reset`), `pc_bg_process`
start/status/logs/list/kill plus registry + session persistence across a daemon
restart, `pc_search_code` context/case/maxResults, the full `pc_git_*` suite in a
throwaway repository (including non-repository and path-traversal errors),
`pc_clipboard` round-trip and `pc_desktop_screenshot` (both reported as `SKIP`
with a reason when the OS facility is genuinely unavailable), HTTP protocol
errors (batch, `-32700`/`-32600`/`-32601`, `GET /mcp` 405, `DELETE /mcp` 200),
CORS headers, WS register + ping/pong + legacy relay, stdio `ask_gemini_web`
round-trip with a fake extension, stdout JSON purity and graceful shutdown. It
prints `PASS`/`FAIL`/`SKIP` per check and exits `0`/`1`.

## Security notes

* The daemon binds to loopback (`127.0.0.1`) by default and has **no
  authentication**. Anyone who can reach the port can execute shell commands as
  the current user and read/write files. Do not bind `0.0.0.0` or expose the
  port to a network/container you do not trust.
* `pc_exec_shell` runs with full user privileges and no sandbox. Background
  children are detached and survive daemon exit by design; the daemon never
  kills processes it did not start, but timeouts do kill the whole tree of the
  foreground command it started, and `pc_bg_process kill` kills the tree of a
  managed process (including its children).
* `NCODE_STATE_DIR` / `~/.ncode` may contain command output, shell environment
  variables (which can include secrets), background process logs and workflow
  checkpoints. Treat it as user-private data.
* The WebSocket bridge accepts a 1 MB max message and drops clients after three
  missed pongs; the HTTP MCP body limit is 16 MB.
* `workflowId` is restricted to `[A-Za-z0-9._-]` so checkpoint paths cannot
  escape `<stateDir>/workflows`; the same sanitization protects
  `shell-sessions.json` keys.
* `pc_fs_patch` refuses non-unique matches, preventing accidental mass
  replacements; always inspect the returned diff.
* Git tools only run argv arrays and `pc_git_add` rejects paths (and
  `pc_git_checkout` rejects branch names) that resolve outside the repository or
  start with `-`. Nothing is ever passed through a shell.
* `pc_desktop_screenshot` and `pc_clipboard` read the user's screen and clipboard;
  screenshots default to `<stateDir>/screenshots` and base64 contents are
  returned to the MCP client. Treat both as sensitive user data and keep the
  daemon bound to loopback.
