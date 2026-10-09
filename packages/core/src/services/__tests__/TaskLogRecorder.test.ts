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
import { isStructuredSession, type ITerminalRunner, type ITerminalSession, type RunnerTransport } from '../../interfaces/ITerminalRunner';
import type { RunnerSpawnOptions } from '../AbstractRunner';
import { listTaskLogAttempts, readTaskLog, type TaskLogFile } from '../../utils/taskLogStore';
import { FakeStructuredSession, FakeTerminalSession } from '../../testing';
import { fakeSpawn, fixture } from './harnessTestKit';
import { makeSession, memoryTaskLogs } from './sessionTestKit';

type TaskLogMessage = Extract<SessionMessage, { type: 'task_log' }>;

function taskLogs(messages: SessionMessage[]): TaskLogMessage[] {
  return messages.filter((m): m is TaskLogMessage => m.type === 'task_log');
}

/** A runner that hands back the session a test made, whatever it asked for. */
function handing(session: ITerminalSession): ITerminalRunner {
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

  it('saves and streams each batch of events together, deltas merged', async () => {
    const session = new FakeStructuredSession('s1', 't1');
    const file = memoryFile();
    const sent: SessionMessage[] = [];
    const recorder = new TaskLogRecorder({ broadcast: (m) => sent.push(m), location: () => ({ baseDir: '/ws', sessionId: 'sess' }), open: () => file });
    await recorder.wrap(handing(session)).spawn(spawnOpts);

    session.emitEvent({ type: 'turn_start', text: 'Do it' });
    session.emitEvent({ type: 'assistant_text_delta', text: 'Hel' });
    session.emitEvent({ type: 'assistant_text_delta', text: 'lo' });
    expect(sent).toEqual([]);
    vi.advanceTimersByTime(60);

    const expected: TaskLogEvent[] = [{ type: 'turn_start', message: 'Do it' }, { type: 'text_delta', text: 'Hello' }];
    expect(sent).toEqual([{ type: 'task_log', taskId: 't1', attempt: 1, events: expected }]);
    expect(file.saved).toEqual(expected);
  });

  it('sends a turn’s end at once, without waiting out the batch', async () => {
    const session = new FakeStructuredSession('s1', 't1');
    const sent: SessionMessage[] = [];
    const recorder = new TaskLogRecorder({ broadcast: (m) => sent.push(m), location: () => ({ baseDir: '/ws', sessionId: 'sess' }), open: () => memoryFile() });
    await recorder.wrap(handing(session)).spawn(spawnOpts);

    session.emitEvent({ type: 'assistant_text', text: 'Done.' });
    session.emitEvent({ type: 'turn_end', reason: 'completed' });
    expect(taskLogs(sent).flatMap((m) => m.events)).toEqual([{ type: 'text', text: 'Done.' }, { type: 'turn_end', reason: 'completed' }]);
  });

  it('flushes what is left when the session exits', async () => {
    const session = new FakeStructuredSession('s1', 't1');
    const file = memoryFile();
    const recorder = new TaskLogRecorder({ broadcast: vi.fn(), location: () => ({ baseDir: '/ws', sessionId: 'sess' }), open: () => file });
    await recorder.wrap(handing(session)).spawn(spawnOpts);
    session.emitEvent({ type: 'error', message: 'boom' });
    session.emitExit(1);
    expect(file.saved).toEqual([{ type: 'error', message: 'boom' }]);
  });

  it('keeps streaming when the log cannot be saved', async () => {
    const session = new FakeStructuredSession('s1', 't1');
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

  it('leaves a terminal-transport session alone: no file, no task_log', async () => {
    const session = new FakeTerminalSession('s1', 't1');
    const open = vi.fn();
    const sent: SessionMessage[] = [];
    const recorder = new TaskLogRecorder({ broadcast: (m) => sent.push(m), location: () => ({ baseDir: '/ws', sessionId: 'sess' }), open });
    const spawned = await recorder.wrap(handing(session)).spawn(spawnOpts);
    session.emitOutput('hello');
    session.emitExit(0);
    expect(spawned).toBe(session);
    expect(open).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });

  it('opens a new attempt’s file for every spawn of the task', async () => {
    const opened: string[] = [];
    let n = 0;
    const recorder = new TaskLogRecorder({
      broadcast: vi.fn(),
      location: () => ({ baseDir: '/ws', sessionId: 'sess' }),
      open: (_where, taskId) => { opened.push(taskId); n += 1; return memoryFile(n); },
    });
    const inner: ITerminalRunner = { spawn: vi.fn(async (o: RunnerSpawnOptions) => new FakeStructuredSession('s', o.taskId)), stop: vi.fn(), stopAll: vi.fn(), activeCount: 2 };
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
    const spawned = fakeSpawn([fixture('claude-code', name)]);
    const structured = new StructuredRunner({
      process: { spawn: spawned.spawn, resolvePath: async () => '/usr/bin', platform: 'linux', isDirectory: () => true, exists: () => true },
    });
    const sent: SessionMessage[] = [];
    const where = { baseDir, sessionId: 'session-live' };
    const recorder = new TaskLogRecorder({ broadcast: (m) => sent.push(m), location: () => where, flushMs: 1 });
    const raw: TaskLogEvent[] = [];
    const session = await recorder.wrap(structured).spawn({ ...spawnOpts, taskId: 'task-live', registry: new RunnerRegistry(), mode });
    if (!isStructuredSession(session)) throw new Error('expected a structured session');
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
      tasks: [createTask({ id: 't1', order: 1, title: 'Only', prompt: 'do it', assignedRunner: 'claude-code', completionMarker: 'mk-1' })],
      generatedAt: new Date().toISOString(),
      status: 'approved',
      runners: ['claude-code'],
      lastUpdated: new Date().toISOString(),
    };
  }

  function runnerFor(transport: RunnerTransport) {
    const sessions: FakeTerminalSession[] = [];
    const runner: ITerminalRunner = {
      spawn: vi.fn(async (opts: RunnerSpawnOptions) => {
        const session = transport === 'structured' ? new FakeStructuredSession('s1', opts.taskId) : new FakeTerminalSession('s1', opts.taskId);
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
    const { runner, sessions } = runnerFor('structured');
    const sent: SessionMessage[] = [];
    const files = memoryTaskLogs();
    const session = makeSession({ runner, broadcast: (m) => sent.push(m), settings: () => ({ tddEnabled: false }), openTaskLog: files });
    session.loadPlan(plan(), 'Goal', '/repo');
    await session.executePlan();

    const task = sessions[0] as FakeStructuredSession;
    task.emitEvent({ type: 'turn_start', text: 'do it' });
    task.emitEvent({ type: 'turn_end', reason: 'completed' });

    await vi.waitFor(() => expect(taskLogs(sent).flatMap((m) => m.events).map((e) => e.type)).toEqual(['turn_start', 'turn_end']));
    expect(taskLogs(sent)[0]).toMatchObject({ taskId: 't1', attempt: 1 });
    expect(files.files.get('t1')).toEqual([[{ type: 'turn_start', message: 'do it' }, { type: 'turn_end', reason: 'completed' }]]);
  });

  it('keeps no log for a terminal-transport task', async () => {
    const { runner, sessions } = runnerFor('terminal');
    const sent: SessionMessage[] = [];
    const files = memoryTaskLogs();
    const session = makeSession({ runner, broadcast: (m) => sent.push(m), openTaskLog: files });
    session.loadPlan(plan(), 'Goal', '/repo');
    await session.executePlan();
    sessions[0].emitOutput('working…');
    sessions[0].emitOutput('<<<ORDEWELL_DONE_mk-1>>>');

    await vi.waitFor(() => expect(sent.some((m) => m.type === 'status_update' && m.tasks[0]?.status === 'completed')).toBe(true));
    expect(taskLogs(sent)).toEqual([]);
    expect(files.files.size).toBe(0);
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
