// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';
import { setLanguagePreference } from '../../../core/i18n.js';
import { getMcpToolsSummaryText, groupMcpTools, renderMcpToolsUI } from './mcp_tools_view.js';

describe('MCP tools view', () => {
    it('summarizes tool exposure state', () => {
        setLanguagePreference('zh');

        expect(
            getMcpToolsSummaryText({
                server: { url: '' },
                tools: [],
                toolMode: 'all',
                enabledSet: new Set(),
            })
        ).toBe('请先设置服务器地址以管理工具。');

        expect(
            getMcpToolsSummaryText({
                server: { url: 'http://localhost/mcp' },
                tools: [],
                toolMode: 'selected',
                enabledSet: new Set(),
            })
        ).toBe('尚未加载工具列表。点击“刷新工具列表”后选择要暴露的工具。');

        expect(
            getMcpToolsSummaryText({
                server: { url: 'http://localhost/mcp' },
                tools: [{ name: 'a' }, { name: 'b' }],
                toolMode: 'selected',
                enabledSet: new Set(['a']),
            })
        ).toBe('模式：已选择。已暴露工具：1/2。');

        setLanguagePreference('en');
    });

    it('groups tools by prefix and keeps ungrouped tools last', () => {
        const groups = groupMcpTools([
            { name: 'browser.click' },
            { name: 'search' },
            { name: 'browser.snapshot' },
            { name: 'files.read' },
        ]);

        expect(groups.map((group) => group.name)).toEqual(['browser', 'files', '(other)']);
        expect(groups[0].tools.map((tool) => tool.name)).toEqual([
            'browser.click',
            'browser.snapshot',
        ]);
        expect(groups[2].tools.map((tool) => tool.name)).toEqual(['search']);
    });

    it('renders selected tool checkboxes and updates enabled tools', () => {
        setLanguagePreference('zh');

        const server = {
            id: 'srv',
            url: 'http://localhost/mcp',
            toolMode: 'selected',
            enabledTools: ['browser.click'],
        };
        const summary = document.createElement('div');
        const list = document.createElement('div');
        const rerender = vi.fn();

        renderMcpToolsUI({
            server,
            tools: [
                { name: 'browser.click', description: 'Click element' },
                { name: 'browser.snapshot', description: 'Snapshot page' },
            ],
            search: '',
            summaryElement: summary,
            listElement: list,
            uiState: { openGroups: new Set(['browser']) },
            onToolsChange: rerender,
        });

        expect(summary.textContent).toBe('模式：已选择。已暴露工具：1/2。');
        expect(list.querySelector('summary')?.textContent).toContain('browser');
        expect(list.querySelector('summary')?.textContent).toContain('1/2');
        expect(list.querySelectorAll('[style]').length).toBe(0);
        expect(list.querySelector('.mcp-tool-row')).toBeTruthy();

        const toolCheckboxes = [...list.querySelectorAll('label input[type="checkbox"]')];
        expect(toolCheckboxes).toHaveLength(2);

        toolCheckboxes[1].checked = true;
        toolCheckboxes[1].dispatchEvent(new Event('change'));

        expect(server.enabledTools.sort()).toEqual(['browser.click', 'browser.snapshot']);
        expect(rerender).toHaveBeenCalledTimes(1);

        setLanguagePreference('en');
    });
});
