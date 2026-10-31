import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TaskLogRecorder } from '../TaskLogRecorder';
import { StructuredRunner } from '../StructuredRunner';
import type { SessionMessage } from '../SessionMessage';
import { RunnerRegistry } from '../../plugins/RunnerRegistry';
import { EMPTY_TASK_LOG, reduceTaskLog, replayTaskLog } from '../../conversation/taskLog';
import { toTaskLogEvent, type TaskLogEvent } from '../../models/TaskLog';
import { createTask, type LegacyPlanState } from '../../models/Task';
import type { IRunner, IRunnerSession } from '../../interfaces/IRunner';
import type { RunnerSpawnOptions } from '../AbstractRunner';
import { listTaskLogAttempts, openTaskLog, readTaskLog, type TaskLogFile } from '../../utils/taskLogStore';
import { FakeRunnerSession } from '../../testing';
import { renderTaskLog } from '../taskLogRead';
import { fakeSpawn, fixture } from './harnessTestKit';
import { makeSession, memoryTaskLogs, saves, taskOf } from './sessionTestKit';

type TaskLogMessage = Extract<SessionMessage, { type: 'task_log' }>;

function taskLogs(messages: SessionMessage[]): TaskLogMessage[] {
  return messages.filter((m): m is TaskLogMessage => m.type === 'task_log');
}

/** A runner that hands back the session a test made, whatever it asked for. */
function handing(session: IRunnerSession): IRunner {
  return { spawn: vi.fn(async () => session), stop: vi.fn(), stopAll: vi.fn(), activeCount: 0 };
}

function memoryFile(attempt = 1): TaskLogFile & { saved: TaskLogEvent[] } {
  const saved: TaskLogEvent[] = [];
  return { attempt, saved, append: (events) => { saved.push(...events); } };
}

const spawnOpts = { taskId: 't1', runner: 'claude-code', prompt: 'Do it', cwd: '/repo' };

describe('TaskLogRecorder', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('dates a turn as it opens, for a reload to count its open turn from (#81)', async () => {
    vi.setSystemTime(new Date('2026-10-30T10:00:00.000Z'));
    const session = new FakeRunnerSession('s1', 't1');
    const file = memoryFile();
    const recorder = new TaskLogRecorder({ broadcast: () => {}, location: () => ({ baseDir: '/ws', sessionId: 'sess' }), open: () => file });
    await recorder.wrap(handing(session)).spawn(spawnOpts);

    session.emitEvent({ type: 'turn_start', text: 'Do it' });
    session.emitEvent({ type: 'turn_start', text: '/compact', command: { name: 'compact' } });
    vi.advanceTimersByTime(60);

    expect(file.saved).toEqual([
      { type: 'turn_start', message: 'Do it', startedAt: '2026-10-30T10:00:00.000Z' },
      { type: 'command', name: 'compact', startedAt: '2026-10-30T10:00:00.000Z' },
    ]);
  });

  it('saves and streams each batch of events together, deltas merged', async () => {
    const session = new FakeRunnerSession('s1', 't1');
    const file = memoryFile();
    const sent: SessionMessage[] = [];
    const recorder = new TaskLogRecorder({ broadcast: (m) => sent.push(m), location: () => ({ baseDir: '/ws', sessionId: 'sess' }), open: () => file });
    await recorder.wrap(handing(session)).spawn(spawnOpts);

    session.emitEvent({ type: 'turn_start', text: 'Do it' });
    session.emitEvent({ type: 'assistant_text_delta', runId: 'r1', text: 'Hel' });
    session.emitEvent({ type: 'assistant_text_delta', runId: 'r1', text: 'lo' });
    expect(sent).toEqual([]);
    vi.advanceTimersByTime(60);

    const expected: TaskLogEvent[] = [{ type: 'turn_start', message: 'Do it', startedAt: expect.any(String) }, { type: 'text_delta', runId: 'r1', text: 'Hello' }];
    expect(sent).toEqual([{ type: 'task_log', taskId: 't1', attempt: 1, events: expected }]);
    expect(file.saved).toEqual(expected);
  });

  it('writes a note into the log of the attempt that ran its session, at once and past its exit, never into a later attempt\'s', async () => {
    const first = memoryFile(1);
    const second = memoryFile(2);
    const files = [first, second];
    const sent: SessionMessage[] = [];
    const recorder = new TaskLogRecorder({ broadcast: (m) => sent.push(m), location: () => ({ baseDir: '/ws', sessionId: 'sess' }), open: () => files.shift()! });
    const note: TaskLogEvent = { type: 'model_switched', from: { model: 'haiku' }, to: { model: 'sonnet' }, plan: { model: { model: 'sonnet' } } };

    const a = new FakeRunnerSession('s1', 't1');
    await recorder.wrap(handing(a)).spawn(spawnOpts);
    a.emitEvent({ type: 'turn_start', text: 'Do it' });
    recorder.note('s1', 't1', note);
    expect(first.saved).toEqual([{ type: 'turn_start', message: 'Do it', startedAt: expect.any(String) }, note]);
    a.emitExit(0);
    recorder.note('s1', 't1', note);
    expect(first.saved).toHaveLength(4);

    await recorder.wrap(handing(new FakeRunnerSession('s2', 't1'))).spawn(spawnOpts);
    recorder.note('s1', 't1', note);
    expect(first.saved).toHaveLength(4);
    expect(second.saved).toEqual([]);
  });

  it('opens a log of its own for a note made with no session, as a user task\'s completion is, and sends it', () => {
    const file = memoryFile(3);
    const open = vi.fn(() => file);
    const sent: SessionMessage[] = [];
    const recorder = new TaskLogRecorder({ broadcast: (m) => sent.push(m), location: () => ({ baseDir: '/ws', sessionId: 'sess' }), open });
    const note: TaskLogEvent = { type: 'handoff', handoff: { summary: 'Completed by the user', findings: [], findingCount: 0 } };

    recorder.note(undefined, 'u1', note);

    expect(open).toHaveBeenCalledWith({ baseDir: '/ws', sessionId: 'sess' }, 'u1', undefined);
    expect(file.saved).toEqual([note]);
    expect(taskLogs(sent)).toEqual([{ type: 'task_log', taskId: 'u1', attempt: 3, events: [note] }]);
  });

  it('opens each attempt\'s log with the skills that attempt was given, shown as one line', async () => {
    const skills = [{ name: 'tdd', source: 'global' as const, path: '/g/tdd/SKILL.md', content: 'RED, GREEN.' }];
    const first = memoryFile(1);
    const second = memoryFile(2);
    const files = [first, second];
    const sent: SessionMessage[] = [];
    const recorder = new TaskLogRecorder({ broadcast: (m) => sent.push(m), location: () => ({ baseDir: '/ws', sessionId: 'sess' }), open: () => files.shift()! });

    const a = new FakeRunnerSession('s1', 't1');
    await recorder.wrap(handing(a)).spawn({ ...spawnOpts, skills });
    a.emitEvent({ type: 'turn_start', text: 'Do it' });
    vi.advanceTimersByTime(60);
    const b = new FakeRunnerSession('s2', 't1');
    await recorder.wrap(handing(b)).spawn(spawnOpts);
    b.emitEvent({ type: 'turn_start', text: 'Do it' });
    vi.advanceTimersByTime(60);

    expect(first.saved).toEqual([{ type: 'task_skills', skills }, { type: 'turn_start', message: 'Do it', startedAt: expect.any(String) }]);
    expect(second.saved).toEqual([{ type: 'turn_start', message: 'Do it', startedAt: expect.any(String) }]);
    expect(replayTaskLog(first.saved).blocks[0]).toMatchObject({ type: 'message', role: 'system', text: 'Skills: tdd (/g/tdd/SKILL.md)' });
    // The file keeps the body; a surface is told which skill, never what it says.
    expect(taskLogs(sent)[0].events[0]).toEqual({ type: 'task_skills', skills: [{ name: 'tdd', source: 'global', path: '/g/tdd/SKILL.md' }] });
  });

  it('sends a turn’s end at once, without waiting out the batch', async () => {
    const session = new FakeRunnerSession('s1', 't1');
    const sent: SessionMessage[] = [];
    const recorder = new TaskLogRecorder({ broadcast: (m) => sent.push(m), location: () => ({ baseDir: '/ws', sessionId: 'sess' }), open: () => memoryFile() });
    await recorder.wrap(handing(session)).spawn(spawnOpts);

    session.emitEvent({ type: 'assistant_text', runId: 'r1', text: 'Done.' });
    session.emitEvent({ type: 'turn_end', reason: 'completed' });
    expect(taskLogs(sent).flatMap((m) => m.events)).toEqual([{ type: 'text', runId: 'r1', text: 'Done.' }, { type: 'turn_end', reason: 'completed' }]);
  });

  it('closes the last turn on exit even when every call already returned', async () => {
    const session = new FakeRunnerSession('s1', 't1');
    const file = memoryFile();
    const sent: SessionMessage[] = [];
    const recorder = new TaskLogRecorder({ broadcast: (m) => sent.push(m), location: () => ({ baseDir: '/ws', sessionId: 'sess' }), open: () => file });
    await recorder.wrap(handing(session)).spawn(spawnOpts);
    session.emitEvent({ type: 'turn_start', text: 'Do it' });
    session.emitEvent({ type: 'assistant_text_delta', runId: 'r1', text: 'Done.' });
    session.emitExit(0);
    for (const events of [file.saved, taskLogs(sent).flatMap((m) => m.events)]) {
      expect(events.at(-1)).toEqual({ type: 'runner_ended' });
      const view = replayTaskLog(events);
      expect(view.working).toBe(false);
      expect(view.blocks.at(-1)).toMatchObject({ type: 'message', text: 'Done.', streaming: false });
      expect(view.streams).toEqual({});
    }
  });

  it('flushes what is left when the session exits', async () => {
    const session = new FakeRunnerSession('s1', 't1');
    const file = memoryFile();
    const recorder = new TaskLogRecorder({ broadcast: vi.fn(), location: () => ({ baseDir: '/ws', sessionId: 'sess' }), open: () => file });
    await recorder.wrap(handing(session)).spawn(spawnOpts);
    session.emitEvent({ type: 'error', message: 'boom' });
    session.emitExit(1);
    expect(file.saved).toEqual([{ type: 'error', message: 'boom' }, { type: 'runner_ended' }]);
  });

  // A stopped runner can end with a call still open: a killed turn, or a
  // process that exits before its last result.
  it('closes a call still open when its runner ends, so no surface shows it running', async () => {
    const session = new FakeRunnerSession('s1', 't1');
    const file = memoryFile();
    const sent: SessionMessage[] = [];
    const recorder = new TaskLogRecorder({ broadcast: (m) => sent.push(m), location: () => ({ baseDir: '/ws', sessionId: 'sess' }), open: () => file });
    await recorder.wrap(handing(session)).spawn(spawnOpts);
    session.emitEvent({ type: 'turn_start', text: 'Do it' });
    session.emitEvent({ type: 'tool_call', id: 'call-1', name: 'mcp__ordewell__task_complete', args: { status: 'done', summary: 'ok' } });
    session.emitExit(-1);

    for (const events of [file.saved, taskLogs(sent).flatMap((m) => m.events)]) {
      const tools = replayTaskLog(events).blocks.filter((b) => b.type === 'tool');
      expect(tools).toHaveLength(1);
      expect(tools[0]).toMatchObject({ toolCallId: 'call-1', status: 'interrupted' });
    }
  });

  it('records a completed task_complete call as a success before the turn ends', async () => {
    const session = new FakeRunnerSession('s1', 't1');
    const file = memoryFile();
    const recorder = new TaskLogRecorder({ broadcast: vi.fn(), location: () => ({ baseDir: '/ws', sessionId: 'sess' }), open: () => file });
    await recorder.wrap(handing(session)).spawn(spawnOpts);
    session.emitEvent({ type: 'turn_start', text: 'Do it' });
    session.emitEvent({ type: 'tool_call', id: 'call-1', name: 'mcp__ordewell__task_complete', args: { status: 'done', summary: 'ok' } });
    session.emitEvent({ type: 'tool_result', id: 'call-1', name: 'mcp__ordewell__task_complete', output: 'Recorded. End your turn now.', success: true });
    session.emitEvent({ type: 'turn_end', reason: 'completed' });

    const tools = replayTaskLog(file.saved).blocks.filter((b) => b.type === 'tool');
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ status: 'ok', output: 'Recorded. End your turn now.' });
    const types = file.saved.map((event) => event.type);
    expect(types.indexOf('tool_result')).toBeLessThan(types.indexOf('turn_end'));
  });

  it('keeps streaming when the log cannot be saved', async () => {
    const session = new FakeRunnerSession('s1', 't1');
    const sent: SessionMessage[] = [];
    const warn = vi.fn();
    const recorder = new TaskLogRecorder({
      broadcast: (m) => sent.push(m),
      location: () => ({ baseDir: '/ws', sessionId: 'sess' }),
      open: () => ({ attempt: 3, append: () => { throw new Error('ENOSPC'); } }),
      logger: { warn },
    });
    await recorder.wrap(handing(session)).spawn(spawnOpts);
    session.emitEvent({ type: 'turn_end', reason: 'completed' });
    session.emitEvent({ type: 'turn_end', reason: 'completed' });
    expect(taskLogs(sent)).toHaveLength(2);
    expect(taskLogs(sent)[0].attempt).toBe(3);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('records every runner session, keeping plain output off the event log', async () => {
    const session = new FakeRunnerSession('s1', 't1');
    const open = vi.fn(() => memoryFile(1));
    const sent: SessionMessage[] = [];
    const recorder = new TaskLogRecorder({ broadcast: (m) => sent.push(m), location: () => ({ baseDir: '/ws', sessionId: 'sess' }), open });
    const spawned = await recorder.wrap(handing(session)).spawn({ ...spawnOpts, attempt: 3 });
    session.emitOutput('hello');
    session.emitExit(0);
    expect(spawned).toBe(session);
    expect(open).toHaveBeenCalledWith({ baseDir: '/ws', sessionId: 'sess' }, 't1', 3);
    expect(sent).toEqual([{ type: 'task_log', taskId: 't1', attempt: 1, events: [{ type: 'runner_ended' }] }]);
  });

  it('opens a new attempt’s file for every spawn of the task', async () => {
    const opened: string[] = [];
    let n = 0;
    const recorder = new TaskLogRecorder({
      broadcast: vi.fn(),
      location: () => ({ baseDir: '/ws', sessionId: 'sess' }),
      open: (_where, taskId) => { opened.push(taskId); n += 1; return memoryFile(n); },
    });
    const inner: IRunner = { spawn: vi.fn(async (o: RunnerSpawnOptions) => new FakeRunnerSession('s', o.taskId)), stop: vi.fn(), stopAll: vi.fn(), activeCount: 2 };
    const runner = recorder.wrap(inner);
    await runner.spawn(spawnOpts);
    await runner.spawn(spawnOpts);
    expect(opened).toEqual(['t1', 't1']);
    expect(runner.activeCount).toBe(2);
    runner.stop('s');
    expect(inner.stop).toHaveBeenCalledWith('s');
  });
});

describe('a structured run through the real Claude adapter', () => {
  let baseDir: string;

  beforeEach(() => { baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-tasklog-run-')); });
  afterEach(() => { fs.rmSync(baseDir, { recursive: true, force: true }); });

  /** `mode` is the one the fixture was recorded under; the adapter holds the CLI to the mode asked for. */
  async function run(name: string, mode = 'acceptEdits') {
    const recorded = fixture('claude-code', name);
    const spawned = fakeSpawn([mode === 'plan' ? recorded.replaceAll('"permissionMode":"plan"', '"permissionMode":"default"') : recorded]);
    const structured = new StructuredRunner({
      process: { spawn: spawned.spawn, resolvePath: async () => '/usr/bin', platform: 'linux', isDirectory: () => true, exists: () => true },
    });
    const sent: SessionMessage[] = [];
    const where = { baseDir, sessionId: 'session-live' };
    const recorder = new TaskLogRecorder({ broadcast: (m) => sent.push(m), location: () => where, flushMs: 1 });
    const raw: TaskLogEvent[] = [];
    const session = await recorder.wrap(structured).spawn({ ...spawnOpts, taskId: 'task-live', registry: new RunnerRegistry(), mode });

    session.onEvent((e) => { const entry = toTaskLogEvent(e); if (entry) raw.push(entry); });
    await new Promise<void>((resolve) => session.onTurnEnd(() => resolve()));
    session.kill();
    const live = taskLogs(sent).reduce((view, m) => m.events.reduce(reduceTaskLog, view), EMPTY_TASK_LOG);
    return { live, raw, where, sent };
  }

  it.each(['stream-subagent', 'stream-reasoning', 'stream-tool-rounds', 'task-marker'])(
    'draws the same blocks live as from the saved file (%s)',
    async (name) => {
      const { live, raw, where } = await run(name, name === 'stream-subagent' ? 'plan' : 'acceptEdits');
      expect(listTaskLogAttempts(where, 'task-live')).toEqual([1]);
      const replayed = replayTaskLog(readTaskLog(where, 'task-live', 1));
      expect(replayed).toEqual(live);
      // Merging deltas into batches changes nothing a surface draws.
      expect(replayTaskLog(raw)).toEqual(live);
    },
  );

  it('rebuilds a subagent with its own calls nested inside it', async () => {
    const { live } = await run('stream-subagent', 'plan');
    const subagent = live.blocks.find((b) => b.type === 'subagent');
    expect(subagent).toMatchObject({ type: 'subagent', status: 'done' });
    expect(subagent?.type === 'subagent' && subagent.children.some((c) => c.type === 'tool' && c.headline.name === 'Read')).toBe(true);
    expect(live.blocks.some((b) => b.type === 'message' && b.role === 'agent' && b.text.includes('The first line of README.md is `hello`.'))).toBe(true);
    expect(live.blocks.at(-1)?.type).toBe('usage');
    expect(live.lastTurnEnd).toBe('completed');
  });
});

describe('a session’s task logs', () => {
  function plan(): LegacyPlanState {
    return {
      tasks: [createTask({ id: 't1', order: 1, title: 'Only', prompt: 'do it', assignedRunner: 'claude-code' })],
      generatedAt: new Date().toISOString(),
      status: 'approved',
      runners: ['claude-code'],
      lastUpdated: new Date().toISOString(),
    };
  }

  function runnerFor() {
    const sessions: FakeRunnerSession[] = [];
    const runner: IRunner = {
      spawn: vi.fn(async (opts: RunnerSpawnOptions) => {
        const session = new FakeRunnerSession('s1', opts.taskId);
        sessions.push(session);
        return session;
      }),
      stop: vi.fn(),
      stopAll: vi.fn(),
      activeCount: 0,
    };
    return { runner, sessions };
  }

  it('broadcasts a structured task’s events on the session’s own seam, and saves them under its attempt', async () => {
    const { runner, sessions } = runnerFor();
    const sent: SessionMessage[] = [];
    const files = memoryTaskLogs();
    const session = makeSession({ runner, broadcast: (m) => sent.push(m), openTaskLog: files });
    session.loadPlan(plan(), 'Goal', '/repo');
    await session.execute({ command: 'run_plan' }, { kind: 'user' });

    const task = sessions[0] as FakeRunnerSession;
    task.emitEvent({ type: 'turn_start', text: 'do it' });
    task.emitEvent({ type: 'turn_end', reason: 'completed' });

    await vi.waitFor(() => expect(taskLogs(sent).flatMap((m) => m.events).map((e) => e.type)).toEqual(['turn_start', 'turn_end']));
    expect(taskLogs(sent)[0]).toMatchObject({ taskId: 't1', attempt: 1 });
    expect(files.files.get('t1')).toEqual([[{ type: 'turn_start', message: 'do it', startedAt: expect.any(String) }, { type: 'turn_end', reason: 'completed' }]]);
  });

  it('writes the handoff a task completed with into its attempt\'s log once, report and all, and keeps the plan to its digest', async () => {
    const { runner, sessions } = runnerFor();
    const sent: SessionMessage[] = [];
    const files = memoryTaskLogs();
    const session = makeSession({ runner, broadcast: (m) => sent.push(m), openTaskLog: files });
    session.loadPlan(plan(), 'Goal', '/repo');
    await session.execute({ command: 'run_plan' }, { kind: 'user' });
    const report = Array.from({ length: 600 }, (_, i) => `Line ${i + 1}: what was checked.`).join('\n');

    sessions[0].reportComplete({ status: 'done', summary: 'Done.', findings: [{ severity: 'minor', title: 'A nit', detail: 'Rename x.' }], report });

    await vi.waitFor(() => expect(taskOf(session, 't1')?.status).toBe('completed'));
    const handoff = { summary: 'Done.', findings: [{ id: 'F1', severity: 'minor', title: 'A nit', detail: 'Rename x.' }], findingCount: 1, attempt: 1 };
    expect(files.files.get('t1')!.flat().filter((e) => e.type === 'handoff')).toEqual([{ type: 'handoff', handoff: { ...handoff, report } }]);
    expect(taskLogs(sent).flatMap((m) => m.events).filter((e) => e.type === 'handoff')).toHaveLength(1);
    expect(taskOf(session, 't1')?.handoff).toEqual(handoff);
    await vi.waitFor(() => expect(saves(session).mock.calls.at(-1)?.[0].tasks[0].handoff).toEqual(handoff));
  });

  it('writes the handoff of a user task into a log of its own, the one a reader of task logs finds', async () => {
    const files = memoryTaskLogs();
    const session = makeSession({ openTaskLog: files });
    const userPlan: LegacyPlanState = {
      ...plan(),
      tasks: [createTask({ id: 'u1', order: 1, title: 'Rotate the key', type: 'user', userSteps: [{ order: 1, instruction: 'Create the new key', completed: false }] })],
    };
    session.loadPlan(userPlan, 'Goal', '/repo');
    await session.execute({ command: 'run_plan' }, { kind: 'user' });

    await session.execute({ command: 'mark_complete', task: 'u1' }, { kind: 'user' });

    const handoff = { summary: 'Completed by the user', findings: [], findingCount: 0, report: '1. [x] Create the new key' };
    expect(files.files.get('u1')).toEqual([[{ type: 'handoff', handoff }]]);
    expect(renderTaskLog(files.files.get('u1')![0], ['handoff'])).toBe('[1 handoff] Completed by the user\n\nReport:\n1. [x] Create the new key\n');
    expect(taskOf(session, 'u1')?.handoff).toEqual({ summary: 'Completed by the user', findings: [], findingCount: 0 });
  });

  it('writes the handoff of a script task into the log of the attempt that ran it, once it has settled', async () => {
    const files = memoryTaskLogs();
    const scripts: FakeRunnerSession[] = [];
    const scriptRunner: IRunner = {
      spawn: vi.fn(async (opts: RunnerSpawnOptions) => {
        const script = new FakeRunnerSession('sc1', opts.taskId);
        scripts.push(script);
        return script;
      }),
      stop: vi.fn(), stopAll: vi.fn(), activeCount: 0,
    };
    const session = makeSession({ scriptRunner, openTaskLog: files });
    session.loadPlan({ ...plan(), tasks: [createTask({ id: 's1', order: 1, title: 'Build', type: 'script', commands: [['make']] })] }, 'Goal', '/repo');
    await session.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(scripts).toHaveLength(1));
    scripts[0].emitEvent({ type: 'script_run', argv: ['make'] });
    scripts[0].emitOutput('built\n');
    scripts[0].emitEvent({ type: 'script_exit', durationMs: 2500, code: 0, signal: null });
    scripts[0].reportScriptExit({ outcome: 'passed' });
    scripts[0].emitExit(0);

    await vi.waitFor(() => expect(taskOf(session, 's1')?.status).toBe('completed'));
    const logged = files.files.get('s1')!.flat();
    expect(logged.map((e) => e.type)).toEqual(['script_run', 'script_exit', 'runner_ended', 'handoff']);
    expect(logged[3]).toEqual({ type: 'handoff', handoff: { summary: 'exited 0 in 2.5 s\nbuilt', findings: [], findingCount: 0, report: 'built', attempt: 1 } });
  });

  it('opens an attempt log even when the runner emits only plain output', async () => {
    const { runner, sessions } = runnerFor();
    const sent: SessionMessage[] = [];
    const files = memoryTaskLogs();
    const session = makeSession({ runner, broadcast: (m) => sent.push(m), openTaskLog: files });
    session.loadPlan(plan(), 'Goal', '/repo');
    await session.execute({ command: 'run_plan' }, { kind: 'user' });
    sessions[0].emitOutput('working…');
    await session.execute({ command: 'stop_run' }, { kind: 'user' });
    await vi.waitFor(() => expect(session.activity.running).toBe(false));
    void session.execute({ command: 'mark_complete', task: 't1', confirmed: true }, { kind: 'user' });

    await vi.waitFor(() => expect(sent.some((m) => m.type === 'status_update' && m.tasks[0]?.status === 'completed')).toBe(true));
    expect(taskLogs(sent)).toEqual([]);
    expect(files.files.size).toBe(1);
    expect(files.files.get('t1')).toEqual([[]]);
  });

  it('reads a task’s saved attempts back from where it wrote them', () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-tasklog-session-'));
    try {
      const session = makeSession({ sessionId: 'session-read', workspaceRoot: () => baseDir });
      session.loadPlan(plan(), 'Goal', baseDir, { sessionId: 'session-read' });
      expect(session.taskLogLocation).toEqual({ baseDir, sessionId: 'session-read' });
      expect(session.taskLogAttempts('t1')).toEqual([]);
      const dir = path.join(baseDir, '.ordewell', 'sessions', 'session-read', 'tasks', 't1');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, '1.jsonl'), `${JSON.stringify({ type: 'text', text: 'hi' })}\n`);
      expect(session.taskLogAttempts('t1')).toEqual([1]);
      expect(session.taskLog('t1', 1)).toEqual([{ type: 'text', text: 'hi' }]);
    } finally {
      fs.rmSync(baseDir, { recursive: true, force: true });
    }
  });
});

describe('a task log and its attempt ledger share one number', () => {
  function plan(): LegacyPlanState {
    return {
      tasks: [createTask({ id: 't1', order: 1, title: 'Only', prompt: 'do it', assignedRunner: 'claude-code' })],
      generatedAt: new Date().toISOString(),
      status: 'approved',
      runners: ['claude-code'],
      lastUpdated: new Date().toISOString(),
    };
  }

  let baseDir: string;
  beforeEach(() => { baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-tasklog-ledger-')); });
  afterEach(() => { fs.rmSync(baseDir, { recursive: true, force: true }); });

  /** A runner whose first spawn fails, as a missing CLI does, and every later one runs. */
  function failingFirst() {
    const sessions: FakeRunnerSession[] = [];
    let spawns = 0;
    const runner: IRunner = {
      spawn: vi.fn(async (opts: RunnerSpawnOptions) => {
        spawns += 1;
        if (spawns === 1) throw new Error('claude: command not found');
        const session = new FakeRunnerSession(`s${spawns}`, opts.taskId);
        sessions.push(session);
        return session;
      }),
      stop: vi.fn(),
      stopAll: vi.fn(),
      activeCount: 0,
    };
    return { runner, sessions };
  }

  const ledger = (session: ReturnType<typeof makeSession>) => taskOf(session, 't1')?.attemptUsage ?? [];

  it('after a spawn that failed, each log is saved under its own attempt\'s ledger number', async () => {
    const { runner, sessions } = failingFirst();
    const session = makeSession({ runner, sessionId: 'sess', workspaceRoot: () => baseDir, openTaskLog });
    session.loadPlan(plan(), 'Goal', baseDir, { sessionId: 'sess' });
    await session.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(runner.spawn).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(taskOf(session, 't1')?.status).toBe('pending'));

    await session.execute({ command: 'retry_task', task: 't1', from: 'fresh' }, { kind: 'user' });
    sessions[0].emitEvent({ type: 'usage', record: { source: 'claude-code', inputTokens: 100 } });
    await session.execute({ command: 'stop_task', task: 't1' }, { kind: 'user' });
    await session.execute({ command: 'retry_task', task: 't1', from: 'fresh' }, { kind: 'user' });
    sessions[1].emitEvent({ type: 'usage', record: { source: 'claude-code', inputTokens: 200 } });
    await vi.waitFor(() => expect(ledger(session).map((u) => u.totals.inputTokens)).toEqual([undefined, 100, 200]));

    expect(ledger(session).map((u) => u.attempt)).toEqual([1, 2, 3]);
    expect(session.taskLogAttempts('t1')).toEqual([2, 3]);
    await vi.waitFor(() => expect(session.taskLog('t1', 2)).toContainEqual({ type: 'usage', record: { source: 'claude-code', inputTokens: 100 } }));
  });

  it('numbers a new attempt past the logs saved before its task kept ledgers', async () => {
    const { runner } = failingFirst();
    const location = { baseDir, sessionId: 'sess' };
    openTaskLog(location, 't1');
    openTaskLog(location, 't1');
    const session = makeSession({ runner, sessionId: 'sess', workspaceRoot: () => baseDir, openTaskLog });
    session.loadPlan(plan(), 'Goal', baseDir, { sessionId: 'sess' });
    await session.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(runner.spawn).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(taskOf(session, 't1')?.status).toBe('pending'));
    await session.execute({ command: 'retry_task', task: 't1', from: 'fresh' }, { kind: 'user' });

    expect(ledger(session).map((u) => u.attempt)).toEqual([3, 4]);
    expect(session.taskLogAttempts('t1')).toEqual([1, 2, 4]);
  });
});
