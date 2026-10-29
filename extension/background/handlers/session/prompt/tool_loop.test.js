import { beforeEach, describe, expect, it, vi } from 'vitest';
import { appendRawMessages, appendUserMessage } from '../../../managers/history_manager.js';
import {
    buildNarrationNudgePrompt,
    injectBrowserControlSnapshot,
    looksLikeUnexecutedBrowserActionPlan,
    persistToolOutputMessages,
} from './tool_loop.js';

vi.mock('../../../managers/history_manager.js', () => ({
    appendAiMessageIfDisplayable: vi.fn(),
    appendRawMessages: vi.fn(),
    appendUserMessage: vi.fn(),
}));

describe('looksLikeUnexecutedBrowserActionPlan', () => {
    it('detects Chinese narration that plans a fill without tool JSON', () => {
        const text =
            '语言下拉菜单的最新 UID 为 `13_147`。现在，我将在这个下拉菜单中选择“简体中文”。\n' +
            '由于“简体中文”是该选项对应的文本，我将直接使用 `fill` 工具进行操作。';
        expect(looksLikeUnexecutedBrowserActionPlan(text)).toBe(true);
    });

    it('detects Chinese 点击 + uid without an English tool name (Win11 SERP failure mode)', () => {
        const text =
            '已经点击了微软官方的 Windows 11 下载页面，现在我需要导航到微软官网。\n\n' +
            '我将点击该官方链接 `uid=8_67`（"Download Windows 11"），进入该页面以获取 ISO 镜像下载选项。';
        expect(looksLikeUnexecutedBrowserActionPlan(text)).toBe(true);
    });

    it('detects English intent + tool name without tool JSON', () => {
        expect(
            looksLikeUnexecutedBrowserActionPlan(
                'I will click the Confirm button next using the click tool on uid 10_127.'
            )
        ).toBe(true);
    });

    it('ignores completed summaries and plain answers', () => {
        expect(
            looksLikeUnexecutedBrowserActionPlan(
                '任务已完成。微软已开始提供 Windows 11 ISO 下载链接。'
            )
        ).toBe(false);
        expect(looksLikeUnexecutedBrowserActionPlan('Hello, how can I help you today?')).toBe(
            false
        );
    });

    it('does not treat status text with bare 现在+下载 as an action plan', () => {
        // Bare 「现在」 must not match intent; otherwise status descriptions nudge forever.
        expect(
            looksLikeUnexecutedBrowserActionPlan('页面现在显示了下载按钮，进度条在加载中。')
        ).toBe(false);
        expect(looksLikeUnexecutedBrowserActionPlan('现在下载进度显示为 50%。')).toBe(false);
    });

    it('ignores replies that already include a tool-call JSON block', () => {
        const text =
            'Next I will select the language.\n```json\n{"tool":"fill","args":{"uid":"13_147","value":"简体中文"}}\n```';
        expect(looksLikeUnexecutedBrowserActionPlan(text)).toBe(false);
    });

    it('builds a bilingual nudge that demands a tool JSON call', () => {
        expect(buildNarrationNudgePrompt('zh')).toContain('工具调用');
        expect(buildNarrationNudgePrompt('zh')).toContain('"tool"');
        expect(buildNarrationNudgePrompt('default')).toContain('tool call');
    });
});

describe('browser-control tool loop handling', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('does not inject a fresh page snapshot into generic failed browser-control outputs', async () => {
        const controlManager = {
            getSnapshot: vi.fn(() => Promise.resolve('snapshot')),
        };

        const output = await injectBrowserControlSnapshot({
            toolResult: {
                source: 'browser_control',
                toolName: 'click',
                status: 'failed',
            },
            outputForModel: 'Error: Target tab is outside the controlled tab group.',
            request: {
                enableBrowserControl: true,
            },
            controlManager,
        });

        expect(output).toBe('Error: Target tab is outside the controlled tab group.');
        expect(controlManager.getSnapshot).not.toHaveBeenCalled();
    });

    it('injects a recovery snapshot for UID-resolution failures', async () => {
        const controlManager = {
            getSnapshot: vi.fn(() => Promise.resolve('uid=9_1 RootWebArea "Home"')),
            getTargetTabId: vi.fn(() => null),
        };

        const output = await injectBrowserControlSnapshot({
            toolResult: {
                source: 'browser_control',
                toolName: 'click',
                status: 'failed',
            },
            outputForModel:
                "Error: Element '3_64' not found in current snapshot. Please verify the UID or take a new snapshot.",
            request: {
                enableBrowserControl: true,
            },
            controlManager,
        });

        expect(controlManager.getSnapshot).toHaveBeenCalled();
        expect(output).toContain('not found in current snapshot');
        expect(output).toContain('Updated Page Accessibility Tree');
        expect(output).toContain('uid=9_1');
    });

    it('persists native function responses and UI tool output with the same batch id', async () => {
        const sendRuntimeMessage = vi.fn(async () => {});
        const toolResult = {
            toolName: 'take_snapshot',
            source: 'browser_control',
            output: 'Snapshot text',
            outputForModel: 'Snapshot text',
            status: 'completed',
            statusKey: 'session-1|take_snapshot|call:call-1',
            officialResponseBatchId: 'official-tools|session-1|123|1',
            officialResponseParts: [
                {
                    functionResponse: {
                        id: 'call-1',
                        name: 'take_snapshot',
                        response: {
                            output: 'Snapshot text',
                            status: 'completed',
                        },
                    },
                },
            ],
            results: [
                {
                    id: 'call-1',
                    toolName: 'take_snapshot',
                    args: { uid: 'root' },
                    output: 'Snapshot text',
                    status: 'completed',
                    statusKey: 'session-1|take_snapshot|call:call-1',
                    startedAt: 100,
                    completedAt: 140,
                    durationMs: 40,
                    callIndex: 1,
                    callCount: 1,
                },
            ],
        };

        const persistedHistoryText = await persistToolOutputMessages({
            request: { sessionId: 'session-1' },
            result: {
                text: 'I need a snapshot.',
                thoughts: 'Thinking',
                officialContent: {
                    role: 'model',
                    parts: [{ functionCall: { id: 'call-1', name: 'take_snapshot', args: {} } }],
                },
                functionCalls: [{ id: 'call-1', name: 'take_snapshot', args: {} }],
            },
            toolResult,
            loopCount: 1,
            pendingNativeCalls: true,
            sendRuntimeMessage,
        });

        expect(persistedHistoryText).toBe('');
        expect(sendRuntimeMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                action: 'TOOL_OUTPUT_MESSAGE',
                sessionId: 'session-1',
                toolName: 'take_snapshot',
                text: 'Snapshot text',
                toolCallText: JSON.stringify(
                    { tool: 'take_snapshot', args: { uid: 'root' } },
                    null,
                    2
                ),
                status: 'completed',
                step: 1,
            })
        );
        expect(appendRawMessages).toHaveBeenCalledWith('session-1', [
            expect.objectContaining({
                role: 'ai',
                text: 'I need a snapshot.',
                officialContent: expect.objectContaining({ role: 'model' }),
            }),
            expect.objectContaining({
                role: 'user',
                text: '',
                officialFunctionResponseBatchId: 'official-tools|session-1|123|1',
                officialContent: expect.objectContaining({ role: 'user' }),
            }),
            expect.objectContaining({
                role: 'user',
                kind: 'tool-output',
                toolName: 'take_snapshot',
                officialFunctionResponseBatchId: 'official-tools|session-1|123|1',
            }),
        ]);
        expect(appendUserMessage).not.toHaveBeenCalled();
    });
});
