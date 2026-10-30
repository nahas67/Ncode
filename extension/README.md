# Ncode Chrome Extension

This directory is the Chrome MV3 half of Ncode: the side-panel chat UI, the
`gemini.google.com` web-session provider, the browser/PC control layer, the MCP client, and
the Ncode Goal Loop + Compact & Resume orchestration that runs inside the MV3 service
worker.

### Project Overview

The repository root is the runnable Chrome extension project root. All runtime code,
`manifest.json`, the Vite page entries (`sidepanel/index.html`, `sandbox/index.html`,
`settings/index.html`) and the packaging scripts live directly in this directory. There is
no nested `gemini-nexus/` project directory; the build output is `extension/dist/`.

Runtime code is grouped by capability instead of by technical layer:

| Directory | Responsibility |
| --- | --- |
| `background/` | MV3 module service worker: providers, prompt/tool loop, managers, Ncode integrations |
| `content/` | Content scripts injected into pages (toolbar, selection, Gemini Web bridges) |
| `sandbox/` | Sandboxed chat renderer and UI controller (loaded inside the side panel iframe) |
| `sidepanel/` | Side-panel bridge shell and window actions |
| `settings/` | Settings page module entry points and bridge |
| `services/` | Model providers and response parsers |
| `shared/` | Cross-runtime utilities grouped by capability (`shared/ui/`, `shared/logging/`, `shared/mcp/`, `shared/media/`, `shared/models/`, `shared/settings/`, …) |
| `css/` | Stylesheets owned by the rendered UI surfaces |
| `assets/`, `vendor/` | Icons, cursors and vendored runtime dependencies |

Module and entrypoint conventions:

- No top-level `shared/*.js` compatibility wrappers remain; every cross-runtime helper has
  a capability directory instead (for example `shared/ui/` and `shared/logging/`).
- A module directory exposes its aggregate API through the directory's own `index.js`.
- Runtime-domain entrypoints stay as `index.js` at each runtime root: `background/index.js`,
  `content/index.js`, `settings/index.js`, `sidepanel/index.js`, `sandbox/index.js`.
- Runtime code files use `snake_case`; build/package scripts under `scripts/` use
  kebab-case.
- Layout regression tests live next to the stylesheet they guard (for example
  `css/settings_layout.test.js`).

### Quick Start

Prerequisites: Node.js >= 20 and a Chromium browser. Run everything from the repository
root (the parent of this directory) so the unified scripts work:

```bash
npm run install:all        # extension + pc-daemon dependencies
npm run build:extension    # vite build -> package -> loadable extension/dist
npm run test:extension     # vitest suite for the extension project
npm run check              # syntax, smoke, dist verification and e2e gates
```

Load `extension/dist` through `chrome://extensions` -> Developer mode -> Load unpacked.
The extension connects to the local Ncode daemon at `http://127.0.0.1:3001/mcp`, so run
`npm run start:daemon` before using the PC harness.

### Gemini Web reverse contract

The reverse-engineered `gemini.google.com` request contract (session tokens, StreamGenerate
and ProcessFile RPCs, upload endpoint/headers, thinking-level markers and model hashes) is
documented in [docs/gemini-web-reverse.md](docs/gemini-web-reverse.md). The model catalog
lives in `shared/models/web_model_catalog.js`, and the contract drift check runs with
`npm run check:gemini-web`.

Chinese documentation: [README.zh-CN.md](README.zh-CN.md).

Project quality guidelines are kept under `docs/project-guidelines/` so local tool drafts
(for example `.trellis/`) never leak into tracked project docs.
