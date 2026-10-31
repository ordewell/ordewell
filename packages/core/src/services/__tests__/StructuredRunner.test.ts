import { describe, it, expect } from 'vitest';
import { StructuredRunner } from '../StructuredRunner';
import { RunnerApprovals } from '../RunnerApprovals';
import { PendingApprovals } from '../PendingApprovals';
import type { RunnerSpawnOptions } from '../AbstractRunner';
import { RunnerRegistry } from '../../plugins/RunnerRegistry';
import type { IRunnerSession, StructuredEvent, StructuredTurnEnd } from '../../interfaces/IRunner';
import type { AgentEvent, SpawnFn, AgentStartOptions, TaskModeAgentAdapter, TaskStartOptions } from '../harness/AgentAdapter';
import type { OrdewellMcpServer, TaskTokenScope } from '../mcp/OrdewellMcpServer';
import type { TaskToolHandler } from '../mcp/tools';
import { TASK_COMPLETION_CONTRACT, taskCompletionContract } from '../mcp';
import { ClaudeCodeAdapter } from '../harness/ClaudeCodeAdapter';
import { McpAttachTimeout } from '../harness/ordewellBinding';
import { claudeTurnEndQueue, claudeSteerRecording, fakeSpawn, fixture, type FakeSpawnResult, type ScriptedReply } from './harnessTestKit';

/**
 * The structured transport (ADR-0018) driven through the real Claude Code
 * adapter and a fake process, fed transcripts recorded from `claude` 2.1.284.
 * What is asserted is what the orchestrator and the surfaces would see:
 * `onOutput`, the turn lifecycle, the queue, and `onExit`. Those transcripts
 * predate mid-turn delivery, so the adapter keeps the turn-end queue here;
 * Claude's mid-turn delivery is covered in claudeTaskMode.test.ts.
 */

const registry = new RunnerRegistry();

function harness(replies: ScriptedReply[], interruptGraceMs = 1000) {
  const spawned = fakeSpawn(replies);
  const spawns: Array<{ env: NodeJS.ProcessEnv; cwd: string }> = [];
  const spawn: SpawnFn = (command, args, options) => {
    spawns.push({ env: options.env, cwd: options.cwd });
    return spawned.spawn(command, args, options);
  };
  const runner = new StructuredRunner({
    process: { spawn, resolvePath: async () => '/usr/bin', platform: 'linux', isDirectory: () => true, exists: () => true },
    createAdapter: claudeTurnEndQueue,
    interruptGraceMs,
  });
  return { runner, spawned, spawns };
}

function options(overrides: Partial<RunnerSpawnOptions> = {}): RunnerSpawnOptions {
  return {
    taskId: 'task-0001-abcdef',
    runner: 'claude-code',
    prompt: 'Do the task',
    modelId: 'sonnet',
    mode: 'acceptEdits',
    cwd: '/repo',
    registry,
    ...overrides,
  };
}

/** Everything a session reports, in order, plus a way to wait for the next turn end. */
function observe(session: IRunnerSession) {
  const chunks: string[] = [];
  const events: StructuredEvent[] = [];
  const turnEnds: StructuredTurnEnd[] = [];
  const statesAtTurnEnd: string[] = [];
  const exits: number[] = [];
  let waiters: Array<() => void> = [];
  session.onOutput((text) => chunks.push(text));
  session.onEvent((event) => events.push(event));
  session.onTurnEnd((reason) => {
    turnEnds.push(reason);
    statesAtTurnEnd.push(session.turnState());
    const ready = waiters;
    waiters = [];
    for (const resolve of ready) resolve();
  });
  session.onExit((code) => exits.push(code));
  let consumedEnds = 0;
  const nextTurnEnd = async () => {
    consumedEnds += 1;
    if (turnEnds.length < consumedEnds) await new Promise<void>((resolve) => { waiters.push(resolve); });
    // The event ends the turn before the adapter releases its send.
    for (let i = 0; i < 8; i++) await Promise.resolve();
  };
  return { session, chunks, events, turnEnds, statesAtTurnEnd, exits, nextTurnEnd };
}

/** The text of each user turn the adapter wrote to the runner's stdin. */
function userTurns(written: string[]): string[] {
  return written
    .map((line) => JSON.parse(line) as { type: string; message?: { content: Array<{ text: string }> } })
    .filter((msg) => msg.type === 'user')
    .map((msg) => msg.message!.content[0].text);
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !condition(); i++) await tick();
  if (!condition()) throw new Error('condition never held');
}

/**
 * The prompt goes out in a `setImmediate` once the runner has started, and a
 * zero-delay timer is not ordered against it: under load the timer fires
 * first. A test that acts on the first turn waits until it was sent.
 */
async function firstTurn(spawned: FakeSpawnResult): Promise<void> {
  await until(() => userTurns(spawned.processes[0]?.written ?? []).length > 0);
}

/** What the session wrote to the runner after the `initialize` and attach check every spawn opens with. */
function afterAttachCheck(written: string[]): string[] {
  return written.filter((line) => !line.includes('"subtype":"mcp_status"') && !line.includes('"subtype":"initialize"'));
}

describe('StructuredRunner out-of-turn output', () => {
  // The turn that follows a background task, recorded from `claude` 2.1.286, which the CLI
  // opens by itself with no user message behind it.
  const wakeTurn = fixture('claude-code', 'task-background').split('\n').slice(
    fixture('claude-code', 'task-background').split('\n').findIndex((line) => line.includes('"task_notification"')) + 1,
  ).join('\n');

  it('shows a turn the runner starts on its own as a turn of the task, and keeps the task working until it ends', async () => {
    const { runner, spawned } = harness([fixture('claude-code', 'task-marker')]);
    const seen = observe(await runner.spawn(options()));
    await seen.nextTurnEnd();
    expect(seen.session.turnState()).toBe('idle');

    const ended = seen.nextTurnEnd();
    spawned.processes[0].emitStdout(wakeTurn);
    await ended;

    expect(seen.turnEnds).toEqual(['completed', 'completed']);
    expect(seen.statesAtTurnEnd).toEqual(['idle', 'idle']);
    expect(seen.chunks.join('')).toContain('FINISHED');
    const starts = seen.events.filter((e) => e.type === 'turn_start');
    expect(starts).toHaveLength(2);
    expect(starts[1]).toMatchObject({ text: '' });
    seen.session.kill();
  });

  it('queues a message sent while such a turn runs, and delivers it when the turn ends', async () => {
    const { runner, spawned } = harness([fixture('claude-code', 'task-marker'), fixture('claude-code', 'task-marker')]);
    const seen = observe(await runner.spawn(options()));
    await seen.nextTurnEnd();

    const lines = wakeTurn.split('\n').filter(Boolean);
    const result = lines.pop()!;
    spawned.processes[0].emitStdout(`${lines.join('\n')}\n`);
    await until(() => seen.session.turnState() === 'working');
    seen.session.sendMessage('and then?');
    expect(seen.session.queued().map((m) => m.text)).toEqual(['and then?']);

    spawned.processes[0].emitStdout(`${result}\n`);
    await until(() => userTurns(spawned.processes[0].written).includes('and then?'));
    expect(seen.session.queued()).toEqual([]);
    seen.session.kill();
  });
});

describe('StructuredRunner spawn', () => {
  it.each([
    ['default', 'default'],
    ['acceptEdits', 'acceptEdits'],
    ['plan', 'default'],
    ['bypassPermissions', 'bypassPermissions'],
    // The legacy alias resolves through the manifest, as a terminal task's does.
    ['build', 'acceptEdits'],
  ])('runs mode %s under --permission-mode %s', async (mode, expected) => {
    const { runner, spawned } = harness([]);
    const session = await runner.spawn(options({ mode }));
    const args = spawned.lastArgs();
    expect(args[args.indexOf('--permission-mode') + 1]).toBe(expected);
    // Only the question tool: a task keeps every other tool its mode allows.
    expect(args[args.indexOf('--disallowedTools') + 1]).toBe(mode === 'plan' ? 'AskUserQuestion,Edit,Write,MultiEdit,NotebookEdit,KillShell,Bash,Monitor,PowerShell,EnterPlanMode,ExitPlanMode' : 'AskUserQuestion');
    // The one system prompt a task has: how it ends, which the CLI's compaction cannot summarise away.
    expect(args[args.indexOf('--append-system-prompt') + 1]).toContain('call the `task_complete` tool with status `done`');
    expect(args).not.toContain('--dangerously-skip-permissions');
    session.kill();
  });

  it('hands the attempt\'s runner config to the Claude start, which narrows what it loads', async () => {
    const { runner, spawned } = harness([]);
    const session = await runner.spawn(options({ runnerConfig: 'minimal' }));
    const args = spawned.lastArgs();
    expect(args).toContain('--strict-mcp-config');
    expect(args[args.indexOf('--setting-sources') + 1]).toBe('project,local');
    session.kill();
  });

  it('asks a change task for its commit in its system prompt, and no other task (ADR-0047)', async () => {
    const { runner, spawned } = harness([]);
    const prompts: string[] = [];
    for (const commits of [undefined, true] as const) {
      const session = await runner.spawn(options(commits ? { commits } : {}));
      const args = spawned.lastArgs();
      prompts.push(args[args.indexOf('--append-system-prompt') + 1]);
      session.kill();
    }

    expect(prompts).toEqual([TASK_COMPLETION_CONTRACT, taskCompletionContract({ commits: true })]);
  });

  it('builds the full command line: protocol, mode, effort from the manifest, model, resume and the Ordewell server', async () => {
    const { runner, spawned } = harness([]);
    const session = await runner.spawn(options({ thinkingEffort: 'high', resumeSessionId: 'sess-prev' }));
    expect(spawned.lastArgs()).toEqual([
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--replay-user-messages',
      '--permission-prompt-tool', 'stdio',
      '--permission-mode', 'acceptEdits',
      '--disallowedTools', 'AskUserQuestion',
      '--thinking', 'enabled', '--effort', 'high',
      '--model', 'sonnet',
      '--resume', 'sess-prev',
      '--append-system-prompt', TASK_COMPLETION_CONTRACT,
      '--mcp-config', expect.stringMatching(/mcp\.json$/),
      '--allowedTools', 'mcp__ordewell__task_complete,mcp__ordewell__checkpoint,mcp__ordewell__read_task,mcp__ordewell__apply_patch',
    ]);
    session.kill();
  });

  it.each([
    ['adaptive', 'sonnet', ['--thinking', 'adaptive']],
    ['max', 'sonnet', ['--thinking', 'enabled', '--effort', 'max']],
    // Effort only rides with a model.
    ['high', undefined, []],
  ])('maps effort %s (model %s) the way the manifest does', async (thinkingEffort, modelId, expected) => {
    const { runner, spawned } = harness([]);
    const session = await runner.spawn(options({ thinkingEffort, modelId }));
    const args = spawned.lastArgs();
    const from = args.indexOf('--disallowedTools') + 2;
    const to = args.indexOf(modelId ? '--model' : '--append-system-prompt');
    expect(args.slice(from, to)).toEqual(expected);
    session.kill();
  });

  it.each([
    ['claude-code', 'acceptEdits', 'sonnet', 'high', { permissionMode: 'acceptEdits', effort: 'high', modeSettings: {} }],
    // Runner-neutral: a Codex task gets its sandbox value and the raw effort, never Claude's thinking flags.
    ['codex', 'agent', 'gpt-5.5', 'high', { permissionMode: 'workspace-write', effort: 'high', modeSettings: { approvalPolicy: 'on-request', approvalsReviewer: 'auto_review' } }],
    ['claude-code', 'default', undefined, 'max', { permissionMode: 'default', modeSettings: {} }],
  ])('hands the %s adapter the manifest\'s flags for mode %s, model %s, effort %s', async (runnerId, mode, modelId, thinkingEffort, flags) => {
    const starts: AgentStartOptions[] = [];
    class Recording extends ClaudeCodeAdapter {
      override start(opts: AgentStartOptions): Promise<void> {
        starts.push(opts);
        return super.start(opts);
      }
    }
    const runner = new StructuredRunner({
      process: { spawn: fakeSpawn([]).spawn, resolvePath: async () => '/usr/bin', platform: 'linux', isDirectory: () => true, exists: () => true },
      createAdapter: (_runner, deps) => new Recording(deps),
    });
    const session = await runner.spawn(options({ runner: runnerId, mode, modelId, thinkingEffort }));
    expect(starts).toHaveLength(1);
    expect(starts[0]).toMatchObject({ kind: 'task', mode, model: modelId });
    expect(starts[0].kind === 'task' && starts[0].flags).toEqual(flags);
    session.kill();
  });

  it('runs in the task cwd with the workspace env, and sends the prompt as the first turn', async () => {
    const { runner, spawned, spawns } = harness([]);
    const session = await runner.spawn(options({ env: { DATABASE_URL: 'postgres://local' } }));
    await firstTurn(spawned);
    expect(spawns[0].cwd).toBe('/repo');
    expect(spawns[0].env.DATABASE_URL).toBe('postgres://local');
    expect(userTurns(spawned.processes[0].written)).toEqual(['Do the task']);
    session.kill();
  });

  it('fails a task whose mode the host cannot run before starting anything, with the reason', async () => {
    const { runner, spawned } = harness([]);
    const noSandbox = new RunnerRegistry();
    noSandbox.setUnavailableModes('codex', { plan: 'Codex sandbox cannot start on this host.' });

    await expect(runner.spawn(options({ runner: 'codex', mode: 'plan', registry: noSandbox })))
      .rejects.toThrow('Mode "plan" of Codex is unavailable on this host: Codex sandbox cannot start on this host.');
    expect(spawned.processes).toHaveLength(0);
    expect(runner.activeCount).toBe(0);
  });

  it('refuses an unknown runner before spawning a process', async () => {
    const { runner, spawned } = harness([]);
    await expect(runner.spawn(options({ runner: 'removed-runner' }))).rejects.toThrow('No runner manifest is registered for "removed-runner".');
    expect(spawned.processes).toHaveLength(0);
    expect(runner.activeCount).toBe(0);
  });
});

describe('StructuredSession output', () => {
  it('writes a line whole even though it streamed in four deltas, after one line per tool call', async () => {
    const { runner } = harness([fixture('claude-code', 'task-marker')]);
    const turn = observe(await runner.spawn(options()));
    await turn.nextTurnEnd();

    expect(turn.chunks.some((chunk) => chunk.includes('<<<ORDEWELL_DONE_test-1234>>>'))).toBe(true);
    expect(turn.session.getOutput()).toBe('› Bash(cat README.md)\n<<<ORDEWELL_DONE_test-1234>>>\n');
    expect(turn.chunks.join('')).toBe(turn.session.getOutput());
    expect(turn.turnEnds).toEqual(['completed']);
    expect(turn.session.turnState()).toBe('idle');
    expect(turn.session.nativeSessionId()).toBe('sess-task-marker');
    turn.session.kill();
  });

  it('ends a turn without a task_complete call as a completed turn, and waits', async () => {
    const { runner } = harness([fixture('claude-code', 'task-no-marker')]);
    const turn = observe(await runner.spawn(options()));
    await turn.nextTurnEnd();
    expect(turn.session.getOutput()).toBe('Hi! Ready to help you with your project.\n');
    expect(turn.turnEnds).toEqual(['completed']);
    expect(turn.session.turnState()).toBe('idle');
    expect(turn.exits).toEqual([]);
    turn.session.kill();
  });

  it('leaves subagent work out of the plain text, but not out of the events', async () => {
    const { runner } = harness([fixture('claude-code', 'stream-subagent').replaceAll('"permissionMode":"plan"', '"permissionMode":"default"')]);
    const turn = observe(await runner.spawn(options({ mode: 'plan' })));
    await turn.nextTurnEnd();
    const output = turn.session.getOutput();
    expect(output).toContain('› Agent(Read README first line)');
    expect(output).not.toContain('› Read(');
    expect(output).toContain('The first line of README.md is `hello`.');
    expect(turn.events.some((e) => e.type === 'tool_call' && e.name === 'Read' && e.subagentId)).toBe(true);
    turn.session.kill();
  });

  it('writes a usage limit the CLI says twice once (#79)', async () => {
    const limit = "You've hit your session limit · resets 8:10pm (Europe/Rome)";
    // An assistant message, then the `result` of the failed turn, worded alike but for a final period.
    const transcript = [
      { type: 'system', subtype: 'init', session_id: 'sess-limit', cwd: '/repo', permissionMode: 'acceptEdits' },
      { type: 'assistant', session_id: 'sess-limit', message: { id: 'msg_limit', role: 'assistant', content: [{ type: 'text', text: limit }] } },
      { type: 'result', subtype: 'success', session_id: 'sess-limit', is_error: true, result: `${limit}.` },
    ].map((line) => `${JSON.stringify(line)}\n`).join('');
    const { runner } = harness([transcript]);
    const turn = observe(await runner.spawn(options()));
    await turn.nextTurnEnd();

    expect(turn.session.getOutput()).toBe(`${limit}\n`);
    expect(turn.turnEnds).toEqual(['failed']);
    // The events are the record; the plain text is the lossy view.
    expect(turn.events.filter((e) => e.type === 'assistant_text' || e.type === 'error')).toHaveLength(2);
    turn.session.kill();
  });

  it('keeps a failure that says more than the last message (#79)', async () => {
    const transcript = [
      { type: 'system', subtype: 'init', session_id: 'sess-fail', cwd: '/repo', permissionMode: 'acceptEdits' },
      { type: 'assistant', session_id: 'sess-fail', message: { id: 'msg_fail', role: 'assistant', content: [{ type: 'text', text: 'Reading the cache.' }] } },
      { type: 'result', subtype: 'success', session_id: 'sess-fail', is_error: true, result: 'The session limit was reached.' },
    ].map((line) => `${JSON.stringify(line)}\n`).join('');
    const { runner } = harness([transcript]);
    const turn = observe(await runner.spawn(options()));
    await turn.nextTurnEnd();

    expect(turn.session.getOutput()).toBe('Reading the cache.\nThe session limit was reached.\n');
    turn.session.kill();
  });

  it('emits the turn and its events in order', async () => {
    const { runner } = harness([fixture('claude-code', 'task-marker')]);
    const turn = observe(await runner.spawn(options()));
    await turn.nextTurnEnd();
    const types = turn.events.map((e) => e.type);
    expect(types[0]).toBe('turn_start');
    expect(turn.events.at(-1)).toEqual({ type: 'turn_end', reason: 'completed' });
    expect(types).toContain('tool_call');
    expect(types).toContain('tool_result');
    expect(types).toContain('assistant_text_delta');
    expect(types).toContain('usage');
    turn.session.kill();
  });

  it('passes a runner permission request on under an id of its own, and answers it through the session', async () => {
    const { runner, spawned } = harness([fixture('claude-code', 'permission-task'), fixture('claude-code', 'permission-task-allowed')]);
    const turn = observe(await runner.spawn(options({ mode: 'default' })));
    await until(() => turn.events.some((e) => e.type === 'permission_request'));
    const request = turn.events.find((e) => e.type === 'permission_request');
    expect(request).toMatchObject({ name: 'Write', input: { file_path: '/repo/a.txt' }, suggestions: [{ type: 'setMode', mode: 'acceptEdits' }] });
    const id = request?.type === 'permission_request' ? request.id : '';
    expect(id).toBe(`${turn.session.id}-perm-1`);
    // Still mid-turn: an approval is not the end of one.
    expect(turn.session.turnState()).toBe('working');

    expect(turn.session.answerPermission(id, { decision: 'allow' })).toBe(true);
    expect(turn.events).toContainEqual({ type: 'permission_decided', id, decision: { decision: 'allow' } });
    const answer = JSON.parse(afterAttachCheck(spawned.processes[0].written)[1]) as { response: { request_id: string } };
    expect(answer.response.request_id).toBe('9a948184-6792-4049-85b1-3e837387f618');
    expect(turn.session.answerPermission(id, { decision: 'deny' })).toBe(false);
    turn.session.kill();
  });

  it('keeps an HTTP permission card pending until delivery and offers it again after a failed reply', async () => {
    let emit: (event: AgentEvent) => void = () => {};
    let finish: () => void = () => {};
    let rejectReply: (err: Error) => void = () => {};
    let attempts = 0;
    const adapter: TaskModeAgentAdapter = {
      agentId: 'opencode', exited: false, start: async () => {}, nativeSessionId: () => null, dispose: () => {},
      mcpAttached: async () => true, interrupt: async () => true, onProcessExit: () => {},
      send: (_text, onEvent) => new Promise<void>((resolve) => { emit = onEvent; finish = resolve; }),
      answerPermission: () => ++attempts === 1
        ? new Promise<boolean>((_resolve, reject) => { rejectReply = reject; }) : Promise.resolve(true),
    };
    const runner = new StructuredRunner({ createAdapter: () => adapter });
    const approvals = new PendingApprovals();
    const bridge = new RunnerApprovals(approvals);
    const turn = observe(await bridge.wrap(runner).spawn(options({ runner: 'opencode', mode: 'build' })));
    await tick();
    emit({ type: 'permission_request', id: 'per_1', name: 'shell', detail: '{}' });
    const id = `${turn.session.id}-perm-1`;
    expect(approvals.resolve(id, { decision: 'allow' })).toBe(true);
    expect(turn.session.answerPermission(id, { decision: 'deny' })).toBe(false);
    expect(turn.events.some((e) => e.type === 'permission_decided')).toBe(false);
    rejectReply(new Error('offline'));
    await until(() => approvals.outstanding().length === 1);
    expect(approvals.outstanding()[0].id).toBe(id);
    expect(bridge.waiting(turn.session.taskId)).toBe(1);
    expect(turn.events.filter((e) => e.type === 'permission_request').map((e) => e.id)).toEqual([id, id]);
    expect(turn.events.some((e) => e.type === 'permission_withdrawn' || e.type === 'permission_decided')).toBe(false);
    expect(approvals.resolve(id, { decision: 'deny' })).toBe(true);
    await until(() => turn.events.some((e) => e.type === 'permission_decided'));
    expect(turn.events).toContainEqual({ type: 'permission_decided', id, decision: { decision: 'deny' } });
    finish();
    turn.session.kill();
  });

  it('shows a request the task\'s mode already answered as asked and decided, with nothing left open', async () => {
    const answered: string[] = [];
    const decided: AgentEvent = { type: 'permission_request', id: 'per_1', name: 'bash', detail: '{}', decided: { decision: 'allow' } };
    const adapter: TaskModeAgentAdapter = {
      agentId: 'opencode',
      exited: false,
      start: async () => {},
      send: async (_message, onEvent) => { onEvent(decided); onEvent({ type: 'turn_end' }); },
      nativeSessionId: () => null,
      dispose: () => {},
      interrupt: async () => true,
      onProcessExit: () => {},
      answerPermission: (id) => { answered.push(id); return true; },
      mcpAttached: async () => true,
    };
    const runner = new StructuredRunner({ createAdapter: () => adapter });
    const turn = observe(await runner.spawn(options({ runner: 'opencode', mode: 'build' })));
    await turn.nextTurnEnd();

    const id = `${turn.session.id}-perm-1`;
    const permissionEvents = turn.events.filter((e) => e.type.startsWith('permission_'));
    expect(permissionEvents).toEqual([
      { ...decided, id },
      { type: 'permission_decided', id, decision: { decision: 'allow' } },
    ]);
    expect(turn.session.answerPermission(id, { decision: 'deny' })).toBe(false);
    expect(answered).toEqual([]);
    turn.session.kill();
  });

  it('withdraws a request the runner cancels, and one left open when it goes', async () => {
    const { runner } = harness([
      fixture('claude-code', 'permission-task-deny'),
      fixture('claude-code', 'permission-task-denied'),
      (written, proc) => {
        const request = JSON.parse(written) as { request_id: string };
        proc.emitStdout(fixture('claude-code', 'permission-task-cancelled', { REQUEST_ID: request.request_id }));
      },
    ]);
    const turn = observe(await runner.spawn(options({ mode: 'default' })));
    const requests = () => turn.events.flatMap((e) => (e.type === 'permission_request' ? [e.id] : []));
    await until(() => requests().length === 1);
    turn.session.answerPermission(requests()[0], { decision: 'deny', note: 'Not this one' });
    await until(() => requests().length === 2);

    await turn.session.interrupt();
    expect(turn.events).toContainEqual({ type: 'permission_withdrawn', id: requests()[1] });
    expect(turn.turnEnds).toEqual(['interrupted']);
    expect(turn.session.answerPermission(requests()[1], { decision: 'allow' })).toBe(false);
    turn.session.kill();
  });

  it('withdraws what is still open when the session is killed', async () => {
    const { runner } = harness([fixture('claude-code', 'permission-task')]);
    const turn = observe(await runner.spawn(options({ mode: 'default' })));
    await until(() => turn.events.some((e) => e.type === 'permission_request'));
    const request = turn.events.find((e) => e.type === 'permission_request');
    turn.session.kill();
    expect(turn.events.at(-1)).toEqual({ type: 'permission_withdrawn', id: request?.type === 'permission_request' ? request.id : '' });
  });
});

describe('StructuredSession messages', () => {
  it('gives an echoed message its own turn when its first line shares the previous result chunk', async () => {
    const { before } = claudeSteerRecording('after-result');
    const spawned = fakeSpawn([before, (written, proc) => {
      const { uuid } = JSON.parse(written) as { uuid: string };
      const recording = fixture('claude-code', 'task-steer-after-result', { STEER_UUID: uuid });
      proc.emitStdout(recording.slice(before.length));
    }]);
    const runner = new StructuredRunner({ process: {
      spawn: spawned.spawn, resolvePath: async () => '/usr/bin', platform: 'linux', isDirectory: () => true, exists: () => true,
    } });
    const turn = observe(await runner.spawn(options({ mode: 'bypassPermissions' })));
    await firstTurn(spawned);
    const id = turn.session.sendMessage('Now reply with only the word PINEAPPLE.');
    await tick();
    await until(() => turn.events.some((e) => e.type === 'assistant_text' && e.text === 'PINEAPPLE'));
    expect(turn.events.filter((e) => e.type === 'turn_start' || e.type === 'turn_end' || e.type === 'message_delivered')).toEqual([
      { type: 'turn_start', text: 'Do the task' },
      { type: 'turn_end', reason: 'completed' },
      { type: 'turn_start', text: 'Now reply with only the word PINEAPPLE.', messageId: id },
      { type: 'turn_end', reason: 'completed' },
    ]);
    turn.session.kill();
  });

  it('holds a write made during a turn until the turn ends, then delivers it without going idle', async () => {
    const { runner, spawned } = harness([
      () => { /* the first turn stays open until the test ends it */ },
      fixture('claude-code', 'task-no-marker'),
    ]);
    const turn = observe(await runner.spawn(options()));
    await firstTurn(spawned);

    turn.session.write('  Yes, go ahead.\r');
    expect(turn.session.queued()).toEqual([{ id: expect.any(String), text: 'Yes, go ahead.' }]);
    expect(userTurns(spawned.processes[0].written)).toEqual(['Do the task']);

    spawned.processes[0].emitStdout(fixture('claude-code', 'task-marker'));
    await turn.nextTurnEnd();
    expect(turn.statesAtTurnEnd.slice(0, 1)).toEqual(['working']);
    expect(turn.session.queued()).toEqual([]);
    expect(userTurns(spawned.processes[0].written)).toEqual(['Do the task', 'Yes, go ahead.']);

    await turn.nextTurnEnd();
    expect(turn.statesAtTurnEnd).toEqual(['working', 'idle']);
    const queue = turn.events.filter((e) => e.type === 'message_queued' || e.type === 'turn_start');
    const [queued] = queue.filter((e) => e.type === 'message_queued');
    expect(queue).toEqual([
      { type: 'turn_start', text: 'Do the task' },
      { type: 'message_queued', messageId: expect.any(String), text: 'Yes, go ahead.' },
      { type: 'turn_start', text: 'Yes, go ahead.', messageId: queued?.type === 'message_queued' ? queued.messageId : '' },
    ]);
    turn.session.kill();
  });

  it('can take a queued message back before it is delivered', async () => {
    const { runner, spawned } = harness([() => {}]);
    const turn = observe(await runner.spawn(options()));
    await firstTurn(spawned);
    const id = turn.session.sendMessage('Never mind');
    expect(turn.session.removeQueued(id)).toBe(true);
    expect(turn.session.removeQueued(id)).toBe(false);
    expect(turn.events.filter((e) => e.type === 'message_removed')).toEqual([{ type: 'message_removed', messageId: id }]);

    spawned.processes[0].emitStdout(fixture('claude-code', 'task-no-marker'));
    await turn.nextTurnEnd();
    expect(userTurns(spawned.processes[0].written)).toEqual(['Do the task']);
    expect(turn.session.turnState()).toBe('idle');
    turn.session.kill();
  });

  it('delivers at once when idle', async () => {
    const { runner, spawned } = harness([fixture('claude-code', 'task-no-marker'), fixture('claude-code', 'task-no-marker')]);
    const turn = observe(await runner.spawn(options()));
    await turn.nextTurnEnd();
    turn.session.sendMessage('One more thing');
    expect(turn.session.turnState()).toBe('working');
    expect(turn.session.queued()).toEqual([]);
    await turn.nextTurnEnd();
    expect(userTurns(spawned.processes[0].written)).toEqual(['Do the task', 'One more thing']);
    turn.session.kill();
  });

  it('marks a message Ordewell sent on the turn it opens when idle', async () => {
    const { runner, spawned } = harness([fixture('claude-code', 'task-no-marker'), fixture('claude-code', 'task-no-marker')]);
    const turn = observe(await runner.spawn(options()));
    await turn.nextTurnEnd();
    turn.session.sendMessage('Call task_complete', 'ordewell');
    await turn.nextTurnEnd();
    expect(userTurns(spawned.processes[0].written)).toEqual(['Do the task', 'Call task_complete']);
    expect(turn.events.filter((e) => e.type === 'turn_start').at(-1)).toEqual({ type: 'turn_start', text: 'Call task_complete', from: 'ordewell' });
    turn.session.kill();
  });

  it('marks a message Ordewell sent while it is queued, and on the turn it opens', async () => {
    const { runner, spawned } = harness([() => {}, fixture('claude-code', 'task-no-marker')]);
    const turn = observe(await runner.spawn(options()));
    await firstTurn(spawned);
    const id = turn.session.sendMessage('Call task_complete', 'ordewell');
    expect(turn.session.queued()).toEqual([{ id, text: 'Call task_complete', from: 'ordewell' }]);

    spawned.processes[0].emitStdout(fixture('claude-code', 'task-no-marker'));
    await turn.nextTurnEnd();
    await turn.nextTurnEnd();
    const marked = turn.events.filter((e) => (e.type === 'message_queued' || e.type === 'turn_start') && 'from' in e);
    expect(marked).toEqual([
      { type: 'message_queued', messageId: id, text: 'Call task_complete', from: 'ordewell' },
      { type: 'turn_start', text: 'Call task_complete', messageId: id, from: 'ordewell' },
    ]);
    turn.session.kill();
  });

  it('ignores a blank write', async () => {
    const { runner } = harness([() => {}]);
    const turn = observe(await runner.spawn(options()));
    turn.session.write(' \r\n');
    expect(turn.session.queued()).toEqual([]);
    turn.session.kill();
  });
});

describe('StructuredSession runner commands (#66)', () => {
  /** `/compact` recorded on a task in `default`, replayed under the `acceptEdits` these tasks ask for. */
  const compact = fixture('claude-code', 'task-compact').split('"permissionMode":"default"').join('"permissionMode":"acceptEdits"');

  it('reports the commands its runner offers', async () => {
    const { runner } = harness([compact]);
    const turn = observe(await runner.spawn(options()));
    await turn.nextTurnEnd();
    expect(turn.session.commands().map((c) => c.name)).toEqual(['tdd', 'pingskill', 'hellocmd', 'clear', 'compact', 'model', 'docs']);
    turn.session.kill();
  });

  it('runs a command as a turn of its own, the turn saying which command opened it', async () => {
    const { runner, spawned } = harness([fixture('claude-code', 'task-no-marker'), compact]);
    const turn = observe(await runner.spawn(options()));
    await turn.nextTurnEnd();

    turn.session.invokeCommand('compact');
    await turn.nextTurnEnd();
    expect(userTurns(spawned.processes[0].written)).toEqual(['Do the task', '/compact']);
    expect(turn.events.filter((e) => e.type === 'turn_start').at(-1)).toEqual({ type: 'turn_start', text: '/compact', command: { name: 'compact' } });
    expect(turn.events.filter((e) => e.type === 'compaction' || e.type === 'command_output')).toEqual([
      { type: 'compaction', trigger: 'manual', preTokens: 24939, postTokens: 3615 },
      { type: 'command_output', text: 'Compacted' },
    ]);
    expect(turn.turnEnds).toEqual(['completed', 'completed']);
    turn.session.kill();
  });

  it('queues a command sent while a turn runs without handing it to that turn, and runs it next', async () => {
    const spawned = fakeSpawn([() => {}, compact]);
    const runner = new StructuredRunner({
      process: { spawn: spawned.spawn, resolvePath: async () => '/usr/bin', platform: 'linux', isDirectory: () => true, exists: () => true },
      createAdapter: (_runner, deps) => new ClaudeCodeAdapter(deps),
    });
    const turn = observe(await runner.spawn(options()));
    await firstTurn(spawned);

    const id = turn.session.invokeCommand('compact', 'keep the API notes');
    await tick();
    expect(turn.session.queued()).toEqual([{ id, text: '/compact keep the API notes' }]);
    expect(userTurns(spawned.processes[0].written)).toEqual(['Do the task']);

    spawned.processes[0].emitStdout(fixture('claude-code', 'task-no-marker'));
    await turn.nextTurnEnd();
    await turn.nextTurnEnd();
    expect(userTurns(spawned.processes[0].written)).toEqual(['Do the task', '/compact keep the API notes']);
    expect(turn.events.filter((e) => e.type === 'turn_start').at(-1)).toEqual({
      type: 'turn_start', text: '/compact keep the API notes', messageId: id, command: { name: 'compact', args: 'keep the API notes' },
    });
    turn.session.kill();
  });
});

describe('StructuredSession interrupt', () => {
  it('stops the turn with a soft interrupt and keeps the process', async () => {
    const { runner, spawned } = harness([
      fixture('claude-code', 'task-interrupt'),
      (written, proc) => {
        const request = JSON.parse(written) as { request_id: string };
        proc.emitStdout(fixture('claude-code', 'task-interrupt-ack', { REQUEST_ID: request.request_id }));
      },
      fixture('claude-code', 'task-interrupt-followup'),
    ]);
    const turn = observe(await runner.spawn(options()));
    await firstTurn(spawned);

    await turn.session.interrupt();
    expect(turn.turnEnds).toEqual(['interrupted']);
    expect(turn.session.turnState()).toBe('idle');
    expect(spawned.processes).toHaveLength(1);
    expect(JSON.parse(afterAttachCheck(spawned.processes[0].written)[1])).toMatchObject({ type: 'control_request', request: { subtype: 'interrupt' } });

    turn.session.sendMessage('Say only: ok');
    await turn.nextTurnEnd();
    expect(turn.turnEnds).toEqual(['interrupted', 'completed']);
    expect(turn.session.getOutput()).toBe('ok\n');
    expect(turn.exits).toEqual([]);
    turn.session.kill();
  });

  it('restarts the runner when its interrupt request never answers within the grace', async () => {
    const adapters: TaskModeAgentAdapter[] = [];
    const makeAdapter = (hung: boolean): TaskModeAgentAdapter => ({
      agentId: 'opencode', exited: false, start: async () => {}, nativeSessionId: () => 'ses_1', dispose: () => {},
      mcpAttached: async () => true, onProcessExit: () => {}, answerPermission: () => false,
      send: () => new Promise<void>(() => {}),
      interrupt: () => (hung ? new Promise<boolean>(() => {}) : Promise.resolve(true)),
    });
    const runner = new StructuredRunner({ createAdapter: () => { const next = makeAdapter(adapters.length === 0); adapters.push(next); return next; }, interruptGraceMs: 20 });
    const turn = observe(await runner.spawn(options({ runner: 'opencode', mode: 'build' })));
    await tick();

    const interrupted = turn.session.interrupt();
    await expect(Promise.race([interrupted.then(() => 'done'), new Promise((resolve) => setTimeout(() => resolve('hung'), 500))])).resolves.toBe('done');
    expect(adapters).toHaveLength(2);
    expect(turn.turnEnds).toEqual(['interrupted']);
    turn.session.kill();
  });

  it('kills and resumes the session when the runner ignores the interrupt', async () => {
    const { runner, spawned } = harness([fixture('claude-code', 'task-interrupt')], 20);
    const turn = observe(await runner.spawn(options()));
    await firstTurn(spawned);

    await turn.session.interrupt();
    expect(turn.turnEnds).toEqual(['interrupted']);
    expect(spawned.processes).toHaveLength(2);
    expect(spawned.processes[0].killed).toBe(true);
    const args = spawned.lastArgs();
    expect(args[args.indexOf('--resume') + 1]).toBe('sess-task-interrupt');
    // The killed process was replaced, not lost: the task is still alive.
    await tick();
    expect(turn.exits).toEqual([]);
    turn.session.kill();
  });

  // The plan follows a /model switch (#106), so a process restarted for the
  // interrupt must run what the plan now says, not what the attempt started on.
  it('resumes on the model a /model switched to', async () => {
    const switchedTurnOpen = fixture('claude-code', 'task-model-switched').split('\n').filter((line) => line && (JSON.parse(line) as { type: string }).type !== 'result').join('\n') + '\n';
    const { runner, spawned } = harness([
      fixture('claude-code', 'task-model-before'), fixture('claude-code', 'task-model-command'), switchedTurnOpen,
    ], 20);
    const turn = observe(await runner.spawn(options({ modelId: 'haiku', mode: 'default' })));
    await turn.nextTurnEnd();
    turn.session.invokeCommand('model', 'sonnet');
    await turn.nextTurnEnd();
    turn.session.sendMessage('Reply with just the word two.');
    await until(() => turn.events.some((e) => e.type === 'model_switched'));

    await turn.session.interrupt();

    expect(spawned.processes).toHaveLength(2);
    const args = spawned.lastArgs();
    expect(args[args.indexOf('--model') + 1]).toBe('sonnet');
    turn.session.kill();
  });

  it('resumes the session it was continuing when interrupted before the runner took it up (ADR-0018, K1)', async () => {
    const { runner, spawned } = harness([() => {}], 20);
    const turn = observe(await runner.spawn(options({ resumeSessionId: 'sess-prev' })));
    await firstTurn(spawned);
    expect(turn.session.nativeSessionId()).toBeNull();

    await turn.session.interrupt();

    expect(spawned.processes).toHaveLength(2);
    const args = spawned.lastArgs();
    expect(args[args.indexOf('--resume') + 1]).toBe('sess-prev');
    turn.session.kill();
  });

  it('counts a continued session\'s cost on from what was counted before, and a restart from what was counted since', async () => {
    const counted = { sessionId: 'sess-prev', usd: 0.2, modelUsd: { 'claude-sonnet-5': 0.2 } };
    const firstReply = [
      { type: 'system', subtype: 'init', session_id: 'sess-prev', cwd: '/repo', model: 'claude-sonnet-5', permissionMode: 'acceptEdits' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Done.' }] } },
      { type: 'result', subtype: 'success', total_cost_usd: 0.5, modelUsage: { 'claude-sonnet-5': { costUSD: 0.5, contextWindow: 200_000 } } },
    ].map((line) => `${JSON.stringify(line)}\n`).join('');
    const { runner, spawned } = harness([firstReply, () => {}], 20);
    const turn = observe(await runner.spawn(options({ resumeSessionId: 'sess-prev', resumeCost: counted })));
    expect(turn.session.sessionCost?.()).toEqual(counted);
    await turn.nextTurnEnd();
    const usage = turn.events.flatMap((e) => (e.type === 'usage' && e.record.reportedCost ? [e.record.reportedCost.amount] : []));
    expect(usage).toHaveLength(1);
    expect(usage[0]).toBeCloseTo(0.3, 10);
    const grown = { sessionId: 'sess-prev', usd: 0.5, modelUsd: { 'claude-sonnet-5': 0.5 } };
    expect(turn.session.sessionCost?.()).toEqual(grown);

    turn.session.sendMessage('And one more thing.');
    await until(() => userTurns(spawned.processes[0].written).length > 1);
    await turn.session.interrupt();

    expect(spawned.processes).toHaveLength(2);
    expect(turn.session.sessionCost?.()).toEqual(grown);
    turn.session.kill();
  });

  it('does nothing when idle', async () => {
    const { runner, spawned } = harness([fixture('claude-code', 'task-no-marker')]);
    const turn = observe(await runner.spawn(options()));
    await turn.nextTurnEnd();
    await turn.session.interrupt();
    expect(afterAttachCheck(spawned.processes[0].written)).toHaveLength(1);
    expect(turn.turnEnds).toEqual(['completed']);
    turn.session.kill();
  });
});

/**
 * An attempt that is over stops its runner (ADR-0018, L1). Claude Code reports
 * its cost and its model's window only on a turn's `result` line, so a stop
 * ends the turn the way the runner reports its end and takes that line before
 * the process goes.
 */
describe('StructuredSession stop', () => {
  /** A recorded turn cut where its `task_complete` would land: its last call's usage and its `result` not yet sent. */
  const checkpointLines = fixture('claude-code', 'task-checkpoint').split('\n').filter(Boolean);
  const lastCall = checkpointLines.findIndex((line) => line.includes('"message_delta"'));
  const turnSoFar = `${checkpointLines.slice(0, lastCall).join('\n')}\n`;
  const turnRest = `${checkpointLines.slice(lastCall).join('\n')}\n`;
  const interruptAck = (written: string) => fixture('claude-code', 'task-interrupt-ack', { REQUEST_ID: (JSON.parse(written) as { request_id: string }).request_id }).split('\n')[0];

  it('interrupts a turn still open and takes its last usage and cost before the runner exits on its own', async () => {
    const { runner, spawned } = harness([turnSoFar, (written, proc) => proc.emitStdout(`${interruptAck(written)}\n${turnRest}`)]);
    const turn = observe(await runner.spawn(options()));
    await until(() => turn.chunks.join('').includes('ORDEWELL_CHECKPOINT'));

    const stopped = turn.session.stop();
    await until(() => spawned.processes[0].stdinEnded);

    const proc = spawned.processes[0];
    expect(JSON.parse(afterAttachCheck(proc.written)[1])).toMatchObject({ type: 'control_request', request: { subtype: 'interrupt' } });
    expect(turn.events.filter((e) => e.type === 'usage').map((e) => e.type === 'usage' && e.record)).toEqual([
      expect.objectContaining({ model: 'claude-haiku-4-5-20251001', outputTokens: 201 }),
      expect.objectContaining({ aggregate: true, reportedCost: { amount: 0.010310099999999999, currency: 'USD', kind: 'estimate', basis: 'list' } }),
      expect.objectContaining({ model: 'claude-haiku-4-5-20251001', contextWindow: 200000 }),
    ]);
    expect(turn.session.sessionCost?.()).toEqual({ sessionId: 'sess-task-checkpoint', usd: 0.010310099999999999, modelUsd: { 'claude-haiku-4-5-20251001': 0.010310099999999999 } });
    expect(turn.exits).toEqual([]);
    expect(proc.killed).toBe(false);

    proc.exit(0);
    await stopped;
    expect(turn.exits).toEqual([0]);
    expect(spawned.processes).toHaveLength(1);
    expect(runner.activeCount).toBe(0);
  });

  it('kills a runner that ignores the interrupt once the grace runs out, never restarting it, and keeps what it counted', async () => {
    const { runner, spawned } = harness([fixture('claude-code', 'task-checkpoint'), fixture('claude-code', 'task-interrupt')], 20);
    const turn = observe(await runner.spawn(options()));
    await turn.nextTurnEnd();
    turn.session.sendMessage('Carry on');
    await until(() => turn.events.filter((e) => e.type === 'turn_start').length === 2);

    await turn.session.stop();

    const proc = spawned.processes[0];
    expect(afterAttachCheck(proc.written).map((line) => JSON.parse(line) as { type: string }).at(-1)).toMatchObject({ type: 'control_request', request: { subtype: 'interrupt' } });
    expect(proc.stdinEnded).toBe(false);
    expect(proc.killed).toBe(true);
    expect(spawned.processes).toHaveLength(1);
    expect(turn.exits).toEqual([-1]);
    expect(turn.session.sessionCost?.()?.usd).toBe(0.010310099999999999);
  });

  it('ends the input of a runner between turns at once, and kills it when it does not exit within the grace', async () => {
    const { runner, spawned } = harness([fixture('claude-code', 'task-no-marker')], 20);
    const turn = observe(await runner.spawn(options()));
    await turn.nextTurnEnd();

    const stopped = turn.session.stop();
    const proc = spawned.processes[0];
    expect(proc.stdinEnded).toBe(true);
    expect(afterAttachCheck(proc.written)).toHaveLength(1);
    await stopped;
    expect(proc.killed).toBe(true);
    expect(turn.exits).toEqual([-1]);
  });

  it('lets an interrupted turn close before the runner is told nothing more is coming', async () => {
    const { runner, spawned } = harness([
      fixture('claude-code', 'task-interrupt'),
      (written, proc) => proc.emitStdout(fixture('claude-code', 'task-interrupt-ack', { REQUEST_ID: (JSON.parse(written) as { request_id: string }).request_id })),
    ]);
    const turn = observe(await runner.spawn(options()));
    await firstTurn(spawned);

    const stopped = turn.session.stop();
    const proc = spawned.processes[0];
    expect(proc.stdinEnded).toBe(false);
    await until(() => proc.stdinEnded);
    expect(turn.turnEnds).toEqual(['interrupted']);
    proc.exit(1);
    await stopped;
    expect(turn.exits).toEqual([1]);
  });

  it('sends a runner winding down nothing more, and a kill still ends it at once', async () => {
    const { runner, spawned } = harness([fixture('claude-code', 'task-interrupt')]);
    const turn = observe(await runner.spawn(options()));
    await firstTurn(spawned);
    const queuedId = turn.session.sendMessage('Queued before the stop');
    // A listener told of the undelivered message answers with another, inside the stop.
    let answerId = '';
    turn.session.onEvent((event) => {
      if (event.type === 'message_undelivered' && event.messageId === queuedId) answerId = turn.session.sendMessage('Then try this');
    });

    const stopped = turn.session.stop();
    const lateId = turn.session.sendMessage('Sent while it winds down');
    turn.session.forceSend('Forced while it winds down');

    expect(turn.session.stop()).toBe(stopped);
    expect(turn.events.filter((e) => e.type === 'message_undelivered').map((e) => e.type === 'message_undelivered' && e.messageId)).toEqual([queuedId, answerId, lateId, 'msg-4']);
    expect(turn.session.queued()).toEqual([]);
    turn.session.kill();
    await stopped;
    expect(turn.exits).toEqual([-1]);
    expect(userTurns(spawned.processes[0].written)).toEqual(['Do the task']);
    expect(spawned.processes).toHaveLength(1);
  });

  it('ends a runner that has no input to close as soon as its interrupted turn closed, after what it reported', async () => {
    const adapter = { interrupts: 0, disposed: false, turn: null as ((event: AgentEvent) => void) | null };
    const createAdapter = (): TaskModeAgentAdapter => ({
      agentId: 'codex',
      exited: false,
      start: async () => {},
      send: (_message, onEvent) => new Promise<void>((resolve) => {
        adapter.turn = (event) => {
          onEvent(event);
          if (event.type === 'turn_end') resolve();
        };
      }),
      nativeSessionId: () => 'thread-1',
      dispose: () => { adapter.disposed = true; },
      interrupt: async () => {
        adapter.interrupts += 1;
        setTimeout(() => {
          adapter.turn?.({ type: 'usage', record: { source: 'codex', model: 'gpt-5.5', inputTokens: 1200, outputTokens: 40 } });
          adapter.turn?.({ type: 'turn_end', interrupted: true });
        }, 5);
        return true;
      },
      onProcessExit: () => {},
      answerPermission: () => false,
      mcpAttached: async () => true,
    });
    const mcp = { issueTaskToken: async () => ({ url: 'http://127.0.0.1:1/mcp', token: 'tok-1' }), revoke: () => {} } as unknown as OrdewellMcpServer;
    const runner = new StructuredRunner({ createAdapter, mcp });
    const turn = observe(await runner.spawn(options({ runner: 'codex' })));
    await until(() => adapter.turn !== null);

    await turn.session.stop();

    expect(adapter.interrupts).toBe(1);
    expect(turn.events.filter((e) => e.type === 'usage')).toEqual([{ type: 'usage', record: { source: 'codex', model: 'gpt-5.5', inputTokens: 1200, outputTokens: 40 } }]);
    expect(turn.turnEnds).toEqual(['interrupted']);
    expect(adapter.disposed).toBe(true);
    expect(turn.exits).toEqual([-1]);
  });
});

describe('StructuredSession exit', () => {
  it('fires onExit exactly once on kill', async () => {
    const { runner, spawned } = harness([() => {}]);
    const turn = observe(await runner.spawn(options()));
    turn.session.kill();
    turn.session.kill();
    await tick();
    expect(spawned.processes[0].killed).toBe(true);
    expect(turn.exits).toEqual([-1]);
    expect(runner.activeCount).toBe(0);
  });

  it('fires onExit exactly once when the runner dies on its own', async () => {
    const { runner, spawned } = harness([() => {}]);
    const turn = observe(await runner.spawn(options()));
    await firstTurn(spawned);
    spawned.processes[0].emitStderr('fatal: out of credits');
    spawned.processes[0].exit(1);
    await tick();
    turn.session.kill();
    expect(turn.exits).toEqual([1]);
    expect(turn.turnEnds).toEqual(['failed']);
    expect(turn.session.getOutput()).toContain('fatal: out of credits');
  });
});

describe('StructuredRunner: tools or nothing (ADR-0022)', () => {
  /** One fake process per spawn, its attach report scripted; the server records what it issued and took back. */
  /** A report of `'never'` is a check still waiting on the runner when the test acts. */
  function attaching(reports: Array<boolean | 'never'>, { issueFails = 0 }: { issueFails?: number } = {}) {
    const adapters: Array<{ sent: string[]; disposed: boolean; checking: boolean; mcp?: TaskStartOptions['mcp'] }> = [];
    const issued: string[] = [];
    const revoked: string[] = [];
    let failures = issueFails;
    const server = {
      issueTaskToken: async () => {
        if (failures > 0) {
          failures -= 1;
          throw new Error('listen EADDRINUSE');
        }
        const token = `tok-${issued.length + 1}`;
        issued.push(token);
        return { url: 'http://127.0.0.1:1/mcp', token };
      },
      revoke: (token: string) => { revoked.push(token); },
    } as unknown as OrdewellMcpServer;
    const createAdapter = (): TaskModeAgentAdapter => {
      const record: (typeof adapters)[number] = { sent: [], disposed: false, checking: false };
      const attached = reports[adapters.length] ?? false;
      adapters.push(record);
      return {
        agentId: 'claude-code',
        exited: false,
        start: async (opts) => { if (opts.kind === 'task') record.mcp = opts.mcp; },
        send: async (message) => { record.sent.push(message); },
        nativeSessionId: () => null,
        dispose: () => { record.disposed = true; },
        interrupt: async () => true,
        onProcessExit: () => {},
        answerPermission: () => false,
        mcpAttached: () => {
          record.checking = true;
          return attached === 'never' ? new Promise<boolean>(() => {}) : Promise.resolve(attached);
        },
      };
    };
    const notices: string[] = [];
    const runner = new StructuredRunner({ createAdapter, mcp: server });
    const spawn = () => runner.spawn(options({ onNotice: (message) => notices.push(message) }));
    return { runner, spawn, adapters, issued, revoked, notices };
  }

  it("serves a read-only attempt's run_command from its shell, and no other attempt's (ADR-0046)", async () => {
    const issued: Array<{ scope: TaskTokenScope; handler: TaskToolHandler }> = [];
    const server = {
      issueTaskToken: async (scope: TaskTokenScope, handler: TaskToolHandler) => {
        issued.push({ scope, handler });
        return { url: 'http://127.0.0.1:1/mcp', token: `tok-${issued.length}`, ...(scope.readOnly ? { readOnly: true as const } : {}) };
      },
      revoke: () => {},
    } as unknown as OrdewellMcpServer;
    const started: Array<TaskStartOptions['mcp']> = [];
    const createAdapter = (): TaskModeAgentAdapter => ({
      agentId: 'claude-code',
      exited: false,
      start: async (opts) => { if (opts.kind === 'task') started.push(opts.mcp); },
      send: async () => {},
      nativeSessionId: () => null,
      dispose: () => {},
      interrupt: async () => true,
      onProcessExit: () => {},
      answerPermission: () => false,
      mcpAttached: async () => true,
    });
    const ran: Array<{ command: string; aborted: boolean | undefined }> = [];
    const shell = {
      run: async (command: string, signal?: AbortSignal) => {
        ran.push({ command, aborted: signal?.aborted });
        return { success: false, output: 'Command exited 1:\nFAIL cache.test.ts', truncated: false };
      },
      end: () => {},
    };
    const runner = new StructuredRunner({ createAdapter, mcp: server });

    const readOnly = await runner.spawn(options({ shell }));
    const change = await runner.spawn(options({ taskId: 'task-2' }));

    expect(issued.map((i) => i.scope.readOnly)).toEqual([true, undefined]);
    expect(started.map((mcp) => mcp?.readOnly)).toEqual([true, undefined]);
    expect(issued[1].handler.runCommand).toBeUndefined();
    const reply = await issued[0].handler.runCommand!({ command: 'npm test' }, { signal: new AbortController().signal });
    expect(reply).toEqual({ text: 'Command exited 1:\nFAIL cache.test.ts', isError: true });
    expect(ran).toEqual([{ command: 'npm test', aborted: false }]);
    readOnly.kill();
    change.kill();
  });

  it('sends the prompt to the first process when the runner reports the server connected', async () => {
    const env = attaching([true]);
    const session = await env.spawn();
    await until(() => env.adapters[0].sent.length > 0);

    expect(env.adapters).toHaveLength(1);
    expect(env.adapters[0].mcp?.headers.Authorization).toContain('tok-1');
    expect(env.adapters[0].sent).toEqual(['Do the task']);
    expect(env.notices).toEqual([]);
    session.kill();
  });

  it('kills a process that did not attach and respawns once, on a fresh token, saying so', async () => {
    const env = attaching([false, true]);
    const session = await env.spawn();
    await until(() => env.adapters[1]?.sent.length > 0);

    expect(env.adapters).toHaveLength(2);
    expect(env.adapters[0]).toMatchObject({ disposed: true, sent: [] });
    expect(env.revoked).toContain('tok-1');
    expect(env.adapters[1].mcp?.headers.Authorization).toContain('tok-2');
    expect(env.adapters[1].sent).toEqual(['Do the task']);
    expect(env.runner.activeCount).toBe(1);
    expect(env.notices).toHaveLength(1);
    expect(env.notices[0]).toContain('claude-code started without Ordewell\'s tools');
    expect(env.notices[0]).toContain('did not report Ordewell\'s MCP server connected');
    session.kill();
  });

  it('respawns once when the server could not issue a token', async () => {
    const env = attaching([true], { issueFails: 1 });
    const session = await env.spawn();
    await until(() => env.adapters[0]?.sent.length > 0);

    expect(env.adapters).toHaveLength(1);
    expect(env.notices[0]).toContain('could not issue a token (listen EADDRINUSE)');
    session.kill();
  });

  // Stop is not a request to finish attaching first: the session already
  // reports its exit, so the process it was starting goes with it, at once.
  it('takes back a process still checking its attach state the moment the session is stopped', async () => {
    const env = attaching(['never']);
    const spawned = env.spawn();
    await until(() => env.adapters[0]?.checking === true);

    env.runner.stopAll();

    expect(env.adapters[0].disposed).toBe(true);
    expect(env.revoked).toEqual(['tok-1']);
    await spawned;
    expect(env.adapters).toHaveLength(1);
    expect(env.adapters[0].sent).toEqual([]);
  });

  it('reports a timeout when the respawn does not attach either, with nothing sent and nothing left running', async () => {
    const env = attaching([false, false]);

    const spawned = env.spawn();
    await expect(spawned).rejects.toBeInstanceOf(McpAttachTimeout);
    await expect(spawned).rejects.toThrow(
      'Could not start claude-code with Ordewell\'s tools, so the task was not sent to it. First spawn: claude-code did not report Ordewell\'s MCP server connected. Respawn: claude-code did not report Ordewell\'s MCP server connected.',
    );
    await tick();

    expect(env.adapters).toHaveLength(2);
    expect(env.adapters.every((a) => a.disposed && a.sent.length === 0)).toBe(true);
    expect(env.revoked).toEqual(['tok-1', 'tok-2']);
    expect(env.runner.activeCount).toBe(0);
    expect(env.notices).toHaveLength(1);
  });
});

describe('StructuredRunner: a runner that exits while it starts', () => {
  // Recorded from `claude` 2.1.296: a resume it cannot find is refused on
  // stderr and the process exits 1, before it answers the attach check.
  it('fails the start in the runner\'s own words, without a respawn on the same arguments', async () => {
    const spawned = fakeSpawn([]);
    const spawn: SpawnFn = (command, args, spawnOptions) => {
      const child = spawned.spawn(command, args, spawnOptions);
      const proc = spawned.processes.at(-1)!;
      queueMicrotask(() => {
        proc.emitStderr('No conversation found with session ID: 0d6c1a52-3b7e-4f7e-9d1a-5b0c2e4f8a11\n');
        proc.exit(1);
      });
      return child;
    };
    const runner = new StructuredRunner({
      process: { spawn, resolvePath: async () => '/usr/bin', platform: 'linux', isDirectory: () => true, exists: () => true },
      createAdapter: claudeTurnEndQueue,
    });

    await expect(runner.spawn(options({ resumeSessionId: '0d6c1a52-3b7e-4f7e-9d1a-5b0c2e4f8a11' })))
      .rejects.toThrow('No conversation found with session ID: 0d6c1a52-3b7e-4f7e-9d1a-5b0c2e4f8a11');
    expect(spawned.processes).toHaveLength(1);
    expect(runner.activeCount).toBe(0);
  });
});
