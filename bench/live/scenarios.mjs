/**
 * The scripted `SessionMessage` sequences the webview harness plays through a
 * real `ConversationViewHost` (see host-driver.mjs). Shaped like core's own
 * conversation fixtures (packages/core/src/conversation/__tests__/fixtures/turns.ts)
 * so the states here are ones the reducer is already proven against — this
 * file adapts them into a single guided tour, plus the handful of top-level
 * `HostToWebview` messages (setRunners, planUpdated, …) a real host sends that
 * never pass through the conversation.
 *
 * Each step is one of:
 *   { post: HostToWebviewMessage }        — sent to the page as-is
 *   { drive: (host) => void }             — mutates the ConversationViewHost;
 *                                            its output is flushed and sent
 *   { mark: string }                      — a named checkpoint the driving
 *                                            script can screenshot/assert at
 */

const step = (id, tool, args, result, outcome, extra = {}) => ({
  id, tool, args: JSON.stringify(args), result, success: outcome === 'success', outcome, timestamp: '2026-09-27T10:02:00.000Z', ...extra,
});

const SETUP = [
  { post: { type: 'setConfiguredProviders', providers: ['openrouter'] } },
  {
    post: {
      type: 'setPlannerBackends',
      backends: [
        { id: 'openrouter', label: 'OpenRouter', kind: 'vendor', usable: true },
        { id: 'claude-code', label: 'Claude Code', kind: 'harness', runner: 'claude-code', usable: true },
      ],
      provider: 'openrouter',
    },
  },
  { post: { type: 'setModelConfig', modelConfig: { orchestrator: 'deepseek/deepseek-v4-flash' } } },
  {
    post: {
      type: 'setRunners',
      runners: [
        { id: 'claude-code', displayName: 'Claude Code', enabled: true },
        { id: 'codex', displayName: 'Codex', enabled: true },
      ],
    },
  },
  { mark: 'empty' },
];

/** A prose reply streamed in one segment, then settled — screenshot mid-stream and after. */
const STREAMED_REPLY = [
  { drive: (h) => h.note('user', 'add persistence') },
  { drive: (h) => h.receive({ type: 'planner_turn_started', turnId: 't1', prompt: 'add persistence' }) },
  { drive: (h) => h.receive({ type: 'planner_text_delta', turnId: 't1', segmentId: 's1', text: 'Which ' }) },
  { mark: 'reply-streaming' },
  { drive: (h) => h.receive({ type: 'planner_text_delta', turnId: 't1', segmentId: 's1', text: 'store — SQLite ' }) },
  { drive: (h) => h.receive({ type: 'planner_text_delta', turnId: 't1', segmentId: 's1', text: 'or Postgres?' }) },
  { drive: (h) => h.receive({ type: 'planner_message', content: 'Which store: SQLite or Postgres?', timestamp: '2026-09-27T10:00:05.000Z', turnId: 't1' }) },
  { drive: (h) => h.receive({ type: 'planner_turn_ended', turnId: 't1', outcome: 'message' }) },
  { mark: 'reply-settled' },
  { drive: (h) => h.note('user', 'use SQLite') },
];

/** Building plan → plan marker, with a command row long enough to need its 3-line preview. */
const PLAN_TURN = [
  { drive: (h) => h.receive({ type: 'planner_turn_started', turnId: 't6', prompt: 'use SQLite' }) },
  { drive: (h) => h.receive({ type: 'planner_thinking_delta', turnId: 't6', text: 'The repo already lists its source under src, so start there.' }) },
  { mark: 'thinking-collapsed' },
  { drive: (h) => h.receive({ type: 'research_step', tool: 'list_dir', args: '{"path":"src"}', toolCallId: 'call_l', turnId: 't6' }) },
  {
    drive: (h) => h.receive({
      type: 'research_step_done',
      step: step('rs-l', 'list_dir', { path: 'src' }, 'index.ts\nstore/\nstore/sqlite.ts\nstore/postgres.ts\nutils.ts\ntypes.ts', 'success', { toolCallId: 'call_l' }),
      turnId: 't6',
    }),
  },
  { mark: 'command-row' },
  { drive: (h) => h.receive({ type: 'plan_token', token: '```json\n{"tasks": [{"title": "Add the SQLite ', turnId: 't6', segmentId: 's1' }) },
  { mark: 'building-plan' },
  { drive: (h) => h.receive({ type: 'plan_token', token: 'store"}, {"title": "Migrate"}]}\n```', turnId: 't6', segmentId: 's1' }) },
  {
    // The reducer's syncTranscript only reads plan.conversationHistory (the
    // marker text and its position) — the tasks themselves arrive separately
    // as the `planUpdated` broadcast below, the plan dock's own copy.
    drive: (h) => h.receive({
      type: 'plan_generated',
      turnId: 't6',
      plan: {
        conversationHistory: [
          { role: 'user', content: 'add persistence', timestamp: '2026-09-27T10:00:00.000Z' },
          { role: 'assistant', content: 'Which store: SQLite or Postgres?', timestamp: '2026-09-27T10:00:05.000Z' },
          { role: 'user', content: 'use SQLite', timestamp: '2026-09-27T10:03:00.000Z' },
          { role: 'assistant', content: 'Plan generated with 2 tasks.', timestamp: '2026-09-27T10:03:20.000Z', kind: 'plan_generated' },
        ],
      },
    }),
  },
  {
    // The plan dock's own copy of the plan — a separate broadcast from the
    // conversation marker (Session emits both; see ChatViewProvider.sendPlanUpdated).
    post: {
      type: 'planUpdated',
      plan: {
        tasks: [
          { id: 'task-1', order: 1, title: 'Add the SQLite store', description: 'Wire up better-sqlite3 and a migrations table', type: 'ai', status: 'pending', dependencies: [], subtasks: [], assignedRunner: 'claude-code', completionMarker: 'm1', taskMode: 'acceptEdits', assignedModel: { modelId: 'deepseek/deepseek-v4-flash', modelLabel: 'DeepSeek V4 Flash' } },
          { id: 'task-2', order: 2, title: 'Migrate', description: 'Write the migration runner', type: 'ai', status: 'pending', dependencies: ['task-1'], subtasks: [], assignedRunner: 'claude-code', completionMarker: 'm2', taskMode: 'acceptEdits' },
        ],
        generatedAt: '2026-09-27T10:03:20.000Z',
        status: 'draft',
        runners: ['claude-code'],
        lastUpdated: '2026-09-27T10:03:20.000Z',
      },
    },
  },
  { mark: 'plan-marker' },
  { drive: (h) => h.receive({ type: 'planner_turn_ended', turnId: 't6', outcome: 'plan' }) },
];

/** Two ADR-0005 research agents working at once, interleaved. */
const SUBAGENTS = [
  { drive: (h) => h.receive({ type: 'planner_turn_started', turnId: 't4', prompt: 'survey auth and billing' }) },
  { drive: (h) => h.receive({ type: 'research_step', tool: 'spawn_research_agent', args: '{"prompt":"Survey auth"}', subagentId: 'sa-1', toolCallId: 'call_s1', turnId: 't4' }) },
  { drive: (h) => h.receive({ type: 'subagent_started', turnId: 't4', subagentId: 'sa-1', brief: 'Survey auth', model: 'gpt-5-mini' }) },
  { drive: (h) => h.receive({ type: 'research_step', tool: 'spawn_research_agent', args: '{"prompt":"Survey billing"}', subagentId: 'sa-2', toolCallId: 'call_s2', turnId: 't4' }) },
  { drive: (h) => h.receive({ type: 'subagent_started', turnId: 't4', subagentId: 'sa-2', brief: 'Survey billing', model: 'gpt-5-mini' }) },
  { drive: (h) => h.receive({ type: 'planner_thinking_delta', turnId: 't4', subagentId: 'sa-1', text: 'Auth lives under src/auth.' }) },
  { drive: (h) => h.receive({ type: 'research_step', tool: 'grep', args: '{"pattern":"login"}', subagentId: 'sa-1', toolCallId: 'call_0', turnId: 't4' }) },
  {
    drive: (h) => h.receive({
      type: 'research_step_done',
      step: step('subrs-sa-1-1', 'grep', { pattern: 'login' }, 'src/auth/login.ts:9', 'success', { toolCallId: 'call_0', subagentId: 'sa-1' }),
      subagentId: 'sa-1', turnId: 't4',
    }),
  },
  { drive: (h) => h.receive({ type: 'subagent_finished', turnId: 't4', subagentId: 'sa-2', outcome: 'done', digest: 'Billing: src/billing/invoice.ts', usage: { inputTokens: 900, outputTokens: 80 } }) },
  { drive: (h) => h.receive({ type: 'subagent_finished', turnId: 't4', subagentId: 'sa-1', outcome: 'done', digest: 'Auth: src/auth/login.ts' }) },
  { mark: 'subagent-collapsed' },
  { drive: (h) => h.receive({ type: 'planner_message', content: 'Auth is in src/auth, billing in src/billing.', timestamp: '2026-09-27T10:05:00.000Z', turnId: 't4' }) },
  { drive: (h) => h.receive({ type: 'planner_turn_ended', turnId: 't4', outcome: 'message' }) },
];

/** Research reaching outside its envelope (ADR-0008): granted, then denied. */
const APPROVALS = [
  { drive: (h) => h.receive({ type: 'planner_turn_started', turnId: 't10', prompt: 'run the tests and check external config' }) },
  { drive: (h) => h.receive({ type: 'research_step', tool: 'bash', args: '{"command":"npm test"}', toolCallId: 'call_n', turnId: 't10' }) },
  { drive: (h) => h.receive({ type: 'approval_request', id: 'ap-1', kind: 'shell_command', subject: 'npm test', scope: 'npm test', detail: "Runs the project's tests", turnId: 't10' }) },
  { mark: 'approval-pending' },
  { drive: (h) => h.receive({ type: 'approval_settled', id: 'ap-1', granted: true }) },
  { mark: 'approval-settled' },
  { drive: (h) => h.receive({ type: 'approval_decided', kind: 'external_path', subject: '/etc/hosts', scope: '/etc', granted: false, source: 'mode' }) },
  { drive: (h) => h.receive({ type: 'planner_message', content: 'Tests pass. The external config read was denied by policy.', timestamp: '2026-09-27T10:06:00.000Z', turnId: 't10' }) },
  { drive: (h) => h.receive({ type: 'planner_turn_ended', turnId: 't10', outcome: 'message' }) },
];

/** The token line through a turn: a first report, a line added meanwhile, then totals with a subagent. */
const USAGE = [
  { drive: (h) => h.receive({ type: 'planner_usage', turnId: 't11', totals: {} }) },
  { drive: (h) => h.receive({ type: 'planner_usage', turnId: 't11', totals: { inputTokens: 1000, outputTokens: 50 }, contextFill: { usedTokens: 1000, windowTokens: 200000 } }) },
  { drive: (h) => h.note('system', 'Planner model: gpt-5') },
  {
    drive: (h) => h.receive({
      type: 'planner_usage', turnId: 't11',
      totals: { inputTokens: 2500, outputTokens: 120, reportedCost: { USD: 0.01 } },
      bySubagent: { 'sa-1': { inputTokens: 900, outputTokens: 30 } },
      contextFill: { usedTokens: 1600, windowTokens: 200000 },
    }),
  },
  { mark: 'usage-line' },
];

/** A turn whose first attempt is discarded for a corrective retry: the retracted text must never reach the screen. */
const RETRACTED_ATTEMPT = [
  { drive: (h) => h.receive({ type: 'planner_turn_started', turnId: 't2', prompt: 'split task 3' }) },
  { drive: (h) => h.receive({ type: 'planner_text_delta', turnId: 't2', segmentId: 's1', text: 'Checking the task first.' }) },
  { drive: (h) => h.receive({ type: 'research_step', tool: 'read_file', args: '{"path":"PLAN.md"}', toolCallId: 'c1', turnId: 't2' }) },
  { drive: (h) => h.receive({ type: 'research_step_done', step: step('rs-1', 'read_file', { path: 'PLAN.md' }, '# Plan', 'success', { toolCallId: 'c1' }), turnId: 't2' }) },
  { drive: (h) => h.receive({ type: 'planner_text_delta', turnId: 't2', segmentId: 's2', text: '{"taskOps": [ {"op": "spl' }) },
  { drive: (h) => h.receive({ type: 'planner_text_retracted', turnId: 't2', segmentId: 's2' }) },
  { drive: (h) => h.receive({ type: 'planner_text_delta', turnId: 't2', segmentId: 's3', text: 'Split it ' }) },
  { drive: (h) => h.receive({ type: 'planner_text_retracted', turnId: 't2' }) },
  { drive: (h) => h.receive({ type: 'planner_text_delta', turnId: 't2', segmentId: 's4', text: 'Task 3 splits cleanly ' }) },
  { drive: (h) => h.receive({ type: 'planner_text_delta', turnId: 't2', segmentId: 's4', text: 'into 3a and 3b.' }) },
  { drive: (h) => h.receive({ type: 'planner_message', content: 'Task 3 splits cleanly into 3a and 3b.', timestamp: '2026-09-27T10:01:09.000Z', turnId: 't2' }) },
  { drive: (h) => h.receive({ type: 'planner_turn_ended', turnId: 't2', outcome: 'message' }) },
  { mark: 'retracted-attempt' },
];

/** A turn left open so the page's own queued-prompt / Esc handling can be driven live. */
const OPEN_TURN = [
  { drive: (h) => h.receive({ type: 'planner_turn_started', turnId: 't12', prompt: 'anything else?' }) },
  { drive: (h) => h.receive({ type: 'planner_text_delta', turnId: 't12', segmentId: 's1', text: 'Thinking about what else the store needs.' }) },
  { mark: 'turn-open' },
];

export const MAIN_SCENARIO = [
  ...SETUP,
  ...STREAMED_REPLY,
  ...PLAN_TURN,
  ...SUBAGENTS,
  ...APPROVALS,
  ...USAGE,
  ...RETRACTED_ATTEMPT,
  ...OPEN_TURN,
];

/** What `fromTranscript` (R1) rebuilds a reopened session from: no thinking, everything else. */
export const RELOAD_FIXTURE = {
  conversationHistory: [
    { role: 'user', content: 'add a parser', timestamp: '2026-01-01T00:00:00.000Z' },
    { role: 'assistant', content: 'Which formats do you need?', timestamp: '2026-01-01T00:00:01.000Z' },
    { role: 'user', content: 'JSON please', timestamp: '2026-01-01T00:00:02.000Z' },
    { role: 'assistant', content: 'Plan generated with 1 task.', timestamp: '2026-01-01T00:00:03.000Z', kind: 'plan_generated' },
    { role: 'assistant', content: 'Anything else you want tweaked?', timestamp: '2026-01-01T00:00:04.000Z' },
  ],
  researchLog: [
    step('rl-1', 'read_file', { path: 'package.json' }, '{"name":"demo"}', 'success', { toolCallId: 'call_1' }),
    { id: 'rl-2', type: 'subagent', subagentId: 'sa-1', brief: 'Survey existing parsers', outcome: 'done', digest: 'No parser exists yet.', timestamp: '2026-01-01T00:00:02.500Z' },
  ],
  plannerUsage: { totals: { inputTokens: 4200, outputTokens: 310 }, lastPromptTokens: 4200, contextWindow: 200000 },
};

export const RELOAD_PLAN = {
  tasks: [
    { id: 't1', order: 1, title: 'Restored Task', description: 'd', type: 'ai', status: 'pending', dependencies: [], subtasks: [], assignedRunner: 'claude-code', completionMarker: 'x', taskMode: 'build', prompt: 'p' },
  ],
  generatedAt: '2026-01-01T00:00:03.000Z', status: 'draft', runners: ['claude-code'], lastUpdated: '2026-01-01T00:00:03.000Z',
};
