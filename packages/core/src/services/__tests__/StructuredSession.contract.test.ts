import { describe, it, expect, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StructuredRunner } from '../StructuredRunner';
import { VerdictEngine } from '../VerdictEngine';
import { createTask, type Verdict } from '../../models/Task';
import type { RunnerSpawnOptions } from '../AbstractRunner';
import { RunnerRegistry } from '../../plugins/RunnerRegistry';
import { isStructuredSession, type ITerminalSession, type StructuredEvent, type StructuredTurnEnd } from '../../interfaces/ITerminalRunner';
import type { AgentEvent, AgentProcessDeps, AgentStartOptions, TaskModeAgentAdapter } from '../harness/AgentAdapter';
import type { ApprovalDecision } from '../../interfaces/IApproval';
import { FakeStructuredSession, FakeTerminalSession } from '../../testing';
import { OrdewellMcpServer, type CheckpointAnswer, type McpClientConfig } from '../mcp';
import { claudeSteerRecording, fakeSpawn, fixture, sseResponse, type FakeAgentProcess, type FakeEventStream, type ScriptedReply } from './harnessTestKit';

/**
 * The `ITerminalSession` contract a structured task keeps (ADR-0018, O1a/S2):
 * what `onOutput` carries, where the done marker lands, and how the session
 * behaves when its runner fails, is killed mid-start or ignores an interrupt.
 *
 * Recorded transcripts drive the real Claude Code adapter where one exists;
 * {@link HandAdapter} covers the splits, orderings and failures no recording
 * pins down, and never stands in for the adapter's own parsing.
 */

type Turn = { onEvent: (event: AgentEvent) => void; resolve: () => void; reject: (err: Error) => void };

/** A task adapter driven by hand: each `send` stays open until the test ends it. */
class HandAdapter implements TaskModeAgentAdapter {
  readonly agentId = 'claude-code';
  readonly starts: AgentStartOptions[] = [];
  readonly sent: string[] = [];
  readonly aborted: string[] = [];
  disposed = 0;
  interrupts = 0;
  /** `ack` acknowledges and closes the turn; `ack-hold` acknowledges but never closes it; `ignore` never answers. */
  interruptAnswer: 'ack' | 'ack-hold' | 'ignore' = 'ack';
  permissionAnswer = true;
  startGate: Promise<void> = Promise.resolve();
  startError: Error | null = null;
  sessionId: string | null = null;
  private turn: Turn | null = null;
  private readonly exitListeners: Array<(code: number) => void> = [];

  async start(opts: AgentStartOptions): Promise<void> {
    this.starts.push(opts);
    await this.startGate;
    if (this.startError) throw this.startError;
  }

  send(message: string, onEvent: (event: AgentEvent) => void, signal?: AbortSignal): Promise<void> {
    this.sent.push(message);
    signal?.addEventListener('abort', () => this.aborted.push(message));
    return new Promise<void>((resolve, reject) => { this.turn = { onEvent, resolve, reject }; });
  }

  emit(...events: AgentEvent[]): void {
    for (const event of events) this.turn?.onEvent(event);
  }

  /** The runner closes the turn the way Claude Code does, with a `turn_end`. */
  endTurn(interrupted = false): void {
    const turn = this.turn;
    this.turn = null;
    turn?.onEvent(interrupted ? { type: 'turn_end', interrupted: true } : { type: 'turn_end' });
    turn?.resolve();
  }

  /** The turn settles with no `turn_end` — how a turn that reported an `error` ends. */
  settle(): void {
    const turn = this.turn;
    this.turn = null;
    turn?.resolve();
  }

  /** The transport itself failed: `send` rejects. */
  failTurn(err: Error): void {
    const turn = this.turn;
    this.turn = null;
    turn?.reject(err);
  }

  async interrupt(): Promise<boolean> {
    this.interrupts += 1;
    if (this.interruptAnswer === 'ignore') return false;
    if (this.interruptAnswer === 'ack') queueMicrotask(() => this.endTurn(true));
    return true;
  }

  onProcessExit(listener: (code: number) => void): void { this.exitListeners.push(listener); }
  exit(code: number): void { for (const listener of this.exitListeners.splice(0)) listener(code); }
  answerPermission(_id: string, _decision: ApprovalDecision): boolean { return this.permissionAnswer; }
  nativeSessionId(): string | null { return this.sessionId; }
  dispose(): void { this.disposed += 1; }
}

const registry = new RunnerRegistry();

function options(overrides: Partial<RunnerSpawnOptions> = {}): RunnerSpawnOptions {
  return { taskId: 'task-0001-abcdef', runner: 'claude-code', prompt: 'Do the task', modelId: 'sonnet', mode: 'acceptEdits', cwd: '/repo', registry, ...overrides };
}

/** A runner whose every spawn or restart builds a fresh {@link HandAdapter}, set up by `configure`. */
function byHand(configure: (adapter: HandAdapter, index: number) => void = () => {}, interruptGraceMs = 20) {
  const adapters: HandAdapter[] = [];
  const runner = new StructuredRunner({
    createAdapter: () => {
      const adapter = new HandAdapter();
      configure(adapter, adapters.length);
      adapters.push(adapter);
      return adapter;
    },
    interruptGraceMs,
  });
  return { runner, adapters };
}

/** The real Claude Code adapter over a fake process. */
function recorded(replies: ScriptedReply[]) {
  const spawned = fakeSpawn(replies);
  const runner = new StructuredRunner({
    process: { spawn: spawned.spawn, resolvePath: async () => '/usr/bin', platform: 'linux', isDirectory: () => true, exists: () => true },
  });
  return { runner, spawned };
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !condition(); i++) await tick();
  if (!condition()) throw new Error('condition never held');
}

function observe(session: ITerminalSession) {
  if (!isStructuredSession(session)) throw new Error('not a structured session');
  const chunks: string[] = [];
  const events: StructuredEvent[] = [];
  const turnEnds: StructuredTurnEnd[] = [];
  const exits: number[] = [];
  session.onOutput((text) => chunks.push(text));
  session.onEvent((event) => events.push(event));
  session.onTurnEnd((reason) => turnEnds.push(reason));
  session.onExit((code) => exits.push(code));
  return { session, chunks, events, turnEnds, exits };
}

const MARKER = '<<<ORDEWELL_DONE_mk-1>>>';

describe('onOutput over every recorded task transcript', () => {
  it.each(['task-marker', 'task-checkpoint', 'task-no-marker', 'stream-subagent', 'stream-tool-rounds', 'stream-reasoning'])(
    '%s: the agent\'s text and one plain line per call — no ANSI, no JSON',
    async (name) => {
      const { runner } = recorded([fixture('claude-code', name)]);
      const turn = observe(await runner.spawn(options()));
      await until(() => turn.turnEnds.length === 1);
      const output = turn.session.getOutput();
      const lines = output.split('\n').filter(Boolean);

      expect(output).not.toContain('\u001b');
      for (const line of lines) {
        expect(line).not.toMatch(/^\s*[[{]"/);
        expect(line).not.toContain('"type":');
      }
      const calls = turn.events.filter((e) => e.type === 'tool_call' && !e.subagentId);
      expect(lines.filter((line) => line.startsWith('› '))).toHaveLength(calls.length);
      for (const text of turn.events.flatMap((e) => (e.type === 'assistant_text' ? [e.text] : []))) {
        expect(output).toContain(text);
      }
      expect(turn.chunks.join('')).toBe(output);
      turn.session.kill();
    },
  );

  it.each([1, 7, 64, 4096])('writes the marker whole when the recording reaches stdout %i characters at a time', async (size) => {
    const recording = fixture('claude-code', 'task-marker');
    const { runner } = recorded([(_written, proc) => {
      for (let i = 0; i < recording.length; i += size) proc.emitStdout(recording.slice(i, i + size));
    }]);
    const turn = observe(await runner.spawn(options()));
    await until(() => turn.turnEnds.length === 1);

    expect(turn.chunks.some((chunk) => chunk.includes('<<<ORDEWELL_DONE_test-1234>>>'))).toBe(true);
    expect(turn.session.getOutput()).toBe('› Bash(cat README.md)\n<<<ORDEWELL_DONE_test-1234>>>\n');
    turn.session.kill();
  });
});

describe('the done marker on the plain-text channel', () => {
  it('is written whole wherever its streamed deltas are cut, turn after turn', async () => {
    const { runner, adapters } = byHand();
    const turn = observe(await runner.spawn(options()));
    const [adapter] = adapters;
    const cuts: Array<[number, number]> = [];
    for (let i = 1; i < MARKER.length; i++) for (let j = i; j < MARKER.length; j++) cuts.push([i, j]);

    for (const [n, [i, j]] of cuts.entries()) {
      await until(() => adapter.sent.length === n + 1);
      const from = turn.chunks.length;
      adapter.emit(
        { type: 'assistant_text_delta', text: `Checked.\nAll done: ${MARKER.slice(0, i)}` },
        { type: 'assistant_text_delta', text: MARKER.slice(i, j) },
        { type: 'assistant_text_delta', text: `${MARKER.slice(j)}\nBye.` },
        { type: 'assistant_text', text: `Checked.\nAll done: ${MARKER}\nBye.` },
      );
      adapter.endTurn();
      await until(() => turn.turnEnds.length === n + 1);
      const written = turn.chunks.slice(from);
      expect(written.some((chunk) => chunk.includes(MARKER)), `cut at ${i}/${j}`).toBe(true);
      expect(written.join('')).toBe(`Checked.\nAll done: ${MARKER}\nBye.\n`);
      turn.session.sendMessage('again');
    }
    turn.session.kill();
  });

  it('is written whole when the turn ends on it with no authoritative block and no newline', async () => {
    const { runner, adapters } = byHand();
    const turn = observe(await runner.spawn(options()));
    await until(() => adapters[0].sent.length === 1);

    adapters[0].emit(
      { type: 'assistant_text_delta', text: '<<<ORDEWELL' },
      { type: 'assistant_text_delta', text: '_DONE_' },
      { type: 'assistant_text_delta', text: 'mk-1>>>' },
    );
    expect(turn.chunks).toEqual([]);
    adapters[0].endTurn();
    await until(() => turn.turnEnds.length === 1);

    expect(turn.chunks).toEqual([MARKER, '\n']);
    turn.session.kill();
  });
});

describe('what else the plain-text channel carries', () => {
  async function oneTurn(events: AgentEvent[], close: (adapter: HandAdapter) => void = (a) => a.endTurn()) {
    const { runner, adapters } = byHand();
    const turn = observe(await runner.spawn(options()));
    await until(() => adapters[0].sent.length === 1);
    adapters[0].emit(...events);
    close(adapters[0]);
    await until(() => turn.turnEnds.length === 1);
    return turn;
  }

  it('draws each call as one line: its key argument collapsed onto it, cut at 120 characters, subagent calls left out', async () => {
    const turn = await oneTurn([
      { type: 'assistant_text_delta', text: 'Let me check' },
      { type: 'tool_call', id: 'c1', name: 'Bash', args: { command: 'npm test\n   && npm run lint', description: 'Run the checks' } },
      { type: 'tool_call', id: 'c2', name: 'Grep', args: { pattern: 'x'.repeat(200) } },
      { type: 'tool_call', id: 'c3', name: 'TodoWrite', args: { todos: [] } },
      { type: 'tool_call', id: 'c4', name: 'Read', args: { file_path: '/repo/a.ts' }, subagentId: 'sub-1' },
      { type: 'tool_call', id: 'c5', name: 'mcp__linear__get_issue', args: { issue: 'ENG-1', description: 'Look it up' } },
    ]);

    expect(turn.session.getOutput()).toBe([
      'Let me check',
      '› Bash(npm test && npm run lint)',
      `› Grep(${'x'.repeat(120)}…)`,
      '› TodoWrite',
      '› mcp__linear__get_issue(Look it up)',
      '',
    ].join('\n'));
  });

  it('keeps the text it already wrote when the authoritative block disagrees, and writes the block too', async () => {
    const turn = await oneTurn([
      { type: 'assistant_text_delta', text: 'First draft.\n' },
      { type: 'assistant_text', text: 'Second thoughts.' },
    ]);
    expect(turn.session.getOutput()).toBe('First draft.\nSecond thoughts.\n');
  });

  it('writes nothing twice when the block repeats what its deltas streamed', async () => {
    const turn = await oneTurn([
      { type: 'assistant_text_delta', text: 'One line.\nTwo' },
      { type: 'assistant_text_delta', text: ' lines.' },
      { type: 'assistant_text', text: 'One line.\nTwo lines.' },
    ]);
    expect(turn.session.getOutput()).toBe('One line.\nTwo lines.\n');
  });

  it('writes a failed turn\'s own words on a line of their own, and the turn ends failed', async () => {
    const turn = await oneTurn([
      { type: 'assistant_text_delta', text: 'Half a sen' },
      { type: 'error', message: 'API Error: 529 overloaded' },
    ], (adapter) => adapter.settle());

    expect(turn.session.getOutput()).toBe('Half a sen\nAPI Error: 529 overloaded\n');
    expect(turn.turnEnds).toEqual(['failed']);
    expect(turn.session.turnState()).toBe('idle');
  });

  it('reports a transport that failed mid-turn as a failed turn, in its own words, and keeps the session', async () => {
    const turn = await oneTurn([], (adapter) => adapter.failTurn(new Error('write EPIPE')));

    expect(turn.session.getOutput()).toBe('write EPIPE\n');
    expect(turn.turnEnds).toEqual(['failed']);
    expect(turn.events).toContainEqual({ type: 'error', message: 'write EPIPE' });
    expect(turn.exits).toEqual([]);
    turn.session.kill();
  });
});

describe('starting and stopping the runner', () => {
  it('refuses a runner with no registered manifest, before building an adapter', async () => {
    const { runner, adapters } = byHand();
    await expect(runner.spawn(options({ registry: undefined }))).rejects.toThrow('No runner manifest is registered for "claude-code".');
    expect(adapters).toHaveLength(0);
  });

  it('lets go of a session whose runner could not start', async () => {
    const { runner } = byHand((adapter) => { adapter.startError = new Error('claude: command not found'); });
    await expect(runner.spawn(options())).rejects.toThrow('claude: command not found');
    expect(runner.activeCount).toBe(0);
  });

  it('disposes a runner that finishes starting after its task was stopped, and never sends it the prompt', async () => {
    let release = () => {};
    const { runner, adapters } = byHand((adapter) => { adapter.startGate = new Promise<void>((resolve) => { release = resolve; }); });
    const spawning = runner.spawn(options());
    await until(() => adapters.length === 1);

    runner.stopAll();
    expect(adapters[0].disposed).toBe(0);
    release();
    const session = await spawning;
    await tick();

    expect(adapters[0].disposed).toBe(1);
    expect(adapters[0].sent).toEqual([]);
    expect(runner.activeCount).toBe(0);
    session.kill();
    expect(adapters[0].disposed).toBe(1);
  });

  it('queues a message sent before the first turn has gone out behind the prompt', async () => {
    const { runner, adapters } = byHand();
    const turn = observe(await runner.spawn(options()));
    turn.session.sendMessage('and add tests');
    await until(() => adapters[0].sent.length === 1);
    expect(adapters[0].sent).toEqual(['Do the task']);

    adapters[0].endTurn();
    await until(() => adapters[0].sent.length === 2);
    expect(adapters[0].sent).toEqual(['Do the task', 'and add tests']);
    turn.session.kill();
  });

  it('delivers queued messages oldest first, one per turn, each naming the message it was', async () => {
    const { runner, adapters } = byHand();
    const turn = observe(await runner.spawn(options()));
    await until(() => adapters[0].sent.length === 1);
    const first = turn.session.sendMessage('one');
    const second = turn.session.sendMessage('two');

    adapters[0].endTurn();
    await until(() => adapters[0].sent.length === 2);
    adapters[0].endTurn();
    await until(() => adapters[0].sent.length === 3);

    expect(adapters[0].sent).toEqual(['Do the task', 'one', 'two']);
    expect(turn.events.filter((e) => e.type === 'turn_start')).toEqual([
      { type: 'turn_start', text: 'Do the task' },
      { type: 'turn_start', text: 'one', messageId: first },
      { type: 'turn_start', text: 'two', messageId: second },
    ]);
    turn.session.kill();
  });

  it('delivers nothing more once the runner has gone, and reports the exit once', async () => {
    const { runner, adapters } = byHand();
    const turn = observe(await runner.spawn(options()));
    await until(() => adapters[0].sent.length === 1);
    turn.session.sendMessage('never read');

    adapters[0].exit(1);
    adapters[0].failTurn(new Error('claude exited with code 1'));
    await until(() => turn.turnEnds.length === 1);

    expect(adapters[0].sent).toEqual(['Do the task']);
    expect(turn.exits).toEqual([1]);
    expect(runner.activeCount).toBe(0);
  });
});

describe('interrupting a turn', () => {
  it('asks the runner once however many times it is asked', async () => {
    const { runner, adapters } = byHand();
    const turn = observe(await runner.spawn(options()));
    await until(() => adapters[0].sent.length === 1);

    await Promise.all([turn.session.interrupt(), turn.session.interrupt(), turn.session.interrupt()]);

    expect(adapters[0].interrupts).toBe(1);
    expect(turn.turnEnds).toEqual(['interrupted']);
    turn.session.kill();
  });

  it('kills and resumes a runner that acknowledged but never closed the turn, in the session it announced', async () => {
    const { runner, adapters } = byHand((adapter, index) => {
      adapter.interruptAnswer = 'ack-hold';
      if (index === 0) adapter.sessionId = 'sess-1';
    });
    const turn = observe(await runner.spawn(options({ thinkingEffort: 'high' })));
    await until(() => adapters[0].sent.length === 1);

    await turn.session.interrupt();

    expect(turn.turnEnds).toEqual(['interrupted']);
    expect(adapters[0].aborted).toEqual(['Do the task']);
    expect(adapters).toHaveLength(2);
    expect(adapters[1].starts[0]).toMatchObject({
      kind: 'task', cwd: '/repo', mode: 'acceptEdits', model: 'sonnet', resumeSessionId: 'sess-1',
      flags: { permissionMode: 'acceptEdits', effort: 'high', modeSettings: {} },
    });
    expect(turn.session.turnState()).toBe('idle');
    expect(turn.exits).toEqual([]);

    // The replaced runner is not heard from again, whatever it still says.
    adapters[0].emit({ type: 'assistant_text', text: 'stale words' });
    adapters[0].exit(137);
    await tick();
    expect(turn.session.getOutput()).not.toContain('stale words');
    expect(turn.exits).toEqual([]);

    turn.session.sendMessage('carry on');
    expect(adapters[1].sent).toEqual(['carry on']);
    turn.session.kill();
  });

  it('ends the task when the runner cannot be restarted after an ignored interrupt, saying why', async () => {
    const { runner, adapters } = byHand((adapter, index) => {
      adapter.interruptAnswer = 'ignore';
      if (index === 1) adapter.startError = new Error('spawn EAGAIN');
    });
    const turn = observe(await runner.spawn(options()));
    await until(() => adapters[0].sent.length === 1);

    await turn.session.interrupt();

    expect(turn.turnEnds).toEqual(['interrupted']);
    expect(turn.session.getOutput()).toBe('Could not restart claude-code after the interrupt: spawn EAGAIN\n');
    expect(turn.exits).toEqual([-1]);
    expect(runner.activeCount).toBe(0);
  });
});

describe('answering a runner\'s request', () => {
  it('withdraws a request the runner will no longer take an answer for', async () => {
    const { runner, adapters } = byHand((adapter) => { adapter.permissionAnswer = false; });
    const turn = observe(await runner.spawn(options({ mode: 'default' })));
    await until(() => adapters[0].sent.length === 1);
    adapters[0].emit({ type: 'permission_request', id: 'req-1', name: 'Write', detail: '{}' });
    const id = `${turn.session.id}-perm-1`;

    expect(turn.session.answerPermission(id, { decision: 'allow' })).toBe(false);
    expect(turn.events).toContainEqual({ type: 'permission_withdrawn', id });
    expect(turn.events.some((e) => e.type === 'permission_decided')).toBe(false);
    expect(turn.session.answerPermission(id, { decision: 'allow' })).toBe(false);
    turn.session.kill();
  });

  it('ignores the runner cancelling a request it never made', async () => {
    const { runner, adapters } = byHand();
    const turn = observe(await runner.spawn(options({ mode: 'default' })));
    await until(() => adapters[0].sent.length === 1);
    adapters[0].emit({ type: 'permission_cancelled', id: 'never-asked' });
    expect(turn.events.some((e) => e.type === 'permission_withdrawn')).toBe(false);
    turn.session.kill();
  });
});

describe('the structured capability is detected, never assumed', () => {
  it('is present on a structured session and absent from a plain one', async () => {
    const { runner } = byHand();
    const session = await runner.spawn(options());
    expect(isStructuredSession(session)).toBe(true);
    expect(isStructuredSession(new FakeStructuredSession())).toBe(true);
    expect(isStructuredSession(new FakeTerminalSession('s1', 't1'))).toBe(false);
    session.kill();
  });
});

describe('the Ordewell task tools (ADR-0022)', () => {
  const servers: OrdewellMcpServer[] = [];
  const clients: Client[] = [];

  afterEach(async () => {
    await Promise.all(clients.splice(0).map((c) => c.close()));
    await Promise.all(servers.splice(0).map((s) => s.dispose()));
  });

  /** {@link byHand}, with a server of the test's own for the tokens. */
  function served(configure: (adapter: HandAdapter) => void = () => {}) {
    const server = new OrdewellMcpServer();
    servers.push(server);
    const adapters: HandAdapter[] = [];
    const runner = new StructuredRunner({
      createAdapter: () => {
        const adapter = new HandAdapter();
        configure(adapter);
        adapters.push(adapter);
        return adapter;
      },
      interruptGraceMs: 20,
      mcp: server,
    });
    return { runner, adapters };
  }

  function servedConfig(adapter: HandAdapter): McpClientConfig {
    const start = adapter.starts[0];
    if (start.kind !== 'task' || !start.mcp) throw new Error('the runner was not given the server');
    return start.mcp;
  }

  async function connect(config: McpClientConfig): Promise<Client> {
    const client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers } }));
    clients.push(client);
    return client;
  }

  it('gives a Claude Code task the server, and its task_complete call reaches the session', async () => {
    const { runner, adapters } = served();
    const session = await runner.spawn(options({ attempt: 2 }));
    if (!isStructuredSession(session)) throw new Error('not a structured session');
    const reports: unknown[] = [];
    session.onTaskComplete((report) => reports.push(report));

    const client = await connect(servedConfig(adapters[0]));
    const result = await client.callTool({ name: 'task_complete', arguments: { status: 'done', summary: 'Built it.' } });

    expect(result.isError).toBe(false);
    expect(reports).toEqual([{ status: 'done', summary: 'Built it.' }]);
    session.kill();
  });

  it('delivers a queued final-turn message before settling, with the same task token valid for the next report', async () => {
    const { runner, adapters } = served();
    const session = await runner.spawn(options());
    if (!isStructuredSession(session)) throw new Error('not a structured session');
    const engine = new VerdictEngine();
    const verdicts: Verdict[] = [];
    engine.onVerdict((_id, verdict) => { verdicts.push(verdict); session.kill(); });
    engine.watch(createTask({ id: session.taskId, completionMarker: 'mk-1' }), session);
    await until(() => adapters[0].sent.length === 1);
    session.sendMessage('Also add tests');
    const client = await connect(servedConfig(adapters[0]));
    expect(await client.callTool({ name: 'task_complete', arguments: { status: 'done', summary: 'Original work' } })).toMatchObject({ isError: false });
    expect(verdicts).toEqual([]);
    adapters[0].endTurn();
    await until(() => adapters[0].sent.length === 2);
    expect(adapters[0].sent).toEqual(['Do the task', 'Also add tests']);
    expect(verdicts).toEqual([]);
    expect(await client.callTool({ name: 'task_complete', arguments: { status: 'failed', summary: 'Tests failed', reason: 'Assertion failed' } })).toMatchObject({ isError: false });
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0].outcome).toBe('fail');
    expect(verdicts[0].reason).toContain('Assertion failed');
    engine.reset();
  });

  it('holds a checkpoint call open until the session answers it, and returns the answer', async () => {
    const { runner, adapters } = served();
    const session = await runner.spawn(options());
    if (!isStructuredSession(session)) throw new Error('not a structured session');
    const asked: string[] = [];
    let answer!: (a: CheckpointAnswer) => void;
    session.onToolCheckpoint((question) => {
      asked.push(question);
      return new Promise<CheckpointAnswer>((resolve) => { answer = resolve; });
    });

    const client = await connect(servedConfig(adapters[0]));
    const call = client.callTool({ name: 'checkpoint', arguments: { question: 'Drop the table?' } });
    await until(() => asked.length === 1);
    answer({ kind: 'rejected', reason: 'keep it' });

    expect(asked).toEqual(['Drop the table?']);
    expect(await call).toMatchObject({ isError: false, content: [{ type: 'text', text: 'rejected: keep it' }] });
    session.kill();
  });

  it('answers a checkpoint call that nothing attached to as not available', async () => {
    const { runner, adapters } = served();
    const session = await runner.spawn(options());

    const client = await connect(servedConfig(adapters[0]));
    const result = await client.callTool({ name: 'checkpoint', arguments: { question: 'Drop the table?' } });

    expect(result.isError).toBe(true);
    session.kill();
  });

  it('ends a waiting checkpoint call with a refusal when the session is killed', async () => {
    const { runner, adapters } = served();
    const session = await runner.spawn(options());
    if (!isStructuredSession(session)) throw new Error('not a structured session');
    let asked = false;
    session.onToolCheckpoint((_question, signal) => new Promise<CheckpointAnswer>((resolve) => {
      asked = true;
      signal.addEventListener('abort', () => resolve({ kind: 'withdrawn', why: 'this attempt has ended.' }));
    }));

    const client = await connect(servedConfig(adapters[0]));
    const call = client.callTool({ name: 'checkpoint', arguments: { question: 'Drop the table?' } });
    await until(() => asked);
    session.kill();

    expect(await call).toMatchObject({ isError: true, content: [{ type: 'text', text: expect.stringContaining('withdrawn') }] });
  });

  it('keeps the server across a restart after an ignored interrupt', async () => {
    const { runner, adapters } = served((adapter) => { adapter.interruptAnswer = 'ignore'; });
    const session = await runner.spawn(options());
    if (!isStructuredSession(session)) throw new Error('not a structured session');
    await until(() => adapters[0].sent.length === 1);

    await session.interrupt();

    expect(adapters).toHaveLength(2);
    expect(adapters[1].starts[0]).toMatchObject({ mcp: servedConfig(adapters[0]) });
    session.kill();
  });

  it('refuses the token once the task is killed', async () => {
    const { runner, adapters } = served();
    const session = await runner.spawn(options());
    const config = servedConfig(adapters[0]);

    session.kill();

    await expect(connect(config)).rejects.toThrow();
  });

  it('refuses the token once the runner\'s process is gone', async () => {
    const { runner, adapters } = served();
    await runner.spawn(options());
    const config = servedConfig(adapters[0]);

    adapters[0].exit(0);

    await expect(connect(config)).rejects.toThrow();
  });

  it('refuses the token of a runner that could not start', async () => {
    const { runner, adapters } = served((adapter) => { adapter.startError = new Error('no such binary'); });

    await expect(runner.spawn(options())).rejects.toThrow('no such binary');

    await expect(connect(servedConfig(adapters[0]))).rejects.toThrow();
  });

  it('gives a runner whose connector cannot inject it no server', async () => {
    const { runner, adapters } = served();
    // Every built-in runner is given the server, so this is a plugin runner.
    const plugin = { get: () => registry.get('claude-code') } as unknown as RunnerRegistry;
    const session = await runner.spawn(options({ runner: 'other-runner', registry: plugin }));

    expect(adapters[0].starts[0]).not.toHaveProperty('mcp');
    session.kill();
  });
});

describe('a message sent mid-turn (ADR-0023)', () => {
  /** {@link HandAdapter} that can take a message into the running turn, and accepts every one. */
  class SteeringHandAdapter extends HandAdapter {
    readonly steered: Array<{ id: string; text: string }> = [];
    async steer(id: string, text: string): Promise<boolean> {
      this.steered.push({ id, text });
      return true;
    }
  }

  it('is handed to a runner that can take one, leaving the queue only once the runner says the model has it', async () => {
    const adapters: SteeringHandAdapter[] = [];
    const runner = new StructuredRunner({ createAdapter: () => { const a = new SteeringHandAdapter(); adapters.push(a); return a; }, interruptGraceMs: 20 });
    const turn = observe(await runner.spawn(options()));
    await until(() => adapters[0]?.sent.length === 1);

    const id = turn.session.sendMessage('and add tests');
    await until(() => turn.events.some((e) => e.type === 'message_handed_over'));
    expect(adapters[0].steered).toEqual([{ id, text: 'and add tests' }]);
    expect(turn.session.queued()).toEqual([{ id, text: 'and add tests', handedOver: true }]);

    adapters[0].emit({ type: 'message_delivered', id });
    expect(turn.session.queued()).toEqual([]);
    adapters[0].endTurn();
    await until(() => turn.turnEnds.length === 1);

    expect(adapters[0].sent).toEqual(['Do the task']);
    expect(turn.events).toContainEqual({ type: 'message_delivered', messageId: id, text: 'and add tests' });
    expect(turn.session.turnState()).toBe('idle');
    turn.session.kill();
  });

  it('waits for the turn to end on a runner that cannot take one', async () => {
    const { runner, adapters } = byHand();
    const turn = observe(await runner.spawn(options()));
    await until(() => adapters[0].sent.length === 1);

    const id = turn.session.sendMessage('and add tests');
    expect(turn.session.queued()).toEqual([{ id, text: 'and add tests' }]);
    adapters[0].endTurn();
    await until(() => adapters[0].sent.length === 2);

    expect(turn.events.some((e) => e.type === 'message_handed_over' || e.type === 'message_delivered')).toBe(false);
    turn.session.kill();
  });

  it('reaches the real Claude Code adapter as a user line, and leaves the queue when the CLI echoes it after the tool result', async () => {
    const recording = claudeSteerRecording('mid-turn');
    const { runner, spawned } = recorded([recording.before, recording.answer]);
    const turn = observe(await runner.spawn(options({ mode: 'bypassPermissions' })));
    await until(() => turn.events.some((e) => e.type === 'tool_call'));

    const id = turn.session.sendMessage('Also include the word PINEAPPLE in your final reply.');
    await until(() => turn.turnEnds.length === 1);

    // The fake answers within the write, so the echo can beat the handover's own report; delivery is what counts.
    const at = (match: (e: StructuredEvent) => boolean) => turn.events.findIndex(match);
    expect(at((e) => e.type === 'message_delivered' && e.messageId === id)).toBeGreaterThan(at((e) => e.type === 'tool_result'));
    expect(turn.events.filter((e) => e.type === 'turn_start')).toEqual([{ type: 'turn_start', text: 'Do the task' }]);
    expect(turn.session.getOutput()).toContain('PINEAPPLE');
    expect(turn.session.queued()).toEqual([]);
    expect(turn.session.turnState()).toBe('idle');
    expect(spawned.processes[0].written.filter((w) => w.includes('PINEAPPLE'))).toHaveLength(1);
    turn.session.kill();
  });

  it('keeps a Claude Code task working past a turn end with a message owed, and gives the turn the CLI opens for it to that message', async () => {
    const recording = claudeSteerRecording('after-result');
    const { runner, spawned } = recorded([recording.before, recording.answer]);
    const turn = observe(await runner.spawn(options({ mode: 'bypassPermissions' })));
    const states: string[] = [];
    turn.session.onTurnEnd(() => states.push(turn.session.turnState()));
    await until(() => turn.events.some((e) => e.type === 'assistant_text_delta'));

    const id = turn.session.sendMessage('Now reply with only the word PINEAPPLE.');
    await until(() => turn.turnEnds.length === 2);

    expect(states).toEqual(['working', 'idle']);
    expect(turn.events.filter((e) => e.type === 'turn_start')).toEqual([
      { type: 'turn_start', text: 'Do the task' },
      { type: 'turn_start', text: 'Now reply with only the word PINEAPPLE.', messageId: id },
    ]);
    expect(turn.session.getOutput().trim().endsWith('PINEAPPLE')).toBe(true);
    expect(turn.session.queued()).toEqual([]);
    expect(spawned.processes[0].written.filter((w) => w.includes('PINEAPPLE'))).toHaveLength(1);
    turn.session.kill();
  });

  /** A real OpenCode 1.x server over a fake fetch: the one end-to-end entry no adapter double can pin. */
  function openCodeServer() {
    const base = 'http://127.0.0.1:4096';
    const sessionId = 'ses_oc';
    const streams: FakeEventStream[] = [];
    const prompts: Array<{ messageID?: string }> = [];
    const answer = (body: unknown, status = 200) => ({
      ok: status >= 200 && status < 300, status, statusText: String(status), json: async () => body,
    }) as unknown as Response;
    const fetchImpl: AgentProcessDeps['fetch'] = async (input, init) => {
      const path = String(input).replace(base, '');
      const method = init?.method ?? 'GET';
      if (path === '/event') { const { response, stream } = sseResponse(init); streams.push(stream); return response; }
      if (path === '/session' && method === 'POST') return answer({ id: sessionId });
      if (path === '/session/status') return answer({});
      if (path.endsWith('/prompt_async')) {
        prompts.push(typeof init?.body === 'string' ? JSON.parse(init.body) as { messageID?: string } : {});
        return answer(null, 204);
      }
      if (path.endsWith('/message') && method === 'GET') return answer([]);
      return answer({});
    };
    const spawned = fakeSpawn([]);
    const spawn: AgentProcessDeps['spawn'] = (cmd, argv, opts) => {
      const proc = spawned.spawn(cmd, argv, opts);
      queueMicrotask(() => (proc as FakeAgentProcess).emitStdout(`opencode server listening on ${base}\n`));
      return proc;
    };
    return { spawn, fetch: fetchImpl, streams, prompts, sessionId };
  }

  it('reaches the real OpenCode adapter as a steer, and clears the queue when the model reads it', async () => {
    const server = openCodeServer();
    const runner = new StructuredRunner({
      process: { spawn: server.spawn, fetch: server.fetch, resolvePath: async () => '/usr/bin', platform: 'linux', isDirectory: () => true, exists: () => true },
    });
    const turn = observe(await runner.spawn(options({ runner: 'opencode', mode: 'build', modelId: 'opencode-go/deepseek-v4.1-flash' })));
    await until(() => server.streams.length === 1 && server.prompts.length === 1);
    const stream = server.streams[0];
    stream.push({ type: 'session.status', properties: { sessionID: server.sessionId, status: { type: 'busy' } } });

    const id = turn.session.sendMessage('and use Postgres');
    await until(() => turn.session.queued().some((m) => m.handedOver));
    const messageID = server.prompts[1].messageID!;
    expect(messageID).toMatch(/^msg/);

    // Storage alone is not delivery; the assistant message parented to the
    // steer's own id is what says the model read it.
    stream.push({ type: 'message.updated', properties: { sessionID: server.sessionId, info: { id: 'msg_a', role: 'assistant', parentID: messageID } } });
    await until(() => turn.session.queued().length === 0);

    stream.push({ type: 'session.status', properties: { sessionID: server.sessionId, status: { type: 'idle' } } });
    await until(() => turn.turnEnds.length === 1);
    expect(turn.events).toContainEqual({ type: 'message_delivered', messageId: id, text: 'and use Postgres' });
    expect(turn.events.filter((e) => e.type === 'turn_start')).toEqual([{ type: 'turn_start', text: 'Do the task' }]);
    turn.session.kill();
  });
});
