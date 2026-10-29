import { describe, expect, it } from 'vitest';

import {
    collectSharedRootModules,
    collectSiblingModuleDirectoryConflicts,
    ignoredProjectScanPaths,
    collectUnexpectedSourceFilenames,
    countCodeLines,
    exists,
    readJson,
    readProjectFile,
} from './project-structure/helpers.js';

describe('project structure', () => {
    it('uses the repository root as the runnable extension project root', async () => {
        await expect(exists('.github/workflows/package-extension.yml')).resolves.toBe(true);
        await expect(exists('package.json')).resolves.toBe(true);
        await expect(exists('manifest.json')).resolves.toBe(true);
        await expect(exists('gemini-nexus/package.json')).resolves.toBe(false);
    });

    it('uses shared/ for cross-runtime utilities instead of lib/', async () => {
        await expect(exists('shared')).resolves.toBe(true);
        await expect(exists('lib')).resolves.toBe(false);
        await expect(exists('background/lib')).resolves.toBe(false);
    });

    it('groups shared runtime code by capability without root-level compatibility wrappers', async () => {
        const capabilityModules = [
            'shared/attachments/index.js',
            'shared/config/constants.js',
            'shared/dom/crop_image.js',
            'shared/logging/debug.js',
            'shared/mcp/transport.js',
            'shared/media/watermark_remover.js',
            'shared/messaging/index.js',
            'shared/models/web_models.js',
            'shared/settings/connection.js',
            'shared/text/tool_call_text.js',
            'shared/ui/copy_feedback.js',
            'shared/utils/index.js',
        ];
        const removedCompatibilityWrappers = [
            'shared/attachments.js',
            'shared/constants.js',
            'shared/crop_utils.js',
            'shared/messaging.js',
            'shared/tool_call_text.js',
            'shared/utils.js',
            'shared/watermark_remover.js',
        ];

        for (const modulePath of capabilityModules) {
            await expect(exists(modulePath)).resolves.toBe(true);
        }

        for (const wrapperPath of removedCompatibilityWrappers) {
            await expect(exists(wrapperPath)).resolves.toBe(false);
        }

        await expect(collectSharedRootModules()).resolves.toEqual([]);
    });

    it('avoids sibling module files that share a name with implementation directories', async () => {
        await expect(collectSiblingModuleDirectoryConflicts()).resolves.toEqual([]);
    });

    it('keeps source filenames aligned with runtime and script naming conventions', async () => {
        await expect(collectUnexpectedSourceFilenames()).resolves.toEqual([]);
    });

    it('keeps local support and generated directories out of structure scans', () => {
        expect(ignoredProjectScanPaths).toEqual(
            expect.arrayContaining([
                '.git',
                'node_modules',
                'dist',
                'artifacts',
                '.superpowers',
                '.trellis',
                'assets/logo-concepts',
            ])
        );
    });

    it('keeps local tool drafts out of tracked project docs', async () => {
        const gitignore = await readProjectFile('.gitignore');

        expect(gitignore).toContain('.trellis/');
        await expect(exists('.trellis/spec/backend/quality-guidelines.md')).resolves.toBe(false);
        await expect(exists('.trellis/spec/frontend/component-guidelines.md')).resolves.toBe(false);
        await expect(exists('docs/project-guidelines/backend-quality.md')).resolves.toBe(true);
        await expect(exists('docs/project-guidelines/frontend-components.md')).resolves.toBe(true);
    });

    it('keeps CSS layout regression tests next to CSS ownership', async () => {
        await expect(exists('css/settings_layout.test.js')).resolves.toBe(true);
        await expect(exists('test/ui/settings_layout.test.js')).resolves.toBe(false);
    });

    it('keeps MCP manager helpers split from the connection state machine', async () => {
        const helperModules = [
            'background/managers/mcp/connection_client.js',
            'background/managers/mcp/handshake.js',
            'background/managers/mcp/transport.js',
            'background/managers/mcp/tool_result.js',
            'background/managers/mcp/preamble.js',
            'background/managers/mcp/server_tools.js',
            'background/managers/mcp/sse_stream.js',
            'background/managers/mcp/sse_connection.js',
            'background/managers/mcp/streamable_http.js',
            'background/managers/mcp/streamable_http_connection.js',
            'background/managers/mcp/websocket_connection.js',
            'background/managers/mcp/rpc_messages.js',
            'background/managers/mcp/tool_listing.js',
            'background/managers/mcp/connection_state.js',
        ];

        for (const modulePath of helperModules) {
            await expect(exists(modulePath)).resolves.toBe(true);
        }

        const manager = await readProjectFile('background/managers/mcp_remote_manager.js');
        const connectionClient = await readProjectFile(
            'background/managers/mcp/connection_client.js'
        );
        expect(manager).toContain("from './mcp/connection_client.js'");
        expect(manager).not.toContain("from './mcp/handshake.js'");
        expect(manager).not.toContain("from './mcp/transport.js'");
        expect(manager).not.toContain("from './mcp/sse_stream.js'");
        expect(manager).not.toContain("from './mcp/streamable_http.js'");
        expect(manager).not.toContain("from './mcp/rpc_messages.js'");
        expect(manager).not.toContain("from './mcp/connection_state.js'");
        expect(manager).toContain("from './mcp/tool_result.js'");
        expect(manager).toContain("from './mcp/preamble.js'");
        expect(manager).toContain("from './mcp/server_tools.js'");
        expect(manager).toContain("from './mcp/tool_listing.js'");
        expect(connectionClient).toContain("from './handshake.js'");
        expect(connectionClient).toContain("from './transport.js'");
        expect(connectionClient).toContain("from './streamable_http.js'");
        expect(connectionClient).toContain("from './rpc_messages.js'");
        expect(connectionClient).toContain("from './connection_state.js'");
        expect(connectionClient).toContain("from './websocket_connection.js'");
        expect(connectionClient).toContain("from './sse_connection.js'");
        expect(connectionClient).toContain("from './streamable_http_connection.js'");
        expect(connectionClient).not.toContain("from './sse_stream.js'");
        expect(manager).not.toMatch(/\b_createConnectionState\s*\(/);
        expect(manager).not.toContain('DEBUG_MCP_REMOTE');
        expect(manager).not.toContain('debugMcpRemote');
        expect(countCodeLines(manager)).toBeLessThan(220);
        expect(countCodeLines(connectionClient)).toBeLessThan(240);
    });

    it('documents current shared and directory entrypoint conventions', async () => {
        const readme = await readProjectFile('README.md');
        const chineseReadme = await readProjectFile('README.zh-CN.md');

        expect(readme).toContain('shared/ui/');
        expect(readme).toContain('shared/logging/');
        expect(readme).toContain('docs/gemini-web-reverse.md');
        await expect(exists('README.zh-CN.md')).resolves.toBe(true);
        await expect(exists('README.en.md')).resolves.toBe(false);
        expect(readme).toContain('README.zh-CN.md');
        expect(readme).toContain('### Project Overview');
        expect(readme).toContain('### Quick Start');
        expect(readme).toContain(
            'The repository root is the runnable Chrome extension project root.'
        );
        expect(readme).toContain('settings/index.js');
        expect(readme).not.toContain('## 中文');
        expect(readme).not.toContain('### 项目简介');
        expect(readme).not.toContain('### 快速开始');
        expect(readme).not.toContain('Project Overview / 项目简介');
        expect(readme).not.toContain('Quick Start / 快速开始');

        expect(chineseReadme).toContain('README.md');
        expect(chineseReadme).toContain('shared/ui/');
        expect(chineseReadme).toContain('shared/logging/');
        expect(chineseReadme).toContain('docs/gemini-web-reverse.md');
        expect(chineseReadme).toContain('### 项目简介');
        expect(chineseReadme).toContain('### 快速开始');
        expect(chineseReadme).toContain('不再保留顶层 `shared/*.js` 兼容入口');
        expect(chineseReadme).toContain('模块目录的聚合入口统一使用目录内 `index.js`');
        expect(chineseReadme).toContain('运行域入口保留为各运行域根部的 `index.js`');
        expect(chineseReadme).toContain('settings/index.js');
        expect(chineseReadme).toContain('运行时代码文件使用 `snake_case`');
        expect(chineseReadme).not.toContain('## English');
        expect(chineseReadme).not.toContain('### Project Overview');
        expect(chineseReadme).not.toContain('### Quick Start');
    });

    it('keeps the Gemini Web reverse contract documented', async () => {
        await expect(exists('docs/gemini-web-reverse.md')).resolves.toBe(true);

        const contract = await readProjectFile('docs/gemini-web-reverse.md');
        for (const requiredText of [
            'SNlM0e',
            'cfb2h',
            'FdrFJe',
            'qKIAYe',
            'Ylro7b',
            'StreamGenerate',
            'ProcessFile',
            'push.clients6.google.com/upload/',
            'THINKING_LEVEL_STANDARD',
            'x-goog-ext-525001261-jspb',
            'shared/models/web_model_catalog.js',
            'npm run check:gemini-web',
        ]) {
            expect(contract).toContain(requiredText);
        }
    });

    it('names shared DOM crop entry points by their runtime shape', async () => {
        await expect(exists('shared/dom/crop_global.js')).resolves.toBe(true);
        await expect(exists('shared/dom/crop_image.js')).resolves.toBe(true);
        await expect(exists('shared/dom/crop_core.js')).resolves.toBe(false);
        await expect(exists('shared/dom/crop_utils.js')).resolves.toBe(false);

        const manifest = await readJson('manifest.json');
        const listedFiles = manifest.content_scripts.flatMap((entry) => entry.js ?? []);
        const cropModule = await readProjectFile('shared/dom/crop_image.js');

        expect(listedFiles).toContain('shared/dom/crop_global.js');
        expect(listedFiles).not.toContain('shared/dom/crop_core.js');
        expect(cropModule).toContain("import './crop_global.js'");
    });

    it('keeps session prompt helpers named by responsibility', async () => {
        await expect(exists('background/handlers/session/active_tab_content.js')).resolves.toBe(
            true
        );
        await expect(
            exists('background/handlers/session/official_function_response.js')
        ).resolves.toBe(true);
        await expect(exists('background/handlers/session/utils.js')).resolves.toBe(false);

        const promptHandler = await readProjectFile(
            'background/handlers/session/prompt_handler.js'
        );
        const promptBuilder = await readProjectFile(
            'background/handlers/session/prompt/builder.js'
        );
        const toolLoop = await readProjectFile('background/handlers/session/prompt/tool_loop.js');
        const toolExecutor = await readProjectFile(
            'background/handlers/session/prompt/tool_executor.js'
        );

        expect(promptHandler).toContain("from './prompt/tool_loop.js'");
        expect(toolLoop).toContain("from '../official_function_response.js'");
        expect(toolLoop).toContain("from '../../../../shared/text/tool_call_text.js'");
        expect(promptBuilder).toContain("from '../active_tab_content.js'");
        expect(toolExecutor).toContain("from '../../../../shared/text/tool_call_text.js'");
    });

    it('names browser-control action helpers by behavior', async () => {
        await expect(exists('background/control/action_waiter.js')).resolves.toBe(true);
        await expect(exists('background/control/wait_helper.js')).resolves.toBe(false);
        await expect(
            exists('background/control/actions/observation/script_evaluation.js')
        ).resolves.toBe(true);
        await expect(exists('background/control/actions/observation/script.js')).resolves.toBe(
            false
        );

        const actionsIndex = await readProjectFile('background/control/actions/index.js');
        const baseAction = await readProjectFile('background/control/actions/base.js');
        const observation = await readProjectFile(
            'background/control/actions/observation/index.js'
        );

        expect(actionsIndex).toContain("from '../action_waiter.js'");
        expect(actionsIndex).toContain('new ActionWaiter');
        expect(baseAction).toContain("from '../action_waiter.js'");
        expect(baseAction).toContain('new ActionWaiter');
        expect(observation).toContain("from './script_evaluation.js'");
        expect(observation).toContain('ScriptEvaluationActions');
    });

    it('keeps sandbox page styles split by UI surface', async () => {
        const sandboxHtml = await readProjectFile('sandbox/index.html');
        const sidepanelHtml = await readProjectFile('sidepanel/index.html');
        const settingsHtml = await readProjectFile('settings/index.html');
        const componentStyles = await readProjectFile('css/components.css');
        const chatStyles = await readProjectFile('css/chat.css');
        const inputStyles = await readProjectFile('css/input.css');

        expect(sandboxHtml).toContain('../css/components.css');
        expect(sandboxHtml).toContain('../css/image_viewer.css');
        expect(sandboxHtml).toContain('../css/settings.css');
        expect(sandboxHtml).toContain('../css/settings_controls.css');
        expect(sandboxHtml).toContain('../css/settings_forms.css');
        expect(sandboxHtml).toContain('../css/settings_mcp.css');
        expect(sandboxHtml).toContain('../css/settings_custom_tools.css');
        expect(sandboxHtml).toContain('../css/chat_tools.css');
        expect(sandboxHtml).toContain('../css/chat_references.css');
        expect(sandboxHtml).toContain('../css/chat_media.css');
        expect(sandboxHtml).toContain('../css/chat_markdown.css');
        expect(sandboxHtml).toContain('../css/input_attachments.css');
        expect(sandboxHtml).toContain('../css/input_states.css');
        expect(componentStyles).not.toContain('.image-viewer');
        expect(componentStyles).not.toContain('.settings-modal');
        expect(await readProjectFile('css/settings.css')).not.toContain('.setting-help');
        expect(await readProjectFile('css/settings.css')).not.toContain('.settings-full-input');
        expect(await readProjectFile('css/settings.css')).not.toContain('.settings-select');
        expect(await readProjectFile('css/settings_controls.css')).not.toContain(
            'transition: all 0.2s'
        );
        expect(chatStyles).not.toContain('.tool-disclosure');
        expect(chatStyles).not.toContain('.thoughts-container');
        expect(chatStyles).not.toContain('.generated-images-grid');
        expect(chatStyles).not.toContain('.code-block-wrapper');
        expect(inputStyles).not.toContain('.image-preview');
        expect(inputStyles).not.toContain('#status.thinking');
        expect(sidepanelHtml).toContain('href="./index.css"');
        expect(sidepanelHtml).not.toMatch(/<style>/i);
        await expect(exists('sidepanel/index.css')).resolves.toBe(true);
        expect(settingsHtml).toContain('../css/settings.css');
        expect(settingsHtml).toContain('../css/settings_controls.css');
        expect(settingsHtml).toContain('../css/settings_forms.css');
        expect(settingsHtml).toContain('../css/settings_mcp.css');
        expect(settingsHtml).toContain('../css/settings_custom_tools.css');
        await expect(exists('css/settings_forms.css')).resolves.toBe(true);
        await expect(exists('css/settings_mcp.css')).resolves.toBe(true);
        await expect(exists('css/settings_custom_tools.css')).resolves.toBe(true);
        expect(await readProjectFile('css/settings_controls.css')).not.toContain(
            '.settings-input.settings-select'
        );
        expect(await readProjectFile('css/settings_controls.css')).not.toContain('.mcp-tool-list');
        expect(await readProjectFile('css/settings_controls.css')).not.toContain(
            '.custom-selection-tool-row'
        );
        expect(await readProjectFile('sandbox/ui/layout.js')).not.toContain('SettingsTemplate +');
    });

    it('keeps connection settings helpers split from the settings section controller', async () => {
        const helperModules = [
            'sandbox/ui/settings/sections/connection_events.js',
            'sandbox/ui/settings/sections/mcp_header_fields.js',
            'sandbox/ui/settings/sections/mcp_tools_view.js',
        ];

        for (const modulePath of helperModules) {
            await expect(exists(modulePath)).resolves.toBe(true);
        }
        await expect(exists('sandbox/ui/settings/sections/connection_utils.js')).resolves.toBe(
            false
        );

        const section = await readProjectFile('sandbox/ui/settings/sections/connection.js');
        const events = await readProjectFile('sandbox/ui/settings/sections/connection_events.js');
        expect(section).toContain("from './connection_events.js'");
        expect(section).toContain("from './mcp_header_fields.js'");
        expect(section).toContain("from './mcp_tools_view.js'");
        expect(section).toContain("from '../../../../shared/mcp/transport.js'");
        expect(section).toContain("from '../../../../shared/settings/openai.js'");
        expect(section).not.toContain("from './connection_utils.js'");
        expect(events).toContain("from '../../../../shared/mcp/transport.js'");
        expect(events).not.toContain("from './connection_utils.js'");
        expect(countCodeLines(section)).toBeLessThan(395);
    });

    it('keeps settings download helpers split from the settings section controller', async () => {
        await expect(exists('sandbox/ui/settings/log_download.js')).resolves.toBe(true);

        const settings = await readProjectFile('sandbox/ui/settings/index.js');
        expect(settings).toContain("from './log_download.js'");
    });

    it('keeps content toolbar window helpers split from the window controller', async () => {
        const helperModules = [
            'content/toolbar/view/image_preview.js',
            'content/toolbar/view/layout.js',
            'content/toolbar/view/translation_targets.js',
        ];

        for (const modulePath of helperModules) {
            await expect(exists(modulePath)).resolves.toBe(true);
        }
        await expect(exists('content/toolbar/view/utils.js')).resolves.toBe(false);

        const windowView = await readProjectFile('content/toolbar/view/window.js');
        const widgetView = await readProjectFile('content/toolbar/view/widget.js');
        const toolbarView = await readProjectFile('content/toolbar/view/index.js');
        expect(windowView).toContain('GeminiViewLayout');
        expect(widgetView).toContain('GeminiViewLayout');
        expect(toolbarView).toContain('GeminiViewLayout');
        expect(toolbarView).not.toContain('GeminiViewUtils');
        expect(windowView).toContain('GeminiImagePreviewController');
        expect(countCodeLines(windowView)).toBeLessThan(300);
    });

    it('names content toolbar classic helpers by their controller responsibilities', async () => {
        await expect(exists('content/toolbar/drag_controller.js')).resolves.toBe(true);
        await expect(exists('content/toolbar/input_manager.js')).resolves.toBe(true);
        await expect(exists('content/toolbar/ui/custom_selection_tools.js')).resolves.toBe(true);
        await expect(exists('content/toolbar/ui/translation_target_store.js')).resolves.toBe(true);
        await expect(exists('content/toolbar/utils/drag.js')).resolves.toBe(false);
        await expect(exists('content/toolbar/utils/input.js')).resolves.toBe(false);

        const toolbarUi = await readProjectFile('content/toolbar/ui/toolbar_ui.js');
        const controller = await readProjectFile('content/toolbar/controller.js');
        expect(toolbarUi).toContain('GeminiDragController');
        expect(toolbarUi).toContain('GeminiCustomSelectionToolsUI');
        expect(toolbarUi).toContain('GeminiTranslationTargetStore');
        expect(toolbarUi).not.toMatch(/^\s{8}renderCustomSelectionTools\s*\(/m);
        expect(toolbarUi).not.toMatch(/^\s{8}getToolButtonLabel\s*\(/m);
        expect(toolbarUi).not.toContain('TRANSLATION_TARGET_STORAGE_KEY');
        expect(controller).toContain('GeminiInputManager');
    });

    it('keeps message rendering helpers split from the message state controller', async () => {
        const helperModules = [
            'sandbox/render/context_compression.js',
            'sandbox/render/copy_button.js',
            'sandbox/render/math_placeholders.js',
            'sandbox/render/message_edit.js',
            'sandbox/render/message_media.js',
            'sandbox/render/sources.js',
        ];

        for (const modulePath of helperModules) {
            await expect(exists(modulePath)).resolves.toBe(true);
        }

        const message = await readProjectFile('sandbox/render/message.js');
        const pipeline = await readProjectFile('sandbox/render/pipeline.js');
        await expect(exists('sandbox/render/thoughts_block.js')).resolves.toBe(true);
        await expect(exists('sandbox/render/message_spacing.js')).resolves.toBe(true);
        expect(message).toContain("from './content.js'");
        expect(message).toContain("from './thoughts_block.js'");
        expect(message).toContain("from './message_spacing.js'");
        expect(message).toContain("from '../core/displayable_content.js'");
        expect(message).not.toContain('appendContextCompressionNotice');
        expect(message).not.toMatch(/\bfunction hasDisplayable(Text|Thoughts)\s*\(/);
        expect(message).not.toMatch(/\bfunction formatThoughtDuration\s*\(/);
        expect(message).not.toContain('THOUGHTS_REGION_PREFIX');
        expect(message).not.toMatch(/\bconst isCompactSpacingPair\s*=/);
        expect(message).toContain("from './copy_button.js'");
        expect(message).toContain("from './message_edit.js'");
        expect(message).toContain("from './message_media.js'");
        expect(message).toContain("from './sources.js'");
        await expect(exists('sandbox/render/math_utils.js')).resolves.toBe(false);
        expect(pipeline).toContain("from './math_placeholders.js'");
        expect(pipeline).toContain('MathPlaceholderProtector');
        expect(pipeline).not.toContain("from './math_utils.js'");
        expect(countCodeLines(message)).toBeLessThan(450);
    });

    it('keeps message result helpers split from the message controller', async () => {
        const helperModules = [
            'sandbox/core/displayable_content.js',
            'sandbox/controllers/message_matchers.js',
            'sandbox/controllers/message_reply_renderer.js',
            'sandbox/controllers/message_results.js',
            'sandbox/controllers/message_stream_state.js',
            'sandbox/controllers/message_tools.js',
            'sandbox/controllers/message_tool_messages.js',
        ];

        for (const modulePath of helperModules) {
            await expect(exists(modulePath)).resolves.toBe(true);
        }

        const handler = await readProjectFile('sandbox/controllers/message_handler.js');
        const replyRenderer = await readProjectFile(
            'sandbox/controllers/message_reply_renderer.js'
        );
        const streamState = await readProjectFile('sandbox/controllers/message_stream_state.js');
        const toolMessages = await readProjectFile('sandbox/controllers/message_tool_messages.js');
        expect(handler).toContain("from './message_reply_renderer.js'");
        expect(handler).toContain("from './message_results.js'");
        expect(handler).toContain("from './message_stream_state.js'");
        expect(handler).toContain("from './message_tool_messages.js'");
        expect(replyRenderer).toContain("from './message_matchers.js'");
        expect(streamState).toContain("from '../core/displayable_content.js'");
        expect(handler).not.toContain("from './message_tools.js'");
        expect(toolMessages).toContain("from './message_tools.js'");
        expect(handler).not.toMatch(/^\s{4}buildToolOutputHistoryText\s*\(/m);
        expect(handler).not.toMatch(/^\s{4}cacheStreamState\s*\(/m);
        expect(handler).not.toMatch(/^\s{4}createStreamingBubble\s*\(/m);
        expect(handler).not.toMatch(/^\s{4}renderGeminiReply\s*\(/m);
        expect(handler).not.toContain("kind: 'tool-output'");
        expect(handler).not.toContain("kind: 'tool-status'");
        expect(countCodeLines(handler)).toBeLessThan(340);
    });

    it('keeps OpenAI-compatible payload and response helpers split from provider transport', async () => {
        const helperModules = [
            'services/providers/openai_payloads.js',
            'services/providers/openai_response_extractors.js',
        ];

        for (const modulePath of helperModules) {
            await expect(exists(modulePath)).resolves.toBe(true);
        }

        const provider = await readProjectFile('services/providers/openai_compatible.js');
        expect(provider).toContain("from './openai_payloads.js'");
        expect(provider).toContain("from './openai_response_extractors.js'");
        expect(provider).not.toMatch(/\bfunction buildChatMessages\s*\(/);
        expect(provider).not.toMatch(/\bfunction buildResponsesInput\s*\(/);
        expect(provider).not.toMatch(/\bfunction extractTextFromCompletedResponse\s*\(/);
        expect(provider).not.toMatch(/\bfunction extractSourcesFromAnnotation\s*\(/);
        expect(countCodeLines(provider)).toBeLessThan(330);
    });

    it('keeps sandbox boot event groups split by UI surface', async () => {
        const helperModules = [
            'sandbox/boot/input_events.js',
            'sandbox/boot/tool_button_events.js',
        ];

        for (const modulePath of helperModules) {
            await expect(exists(modulePath)).resolves.toBe(true);
        }

        const events = await readProjectFile('sandbox/boot/events.js');
        expect(events).toContain("from './input_events.js'");
        expect(events).toContain("from './tool_button_events.js'");
        expect(events).not.toContain("action: 'GET_ACTIVE_SELECTION'");
        expect(events).not.toContain("action: 'INITIATE_CAPTURE'");
        expect(events).not.toMatch(/\bgetToolsPageScrollDistance\s*\(/);
        expect(countCodeLines(events)).toBeLessThan(95);
    });

    it('keeps sidebar helpers split by UI responsibility', async () => {
        const helperModules = [
            'sandbox/ui/sidebar_collapsed_recent.js',
            'sandbox/ui/sidebar_grouping.js',
            'sandbox/ui/sidebar_menus.js',
            'sandbox/ui/sidebar_rendering.js',
            'sandbox/ui/sidebar_title_edit.js',
        ];

        for (const modulePath of helperModules) {
            await expect(exists(modulePath)).resolves.toBe(true);
        }
        await expect(exists('sandbox/ui/sidebar')).resolves.toBe(false);

        const sidebar = await readProjectFile('sandbox/ui/sidebar.js');
        expect(sidebar).toContain("from './sidebar_collapsed_recent.js'");
        expect(sidebar).toContain("from './sidebar_grouping.js'");
        expect(sidebar).toContain("from './sidebar_menus.js'");
        expect(sidebar).toContain("from './sidebar_rendering.js'");
        expect(sidebar).toContain("from './sidebar_title_edit.js'");
        expect(sidebar).not.toContain('TemplateIcons');
        expect(sidebar).not.toContain('COLLAPSED_RECENT_PANEL_WIDTH');
        expect(sidebar).not.toContain('history-menu-item');
        expect(sidebar).not.toContain('history-session-edit-input');
        expect(sidebar).not.toContain('collapsed-recent-title');
        expect(sidebar).not.toContain('confirm(t(');
        expect(sidebar).not.toMatch(/\bfunction getValidSessionDate\s*\(/);
        expect(countCodeLines(sidebar)).toBeLessThan(540);
    });

    it('keeps UI message helper branches split by responsibility', async () => {
        const helperModules = [
            'background/handlers/ui_browser_control.js',
            'background/handlers/ui_async.js',
            'background/handlers/ui_capture.js',
            'background/handlers/ui_image_fetching.js',
            'background/handlers/ui_mcp_tools.js',
            'background/handlers/ui_page_context.js',
            'background/handlers/ui_sidepanel.js',
            'background/handlers/ui_tab_actions.js',
        ];

        for (const modulePath of helperModules) {
            await expect(exists(modulePath)).resolves.toBe(true);
        }

        const handler = await readProjectFile('background/handlers/ui.js');
        expect(handler).toContain("from './ui_browser_control.js'");
        expect(handler).toContain("from './ui_capture.js'");
        expect(handler).toContain("from './ui_image_fetching.js'");
        expect(handler).toContain("from './ui_mcp_tools.js'");
        expect(handler).toContain("from './ui_page_context.js'");
        expect(handler).toContain("from './ui_sidepanel.js'");
        expect(handler).toContain("from './ui_tab_actions.js'");
        expect(handler).not.toMatch(/^\s{4}_handle(OpenSidePanel|ToggleSidePanelControl)\s*\(/m);
        expect(handler).not.toMatch(
            /^\s{4}async _handle(OpenSidePanel|ToggleSidePanelControl)\s*\(/m
        );
        expect(handler).not.toMatch(/^\s{4}_loadMcpTools\s*\(/m);
        expect(handler).not.toMatch(/^\s{4}_toSafeMcpTools\s*\(/m);
        expect(handler).not.toContain('captureScreenshot');
        expect(handler).not.toContain('captureArea');
        expect(handler).not.toContain('toControlTabSummary');
        expect(countCodeLines(handler)).toBeLessThan(130);
    });

    it('keeps sidepanel session merge helpers split from the message bridge', async () => {
        await expect(exists('sidepanel/core/session_merge.js')).resolves.toBe(true);

        const bridge = await readProjectFile('sidepanel/core/bridge.js');
        expect(bridge).toContain("from './session_merge.js'");
        expect(bridge).not.toMatch(/\bfunction mergeSessionSaveWithCurrent\s*\(/);
        expect(countCodeLines(bridge)).toBeLessThan(420);
    });

    it('keeps sidepanel window actions split from the message bridge', async () => {
        const helperModules = [
            'sidepanel/core/downloads.js',
            'sidepanel/core/screen_capture.js',
            'sidepanel/core/window_actions.js',
        ];

        for (const modulePath of helperModules) {
            await expect(exists(modulePath)).resolves.toBe(true);
        }
        await expect(exists('sidepanel/utils/download.js')).resolves.toBe(false);

        const bridge = await readProjectFile('sidepanel/core/bridge.js');
        const windowActions = await readProjectFile('sidepanel/core/window_actions.js');
        expect(bridge).toContain("from './screen_capture.js'");
        expect(bridge).toContain("from './window_actions.js'");
        expect(bridge).not.toContain("from './downloads.js'");
        expect(bridge).not.toContain("from './preferences.js'");
        expect(bridge).not.toContain('WINDOW_MESSAGE_HANDLERS');
        expect(bridge).not.toMatch(/^\s{4}async _captureDisplayStill\s*\(/m);
        expect(windowActions).toContain("from './downloads.js'");
        expect(windowActions).toContain("from './preferences.js'");
        expect(bridge).not.toContain("from '../utils/download.js'");
        expect(countCodeLines(bridge)).toBeLessThan(300);
    });
});
