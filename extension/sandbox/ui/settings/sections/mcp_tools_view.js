import { formatT, t } from '../../../core/i18n.js';

const UNGROUPED_TOOLS_KEY = '(other)';

function createHelpText(text) {
    const helpTextElement = document.createElement('div');
    helpTextElement.className = 'mcp-tool-help-text';
    helpTextElement.textContent = text;
    return helpTextElement;
}

export function getMcpToolsSummaryText({ server, tools, toolMode, enabledSet }) {
    const total = Array.isArray(tools) ? tools.length : 0;
    const enabledCount = toolMode === 'all' ? total : enabledSet.size;
    const modeLabel = toolMode === 'all' ? t('mcpModeAll') : t('mcpModeSelected');

    if (!server.url || !server.url.trim()) {
        return t('mcpSummarySetServerUrl');
    }
    if (total === 0) {
        return toolMode === 'all' ? t('mcpSummaryAllTools') : t('mcpSummaryNoTools');
    }
    return formatT('mcpSummarySelected', {
        mode: modeLabel,
        count: enabledCount,
        total,
    });
}

export function groupMcpTools(tools, search = '') {
    const normalizedSearch = (search || '').trim().toLowerCase();
    const filtered = normalizedSearch
        ? tools.filter(
              (tool) =>
                  (tool.name || '').toLowerCase().includes(normalizedSearch) ||
                  (tool.description || '').toLowerCase().includes(normalizedSearch)
          )
        : tools;
    const groups = new Map();

    for (const tool of filtered) {
        const toolName = tool.name || '';
        if (!toolName) continue;
        const dot = toolName.indexOf('.');
        const group = dot > 0 ? toolName.slice(0, dot) : UNGROUPED_TOOLS_KEY;
        if (!groups.has(group)) groups.set(group, []);
        groups.get(group).push(tool);
    }

    return Array.from(groups.keys())
        .sort((leftGroupName, rightGroupName) => {
            if (leftGroupName === UNGROUPED_TOOLS_KEY) return 1;
            if (rightGroupName === UNGROUPED_TOOLS_KEY) return -1;
            return leftGroupName.localeCompare(rightGroupName);
        })
        .map((name) => ({
            name,
            tools: groups
                .get(name)
                .sort((leftTool, rightTool) =>
                    (leftTool.name || '').localeCompare(rightTool.name || '')
                ),
        }));
}

function renderToolRow(tool, enabledSet, onToolsChange) {
    const toolName = tool.name || '';
    const dot = toolName.indexOf('.');
    const displayName = dot > 0 ? toolName.slice(dot + 1) : toolName;

    const row = document.createElement('label');
    row.className = 'mcp-tool-row';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = enabledSet.has(toolName);
    checkbox.addEventListener('change', () => {
        if (checkbox.checked) enabledSet.add(toolName);
        else enabledSet.delete(toolName);
        onToolsChange(Array.from(enabledSet));
    });

    const text = document.createElement('div');
    text.className = 'mcp-tool-row-text';

    const toolNameElement = document.createElement('div');
    toolNameElement.className = 'mcp-tool-name';
    toolNameElement.textContent = displayName;

    const fullToolNameElement = document.createElement('div');
    fullToolNameElement.className = 'mcp-tool-full-name';
    fullToolNameElement.textContent = toolName;

    const toolDescriptionElement = document.createElement('div');
    toolDescriptionElement.className = 'mcp-tool-description';
    toolDescriptionElement.textContent = tool.description || '';

    text.appendChild(toolNameElement);
    text.appendChild(fullToolNameElement);
    if (tool.description) text.appendChild(toolDescriptionElement);

    row.appendChild(checkbox);
    row.appendChild(text);
    return row;
}

function renderToolGroup(groupName, tools, enabledSet, uiState, onToolsChange) {
    const toolNames = tools.map((tool) => tool.name).filter(Boolean);
    const enabledCountInGroup = toolNames.filter((name) => enabledSet.has(name)).length;
    const totalInGroup = toolNames.length;

    const details = document.createElement('details');
    details.className = 'mcp-tool-group';
    details.open = uiState.openGroups.has(groupName);
    details.addEventListener('toggle', () => {
        if (details.open) uiState.openGroups.add(groupName);
        else uiState.openGroups.delete(groupName);
    });

    const summary = document.createElement('summary');
    summary.className = 'mcp-tool-group-summary';

    const left = document.createElement('div');
    left.className = 'mcp-tool-group-summary-left';

    const groupCheckbox = document.createElement('input');
    groupCheckbox.type = 'checkbox';
    groupCheckbox.checked = totalInGroup > 0 && enabledCountInGroup === totalInGroup;
    groupCheckbox.indeterminate = enabledCountInGroup > 0 && enabledCountInGroup < totalInGroup;
    groupCheckbox.addEventListener('click', (event) => {
        event.stopPropagation();
    });
    groupCheckbox.addEventListener('change', () => {
        if (groupCheckbox.checked) {
            for (const name of toolNames) enabledSet.add(name);
        } else {
            for (const name of toolNames) enabledSet.delete(name);
        }
        onToolsChange(Array.from(enabledSet));
    });

    const groupTitle = document.createElement('div');
    groupTitle.className = 'mcp-tool-group-title';
    groupTitle.textContent = groupName === UNGROUPED_TOOLS_KEY ? t('mcpOtherTools') : groupName;

    left.appendChild(groupCheckbox);
    left.appendChild(groupTitle);

    const right = document.createElement('div');
    right.className = 'mcp-tool-group-count';
    right.textContent = `${enabledCountInGroup}/${totalInGroup}`;

    summary.appendChild(left);
    summary.appendChild(right);

    const list = document.createElement('div');
    list.className = 'mcp-tool-group-list';

    for (const tool of tools) {
        list.appendChild(renderToolRow(tool, enabledSet, onToolsChange));
    }

    details.appendChild(summary);
    details.appendChild(list);
    return details;
}

export function renderMcpToolsUI({
    server,
    tools,
    search,
    summaryElement,
    listElement,
    uiState,
    onToolsChange,
}) {
    const toolMode = server.toolMode === 'selected' ? 'selected' : 'all';
    const enabledSet = new Set(Array.isArray(server.enabledTools) ? server.enabledTools : []);
    const cached = Array.isArray(tools) ? tools : [];

    summaryElement.textContent = getMcpToolsSummaryText({
        server,
        tools: cached,
        toolMode,
        enabledSet,
    });

    listElement.innerHTML = '';

    if (toolMode === 'all') {
        listElement.appendChild(createHelpText(t('mcpSwitchToSelected')));
        return;
    }

    if (cached.length === 0) {
        listElement.appendChild(createHelpText(t('mcpNoToolsLoaded')));
        return;
    }

    const container = document.createElement('div');
    container.className = 'mcp-tool-selection';

    const handleToolsChange = (enabledTools) => {
        server.enabledTools = enabledTools;
        onToolsChange();
    };

    for (const group of groupMcpTools(cached, search)) {
        container.appendChild(
            renderToolGroup(group.name, group.tools, enabledSet, uiState, handleToolsChange)
        );
    }

    listElement.appendChild(container);
}
