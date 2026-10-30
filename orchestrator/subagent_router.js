/**
 * Ncode Astra — four-role subagent router.
 *
 * Ncode drives an autonomous agent loop from the user's own logged-in
 * gemini.google.com web session. `goal_state_machine.js` owns the flat three-milestone
 * goal loop; this module owns the decomposition and routing layer above it:
 *
 *   planner            decomposes the root goal into an acyclic subgoal DAG
 *   pc_coder           executes local PC / IDE / git work through the pc_* tools
 *   browser_operator   drives the browser through the Gemini-Nexus control actions
 *   verifier           refuses completion until recorded evidence proves the work
 *
 * The planner emits its plan inside
 * `<ncode_goal_plan>[{"id","title","role","dependsOn","successCriteria","tools"}]</ncode_goal_plan>`;
 * the verifier guards `<ncode_goal_complete>true</ncode_goal_complete>`. Both tags are
 * parsed here with strict JSON recovery from fenced, prose-wrapped or HTML-escaped model
 * output, because Gemini Web renders markdown and can mangle angle brackets.
 *
 * The module is pure ESM with zero imports so the exact same bytes can be mirrored to
 * `extension/shared/orchestrator/subagent_router.js` and executed by the Chrome MV3
 * service worker. Every other orchestrator helper (goal state machine, compaction
 * engine) follows the same source-of-truth + mirror convention.
 *
 * The goal-session shape produced by {@link createGoalSession},
 * {@link toHarnessSnapshot} and {@link hydrateState} matches the extension
 * `NcodeHarnessBar` contract exactly:
 * `{ workflowId, rootGoal, subgoals: [{ id, title, role, status, evidence }],
 * iterationCount, maxIterations, status, completionMarked, createdAt, updatedAt }`.
 *
 * @module orchestrator/subagent_router
 */

/**
 * @typedef {'planner' | 'pc_coder' | 'browser_operator' | 'verifier'} GoalRole
 * @typedef {'pending' | 'running' | 'done' | 'failed'} SubgoalStatus
 * @typedef {'active' | 'compacting' | 'paused' | 'completed' | 'failed'} GoalStatus
 */

/**
 * @typedef {object} PlanNode
 * @property {string} id Stable lowercase subgoal id, unique inside one plan.
 * @property {string} title Short imperative description of the deliverable.
 * @property {GoalRole} role Capability lane that owns the step.
 * @property {string[]} dependsOn Ids that must be done before this step may start.
 * @property {string} successCriteria Objective proof the verifier will demand.
 * @property {string[]} tools Tool names from the role whitelist.
 */

/**
 * @typedef {object} RouterSubgoal
 * @property {string} id
 * @property {string} title
 * @property {GoalRole} role
 * @property {SubgoalStatus} status
 * @property {string} evidence Serialized evidence; it carries a leading check mark when
 *   {@link verifySubgoalCompletion} accepted it.
 * @property {string[]} dependsOn
 * @property {string} successCriteria
 * @property {string[]} tools
 * @property {number} attempts Number of reported results for this subgoal.
 * @property {string} lastError Most recent refusal or failure reason.
 */

/**
 * @typedef {object} GoalSession
 * @property {string} workflowId Durable workflow id shared with checkpoint storage.
 * @property {string} rootGoal The user's requested end state, restated to the model.
 * @property {RouterSubgoal[]} subgoals Planned subgoals in topological order.
 * @property {number} iterationCount Completed goal-loop iterations.
 * @property {number} maxIterations Hard iteration cap.
 * @property {GoalStatus} status
 * @property {boolean} completionMarked
 * @property {number} createdAt Epoch milliseconds.
 * @property {number} updatedAt Epoch milliseconds.
 * @property {string} [failureReason] Present only when a transition recorded one.
 */

/**
 * @typedef {object} SubgoalEvidence
 * @property {string} summary Human-readable claim.
 * @property {string} command Exact command that was executed, when any.
 * @property {number|null} exitCode Real terminal exit code, when any.
 * @property {string[]} changedFiles Files modified by the step.
 * @property {string} gitDiff Real diff text proving the file change.
 * @property {{ path?: string, dataUrl?: string, base64?: string, bytes?: number|null }|null} screenshot
 * @property {Array<{ name: string, ok: boolean }>} toolCalls Tools that ran for the step.
 * @property {boolean} browserSteps Whether browser control actions ran.
 * @property {string[]} failures Explicit failure notes.
 */

/** Roles that make up the four-role harness. */
export const GOAL_ROLES = Object.freeze(['planner', 'pc_coder', 'browser_operator', 'verifier']);

/** Subgoal lifecycle: pending -> running -> done | failed (failed may retry to pending). */
export const SUBGOAL_STATUSES = Object.freeze(['pending', 'running', 'done', 'failed']);

/**
 * Goal statuses. The vocabulary is a superset of the router's own transitions so a
 * session produced by the goal-state machine (including `compacting`) can be hydrated.
 */
export const GOAL_STATUSES = Object.freeze([
    'active',
    'compacting',
    'paused',
    'completed',
    'failed',
]);

/** Planner plan tag. */
export const GOAL_PLAN_TAG = 'ncode_goal_plan';
/** Milestone update tag shared with the goal-state machine. */
export const GOAL_UPDATE_TAG = 'ncode_goal_update';
/** Explicit completion tag. */
export const GOAL_COMPLETE_TAG = 'ncode_goal_complete';
/** Real-time status line tag. */
export const PREAMBLE_TAG = 'ncode_preamble';

/** Leading marker of evidence records this module verified. */
export const VERIFIED_EVIDENCE_MARKER = '\u2713';

/** Default goal-loop iteration cap. */
export const DEFAULT_MAX_ITERATIONS = 30;

/** Default number of reported results a subgoal may fail before it is terminal. */
export const DEFAULT_MAX_ATTEMPTS = 3;

/** Hard cap on planner subgoal count; a plan is a decomposition, not a transcript. */
export const MAX_PLAN_SUBGOALS = 24;

/** Version written into {@link SubagentRouter#serializeState} payloads. */
export const SERIALIZED_STATE_VERSION = 1;

const MAX_SUBGOAL_ID_CHARS = 64;
const MAX_TITLE_CHARS = 300;
const MAX_SUCCESS_CRITERIA_CHARS = 1000;
const MAX_EVIDENCE_CHARS = 2000;
const MAX_LAST_ERROR_CHARS = 1000;
const SUBGOAL_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const ROLE_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * Tool whitelist for the PC coder lane. These are the local PC daemon / IDE tool names
 * (implemented by pc-daemon); the router only references them. The local MCP server id
 * is `ncode-pc-daemon`, so namespaced calls surface as
 * `ncode-pc-daemon__pc_exec_shell` at the MCP boundary.
 */
export const PC_CODER_TOOL_NAMES = Object.freeze([
    'pc_exec_shell',
    'pc_bg_process',
    'pc_shell_session',
    'pc_fs_tree',
    'pc_fs_read',
    'pc_fs_write',
    'pc_fs_patch',
    'pc_search_code',
    'pc_git_status_diff',
    'pc_git_status',
    'pc_git_diff',
    'pc_git_add',
    'pc_git_commit',
    'pc_git_checkout',
    'pc_git_log',
    'pc_desktop_screenshot',
    'pc_clipboard',
]);

/**
 * Browser control tool names exposed by the extension's internal Gemini-Nexus action
 * dispatcher (`extension/background/control/dispatcher.js`, `LOCAL_TOOL_NAMES` plus its
 * `TOOL_METHOD_MAP`). The first five entries are the DOM snapshot / click / fill /
 * evaluate / screenshot primitives the browser operator relies on.
 */
export const BROWSER_TOOL_NAMES = Object.freeze([
    'take_snapshot',
    'click',
    'fill',
    'fill_form',
    'evaluate_script',
    'take_screenshot',
    'navigate_page',
    'new_page',
    'close_page',
    'list_pages',
    'select_page',
    'hover',
    'press_key',
    'type_text',
    'attach_file',
    'drag',
    'scroll',
    'wait_for',
    'wait_for_url',
    'wait_for_load_state',
    'wait_for_timeout',
    'handle_dialog',
    'list_downloads',
    'wait_for_download',
    'run_steps',
]);

/**
 * Per-role tool whitelists. A subgoal that lists tools outside its role whitelist has
 * those tools dropped during plan validation, so the model can never widen its own
 * capability lane.
 */
export const ROLE_TOOL_WHITELISTS = Object.freeze({
    planner: Object.freeze([
        'pc_fs_tree',
        'pc_fs_read',
        'pc_search_code',
        'take_snapshot',
        'take_screenshot',
    ]),
    pc_coder: PC_CODER_TOOL_NAMES,
    browser_operator: BROWSER_TOOL_NAMES,
    verifier: Object.freeze([
        'pc_exec_shell',
        'pc_fs_read',
        'pc_search_code',
        'pc_git_status',
        'pc_git_diff',
        'pc_git_status_diff',
        'take_snapshot',
        'take_screenshot',
        'evaluate_script',
    ]),
});

/** Planner prompt: root goal -> acyclic subgoal DAG inside `<ncode_goal_plan>`. */
const PLANNER_PROMPT = `You are the Ncode planner agent: the decomposition stage of a four-role
harness that drives the user's own logged-in gemini.google.com web session. You own ONE
job — turn the root goal into a small, acyclic dependency graph of executable subgoals.
You do not execute the work yourself.

Emit exactly one plan inside the tag:

<ncode_goal_plan>[{"id":"inspect_repo","title":"Inspect the repository layout","role":"planner","dependsOn":[],"successCriteria":"The relevant files, commands and constraints are listed.","tools":["pc_fs_tree","pc_fs_read"]}]</ncode_goal_plan>

Rules for the plan:
- 2 to 10 subgoals; each one is a concrete deliverable, not a vague theme.
- ids are unique snake_case tokens such as inspect_repo or patch_router.
- dependsOn lists only ids defined in the same plan; a root step has an empty list.
- The graph must be acyclic. A step may start only after every dependency is done.
- role picks the capability lane: planner for inspection and re-planning, pc_coder for
  local files, shell and git, browser_operator for driving the browser UI, verifier for
  the final independent check.
- tools is optional; omit it to grant the full whitelist of the role. When present it
  may only list tools from that role whitelist.
- successCriteria is the objective, checkable proof the verifier will demand, for example
  "pc_exec_shell returns exit code 0 for npm test in the repository root".
- A plan that changes files ends with a verifier subgoal that depends on the work steps.
- Never report progress or completion in this message. Emit the plan tag and stop.`;

/** PC coder prompt: local files, shell, git and desktop through the pc_* tools. */
const PC_CODER_PROMPT = `You are the Ncode PC coder agent: the local-machine execution lane of a
four-role harness. You act through the pc_* tools on the user's real computer: files,
shell commands, background processes, git and desktop access.

Operating rules:
- Read before writing. Use pc_fs_tree, pc_search_code and pc_fs_read to understand the
  code, then pc_fs_patch (preferred) or pc_fs_write to change it.
- Run commands with pc_exec_shell; use pc_bg_process for long-lived servers and logs.
- Record the real result of every action: the exact command, the real stdout/stderr and
  the real numeric exit code. Never guess or paraphrase an exit code.
- After changing files run pc_git_status_diff and quote the real diff. A claimed change
  without a diff is not verifiable.
- Stay inside the requested scope. Do not rewrite unrelated files and do not run
  destructive commands the user did not ask for.
- If a tool fails, report the exact error text as evidence instead of inventing success.`;

/** Browser operator prompt: drive the browser through the internal control actions. */
const BROWSER_OPERATOR_PROMPT = `You are the Ncode browser operator agent: the browser-driving lane of
a four-role harness. You control the user's real browser through the extension's internal
browser-control tools (the same Gemini-Nexus action dispatcher the sidepanel uses). You
never fabricate page state.

Operating rules:
- Observe before acting. take_snapshot returns the accessible DOM tree; read the snapshot
  and use the returned element positions before you click or fill.
- Act one step at a time. After every mutating action confirm the outcome with another
  snapshot, wait_for or wait_for_load_state.
- Use click, fill, fill_form, press_key and type_text for input, scroll and drag for
  movement, navigate_page / new_page / list_pages / select_page for tabs, and
  evaluate_script only for inspection or measurement.
- Capture take_screenshot as visual evidence for every completed browser step, and keep
  the returned screenshot path or data URL.
- If a dialog opens, handle_dialog it before continuing.
- Never invent a screenshot or a page state: if a step did not visibly finish, report
  the failure with the real observed output.`;

/** Verifier prompt: independent evidence gate before the completion tag. */
const VERIFIER_PROMPT = `You are the Ncode verifier agent: the independent gate between "the model says the
work is done" and the explicit completion tag. You never trust a claim; you check
evidence.

Checklist:
1. Terminal evidence: every command that mattered reports its real exit code and that
   code is 0. A missing or non-zero exit code is a refusal.
2. File-change evidence: when files changed, a non-empty git diff is recorded.
3. Browser evidence: when browser control steps ran, a screenshot path or data URL is
   recorded.
4. Tool evidence: the tool calls that produced the result are listed and none failed
   silently.
5. Truth: the evidence describes what actually happened, not what was expected.

Rules:
- If any check fails, refuse completion, record the exact missing proof, and mark the
  target subgoal failed with that reason.
- Only when every subgoal is done and every check above passes may you emit the
  completion tag <ncode_goal_complete>true</ncode_goal_complete>. Never emit it to make
  the loop stop, and never emit it early.`;

/**
 * Role prompt fragments. The extension goal manager and the router both consume these so
 * the four role contracts have a single source of truth.
 */
export const ROLE_PROMPTS = Object.freeze({
    planner: PLANNER_PROMPT,
    pc_coder: PC_CODER_PROMPT,
    browser_operator: BROWSER_OPERATOR_PROMPT,
    verifier: VERIFIER_PROMPT,
});

const HTML_ENTITY_MAP = Object.freeze({
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&apos;': "'",
    '&#39;': "'",
    '&#34;': '"',
    '&#60;': '<',
    '&#62;': '>',
    '&amp;': '&',
});
const HTML_ENTITY_PATTERN = /&(?:lt|gt|quot|apos|amp|#0*34|#0*39|#0*60|#0*62);/gi;
const HTML_ENTITY_TAG_HINT = /&lt;\s*ncode_/i;

// Small shared helpers

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function toTrimmedString(value) {
    return typeof value === 'string' ? value.trim() : '';
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {string}
 */
function requireTrimmedString(value, label) {
    const text = toTrimmedString(value);
    if (!text) throw new TypeError(`${label} must be a non-empty string.`);
    return text;
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function toErrorMessage(error) {
    return error && error.message ? String(error.message) : String(error);
}

/**
 * Collapses arbitrary text to one printable line.
 * @param {unknown} value
 * @returns {string}
 */
function formatInline(value) {
    if (value === null || value === undefined) return '';
    return String(value).replace(/\s+/g, ' ').trim();
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @param {string} label
 * @returns {number}
 */
function normalizePositiveInteger(value, fallback, label) {
    if (value === undefined || value === null) return fallback;
    if (!Number.isInteger(value) || value < 1) {
        throw new TypeError(`${label} must be a positive integer.`);
    }
    return value;
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @param {string} label
 * @returns {number}
 */
function normalizeNonNegativeInteger(value, fallback, label) {
    if (value === undefined || value === null) return fallback;
    if (!Number.isInteger(value) || value < 0) {
        throw new TypeError(`${label} must be a non-negative integer.`);
    }
    return value;
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function normalizeTimestamp(value, fallback) {
    if (Number.isFinite(value)) return Math.trunc(value);
    if (typeof value === 'string' && value.trim()) {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) return Math.trunc(parsed);
    }
    return fallback;
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {string[]}
 */
function normalizeToolNames(value, label) {
    if (!Array.isArray(value)) {
        throw new TypeError(`${label} must be an array of tool names.`);
    }
    const names = [];
    for (const entry of value) {
        const name = requireTrimmedString(entry, `${label} entries`);
        if (!names.includes(name)) names.push(name);
    }
    return names;
}

/**
 * @param {unknown} value
 * @returns {string[]}
 */
function normalizeStringList(value) {
    if (value === null || value === undefined) return [];
    const entries = Array.isArray(value) ? value : [value];
    const result = [];
    for (const entry of entries) {
        const text = formatInline(entry).slice(0, 500);
        if (text && !result.includes(text)) result.push(text);
    }
    return result;
}

/**
 * Decodes the small HTML entity subset Gemini Web emits around markdown text.
 * @param {string} text
 * @returns {string}
 */
function decodeHtmlEntities(text) {
    return text.replace(HTML_ENTITY_PATTERN, (entity) => {
        const normalized = entity.toLowerCase().replace(/&#0+/, '&#').replace(/&#x0+/, '&#x');
        return HTML_ENTITY_MAP[entity] || HTML_ENTITY_MAP[normalized] || entity;
    });
}

/**
 * Returns every closed `<tag>...</tag>` body, in order.
 * @param {string} text
 * @param {string} tagName
 * @returns {string[]}
 */
function collectClosedTagContents(text, tagName) {
    const pattern = new RegExp(`<${tagName}>([\\s\\S]*?)<\\/${tagName}>`, 'gi');
    const contents = [];
    let match = pattern.exec(text);
    while (match) {
        contents.push(match[1]);
        match = pattern.exec(text);
    }
    return contents;
}

/**
 * @param {string} text
 * @returns {string[]}
 */
function collectFencedCodeBlocks(text) {
    const pattern = /`{3,}[ \t]*(?:json|javascript|js)?\s*\n?([\s\S]*?)`{3,}/gi;
    const blocks = [];
    let match = pattern.exec(text);
    while (match) {
        blocks.push(match[1]);
        match = pattern.exec(text);
    }
    return blocks;
}

/**
 * Finds the first plan-shaped JSON array embedded in free-form model text.
 *
 * A plan is an array of objects, so arrays of scalars (for example a prose "[1]" or
 * "[note]" marker) are only used as a last resort; this keeps prose brackets from
 * shadowing the real plan.
 *
 * @param {string} text
 * @returns {string|null}
 */
function extractJsonArrayText(text) {
    const source = typeof text === 'string' ? text : '';
    let scalarFallback = null;
    for (let index = source.indexOf('['); index !== -1; index = source.indexOf('[', index + 1)) {
        const end = findMatchingJsonEnd(source, index);
        if (end === -1) continue;
        const candidate = source.slice(index, end);
        try {
            const parsed = JSON.parse(candidate);
            if (!Array.isArray(parsed)) continue;
            if (parsed.length === 0 || isPlainObject(parsed[0])) return candidate;
            if (scalarFallback === null) scalarFallback = candidate;
        } catch {
            // Not JSON by itself: keep scanning for a parseable candidate.
        }
    }
    return scalarFallback;
}

/**
 * Returns the index just past the JSON value that starts at `start`, or -1.
 * @param {string} text
 * @param {number} start
 * @returns {number}
 */
function findMatchingJsonEnd(text, start) {
    const opening = text[start];
    const closing = opening === '[' ? ']' : opening === '{' ? '}' : '';
    if (!closing) return -1;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < text.length; index += 1) {
        const char = text[index];
        if (inString) {
            if (escaped) escaped = false;
            else if (char === '\\') escaped = true;
            else if (char === '"') inString = false;
            continue;
        }
        if (char === '"') {
            inString = true;
            continue;
        }
        if (char === opening) depth += 1;
        else if (char === closing) {
            depth -= 1;
            if (depth === 0) return index + 1;
        }
    }
    return -1;
}

/**
 * Determines the topological order of plan nodes with a stable layer scan.
 * @param {Array<{ id: string, dependsOn: string[] }>} nodes
 * @returns {{ order: string[], cycleIds: string[] }}
 */
function topologicalOrder(nodes) {
    const resolvedIds = new Set();
    const order = [];
    let progressed = true;
    while (order.length < nodes.length && progressed) {
        progressed = false;
        for (const node of nodes) {
            if (resolvedIds.has(node.id)) continue;
            const ready = node.dependsOn.every((dependency) => resolvedIds.has(dependency));
            if (!ready) continue;
            resolvedIds.add(node.id);
            order.push(node.id);
            progressed = true;
        }
    }
    const cycleIds = nodes.filter((node) => !resolvedIds.has(node.id)).map((node) => node.id);
    return { order, cycleIds };
}

// Plan parsing, validation and serialization

/**
 * Recovers a planner DAG from one model response.
 *
 * Recovery order is: closed `<ncode_goal_plan>` tag body (also when Gemini Web
 * HTML-escaped the angle brackets), then fenced ```json blocks, then the first JSON
 * array embedded in prose. Malformed input never throws; it is reported through
 * `errors` so the loop can ask the planner to re-emit the plan.
 *
 * @param {unknown} rawModelText
 * @returns {{
 *   ok: boolean,
 *   plan: unknown[] | null,
 *   jsonText: string | null,
 *   source: 'tag' | 'fence' | 'prose' | null,
 *   errors: string[],
 *   warnings: string[],
 *   raw: string
 * }}
 */
export function parseGoalPlan(rawModelText) {
    const raw = typeof rawModelText === 'string' ? rawModelText : '';
    const warnings = [];
    const errors = [];
    if (!raw.trim()) {
        return {
            ok: false,
            plan: null,
            jsonText: null,
            source: null,
            errors: ['The model text is empty; no plan can be recovered.'],
            warnings,
            raw,
        };
    }

    let sourceText = raw;
    let tagContents = collectClosedTagContents(sourceText, GOAL_PLAN_TAG);
    if (tagContents.length === 0 && HTML_ENTITY_TAG_HINT.test(raw)) {
        const decoded = decodeHtmlEntities(raw);
        const decodedContents = collectClosedTagContents(decoded, GOAL_PLAN_TAG);
        if (decodedContents.length > 0) {
            tagContents = decodedContents;
            sourceText = decoded;
        }
    }

    let jsonText = null;
    let source = null;
    if (tagContents.length > 0) {
        for (const content of tagContents) {
            const candidate = extractJsonArrayText(content);
            if (candidate) {
                jsonText = candidate;
                source = 'tag';
                break;
            }
        }
        if (!jsonText) {
            warnings.push(`The <${GOAL_PLAN_TAG}> tag did not contain a JSON array.`);
        }
    }

    if (!jsonText) {
        for (const block of collectFencedCodeBlocks(sourceText)) {
            const candidate = extractJsonArrayText(block);
            if (candidate) {
                jsonText = candidate;
                source = 'fence';
                break;
            }
        }
    }

    if (!jsonText) {
        const candidate = extractJsonArrayText(sourceText);
        if (candidate) {
            jsonText = candidate;
            source = 'prose';
        }
    }

    if (!jsonText) {
        errors.push(`No JSON array could be recovered for <${GOAL_PLAN_TAG}>.`);
        return { ok: false, plan: null, jsonText: null, source: null, errors, warnings, raw };
    }

    try {
        const parsed = JSON.parse(jsonText);
        if (!Array.isArray(parsed)) {
            errors.push('The recovered goal plan JSON is not an array.');
            return { ok: false, plan: null, jsonText, source, errors, warnings, raw };
        }
        return { ok: true, plan: parsed, jsonText, source, errors: [], warnings, raw };
    } catch (error) {
        errors.push(`Malformed goal plan JSON: ${toErrorMessage(error)}`);
        return { ok: false, plan: null, jsonText, source, errors, warnings, raw };
    }
}

/**
 * @param {GoalRole} roleName
 * @param {{ whitelists?: object|Map<string, readonly string[]> }} [options]
 * @returns {readonly string[]}
 */
function resolveWhitelist(roleName, options = {}) {
    const whitelists = options.whitelists;
    if (whitelists instanceof Map && whitelists.has(roleName)) {
        return whitelists.get(roleName) || [];
    }
    if (isPlainObject(whitelists) && Array.isArray(whitelists[roleName])) {
        return whitelists[roleName];
    }
    return ROLE_TOOL_WHITELISTS[roleName] || [];
}

/**
 * Validates and canonicalizes raw plan nodes.
 *
 * Semantic problems (missing fields, unknown roles, unknown or cyclic dependencies,
 * duplicate ids) are returned in `errors` so a model repair turn can be requested.
 * Non-array input is a programming error and throws.
 *
 * @param {unknown} rawNodes
 * @param {{ roles?: readonly string[], whitelists?: object|Map<string, readonly string[]> }} [options]
 * @returns {{
 *   ok: boolean,
 *   nodes: PlanNode[],
 *   order: string[],
 *   errors: string[],
 *   warnings: string[]
 * }}
 */
export function validateGoalPlan(rawNodes, options = {}) {
    if (!Array.isArray(rawNodes)) {
        throw new TypeError('validateGoalPlan requires an array of plan nodes.');
    }
    const allowedRoles =
        Array.isArray(options.roles) && options.roles.length > 0 ? options.roles : GOAL_ROLES;
    const errors = [];
    const warnings = [];
    const nodes = [];
    const seenIds = new Set();

    if (rawNodes.length === 0) errors.push('A goal plan must contain at least one subgoal.');
    if (rawNodes.length > MAX_PLAN_SUBGOALS) {
        errors.push(`A goal plan may contain at most ${MAX_PLAN_SUBGOALS} subgoals.`);
    }

    rawNodes.forEach((raw, index) => {
        const label = `nodes[${index}]`;
        if (!isPlainObject(raw)) {
            errors.push(`${label} must be an object.`);
            return;
        }

        const id = toTrimmedString(raw.id);
        if (!id) {
            errors.push(`${label}.id must be a non-empty string.`);
        } else if (!SUBGOAL_ID_PATTERN.test(id) || id.length > MAX_SUBGOAL_ID_CHARS) {
            errors.push(
                `${label}.id "${id}" must be at most ${MAX_SUBGOAL_ID_CHARS} characters of letters, digits, "_" or "-".`
            );
        } else if (seenIds.has(id)) {
            errors.push(`Duplicate subgoal id "${id}".`);
        }
        if (id) seenIds.add(id);

        let title = formatInline(raw.title);
        if (!title) {
            errors.push(`${label}.title must be a non-empty string.`);
        } else if (title.length > MAX_TITLE_CHARS) {
            title = title.slice(0, MAX_TITLE_CHARS);
            warnings.push(`${label}.title was truncated to ${MAX_TITLE_CHARS} characters.`);
        }

        const role = toTrimmedString(raw.role);
        if (!role) {
            errors.push(`${label}.role must be a non-empty string.`);
        } else if (!allowedRoles.includes(role)) {
            errors.push(
                `${label}.role must be one of ${allowedRoles.join(', ')} (received "${role}").`
            );
        }

        const dependsOn = [];
        if (raw.dependsOn !== undefined && raw.dependsOn !== null) {
            if (!Array.isArray(raw.dependsOn)) {
                errors.push(`${label}.dependsOn must be an array of subgoal ids.`);
            } else {
                const seenDependencies = new Set();
                for (const entry of raw.dependsOn) {
                    const dependency = toTrimmedString(entry);
                    if (!dependency) {
                        errors.push(`${label}.dependsOn entries must be non-empty strings.`);
                        continue;
                    }
                    if (id && dependency === id) {
                        errors.push(`${label} cannot depend on itself.`);
                        continue;
                    }
                    if (seenDependencies.has(dependency)) continue;
                    seenDependencies.add(dependency);
                    dependsOn.push(dependency);
                }
            }
        }

        const successCriteria =
            typeof raw.successCriteria === 'string'
                ? raw.successCriteria.trim().slice(0, MAX_SUCCESS_CRITERIA_CHARS)
                : '';

        const whitelist = resolveWhitelist(role, options);
        let tools;
        if (raw.tools === undefined || raw.tools === null) {
            tools = [...whitelist];
        } else if (!Array.isArray(raw.tools)) {
            errors.push(`${label}.tools must be an array of tool names.`);
            tools = [...whitelist];
        } else {
            tools = [];
            for (const entry of raw.tools) {
                const toolName = toTrimmedString(entry);
                if (!toolName) {
                    errors.push(`${label}.tools entries must be non-empty strings.`);
                    continue;
                }
                if (!whitelist.includes(toolName)) {
                    warnings.push(
                        `Subgoal "${id || label}" tool "${toolName}" is not allowed for role "${role}" and was dropped.`
                    );
                    continue;
                }
                if (!tools.includes(toolName)) tools.push(toolName);
            }
        }

        nodes.push({ id, title, role, dependsOn, successCriteria, tools });
    });

    const knownIds = new Set(nodes.filter((node) => node.id).map((node) => node.id));
    for (const node of nodes) {
        if (!node.id) continue;
        for (const dependency of node.dependsOn) {
            if (!knownIds.has(dependency)) {
                errors.push(`Subgoal "${node.id}" depends on unknown subgoal "${dependency}".`);
            }
        }
    }

    const { order, cycleIds } = topologicalOrder(nodes.filter((node) => node.id));
    if (cycleIds.length > 0) {
        errors.push(`Dependency cycle detected among: ${cycleIds.join(', ')}.`);
    }

    return {
        ok: errors.length === 0,
        nodes,
        order: errors.length === 0 ? order : [],
        errors,
        warnings,
    };
}

/**
 * @param {PlanNode[]} nodes
 * @param {string[]} order
 * @returns {string}
 */
function serializeValidatedPlan(nodes, order) {
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const payload = order.map((id) => {
        const node = byId.get(id);
        return {
            id: node.id,
            title: node.title,
            role: node.role,
            dependsOn: [...node.dependsOn],
            successCriteria: node.successCriteria,
            tools: [...node.tools],
        };
    });
    return `<${GOAL_PLAN_TAG}>${JSON.stringify(payload)}</${GOAL_PLAN_TAG}>`;
}

/**
 * Serializes a validated plan back into the `<ncode_goal_plan>` tag format.
 *
 * @param {unknown} rawNodes
 * @param {{ roles?: readonly string[], whitelists?: object|Map<string, readonly string[]> }} [options]
 * @returns {string}
 */
export function serializeGoalPlan(rawNodes, options = {}) {
    const validated = validateGoalPlan(rawNodes, options);
    if (!validated.ok) {
        throw new TypeError(`Cannot serialize an invalid goal plan: ${validated.errors.join(' ')}`);
    }
    return serializeValidatedPlan(validated.nodes, validated.order);
}

// Evidence normalization and verification

/**
 * @returns {SubgoalEvidence & { verified: boolean, invalidExitCode: boolean }}
 */
function emptyEvidence() {
    return {
        verified: false,
        invalidExitCode: false,
        summary: '',
        command: '',
        exitCode: null,
        changedFiles: [],
        gitDiff: '',
        screenshot: null,
        toolCalls: [],
        browserSteps: false,
        failures: [],
    };
}

/**
 * @param {unknown} value
 * @returns {{ path: string, dataUrl: string, base64: string, bytes: number|null }|null}
 */
function normalizeScreenshot(value) {
    if (Array.isArray(value)) {
        for (const entry of value) {
            const screenshot = normalizeScreenshot(entry);
            if (screenshot) return screenshot;
        }
        return null;
    }
    if (typeof value === 'string') {
        const text = value.trim();
        return text ? { path: text, dataUrl: '', base64: '', bytes: null } : null;
    }
    if (!isPlainObject(value)) return null;
    const path =
        toTrimmedString(value.path) ||
        toTrimmedString(value.filePath) ||
        toTrimmedString(value.savePath);
    const dataUrl = toTrimmedString(value.dataUrl);
    const base64 = toTrimmedString(value.base64);
    const bytes = Number.isFinite(value.bytes) ? Math.trunc(value.bytes) : null;
    if (!path && !dataUrl && !base64) return null;
    return { path, dataUrl, base64, bytes };
}

/**
 * @param {unknown} raw
 * @returns {{ name: string, ok: boolean }|null}
 */
function normalizeToolCall(raw) {
    if (isPlainObject(raw)) {
        const name = toTrimmedString(raw.name);
        if (!name) return null;
        return { name, ok: raw.ok !== false };
    }
    if (typeof raw === 'string' && raw.trim()) return { name: raw.trim(), ok: true };
    return null;
}

/**
 * @param {Record<string, unknown>} raw
 * @returns {SubgoalEvidence & { verified: boolean, invalidExitCode: boolean }}
 */
function normalizeEvidenceObject(raw) {
    const evidence = emptyEvidence();
    evidence.summary = formatInline(
        raw.summary ?? raw.notes ?? raw.description ?? raw.message ?? raw.evidence
    ).slice(0, MAX_EVIDENCE_CHARS);
    evidence.command = toTrimmedString(raw.command ?? raw.cmd);
    const rawExit = raw.exitCode ?? raw.terminalExitCode;
    if (rawExit !== undefined && rawExit !== null) {
        const numeric = typeof rawExit === 'string' ? Number(rawExit.trim()) : rawExit;
        if (Number.isFinite(numeric)) {
            evidence.exitCode = Math.trunc(numeric);
        } else {
            evidence.invalidExitCode = true;
        }
    }
    evidence.changedFiles = normalizeStringList(raw.changedFiles ?? raw.filesChanged ?? raw.files);
    if (typeof raw.gitDiff === 'string') evidence.gitDiff = raw.gitDiff;
    else if (typeof raw.diff === 'string') evidence.gitDiff = raw.diff;
    evidence.screenshot = normalizeScreenshot(
        raw.screenshot ?? raw.screenshotPath ?? raw.screenshots
    );
    evidence.toolCalls = Array.isArray(raw.toolCalls)
        ? raw.toolCalls.map(normalizeToolCall).filter((call) => Boolean(call))
        : [];
    evidence.browserSteps =
        raw.browserSteps === true ||
        raw.usedBrowser === true ||
        evidence.toolCalls.some((call) => BROWSER_TOOL_NAMES.includes(call.name));
    evidence.failures = normalizeStringList(raw.failures);
    return evidence;
}

/**
 * @param {string} text
 * @returns {boolean}
 */
function isRecordedVerified(text) {
    return typeof text === 'string' && text.startsWith(`${VERIFIED_EVIDENCE_MARKER} `);
}

/**
 * Normalizes any evidence value (object, JSON string or narrative string) into the
 * router's evidence record. Returns null when there is no evidence at all.
 *
 * @param {unknown} raw
 * @returns {(SubgoalEvidence & { verified: boolean, invalidExitCode: boolean })|null}
 */
function normalizeEvidence(raw) {
    if (raw === null || raw === undefined) return null;
    if (typeof raw === 'string') {
        const text = raw.trim();
        if (!text) return null;
        if (isRecordedVerified(text)) {
            const evidence = emptyEvidence();
            evidence.verified = true;
            evidence.summary = formatInline(text.slice(VERIFIED_EVIDENCE_MARKER.length)).slice(
                0,
                MAX_EVIDENCE_CHARS
            );
            return evidence;
        }
        if (text.startsWith('{') || text.startsWith('[')) {
            try {
                const parsed = JSON.parse(text);
                if (isPlainObject(parsed)) return normalizeEvidenceObject(parsed);
            } catch {
                // Not JSON: fall through and keep the text as narrative evidence.
            }
        }
        const evidence = emptyEvidence();
        evidence.summary = formatInline(text).slice(0, MAX_EVIDENCE_CHARS);
        return evidence;
    }
    if (!isPlainObject(raw)) return null;
    return normalizeEvidenceObject(raw);
}

/**
 * @param {SubgoalEvidence} evidence
 * @returns {boolean}
 */
function hasStructuredEvidence(evidence) {
    return (
        evidence.exitCode !== null ||
        evidence.invalidExitCode ||
        evidence.changedFiles.length > 0 ||
        Boolean(evidence.gitDiff && evidence.gitDiff.trim()) ||
        Boolean(evidence.screenshot) ||
        evidence.toolCalls.length > 0
    );
}

/**
 * Formats a verified or rejected evidence record into the one-line string stored in a
 * subgoal. A verified record carries the {@link VERIFIED_EVIDENCE_MARKER} prefix so the
 * completion gate can trust work that was already checked before a compaction moved the
 * session to another conversation.
 *
 * @param {SubgoalEvidence} evidence
 * @param {{ verified?: boolean }} [options]
 * @returns {string}
 */
function formatEvidence(evidence, options = {}) {
    const record = evidence || emptyEvidence();
    const marker = options.verified === true ? `${VERIFIED_EVIDENCE_MARKER} ` : '';
    const parts = [];
    if (record.summary) parts.push(record.summary);
    if (record.command) parts.push(`command=${formatInline(record.command).slice(0, 200)}`);
    if (record.invalidExitCode) parts.push('exit=invalid');
    else if (record.exitCode !== null) parts.push(`exit=${record.exitCode}`);
    if (record.changedFiles.length > 0) parts.push(`files=${record.changedFiles.length}`);
    if (record.gitDiff && record.gitDiff.trim()) parts.push('diff=present');
    if (record.screenshot) parts.push('screenshot=present');
    if (record.toolCalls.length > 0) {
        const calls = record.toolCalls
            .map((call) => `${call.name}:${call.ok ? 'ok' : 'failed'}`)
            .join(',');
        parts.push(`tools=${calls}`);
    }
    if (record.browserSteps) parts.push('browser=yes');
    const body = parts.length > 0 ? parts.join(' \u00b7 ') : 'no structured evidence recorded';
    return `${marker}${body}`.slice(0, MAX_EVIDENCE_CHARS);
}

/**
 * Verifies that a subgoal's evidence actually proves the work.
 *
 * Rules enforced:
 * - there must be evidence at all;
 * - a recorded command must carry exit code 0 (missing or non-zero is a refusal);
 * - changed files must come with a non-empty git diff;
 * - browser steps (and every browser_operator subgoal) must come with a screenshot;
 * - a listed tool call that failed refuses the subgoal;
 * - a pc_coder claim needs structured tool/terminal/file evidence, not narrative only.
 *
 * Evidence recorded by this router carries a check-mark prefix and is trusted.
 *
 * @param {{ role?: string } | Record<string, unknown>} subgoal
 * @param {unknown} evidence Evidence object, JSON string or narrative string.
 * @returns {{ verified: boolean, reasons: string[] }}
 */
export function verifySubgoalCompletion(subgoal, evidence) {
    const reasons = [];
    if (!isPlainObject(subgoal)) {
        return { verified: false, reasons: ['missing_subgoal'] };
    }
    const role = toTrimmedString(subgoal.role);
    if (!GOAL_ROLES.includes(role)) {
        reasons.push(`unknown_role:${role || 'empty'}`);
    }

    const record = normalizeEvidence(evidence);
    if (!record) {
        reasons.push('missing_evidence');
        return { verified: false, reasons };
    }
    if (record.verified) {
        return { verified: reasons.length === 0, reasons };
    }
    if (!record.summary && !hasStructuredEvidence(record)) {
        reasons.push('missing_evidence');
    }

    if (record.invalidExitCode) {
        reasons.push('terminal_exit_code_invalid');
    } else if (record.exitCode !== null) {
        if (record.exitCode !== 0) reasons.push(`terminal_exit_code_non_zero:${record.exitCode}`);
    } else if (record.command) {
        reasons.push('terminal_exit_code_missing');
    }

    if (record.changedFiles.length > 0 && !record.gitDiff.trim()) {
        reasons.push('git_diff_missing');
    }

    if (record.browserSteps && !record.screenshot) {
        reasons.push('browser_screenshot_missing');
    }

    for (const call of record.toolCalls) {
        if (call.ok === false) reasons.push(`tool_call_failed:${call.name}`);
    }

    if (role === 'pc_coder' && !hasStructuredEvidence(record) && record.summary) {
        reasons.push('unstructured_pc_evidence');
    }
    if (role === 'browser_operator' && !record.screenshot) {
        if (!reasons.includes('browser_screenshot_missing')) {
            reasons.push('browser_screenshot_missing');
        }
    }

    return { verified: reasons.length === 0, reasons };
}

/**
 * Parses the explicit `<ncode_goal_complete>true</ncode_goal_complete>` signal, also
 * when Gemini Web HTML-escaped the angle brackets.
 *
 * @param {unknown} modelText
 * @returns {boolean}
 */
export function hasGoalCompletionTag(modelText) {
    if (typeof modelText !== 'string' || !modelText.trim()) return false;
    const contents = collectClosedTagContents(modelText, GOAL_COMPLETE_TAG);
    if (contents.length > 0) {
        return contents.some((content) => /^(?:true|yes|on|1)$/i.test(content.trim()));
    }
    if (HTML_ENTITY_TAG_HINT.test(modelText)) {
        const decoded = decodeHtmlEntities(modelText);
        return collectClosedTagContents(decoded, GOAL_COMPLETE_TAG).some((content) =>
            /^(?:true|yes|on|1)$/i.test(content.trim())
        );
    }
    return false;
}

// Goal-session normalization and serialization

/**
 * @param {unknown} raw
 * @param {number} index
 * @param {Set<string>} seenIds
 * @returns {RouterSubgoal}
 */
function normalizeSubgoalRecord(raw, index, seenIds) {
    if (!isPlainObject(raw)) {
        throw new TypeError(`goalSession.subgoals[${index}] must be an object.`);
    }
    const id = requireTrimmedString(raw.id, `goalSession.subgoals[${index}].id`);
    if (seenIds.has(id)) throw new TypeError(`Duplicate subgoal id "${id}".`);
    seenIds.add(id);

    const title = requireTrimmedString(raw.title, `goalSession.subgoals[${index}].title`);
    const role = requireTrimmedString(raw.role, `goalSession.subgoals[${index}].role`);
    if (!GOAL_ROLES.includes(role)) {
        throw new TypeError(
            `goalSession.subgoals[${index}].role must be one of ${GOAL_ROLES.join(
                ', '
            )} (received "${role}").`
        );
    }

    const status =
        raw.status === undefined
            ? 'pending'
            : requireTrimmedString(raw.status, `goalSession.subgoals[${index}].status`);
    if (!SUBGOAL_STATUSES.includes(status)) {
        throw new TypeError(
            `goalSession.subgoals[${index}].status must be one of ${SUBGOAL_STATUSES.join(
                ', '
            )} (received "${status}").`
        );
    }

    if (raw.evidence !== undefined && typeof raw.evidence !== 'string') {
        throw new TypeError(`goalSession.subgoals[${index}].evidence must be a string.`);
    }

    let dependsOn = [];
    if (raw.dependsOn !== undefined && raw.dependsOn !== null) {
        if (!Array.isArray(raw.dependsOn)) {
            throw new TypeError(`goalSession.subgoals[${index}].dependsOn must be an array.`);
        }
        for (const entry of raw.dependsOn) {
            const dependency = requireTrimmedString(
                entry,
                `goalSession.subgoals[${index}].dependsOn entries`
            );
            if (!dependsOn.includes(dependency)) dependsOn.push(dependency);
        }
    }

    const tools =
        raw.tools === undefined
            ? [...(ROLE_TOOL_WHITELISTS[role] || [])]
            : normalizeToolNames(raw.tools, `goalSession.subgoals[${index}].tools`);

    return {
        id,
        title,
        role,
        status,
        evidence: typeof raw.evidence === 'string' ? raw.evidence.trim() : '',
        dependsOn,
        successCriteria:
            typeof raw.successCriteria === 'string'
                ? raw.successCriteria.trim().slice(0, MAX_SUCCESS_CRITERIA_CHARS)
                : '',
        tools,
        attempts: normalizeNonNegativeInteger(
            raw.attempts,
            0,
            `goalSession.subgoals[${index}].attempts`
        ),
        lastError:
            typeof raw.lastError === 'string' ? raw.lastError.slice(0, MAX_LAST_ERROR_CHARS) : '',
    };
}

/**
 * Hydrates and validates a goal session.
 *
 * Accepts the router's full state (with DAG edges, attempts and last errors) and the
 * narrow NcodeHarnessBar snapshot `{ worklowId, rootGoal, subgoals: [{id,title,role,
 * status,evidence}], ... }`. Missing DAG metadata defaults to a dependency-free step, so
 * a session restored from a compact checkpoint still schedules in stored order.
 *
 * Invalid structural input (duplicate ids, unknown roles, unknown dependencies, cycles)
 * throws a TypeError; missing optional fields are defaulted.
 *
 * @param {unknown} raw
 * @returns {GoalSession}
 */
export function hydrateState(raw) {
    if (!isPlainObject(raw)) {
        throw new TypeError('hydrateState requires a goal session object.');
    }
    const workflowId = requireTrimmedString(raw.workflowId, 'goalSession.workflowId');
    const rootGoal = requireTrimmedString(raw.rootGoal, 'goalSession.rootGoal');
    if (!Array.isArray(raw.subgoals)) {
        throw new TypeError('goalSession.subgoals must be an array.');
    }
    if (raw.subgoals.length > MAX_PLAN_SUBGOALS) {
        throw new TypeError(`goalSession.subgoals may contain at most ${MAX_PLAN_SUBGOALS} steps.`);
    }

    const seenIds = new Set();
    const subgoals = raw.subgoals.map((subgoal, index) =>
        normalizeSubgoalRecord(subgoal, index, seenIds)
    );
    const knownIds = new Set(subgoals.map((subgoal) => subgoal.id));
    for (const subgoal of subgoals) {
        for (const dependency of subgoal.dependsOn) {
            if (dependency === subgoal.id) {
                throw new TypeError(`Subgoal "${subgoal.id}" cannot depend on itself.`);
            }
            if (!knownIds.has(dependency)) {
                throw new TypeError(
                    `Subgoal "${subgoal.id}" depends on unknown subgoal "${dependency}".`
                );
            }
        }
    }
    const { order, cycleIds } = topologicalOrder(subgoals);
    if (cycleIds.length > 0) {
        throw new TypeError(`Dependency cycle detected among: ${cycleIds.join(', ')}.`);
    }
    const byId = new Map(subgoals.map((subgoal) => [subgoal.id, subgoal]));
    const orderedSubgoals = order.map((id) => byId.get(id));

    const iterationCount = normalizeNonNegativeInteger(
        raw.iterationCount,
        0,
        'goalSession.iterationCount'
    );
    const maxIterations = normalizePositiveInteger(
        raw.maxIterations,
        DEFAULT_MAX_ITERATIONS,
        'goalSession.maxIterations'
    );
    const status =
        raw.status === undefined
            ? 'active'
            : requireTrimmedString(raw.status, 'goalSession.status');
    if (!GOAL_STATUSES.includes(status)) {
        throw new TypeError(
            `goalSession.status must be one of ${GOAL_STATUSES.join(', ')} (received "${status}").`
        );
    }
    const createdAt = normalizeTimestamp(raw.createdAt, Date.now());
    const updatedAt = normalizeTimestamp(raw.updatedAt, createdAt);

    const session = {
        workflowId,
        rootGoal,
        subgoals: orderedSubgoals,
        iterationCount,
        maxIterations,
        status,
        completionMarked: raw.completionMarked === true || status === 'completed',
        createdAt,
        updatedAt,
    };
    const failureReason = formatInline(raw.failureReason);
    if (failureReason) session.failureReason = failureReason;
    return session;
}

/**
 * Serializes a goal session with full routing fidelity (DAG edges, attempts, last
 * errors). Use {@link toHarnessSnapshot} for the narrow NcodeHarnessBar / compact
 * checkpoint shape.
 *
 * @param {GoalSession} goalSession
 * @returns {Record<string, unknown>}
 */
export function serializeState(goalSession) {
    const session = hydrateState(goalSession);
    const serialized = {
        version: SERIALIZED_STATE_VERSION,
        workflowId: session.workflowId,
        rootGoal: session.rootGoal,
        subgoals: session.subgoals.map((subgoal) => ({
            id: subgoal.id,
            title: subgoal.title,
            role: subgoal.role,
            status: subgoal.status,
            evidence: subgoal.evidence,
            dependsOn: [...subgoal.dependsOn],
            successCriteria: subgoal.successCriteria,
            tools: [...subgoal.tools],
            attempts: subgoal.attempts,
            lastError: subgoal.lastError,
        })),
        iterationCount: session.iterationCount,
        maxIterations: session.maxIterations,
        status: session.status,
        completionMarked: session.completionMarked,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
    };
    if (session.failureReason) serialized.failureReason = session.failureReason;
    return serialized;
}

/**
 * Projects a goal session onto the exact NcodeHarnessBar goal-session contract:
 * `{ workflowId, rootGoal, subgoals: [{ id, title, role, status, evidence }],
 * iterationCount, maxIterations, status, completionMarked, createdAt, updatedAt }`.
 *
 * @param {GoalSession} goalSession
 * @returns {{
 *   workflowId: string,
 *   rootGoal: string,
 *   subgoals: Array<{ id: string, title: string, role: GoalRole, status: SubgoalStatus, evidence: string }>,
 *   iterationCount: number,
 *   maxIterations: number,
 *   status: GoalStatus,
 *   completionMarked: boolean,
 *   createdAt: number,
 *   updatedAt: number
 * }}
 */
export function toHarnessSnapshot(goalSession) {
    const session = hydrateState(goalSession);
    return {
        workflowId: session.workflowId,
        rootGoal: session.rootGoal,
        subgoals: session.subgoals.map((subgoal) => ({
            id: subgoal.id,
            title: subgoal.title,
            role: subgoal.role,
            status: subgoal.status,
            evidence: subgoal.evidence,
        })),
        iterationCount: session.iterationCount,
        maxIterations: session.maxIterations,
        status: session.status,
        completionMarked: session.completionMarked,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
    };
}

// Session lifecycle and scheduling

/**
 * @param {PlanNode} node
 * @returns {RouterSubgoal}
 */
function subgoalFromPlanNode(node) {
    return {
        id: node.id,
        title: node.title,
        role: node.role,
        status: 'pending',
        evidence: '',
        dependsOn: [...node.dependsOn],
        successCriteria: node.successCriteria,
        tools: [...node.tools],
        attempts: 0,
        lastError: '',
    };
}

/**
 * Creates a fresh active goal session. Subgoals are optional: a loop normally creates
 * the session first, asks the planner for a DAG and applies it with {@link applyPlan}.
 *
 * @param {{
 *   workflowId: string,
 *   rootGoal: string,
 *   maxIterations?: number,
 *   subgoals?: unknown[],
 *   now?: number
 * }} options
 * @returns {GoalSession}
 */
export function createGoalSession(options = {}) {
    if (!isPlainObject(options)) {
        throw new TypeError('createGoalSession requires an options object.');
    }
    const workflowId = requireTrimmedString(
        options.workflowId,
        'createGoalSession({ workflowId })'
    );
    const rootGoal = requireTrimmedString(options.rootGoal, 'createGoalSession({ rootGoal })');
    const maxIterations = normalizePositiveInteger(
        options.maxIterations,
        DEFAULT_MAX_ITERATIONS,
        'createGoalSession({ maxIterations })'
    );
    const now = normalizeTimestamp(options.now, Date.now());

    let subgoals = [];
    if (options.subgoals !== undefined && options.subgoals !== null) {
        const validated = validateGoalPlan(options.subgoals);
        if (!validated.ok) {
            throw new TypeError(
                `createGoalSession({ subgoals }) is invalid: ${validated.errors.join(' ')}`
            );
        }
        const byId = new Map(validated.nodes.map((node) => [node.id, node]));
        subgoals = validated.order.map((id) => subgoalFromPlanNode(byId.get(id)));
    }

    return {
        workflowId,
        rootGoal,
        subgoals,
        iterationCount: 0,
        maxIterations,
        status: 'active',
        completionMarked: false,
        createdAt: now,
        updatedAt: now,
    };
}

/**
 * Attaches a validated subgoal DAG to a session and resets it to a schedulable state.
 * Work already recorded as done with matching ids is preserved across a re-plan so the
 * loop does not repeat verified steps.
 *
 * @param {GoalSession} goalSession
 * @param {unknown[] | { nodes?: unknown[] }} planInput Plan nodes or a validated plan result.
 * @returns {GoalSession}
 */
export function applyPlan(goalSession, planInput) {
    const session = hydrateState(goalSession);
    let nodes = planInput;
    if (isPlainObject(planInput) && Array.isArray(planInput.nodes)) {
        nodes = planInput.nodes;
    }
    const validated = validateGoalPlan(nodes);
    if (!validated.ok) {
        throw new TypeError(`Cannot apply an invalid goal plan: ${validated.errors.join(' ')}`);
    }
    const previousById = new Map(session.subgoals.map((subgoal) => [subgoal.id, subgoal]));
    const byId = new Map(validated.nodes.map((node) => [node.id, node]));
    const subgoals = validated.order.map((id) => {
        const planned = subgoalFromPlanNode(byId.get(id));
        const previous = previousById.get(id);
        if (previous && previous.status === 'done' && previous.evidence) {
            return {
                ...planned,
                status: 'done',
                evidence: previous.evidence,
                attempts: previous.attempts,
            };
        }
        return planned;
    });
    return {
        ...session,
        subgoals,
        status: session.status === 'completed' ? 'active' : session.status,
        completionMarked: session.completionMarked,
        updatedAt: Date.now(),
    };
}

/**
 * Lists pending subgoals whose dependencies are all done, in topological order.
 *
 * @param {GoalSession} goalSession
 * @returns {RouterSubgoal[]}
 */
export function listReadySubgoals(goalSession) {
    const session = hydrateState(goalSession);
    const doneIds = new Set(
        session.subgoals.filter((subgoal) => subgoal.status === 'done').map((subgoal) => subgoal.id)
    );
    return session.subgoals
        .filter(
            (subgoal) =>
                subgoal.status === 'pending' &&
                subgoal.dependsOn.every((dependency) => doneIds.has(dependency))
        )
        .map((subgoal) => ({
            ...subgoal,
            dependsOn: [...subgoal.dependsOn],
            tools: [...subgoal.tools],
        }));
}

/**
 * Returns the subgoal the loop should work on next: an in-flight running subgoal first,
 * then the first ready pending subgoal. Returns null when nothing can run.
 *
 * @param {GoalSession} goalSession
 * @returns {RouterSubgoal|null}
 */
export function nextSubgoal(goalSession) {
    const session = hydrateState(goalSession);
    const running = session.subgoals.find((subgoal) => subgoal.status === 'running');
    if (running) {
        return { ...running, dependsOn: [...running.dependsOn], tools: [...running.tools] };
    }
    const ready = listReadySubgoals(session);
    return ready.length > 0 ? ready[0] : null;
}

/**
 * Applies one reported subgoal result.
 *
 * `done` results pass through {@link verifySubgoalCompletion}; refused evidence schedules
 * a retry (back to `pending`) until `maxAttempts` is exhausted, then becomes `failed`.
 * Reported `failed` results retry the same way. When no subgoal can run any more the
 * session becomes `failed` with `failureReason: 'blocked_by_failed_subgoals'`.
 *
 * @param {GoalSession} goalSession
 * @param {{ subgoalId: string, status: SubgoalStatus, evidence?: unknown }} result
 * @param {{ maxAttempts?: number, now?: number }} [options]
 * @returns {{
 *   goalSession: GoalSession,
 *   accepted: boolean,
 *   reasons: string[],
 *   retrying: boolean,
 *   exhausted: boolean,
 *   completionReady: boolean,
 *   subgoal: RouterSubgoal
 * }}
 */
export function applySubgoalResult(goalSession, result, options = {}) {
    const session = hydrateState(goalSession);
    if (!isPlainObject(result)) {
        throw new TypeError(
            'applySubgoalResult requires a { subgoalId, status, evidence } object.'
        );
    }
    const subgoalId = requireTrimmedString(result.subgoalId, 'applySubgoalResult({ subgoalId })');
    const status = requireTrimmedString(result.status, 'applySubgoalResult({ status })');
    if (!SUBGOAL_STATUSES.includes(status)) {
        throw new TypeError(
            `applySubgoalResult status must be one of ${SUBGOAL_STATUSES.join(
                ', '
            )} (received "${status}").`
        );
    }
    const index = session.subgoals.findIndex((subgoal) => subgoal.id === subgoalId);
    if (index === -1) {
        throw new TypeError(`Unknown subgoal id "${subgoalId}".`);
    }
    const maxAttempts = normalizePositiveInteger(
        options.maxAttempts,
        DEFAULT_MAX_ATTEMPTS,
        'applySubgoalResult maxAttempts'
    );
    const now = normalizeTimestamp(options.now, Date.now());
    const target = session.subgoals[index];
    const record = normalizeEvidence(result.evidence);

    const reasons = [];
    let accepted = true;
    let retrying = false;
    let exhausted = false;
    let nextRecord = {
        ...target,
        dependsOn: [...target.dependsOn],
        tools: [...target.tools],
    };

    if (status === 'running') {
        const doneIds = new Set(
            session.subgoals
                .filter((subgoal) => subgoal.status === 'done')
                .map((subgoal) => subgoal.id)
        );
        const blockedBy = target.dependsOn.filter((dependency) => !doneIds.has(dependency));
        if (blockedBy.length > 0) {
            accepted = false;
            reasons.push(`dependencies_not_done:${blockedBy.join(',')}`);
        } else {
            nextRecord = { ...nextRecord, status: 'running', lastError: '' };
        }
    } else if (status === 'pending') {
        nextRecord = { ...nextRecord, status: 'pending', lastError: '' };
    } else if (status === 'done') {
        const verification = verifySubgoalCompletion(target, result.evidence);
        if (!verification.verified) {
            accepted = false;
            reasons.push(...verification.reasons);
            const attempts = target.attempts + 1;
            const canRetry = attempts < maxAttempts;
            retrying = canRetry;
            exhausted = !canRetry;
            nextRecord = {
                ...nextRecord,
                status: canRetry ? 'pending' : 'failed',
                attempts,
                lastError: verification.reasons.join('; ').slice(0, MAX_LAST_ERROR_CHARS),
                evidence: record ? formatEvidence(record) : '',
            };
        } else {
            nextRecord = {
                ...nextRecord,
                status: 'done',
                attempts: target.attempts + 1,
                lastError: '',
                evidence: formatEvidence(record, { verified: true }),
            };
        }
    } else {
        const attempts = target.attempts + 1;
        const canRetry = attempts < maxAttempts;
        retrying = canRetry;
        exhausted = !canRetry;
        reasons.push(canRetry ? 'retry_scheduled' : 'max_attempts_reached');
        nextRecord = {
            ...nextRecord,
            status: canRetry ? 'pending' : 'failed',
            attempts,
            lastError: record && record.summary ? record.summary : 'Subgoal reported failed.',
            evidence: record ? formatEvidence(record) : '',
        };
    }

    const subgoals = session.subgoals.map((subgoal, subgoalIndex) =>
        subgoalIndex === index ? nextRecord : subgoal
    );
    const updated = { ...session, subgoals, updatedAt: now };
    const allDone = subgoals.length > 0 && subgoals.every((subgoal) => subgoal.status === 'done');
    if (!allDone) {
        const hasRunning = subgoals.some((subgoal) => subgoal.status === 'running');
        const hasReady = listReadySubgoals({ ...updated, subgoals }).length > 0;
        if (!hasRunning && !hasReady) {
            updated.status = 'failed';
            updated.failureReason = 'blocked_by_failed_subgoals';
        }
    }
    return {
        goalSession: updated,
        accepted,
        reasons,
        retrying,
        exhausted,
        completionReady: allDone,
        subgoal: {
            ...nextRecord,
            dependsOn: [...nextRecord.dependsOn],
            tools: [...nextRecord.tools],
        },
    };
}

/**
 * Advances the loop iteration counter; reaching the cap fails the session.
 *
 * @param {GoalSession} goalSession
 * @param {{ now?: number }} [options]
 * @returns {GoalSession}
 */
export function advanceIteration(goalSession, options = {}) {
    const session = hydrateState(goalSession);
    const iterationCount = session.iterationCount + 1;
    const next = {
        ...session,
        subgoals: session.subgoals.map((subgoal) => ({
            ...subgoal,
            dependsOn: [...subgoal.dependsOn],
            tools: [...subgoal.tools],
        })),
        iterationCount,
        updatedAt: normalizeTimestamp(options.now, Date.now()),
    };
    if (iterationCount >= session.maxIterations) {
        next.status = 'failed';
        next.failureReason = 'max_iterations_reached';
    }
    return next;
}

// Verifier completion gate

/**
 * The completion gate: decides whether a session may be marked complete.
 *
 * It refuses unless every subgoal is done, every done subgoal's evidence still verifies,
 * and the loop explicitly signalled completion (`options.complete === true` or a
 * `<ncode_goal_complete>true</ncode_goal_complete>` tag in `options.modelText`).
 *
 * @param {GoalSession} goalSession
 * @param {{ complete?: boolean, modelText?: string, requireExplicitCompletion?: boolean }} [options]
 * @returns {{ allowed: boolean, reasons: string[], completionTag: string }}
 */
export function completionGate(goalSession, options = {}) {
    const session = hydrateState(goalSession);
    const completionTag = `<${GOAL_COMPLETE_TAG}>true</${GOAL_COMPLETE_TAG}>`;
    if (
        options.modelText !== undefined &&
        typeof options.modelText !== 'string' &&
        options.complete !== true
    ) {
        throw new TypeError('completionGate modelText must be a string when provided.');
    }
    if (session.completionMarked === true || session.status === 'completed') {
        return { allowed: true, reasons: [], completionTag };
    }

    const reasons = [];
    if (session.status === 'failed') reasons.push('goal_session_failed');
    if (session.subgoals.length === 0) reasons.push('no_subgoals_planned');

    const unfinished = session.subgoals
        .filter((subgoal) => subgoal.status !== 'done')
        .map((subgoal) => `${subgoal.id}:${subgoal.status}`);
    if (unfinished.length > 0) reasons.push(`subgoals_not_done:${unfinished.join(',')}`);

    for (const subgoal of session.subgoals) {
        if (subgoal.status !== 'done') continue;
        const verification = verifySubgoalCompletion(subgoal, subgoal.evidence);
        if (!verification.verified) {
            reasons.push(`unverified_evidence:${subgoal.id}:${verification.reasons.join('|')}`);
        }
    }

    if (options.requireExplicitCompletion !== false) {
        const explicit =
            options.complete === true ||
            (typeof options.modelText === 'string' && hasGoalCompletionTag(options.modelText));
        if (!explicit) reasons.push('missing_completion_tag');
    }

    return {
        allowed: reasons.length === 0,
        reasons,
        completionTag: reasons.length === 0 ? completionTag : '',
    };
}

/**
 * Marks a session complete only when {@link completionGate} allows it.
 *
 * @param {GoalSession} goalSession
 * @param {{ complete?: boolean, modelText?: string, requireExplicitCompletion?: boolean, now?: number }} [options]
 * @returns {{ goalSession: GoalSession, allowed: boolean, reasons: string[], completionTag: string }}
 */
export function markGoalComplete(goalSession, options = {}) {
    const session = hydrateState(goalSession);
    const gate = completionGate(session, options);
    if (!gate.allowed) {
        return { goalSession: session, allowed: false, reasons: gate.reasons, completionTag: '' };
    }
    const completed = {
        ...session,
        subgoals: session.subgoals.map((subgoal) => ({
            ...subgoal,
            dependsOn: [...subgoal.dependsOn],
            tools: [...subgoal.tools],
        })),
        status: 'completed',
        completionMarked: true,
        updatedAt: normalizeTimestamp(options.now, Date.now()),
    };
    return {
        goalSession: completed,
        allowed: true,
        reasons: [],
        completionTag: gate.completionTag,
    };
}

// Model-facing prompts

/**
 * @param {GoalSession} session
 * @returns {string}
 */
function formatSubgoalChecklist(session) {
    if (session.subgoals.length === 0) return '- (no subgoals have been planned yet)';
    return session.subgoals
        .map((subgoal) => {
            const dependencies =
                subgoal.dependsOn.length > 0 ? subgoal.dependsOn.join(', ') : 'none';
            const evidence = subgoal.evidence
                ? ` | evidence: ${formatInline(subgoal.evidence).slice(0, 300)}`
                : '';
            const error = subgoal.lastError
                ? ` | last error: ${formatInline(subgoal.lastError).slice(0, 240)}`
                : '';
            return `- ${subgoal.id} [${subgoal.role}/${subgoal.status}] deps: ${dependencies} | ${subgoal.title}${evidence}${error}`;
        })
        .join('\n');
}

/**
 * @param {GoalSession} session
 * @returns {string}
 */
function describeNextSubgoal(session) {
    const next = nextSubgoal(session);
    if (next) {
        const criteria = next.successCriteria
            ? ` Acceptance criteria: ${next.successCriteria}`
            : '';
        return `Work on subgoal ${next.id} (${next.role}) \u2014 ${next.title}.${criteria}`;
    }
    if (session.subgoals.length === 0) {
        return `No subgoal plan exists yet. Emit the <${GOAL_PLAN_TAG}> JSON array described by the planner role now.`;
    }
    if (session.subgoals.every((subgoal) => subgoal.status === 'done')) {
        return `Every subgoal is done. Run the verifier checklist, then emit the completion tag.`;
    }
    return 'No subgoal is ready: all remaining work is blocked by failed dependencies. Report the exact blocker or re-plan with the planner role.';
}

/**
 * @param {string} roleName
 * @param {{ roles?: Map<string, object>|object }} [options]
 * @returns {{ name: string, prompt: string, tools: readonly string[] }}
 */
function resolveRoleDefinition(roleName, options = {}) {
    const name = toTrimmedString(roleName);
    const roles = options.roles;
    if (roles instanceof Map && roles.has(name)) return roles.get(name);
    if (isPlainObject(roles) && isPlainObject(roles[name])) return roles[name];
    if (GOAL_ROLES.includes(name)) {
        return { name, prompt: ROLE_PROMPTS[name], tools: ROLE_TOOL_WHITELISTS[name] };
    }
    return { name, prompt: '', tools: [] };
}

/**
 * @param {string} roleName
 * @param {{ roles?: Map<string, object>|object }} [options]
 * @returns {string}
 */
function renderRoleSection(roleName, options = {}) {
    const role = resolveRoleDefinition(roleName, options);
    if (!role.prompt) {
        return `## Role\n\nNo role prompt is registered for "${roleName}".`;
    }
    const tools =
        Array.isArray(role.tools) && role.tools.length > 0
            ? role.tools.map((toolName) => `- ${toolName}`).join('\n')
            : '- (no tools)';
    return `## Role: ${role.name}

${role.prompt}

### Allowed tools for this role

${tools}`;
}

const EVIDENCE_CONTRACT = `## Evidence contract

Record evidence for every subgoal transition as one JSON object (a one-line JSON string is
also accepted as the evidence value):

{"summary":"what was proven","command":"exact command","exitCode":0,"changedFiles":["relative/path"],"gitDiff":"real diff text","screenshot":{"path":"absolute/path.png"},"toolCalls":[{"name":"pc_exec_shell","ok":true}]}

- A pc_coder subgoal needs structured evidence: an exit code of 0 for the command that
  ran, or a successful tool call, or changed files plus a non-empty git diff.
- A browser_operator subgoal needs a screenshot path or data URL.
- A verifier subgoal needs the concrete result of its independent checks.
- Narrative-only claims are refused by the verifier.`;

/**
 * Builds the real-time status / milestone / completion tag contract shared with the
 * goal-state machine.
 *
 * @returns {string}
 */
function renderTagContract() {
    return `## Mandatory status tags

1. Emit one concise status line inside the preamble tag immediately before every tool call:

<${PREAMBLE_TAG}>One concise real-time status line for the user.</${PREAMBLE_TAG}>

2. Report each milestone transition once:

<${GOAL_UPDATE_TAG}>{"subgoalId":"<id from the checklist>","status":"running|done|failed","evidence":{"summary":"short factual evidence"}}</${GOAL_UPDATE_TAG}>

3. Only after every subgoal is done and the verifier accepted the evidence:

<${GOAL_COMPLETE_TAG}>true</${GOAL_COMPLETE_TAG}>

Never emit the completion tag while a subgoal is pending, running or failed. Do not
invent completion and do not claim a tool ran when its result is not in the conversation.`;
}

/**
 * Builds the standalone role prompt: the role fragment plus its tool whitelist.
 *
 * @param {string} roleName
 * @param {{ roles?: Map<string, object>|object }} [options]
 * @returns {string}
 */
export function buildRolePrompt(roleName, options = {}) {
    const role = resolveRoleDefinition(roleName, options);
    if (!role.prompt) {
        throw new TypeError(`Unknown subagent role "${toTrimmedString(roleName)}".`);
    }
    return renderRoleSection(roleName, options);
}

/**
 * Builds the planner turn prompt for a session without a subgoal DAG.
 *
 * @param {GoalSession} goalSession
 * @param {{ roles?: Map<string, object>|object }} [options]
 * @returns {string}
 */
export function buildPlanPrompt(goalSession, options = {}) {
    const session = hydrateState(goalSession);
    return `# Ncode Astra orchestrator — planning turn

You are starting the planning stage of one autonomous Ncode workflow. This conversation
is executed from the user's own logged-in gemini.google.com web session; there is no API
key and no other host.

## Root goal

${session.rootGoal}

## Workflow state

- workflowId: ${session.workflowId}
- iteration: ${session.iterationCount} of ${session.maxIterations}
- goal status: ${session.status}
- planned subgoals: ${session.subgoals.length}

${renderRoleSection('planner', options)}

## Output contract

Emit exactly one plan and stop:

<${GOAL_PLAN_TAG}>[{"id":"step_id","title":"Concrete deliverable","role":"planner|pc_coder|browser_operator|verifier","dependsOn":[],"successCriteria":"Checkable proof","tools":["tool_name"]}]</${GOAL_PLAN_TAG}>

After the tag, wait for the harness. Do not report progress, do not claim any step is
done, do not emit a downstream tool call and do not emit the completion tag in this turn.
`;
}

/**
 * Builds the continuation turn prompt for the active subgoal DAG.
 *
 * @param {GoalSession} goalSession
 * @param {{ roles?: Map<string, object>|object }} [options]
 * @returns {string}
 */
export function buildContinuationPrompt(goalSession, options = {}) {
    const session = hydrateState(goalSession);
    const next = nextSubgoal(session);
    const roleName = next ? next.role : session.subgoals.length === 0 ? 'planner' : 'verifier';
    return `# Ncode Astra orchestrator — continuation turn

This is a continuation of the same autonomous Ncode task, not a new user request. The
previous turn ended before the subgoal DAG was complete. Keep making progress with tool
calls; do not summarize instead of working.

## Root goal

${session.rootGoal}

## Workflow state

- workflowId: ${session.workflowId}
- iteration: ${session.iterationCount} of ${session.maxIterations} (${Math.max(
        0,
        session.maxIterations - session.iterationCount
    )} remaining)
- goal status: ${session.status}
- completion already marked: ${session.completionMarked ? 'yes' : 'no'}

## Subgoal DAG

${formatSubgoalChecklist(session)}

## Next subgoal

${describeNextSubgoal(session)}

${renderRoleSection(roleName, options)}

${EVIDENCE_CONTRACT}

${renderTagContract()}

## Loop rules

- Work on one subgoal at a time: mark it running, execute the tools, then mark it done
  with real evidence or failed with the real error.
- Never mark a subgoal done without the evidence listed above, and never invent tool output.
- When a subgoal fails, either retry it or continue with work that is still possible.
- Keep using tool calls until the DAG is done or you are genuinely blocked; only then
  stop for a real decision the user must make.
`;
}

/**
 * Builds the verifier turn prompt for one subgoal (or for the completion of the report
 * when the subgoal is not part of the session).
 *
 * @param {GoalSession} goalSession
 * @param {string | Record<string, unknown>} subgoal Subgoal id or subgoal object.
 * @param {{ roles?: Map<string, object>|object }} [options]
 * @returns {string}
 */
export function buildVerifierPrompt(goalSession, subgoal, options = {}) {
    const session = hydrateState(goalSession);
    let target = subgoal;
    if (typeof subgoal === 'string') {
        target = session.subgoals.find((entry) => entry.id === subgoal.trim());
        if (!target) throw new TypeError(`Unknown subgoal id "${subgoal}".`);
    }
    if (!isPlainObject(target)) {
        throw new TypeError('buildVerifierPrompt requires a subgoal object or subgoal id.');
    }
    const subgoalId = toTrimmedString(target.id) || '(unknown)';
    const title = toTrimmedString(target.title) || '(untitled)';
    const role = toTrimmedString(target.role) || '(unknown)';
    const dependencies =
        Array.isArray(target.dependsOn) && target.dependsOn.length > 0
            ? target.dependsOn.join(', ')
            : 'none';
    const successCriteria = toTrimmedString(target.successCriteria) || '(not declared)';
    const recordedEvidence = toTrimmedString(target.evidence) || '(none recorded)';

    return `# Ncode Astra verifier turn — independent completion check

${renderRoleSection('verifier', options)}

## Root goal

${session.rootGoal}

## Target subgoal

- id: ${subgoalId}
- title: ${title}
- role: ${role}
- dependencies: ${dependencies}
- success criteria: ${successCriteria}
- recorded evidence: ${recordedEvidence}

## Verification checklist

1. Terminal: a command that ran must report the real exit code 0. A missing or non-zero
   exit code is a refusal.
2. Files: when files changed, a non-empty git diff must be recorded.
3. Browser: when browser control steps ran, a screenshot path or data URL must be recorded.
4. Tools: every tool call that mattered is listed and none failed silently.
5. Truth: the evidence must describe what actually happened, not what was expected.

## Verdict contract

- Verified: emit
  <${GOAL_UPDATE_TAG}>{"subgoalId":"${subgoalId}","status":"done","evidence":{"summary":"check passed","toolCalls":[{"name":"pc_git_diff","ok":true}]}}</${GOAL_UPDATE_TAG}>
- Not verified: emit
  <${GOAL_UPDATE_TAG}>{"subgoalId":"${subgoalId}","status":"failed","evidence":{"summary":"exact missing proof"}}</${GOAL_UPDATE_TAG}>
  and do not emit the completion tag.
- Only when every subgoal in the DAG is done and every check above passed may you emit
  <${GOAL_COMPLETE_TAG}>true</${GOAL_COMPLETE_TAG}>.

${renderTagContract()}
`;
}

// Router

/**
 * @typedef {object} RoleDefinition
 * @property {string} name
 * @property {string} prompt
 * @property {readonly string[]} tools
 * @property {string} description
 */

/**
 * The four-role subagent router.
 *
 * Holds the role registry (prompt fragment + tool whitelist per role), owns plan
 * recovery/validation, scheduling and evidence verification, and exposes the goal-session
 * shapes consumed by the harness bar and the compact/resume engine.
 *
 * @example
 * const router = new SubagentRouter();
 * let session = router.createGoalSession({ workflowId: 'wf-1', rootGoal: 'Ship the fix' });
 * const planned = router.plan(modelText);
 * if (!planned.ok) throw new Error(planned.errors.join(' '));
 * session = router.applyPlan(session, planned.nodes);
 * const next = router.nextSubgoal(session);
 */
export class SubagentRouter {
    /**
     * @param {{
     *   maxAttempts?: number,
     *   roles?: Array<{ name: string, prompt?: string, tools?: readonly string[], description?: string }>
     * }} [options]
     */
    constructor(options = {}) {
        if (!isPlainObject(options)) {
            throw new TypeError('SubagentRouter requires an options object.');
        }
        this.maxAttempts = normalizePositiveInteger(
            options.maxAttempts,
            DEFAULT_MAX_ATTEMPTS,
            'SubagentRouter({ maxAttempts })'
        );
        /** @type {Map<string, RoleDefinition>} */
        this.roles = new Map();
        for (const roleName of GOAL_ROLES) {
            this.registerRole(roleName, {
                prompt: ROLE_PROMPTS[roleName],
                tools: ROLE_TOOL_WHITELISTS[roleName],
            });
        }
        if (options.roles !== undefined) {
            if (!Array.isArray(options.roles)) {
                throw new TypeError('SubagentRouter({ roles }) must be an array.');
            }
            for (const definition of options.roles) {
                if (!isPlainObject(definition)) {
                    throw new TypeError('SubagentRouter({ roles }) entries must be objects.');
                }
                this.registerRole(definition.name, definition);
            }
        }
    }

    /**
     * Registers (or overrides) one role definition.
     *
     * @param {string} name Lowercase snake_case role name.
     * @param {{ prompt?: string, tools?: readonly string[], description?: string }} [definition]
     * @returns {SubagentRouter} this router, for chaining.
     */
    registerRole(name, definition = {}) {
        const roleName = requireTrimmedString(name, 'registerRole({ name })');
        if (!ROLE_NAME_PATTERN.test(roleName)) {
            throw new TypeError(
                `registerRole name "${roleName}" must be lowercase letters, digits or "_".`
            );
        }
        if (!isPlainObject(definition)) {
            throw new TypeError('registerRole({ definition }) must be an object.');
        }
        const fallbackPrompt = ROLE_PROMPTS[roleName] || '';
        const prompt =
            definition.prompt === undefined
                ? fallbackPrompt
                : requireTrimmedString(definition.prompt, `registerRole("${roleName}") prompt`);
        if (!prompt) {
            throw new TypeError(`registerRole("${roleName}") requires a non-empty prompt.`);
        }
        const fallbackTools = ROLE_TOOL_WHITELISTS[roleName] || [];
        const tools =
            definition.tools === undefined
                ? [...fallbackTools]
                : normalizeToolNames(definition.tools, `registerRole("${roleName}") tools`);
        this.roles.set(
            roleName,
            Object.freeze({
                name: roleName,
                prompt,
                tools: Object.freeze(tools),
                description: toTrimmedString(definition.description),
            })
        );
        return this;
    }

    /**
     * @param {string} name
     * @returns {RoleDefinition}
     */
    getRole(name) {
        const roleName = requireTrimmedString(name, 'getRole({ name })');
        const role = this.roles.get(roleName);
        if (!role) throw new TypeError(`Unknown subagent role "${roleName}".`);
        return role;
    }

    /** @returns {string[]} registered role names in registration order. */
    listRoles() {
        return [...this.roles.keys()];
    }

    /**
     * @param {string} name
     * @returns {readonly string[]}
     */
    getToolWhitelist(name) {
        return this.getRole(name).tools;
    }

    /**
     * @param {string} name
     * @returns {string}
     */
    buildRolePrompt(name) {
        return buildRolePrompt(name, { roles: this.roles });
    }

    /**
     * Recovers and validates a planner DAG from one model response.
     *
     * @param {unknown} rawModelText
     * @returns {{
     *   ok: boolean,
     *   nodes: PlanNode[],
     *   order: string[],
     *   readyIds: string[],
     *   serialized: string,
     *   errors: string[],
     *   warnings: string[],
     *   source: 'tag' | 'fence' | 'prose' | null,
     *   jsonText: string | null
     * }}
     */
    plan(rawModelText) {
        const parsed = parseGoalPlan(rawModelText);
        const base = {
            nodes: [],
            order: [],
            readyIds: [],
            serialized: '',
            warnings: [...parsed.warnings],
            source: parsed.source,
            jsonText: parsed.jsonText,
        };
        if (!parsed.ok) {
            return { ok: false, ...base, errors: [...parsed.errors, ...parsed.warnings] };
        }
        const whitelists = new Map(
            this.listRoles().map((roleName) => [roleName, this.getToolWhitelist(roleName)])
        );
        const validated = validateGoalPlan(parsed.plan, {
            roles: this.listRoles(),
            whitelists,
        });
        if (!validated.ok) {
            return {
                ok: false,
                ...base,
                nodes: validated.nodes,
                warnings: [...parsed.warnings, ...validated.warnings],
                errors: validated.errors,
            };
        }
        const readyIds = validated.nodes
            .filter((node) => node.dependsOn.length === 0)
            .map((node) => node.id);
        return {
            ok: true,
            nodes: validated.nodes,
            order: validated.order,
            readyIds,
            serialized: serializeValidatedPlan(validated.nodes, validated.order),
            errors: [],
            warnings: [...parsed.warnings, ...validated.warnings],
            source: parsed.source,
            jsonText: parsed.jsonText,
        };
    }

    /**
     * @param {{
     *   workflowId: string, rootGoal: string, maxIterations?: number, subgoals?: unknown[], now?: number
     * }} options
     * @returns {GoalSession}
     */
    createGoalSession(options = {}) {
        return createGoalSession(options);
    }

    /**
     * @param {GoalSession} goalSession
     * @param {unknown[] | { nodes?: unknown[] }} planInput
     * @returns {GoalSession}
     */
    applyPlan(goalSession, planInput) {
        return applyPlan(goalSession, planInput);
    }

    /**
     * @param {GoalSession} goalSession
     * @returns {RouterSubgoal|null}
     */
    nextSubgoal(goalSession) {
        return nextSubgoal(goalSession);
    }

    /**
     * @param {GoalSession} goalSession
     * @returns {RouterSubgoal[]}
     */
    listReadySubgoals(goalSession) {
        return listReadySubgoals(goalSession);
    }

    /**
     * @param {GoalSession} goalSession
     * @param {{ subgoalId: string, status: SubgoalStatus, evidence?: unknown }} result
     * @returns {ReturnType<typeof applySubgoalResult>}
     */
    applySubgoalResult(goalSession, result) {
        return applySubgoalResult(goalSession, result, { maxAttempts: this.maxAttempts });
    }

    /**
     * @param {GoalSession} goalSession
     * @param {{ complete?: boolean, modelText?: string, requireExplicitCompletion?: boolean }} [options]
     * @returns {{ allowed: boolean, reasons: string[], completionTag: string }}
     */
    completionGate(goalSession, options = {}) {
        return completionGate(goalSession, options);
    }

    /**
     * @param {GoalSession} goalSession
     * @param {{ complete?: boolean, modelText?: string, requireExplicitCompletion?: boolean, now?: number }} [options]
     * @returns {{ goalSession: GoalSession, allowed: boolean, reasons: string[], completionTag: string }}
     */
    markGoalComplete(goalSession, options = {}) {
        return markGoalComplete(goalSession, options);
    }

    /**
     * @param {GoalSession} goalSession
     * @param {{ now?: number }} [options]
     * @returns {GoalSession}
     */
    advanceIteration(goalSession, options = {}) {
        return advanceIteration(goalSession, options);
    }

    /**
     * @param {GoalSession} goalSession
     * @returns {string}
     */
    buildPlanPrompt(goalSession) {
        return buildPlanPrompt(goalSession, { roles: this.roles });
    }

    /**
     * @param {GoalSession} goalSession
     * @returns {string}
     */
    buildContinuationPrompt(goalSession) {
        return buildContinuationPrompt(goalSession, { roles: this.roles });
    }

    /**
     * @param {GoalSession} goalSession
     * @param {string | Record<string, unknown>} subgoal
     * @returns {string}
     */
    buildVerifierPrompt(goalSession, subgoal) {
        return buildVerifierPrompt(goalSession, subgoal, { roles: this.roles });
    }

    /**
     * @param {GoalSession} goalSession
     * @returns {Record<string, unknown>}
     */
    serializeState(goalSession) {
        return serializeState(goalSession);
    }

    /**
     * @param {unknown} raw
     * @returns {GoalSession}
     */
    hydrateState(raw) {
        return hydrateState(raw);
    }

    /**
     * @param {GoalSession} goalSession
     * @returns {ReturnType<typeof toHarnessSnapshot>}
     */
    toHarnessSnapshot(goalSession) {
        return toHarnessSnapshot(goalSession);
    }
}
