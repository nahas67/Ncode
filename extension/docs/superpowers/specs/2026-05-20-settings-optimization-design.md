# Settings optimization design

Status: retained design note for the settings-surface refactor. The features described here
have shipped; this document records the target structure so later changes keep the same
ownership boundaries.

## Goal

The settings modal had grown into a single controller that owned connection state, MCP tool
rendering, appearance, shortcuts, download helpers and every DOM lookup. The refactor splits
that surface by UI responsibility without changing the rendered settings or stored schema.

## Structure

- Tabs are rendered by the settings view; each tab maps to one section controller under
  `sandbox/ui/settings/sections/` (about, appearance, connection, general, shortcuts).
- The connection section keeps only orchestration. Its helpers are split as:
  - `connection_events.js` wires form/subscription events,
  - `mcp_header_fields.js` builds and reads per-server header rows,
  - `mcp_tools_view.js` renders the discovered MCP tool list.
- Element lookup is centralized in `sandbox/ui/settings/dom.js` through
  `getSettingsElement`; section controllers do not define local lookup wrappers.
- Log download handling lives in `sandbox/ui/settings/log_download.js` and is imported by
  the settings entrypoint.

## Stylesheet ownership

Settings styling is split by concern under `css/`:

- `settings.css` — modal shell, layout and tab chrome,
- `settings_controls.css` — shared control primitives,
- `settings_forms.css` — form rows and validation states,
- `settings_mcp.css` — MCP server cards and tool list,
- `settings_custom_tools.css` — custom selection tool editor.

Each stylesheet keeps its layout regression test beside it in `css/` so a visual regression
is attributed to the owning file. No stylesheet declares selectors that no template or
runtime code produces.

## Connection schema

The settings schema keeps the multi-server `mcpServers` map as the single source of truth.
Single-server legacy fields are not read or written by the current UI. Server ids are
generated with the shared `createPrefixedId` helper; no ad-hoc timestamp/random ids.

## Non-goals

- No change to the stored `chrome.storage` keys used by existing installs.
- No migration of the granularity of tool discovery caching in this refactor.
