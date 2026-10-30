# Gemini Web reverse-engineering contract

Ncode drives `https://gemini.google.com` through the user's existing signed-in browser
session. This document records the request/response contract the extension depends on, so a
Gemini Web change can be diagnosed without re-deriving the protocol from the minified client
bundle. `npm run check:gemini-web` (in `extension/`) validates saved HTML and client-script
artifacts against these expectations.

## Page tokens

The `gemini.google.com/app` bootstrap payload embeds the session-scoped values that every
chat request needs:

| Token | Meaning |
| --- | --- |
| `SNlM0e` | `at` anti-CSRF/session token sent as `at` in StreamGenerate requests |
| `cfb2h` | Assistant web build label (`boq_assistant-bard-web-server_<date>`) |
| `FdrFJe` | Numeric session/request correlation id used by the upload and stream endpoints |
| `qKIAYe` | Dynamic feeds path used by the streaming endpoint |
| `Ylro7b` | Client page-context blob attached to uploads and stream headers |

## RPC endpoints

| Operation | RPC id | Path |
| --- | --- | --- |
| Chat streaming | `RxAFq` | `/assistant.lamda.BardFrontendService/StreamGenerate` |
| File upload | `LbusCb` | `/assistant.lamda.BardFrontendService/ProcessFile` |

The stream response is an array-of-arrays payload; candidate text lives in the parser
protocol indexes documented in `services/parser.js` (named constants such as
`PAYLOAD_CANDIDATES_INDEX` and `CANDIDATE_THOUGHTS_INDEX` rather than raw numeric indexing).

## Upload contract

Generated/captured images and attachments are pushed to:

- Endpoint: `https://push.clients6.google.com/upload/`
- Request headers: `Push-ID`, `X-Tenant-Id`, `X-Client-Pctx`

## Stream side-channel headers

The `x-goog-ext-<id>-jspb` headers select server-side feature flags. Ncode sends:

- `x-goog-ext-525001261-jspb`
- `x-goog-ext-525005358-jspb`
- `x-goog-ext-73010989-jspb`
- `x-goog-ext-73010990-jspb`

## Thinking levels

Thinking effort is carried as native markers in the request payload:

- `THINKING_LEVEL_STANDARD`
- `THINKING_LEVEL_EXTENDED`
- `THINKING_LEVEL_DEEP_THINK`

## Temporary chat markers

Temporary (non-persisted) chat mode is detected/produced through the markers
`gemini_chat_temp`, `is-temporary-chat`, `temporary-chat-header` and
`disable_temp_chat_soft_badge`.

## Model catalog

Model display names, values and request hashes are centralized in
`shared/models/web_model_catalog.js`. The drift checker reads the configured model hashes
from `GeminiNexusWebModelCatalog.getSupportedWebModelValues()` and verifies they are present
in the client script, so adding a model only requires updating the catalog.

## Drift validation

Save the logged-in page HTML and the relevant client script, then run:

```bash
cd extension
npm run check:gemini-web -- --html /path/to/gemini-app.html --script /path/to/bard-chat-ui.js
```

The check fails when HTML tokens are missing, when StreamGenerate/ProcessFile mappings are
absent, when the upload endpoint/headers changed, when the stream side-channel headers are
gone, or when configured model hashes / thinking markers / temporary-chat markers disappear.
Use `--url https://gemini.google.com/app` instead of `--html` to fetch the page live.
