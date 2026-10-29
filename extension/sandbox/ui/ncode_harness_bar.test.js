// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NcodeHarnessBar } from './ncode_harness_bar.js';
import { renderLayout as renderSandboxLayout } from './layout.js';
import { NcodeHarnessTemplate } from './templates/ncode_harness.js';

const REQUIRED_SINGLE_IDS = [
    'ncode-harness-bar',
    'ncode-gemini-status',
    'ncode-pc-status',
    'ncode-goal-mode-toggle',
    'ncode-preamble-ticker',
    'ncode-preamble-text',
    'ncode-goal-toggle',
    'ncode-compact-btn',
    'ncode-goal-panel',
    'ncode-goal-root',
    'ncode-goal-list',
];

const SAMPLE_GOAL_SESSION = {
    workflowId: 'wf-1',
    rootGoal: 'Ship the Ncode harness',
    subgoals: [
        {
            id: 'goal-1',
            title: 'Wire the PC daemon',
            role: 'executor',
            status: 'done',
            evidence: 'smoke test passed',
        },
        {
            id: 'goal-2',
            title: 'Harden the sandbox UI',
            role: 'researcher',
            status: 'running',
            evidence: 'in progress',
        },
    ],
    iterationCount: 2,
    maxIterations: 30,
    status: 'running',
    completionMarked: false,
    createdAt: 100,
    updatedAt: 200,
};

function renderHarnessTemplate() {
    document.body.innerHTML = NcodeHarnessTemplate;
}

function createBar(options = {}) {
    const bar = new NcodeHarnessBar(options);
    bar.init();
    return bar;
}

function getElement(id) {
    return document.getElementById(id);
}

describe('NcodeHarnessTemplate', () => {
    it('renders every harness contract id exactly once', () => {
        renderHarnessTemplate();

        for (const id of REQUIRED_SINGLE_IDS) {
            expect(document.querySelectorAll(`#${id}`), id).toHaveLength(1);
        }
    });

    it('exposes the interactive controls as buttons with accessible metadata', () => {
        renderHarnessTemplate();

        const goalModeToggle = getElement('ncode-goal-mode-toggle');
        const goalToggle = getElement('ncode-goal-toggle');
        const compactButton = getElement('ncode-compact-btn');
        const preambleTicker = getElement('ncode-preamble-ticker');

        expect(goalModeToggle.getAttribute('type')).toBe('button');
        expect(goalModeToggle.getAttribute('aria-pressed')).toBe('true');
        expect(goalModeToggle.textContent).toContain('Goal Loop');
        expect(goalToggle.getAttribute('aria-expanded')).toBe('false');
        expect(goalToggle.getAttribute('aria-controls')).toBe('ncode-goal-panel');
        expect(goalToggle.hidden).toBe(true);
        expect(compactButton.getAttribute('type')).toBe('button');
        expect(compactButton.getAttribute('aria-label')).toBeTruthy();
        expect(preambleTicker.getAttribute('aria-live')).toBe('polite');
        expect(getElement('ncode-goal-panel').hidden).toBe(true);
    });
});

describe('sandbox layout integration', () => {
    it('places the harness bar between the header and the chat stream', () => {
        document.body.innerHTML = '<div id="app"></div>';
        renderSandboxLayout();

        const app = document.getElementById('app');
        const bar = document.getElementById('ncode-harness-bar');
        const header = app.querySelector('.header');
        const history = document.getElementById('chat-history');

        expect(bar).toBeTruthy();
        expect(header).toBeTruthy();
        expect(history).toBeTruthy();
        expect(header.compareDocumentPosition(bar) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
        expect(bar.compareDocumentPosition(history) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    });
});

describe('NcodeHarnessBar connection status', () => {
    beforeEach(() => {
        renderHarnessTemplate();
    });

    it('renders connected pills with green classes and endpoint derived port', () => {
        const bar = createBar();
        bar.setConnectionStatus({
            geminiWebConnected: true,
            geminiWebProvider: 'web',
            pcShellConnected: true,
            pcShellEndpoint: 'http://127.0.0.1:3001/mcp',
            pcShellToolCount: 8,
            updatedAt: 10,
        });

        const geminiPill = getElement('ncode-gemini-status');
        const pcPill = getElement('ncode-pc-status');

        expect(geminiPill.textContent).toContain('Gemini Web (Connected)');
        expect(geminiPill.classList.contains('is-connected')).toBe(true);
        expect(pcPill.textContent).toContain('PC Shell MCP (Port 3001 Connected)');
        expect(pcPill.classList.contains('is-connected')).toBe(true);
        expect(pcPill.title).toContain('8 tools available');
    });

    it('renders disconnected pills with the error as a tooltip', () => {
        const bar = createBar();
        bar.setConnectionStatus({
            geminiWebConnected: false,
            pcShellConnected: false,
            pcShellError: 'ECONNREFUSED 127.0.0.1:3001',
        });

        const geminiPill = getElement('ncode-gemini-status');
        const pcPill = getElement('ncode-pc-status');

        expect(geminiPill.textContent).toContain('Gemini Web (Disconnected)');
        expect(geminiPill.classList.contains('is-disconnected')).toBe(true);
        expect(pcPill.textContent).toContain('PC Shell MCP (Port 3001 Disconnected)');
        expect(pcPill.classList.contains('is-disconnected')).toBe(true);
        expect(pcPill.title).toContain('ECONNREFUSED');
    });
});

describe('NcodeHarnessBar preamble ticker', () => {
    beforeEach(() => {
        renderHarnessTemplate();
    });

    it('shows live preamble text and resets the ticker animation class', () => {
        const bar = createBar();
        bar.setPreamble({ sessionId: 'session-1', text: 'PLAN: inspect repo', ts: 5 });

        expect(getElement('ncode-preamble-text').textContent).toBe('PLAN: inspect repo');
        expect(getElement('ncode-preamble-ticker').classList.contains('is-idle')).toBe(false);
        expect(getElement('ncode-preamble-ticker').classList.contains('is-updated')).toBe(true);
    });

    it('falls back to the Idle placeholder when the preamble is empty', () => {
        const bar = createBar();
        bar.setPreamble({ text: '' });

        expect(getElement('ncode-preamble-text').textContent).toBe('Idle');
        expect(getElement('ncode-preamble-ticker').classList.contains('is-idle')).toBe(true);
    });
});

describe('NcodeHarnessBar goal session rendering', () => {
    beforeEach(() => {
        renderHarnessTemplate();
    });

    it('shows the subgoal checklist, counts, roles and statuses', () => {
        const bar = createBar();
        bar.setGoalSession(SAMPLE_GOAL_SESSION, 'session-1');

        const goalToggle = getElement('ncode-goal-toggle');
        const panel = getElement('ncode-goal-panel');
        const rows = getElement('ncode-goal-list').querySelectorAll('.ncode-goal-row');

        expect(goalToggle.hidden).toBe(false);
        expect(goalToggle.textContent).toContain('Subgoals 1/2');
        expect(goalToggle.getAttribute('aria-expanded')).toBe('true');
        expect(panel.hidden).toBe(false);
        expect(getElement('ncode-goal-root').textContent).toBe('Ship the Ncode harness');
        expect(getElement('ncode-goal-meta').textContent).toContain('Iteration 2/30');
        expect(rows).toHaveLength(2);
        expect(rows[0].classList.contains('is-done')).toBe(true);
        expect(rows[1].classList.contains('is-running')).toBe(true);
        expect(rows[0].querySelector('.ncode-goal-role').textContent).toBe('executor');
        expect(rows[0].querySelector('.ncode-goal-title').title).toBe('smoke test passed');
    });

    it('toggles the checklist and persists the collapsed preference', () => {
        const bar = createBar();
        bar.setGoalSession(SAMPLE_GOAL_SESSION, 'session-1');

        getElement('ncode-goal-toggle').click();
        expect(getElement('ncode-goal-panel').hidden).toBe(true);
        expect(getElement('ncode-goal-toggle').getAttribute('aria-expanded')).toBe('false');
        expect(localStorage.getItem('ncodeHarnessCollapsed')).toBe('true');

        getElement('ncode-goal-toggle').click();
        expect(getElement('ncode-goal-panel').hidden).toBe(false);
        expect(localStorage.getItem('ncodeHarnessCollapsed')).toBe('false');
    });

    it('restores the collapsed preference on init', () => {
        localStorage.setItem('ncodeHarnessCollapsed', 'true');
        const bar = createBar();
        bar.setGoalSession(SAMPLE_GOAL_SESSION, 'session-1');

        expect(getElement('ncode-goal-panel').hidden).toBe(true);
        expect(getElement('ncode-goal-toggle').getAttribute('aria-expanded')).toBe('false');
    });

    it('hides the checklist when the goal session is cleared', () => {
        const bar = createBar();
        bar.setGoalSession(SAMPLE_GOAL_SESSION, 'session-1');
        bar.setGoalSession(null);

        expect(getElement('ncode-goal-toggle').hidden).toBe(true);
        expect(getElement('ncode-goal-panel').hidden).toBe(true);
        expect(getElement('ncode-goal-list').children).toHaveLength(0);
    });

    it('renders goal text as text content only (XSS safe)', () => {
        const bar = createBar();
        bar.setGoalSession({
            ...SAMPLE_GOAL_SESSION,
            rootGoal: '<img src=x onerror="alert(1)">',
            subgoals: [
                {
                    id: 'goal-x',
                    title: '<script>alert(1)</script>',
                    role: 'executor',
                    status: 'pending',
                },
            ],
        });

        expect(getElement('ncode-goal-root').querySelector('img')).toBeNull();
        expect(getElement('ncode-goal-root').textContent).toBe('<img src=x onerror="alert(1)">');
        const rowTitle = getElement('ncode-goal-list').querySelector('.ncode-goal-title');
        expect(rowTitle.querySelector('script')).toBeNull();
        expect(rowTitle.textContent).toBe('<script>alert(1)</script>');
    });
});

describe('NcodeHarnessBar compaction and goal mode', () => {
    beforeEach(() => {
        renderHarnessTemplate();
    });

    it('disables the compact button while compacting and restores it when done', () => {
        const bar = createBar();
        bar.setCompactionState({ sessionId: 'session-1', state: 'compacting', detail: 'Pruning' });

        const button = getElement('ncode-compact-btn');
        expect(button.disabled).toBe(true);
        expect(button.textContent).toContain('Compacting…');
        expect(button.getAttribute('aria-busy')).toBe('true');
        expect(getElement('ncode-compaction-status').hidden).toBe(false);

        bar.setCompactionState({ sessionId: 'session-1', state: 'done', detail: 'Complete' });
        expect(button.disabled).toBe(false);
        expect(button.textContent).toContain('Compact & Resume');
        bar.clearCompactionTimers();
    });

    it('treats the background "requested" phase as busy and formats object detail', () => {
        const bar = createBar();
        bar.setCompactionState({
            sessionId: 'session-1',
            state: 'requested',
            detail: { reason: 'manual', messageCount: 24 },
        });

        const status = getElement('ncode-compaction-status');
        expect(getElement('ncode-compact-btn').disabled).toBe(true);
        expect(status.hidden).toBe(false);
        expect(status.textContent).toContain('manual');
        expect(status.textContent).toContain('24 messages');
        bar.clearCompactionTimers();
    });

    it('surfaces a failed compaction as retry state', () => {
        const bar = createBar();
        bar.setCompactionState({ sessionId: 'session-1', state: 'failed', detail: 'Chat missing' });

        const button = getElement('ncode-compact-btn');
        expect(button.disabled).toBe(false);
        expect(button.textContent).toContain('Retry Compact');
        expect(getElement('ncode-compaction-status').textContent).toBe('Chat missing');
        expect(getElement('ncode-compaction-status').classList.contains('is-error')).toBe(true);
    });

    it('defaults Goal Loop on and emits the change event on toggle', () => {
        const bar = createBar();
        const changes = [];
        document.addEventListener('ncode-goal-mode-changed', (event) => {
            changes.push(event.detail);
        });

        expect(bar.isGoalModeEnabled()).toBe(true);
        expect(getElement('ncode-goal-mode-toggle').getAttribute('aria-pressed')).toBe('true');

        getElement('ncode-goal-mode-toggle').click();

        expect(bar.isGoalModeEnabled()).toBe(false);
        expect(getElement('ncode-goal-mode-toggle').getAttribute('aria-pressed')).toBe('false');
        expect(localStorage.getItem('ncodeGoalModeEnabled')).toBe('false');
        expect(changes).toEqual([{ enabled: false }]);
    });

    it('restores the persisted Goal Loop preference on init', () => {
        localStorage.setItem('ncodeGoalModeEnabled', 'false');
        const bar = createBar();

        expect(bar.isGoalModeEnabled()).toBe(false);
        expect(getElement('ncode-goal-mode-toggle').getAttribute('aria-pressed')).toBe('false');
    });
});

describe('NcodeHarnessBar request plumbing', () => {
    beforeEach(() => {
        renderHarnessTemplate();
    });

    it('requests the initial state exactly once', () => {
        const postMessageSpy = vi.spyOn(window.parent, 'postMessage');
        const bar = createBar();

        bar.requestInitialState();
        bar.requestInitialState();

        expect(postMessageSpy).toHaveBeenCalledTimes(1);
        expect(postMessageSpy).toHaveBeenCalledWith({ action: 'NCODE_GET_STATE' }, '*');
        postMessageSpy.mockRestore();
    });

    it('posts compact/reset requests with the active session id', () => {
        const postMessageSpy = vi.spyOn(window.parent, 'postMessage');
        const bar = createBar();
        bar.setGoalSession(SAMPLE_GOAL_SESSION, 'session-7');

        bar.requestCompactResume();

        expect(postMessageSpy).toHaveBeenCalledWith(
            {
                action: 'NCODE_COMPACT_RESUME',
                payload: { sessionId: 'session-7', force: true },
            },
            '*'
        );
        expect(getElement('ncode-compact-btn').disabled).toBe(true);
        bar.clearCompactionTimers();

        bar.requestResetGoal();
        expect(postMessageSpy).toHaveBeenCalledWith(
            { action: 'NCODE_RESET_GOAL', payload: { sessionId: 'session-7' } },
            '*'
        );
        postMessageSpy.mockRestore();
    });

    it('prefers injected callbacks over parent posts', () => {
        const onCompactResume = vi.fn();
        const onResetGoal = vi.fn();
        const postMessageSpy = vi.spyOn(window.parent, 'postMessage');
        const bar = createBar({ callbacks: { onCompactResume, onResetGoal } });
        bar.setGoalSession(SAMPLE_GOAL_SESSION, 'session-3');

        bar.requestCompactResume();
        bar.clearCompactionTimers();
        bar.requestResetGoal();

        expect(onCompactResume).toHaveBeenCalledWith({ sessionId: 'session-3', force: true });
        expect(onResetGoal).toHaveBeenCalledWith({ sessionId: 'session-3' });
        expect(postMessageSpy).not.toHaveBeenCalled();
        postMessageSpy.mockRestore();
    });
});
