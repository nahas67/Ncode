# Changelog

## v1.0.0 - 2026-10-30

- Ncode Chrome MV3 extension: side-panel chat UI, `gemini.google.com` web-session provider
  and browser control tools.
- Astra-style Goal Loop with interim status preambles and subgoal checklist
  (`shared/orchestrator/goal_state_machine.js`).
- Compact & Resume session durability: pruning, checkpoint persistence to
  `chrome.storage.local` and `~/.ncode/workflows/<workflowId>.json`, cursor reset and
  hydration for the next turn (`shared/orchestrator/compact_resume_engine.js`).
- Ncode PC & Shell MCP connections: local daemon at `http://127.0.0.1:3001/mcp` with
  `pc_exec_shell`, filesystem, search and workflow checkpoint tools.
- Packaged, self-contained loadable extension at `extension/dist` produced by
  `npm run build:extension`.
