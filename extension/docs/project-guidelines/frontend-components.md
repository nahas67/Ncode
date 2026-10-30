# Frontend component guidelines

These guidelines apply to the sandboxed chat renderer (`sandbox/`), the side-panel shell
(`sidepanel/`), the settings page (`settings/`) and the toolbars injected by content scripts.
The sandbox page renders inside an iframe with the extension sandbox CSP; it cannot use
`eval`, remote scripts or absolute asset URLs.

## Rendering structure

- The sandbox boots through `sandbox/index.js`, then hands control to
  `sandbox/controllers/app_controller.js`. Sub-controllers own one UI surface each
  (messages, chat input, sidebar, tab selector, settings).
- Message rendering is split by responsibility: `sandbox/render/message.js` composes helpers
  such as `content.js`, `thoughts_block.js`, `message_spacing.js`, `copy_button.js`,
  `message_media.js` and `sources.js`. A new bubble behavior belongs in a helper, not in the
  state controller.
- DOM builders use descriptive variable names (`messageElement`, `noticeElement`,
  `helpTextElement`) instead of short placeholders (`div`, `el`, `btn`).
- SVG icons live in the shared template icon registry (`sandbox/ui/templates/icons.js`) as
  `TemplateIcons.*` constants; do not inline `<svg>` markup in render code.
- Correlation ids are generated with the shared `createPrefixedId` helper; never build ids
  from `Date.now()` + `Math.random()`.

## Styling ownership

- Stylesheets are split by owned UI surface under `css/`: base tokens, chat surfaces,
  settings sections (`settings.css`, `settings_controls.css`, `settings_forms.css`,
  `settings_mcp.css`, `settings_custom_tools.css`) and content-toolbar styles.
- A layout regression test stays next to the stylesheet it guards
  (for example `css/settings_layout.test.js`), not in a general UI test directory.
- Custom properties must be declared in a stylesheet before they are referenced; unresolved
  `var()` silently drops a declaration and fails visually instead of loudly.
- Inline styles in runtime DOM builders are only acceptable for dynamic geometry (drag
  position, crop rectangle). Static visual styling belongs in `css/`.

## Settings page

- `settings/index.html` loads `settings/index.js`, which wires the settings bridge and
  section controllers. The section controllers use the centralized `getSettingsElement`
  lookup helper instead of local `document.getElementById` wrappers.
- Connection settings helpers are split by concern: `connection_events.js`,
  `mcp_header_fields.js` and `mcp_tools_view.js`. The section controller only orchestrates
  them.
- Setting-specific input classes stay setting-specific; do not reuse shortcut-input classes
  for unrelated setting rows.

## Messaging and i18n

- Sandbox UI talks to the service worker through the message bridge
  (`sandbox/boot/messaging.js`); Ncode-specific message actions come from the shared action
  registry `shared/messaging/ncode_actions.js` instead of raw string literals.
- Every user-visible string goes through `t('key')` or a `data-i18n*` attribute, with the key
  defined in `sandbox/core/translations.js` for all supported languages.
- Incoming Ncode harness messages (`NCODE_HARNESS_STATUS_UPDATE`, `NCODE_GOAL_STATE_UPDATE`,
  `NCODE_INTERIM_PREAMBLE`, `NCODE_APPROVAL_REQUEST`, …) are dispatched by the message
  handler to the relevant controller; components only render the state they receive.

## Accessibility and verification

- Interactive controls are real `<button>` elements with labels/tooltips, and panels expose
  appropriate ARIA roles when they behave as dialogs.
- `cd extension && npx vitest run` covers controller/helper contracts; DOM tests declare
  `// @vitest-environment jsdom` per file.
- `npm run check` at the repository root runs the build, packaged-extension verification and
  the runtime e2e gate before release.
