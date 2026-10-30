# Settings optimization plan

Status: retained implementation plan for the settings-surface refactor. All steps shipped;
keep this list as the checklist new settings work should extend.

## Steps

1. Extract element lookup into `sandbox/ui/settings/dom.js` and route every section
   controller through `getSettingsElement`.
2. Split the connection section into focused helpers:
   - `sandbox/ui/settings/sections/connection_events.js`
   - `sandbox/ui/settings/sections/mcp_header_fields.js`
   - `sandbox/ui/settings/sections/mcp_tools_view.js`
   The section controller keeps only composition and tab lifecycle.
3. Move download helpers to `sandbox/ui/settings/log_download.js` and import them from the
   settings entrypoint instead of the section controller.
4. Split settings stylesheets by concern (`settings.css`, `settings_controls.css`,
   `settings_forms.css`, `settings_mcp.css`, `settings_custom_tools.css`) and keep each
   layout regression test beside its stylesheet in `css/`.
5. Replace transitional schema comments with the final multi-server `mcpServers` shape.
   Server ids use `createPrefixedId`; no timestamp-based ids remain.
6. Give each connection field its own setting-specific input class; unrelated rows must not
   reuse shortcut-input styling.
7. Keep localized placeholder text in translation dictionaries only; templates carry a
   single `data-i18n-placeholder` source of truth.
8. Re-run `cd extension && npx vitest run` and the project structure/hygiene suites after
   each extraction step so file-ownership assertions stay green.

## Verification

- `cd extension && npx vitest run` (settings, structure and hygiene suites).
- `npm run format:check` and the build from the extension project.
- Manual smoke: open settings, switch every tab, add/remove an MCP server, download logs.
