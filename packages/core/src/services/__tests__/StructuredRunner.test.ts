import { describe, it, expect } from 'vitest';
import { StructuredRunner } from '../StructuredRunner';
import type { RunnerSpawnOptions } from '../AbstractRunner';
import { RunnerRegistry } from '../../plugins/RunnerRegistry';
import type { IRunnerSession, StructuredEvent, StructuredTurnEnd } from '../../interfaces/IRunner';
import type { AgentEvent, SpawnFn, AgentStartOptions, TaskModeAgentAdapter, TaskStartOptions } from '../harness/AgentAdapter';
import type { OrdewellMcpServer } from '../mcp/OrdewellMcpServer';
import { ClaudeCodeAdapter } from '../harness/ClaudeCodeAdapter';
import { claudeTurnEndQueue, fakeSpawn, fixture, type FakeSpawnResult, type ScriptedReply } from './harnessTestKit';

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
  const nextTurnEnd = () => new Promise<void>((resolve) => { waiters.push(resolve); });
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

/** What the session wrote to the runner after the attach check every spawn opens with. */
function afterAttachCheck(written: string[]): string[] {
  return written.filter((line) => !line.includes('"subtype":"mcp_status"'));
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
    ['plan', 'plan'],
    ['bypassPermissions', 'bypassPermissions'],
    // The legacy alias resolves through the manifest, as a terminal task's does.
    ['build', 'acceptEdits'],
  ])('runs mode %s under --permission-mode %s', async (mode, expected) => {
    const { runner, spawned } = harness([]);
    const session = await runner.spawn(options({ mode }));
    const args = spawned.lastArgs();
    expect(args[args.indexOf('--permission-mode') + 1]).toBe(expected);
    // Only the question tool: a task keeps every other tool its mode allows.
    expect(args[args.indexOf('--disallowedTools') + 1]).toBe('AskUserQuestion');
    expect(args).not.toContain('--append-system-prompt');
    expect(args).not.toContain('--dangerously-skip-permissions');
    session.kill();
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
      '--mcp-config', expect.stringMatching(/mcp\.json$/),
      '--allowedTools', 'mcp__ordewell__task_complete,mcp__ordewell__checkpoint',
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
    const to = args.indexOf(modelId ? '--model' : '--mcp-config');
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
    // Recorded under plan mode, which the adapter holds the CLI to.
    const { runner } = harness([fixture('claude-code', 'stream-subagent')]);
    const turn = observe(await runner.spawn(options({ mode: 'plan' })));
    await turn.nextTurnEnd();
    const output = turn.session.getOutput();
    expect(output).toContain('› Agent(Read README first line)');
    expect(output).not.toContain('› Read(');
    expect(output).toContain('The first line of README.md is `hello`.');
    expect(turn.events.some((e) => e.type === 'tool_call' && e.name === 'Read' && e.subagentId)).toBe(true);
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

  it('shows a request the task\'s mode already answered as asked and decided, with nothing left open', async () => {
    const answered: string[] = [];
    const decided: AgentEvent = { type: 'permission_request', id: 'per_1', name: 'bash', detail: '{}', decided: { decision: 'allow' } };
    const adapter: TaskModeAgentAdapter = {
      agentId: 'opencode',
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
    expect(turn.statesAtTurnEnd).toEqual(['working']);
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

  it('ignores a blank write', async () => {
    const { runner } = harness([() => {}]);
    const turn = observe(await runner.spawn(options()));
    turn.session.write(' \r\n');
    expect(turn.session.queued()).toEqual([]);
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
  function attaching(reports: boolean[], { issueFails = 0 }: { issueFails?: number } = {}) {
    const adapters: Array<{ sent: string[]; disposed: boolean; mcp?: TaskStartOptions['mcp'] }> = [];
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
      const record: (typeof adapters)[number] = { sent: [], disposed: false };
      const attached = reports[adapters.length] ?? false;
      adapters.push(record);
      return {
        agentId: 'claude-code',
        start: async (opts) => { if (opts.kind === 'task') record.mcp = opts.mcp; },
        send: async (message) => { record.sent.push(message); },
        nativeSessionId: () => null,
        dispose: () => { record.disposed = true; },
        interrupt: async () => true,
        onProcessExit: () => {},
        answerPermission: () => false,
        mcpAttached: async () => attached,
      };
    };
    const notices: string[] = [];
    const runner = new StructuredRunner({ createAdapter, mcp: server });
    const spawn = () => runner.spawn(options({ onNotice: (message) => notices.push(message) }));
    return { runner, spawn, adapters, issued, revoked, notices };
  }

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

  it('fails the start when the respawn does not attach either, with nothing sent and nothing left running', async () => {
    const env = attaching([false, false]);

    await expect(env.spawn()).rejects.toThrow(
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
