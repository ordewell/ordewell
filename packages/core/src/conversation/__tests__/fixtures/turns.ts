import type { ResearchStep } from '../../../models/Task';
import type { SerializedConversationMessage } from '../../../services/SessionMessage';
import type { ConversationInput } from '../../reduce';

/**
 * Planner turns as a surface receives them: `SessionMessage`s in the order the
 * Session broadcasts them (see `SessionEventRelay.progress` and
 * `PlannerConversation.userTurn`), with the surface's own lines between.
 */

/** A prose reply streamed in one segment, then settled by its `planner_message`. */
export const streamedReply: ConversationInput[] = [
  { type: 'local_entry', role: 'user', text: 'add persistence' },
  { type: 'planner_turn_started', turnId: 't1', prompt: 'add persistence' },
  { type: 'planner_text_delta', turnId: 't1', segmentId: 's1', text: 'Which ' },
  { type: 'planner_text_delta', turnId: 't1', segmentId: 's1', text: 'store — SQLite ' },
  { type: 'planner_text_delta', turnId: 't1', segmentId: 's1', text: 'or Postgres?' },
  { type: 'planner_message', content: 'Which store: SQLite or Postgres?', timestamp: '2026-09-27T10:00:05.000Z', turnId: 't1' },
  { type: 'planner_turn_ended', turnId: 't1', outcome: 'message' },
];

/**
 * A turn whose first attempt the backend discarded for a corrective retry: the
 * attempt's text is taken back, and the retry streams and settles.
 */
export const retractedAttempt: ConversationInput[] = [
  { type: 'planner_turn_started', turnId: 't2', prompt: 'split task 3' },
  { type: 'planner_text_delta', turnId: 't2', segmentId: 's1', text: 'Checking the task first.' },
  { type: 'research_step', tool: 'read_file', args: '{"path":"PLAN.md"}', toolCallId: 'c1', turnId: 't2' },
  { type: 'research_step_done', step: { id: 'rs-1', tool: 'read_file', args: '{"path":"PLAN.md"}', result: '# Plan', success: true, outcome: 'success', toolCallId: 'c1', timestamp: '2026-09-27T10:01:01.000Z' }, turnId: 't2' },
  { type: 'planner_text_delta', turnId: 't2', segmentId: 's2', text: '{"taskOps": [ {"op": "spl' },
  { type: 'planner_text_retracted', turnId: 't2', segmentId: 's2' },
  { type: 'planner_text_delta', turnId: 't2', segmentId: 's3', text: 'Split it ' },
  { type: 'planner_text_retracted', turnId: 't2' },
  { type: 'planner_text_delta', turnId: 't2', segmentId: 's4', text: 'Task 3 splits cleanly ' },
  { type: 'planner_text_delta', turnId: 't2', segmentId: 's4', text: 'into 3a and 3b.' },
  { type: 'planner_message', content: 'Task 3 splits cleanly into 3a and 3b.', timestamp: '2026-09-27T10:01:09.000Z', turnId: 't2' },
  { type: 'planner_turn_ended', turnId: 't2', outcome: 'message' },
];

const step = (id: string, tool: ResearchStep['tool'], args: object, result: string, outcome: ResearchStep['outcome'], extra: Partial<ResearchStep> = {}): ResearchStep => ({
  id, tool, args: JSON.stringify(args), result, success: outcome === 'success', outcome, timestamp: '2026-09-27T10:02:00.000Z', ...extra,
});

/**
 * One research round of three reads run in parallel, whose results come back
 * in a different order than the calls went out, then a refused command.
 */
export const parallelRound: ConversationInput[] = [
  { type: 'planner_turn_started', turnId: 't3', prompt: 'where is config loaded?' },
  { type: 'research_step', tool: 'read_file', args: '{"path":"src/a.ts"}', toolCallId: 'call_a', turnId: 't3' },
  { type: 'research_step', tool: 'read_file', args: '{"path":"src/b.ts"}', toolCallId: 'call_b', turnId: 't3' },
  { type: 'research_step', tool: 'read_file', args: '{"path":"src/c.ts"}', toolCallId: 'call_c', turnId: 't3' },
  { type: 'research_step_done', step: step('rs-c', 'read_file', { path: 'src/c.ts' }, 'export const c = 3;', 'success', { toolCallId: 'call_c' }), turnId: 't3' },
  { type: 'research_step_done', step: step('rs-a', 'read_file', { path: 'src/a.ts' }, 'export const a = 1;\nexport const aa = 11;\n', 'success', { toolCallId: 'call_a' }), turnId: 't3' },
  { type: 'research_step_done', step: step('rs-b', 'read_file', { path: 'src/b.ts' }, 'ENOENT: src/b.ts', 'failure', { toolCallId: 'call_b' }), turnId: 't3' },
  { type: 'research_step', tool: 'bash', args: '{"command":"rm -rf dist"}', toolCallId: 'call_d', turnId: 't3' },
  { type: 'research_step_done', step: step('rs-d', 'bash', { command: 'rm -rf dist' }, 'Command refused: rm is destructive', 'refused', { toolCallId: 'call_d' }), turnId: 't3' },
];

/**
 * Two ADR-0005 research agents spawned in one round, working at once: their
 * reasoning and calls interleave, and each child's call id is only unique
 * within its own agent. The spawn call names the agent it starts.
 */
export const interleavedSubagents: ConversationInput[] = [
  { type: 'planner_turn_started', turnId: 't4', prompt: 'survey auth and billing' },
  { type: 'research_step', tool: 'spawn_research_agent', args: '{"prompt":"Survey auth"}', subagentId: 'sa-1', toolCallId: 'call_s1', turnId: 't4' },
  { type: 'subagent_started', turnId: 't4', subagentId: 'sa-1', brief: 'Survey auth', model: 'gpt-5-mini' },
  { type: 'research_step', tool: 'spawn_research_agent', args: '{"prompt":"Survey billing"}', subagentId: 'sa-2', toolCallId: 'call_s2', turnId: 't4' },
  { type: 'subagent_started', turnId: 't4', subagentId: 'sa-2', brief: 'Survey billing', model: 'gpt-5-mini' },
  { type: 'planner_thinking_delta', turnId: 't4', subagentId: 'sa-1', text: 'Auth lives' },
  { type: 'planner_thinking_delta', turnId: 't4', subagentId: 'sa-2', text: 'Billing is' },
  { type: 'planner_thinking_delta', turnId: 't4', subagentId: 'sa-1', text: ' under src/auth.' },
  { type: 'research_step', tool: 'grep', args: '{"pattern":"login"}', subagentId: 'sa-1', toolCallId: 'call_0', turnId: 't4' },
  { type: 'research_step', tool: 'grep', args: '{"pattern":"invoice"}', subagentId: 'sa-2', toolCallId: 'call_0', turnId: 't4' },
  { type: 'research_step_done', step: step('subrs-sa-2-1', 'grep', { pattern: 'invoice' }, 'src/billing/invoice.ts:4', 'success', { toolCallId: 'call_0', subagentId: 'sa-2' }), subagentId: 'sa-2', turnId: 't4' },
  { type: 'research_step_done', step: step('subrs-sa-1-1', 'grep', { pattern: 'login' }, 'src/auth/login.ts:9', 'success', { toolCallId: 'call_0', subagentId: 'sa-1' }), subagentId: 'sa-1', turnId: 't4' },
  { type: 'subagent_finished', turnId: 't4', subagentId: 'sa-2', outcome: 'done', digest: 'Billing: src/billing', usage: { inputTokens: 900, outputTokens: 80 } },
  { type: 'subagent_finished', turnId: 't4', subagentId: 'sa-1', outcome: 'failed', digest: '[research agent failed: timeout]' },
  { type: 'research_step_done', step: step('rs-s1', 'spawn_research_agent', { prompt: 'Survey auth' }, '[research agent failed: timeout]', 'failure', { toolCallId: 'call_s1' }), subagentId: 'sa-1', turnId: 't4' },
  { type: 'research_step_done', step: step('rs-s2', 'spawn_research_agent', { prompt: 'Survey billing' }, 'Billing: src/billing', 'success', { toolCallId: 'call_s2' }), subagentId: 'sa-2', turnId: 't4' },
];

/**
 * A harness planner's own subagent (Claude Code's `Agent` tool): the call's id
 * is the subagent's id, and the call's result follows the subagent's finish.
 */
export const harnessSubagent: ConversationInput[] = [
  { type: 'planner_turn_started', turnId: 't5', prompt: 'map the tui' },
  { type: 'research_step', tool: 'agent_tool', toolLabel: 'Agent', args: '{"description":"Map the TUI","prompt":"Read tui/ and report","subagent_type":"Explore"}', toolCallId: 'toolu_1', turnId: 't5' },
  { type: 'subagent_started', turnId: 't5', subagentId: 'toolu_1', brief: 'Map the TUI' },
  { type: 'planner_thinking_delta', turnId: 't5', subagentId: 'toolu_1', text: 'Start with state.ts' },
  { type: 'research_step', tool: 'read_file', toolLabel: 'Read', args: '{"file_path":"tui/state.ts","path":"tui/state.ts"}', subagentId: 'toolu_1', toolCallId: 'toolu_2', turnId: 't5' },
  { type: 'research_step_done', step: step('rs-2', 'read_file', { file_path: 'tui/state.ts', path: 'tui/state.ts' }, 'export interface TuiState {}', 'success', { toolCallId: 'toolu_2', subagentId: 'toolu_1', toolLabel: 'Read' }), subagentId: 'toolu_1', turnId: 't5' },
  { type: 'subagent_finished', turnId: 't5', subagentId: 'toolu_1', outcome: 'done', digest: 'TUI state lives in tui/state.ts', usage: { inputTokens: 1200 } },
  { type: 'research_step_done', step: step('rs-1', 'agent_tool', { description: 'Map the TUI', prompt: 'Read tui/ and report', subagent_type: 'Explore' }, 'TUI state lives in tui/state.ts', 'success', { toolCallId: 'toolu_1', toolLabel: 'Agent' }), turnId: 't5' },
];

/**
 * The whole-plan broadcast that follows every plan mutation, carrying the
 * transcript as it now stands — and the turn, when a planner turn's commit is
 * what it carries.
 */
export function planSnapshot(conversationHistory: SerializedConversationMessage[], taskCount = 0, turnId?: string): ConversationInput {
  const tasks = Array.from({ length: taskCount }, (_, i) => ({
    id: `task-${i + 1}`, order: i + 1, title: `Task ${i + 1}`, type: 'ai', description: '', dependencies: [], assignedRunner: 'claude-code',
    assignedModel: null, taskMode: 'build', prompt: null, subtasks: [], userSteps: undefined, thinkingEffort: undefined, autonomy: undefined,
    sliceType: undefined, userStoriesCovered: undefined,
  }));
  return {
    type: 'plan_generated', plan: { tasks, runners: ['claude-code'], generatedAt: '2026-09-27T10:00:00.000Z', conversationHistory }, goal: 'add persistence', runners: ['claude-code'],
    ...(turnId ? { turnId } : {}),
  };
}

/** A turn whose reply is the plan: its JSON streams as `plan_token`, never as reply text. */
export const planTurn: ConversationInput[] = [
  { type: 'local_entry', role: 'user', text: 'use SQLite' },
  { type: 'planner_turn_started', turnId: 't6', prompt: 'use SQLite' },
  { type: 'research_step', tool: 'list_dir', args: '{"path":"src"}', toolCallId: 'call_l', turnId: 't6' },
  { type: 'research_step_done', step: step('rs-l', 'list_dir', { path: 'src' }, 'index.ts\nstore/', 'success', { toolCallId: 'call_l' }), turnId: 't6' },
  { type: 'plan_token', token: '```json\n{"tasks": [{"title": "Add the SQLite ', turnId: 't6', segmentId: 's1' },
  { type: 'plan_token', token: 'store"}, {"title": "Migrate"}]}\n```', turnId: 't6', segmentId: 's1' },
  planSnapshot([
    { role: 'user', content: 'add persistence', timestamp: '2026-09-27T10:00:00.000Z' },
    { role: 'assistant', content: 'Which store: SQLite or Postgres?', timestamp: '2026-09-27T10:00:05.000Z' },
    { role: 'user', content: 'use SQLite', timestamp: '2026-09-27T10:03:00.000Z' },
    { role: 'assistant', content: 'Plan generated with 2 tasks.', timestamp: '2026-09-27T10:03:20.000Z', kind: 'plan_generated' },
  ], 2, 't6'),
  { type: 'status_update', tasks: [] },
  { type: 'planner_turn_ended', turnId: 't6', outcome: 'plan' },
];

/** A turn whose reply is a task-ops envelope: it streams like a plan, but settles as a message. */
export const taskOpsTurn: ConversationInput[] = [
  { type: 'planner_turn_started', turnId: 't7', prompt: 'drop task 2' },
  { type: 'plan_token', token: '{"taskOps": [{"op": "remove", ', turnId: 't7' },
  { type: 'plan_token', token: '"task": "#2"}]}', turnId: 't7' },
  { type: 'planner_message', content: 'Tasks updated:\n- Removed #2', timestamp: '2026-09-27T10:04:10.000Z', turnId: 't7' },
  planSnapshot([
    { role: 'user', content: 'drop task 2', timestamp: '2026-09-27T10:04:00.000Z' },
    { role: 'assistant', content: 'Tasks updated:\n- Removed #2', timestamp: '2026-09-27T10:04:10.000Z' },
  ], 1),
  { type: 'planner_turn_ended', turnId: 't7', outcome: 'task_ops' },
];

/** A daemon from before turns existed: all reply text streamed as `plan_token`, nothing carried a turn. */
export const legacyProse: ConversationInput[] = [
  { type: 'plan_token', token: 'Which ' },
  { type: 'plan_token', token: 'store?' },
  { type: 'planner_message', content: 'Which store?', timestamp: '2026-09-27T10:00:05.000Z' },
];

/**
 * A plan behind a prose preamble in one segment: the segment follows its
 * opening and streams as text (`ReplySplitter`), and no message settles it.
 */
export const preambledPlan: ConversationInput[] = [
  { type: 'planner_turn_started', turnId: 't8', prompt: 'go ahead' },
  { type: 'planner_text_delta', turnId: 't8', segmentId: 's1', text: 'Here is the plan:\n```json\n{"tasks": [' },
  { type: 'planner_text_delta', turnId: 't8', segmentId: 's1', text: '{"title": "Ship it"}]}\n```' },
  planSnapshot([
    { role: 'user', content: 'go ahead', timestamp: '2026-09-27T10:07:00.000Z' },
    { role: 'assistant', content: 'Plan generated with 1 task.', timestamp: '2026-09-27T10:07:09.000Z', kind: 'plan_generated' },
  ], 1),
  { type: 'planner_turn_ended', turnId: 't8', outcome: 'plan' },
];

/** A turn the user stopped mid-research, with a call and a subagent still out. */
export const stoppedTurn: ConversationInput[] = [
  { type: 'planner_turn_started', turnId: 't9', prompt: 'dig deeper' },
  { type: 'planner_thinking_delta', turnId: 't9', segmentId: 'r1', text: 'Looking at CI' },
  { type: 'planner_text_delta', turnId: 't9', segmentId: 's1', text: 'Let me check CI.' },
  { type: 'research_step', tool: 'bash', args: '{"command":"npm test"}', toolCallId: 'call_t', turnId: 't9' },
  { type: 'research_step', tool: 'spawn_research_agent', args: '{"prompt":"Check CI"}', subagentId: 'sa-9', toolCallId: 'call_sp', turnId: 't9' },
  { type: 'subagent_started', turnId: 't9', subagentId: 'sa-9', brief: 'Check CI' },
  { type: 'research_step', tool: 'read_file', args: '{"path":".github/ci.yml"}', subagentId: 'sa-9', toolCallId: 'call_r', turnId: 't9' },
  { type: 'plan_token', token: '{"tas', turnId: 't9' },
  { type: 'planner_turn_ended', turnId: 't9', outcome: 'stopped' },
];

/** Research reaching outside its envelope (ADR-0008): one ask granted, one policy decision, one ask denied. */
export const approvals: ConversationInput[] = [
  { type: 'research_step', tool: 'bash', args: '{"command":"npm test"}', toolCallId: 'call_n', turnId: 't10' },
  { type: 'approval_request', id: 'ap-1', kind: 'shell_command', subject: 'npm test', scope: 'npm test', detail: 'Runs the project\'s tests', turnId: 't10' },
  { type: 'approval_settled', id: 'ap-1', granted: true },
  { type: 'approval_decided', kind: 'external_path', subject: '/etc/hosts', scope: '/etc', granted: false, source: 'mode' },
  { type: 'approval_request', id: 'ap-2', kind: 'url_fetch', subject: 'https://example.com/api', scope: 'example.com', turnId: 't10' },
  { type: 'approval_settled', id: 'ap-2', granted: false },
];

/** The token line through a turn: a first report, a line added meanwhile, then totals that include a subagent. */
export const usageUpdates: ConversationInput[] = [
  { type: 'planner_usage', turnId: 't11', totals: {} },
  { type: 'planner_usage', turnId: 't11', totals: { inputTokens: 1000, outputTokens: 50 }, contextFill: { usedTokens: 1000, windowTokens: 200000 } },
  { type: 'local_entry', role: 'system', text: 'Planner model: gpt-5' },
  {
    type: 'planner_usage', turnId: 't11',
    totals: { inputTokens: 2500, outputTokens: 120, reportedCost: { USD: 0.01 } },
    bySubagent: { 'sa-1': { inputTokens: 900, outputTokens: 30 } },
    contextFill: { usedTokens: 1600, windowTokens: 200000 },
  },
];

/** A user-triggered compaction: the summary is announced as a message, then the transcript it now heads. */
export const compaction: ConversationInput[] = [
  { type: 'planner_message', content: 'Conversation condensed.\n\nGoal: add persistence with SQLite.', timestamp: '2026-09-27T11:00:00.000Z' },
  planSnapshot([
    { role: 'assistant', content: 'Conversation condensed.\n\nGoal: add persistence with SQLite.', timestamp: '2026-09-27T11:00:00.000Z', kind: 'compaction' },
    { role: 'user', content: 'go ahead', timestamp: '2026-09-27T10:07:00.000Z' },
    { role: 'assistant', content: 'Plan generated with 1 task.', timestamp: '2026-09-27T10:07:09.000Z', kind: 'plan_generated' },
  ], 1),
];
