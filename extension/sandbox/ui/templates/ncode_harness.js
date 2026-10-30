import { TemplateIcons } from './icons.js';

export const NcodeHarnessTemplate = `
    <!-- NCODE HARNESS BAR -->
    <div id="ncode-harness-bar" class="ncode-harness-bar" role="region" aria-label="Ncode goal and PC harness status">
        <div class="ncode-harness-row">
            <div class="ncode-harness-cluster ncode-harness-left">
                <span id="ncode-gemini-status" class="ncode-status-pill is-unknown" title="Gemini Web session (gemini.google.com)">
                    <span class="ncode-status-dot" aria-hidden="true"></span>
                    <span class="ncode-status-text">Gemini Web (Checking)</span>
                </span>
                <span id="ncode-pc-status" class="ncode-status-pill is-unknown" title="PC Shell MCP daemon (127.0.0.1:3001)">
                    <span class="ncode-status-dot" aria-hidden="true"></span>
                    <span class="ncode-status-text">PC Shell MCP (Checking)</span>
                </span>
                <span id="ncode-bridge-status" class="ncode-status-pill is-unknown" title="WS Bridge (127.0.0.1:8085)">
                    <span class="ncode-status-dot" aria-hidden="true"></span>
                    <span class="ncode-status-text">WS Bridge (Checking)</span>
                </span>
                <button id="ncode-goal-mode-toggle" class="ncode-toggle-btn is-on" type="button" aria-pressed="true" title="Toggle Astra Goal Loop autonomy" aria-label="Toggle Goal Loop autonomy">
                    ${TemplateIcons.ZAP}
                    <span>Goal Loop</span>
                </button>
                <div id="ncode-preamble-ticker" class="ncode-preamble-ticker is-idle" title="Live Ncode preamble" aria-live="polite" aria-atomic="true" role="status">
                    <span class="ncode-preamble-label" aria-hidden="true">NCODE / PREAMBLE</span>
                    <span id="ncode-preamble-text" class="ncode-preamble-text">Idle</span>
                </div>
            </div>
            <div class="ncode-harness-cluster ncode-harness-right">
                <button id="ncode-goal-toggle" class="ncode-goal-toggle" type="button" aria-expanded="false" aria-controls="ncode-goal-panel" title="Toggle the subgoal checklist" hidden>
                    <span class="ncode-goal-toggle-label">Subgoals 0/0</span>
                    ${TemplateIcons.CHEVRON_DOWN}
                </button>
                <button id="ncode-compact-btn" class="ncode-compact-btn" type="button" title="Compact context and resume the goal loop" aria-label="Compact and resume">
                    ${TemplateIcons.REFRESH}
                    <span class="ncode-compact-label">Compact &amp; Resume</span>
                </button>
                <span id="ncode-compaction-status" class="ncode-compaction-status" role="status" aria-live="polite" hidden></span>
            </div>
        </div>
        <div id="ncode-approval" class="ncode-approval" role="alertdialog" aria-labelledby="ncode-approval-title" aria-describedby="ncode-approval-detail" hidden>
            <div class="ncode-approval-copy">
                <span id="ncode-approval-title" class="ncode-approval-title">Approval required</span>
                <span id="ncode-approval-detail" class="ncode-approval-detail"></span>
            </div>
            <div class="ncode-approval-actions">
                <button id="ncode-approval-approve" class="ncode-approval-btn is-approve" type="button">Approve</button>
                <button id="ncode-approval-deny" class="ncode-approval-btn is-deny" type="button">Deny</button>
            </div>
        </div>
        <div id="ncode-goal-panel" class="ncode-goal-panel" hidden>
            <div class="ncode-goal-panel-head">
                <span class="ncode-goal-panel-title">Astra Goal Loop</span>
                <span id="ncode-goal-meta" class="ncode-goal-meta"></span>
                <button id="ncode-goal-reset" class="ncode-goal-reset" type="button" title="Reset the goal state for this session" aria-label="Reset goal">Reset</button>
            </div>
            <div id="ncode-goal-root" class="ncode-goal-root"></div>
            <ul id="ncode-goal-list" class="ncode-goal-list" aria-label="Subgoals"></ul>
        </div>
    </div>
`;
