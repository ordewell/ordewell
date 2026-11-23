import { describe, it, expect } from 'vitest';
import { assignableRunners, resolveAssignment, resolveAssignments, type AssignmentCatalog, type AssignmentWriter } from '../TaskAssignment';
import { createTask } from '../../models/Task';
import type { DiscoveredModel, Task } from '../../models/Task';
import type { RunnerModeInfo } from '../ModeResolver';

const variants = (...ids: string[]) => ids.map((id) => ({ id, label: id }));
const model = (modelId: string, ...levels: string[]): DiscoveredModel => ({ modelId, modelLabel: modelId.toUpperCase(), variants: variants(...levels) });

const CLAUDE_MODELS = [model('claude-sonnet-4-5', 'adaptive', 'low', 'high'), model('claude-haiku-4-5')];
const CODEX_MODELS = [model('gpt-5-codex', 'low', 'high'), model('o3')];
const CLAUDE_MODES: RunnerModeInfo[] = [
  { id: 'acceptEdits', label: 'Edit', description: 'edits' },
  { id: 'bypassPermissions', label: 'Bypass', description: 'all', autonomous: true },
  { id: 'auto', label: 'Auto', description: 'classifier', safe: true },
  { id: 'plan', label: 'Plan', description: 'Read only', readOnly: true },
];
const CODEX_MODES: RunnerModeInfo[] = [
  { id: 'agent', label: 'Agent', description: 'sandbox', safe: true },
  { id: 'fullAccess', label: 'Full access', description: 'all', autonomous: true },
  { id: 'inspect', label: 'Inspect', description: 'Read only', readOnly: true },
];

function catalog(over: Partial<AssignmentCatalog> = {}): AssignmentCatalog {
  return {
    modelsByRunner: { 'claude-code': CLAUDE_MODELS, codex: CODEX_MODELS },
    runnerModes: { 'claude-code': CLAUDE_MODES, codex: CODEX_MODES },
    ...over,
  };
}

function claudeTask(over: Partial<Task> = {}): Task {
  return createTask({
    id: 't1',
    title: 'Refactor PlanStore',
    assignedRunner: 'claude-code',
    assignedModel: { modelId: 'claude-sonnet-4-5', modelLabel: 'Claude Sonnet 4.5', thinkingEffort: 'adaptive', availableVariants: ['adaptive', 'low', 'high'] },
    taskMode: 'acceptEdits',
    ...over,
  });
}

/** `before` edited by `changes`, as `writer` would write it. */
function edit(writer: AssignmentWriter, before: Task, changes: Partial<Task>, over: Partial<AssignmentCatalog> = {}) {
  return resolveAssignment({ writer, task: { ...before, ...changes }, before, catalog: catalog(over) });
}

function landed(outcome: ReturnType<typeof resolveAssignment>): Task {
  if (!outcome.ok) throw new Error(outcome.error);
  return outcome.task;
}

describe('resolveAssignment: a task moved to another runner', () => {
  it('takes that runner\'s model, carries its effort to the nearest level, and its mode for the level', () => {
    const outcome = edit('user', claudeTask(), { assignedRunner: 'codex' });

    expect(landed(outcome)).toMatchObject({
      assignedRunner: 'codex',
      // 'adaptive' is Claude-only; the ladder maps it to medium, then down to the nearest level Codex offers.
      assignedModel: { modelId: 'gpt-5-codex', modelLabel: 'GPT-5-CODEX', thinkingEffort: 'low', availableVariants: ['low', 'high'] },
      taskMode: 'agent',
    });
    expect(outcome.ok && outcome.adjustments).toEqual([
      { taskId: 't1', title: 'Refactor PlanStore', field: 'assignedModel', from: 'claude-sonnet-4-5', to: 'gpt-5-codex' },
      { taskId: 't1', title: 'Refactor PlanStore', field: 'thinkingEffort', from: 'adaptive', to: 'low' },
    ]);
  });

  it('does so for the planner\'s edit too, which names no model for the move', () => {
    expect(landed(edit('edit', claudeTask(), { assignedRunner: 'codex' })).assignedModel?.modelId).toBe('gpt-5-codex');
  });

  it('lands on the safe mode under Guarded', () => {
    expect(landed(edit('user', claudeTask(), { assignedRunner: 'codex' }, { autonomousDefault: false })).taskMode).toBe('agent');
  });

  it('keeps a model and an effort the new runner also offers', () => {
    const shared = claudeTask({ assignedModel: { modelId: 'gpt-5-codex', modelLabel: 'GPT-5 Codex', thinkingEffort: 'high', availableVariants: ['low', 'high'] } });

    const outcome = edit('user', shared, { assignedRunner: 'codex' });

    expect(landed(outcome).assignedModel).toEqual(shared.assignedModel);
    expect(outcome.ok && outcome.adjustments).toEqual([]);
  });

  it('keeps a mode the new runner also offers', () => {
    const modes = { 'claude-code': CLAUDE_MODES, codex: [...CODEX_MODES, { id: 'acceptEdits', label: 'Edit', description: '' }] };
    expect(landed(edit('user', claudeTask(), { assignedRunner: 'codex' }, { runnerModes: modes })).taskMode).toBe('acceptEdits');
  });

  it('keeps a read-only task read-only by the manifest tag, not the mode id (ADR-0001)', () => {
    expect(landed(edit('user', claudeTask({ taskMode: 'plan' }), { assignedRunner: 'codex' })).taskMode).toBe('inspect');
    expect(landed(edit('edit', claudeTask({ taskMode: 'plan' }), { assignedRunner: 'codex' })).taskMode).toBe('inspect');
  });

  it('refuses to move a read-only task to a runner with no read-only mode, rather than give it write access', () => {
    const modes = { 'claude-code': CLAUDE_MODES, codex: CODEX_MODES.filter((m) => !m.readOnly), opencode: [{ id: 'build', label: 'Build', description: '' }] };

    const outcome = edit('user', claudeTask({ taskMode: 'plan' }), { assignedRunner: 'opencode' }, { runnerModes: modes });

    expect(outcome).toEqual({ ok: false, field: 'taskMode', error: '"Refactor PlanStore" is read-only, and runner "opencode" has no read-only mode: give it another mode first, or move it to one of: claude-code' });
  });

  it('carries the effort to the nearest level the new model has, or none where it has none', () => {
    const xhigh = claudeTask({ assignedModel: { modelId: 'claude-sonnet-4-5', modelLabel: 'Sonnet', thinkingEffort: 'xhigh' } });
    expect(landed(edit('user', xhigh, { assignedRunner: 'codex' })).assignedModel?.thinkingEffort).toBe('high');

    const plain = { modelsByRunner: { 'claude-code': CLAUDE_MODELS, opencode: [model('zen/kimi')] }, runnerModes: { opencode: [{ id: 'build', label: 'Build', description: '' }] } };
    expect(landed(edit('user', claudeTask(), { assignedRunner: 'opencode' }, plain)).assignedModel).toEqual({ modelId: 'zen/kimi', modelLabel: 'ZEN/KIMI', availableVariants: [] });
  });

  it('unassigns a model only the old runner lists when the new one\'s are unknown, and keeps one nobody lists', () => {
    const unknown = { modelsByRunner: { 'claude-code': CLAUDE_MODELS } };
    expect(landed(edit('user', claudeTask(), { assignedRunner: 'aider' }, unknown)).assignedModel).toBeUndefined();

    expect(landed(edit('user', claudeTask(), { assignedRunner: 'aider' }, { modelsByRunner: {} })).assignedModel?.modelId).toBe('claude-sonnet-4-5');
  });

  it('keeps the mode when the new runner declares none', () => {
    expect(landed(edit('user', claudeTask(), { assignedRunner: 'aider' }, { runnerModes: { aider: [] } })).taskMode).toBe('acceptEdits');
  });

  it('changes nothing for a re-pick of the same runner', () => {
    const task = claudeTask({ assignedRunner: 'codex', assignedModel: { modelId: 'o3', modelLabel: 'o3', availableVariants: [] }, taskMode: 'agent' });

    const outcome = edit('user', task, {});

    expect(outcome).toEqual({ ok: true, task, adjustments: [] });
  });
});

describe('resolveAssignment: a new task', () => {
  it('gets its runner\'s first model and the level\'s mode', () => {
    const outcome = resolveAssignment({ writer: 'userAdd', task: { ...claudeTask({ assignedRunner: 'codex', assignedModel: undefined }), taskMode: undefined }, catalog: catalog() });

    expect(landed(outcome)).toMatchObject({ assignedModel: { modelId: 'gpt-5-codex', modelLabel: 'GPT-5-CODEX', availableVariants: ['low', 'high'] }, taskMode: 'agent' });
  });

  it('keeps a model and a mode the user chose when the runner offers them', () => {
    const chosen = claudeTask({ assignedRunner: 'codex', assignedModel: { modelId: 'o3', modelLabel: 'o3' }, taskMode: 'agent' });

    expect(landed(resolveAssignment({ writer: 'userAdd', task: chosen, catalog: catalog() }))).toMatchObject({ assignedModel: { modelId: 'o3' }, taskMode: 'agent' });
  });

  it('is left as it is when discovery found nothing and no modes are known', () => {
    const bare = { ...claudeTask({ assignedRunner: 'aider', assignedModel: undefined }), taskMode: undefined };

    expect(landed(resolveAssignment({ writer: 'userAdd', task: bare, catalog: { modelsByRunner: {} } }))).toBe(bare);
  });

  it('refills a part made from a task on another runner, as a move does', () => {
    const from = claudeTask();
    const part = { ...claudeTask({ id: 'p2', title: 'Part two', assignedRunner: 'codex' }), taskMode: undefined };

    const outcome = resolveAssignment({ writer: 'edit', task: part, from, readOnly: false, catalog: catalog() });

    expect(landed(outcome)).toMatchObject({ assignedModel: { modelId: 'gpt-5-codex' }, taskMode: 'agent' });
  });
});

describe('resolveAssignment: a model the writer names', () => {
  const allowlist = { perRunnerAllowlist: { 'claude-code': ['claude-haiku-4-5'] } };
  const sonnetToOpus = { assignedModel: { modelId: 'claude-sonnet-4-5', modelLabel: 'Sonnet', thinkingEffort: 'high' } };
  const haikuTask = () => claudeTask({ assignedModel: { modelId: 'claude-haiku-4-5', modelLabel: 'Haiku' } });

  it('is refused off the allowlist for the planner\'s edit and the user\'s', () => {
    for (const writer of ['edit', 'user'] as const) {
      expect(edit(writer, haikuTask(), sonnetToOpus, allowlist)).toEqual({ ok: false, field: 'assignedModel', error: 'Model "claude-sonnet-4-5" is excluded by the allowlist for runner "claude-code"' });
    }
  });

  it('is replaced off the allowlist for a submitted plan and an added task, with its effort carried, and named', () => {
    for (const writer of ['plan', 'userAdd'] as const) {
      const outcome = resolveAssignment({ writer, task: claudeTask({ assignedModel: { modelId: 'claude-sonnet-4-5', modelLabel: 'Sonnet', thinkingEffort: 'high' } }), catalog: catalog(allowlist) });
      expect(landed(outcome).assignedModel).toEqual({ modelId: 'claude-haiku-4-5', modelLabel: 'CLAUDE-HAIKU-4-5', availableVariants: [] });
      expect(outcome.ok && outcome.adjustments.map((a) => [a.field, a.from, a.to])).toEqual([['assignedModel', 'claude-sonnet-4-5', 'claude-haiku-4-5'], ['thinkingEffort', 'high', null]]);
    }
  });

  it('is written as it is for the runner\'s own /model, off the allowlist too', () => {
    expect(landed(edit('runner', haikuTask(), sonnetToOpus, allowlist)).assignedModel).toMatchObject({ modelId: 'claude-sonnet-4-5', thinkingEffort: 'high' });
  });

  it('is refused where the runner does not offer it, for the planner\'s edit and the user\'s', () => {
    for (const writer of ['edit', 'user'] as const) {
      expect(edit(writer, claudeTask(), { assignedModel: { modelId: 'gpt-5-codex', modelLabel: 'GPT' } })).toEqual({ ok: false, field: 'assignedModel', error: 'Runner "claude-code" does not offer model "gpt-5-codex"' });
    }
  });

  it('is refilled where only another runner lists it, for a submitted plan, and kept where none does', () => {
    const stray = resolveAssignment({ writer: 'plan', task: claudeTask({ assignedRunner: 'codex' }), catalog: catalog() });
    expect(landed(stray).assignedModel?.modelId).toBe('gpt-5-codex');

    const unknown = resolveAssignment({ writer: 'plan', task: claudeTask({ assignedModel: { modelId: 'claude-future', modelLabel: 'Future', thinkingEffort: 'weird' } }), catalog: catalog() });
    expect(landed(unknown).assignedModel).toEqual({ modelId: 'claude-future', modelLabel: 'Future', thinkingEffort: 'weird' });
  });

  it('is accepted where it is allowlisted though discovery does not list it', () => {
    const future = { perRunnerAllowlist: { 'claude-code': ['claude-future'] } };
    expect(landed(edit('edit', claudeTask(), { assignedModel: { modelId: 'claude-future', modelLabel: 'Future' } }, future)).assignedModel?.modelId).toBe('claude-future');
  });

  it('has its effort held to what the model offers', () => {
    const outcome = edit('user', claudeTask(), { assignedModel: { modelId: 'claude-sonnet-4-5', modelLabel: 'Sonnet', thinkingEffort: 'max' } });
    expect(landed(outcome).assignedModel?.thinkingEffort).toBe('high');
  });
});

describe('resolveAssignment: a runner whose discovery came back empty, with an allowlist of another runner\'s slugs', () => {
  // A settings file written before a picker was scoped to one runner holds OpenRouter slugs for Claude Code.
  const legacy = catalog({
    modelsByRunner: { 'claude-code': [], openrouter: [model('openai/gpt-5'), model('anthropic/claude-x')] },
    perRunnerAllowlist: { 'claude-code': ['openai/gpt-5', 'anthropic/claude-x'] },
  });

  it('gives a planned task none of those slugs', () => {
    const planned = resolveAssignment({ writer: 'plan', task: claudeTask({ assignedModel: undefined }), catalog: legacy });
    expect(landed(planned).assignedModel).toBeUndefined();
  });

  it('keeps the model the planner wrote', () => {
    const planned = resolveAssignment({ writer: 'plan', task: claudeTask({ assignedModel: { modelId: 'sonnet', modelLabel: 'sonnet' } }), catalog: legacy });
    expect(landed(planned).assignedModel?.modelId).toBe('sonnet');
  });
});

describe('resolveAssignment: a model the writer left alone', () => {
  const offList = { perRunnerAllowlist: { 'claude-code': ['claude-haiku-4-5'] } };

  // The allowlist shapes what is written, not a model the user switched to (ADR-0043).
  it('stays off the allowlist, through an edit of its effort too', () => {
    expect(landed(edit('edit', claudeTask(), { title: 'Renamed' }, offList)).assignedModel?.modelId).toBe('claude-sonnet-4-5');
    const effort = edit('user', claudeTask(), { assignedModel: { ...claudeTask().assignedModel!, thinkingEffort: 'low' } }, offList);
    expect(landed(effort).assignedModel).toMatchObject({ modelId: 'claude-sonnet-4-5', thinkingEffort: 'low' });
  });

  it('has its effort clamped to what the model offers now', () => {
    const stale = claudeTask({ assignedModel: { modelId: 'claude-sonnet-4-5', modelLabel: 'Sonnet', thinkingEffort: 'max' } });
    expect(landed(edit('edit', stale, { title: 'Renamed' })).assignedModel?.thinkingEffort).toBe('high');
  });
});

describe('resolveAssignment: a task whose runner is live', () => {
  const live = { liveRunner: (id: string) => id === 't1' };

  it('refuses another runner, model or effort, a cleared model included', () => {
    expect(edit('user', claudeTask(), { assignedRunner: 'codex' }, live)).toMatchObject({ ok: false, field: 'assignedRunner' });
    expect(edit('edit', claudeTask(), { assignedModel: { modelId: 'claude-haiku-4-5', modelLabel: 'Haiku' } }, live)).toMatchObject({ ok: false, field: 'assignedModel' });
    expect(edit('user', claudeTask(), { type: 'user', assignedModel: undefined }, live)).toEqual({
      ok: false, field: 'assignedModel', error: '"Refactor PlanStore" has a live runner, so its model and effort cannot change now: stop the task first, or use the runner\'s own /model',
    });
  });

  it('holds its model and effort as they are, even where the model\'s levels changed since', () => {
    const stale = claudeTask({ assignedModel: { modelId: 'claude-sonnet-4-5', modelLabel: 'Sonnet', thinkingEffort: 'max' } });
    expect(landed(edit('edit', stale, { title: 'Renamed' }, live)).assignedModel?.thinkingEffort).toBe('max');
  });

  it('still takes a mode the user picks, and the runner\'s own switch', () => {
    expect(landed(edit('user', claudeTask(), { taskMode: 'auto' }, live)).taskMode).toBe('auto');
    expect(landed(edit('runner', claudeTask(), { assignedModel: { modelId: 'claude-haiku-4-5', modelLabel: 'Haiku' } }, live)).assignedModel?.modelId).toBe('claude-haiku-4-5');
  });
});

describe('resolveAssignment: a mode the user picks', () => {
  it('stands at either level, where the runner has it', () => {
    expect(landed(edit('user', claudeTask(), { taskMode: 'bypassPermissions' }, { autonomousDefault: false })).taskMode).toBe('bypassPermissions');
  });

  it('is refused where the runner has no such mode, naming the ones it has', () => {
    expect(edit('user', claudeTask(), { taskMode: 'yolo' })).toEqual({ ok: false, field: 'taskMode', error: 'Runner "claude-code" has no task mode "yolo": valid modes: acceptEdits, bypassPermissions, auto, plan' });
  });

  it('wins over the mode a move would give, held to the new runner', () => {
    expect(landed(edit('user', claudeTask(), { assignedRunner: 'codex', taskMode: 'agent' })).taskMode).toBe('agent');
    expect(edit('user', claudeTask(), { assignedRunner: 'codex', taskMode: 'auto' })).toMatchObject({ ok: false, field: 'taskMode' });
  });
});

describe('resolveAssignment: a manual task', () => {
  it('is left alone', () => {
    const manual = createTask({ title: 'Rotate the API key', type: 'user', assignedRunner: 'claude-code', taskMode: 'acceptEdits' });
    expect(edit('user', manual, { assignedRunner: 'codex' })).toEqual({ ok: true, task: { ...manual, assignedRunner: 'codex' }, adjustments: [] });
  });

  // Bug: the flip derived nothing, so the task ran on the legacy `build` default.
  it('turned into an AI task gets the mode and model the planner path gives one', () => {
    const manual = createTask({ id: 't1', title: 'Sign off', type: 'user', assignedRunner: 'codex' });
    expect(landed(edit('user', manual, { type: 'ai', prompt: 'sign it off' }))).toMatchObject({ taskMode: 'agent', assignedModel: { modelId: 'gpt-5-codex' } });
  });
});

describe('assignableRunners', () => {
  it('is the enabled runners for a plan and an edit alike, and any for the user', () => {
    expect(assignableRunners('plan', ['claude-code'])).toEqual(['claude-code']);
    expect(assignableRunners('edit', ['claude-code'])).toEqual(['claude-code']);
    expect(assignableRunners('user', ['claude-code'])).toBeUndefined();
  });
});

describe('resolveAssignments: the planner\'s tasks as they land', () => {
  const opencodeTask = (modelId: string, thinkingEffort?: string): Task => ({
    id: 't1', order: 0, title: 'test', description: '', type: 'ai', status: 'pending', dependencies: [], subtasks: [],
    assignedRunner: 'opencode', assignedModel: { modelId, modelLabel: modelId, ...(thinkingEffort ? { thinkingEffort } : {}) },
  });
  const land = (tasks: Task[], allowlist: Record<string, string[]>, modelsByRunner: AssignmentCatalog['modelsByRunner'] = {}, planned: Task[] = [], liveRunner?: AssignmentCatalog['liveRunner']) =>
    resolveAssignments(tasks, planned, { modelsByRunner, perRunnerAllowlist: allowlist, ...(liveRunner ? { liveRunner } : {}) });

  it('rewrites a model off the allowlist to its first, with no effort where discovery does not list that one', () => {
    const result = land([opencodeTask('stray-model', 'high')], { opencode: ['allowed-a', 'allowed-b'] }).tasks;
    expect(result[0].assignedModel).toEqual({ modelId: 'allowed-a', modelLabel: 'allowed-a' });
  });

  // One effort rule (ADR-0003, T2): the effort follows the model to its nearest level, as a move's does.
  it('carries the effort onto the allowlist\'s model at the nearest level it offers', () => {
    const result = land([opencodeTask('stray-model', 'high')], { opencode: ['allowed-a'] }, { opencode: [model('allowed-a', 'low', 'medium')] });
    expect(result.tasks[0].assignedModel).toEqual({ modelId: 'allowed-a', modelLabel: 'ALLOWED-A', thinkingEffort: 'medium', availableVariants: ['low', 'medium'] });
    expect(result.adjustments).toEqual([
      { taskId: 't1', title: 'test', field: 'assignedModel', from: 'stray-model', to: 'allowed-a' },
      { taskId: 't1', title: 'test', field: 'thinkingEffort', from: 'high', to: 'medium' },
    ]);
  });

  it('does not snap a task onto another runner\'s model that leaked into its allowlist', () => {
    const task = claudeTask({ assignedModel: { modelId: 'claude-sonnet-4-5', modelLabel: 'Sonnet' } });
    const result = land([task], { 'claude-code': ['gpt-5.6-sol'] }, { 'claude-code': [model('claude-sonnet-4-5')], opencode: [model('gpt-5.6-sol')] }).tasks;
    expect(result[0].assignedModel?.modelId).toBe('claude-sonnet-4-5');
  });

  it('leaves a manual task, a runner with no allowlist, and an allowed model untouched, and never moves a task', () => {
    const manual = { ...opencodeTask('stray'), type: 'user' as const };
    expect(land([manual], { opencode: ['allowed'] }).tasks[0].assignedModel?.modelId).toBe('stray');
    expect(land([opencodeTask('stray-model')], { other: ['allowed'] }).tasks[0].assignedModel?.modelId).toBe('stray-model');
    expect(land([opencodeTask('allowed-a', 'high')], { opencode: ['allowed-a'] }).tasks[0].assignedModel).toMatchObject({ modelId: 'allowed-a', thinkingEffort: 'high' });
    expect(land([claudeTask()], { opencode: ['deepseek'] }).tasks[0]).toMatchObject({ assignedRunner: 'claude-code', assignedModel: { modelId: 'claude-sonnet-4-5' } });
  });

  it('fills a missing model from the allowlist, else discovery, else leaves it to the runner', () => {
    const bare = (): Task => ({ ...opencodeTask('x'), assignedModel: undefined });
    expect(land([bare()], { opencode: ['allowed'] }).tasks[0].assignedModel?.modelId).toBe('allowed');
    expect(land([bare()], {}, { opencode: [model('discovered-a')] }).tasks[0].assignedModel?.modelId).toBe('discovered-a');
    expect(land([bare()], {}).tasks[0].assignedModel).toBeUndefined();
  });

  it('walks subtasks, which run as tasks of their own', () => {
    const parent = { ...opencodeTask('allowed'), subtasks: [{ ...opencodeTask('stray'), id: 's1', title: 'child' }] };
    const result = land([parent], { opencode: ['allowed'] });
    expect(result.tasks[0].subtasks[0].assignedModel?.modelId).toBe('allowed');
    expect(result.adjustments).toEqual([{ taskId: 's1', title: 'child', field: 'assignedModel', from: 'stray', to: 'allowed' }]);
  });

  it('clamps an effort to what its model offers, maps one it lacks, and drops one a plain model cannot take', () => {
    const catalogued = { opencode: [model('p/limited', 'low', 'medium', 'high'), model('p/plain')] };
    expect(land([opencodeTask('p/limited', 'high')], {}, catalogued).tasks[0].assignedModel?.thinkingEffort).toBe('high');
    expect(land([opencodeTask('p/limited', 'xhigh')], {}, catalogued).tasks[0].assignedModel?.thinkingEffort).toBe('high');
    expect(land([opencodeTask('p/plain', 'high')], {}, catalogued).tasks[0].assignedModel?.thinkingEffort).toBeUndefined();
    expect(land([opencodeTask('p/unknown', 'weird')], {}, catalogued).tasks[0].assignedModel?.thinkingEffort).toBe('weird');
  });

  it('keeps a task the planner left alone on its off-list model, clamping its effort', () => {
    const catalogued = { opencode: [model('p/limited', 'low', 'medium', 'high'), model('p/plain')] };
    const saved = opencodeTask('p/limited', 'xhigh');
    const { tasks, adjustments } = land([saved], { opencode: ['p/plain'] }, catalogued, [saved]);
    expect(tasks[0].assignedModel).toMatchObject({ modelId: 'p/limited', thinkingEffort: 'high', availableVariants: ['low', 'medium', 'high'] });
    expect(adjustments).toEqual([{ taskId: 't1', title: 'test', field: 'thinkingEffort', from: 'xhigh', to: 'high' }]);
  });

  // Its runner holds the model and effort while it is live (ADR-0041).
  it('leaves a task whose runner is live as the plan holds it', () => {
    const catalogued = { opencode: [model('p/limited', 'low', 'medium', 'high')] };
    const saved = opencodeTask('p/limited', 'xhigh');
    const { tasks, adjustments } = land([saved], {}, catalogued, [saved], () => true);
    expect(tasks[0].assignedModel).toEqual(saved.assignedModel);
    expect(adjustments).toEqual([]);
  });

  it('refills a restated task moved to another runner with that runner\'s model', () => {
    const before = claudeTask();
    const { tasks } = resolveAssignments([{ ...before, assignedRunner: 'codex' }], [before], catalog());
    expect(tasks[0].assignedModel?.modelId).toBe('gpt-5-codex');
  });
});
