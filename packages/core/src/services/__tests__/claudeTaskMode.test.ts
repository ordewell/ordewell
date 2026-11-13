import { describe, it, expect, vi, afterEach } from 'vitest';
import { existsSync, readFileSync, statSync } from 'fs';
import { addAttemptUsage, plannerContextFill, startAttemptUsage, usageText } from '../../models/Usage';
import { ClaudeCodeAdapter } from '../harness/ClaudeCodeAdapter';
import { CodexAdapter } from '../harness/CodexAdapter';
import { OpenCodeAdapter } from '../harness/OpenCodeAdapter';
import { TaskModeUnsupportedError, type AgentEvent, type AgentProcessDeps, type AgentStartOptions, type TaskStartOptions } from '../harness/AgentAdapter';
import { supportsTaskMode, createTaskAdapter } from '../harness/connectors';
import { resolveTaskRunnerFlags } from '../../plugins/resolveArgs';
import { CLAUDE_CODE_MANIFEST } from '../../plugins/builtin/claude-code.manifest';
import { mcpClientConfig } from '../mcp';
import { classifyRunnerStop, readUsageLimitReset } from '../runnerExit';
import { modeIds, fakeSpawn, fixture, claudeSteerRecording, type FakeSpawnOptions, type ScriptedReply } from './harnessTestKit';

/**
 * The adapter's task mode (ADR-0018, C1), against transcripts recorded from
 * `claude` 2.1.284 in `-p` stream-json mode. The planner's read-only start is
 * asserted here too, flag for flag: task mode must not have moved it.
 */

function deps(replies: ScriptedReply[], options: FakeSpawnOptions = {}) {
  const spawned = fakeSpawn(replies, options);
  const processDeps: AgentProcessDeps = {
    spawn: spawned.spawn,
    fetch: (async () => { throw new Error('no HTTP in this test'); }) as unknown as typeof fetch,
    resolvePath: async () => '/usr/bin',
    platform: 'linux',
    isDirectory: () => true,
    exists: () => true,
    workspaceEnv: async () => ({}),
  };
  return { spawned, processDeps };
}

function taskStart(overrides: Partial<TaskStartOptions> = {}): TaskStartOptions {
  return {
    kind: 'task',
    cwd: '/repo',
    mode: 'acceptEdits',
    flags: { permissionMode: 'acceptEdits', modeSettings: {} },
    ...overrides,
  };
}

/** A task in the mode a fixture was recorded under: the adapter holds the CLI to the mode asked for. */
function taskIn(permissionMode: string, overrides: Partial<TaskStartOptions> = {}): TaskStartOptions {
  return taskStart({ mode: permissionMode, flags: { permissionMode, modeSettings: {} }, ...overrides });
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** What the adapter wrote to the CLI, past the `initialize` every task opens with. */
function sent(spawned: ReturnType<typeof deps>['spawned']): string[] {
  return spawned.processes[0].written.filter((w) => !w.includes('"subtype":"initialize"'));
}

async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !condition(); i++) await tick();
  if (!condition()) throw new Error('condition never held');
}

describe('ClaudeCodeAdapter start switch', () => {
  it('starts a planner without native plan mode or shell tools, its requests routed to Ordewell', async () => {
    const { spawned, processDeps } = deps([]);
    const adapter = new ClaudeCodeAdapter(processDeps);
    await adapter.start({ kind: 'planner', cwd: '/repo', systemPrompt: 'PLAN', model: 'sonnet', effort: 'high', resumeSessionId: 'sess-1' });
    expect(spawned.lastCommand()).toBe('claude');
    expect(spawned.lastArgs()).toEqual([
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--permission-prompt-tool', 'stdio',
      '--permission-mode', 'default',
      '--disallowedTools', 'Edit,Write,MultiEdit,NotebookEdit,KillShell,Bash,Monitor,PowerShell,EnterPlanMode,ExitPlanMode',
      '--setting-sources', 'user',
      '--settings', '{"disableAllHooks":true,"permissions":{"ask":["WebFetch","WebFetch(domain:*)","WebSearch","mcp__*","Read","Grep","Glob","LS","LSP"]}}',
      '--append-system-prompt', 'PLAN',
      '--model', 'sonnet',
      '--effort', 'high',
      '--resume', 'sess-1',
    ]);
    adapter.dispose();
  });

  it.each([
    ['nothing else', {}],
    ['a model, an effort and a resume', { model: 'opus', effort: 'max', resumeSessionId: 'sess-1' }],
    // Task fields smuggled onto a planner start: nothing on the planner path reads them.
    ['a task\'s bypass mode and flags', { mode: 'bypassPermissions', flags: { permissionMode: 'bypassPermissions', effort: 'max', modeSettings: {} } }],
    ['the legacy build alias a task resolves to acceptEdits', { mode: 'build', flags: { permissionMode: 'acceptEdits', modeSettings: {} } }],
    // Native plan mode lets Bash write its plan file outside the workspace.
    ['a task\'s native plan mode', { mode: 'plan', flags: { permissionMode: 'plan', modeSettings: {} } }],
  ])('starts a planner read-only whatever else its start carries: %s', async (_label, extra) => {
    const { spawned, processDeps } = deps([]);
    const adapter = new ClaudeCodeAdapter(processDeps);
    await adapter.start({ kind: 'planner', cwd: '/repo', systemPrompt: 'PLAN', ...extra } as unknown as AgentStartOptions);
    const args = spawned.lastArgs();

    expect(args.flatMap((arg, i) => (arg === '--permission-mode' ? [args[i + 1]] : []))).toEqual(['default']);
    expect(args[args.indexOf('--disallowedTools') + 1].split(',')).toEqual(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'KillShell', 'Bash', 'Monitor', 'PowerShell', 'EnterPlanMode', 'ExitPlanMode']);
    expect(args[args.indexOf('--setting-sources') + 1]).toBe('user');
    expect(JSON.parse(args[args.indexOf('--settings') + 1])).toEqual({
      disableAllHooks: true,
      permissions: { ask: ['WebFetch', 'WebFetch(domain:*)', 'WebSearch', 'mcp__*', 'Read', 'Grep', 'Glob', 'LS', 'LSP'] },
    });
    for (const flag of ['--dangerously-skip-permissions', 'acceptEdits', 'bypassPermissions']) {
      expect(args).not.toContain(flag);
    }
    adapter.dispose();
  });

  it('starts a task with the protocol flags around the manifest-derived ones, and nothing of the planner', async () => {
    const { spawned, processDeps } = deps([]);
    const adapter = new ClaudeCodeAdapter(processDeps);
    await adapter.start(taskStart({
      model: 'opus',
      resumeSessionId: 'sess-9',
      flags: { permissionMode: 'default', effort: 'max', modeSettings: {} },
    }));
    expect(spawned.lastArgs()).toEqual([
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--replay-user-messages',
      '--permission-prompt-tool', 'stdio',
      '--permission-mode', 'default',
      '--disallowedTools', 'AskUserQuestion',
      '--thinking', 'enabled', '--effort', 'max',
      '--model', 'opus',
      '--resume', 'sess-9',
    ]);
    adapter.dispose();
  });
});

/**
 * The adapter maps the task's raw effort itself now; the argv a Claude task
 * starts with, and its parity with the terminal command line, must not move.
 */
describe('ClaudeCodeAdapter task argv for every effort and mode', () => {
  const thinking: Array<[string, string[]]> = [
    ['adaptive', ['--thinking', 'adaptive']],
    ['low', ['--thinking', 'enabled', '--effort', 'low']],
    ['medium', ['--thinking', 'enabled', '--effort', 'medium']],
    ['high', ['--thinking', 'enabled', '--effort', 'high']],
    ['xhigh', ['--thinking', 'enabled', '--effort', 'xhigh']],
    ['max', ['--thinking', 'enabled', '--effort', 'max']],
    ['disabled', ['--thinking', 'disabled']],
    // A legacy variant id an old task may still carry.
    ['thinking-16k', ['--thinking', 'adaptive']],
  ];
  const modes: Array<[string, string]> = [
    ['default', 'default'],
    ['acceptEdits', 'acceptEdits'],
    ['plan', 'default'],
    ['bypassPermissions', 'bypassPermissions'],
    ['build', 'acceptEdits'],
  ];
  const cases = modes.flatMap(([mode, permissionMode]) => [
    ...thinking.map(([effort, thinkingArgs]) => ({ mode, permissionMode, effort, model: 'sonnet' as string | undefined, thinkingArgs })),
    // Effort only rides with a model, on both transports.
    { mode, permissionMode, effort: 'max', model: undefined, thinkingArgs: [] },
  ]);

  async function taskArgs(mode: string, model: string | undefined, effort: string): Promise<string[]> {
    const { spawned, processDeps } = deps([]);
    const adapter = new ClaudeCodeAdapter(processDeps);
    await adapter.start(taskStart({ mode, model, flags: resolveTaskRunnerFlags(CLAUDE_CODE_MANIFEST, { mode, model, thinkingEffort: effort }) }));
    adapter.dispose();
    return spawned.lastArgs();
  }

  it.each(cases)('mode $mode, effort $effort, model $model', async ({ mode, permissionMode, effort, model, thinkingArgs }) => {
    expect(await taskArgs(mode, model, effort)).toEqual([
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--replay-user-messages',
      '--permission-prompt-tool', 'stdio',
      '--permission-mode', permissionMode,
      '--disallowedTools', mode === 'plan' ? 'AskUserQuestion,Edit,Write,MultiEdit,NotebookEdit,KillShell,Bash,Monitor,PowerShell,EnterPlanMode,ExitPlanMode' : 'AskUserQuestion',
      ...(mode === 'plan' ? ['--setting-sources', 'user', '--settings', '{"disableAllHooks":true,"permissions":{"ask":["WebFetch","WebFetch(domain:*)","WebSearch","mcp__*","Read","Grep","Glob","LS","LSP"]}}'] : []),
      ...thinkingArgs,
      ...(model ? ['--model', model] : []),
    ]);
  });


});

describe('task mode support', () => {
  it('is every built-in runner', () => {
    expect(supportsTaskMode('claude-code')).toBe(true);
    expect(supportsTaskMode('codex')).toBe(true);
    expect(supportsTaskMode('opencode')).toBe(true);
    expect(createTaskAdapter('codex', deps([]).processDeps)).toBeInstanceOf(CodexAdapter);
    expect(createTaskAdapter('opencode', deps([]).processDeps)).toBeInstanceOf(OpenCodeAdapter);
    expect(supportsTaskMode('toString')).toBe(false);
  });

  it('refuses a runner without a connector with a typed error', () => {
    expect(() => createTaskAdapter('my-plugin', deps([]).processDeps)).toThrow(TaskModeUnsupportedError);
    expect(() => createTaskAdapter('my-plugin', deps([]).processDeps)).toThrow('my-plugin has no structured task connector');
  });
});

describe('ClaudeCodeAdapter in task mode', () => {
  // Recorded on 2.1.303: with `--model claude-sonnet-5[1m]`, `init` names the
  // variant the turn runs as, the message names the API's canonical id, and
  // `modelUsage` keys the window by the variant. Using the canonical id for
  // the meter missed the window and read the base model's catalog one instead.
  it('counts a 1m variant under the id its init names, with the window modelUsage states for it', async () => {
    const SESSION = 'sess-1m';
    const init = { type: 'system', subtype: 'init', session_id: SESSION, permissionMode: 'acceptEdits', model: 'claude-sonnet-5[1m]' };
    const messageStart = {
      type: 'stream_event', session_id: SESSION, parent_tool_use_id: null,
      event: { type: 'message_start', message: { model: 'claude-sonnet-5', id: 'msg_1', usage: { input_tokens: 2, cache_creation_input_tokens: 100, cache_read_input_tokens: 400, output_tokens: 1 } } },
    };
    const messageDelta = {
      type: 'stream_event', session_id: SESSION, parent_tool_use_id: null,
      event: { type: 'message_delta', usage: { input_tokens: 2, cache_creation_input_tokens: 100, cache_read_input_tokens: 400, output_tokens: 10 } },
    };
    const result = {
      type: 'result', session_id: SESSION, subtype: 'success', is_error: false, result: 'ok', total_cost_usd: 0.02,
      modelUsage: { 'claude-sonnet-5[1m]': { costUSD: 0.02, contextWindow: 1_000_000, costBasis: 'list', canonicalModel: 'claude-sonnet-5' } },
    };
    const { processDeps } = deps([`${[init, messageStart, messageDelta, result].map((line) => JSON.stringify(line)).join('\n')}\n`]);
    const adapter = new ClaudeCodeAdapter(processDeps);
    await adapter.start(taskStart({ model: 'claude-sonnet-5[1m]' }));
    const events: AgentEvent[] = [];
    await adapter.send('go', (e) => events.push(e));

    const records = events.flatMap((event) => event.type === 'usage' ? [event.record] : []);
    expect(records).toContainEqual({ source: 'claude-code', model: 'claude-sonnet-5[1m]', inputTokens: 502, cachedInputTokens: 400, outputTokens: 10, contextTokens: 512 });
    expect(records).toContainEqual({ source: 'claude-code', model: 'claude-sonnet-5[1m]', contextWindow: 1_000_000 });
    expect(events.filter((event) => event.type === 'model_drifted' || event.type === 'model_switched')).toEqual([]);
    const ledger = records.reduce((usage, record) => addAttemptUsage(usage, record, '2026-10-19T18:00:01Z'),
      startAttemptUsage(1, 'claude-code', '2026-10-19T18:00:00Z'));
    expect(plannerContextFill(ledger)).toEqual({ usedTokens: 512, windowTokens: 1_000_000 });
    adapter.dispose();
  });

  // A subagent runs its own model in the same stream, tagged with the call that
  // spawned it. Its init and compaction are not the main model's, so neither
  // may move the task's meter or its model.
  it('does not let a subagent\'s init or compaction move the main model\'s meter', async () => {
    const SESSION = 'sess-sub';
    const line = (fields: object) => JSON.stringify({ session_id: SESSION, ...fields });
    const mainStart = (id: string) => line({
      type: 'stream_event', parent_tool_use_id: null,
      event: { type: 'message_start', message: { model: 'claude-haiku-5-5', id, usage: { input_tokens: 1, output_tokens: 1 } } },
    });
    const mainDelta = (input: number) => line({
      type: 'stream_event', parent_tool_use_id: null,
      event: { type: 'message_delta', usage: { input_tokens: input, output_tokens: 10 } },
    });
    const lines = [
      line({ type: 'system', subtype: 'init', permissionMode: 'acceptEdits', model: 'claude-haiku-5-5' }),
      mainStart('msg_1'), mainDelta(1000),
      // A subagent's own model and compaction, replayed with its spawning call.
      line({ type: 'system', subtype: 'init', parent_tool_use_id: 'toolu_agent', model: 'claude-opus-5-5' }),
      line({ type: 'system', subtype: 'compact_boundary', parent_tool_use_id: 'toolu_agent', compact_metadata: { trigger: 'auto', pre_tokens: 90_000, post_tokens: 5_000 } }),
      line({
        type: 'result', parent_tool_use_id: 'toolu_agent', subtype: 'success', is_error: false, result: 'subagent done', total_cost_usd: 99,
        modelUsage: { 'claude-opus-5-5': { costUSD: 99, contextWindow: 1_000_000, costBasis: 'list' } },
      }),
      mainStart('msg_2'), mainDelta(2000),
      line({
        type: 'result', subtype: 'success', is_error: false, result: 'ok', total_cost_usd: 0.01,
        modelUsage: { 'claude-haiku-5-5': { costUSD: 0.01, contextWindow: 200_000, costBasis: 'list' } },
      }),
    ];
    const { processDeps } = deps([`${lines.join('\n')}\n`]);
    const adapter = new ClaudeCodeAdapter(processDeps);
    await adapter.start(taskStart());
    const events: AgentEvent[] = [];
    await adapter.send('go', (e) => events.push(e));

    const records = events.flatMap((event) => event.type === 'usage' ? [event.record] : []);
    expect(records.filter((record) => record.compacted)).toEqual([]);
    expect(records.filter((record) => record.reportedCost?.amount === 99)).toEqual([]);
    expect(events.filter((event) => event.type === 'model_drifted' || event.type === 'model_switched')).toEqual([]);
    const ledger = records.reduce((usage, record) => addAttemptUsage(usage, record, '2026-10-19T18:00:01Z'),
      startAttemptUsage(1, 'claude-code', '2026-10-19T18:00:00Z'));
    expect(plannerContextFill(ledger)).toEqual({ usedTokens: 2010, windowTokens: 200_000 });
    adapter.dispose();
  });

  it('disables the question tool, so the agent asks in plain text and ends its turn (ADR-0018, M1)', async () => {
    const { spawned, processDeps } = deps([]);
    const adapter = new ClaudeCodeAdapter(processDeps);
    await adapter.start(taskStart());
    const args = spawned.lastArgs();
    expect(args.flatMap((arg, i) => (arg === '--disallowedTools' ? [args[i + 1]] : []))).toEqual(['AskUserQuestion']);
    adapter.dispose();
  });

  describe('background work', () => {
    afterEach(() => { vi.useRealTimers(); });

    // Recorded from `claude` 2.1.286: a background `sleep 20`, a `result` line while it
    // still runs, then — on its own — a second turn once it finishes.
    it('holds the turn open while a background task runs, so what the agent says after it is the same turn\'s', async () => {
      const { processDeps } = deps([fixture('claude-code', 'task-background')]);
      const adapter = new ClaudeCodeAdapter(processDeps);
      await adapter.start(taskStart());
      const events: AgentEvent[] = [];
      await adapter.send('wait for it', (e) => events.push(e));

      expect(events.filter((e) => e.type === 'turn_end')).toEqual([{ type: 'turn_end' }]);
      expect(events.at(-1)).toEqual({ type: 'turn_end' });
      const text = events.flatMap((e) => (e.type === 'assistant_text' ? [e.text] : [])).join('');
      expect(text).toContain('Waiting for the background command to complete');
      expect(text.trim().endsWith('FINISHED')).toBe(true);
      adapter.dispose();
    });

    it('ends the held turn once the work is done and the CLI starts no follow-on turn', async () => {
      vi.useFakeTimers();
      const { processDeps } = deps([fixture('claude-code', 'task-background-no-wake')]);
      const adapter = new ClaudeCodeAdapter(processDeps);
      await adapter.start(taskStart());
      const events: AgentEvent[] = [];
      let ended = false;
      void adapter.send('wait for it', (e) => events.push(e)).then(() => { ended = true; });

      await vi.advanceTimersByTimeAsync(1000);
      expect(events.some((e) => e.type === 'turn_end')).toBe(false);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(ended).toBe(true);
      expect(events.at(-1)).toEqual({ type: 'turn_end' });
      adapter.dispose();
    });

    it('does not hold a planner\'s turn', async () => {
      const { processDeps } = deps([fixture('claude-code', 'task-background')]);
      const adapter = new ClaudeCodeAdapter(processDeps);
      await adapter.start({ kind: 'planner', cwd: '/repo', systemPrompt: 'PLAN' });
      const events: AgentEvent[] = [];
      await adapter.send('wait for it', (e) => events.push(e));
      expect(events.at(-1)).toEqual({ type: 'turn_end' });
      expect(events.some((e) => e.type === 'assistant_text' && e.text.trim() === 'FINISHED')).toBe(false);
      adapter.dispose();
    });
  });

  it('fails the turn in plain words when the CLI starts in another mode than the plan asked for', async () => {
    const { processDeps } = deps([
      // Recorded from `claude` 2.1.286 asked for `--permission-mode auto` on haiku: no refusal, no warning.
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-1', cwd: '/repo', permissionMode: 'default', model: 'claude-haiku-4-5-20251001' }) + '\n',
    ]);
    const adapter = new ClaudeCodeAdapter(processDeps);
    await adapter.start(taskStart({ mode: 'auto', model: 'haiku', flags: { permissionMode: 'auto', modeSettings: {} } }));
    const events: AgentEvent[] = [];
    await adapter.send('go', (e) => events.push(e));

    expect(events).toEqual([{
      type: 'error',
      message: 'Claude Code started in "default" mode, not the "auto" mode the plan asked for. It does not report why; the model or the account may not offer it.',
    }]);
    adapter.dispose();
  });

  it('reports a usage limit as the turn\'s error, in words the reset time is read from (#84)', async () => {
    // Not recorded: the result line #79 describes, its text built from the
    // template in `claude` 2.1.296 ("You've hit your <limit> · resets <time> (<zone>)").
    const limit = "You've hit your session limit · resets 8:10pm (Europe/Rome)";
    const { processDeps } = deps([
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-1', cwd: '/repo', permissionMode: 'acceptEdits' }) + '\n'
        + JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: limit, session_id: 'sess-1' }) + '\n',
    ]);
    const adapter = new ClaudeCodeAdapter(processDeps);
    await adapter.start(taskStart());
    const events: AgentEvent[] = [];
    await adapter.send('go', (e) => events.push(e));

    const error = events.find((e): e is Extract<AgentEvent, { type: 'error' }> => e.type === 'error');
    expect(error?.message).toBe(limit);
    expect(classifyRunnerStop(error!.message)).toBe('usage-limit');
    expect(readUsageLimitReset('claude-code', error!.message, new Date('2026-10-11T17:00:00Z'))?.toISOString()).toBe('2026-10-11T18:10:00.000Z');
    adapter.dispose();
  });

  it('reports a resume the CLI cannot find as a failed turn in its own words, and lets the process go (ADR-0018, K1)', async () => {
    const { spawned, processDeps } = deps([]);
    const adapter = new ClaudeCodeAdapter(processDeps);
    await adapter.start(taskStart({ resumeSessionId: '0d6c1a52-3b7e-4f7e-9d1a-5b0c2e4f8a11' }));
    const proc = spawned.processes[0];
    const events: AgentEvent[] = [];
    const turn = adapter.send('also handle arrays', (e) => events.push(e));
    // Recorded from `claude` 2.1.284: the refusal arrives on its own, before any `init`.
    proc.emitStdout(fixture('claude-code', 'task-resume-not-found'));
    await turn;

    expect(events).toEqual([{ type: 'error', message: 'No conversation found with session ID: 0d6c1a52-3b7e-4f7e-9d1a-5b0c2e4f8a11' }]);
    // The CLI waits on stdin after refusing; closing it is what lets it exit.
    expect(proc.stdinEnded).toBe(true);
    // No session was taken up, so none is announced for a later continue.
    expect(adapter.nativeSessionId()).toBeNull();
    adapter.dispose();
  });

  it('refused before any turn opens, the next turn reports the CLI\'s last words instead of hanging', async () => {
    const { spawned, processDeps } = deps([]);
    const adapter = new ClaudeCodeAdapter(processDeps);
    await adapter.start(taskStart({ resumeSessionId: '0d6c1a52-3b7e-4f7e-9d1a-5b0c2e4f8a11' }));
    const proc = spawned.processes[0];
    proc.emitStderr('No conversation found with session ID: 0d6c1a52-3b7e-4f7e-9d1a-5b0c2e4f8a11\n');
    proc.emitStdout(fixture('claude-code', 'task-resume-not-found'));
    expect(proc.stdinEnded).toBe(true);
    proc.exit(1);

    const events: AgentEvent[] = [];
    await adapter.send('also handle arrays', (e) => events.push(e));

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'error', message: expect.stringContaining('No conversation found with session ID') });
    expect(adapter.nativeSessionId()).toBeNull();
    adapter.dispose();
  });

  it('takes a resumed session up once the CLI announces it', async () => {
    const { spawned, processDeps } = deps([fixture('claude-code', 'task-marker')]);
    const adapter = new ClaudeCodeAdapter(processDeps);
    await adapter.start(taskStart({ resumeSessionId: 'sess-task-marker' }));
    const events: AgentEvent[] = [];
    await adapter.send('go on', (e) => events.push(e));

    expect(events.at(-1)).toEqual({ type: 'turn_end' });
    expect(spawned.processes[0].stdinEnded).toBe(false);
    expect(adapter.nativeSessionId()).toBe('sess-task-marker');
    adapter.dispose();
  });

  describe('the cost of a resumed session', () => {
    // Recorded: the resumed session's running total after its first turn.
    const RECORDED_TOTAL = 0.0943048;
    const costs = (events: AgentEvent[]) => events.flatMap((e) => (e.type === 'usage' && e.record.reportedCost ? [e.record] : []));

    it('reports the first turn\'s growth over what was counted of the session before', async () => {
      const { processDeps } = deps([fixture('claude-code', 'stream-resumed')]);
      const adapter = new ClaudeCodeAdapter(processDeps);
      const counted = { sessionId: 'sess-claude-stream-1', usd: 0.09, modelUsd: { 'claude-sonnet-5': 0.09 } };
      await adapter.start(taskIn('plan', { resumeSessionId: 'sess-claude-stream-1', resumeCost: counted }));
      const events: AgentEvent[] = [];
      await adapter.send('go on', (e) => events.push(e));

      expect(costs(events)).toHaveLength(1);
      expect(costs(events)[0]).toMatchObject({ model: 'claude-sonnet-5', reportedCost: { currency: 'USD' } });
      expect(costs(events)[0].reportedCost?.amount).toBeCloseTo(RECORDED_TOTAL - 0.09, 10);
      expect(adapter.sessionCost()).toEqual({ sessionId: 'sess-claude-stream-1', usd: expect.closeTo(RECORDED_TOTAL, 10), modelUsd: { 'claude-sonnet-5': expect.closeTo(RECORDED_TOTAL, 10) } });
      adapter.dispose();
    });

    it('reports nothing for a first turn whose session it knows no count of, then counts from its total', async () => {
      const { processDeps } = deps([fixture('claude-code', 'stream-resumed')]);
      const adapter = new ClaudeCodeAdapter(processDeps);
      await adapter.start(taskIn('plan', { resumeSessionId: 'sess-claude-stream-1' }));
      expect(adapter.sessionCost()).toBeNull();
      const events: AgentEvent[] = [];
      await adapter.send('go on', (e) => events.push(e));

      expect(costs(events)).toEqual([]);
      expect(adapter.sessionCost()).toEqual({ sessionId: 'sess-claude-stream-1', usd: expect.closeTo(RECORDED_TOTAL, 10), modelUsd: { 'claude-sonnet-5': expect.closeTo(RECORDED_TOTAL, 10) } });
      adapter.dispose();
    });

    it('does not take a count kept for another session as this one\'s', async () => {
      const { processDeps } = deps([fixture('claude-code', 'stream-resumed')]);
      const adapter = new ClaudeCodeAdapter(processDeps);
      await adapter.start(taskIn('plan', { resumeSessionId: 'sess-claude-stream-1', resumeCost: { sessionId: 'another', usd: 0.01, modelUsd: {} } }));
      const events: AgentEvent[] = [];
      await adapter.send('go on', (e) => events.push(e));

      expect(costs(events)).toEqual([]);
      adapter.dispose();
    });

    // Claude Code's cost-tracking docs: a crashed process's last result
    // (`error_during_execution`) can carry zeroed totals. The session's saved
    // totals come back whole on the next resume, so a count lowered to 0 here
    // would count that spend a second time.
    const SESSION = 'sess-crash';
    const turnLines = (...lines: object[]) => `${[{ type: 'system', subtype: 'init', session_id: SESSION }, ...lines].map((l) => JSON.stringify(l)).join('\n')}\n`;
    const result = (fields: object) => ({ type: 'result', session_id: SESSION, ...fields });
    const opus = (costUSD: number) => ({ 'claude-opus-5': { costUSD, contextWindow: 200000 } });

    it('does not lower the count on a crashed result whose totals are zeroed', async () => {
      const pricedOpus = (costUSD: number) => ({ 'claude-opus-5': { costUSD, costBasis: 'list', contextWindow: 200000 } });
      const { processDeps } = deps([
        turnLines(result({ subtype: 'success', total_cost_usd: 2, modelUsage: pricedOpus(2) })),
        turnLines(result({ subtype: 'error_during_execution', is_error: true, total_cost_usd: 0, modelUsage: pricedOpus(0) })),
        turnLines(result({ subtype: 'success', total_cost_usd: 2.5, modelUsage: pricedOpus(2.5) })),
      ], { claudeAccount: { subscriptionType: 'max', apiKeySource: 'none' } });
      const adapter = new ClaudeCodeAdapter(processDeps);
      await adapter.start(taskIn('plan', { resumeSessionId: SESSION, resumeCost: { sessionId: SESSION, usd: 1, modelUsd: { 'claude-opus-5': 1 } } }));
      const events: AgentEvent[] = [];
      await adapter.send('one', (e) => events.push(e));
      await adapter.send('crash', (e) => events.push(e));
      expect(adapter.sessionCost()).toEqual({ sessionId: SESSION, usd: 2, modelUsd: { 'claude-opus-5': 2 } });
      await adapter.send('three', (e) => events.push(e));

      // 1 → 2 → (crash) → 2.5: every dollar once.
      expect(costs(events).map((r) => r.reportedCost?.amount)).toEqual([1, 0.5]);
      const ledger = events.reduce((usage, event) => event.type === 'usage' ? addAttemptUsage(usage, event.record, '2026-10-19T18:00:01Z') : usage,
        startAttemptUsage(1, 'claude-code', '2026-10-19T18:00:00Z'));
      expect(ledger.sessionBilling).toEqual({ type: 'subscription', plan: 'max' });
      expect(ledger.totals.costProvenance).toEqual({ USD: { kind: 'estimate', basis: 'list', billing: 'subscription' } });
      expect(usageText(ledger)).toBe('≈$1.50 API-equivalent');
      adapter.dispose();
    });

    it('does not take a crashed result with no totals at all as a lowered count', async () => {
      const { processDeps } = deps([
        turnLines(result({ subtype: 'error_during_execution', is_error: true })),
        turnLines(result({ subtype: 'success', total_cost_usd: 3, modelUsage: opus(3) })),
      ]);
      const adapter = new ClaudeCodeAdapter(processDeps);
      await adapter.start(taskIn('plan', { resumeSessionId: SESSION, resumeCost: { sessionId: SESSION, usd: 2, modelUsd: { 'claude-opus-5': 2 } } }));
      const events: AgentEvent[] = [];
      await adapter.send('crash', (e) => events.push(e));
      await adapter.send('again', (e) => events.push(e));

      expect(costs(events).map((r) => r.reportedCost?.amount)).toEqual([1]);
      adapter.dispose();
    });

    it('keeps a resume with no kept count at its baseline through a zeroed crash result', async () => {
      const { processDeps } = deps([
        turnLines(result({ subtype: 'error_during_execution', is_error: true, total_cost_usd: 0, modelUsage: opus(0) })),
        turnLines(result({ subtype: 'success', total_cost_usd: 5, modelUsage: opus(5) })),
      ]);
      const adapter = new ClaudeCodeAdapter(processDeps);
      await adapter.start(taskIn('plan', { resumeSessionId: SESSION }));
      const events: AgentEvent[] = [];
      await adapter.send('crash', (e) => events.push(e));
      await adapter.send('again', (e) => events.push(e));

      // 5 includes the restored spend, which this turn did not make.
      expect(costs(events)).toEqual([]);
      adapter.dispose();
    });

    // Recorded on 2.1.303: `/clear` emits a top-level `conversation_reset`
    // (not a `system` line) and its own result, then the session runs on under
    // a new session id with its totals restarted from zero.
    it('counts the turn after a /clear from zero, under the new session', async () => {
      const NEW_SESSION = 'sess-cleared';
      const reset = { type: 'conversation_reset', new_conversation_id: 'conv-2', uuid: 'conv-2', trigger: 'clear', user_message_uuid: 'u-1', timestamp: '2026-10-19T17:14:21.590Z', session_id: SESSION };
      const { processDeps } = deps([
        turnLines(result({ subtype: 'success', total_cost_usd: 4, modelUsage: opus(4) })),
        turnLines(reset, { type: 'result', subtype: 'success', session_id: NEW_SESSION, total_cost_usd: 0, modelUsage: {} }),
        turnLines({ type: 'result', subtype: 'success', session_id: NEW_SESSION, total_cost_usd: 0.3, modelUsage: opus(0.3) }),
      ]);
      const adapter = new ClaudeCodeAdapter(processDeps);
      await adapter.start(taskIn('plan', { resumeSessionId: SESSION, resumeCost: { sessionId: SESSION, usd: 3, modelUsd: { 'claude-opus-5': 3 } } }));
      const events: AgentEvent[] = [];
      await adapter.send('work', (e) => events.push(e));
      await adapter.send('/clear', (e) => events.push(e));
      await adapter.send('fresh start', (e) => events.push(e));

      expect(costs(events).map((r) => r.reportedCost?.amount)).toEqual([1, 0.3]);
      expect(adapter.sessionCost()).toEqual({ sessionId: NEW_SESSION, usd: 0.3, modelUsd: { 'claude-opus-5': 0.3 } });
      adapter.dispose();
    });

    it('clears the context meter on a /clear, before the next call', async () => {
      const reset = { type: 'conversation_reset', new_conversation_id: 'conv-2', uuid: 'conv-2', trigger: 'clear', session_id: SESSION };
      const start = { type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start', message: { model: 'claude-opus-5', id: 'msg-1' } } };
      const delta = { type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_delta', usage: { input_tokens: 1000, output_tokens: 10 } } };
      const { processDeps } = deps([
        turnLines(start, delta, result({ subtype: 'success', total_cost_usd: 1, modelUsage: opus(1) })),
        turnLines(reset, { type: 'result', subtype: 'success', session_id: 'sess-cleared', total_cost_usd: 0, modelUsage: {} }),
      ]);
      const adapter = new ClaudeCodeAdapter(processDeps);
      await adapter.start(taskIn('plan'));
      const events: AgentEvent[] = [];
      await adapter.send('work', (e) => events.push(e));
      const before = events.reduce((usage, event) => event.type === 'usage' ? addAttemptUsage(usage, event.record, '2026-10-19T18:00:01Z') : usage,
        startAttemptUsage(1, 'claude-code', '2026-10-19T18:00:00Z'));
      expect(plannerContextFill(before)).toEqual({ usedTokens: 1010, windowTokens: 200_000 });

      await adapter.send('/clear', (e) => events.push(e));
      const after = events.reduce((usage, event) => event.type === 'usage' ? addAttemptUsage(usage, event.record, '2026-10-19T18:00:01Z') : usage,
        startAttemptUsage(1, 'claude-code', '2026-10-19T18:00:00Z'));
      expect(plannerContextFill(after)).toBeUndefined();
      adapter.dispose();
    });

    it('counts a first turn after a /clear in full when the session was resumed with no count kept', async () => {
      const reset = { type: 'conversation_reset', new_conversation_id: 'conv-2', uuid: 'conv-2', trigger: 'clear', session_id: SESSION };
      const { processDeps } = deps([
        turnLines(reset, { type: 'result', subtype: 'success', session_id: 'sess-cleared', total_cost_usd: 0, modelUsage: {} }),
        turnLines({ type: 'result', subtype: 'success', session_id: 'sess-cleared', total_cost_usd: 0.3, modelUsage: opus(0.3) }),
      ]);
      const adapter = new ClaudeCodeAdapter(processDeps);
      await adapter.start(taskIn('plan', { resumeSessionId: SESSION }));
      const events: AgentEvent[] = [];
      await adapter.send('/clear', (e) => events.push(e));
      await adapter.send('fresh start', (e) => events.push(e));

      expect(costs(events).map((r) => r.reportedCost?.amount)).toEqual([0.3]);
      adapter.dispose();
    });
  });

  // A recording without `--include-partial-messages` carries a call's usage only
  // on its `assistant` line and the turn's sum on its `result`. The result is
  // the only complete measure there is, so it is read when no call streamed.
  describe('a turn that reported no per-call usage', () => {
    const calls = (events: AgentEvent[]) => events.flatMap((e) => (e.type === 'usage' && !e.record.reportedCost && !e.record.compacted && e.record.inputTokens !== undefined ? [e.record] : []));

    it('counts each turn\'s tokens from its result, once', async () => {
      const { processDeps } = deps([fixture('claude-code', 'task-background')]);
      const adapter = new ClaudeCodeAdapter(processDeps);
      await adapter.start(taskStart());
      const events: AgentEvent[] = [];
      await adapter.send('do it', (e) => events.push(e));

      expect(calls(events)).toEqual([
        { source: 'claude-code', model: 'claude-haiku-4-5-20251001', aggregate: true, inputTokens: 109076, cachedInputTokens: 98305, outputTokens: 1749 },
        { source: 'claude-code', model: 'claude-haiku-4-5-20251001', aggregate: true, inputTokens: 47395, cachedInputTokens: 46665, outputTokens: 232 },
      ]);
      adapter.dispose();
    });

    it('does not count a turn\'s result again when its calls streamed', async () => {
      const { processDeps } = deps([fixture('claude-code', 'task-checkpoint')]);
      const adapter = new ClaudeCodeAdapter(processDeps);
      await adapter.start(taskStart());
      const events: AgentEvent[] = [];
      await adapter.send('do it', (e) => events.push(e));

      expect(calls(events)).toEqual([
        { source: 'claude-code', model: 'claude-haiku-4-5-20251001', inputTokens: 21160, cachedInputTokens: 17371, outputTokens: 201, contextTokens: 21361 },
      ]);
      adapter.dispose();
    });
  });

  it('leaves a tool request open for someone to answer, and passes the whole request on', async () => {
    const { spawned, processDeps } = deps([fixture('claude-code', 'permission-task')]);
    const adapter = new ClaudeCodeAdapter(processDeps);
    await adapter.start(taskStart({ mode: 'default', flags: { permissionMode: 'default', modeSettings: {} } }));
    const events: AgentEvent[] = [];
    void adapter.send('Write a.txt', (e) => events.push(e));
    await until(() => events.some((e) => e.type === 'permission_request'));

    expect(events.find((e) => e.type === 'permission_request')).toEqual({
      type: 'permission_request',
      id: '9a948184-6792-4049-85b1-3e837387f618',
      name: 'Write',
      detail: JSON.stringify({ file_path: '/repo/a.txt', content: 'a' }),
      input: { file_path: '/repo/a.txt', content: 'a' },
      suggestions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
      toolUseId: 'toolu_01TxT55eyjF5qKKGmJHwiDbe',
    });
    await tick();
    expect(sent(spawned)).toHaveLength(1);
    expect(events.some((e) => e.type === 'turn_end')).toBe(false);
    adapter.dispose();
  });

  it('answers Allow with the call\'s own input, then Allow for this task with Claude\'s own suggestions', async () => {
    const { spawned, processDeps } = deps([
      fixture('claude-code', 'permission-task'),
      fixture('claude-code', 'permission-task-allowed'),
      fixture('claude-code', 'permission-task-allowed-for-task'),
    ]);
    const adapter = new ClaudeCodeAdapter(processDeps);
    await adapter.start(taskStart({ mode: 'default', flags: { permissionMode: 'default', modeSettings: {} } }));
    const events: AgentEvent[] = [];
    const turn = adapter.send('Write a.txt and b.txt', (e) => events.push(e));
    const requests = () => events.filter((e) => e.type === 'permission_request');

    await until(() => requests().length === 1);
    expect(adapter.answerPermission('9a948184-6792-4049-85b1-3e837387f618', { decision: 'allow' })).toBe(true);
    expect(JSON.parse(sent(spawned)[1])).toEqual({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: '9a948184-6792-4049-85b1-3e837387f618',
        response: { behavior: 'allow', updatedInput: { file_path: '/repo/a.txt', content: 'a' } },
      },
    });

    await until(() => requests().length === 2);
    expect(adapter.answerPermission('5ab6f7de-9bb1-4e03-9e80-8c3aa64c0506', { decision: 'allowForTask' })).toBe(true);
    expect(JSON.parse(sent(spawned)[2])).toEqual({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: '5ab6f7de-9bb1-4e03-9e80-8c3aa64c0506',
        response: {
          behavior: 'allow',
          updatedInput: { file_path: '/repo/b.txt', content: 'b' },
          updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
        },
      },
    });

    await turn;
    // The recorded run: both writes went through, and the third call ran
    // unasked under the session-scoped grant.
    expect(events.filter((e) => e.type === 'tool_result').map((e) => e.type === 'tool_result' && e.success)).toEqual([true, true, true]);
    expect(requests()).toHaveLength(2);
    expect(events.at(-1)).toEqual({ type: 'turn_end' });
    adapter.dispose();
  });

  it('reports a file edit\'s result as its diff, a created file as its added lines', async () => {
    const toolResult = (id: string, content: string, toolUseResult: Record<string, unknown>, isError = false) => JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ tool_use_id: id, type: 'tool_result', content, ...(isError ? { is_error: true } : {}) }] },
      parent_tool_use_id: null, session_id: 'sess-edit', tool_use_result: toolUseResult,
    });
    const stream = [
      toolResult('toolu_e', 'The file /repo/sum.ts has been updated successfully.', {
        filePath: '/repo/sum.ts', oldString: 'a - b', newString: 'a + b',
        structuredPatch: [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, lines: [' export function sum(a, b) {', '-  return a - b;', '+  return a + b;', ' }'] }],
      }),
      toolResult('toolu_w', 'File created successfully at: /repo/a.txt', { type: 'create', filePath: '/repo/a.txt', content: 'a\nb\n', structuredPatch: [], originalFile: null }),
      toolResult('toolu_x', 'String to replace not found in file.', { filePath: '/repo/x.ts', structuredPatch: [] }, true),
      JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: 'sess-edit', stop_reason: 'end_turn' }),
    ].join('\n') + '\n';
    const { processDeps } = deps([stream]);
    const adapter = new ClaudeCodeAdapter(processDeps);
    await adapter.start(taskStart());
    const events: AgentEvent[] = [];
    await adapter.send('fix sum', (e) => events.push(e));

    expect(events.filter((e) => e.type === 'tool_result').map((e) => e.type === 'tool_result' && [e.id, e.output, e.success])).toEqual([
      ['toolu_e', '@@ -1,3 +1,3 @@\n export function sum(a, b) {\n-  return a - b;\n+  return a + b;\n }\n', true],
      ['toolu_w', '+a\n+b\n', true],
      ['toolu_x', 'String to replace not found in file.', false],
    ]);
    adapter.dispose();
  });

  it('answers Deny with the note as the message the agent reads', async () => {
    const { spawned, processDeps } = deps([fixture('claude-code', 'permission-task-deny'), fixture('claude-code', 'permission-task-denied')]);
    const adapter = new ClaudeCodeAdapter(processDeps);
    await adapter.start(taskStart({ mode: 'default', flags: { permissionMode: 'default', modeSettings: {} } }));
    const events: AgentEvent[] = [];
    void adapter.send('Write d.txt', (e) => events.push(e));
    await until(() => events.some((e) => e.type === 'permission_request'));

    expect(adapter.answerPermission('160adb6f-1e51-4d65-a12f-911f10dd46ae', { decision: 'deny', note: 'Not this one — write it to notes/c.txt instead.' })).toBe(true);
    expect(JSON.parse(sent(spawned)[1])).toEqual({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: '160adb6f-1e51-4d65-a12f-911f10dd46ae',
        response: { behavior: 'deny', message: 'Not this one — write it to notes/c.txt instead.' },
      },
    });
    await until(() => events.filter((e) => e.type === 'permission_request').length === 2);
    expect(events.find((e) => e.type === 'tool_result')).toMatchObject({ success: false, output: 'Not this one — write it to notes/c.txt instead.' });
    adapter.dispose();
  });

  it('denies without a note in words of its own, since the CLI requires a message', async () => {
    const { spawned, processDeps } = deps([fixture('claude-code', 'permission-task-deny')]);
    const adapter = new ClaudeCodeAdapter(processDeps);
    await adapter.start(taskIn('default'));
    const events: AgentEvent[] = [];
    void adapter.send('Write d.txt', (e) => events.push(e));
    await until(() => events.some((e) => e.type === 'permission_request'));
    adapter.answerPermission('160adb6f-1e51-4d65-a12f-911f10dd46ae', { decision: 'deny', note: '   ' });
    const answer = JSON.parse(sent(spawned)[1]) as { response: { response: { behavior: string; message: string } } };
    expect(answer.response.response.behavior).toBe('deny');
    expect(answer.response.response.message).toMatch(/\S/);
    adapter.dispose();
  });

  it('answers Allow for this task as a plain allow when Claude suggested nothing', async () => {
    const noSuggestions = fixture('claude-code', 'permission-task').replace(/,"permission_suggestions":\[[^\]]*\]/, '');
    const { spawned, processDeps } = deps([noSuggestions]);
    const adapter = new ClaudeCodeAdapter(processDeps);
    await adapter.start(taskIn('default'));
    const events: AgentEvent[] = [];
    void adapter.send('Write a.txt', (e) => events.push(e));
    await until(() => events.some((e) => e.type === 'permission_request'));
    expect(events.find((e) => e.type === 'permission_request')).toMatchObject({ suggestions: [] });
    adapter.answerPermission('9a948184-6792-4049-85b1-3e837387f618', { decision: 'allowForTask' });
    const answer = JSON.parse(sent(spawned)[1]) as { response: { response: Record<string, unknown> } };
    expect(answer.response.response).toEqual({ behavior: 'allow', updatedInput: { file_path: '/repo/a.txt', content: 'a' } });
    adapter.dispose();
  });

  it('answers each request once, and nothing it never asked', async () => {
    const { spawned, processDeps } = deps([fixture('claude-code', 'permission-task')]);
    const adapter = new ClaudeCodeAdapter(processDeps);
    await adapter.start(taskIn('default'));
    const events: AgentEvent[] = [];
    void adapter.send('Write a.txt', (e) => events.push(e));
    await until(() => events.some((e) => e.type === 'permission_request'));
    expect(adapter.answerPermission('not-asked', { decision: 'allow' })).toBe(false);
    expect(adapter.answerPermission('9a948184-6792-4049-85b1-3e837387f618', { decision: 'allow' })).toBe(true);
    expect(adapter.answerPermission('9a948184-6792-4049-85b1-3e837387f618', { decision: 'deny' })).toBe(false);
    expect(sent(spawned)).toHaveLength(2);
    adapter.dispose();
  });

  it('reports a request Claude withdraws when the turn is interrupted, and takes no answer for it', async () => {
    const { spawned, processDeps } = deps([
      fixture('claude-code', 'permission-task-deny'),
      fixture('claude-code', 'permission-task-denied'),
      (written, proc) => {
        const request = JSON.parse(written) as { request_id: string };
        proc.emitStdout(fixture('claude-code', 'permission-task-cancelled', { REQUEST_ID: request.request_id }));
      },
    ]);
    const adapter = new ClaudeCodeAdapter(processDeps);
    await adapter.start(taskIn('default'));
    const events: AgentEvent[] = [];
    const turn = adapter.send('Write d.txt', (e) => events.push(e));
    await until(() => events.some((e) => e.type === 'permission_request'));
    adapter.answerPermission('160adb6f-1e51-4d65-a12f-911f10dd46ae', { decision: 'deny' });
    await until(() => events.filter((e) => e.type === 'permission_request').length === 2);

    await expect(adapter.interrupt(1000)).resolves.toBe(true);
    await turn;
    expect(events).toContainEqual({ type: 'permission_cancelled', id: '04436c5a-8682-477d-a23f-34bbb9f814f3' });
    expect(adapter.answerPermission('04436c5a-8682-477d-a23f-34bbb9f814f3', { decision: 'allow' })).toBe(false);
    expect(events.at(-1)).toEqual({ type: 'turn_end', interrupted: true });
    expect(sent(spawned)).toHaveLength(3);
    adapter.dispose();
  });

  it('leaves a planner\'s request open for Ordewell, without Claude\'s own grants', async () => {
    const { spawned, processDeps } = deps([fixture('claude-code', 'permission-task')]);
    const adapter = new ClaudeCodeAdapter(processDeps);
    await adapter.start({ kind: 'planner', cwd: '/repo', systemPrompt: 'PLAN' });
    const events: AgentEvent[] = [];
    void adapter.send('Plan it', (e) => events.push(e));
    await until(() => events.some((e) => e.type === 'permission_request'));
    expect(sent(spawned)).toHaveLength(1);
    expect(events.find((e) => e.type === 'permission_request')).toEqual({
      type: 'permission_request',
      id: '9a948184-6792-4049-85b1-3e837387f618',
      name: 'Write',
      detail: JSON.stringify({ file_path: '/repo/a.txt', content: 'a' }),
      input: { file_path: '/repo/a.txt', content: 'a' },
      toolUseId: expect.any(String),
      ask: { kind: 'other' },
    });
    expect(adapter.answerPermission('9a948184-6792-4049-85b1-3e837387f618', { decision: 'deny', note: 'no' })).toBe(true);
    const answer = JSON.parse(sent(spawned)[1]) as { response: { response: { behavior: string; message: string } } };
    expect(answer.response.response).toEqual({ behavior: 'deny', message: 'no' });
    adapter.dispose();
  });

  it('cancels a request still open when the turn ends, as every runner does', async () => {
    const result = { type: 'result', subtype: 'success', is_error: false, session_id: 'sess-1', result: 'Stopped.' };
    const { spawned, processDeps } = deps([fixture('claude-code', 'permission-task') + `${JSON.stringify(result)}\n`]);
    const adapter = new ClaudeCodeAdapter(processDeps);
    await adapter.start(taskIn('default'));
    const events: AgentEvent[] = [];
    await adapter.send('Write a.txt', (e) => events.push(e));

    expect(events.slice(-2)).toEqual([{ type: 'permission_cancelled', id: '9a948184-6792-4049-85b1-3e837387f618' }, { type: 'turn_end' }]);
    expect(adapter.answerPermission('9a948184-6792-4049-85b1-3e837387f618', { decision: 'allow' })).toBe(false);
    expect(sent(spawned)).toHaveLength(1);
    adapter.dispose();
  });

  it('keeps a planner\'s request open past a turn end while background work that may have raised it still runs', async () => {
    const background = { type: 'system', subtype: 'background_tasks_changed', session_id: 'sess-1', tasks: [{ id: 'bg-1' }] };
    const result = { type: 'result', subtype: 'success', is_error: false, session_id: 'sess-1', result: 'Researching in the background.' };
    const { processDeps } = deps([`${JSON.stringify(background)}\n` + fixture('claude-code', 'permission-task') + `${JSON.stringify(result)}\n`]);
    const adapter = new ClaudeCodeAdapter(processDeps);
    await adapter.start({ kind: 'planner', cwd: '/repo', systemPrompt: 'PLAN' });
    const events: AgentEvent[] = [];
    await adapter.send('Plan it', (e) => events.push(e));

    expect(events.at(-1)).toEqual({ type: 'turn_end' });
    expect(events.some((e) => e.type === 'permission_cancelled')).toBe(false);
    expect(adapter.answerPermission('9a948184-6792-4049-85b1-3e837387f618', { decision: 'deny' })).toBe(true);
    adapter.dispose();
  });

  it('interrupts with the control request the CLI acknowledges, and the turn ends interrupted', async () => {
    const { spawned, processDeps } = deps([
      fixture('claude-code', 'task-interrupt'),
      (written, proc) => {
        const request = JSON.parse(written) as { request_id: string };
        proc.emitStdout(fixture('claude-code', 'task-interrupt-ack', { REQUEST_ID: request.request_id }));
      },
    ]);
    const adapter = new ClaudeCodeAdapter(processDeps);
    await adapter.start(taskStart());
    const events: AgentEvent[] = [];
    const turn = adapter.send('sleep a while', (e) => events.push(e));
    await tick();

    await expect(adapter.interrupt(1000)).resolves.toBe(true);
    await turn;
    expect(JSON.parse(sent(spawned)[1])).toEqual({
      type: 'control_request',
      request_id: 'ordewell-interrupt-2',
      request: { subtype: 'interrupt' },
    });
    expect(events.some((e) => e.type === 'error')).toBe(false);
    expect(events.at(-1)).toEqual({ type: 'turn_end', interrupted: true });
    adapter.dispose();
  });

  it('reports an unanswered interrupt so the caller can fall back', async () => {
    const { processDeps } = deps([fixture('claude-code', 'task-interrupt')]);
    const adapter = new ClaudeCodeAdapter(processDeps);
    await adapter.start(taskStart());
    void adapter.send('sleep a while', () => {});
    await tick();
    await expect(adapter.interrupt(20)).resolves.toBe(false);
    adapter.dispose();
  });

  it('reports a process that ends, once', async () => {
    const { spawned, processDeps } = deps([]);
    const adapter = new ClaudeCodeAdapter(processDeps);
    await adapter.start(taskStart());
    const codes: number[] = [];
    adapter.onProcessExit((code) => codes.push(code));
    spawned.processes[0].exit(3);
    spawned.processes[0].exit(3);
    await tick();
    expect(codes).toEqual([3]);
  });
});

describe('ClaudeCodeAdapter with the Ordewell MCP server (ADR-0022)', () => {
  const mcp = mcpClientConfig({ url: 'http://127.0.0.1:4555/mcp', token: 'tok-secret' });

  function configPath(args: string[]): string {
    expect(args.filter((arg) => arg === '--mcp-config')).toHaveLength(1);
    return args[args.indexOf('--mcp-config') + 1];
  }

  it('hands the server to the CLI in an owner-only file, its tools loaded up front and pre-approved', async () => {
    const { spawned, processDeps } = deps([]);
    const adapter = new ClaudeCodeAdapter(processDeps);
    await adapter.start(taskStart({ mcp }));
    const args = spawned.lastArgs();

    const path = configPath(args);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      mcpServers: { ordewell: { type: 'http', url: 'http://127.0.0.1:4555/mcp', headers: { Authorization: 'Bearer tok-secret' }, alwaysLoad: true } },
    });
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(args.some((arg) => arg.includes('tok-secret'))).toBe(false);
    expect(args.flatMap((arg, i) => (arg === '--allowedTools' ? [args[i + 1]] : []))).toEqual(['mcp__ordewell__task_complete,mcp__ordewell__checkpoint,mcp__ordewell__read,mcp__ordewell__apply_patch']);
    adapter.dispose();
  });

  it.each(modeIds(CLAUDE_CODE_MANIFEST))('pre-approves the Ordewell tools and auto-allows their requests under %s', async (mode) => {
    const request = {
      type: 'control_request',
      request_id: 'req-m',
      request: { subtype: 'can_use_tool', tool_name: 'mcp__ordewell__checkpoint', input: { question: 'ok?' }, tool_use_id: 'tu-m' },
    };
    const { spawned, processDeps } = deps([`${JSON.stringify(request)}\n`]);
    const adapter = new ClaudeCodeAdapter(processDeps);
    await adapter.start(taskIn(mode, { mcp }));
    const events: AgentEvent[] = [];
    void adapter.send('Do it', (e) => events.push(e));
    await until(() => sent(spawned).length === 2);
    const args = spawned.lastArgs();

    expect(args.flatMap((arg, i) => (arg === '--allowedTools' ? [args[i + 1]] : []))).toEqual(['mcp__ordewell__task_complete,mcp__ordewell__checkpoint,mcp__ordewell__read,mcp__ordewell__apply_patch']);
    expect(args.some((arg) => arg.includes('tok-secret'))).toBe(false);
    expect(JSON.parse(sent(spawned)[1]).response.response.behavior).toBe('allow');
    expect(events.find((e) => e.type === 'permission_request')).toMatchObject({ decided: { decision: 'allow' } });
    adapter.dispose();
  });

  it('removes the file once the process is gone', async () => {
    const { spawned, processDeps } = deps([]);
    const adapter = new ClaudeCodeAdapter(processDeps);
    await adapter.start(taskStart({ mcp }));
    const path = configPath(spawned.lastArgs());

    spawned.processes[0].exit(0);

    await until(() => !existsSync(path));
    adapter.dispose();
  });

  it('removes the file when disposed', async () => {
    const { spawned, processDeps } = deps([]);
    const adapter = new ClaudeCodeAdapter(processDeps);
    await adapter.start(taskStart({ mcp }));
    const path = configPath(spawned.lastArgs());

    adapter.dispose();

    expect(existsSync(path)).toBe(false);
  });

  it('allows a request for an Ordewell tool itself, so it never waits on a person', async () => {
    const request = {
      type: 'control_request',
      request_id: 'req-1',
      request: { subtype: 'can_use_tool', tool_name: 'mcp__ordewell__task_complete', input: { status: 'done', summary: 'ok' }, tool_use_id: 'tu-1' },
    };
    const { spawned, processDeps } = deps([`${JSON.stringify(request)}\n`]);
    const adapter = new ClaudeCodeAdapter(processDeps);
    await adapter.start(taskStart({ mcp, flags: { permissionMode: 'default', modeSettings: {} }, mode: 'default' }));
    const events: AgentEvent[] = [];
    void adapter.send('Do it', (e) => events.push(e));
    await until(() => sent(spawned).length === 2);

    expect(JSON.parse(sent(spawned)[1])).toEqual({
      type: 'control_response',
      response: { subtype: 'success', request_id: 'req-1', response: { behavior: 'allow', updatedInput: { status: 'done', summary: 'ok' } } },
    });
    expect(events.find((e) => e.type === 'permission_request')).toEqual({
      type: 'permission_request',
      id: 'req-1',
      name: 'mcp__ordewell__task_complete',
      detail: JSON.stringify({ status: 'done', summary: 'ok' }),
      input: { status: 'done', summary: 'ok' },
      toolUseId: 'tu-1',
      decided: { decision: 'allow' },
    });
    expect(adapter.answerPermission('req-1', { decision: 'deny' })).toBe(false);
    adapter.dispose();
  });

  // `mcp__ordewell__x__task_complete` is the tool `task_complete` of a server named `ordewell__x`.
  it.each(['mcp__ordewellx__task_complete', 'mcp__ordewell__x__task_complete', 'mcp__ordewell__evil'])('still asks about another server\'s tool: %s', async (name) => {
    const request = {
      type: 'control_request',
      request_id: 'req-2',
      request: { subtype: 'can_use_tool', tool_name: name, input: {} },
    };
    const { spawned, processDeps } = deps([`${JSON.stringify(request)}\n`]);
    const adapter = new ClaudeCodeAdapter(processDeps);
    await adapter.start(taskStart({ mcp, flags: { permissionMode: 'default', modeSettings: {} }, mode: 'default' }));
    const events: AgentEvent[] = [];
    void adapter.send('Do it', (e) => events.push(e));
    await until(() => events.some((e) => e.type === 'permission_request'));

    expect(events.find((e) => e.type === 'permission_request')).not.toHaveProperty('decided');
    expect(sent(spawned)).toHaveLength(1);
    adapter.dispose();
  });
});

/**
 * Mid-turn delivery (ADR-0023), against transcripts recorded from `claude`
 * 2.1.291 under `--replay-user-messages`, on haiku: a steer written during a
 * `sleep`, and one written while the model was writing a text-only reply.
 */
describe('ClaudeCodeAdapter steer', () => {
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  const midTurn = claudeSteerRecording('mid-turn');
  const afterResult = claudeSteerRecording('after-result');

  function steerLine(written: string): { type: string; uuid: string; message: { role: string; content: Array<{ type: string; text: string }> } } {
    return JSON.parse(written) as ReturnType<typeof steerLine>;
  }

  it('writes the message as a user line under a uuid of its own, and reports it delivered when the CLI echoes that uuid', async () => {
    const { spawned, processDeps } = deps([midTurn.before, midTurn.answer]);
    const adapter = new ClaudeCodeAdapter(processDeps);
    await adapter.start(taskIn('bypassPermissions'));
    const events: AgentEvent[] = [];
    const turn = adapter.send('Run the sleep', (e) => events.push(e));
    await until(() => events.some((e) => e.type === 'tool_call'));

    expect(await adapter.steer('msg-1', 'Also include the word PINEAPPLE in your final reply.')).toBe(true);
    const line = steerLine(sent(spawned)[1]);
    expect(line).toEqual({ type: 'user', uuid: expect.stringMatching(UUID), message: { role: 'user', content: [{ type: 'text', text: 'Also include the word PINEAPPLE in your final reply.' }] } });
    await turn;

    const at = (match: (e: AgentEvent) => boolean) => events.findIndex(match);
    const delivered = at((e) => e.type === 'message_delivered');
    // The first prompt is echoed too, and is no delivery.
    expect(events.filter((e) => e.type === 'message_delivered')).toEqual([{ type: 'message_delivered', id: 'msg-1' }]);
    expect(delivered).toBeGreaterThan(at((e) => e.type === 'tool_result'));
    expect(delivered).toBeLessThan(at((e) => e.type === 'assistant_text' && e.text.includes('PINEAPPLE')));
    expect(events.filter((e) => e.type === 'turn_end')).toEqual([{ type: 'turn_end' }]);
    expect(events.at(-1)).toEqual({ type: 'turn_end' });
    adapter.dispose();
  });

  it('a message the model did not read before the result opens the CLI\'s own turn, reported out of turn and written once', async () => {
    const { spawned, processDeps } = deps([afterResult.before, afterResult.answer]);
    const adapter = new ClaudeCodeAdapter(processDeps);
    await adapter.start(taskIn('bypassPermissions'));
    const outOfTurn: AgentEvent[] = [];
    adapter.onOutOfTurn((e) => outOfTurn.push(e));
    const events: AgentEvent[] = [];
    const turn = adapter.send('Say something about the sea', (e) => events.push(e));
    await until(() => events.some((e) => e.type === 'assistant_text_delta'));

    expect(await adapter.steer('msg-1', 'Now reply with only the word PINEAPPLE.')).toBe(true);
    await turn;
    expect(events.some((e) => e.type === 'message_delivered')).toBe(false);
    expect(events.at(-1)).toEqual({ type: 'turn_end' });

    await until(() => outOfTurn.some((e) => e.type === 'turn_end'));
    expect(outOfTurn[0]).toEqual({ type: 'message_delivered', id: 'msg-1' });
    expect(outOfTurn.filter((e) => e.type === 'assistant_text')).toEqual([{ type: 'assistant_text', runId: 'msg_011CfmAWQwKMox4L4MVgU2r7:1', text: 'PINEAPPLE' }]);
    expect(outOfTurn.filter((e) => e.type === 'message_delivered' || e.type === 'message_dropped')).toHaveLength(1);
    expect(sent(spawned).filter((w) => w.includes('PINEAPPLE'))).toHaveLength(1);
    adapter.dispose();
  });

  it('reports each message delivered once, by its own echo, whatever else the CLI echoes', async () => {
    const { spawned, processDeps } = deps([]);
    const adapter = new ClaudeCodeAdapter(processDeps);
    await adapter.start(taskStart());
    const events: AgentEvent[] = [];
    void adapter.send('Do it', (e) => events.push(e));
    await adapter.steer('msg-1', 'one');
    await adapter.steer('msg-2', 'two');
    const [, first, second] = sent(spawned).map(steerLine);
    // Accepted is not delivered: only the echo says the model has it.
    expect(events.some((e) => e.type === 'message_delivered')).toBe(false);
    const echo = (uuid: string) => `${JSON.stringify({ type: 'user', isReplay: true, uuid, session_id: 's', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'text', text: 'x' }] } })}\n`;

    // A steer of another process — a stale attempt's, or a killed one's — is not this one's to report.
    spawned.processes[0].emitStdout(echo('00000000-0000-4000-8000-000000000000') + echo(first.uuid) + echo(first.uuid) + echo(second.uuid));

    expect(first.uuid).not.toBe(second.uuid);
    expect(events.filter((e) => e.type === 'message_delivered')).toEqual([
      { type: 'message_delivered', id: 'msg-1' },
      { type: 'message_delivered', id: 'msg-2' },
    ]);
    adapter.dispose();
  });

  it('keeps a message it was handed across an interrupt: never dropped, and its echo opens the CLI\'s next turn (ADR-0023, F1)', async () => {
    const { spawned, processDeps } = deps([
      fixture('claude-code', 'task-interrupt'),
      () => {},
      (written, proc) => {
        const request = JSON.parse(written) as { request_id: string };
        proc.emitStdout(fixture('claude-code', 'task-interrupt-ack', { REQUEST_ID: request.request_id }));
      },
    ]);
    const adapter = new ClaudeCodeAdapter(processDeps);
    await adapter.start(taskStart());
    const outOfTurn: AgentEvent[] = [];
    adapter.onOutOfTurn((e) => outOfTurn.push(e));
    const events: AgentEvent[] = [];
    const turn = adapter.send('sleep a while', (e) => events.push(e));
    await tick();

    expect(await adapter.steer('msg-1', 'use Postgres')).toBe(true);
    const { uuid } = steerLine(sent(spawned)[1]);
    await expect(adapter.interrupt(1000)).resolves.toBe(true);
    await turn;
    expect(events.at(-1)).toEqual({ type: 'turn_end', interrupted: true });
    expect(events.some((e) => e.type === 'message_dropped' || e.type === 'message_delivered')).toBe(false);

    spawned.processes[0].emitStdout(`${JSON.stringify({ type: 'user', isReplay: true, uuid, session_id: 'sess-task-interrupt', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'text', text: 'use Postgres' }] } })}\n`);
    expect(outOfTurn).toEqual([{ type: 'message_delivered', id: 'msg-1' }]);
    expect(sent(spawned).filter((w) => w.includes('use Postgres'))).toHaveLength(1);
    adapter.dispose();
  });

  it('is refused, leaving the message for the turn\'s end, while an interrupt is in flight and before a resume is taken up', async () => {
    const { spawned, processDeps } = deps([]);
    const adapter = new ClaudeCodeAdapter(processDeps);
    await adapter.start(taskStart({ resumeSessionId: 'sess-task-marker' }));
    void adapter.send('go on', () => {});
    expect(await adapter.steer('msg-1', 'too early')).toBe(false);

    spawned.processes[0].emitStdout(`${JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-task-marker', permissionMode: 'acceptEdits' })}\n`);
    void adapter.interrupt(50);
    expect(await adapter.steer('msg-2', 'mid-interrupt')).toBe(false);
    expect(sent(spawned).some((w) => w.includes('too early') || w.includes('mid-interrupt'))).toBe(false);
    adapter.dispose();
  });

  it('is refused by a planner, and once the process is gone', async () => {
    const planner = new ClaudeCodeAdapter(deps([]).processDeps);
    await planner.start({ kind: 'planner', cwd: '/repo', systemPrompt: 'PLAN' });
    expect(await planner.steer('msg-1', 'hi')).toBe(false);
    planner.dispose();

    const task = new ClaudeCodeAdapter(deps([]).processDeps);
    await task.start(taskStart());
    task.dispose();
    expect(await task.steer('msg-1', 'hi')).toBe(false);
  });
});

describe('ClaudeCodeAdapter: a read-only task on a model alias', () => {
  /** The control requests the adapter wrote, in order. */
  function controlRequests(written: string[]): unknown[] {
    return written.map((line) => JSON.parse(line) as { type?: string; request?: unknown })
      .filter((msg) => msg.type === 'control_request')
      .map((msg) => msg.request);
  }

  it('keeps the planned alias without a native plan-mode model pin', async () => {
    const { spawned, processDeps } = deps([]);
    const adapter = new ClaudeCodeAdapter(processDeps);
    await adapter.start(taskStart({ mode: 'plan', model: 'haiku', flags: resolveTaskRunnerFlags(CLAUDE_CODE_MANIFEST, { mode: 'plan' }) }));

    expect(controlRequests(spawned.processes[0].written)).toEqual([{ subtype: 'initialize' }]);
    adapter.dispose();
  });

  it('switches no model for a task in another mode, or for one already on a full id', async () => {
    for (const start of [taskIn('acceptEdits', { model: 'haiku' }), taskIn('plan', { model: 'claude-haiku-5-5' })]) {
      const { spawned, processDeps } = deps([]);
      const adapter = new ClaudeCodeAdapter(processDeps);
      await adapter.start(start);

      expect(controlRequests(spawned.processes[0].written).filter((r) => (r as { subtype?: string }).subtype !== 'initialize')).toEqual([]);
      adapter.dispose();
    }
  });
});

/**
 * The runner's own commands in a task (#66), against `claude` 2.1.299 in a
 * repository with a project skill (`pingskill`) and a project command
 * (`hellocmd`): `initialize` lists every command, `init` says which are skills.
 */
describe('ClaudeCodeAdapter runner commands', () => {
  it('reports the commands the CLI offers, kinded by its own skill list, without the ones only its TUI runs', async () => {
    const { processDeps } = deps([fixture('claude-code', 'task-command-skill')]);
    const adapter = new ClaudeCodeAdapter(processDeps);
    await adapter.start(taskIn('default'));
    await adapter.send('/pingskill', () => {});

    expect(adapter.commands()).toEqual([
      { name: 'tdd', description: 'Test-driven development. (user)', kind: 'skill' },
      { name: 'pingskill', description: 'Reply with the word PONG-SKILL and nothing else. (project)', kind: 'skill' },
      { name: 'hellocmd', description: 'Say hello-command (project)', argumentHint: 'name', kind: 'command' },
      { name: 'clear', description: 'Start a new session with empty context; previous session stays on disk (resumable with /resume)', argumentHint: '[name]', kind: 'builtin', aliases: ['reset', 'new'] },
      { name: 'compact', description: 'Free up context by summarizing the conversation so far', argumentHint: '<optional custom summarization instructions>', kind: 'builtin' },
      { name: 'model', description: 'Set the AI model for Claude Code', argumentHint: '<model>', kind: 'builtin' },
      { name: 'docs', description: 'docs (editable docs people share and comment on). (claude.ai sync)', kind: 'skill', aliases: ['anthropic-skills:docs'] },
    ]);
    adapter.dispose();
  });

  it('says once what the process loaded — its commands and the MCP servers of the user\'s own setup — as its first turn starts', async () => {
    const { processDeps } = deps([fixture('claude-code', 'task-command-skill'), fixture('claude-code', 'task-command-skill')]);
    const adapter = new ClaudeCodeAdapter(processDeps);
    await adapter.start(taskIn('default'));
    const events: AgentEvent[] = [];
    await adapter.send('/pingskill', (e) => events.push(e));
    await adapter.send('/pingskill', (e) => events.push(e));

    const loaded = events.filter((e) => e.type === 'runner_loaded');
    expect(loaded).toEqual([{ type: 'runner_loaded', commands: adapter.commands(), mcpServers: [{ name: 'docs-server', status: 'pending' }] }]);
    expect(events.find((e) => e.type === 'assistant_text')).toEqual({ type: 'assistant_text', runId: 'msg_011Cg1ych2PQ6DHrmD81ySTt:0', text: 'PONG-SKILL' });
    adapter.dispose();
  });

  // The CLI reads a slash command at the start of a user message, so that is
  // how one is invoked over the protocol; its echo comes back as `<command-name>`.
  it('invokes a command as a user message that starts with it, as a turn of its own', async () => {
    const { spawned, processDeps } = deps([fixture('claude-code', 'task-command-skill')]);
    const adapter = new ClaudeCodeAdapter(processDeps);
    await adapter.start(taskIn('default'));
    const events: AgentEvent[] = [];
    await adapter.invokeCommand('hellocmd', 'Bob', (e) => events.push(e));

    expect(JSON.parse(sent(spawned)[0])).toEqual({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '/hellocmd Bob' }] } });
    expect(events.at(-1)).toEqual({ type: 'turn_end' });
    adapter.dispose();
  });

  it('reports /compact as the runner\'s own compaction, with what the command printed', async () => {
    const { spawned, processDeps } = deps([fixture('claude-code', 'task-compact')]);
    const adapter = new ClaudeCodeAdapter(processDeps);
    await adapter.start(taskIn('default'));
    const events: AgentEvent[] = [];
    await adapter.invokeCommand('compact', '', (e) => events.push(e));

    expect(JSON.parse(sent(spawned)[0]).message.content[0].text).toBe('/compact');
    expect(events.filter((e) => e.type !== 'usage' && e.type !== 'runner_loaded')).toEqual([
      { type: 'compaction', trigger: 'manual', preTokens: 24939, postTokens: 3615 },
      { type: 'command_output', text: 'Compacted' },
      { type: 'turn_end' },
    ]);
    // The meter reads the size the compaction left, and no total counts it.
    expect(events.filter((e) => e.type === 'usage' && e.record.compacted)).toEqual([
      { type: 'usage', record: { source: 'claude-code', model: 'claude-haiku-5-5', compacted: true, contextTokens: 3615 } },
    ]);
    // The result after it states the window the turn ran against, even though a
    // command turn made no call whose message_start could name the model.
    const ledger = events.reduce((usage, event) => event.type === 'usage' ? addAttemptUsage(usage, event.record, '2026-10-19T18:00:01Z') : usage,
      startAttemptUsage(1, 'claude-code', '2026-10-19T18:00:00Z'));
    expect(plannerContextFill(ledger)).toEqual({ usedTokens: 3615, windowTokens: 1_000_000 });
    adapter.dispose();
  });
});

/**
 * `/model` mid-task, recorded from `claude` 2.1.302 on haiku: the command turn
 * calls no model and only prints; the next turn's `init`, then its
 * `message_start`, name the model it now runs (#106).
 */
describe('ClaudeCodeAdapter model switches', () => {
  it('records the initialized account plan and never prices a model whose cost basis is unknown', async () => {
    const recorded = fixture('claude-code', 'task-model-before').replaceAll('"costBasis":"list"', '"costBasis":"unknown"');
    const { processDeps } = deps([recorded], { claudeAccount: { subscriptionType: 'max', apiKeySource: 'none' } });
    const adapter = new ClaudeCodeAdapter(processDeps);
    await adapter.start(taskIn('default', { model: 'haiku' }));
    let ledger = startAttemptUsage(1, 'claude-code', '2026-10-17T18:00:00Z');
    await adapter.send('one', (event) => {
      if (event.type === 'usage') ledger = addAttemptUsage(ledger, event.record, '2026-10-17T18:00:01Z');
    });
    expect(ledger.sessionBilling).toEqual({ type: 'subscription', plan: 'max' });
    expect(ledger.totals.reportedCost).toBeUndefined();
    expect(ledger.byModel?.some((m) => m.totals.reportedCost)).toBe(false);
    adapter.dispose();
  });

  it('keeps the recorded subscription and list-price estimate on the attempt ledger', async () => {
    const { processDeps } = deps([fixture('claude-code', 'task-model-before')]);
    const adapter = new ClaudeCodeAdapter(processDeps);
    await adapter.start(taskIn('default', { model: 'haiku' }));
    let ledger = startAttemptUsage(1, 'claude-code', '2026-10-17T18:00:00Z');
    await adapter.send('one', (event) => {
      if (event.type === 'usage') ledger = addAttemptUsage(ledger, event.record, '2026-10-17T18:00:01Z');
    });
    expect(ledger.sessionBilling).toEqual({ type: 'subscription' });
    expect(ledger.totals.costProvenance).toEqual({ USD: { kind: 'estimate', basis: 'list', billing: 'subscription' } });
    expect(usageText(ledger)).toBe('≈$0.0019 API-equivalent');
    adapter.dispose();
  });

  const recording = () => [fixture('claude-code', 'task-model-before'), fixture('claude-code', 'task-model-command'), fixture('claude-code', 'task-model-switched')];

  it('reports a /model switch once the runner answers on the new model, under the ids it lists', async () => {
    const { processDeps } = deps(recording());
    const adapter = new ClaudeCodeAdapter(processDeps);
    await adapter.start(taskIn('default', { model: 'haiku' }));
    const events: AgentEvent[] = [];
    await adapter.send('Reply with just the word one.', (e) => events.push(e));
    await adapter.invokeCommand('model', 'sonnet', (e) => events.push(e));
    expect(events.filter((e) => e.type === 'model_switched')).toEqual([]);
    await adapter.send('Reply with just the word two.', (e) => events.push(e));

    expect(events.filter((e) => e.type === 'model_switched')).toEqual([
      { type: 'model_switched', from: { model: 'haiku', label: 'Haiku 5.5' }, to: { model: 'sonnet', label: 'Sonnet 5.5' } },
    ]);
    adapter.dispose();
  });

  // A model command's turn makes no call, and the window it reports is the
  // one the turn's `init` names. Reading the previous turn's model there made
  // a `/compact` right after `/model` report the old model's window last,
  // which cleared the size the compaction had just left.
  it('keeps the size a compaction left when it follows a model switch', async () => {
    const SESSION = 'sess-switch-compact';
    const A = 'claude-haiku-5-5';
    const B = 'claude-sonnet-5-5';
    const init = (model: string) => ({ type: 'system', subtype: 'init', session_id: SESSION, permissionMode: 'acceptEdits', model });
    const start = { type: 'stream_event', session_id: SESSION, parent_tool_use_id: null, event: { type: 'message_start', message: { model: A, id: 'msg_1' } } };
    const delta = { type: 'stream_event', session_id: SESSION, parent_tool_use_id: null, event: { type: 'message_delta', usage: { input_tokens: 1000, output_tokens: 10 } } };
    const result = (modelUsage: object, cost = 0.01) => ({ type: 'result', session_id: SESSION, subtype: 'success', is_error: false, result: 'ok', total_cost_usd: cost, usage: { input_tokens: 2, output_tokens: 3 }, modelUsage });
    const turn = (...lines: object[]) => `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`;
    const { processDeps } = deps([
      turn(init(A), start, delta, result({ [A]: { costUSD: 0.01, contextWindow: 200_000, costBasis: 'list' } })),
      // `/model sonnet`: a command turn with no call, whose init still names A.
      turn(init(A), result({ [A]: { costUSD: 0.01, contextWindow: 200_000, costBasis: 'list' } })),
      // `/compact` after the switch: it runs on B, and the result's cumulative
      // breakdown still contains A.
      turn(
        init(B),
        { type: 'system', subtype: 'compact_boundary', session_id: SESSION, compact_metadata: { trigger: 'manual', pre_tokens: 24_939, post_tokens: 3_615 } },
        result({ [A]: { costUSD: 0.01, contextWindow: 200_000, costBasis: 'list' }, [B]: { costUSD: 0.02, contextWindow: 1_000_000, costBasis: 'list' } }, 0.03),
      ),
    ]);
    const adapter = new ClaudeCodeAdapter(processDeps);
    await adapter.start(taskIn('acceptEdits'));
    const events: AgentEvent[] = [];
    await adapter.send('one', (e) => events.push(e));
    await adapter.invokeCommand('model', 'sonnet', (e) => events.push(e));
    await adapter.invokeCommand('compact', '', (e) => events.push(e));

    const ledger = events.reduce((usage, event) => event.type === 'usage' ? addAttemptUsage(usage, event.record, '2026-10-19T18:00:01Z') : usage,
      startAttemptUsage(1, 'claude-code', '2026-10-19T18:00:00Z'));
    expect(plannerContextFill(ledger)).toEqual({ usedTokens: 3_615, windowTokens: 1_000_000 });
    adapter.dispose();
  });

  // Recorded the same way, `/model opus` straight after `/model sonnet`: the
  // second command's own `init` already reports Sonnet, the first switch.
  it('follows two /model commands back to back, each once the runner answers on its model', async () => {
    const { processDeps } = deps([...recording().slice(0, 2), fixture('claude-code', 'task-model-command-again'), fixture('claude-code', 'task-model-switched-again')]);
    const adapter = new ClaudeCodeAdapter(processDeps);
    await adapter.start(taskIn('default', { model: 'haiku' }));
    const events: AgentEvent[] = [];
    await adapter.send('Reply with just the word one.', (e) => events.push(e));
    await adapter.invokeCommand('model', 'sonnet', (e) => events.push(e));
    await adapter.invokeCommand('model', 'opus', (e) => events.push(e));
    await adapter.send('Reply with just the word two.', (e) => events.push(e));

    expect(events.filter((e) => e.type === 'model_switched')).toEqual([
      { type: 'model_switched', from: { model: 'haiku', label: 'Haiku 5.5' }, to: { model: 'sonnet', label: 'Sonnet 5.5' } },
      { type: 'model_switched', from: { model: 'sonnet', label: 'Sonnet 5.5' }, to: { model: 'opus', label: 'Opus 5.5' } },
    ]);
    adapter.dispose();
  });

  // `/effort low` recorded after them: its turn only prints, and no `init`
  // before or after names an effort, so there is none to follow.
  it('follows no effort: /effort only prints', async () => {
    const { processDeps } = deps([...recording().slice(0, 2), fixture('claude-code', 'task-model-command-again'), fixture('claude-code', 'task-model-switched-again'), fixture('claude-code', 'task-effort-command')]);
    const adapter = new ClaudeCodeAdapter(processDeps);
    await adapter.start(taskIn('default', { model: 'haiku' }));
    await adapter.send('Reply with just the word one.', () => {});
    await adapter.invokeCommand('model', 'sonnet', () => {});
    await adapter.invokeCommand('model', 'opus', () => {});
    await adapter.send('Reply with just the word two.', () => {});
    const events: AgentEvent[] = [];
    await adapter.invokeCommand('effort', 'low', (e) => events.push(e));

    expect(events.filter((e) => e.type !== 'usage')).toEqual([
      { type: 'assistant_text', runId: 'c6e3aedd-0c29-4a98-89b7-0708cdd1f663:0', text: 'Set effort level to low (this session only): Quick, straightforward implementation with minimal overhead' },
      { type: 'turn_end' },
    ]);
    adapter.dispose();
  });

  // The CLI runs a message that starts with `/model` as the command however
  // the surface sent it: before the command list arrived, or into a finished
  // task's composer, it goes out as a plain message.
  it('follows a /model that went out as a plain message', async () => {
    const { processDeps } = deps(recording());
    const adapter = new ClaudeCodeAdapter(processDeps);
    await adapter.start(taskIn('default', { model: 'haiku' }));
    const events: AgentEvent[] = [];
    await adapter.send('Reply with just the word one.', (e) => events.push(e));
    await adapter.send('/model sonnet', (e) => events.push(e));
    await adapter.send('Reply with just the word two.', (e) => events.push(e));

    expect(events.filter((e) => e.type === 'model_switched')).toEqual([
      { type: 'model_switched', from: { model: 'haiku', label: 'Haiku 5.5' }, to: { model: 'sonnet', label: 'Sonnet 5.5' } },
    ]);
    adapter.dispose();
  });

  it('reports a change the chat did not ask for as drift, not as a switch to follow', async () => {
    const { processDeps } = deps([fixture('claude-code', 'task-model-before'), fixture('claude-code', 'task-model-switched')]);
    const adapter = new ClaudeCodeAdapter(processDeps);
    await adapter.start(taskIn('default', { model: 'haiku' }));
    const events: AgentEvent[] = [];
    await adapter.send('Reply with just the word one.', (e) => events.push(e));
    await adapter.send('Reply with just the word two.', (e) => events.push(e));

    expect(events.filter((e) => e.type === 'model_switched' || e.type === 'model_drifted')).toEqual([
      { type: 'model_drifted', from: { model: 'haiku', label: 'Haiku 5.5' }, to: { model: 'sonnet', label: 'Sonnet 5.5' } },
    ]);
    adapter.dispose();
  });

  it('lets go of a /model that switched nothing, so a later change is not taken for it', async () => {
    const { processDeps } = deps([...recording().slice(0, 2), fixture('claude-code', 'task-model-before'), fixture('claude-code', 'task-model-switched')]);
    const adapter = new ClaudeCodeAdapter(processDeps);
    await adapter.start(taskIn('default', { model: 'haiku' }));
    const events: AgentEvent[] = [];
    await adapter.send('Reply with just the word one.', (e) => events.push(e));
    await adapter.invokeCommand('model', 'haiku', (e) => events.push(e));
    await adapter.send('Reply with just the word one.', (e) => events.push(e));
    await adapter.send('Reply with just the word two.', (e) => events.push(e));

    expect(events.filter((e) => e.type === 'model_switched' || e.type === 'model_drifted')).toEqual([
      { type: 'model_drifted', from: { model: 'haiku', label: 'Haiku 5.5' }, to: { model: 'sonnet', label: 'Sonnet 5.5' } },
    ]);
    adapter.dispose();
  });
});

describe('ClaudeCodeAdapter — an interrupt and the turn it is for', () => {
  const line = (value: unknown) => `${JSON.stringify(value)}\n`;
  const ack = (written: string) => line({ type: 'control_response', response: { subtype: 'success', request_id: (JSON.parse(written) as { request_id: string }).request_id, response: {} } });
  const result = (subtype: string) => line({ type: 'result', subtype, is_error: subtype !== 'success', session_id: 'sess-1', result: subtype === 'success' ? 'done' : 'Usage limit reached' });
  const background = line({ type: 'system', subtype: 'background_tasks_changed', session_id: 'sess-1', tasks: [{ id: 'bg-1' }] });
  const speaking = line({ type: 'assistant', session_id: 'sess-1', message: { id: 'msg_wake', role: 'assistant', content: [{ type: 'text', text: 'woken' }] } });

  it('is not an interrupt when no turn is open, and leaves the adapter taking messages', async () => {
    const { spawned, processDeps } = deps([result('success')]);
    const adapter = new ClaudeCodeAdapter(processDeps);
    await adapter.start(taskStart());
    await adapter.send('quick', () => {});

    expect(await adapter.interrupt(50)).toBe(false);
    expect(sent(spawned).some((w) => w.includes('"subtype":"interrupt"'))).toBe(false);
    expect(await adapter.steer('m1', 'next')).toBe(true);
    adapter.dispose();
  });

  it('ends a turn whose finish raced an acknowledged interrupt as interrupted, and still reports a failure of a turn the runner opens itself', async () => {
    const { processDeps, spawned } = deps([(written, proc) => { void written; void proc; }, (written, proc) => proc.emitStdout(ack(written) + result('success'))]);
    const adapter = new ClaudeCodeAdapter(processDeps);
    await adapter.start(taskStart());
    const events: AgentEvent[] = [];
    const wake: AgentEvent[] = [];
    adapter.onOutOfTurn(( e) => wake.push(e));
    const turn = adapter.send('work', (e) => events.push(e));
    await tick();

    await expect(adapter.interrupt(1000)).resolves.toBe(true);
    await turn;
    // The model finished as the interrupt landed: the interrupt still ends it (ADR-0018 W1).
    expect(events.at(-1)).toEqual({ type: 'turn_end', interrupted: true });
    expect(await adapter.steer('m1', 'next')).toBe(true);

    spawned.processes[0].emitStdout(speaking + result('error_during_execution'));
    expect(wake.filter((e) => e.type === 'turn_end' || e.type === 'error')).toEqual([{ type: 'error', message: 'Usage limit reached' }]);
    adapter.dispose();
  });

  // The interrupt cuts the subagent's `Agent` call short, so its tool result
  // comes back an error: that is the stop that was asked for, not a failure.
  it('finishes a foreground subagent the interrupt cut short as stopped, and one that failed on its own as failed', async () => {
    const agentCall = (id: string) => line({ type: 'assistant', session_id: 'sess-1', message: { id: `msg_${id}`, role: 'assistant', content: [{ type: 'tool_use', id, name: 'Agent', input: { description: 'Read the README' } }] } });
    const agentError = (id: string, content: string) => line({ type: 'user', session_id: 'sess-1', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: true }] } });
    const { processDeps } = deps([
      agentCall('toolu_cut'),
      (written, proc) => proc.emitStdout(ack(written) + agentError('toolu_cut', 'Interrupted by user') + result('error_during_execution')),
      agentCall('toolu_broke') + agentError('toolu_broke', 'Agent crashed') + result('success'),
    ]);
    const adapter = new ClaudeCodeAdapter(processDeps);
    await adapter.start(taskStart());
    const cut: AgentEvent[] = [];
    const turn = adapter.send('look around', (e) => cut.push(e));
    await tick();

    await expect(adapter.interrupt(1000)).resolves.toBe(true);
    await turn;
    expect(cut.filter((e) => e.type === 'subagent_finished')).toEqual([{ type: 'subagent_finished', subagentId: 'toolu_cut', outcome: 'stopped', digest: 'Interrupted by user' }]);

    const broke: AgentEvent[] = [];
    await adapter.send('again', (e) => broke.push(e));
    expect(broke.filter((e) => e.type === 'subagent_finished')).toEqual([{ type: 'subagent_finished', subagentId: 'toolu_broke', outcome: 'failed', digest: 'Agent crashed' }]);
    adapter.dispose();
  });

  it('ends a turn held for background work when interrupted, without killing the work', async () => {
    const { spawned, processDeps } = deps([background + result('success')]);
    const adapter = new ClaudeCodeAdapter(processDeps);
    await adapter.start(taskStart());
    const events: AgentEvent[] = [];
    const turn = adapter.send('wait for it', (e) => events.push(e));
    await tick();
    expect(events.some((e) => e.type === 'turn_end')).toBe(false);

    await expect(adapter.interrupt(1000)).resolves.toBe(true);
    await turn;

    expect(events.at(-1)).toEqual({ type: 'turn_end', interrupted: true });
    expect(spawned.processes[0].killed).toBe(false);
    adapter.dispose();
  });
});
