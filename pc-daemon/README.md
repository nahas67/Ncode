# ncode-pc-daemon

Unified local PC & shell MCP daemon for Ncode — a single zero-dependency Node.js
process (Node built-ins only) that exposes:

| Transport | Default address | Purpose |
| --- | --- | --- |
| Streamable HTTP MCP | `http://127.0.0.1:3001/mcp` | Primary MCP transport for the Ncode extension / agents |
| WebSocket bridge | `ws://127.0.0.1:8085` | Browser-extension relay (`ask_gemini_web`, legacy `gemini-browser-mcp` compatibility, liveness pings) |
| stdio MCP (`--stdio`) | stdin/stdout | Newline-delimited JSON-RPC MCP for local CLI hosts |

The daemon owns the PC harness tools (`pc_*`), durable workflow checkpoints and the
browser-extension relay. It has **no runtime npm dependencies**, never writes
non-JSON-RPC text to stdout, and all logging goes to stderr through a
`[ncode-pc-daemon] [level] ...` prefixed logger.

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

`pc_*` tools are always listed. `ask_gemini_web` is listed only in stdio mode
(`--stdio`); over HTTP it is reported as an unknown tool.

### `pc_exec_shell`

Run a command in the user's shell: `cmd.exe /d /s /c` on Windows, `/bin/sh -lc`
on macOS/Linux.

* `command` (required, non-empty string)
* `cwd` optional (supports `~`; defaults to the user home directory; nonexistent
  or non-directory cwd is a clear tool error)
* `timeoutMs` optional, default `120000`, clamped to max `600000`
* `background` optional boolean (default `false`)

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
  "bytes": { "stdout": 10, "stderr": 0 }
}
```

* Each stream is captured up to **32 KB** (16 KB head + 16 KB tail). When
  truncated, the middle is replaced with
  `[truncated: full log at <logPath>]` and the complete output is always written
  to `<stateDir>/logs/<id>.log`.
* On timeout the **entire process tree** is killed (`taskkill /pid <pid> /T /F`
  on Windows, process-group `SIGKILL` on POSIX) and `timedOut:true` is reported.
* `background:true` spawns detached (`cmd.exe /d /s /c` / `/bin/sh -lc`,
  `detached:true`), redirects stdout+stderr to a log file, and returns
  `{id, pid, logPath, started:true, command, cwd, detached:true}`. Background
  children intentionally survive daemon exit and stay in the managed registry
  (visible in `pc_system_info`).

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

### `pc_search_code`

`{directory (required), pattern (required JS regex), fileGlob? (e.g. *.js, **/*.ts, src/**/*.{js,ts})}`

Uses `rg` when `rg --version` succeeds
(`--line-number --with-filename --no-messages --color never --max-count 200`),
otherwise a pure-Node recursive walker (needed on machines without ripgrep).
The fallback skips `node_modules`, `.git`, `dist`, `artifacts`, `build`, ignores
files over 2 MB and binary files, honours `fileGlob` (`**`, `*`, `?`, `{a,b}`),
caps at 200 matches and 30 s.

```json
{
  "matches": [{ "file": "C:\\work\\src\\index.js", "line": 12, "text": "export default fs;" }],
  "count": 1,
  "engine": "node",
  "truncated": false,
  "timedOut": false,
  "scannedFiles": 27,
  "skippedFiles": 3,
  "directory": "C:\\work\\src",
  "pattern": "export default",
  "fileGlob": "*.js",
  "durationMs": 14
}
```

### `pc_system_info`

No arguments. Returns platform, release, arch, shell, cwd, homedir, `node`
version, `npm`/`python`/`git` versions (one short spawn each, `null` on failure),
`stateDir`, `logsDir`, checkpoint count (`workflows`), managed
`backgroundProcesses` (`[{id, pid, command, logPath, startedAt, alive}]`, dead
entries pruned lazily), daemon `uptimeMs` and `pid`.

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
| `NCODE_STATE_DIR` | `~/.ncode` | State root (`logs/`, `workflows/`) |
| `NCODE_DEBUG` | unset | `1`/`true` enables debug logs on stderr |
| `NCODE_WS_PING_MS` | `20000` | Advanced/testing override for the ping interval |

## State layout

```
<stateDir>/
  logs/                       full stdout/stderr for every foreground command (<id>.log)
  workflows/<workflowId>.json durable checkpoints: {savedAt, checkpoint}
```

`<stateDir>` defaults to `~/.ncode` (override with `NCODE_STATE_DIR`). Log files
for foreground commands are always written, even when the returned text was not
truncated. Checkpoint writes are atomic (same-directory temp file + rename).

## Diagnostics & smoke test

```bash
node --check server.mjs
node smoke_test.mjs
```

`smoke_test.mjs` starts ephemeral daemon instances and asserts: initialize
serverInfo, tools/list contents, `tools/call pc_system_info`,
checkpoint save/load round-trip, fs write/read/patch, shell echo + long-output
truncation + timeout, code search, HTTP protocol errors (batch, `-32700`/
`-32600`/`-32601`, `GET /mcp` 405, `DELETE /mcp` 200), CORS headers, WS
register + ping/pong + legacy relay, stdio `ask_gemini_web` round-trip with a
fake extension, stdout JSON purity and graceful shutdown. It prints `PASS`/`FAIL`
per check and exits `0`/`1`.

## Security notes

* The daemon binds to loopback (`127.0.0.1`) by default and has **no
  authentication**. Anyone who can reach the port can execute shell commands as
  the current user and read/write files. Do not bind `0.0.0.0` or expose the
  port to a network/container you do not trust.
* `pc_exec_shell` runs with full user privileges and no sandbox. Background
  children are detached and survive daemon exit by design; the daemon never
  kills processes it did not start, but timeouts do kill the whole tree of the
  foreground command it started.
* `NCODE_STATE_DIR` / `~/.ncode` may contain command output and workflow
  checkpoints, which can include secrets. Treat it as user-private data.
* The WebSocket bridge accepts a 1 MB max message and drops clients after three
  missed pongs; the HTTP MCP body limit is 16 MB.
* `workflowId` is restricted to `[A-Za-z0-9._-]` so checkpoint paths cannot
  escape `<stateDir>/workflows`.
* `pc_fs_patch` refuses non-unique matches, preventing accidental mass
  replacements; always inspect the returned diff.
