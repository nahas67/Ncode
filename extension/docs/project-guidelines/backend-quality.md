# Backend quality guidelines

These guidelines apply to the MV3 service worker (`background/`), the local PC & shell MCP
daemon (`pc-daemon/`), and the pure orchestration modules under `extension/shared/orchestrator/`.
They are tracked project docs; local tool drafts (for example `.trellis/`) must not be copied
into them.

## Module boundaries

- Group code by capability. `background/managers/` owns long-lived feature managers; a
  manager delegates protocol details to focused helpers under `background/managers/mcp/`
  instead of growing a second connection state machine in one file.
- Runtime-domain entrypoints are the root `index.js` files. A manager module should export a
  class or factory with an explicit constructor contract; avoid module-level singletons that
  make tests order-dependent.
- Prefer dependency injection for browser APIs (`chrome.*`), daemon clients and clocks so
  unit tests can exercise failure paths without a live profile.

## Error handling

- Every `try/catch` either handles the error with a user-visible or logged outcome, or
  rethrows it. Intentionally ignored errors use the explicit catchless form
  (`catch { /* reason */ }`) so they are searchable.
- Long-running loops and tool calls are timeout-bounded. A stalled MCP/PC request must not
  hang a chat turn; fail with a structured error the model can recover from.
- Never swallow storage write failures: checkpoint persistence failures are reported to the
  harness status, not silently dropped.

## Naming and hygiene

- Runtime code files use `snake_case`; classes are PascalCase; constants are UPPER_SNAKE.
- Names describe behavior (`action_waiter.js`, `script_evaluation.js`), not file position.
- No placeholder code, commented-out debug logging, or decorative section banners. Debug
  output goes through the shared `debugLog` helpers and is off by default.
- Keep comments for non-obvious constraints (protocol indexes, retry offsets, security
  notes); delete comments that repeat the next line.

## MCP and daemon contracts

- The daemon speaks Streamable HTTP MCP at `http://127.0.0.1:3001/mcp`, WebSocket at
  `ws://127.0.0.1:8085` and stdio (`--stdio`). Keep stdout reserved for JSON-RPC; diagnostics
  go to stderr.
- Daemon tools must be idempotent where possible, truncate large tool results predictably
  (head+tail with a full-log pointer), and persist workflow checkpoints atomically under
  `~/.ncode/workflows/<workflowId>.json`.
- When changing a tool schema, update the extension-side tool listing and the daemon smoke
  test in the same change.

## Verification

- `cd extension && npx vitest run` covers pure helpers and manager contracts.
- `node orchestrator/smoke_test.mjs` and `node pc-daemon/smoke_test.mjs` cover the runtime
  contracts (spawned daemons included).
- `npm run build:extension && node scripts/verify-extension-dist.mjs` proves the packaged
  service worker module graph is complete before a release.
