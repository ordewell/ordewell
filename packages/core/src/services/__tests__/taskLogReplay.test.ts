import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TaskLogRecorder } from '../TaskLogRecorder';
import { StructuredRunner } from '../StructuredRunner';
import { RunnerApprovals } from '../RunnerApprovals';
import { PendingApprovals } from '../PendingApprovals';
import type { SessionMessage } from '../SessionMessage';
import { RunnerRegistry } from '../../plugins/RunnerRegistry';
import { EMPTY_TASK_LOG, reduceTaskLog, replayTaskLog, type TaskLogView } from '../../conversation/taskLog';
import type { TaskLogEvent } from '../../models/TaskLog';
import type { IRunner, IRunnerSession } from '../../interfaces/IRunner';
import { listTaskLogAttempts, readTaskLog, type TaskLogLocation } from '../../utils/taskLogStore';
import { sessionDataDir } from '../../utils/sessionStore';
import { FakeRunnerSession } from '../../testing';
import { claudeTurnEndQueue, fakeSpawn, fixture, type ScriptedReply } from './harnessTestKit';

/**
 * A structured task's log on disk against what surfaces drew live (ADR-0018,
 * P1): real files under `.ordewell/sessions/<session>/tasks/<task>/`, the real
 * Claude Code adapter fed recorded transcripts, and multi-turn attempts —
 * interrupts, queued messages, runner approvals — that a single-turn replay
 * does not reach.
 */

type TaskLogMessage = Extract<SessionMessage, { type: 'task_log' }>;

const TASK = 'task-replay';

let baseDir: string;
let where: TaskLogLocation;

beforeEach(() => {
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-tasklog-replay-'));
  where = { baseDir, sessionId: 'session-replay' };
});
afterEach(() => { fs.rmSync(baseDir, { recursive: true, force: true }); });

function recording(replies: ScriptedReply[], wrap: (runner: IRunner) => IRunner = (r) => r) {
  const spawned = fakeSpawn(replies);
  const structured = new StructuredRunner({
    process: { spawn: spawned.spawn, resolvePath: async () => '/usr/bin', platform: 'linux', isDirectory: () => true, exists: () => true },
    createAdapter: claudeTurnEndQueue,
    interruptGraceMs: 1000,
  });
  const sent: SessionMessage[] = [];
  const recorder = new TaskLogRecorder({ broadcast: (m) => sent.push(m), location: () => where, flushMs: 1 });
  const runner = recorder.wrap(wrap(structured));
  const spawn = async (mode = 'acceptEdits') => {
    const session = await runner.spawn({ taskId: TASK, runner: 'claude-code', prompt: 'Do the task', cwd: '/repo', registry: new RunnerRegistry(), mode });

    return session;
  };
  /** What a surface folding every `task_log` of one attempt would draw. */
  const live = (attempt: number): TaskLogView => sent
    .filter((m): m is TaskLogMessage => m.type === 'task_log' && m.attempt === attempt)
    .reduce((view, m) => m.events.reduce(reduceTaskLog, view), EMPTY_TASK_LOG);
  return { spawned, sent, spawn, live, runner };
}

function turnEnds(session: IRunnerSession, count: number): Promise<void> {
  let seen = 0;
  return new Promise<void>((resolve) => session.onTurnEnd(() => { seen += 1; if (seen === count) resolve(); }));
}

const saved = (attempt: number): TaskLogEvent[] => readTaskLog(where, TASK, attempt);

describe('a multi-turn attempt, saved and replayed', () => {
  it('draws the same blocks from the file as live across an interrupt, a queued message and the turn it started', async () => {
    const run = recording([
      fixture('claude-code', 'task-interrupt'),
      (written, proc) => {
        const request = JSON.parse(written) as { request_id: string };
        proc.emitStdout(fixture('claude-code', 'task-interrupt-ack', { REQUEST_ID: request.request_id }));
      },
      fixture('claude-code', 'task-interrupt-followup'),
    ]);
    const session = await run.spawn();
    const both = turnEnds(session, 2);
    await vi.waitFor(() => expect(run.spawned.processes[0].written).toHaveLength(2));
    const queued = session.sendMessage('Say only: ok');
    await session.interrupt();
    await both;
    session.kill();

    const events = saved(1);
    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(['message_queued', 'turn_end']));
    expect(events.filter((e) => e.type === 'turn_start')).toEqual([
      { type: 'turn_start', message: 'Do the task' },
      { type: 'turn_start', message: 'Say only: ok', messageId: queued },
    ]);
    expect(events.filter((e) => e.type === 'turn_end')).toEqual([
      { type: 'turn_end', reason: 'interrupted' },
      { type: 'turn_end', reason: 'completed' },
    ]);
    const replayed = replayTaskLog(events);
    expect(replayed).toEqual(run.live(1));
    expect(replayed.queued).toEqual([]);
    expect(replayed.lastTurnEnd).toBe('completed');
    expect(replayed.blocks.filter((b) => b.type === 'message' && b.role === 'user').map((b) => b.type === 'message' && b.text))
      .toEqual(['Do the task', 'Say only: ok']);
  });

  it.each([
    ['allowed', 'permission-task-allowed', { decision: 'allow' as const }, 'granted'],
    ['denied with a note', 'permission-task-denied', { decision: 'deny' as const, note: 'Not this one — write it to notes/c.txt instead.' }, 'denied'],
  ])('replays a runner approval %s as the card surfaces drew', async (_label, answered, decision, status) => {
    const approvals = new PendingApprovals();
    const first = answered === 'permission-task-denied' ? 'permission-task-deny' : 'permission-task';
    const run = recording([fixture('claude-code', first), fixture('claude-code', answered)], (inner) => new RunnerApprovals(approvals).wrap(inner));
    const session = await run.spawn('default');

    await vi.waitFor(() => expect(approvals.outstanding()).toHaveLength(1));
    approvals.resolve(approvals.outstanding()[0].id, decision);
    await vi.waitFor(() => expect(saved(1).some((e) => e.type === 'approval_decided')).toBe(true));
    session.kill();

    const replayed = replayTaskLog(saved(1));
    expect(replayed).toEqual(run.live(1));
    const cards = replayed.blocks.filter((b) => b.type === 'approval');
    expect(cards[0]).toMatchObject({ kind: 'runner_tool', status, ...('note' in decision ? { note: decision.note } : {}) });
  });
});

describe('a long tool result', () => {
  it('is trimmed to the cap before it is saved or streamed, so the file and the live view agree', async () => {
    const output = Array.from({ length: 500 }, (_, i) => `line ${i + 1}`).join('\n');
    const transcript = fixture('claude-code', 'task-marker').replace('"content":"hello","is_error":false', `"content":${JSON.stringify(output)},"is_error":false`);
    const run = recording([transcript]);
    const session = await run.spawn();
    await turnEnds(session, 1);
    session.kill();

    const result = saved(1).find((e) => e.type === 'tool_result');
    expect(result).toMatchObject({ type: 'tool_result', omittedLines: 400 });
    const kept = result?.type === 'tool_result' ? result.output.split('\n') : [];
    expect(kept).toHaveLength(60 + 1 + 40);
    expect(kept[0]).toBe('line 1');
    expect(kept[60]).toBe('… 400 lines omitted …');
    expect(kept.at(-1)).toBe('line 500');

    const live = run.live(1);
    expect(replayTaskLog(saved(1))).toEqual(live);
    const tool = live.blocks.find((b) => b.type === 'tool');
    expect(tool?.type === 'tool' ? tool.output : '').toContain('… 400 lines omitted …');
    const fileBytes = fs.statSync(path.join(sessionDataDir(where.sessionId, baseDir), 'tasks', TASK, '1.jsonl')).size;
    expect(fileBytes).toBeLessThan(output.length);
  });
});

describe('every attempt of a task', () => {
  it('keeps its own file, and an earlier attempt still replays as it was drawn', async () => {
    const run = recording([fixture('claude-code', 'task-marker'), fixture('claude-code', 'task-no-marker')]);
    const first = await run.spawn();
    await turnEnds(first, 1);
    first.kill();
    const second = await run.spawn();
    await turnEnds(second, 1);
    second.kill();

    expect(listTaskLogAttempts(where, TASK)).toEqual([1, 2]);
    expect(replayTaskLog(saved(1))).toEqual(run.live(1));
    expect(replayTaskLog(saved(2))).toEqual(run.live(2));
    const agentText = (attempt: number) => replayTaskLog(saved(attempt)).blocks
      .flatMap((b) => (b.type === 'message' && b.role === 'agent' ? [b.text] : []));
    expect(agentText(1).join('')).toContain('<<<ORDEWELL_DONE_test-1234>>>');
    expect(agentText(2).join('')).toContain('Hi! Ready to help you with your project.');
  });
});

describe('a log that cannot be created', () => {
  it('still streams the attempt, unnumbered, and warns once rather than on every batch', async () => {
    const session = new FakeRunnerSession('s1', TASK);
    const sent: SessionMessage[] = [];
    const warn = vi.fn();
    const open = vi.fn(() => { throw new Error('EACCES: permission denied'); });
    const recorder = new TaskLogRecorder({ broadcast: (m) => sent.push(m), location: () => where, open, flushMs: 1, logger: { warn } });
    const inner: IRunner = { spawn: vi.fn(async () => session), stop: vi.fn(), stopAll: vi.fn(), activeCount: 0 };
    await recorder.wrap(inner).spawn({ taskId: TASK, runner: 'claude-code', prompt: 'Do it', cwd: '/repo' });

    session.emitEvent({ type: 'assistant_text', text: 'Done.' });
    session.emitEvent({ type: 'turn_end', reason: 'completed' });
    session.emitEvent({ type: 'turn_end', reason: 'completed' });

    expect(sent.filter((m): m is TaskLogMessage => m.type === 'task_log').map((m) => m.attempt)).toEqual([0, 0]);
    expect(open).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(listTaskLogAttempts(where, TASK)).toEqual([]);
  });
});


describe('undelivered messages in the saved task log', () => {
  it('replays the notice and removes each message from the queue after a kill', async () => {
    const run = recording([() => {}]);
    const session = await run.spawn();
    await vi.waitFor(() => expect(run.spawned.processes[0].written).toHaveLength(2));
    const first = session.sendMessage('use Postgres');
    const second = session.sendMessage('add tests');
    session.kill();
    const events = saved(1);
    expect(events.filter((event) => event.type === 'message_undelivered')).toEqual([
      { type: 'message_undelivered', messageId: first, text: 'use Postgres' },
      { type: 'message_undelivered', messageId: second, text: 'add tests' },
    ]);
    const replayed = replayTaskLog(events);
    expect(replayed).toEqual(run.live(1));
    expect(replayed.queued).toEqual([]);
    expect(replayed.blocks.filter((block) => block.type === 'message' && block.role === 'system').map((block) => block.type === 'message' ? block.text : '')).toEqual([
      'use Postgres · not delivered', 'add tests · not delivered',
    ]);
  });
});

describe('a message read mid-turn in the saved task log (ADR-0023)', () => {
  it('replays the message where Codex read it, inside the one turn, as the surfaces drew it live', async () => {
    const rpc = (msg: Record<string, unknown>) => `${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`;
    const item = (method: string, body: Record<string, unknown>) => rpc({ method, params: { threadId: 'thr-task-1', turnId: 'turn-a', item: body } });
    const command = { id: 'cmd-1', type: 'commandExecution', command: 'sleep 20', cwd: '/repo' };
    const spawned = fakeSpawn([
      fixture('codex', 'handshake'),
      fixture('codex', 'task-thread'),
      (_written, proc) => proc.emitStdout(rpc({ method: 'turn/started', params: { threadId: 'thr-task-1', turn: { id: 'turn-a', status: 'inProgress', items: [] } } }) + item('item/started', command)),
      (written, proc) => {
        const steer = JSON.parse(written) as { id: number; params: { clientUserMessageId: string } };
        proc.emitStdout(rpc({ id: steer.id, result: { turnId: 'turn-a' } }));
        // Codex accepts at once and delivers once the command in flight completes.
        setTimeout(() => proc.emitStdout(
          item('item/completed', { ...command, aggregatedOutput: '', exitCode: 0 })
          + item('item/started', { id: 'um-1', type: 'userMessage', clientId: steer.params.clientUserMessageId, content: [] })
          + item('item/completed', { id: 'am-1', type: 'agentMessage', text: 'Using Postgres.' })
          + rpc({ method: 'turn/completed', params: { threadId: 'thr-task-1', turn: { id: 'turn-a', status: 'completed', items: [] } } }),
        ), 5);
      },
    ]);
    const structured = new StructuredRunner({
      process: { spawn: spawned.spawn, resolvePath: async () => '/usr/bin', platform: 'linux', isDirectory: () => true, exists: () => true },
    });
    const sent: SessionMessage[] = [];
    const recorder = new TaskLogRecorder({ broadcast: (m) => sent.push(m), location: () => where, flushMs: 1 });
    const session = await recorder.wrap(structured).spawn({ taskId: TASK, runner: 'codex', prompt: 'Do the task', cwd: '/repo', registry: new RunnerRegistry(), mode: 'fullAccess' });

    const ended = turnEnds(session, 1);
    await vi.waitFor(() => expect(sent.some((m) => m.type === 'task_log' && m.events.some((e) => e.type === 'tool_call'))).toBe(true));

    const id = session.sendMessage('use Postgres');
    await ended;
    await vi.waitFor(() => expect(saved(1).some((e) => e.type === 'turn_end')).toBe(true));
    session.kill();

    const events = saved(1);
    expect(events.filter((e) => e.type.startsWith('message_') || e.type.startsWith('turn_'))).toEqual([
      { type: 'turn_start', message: 'Do the task' },
      { type: 'message_queued', messageId: id, text: 'use Postgres' },
      { type: 'message_handed_over', messageId: id },
      { type: 'message_delivered', messageId: id, text: 'use Postgres' },
      { type: 'turn_end', reason: 'completed' },
    ]);
    const live = sent
      .filter((m): m is TaskLogMessage => m.type === 'task_log' && m.attempt === 1)
      .reduce((view, m) => m.events.reduce(reduceTaskLog, view), EMPTY_TASK_LOG);
    const replayed = replayTaskLog(events);
    expect(replayed).toEqual(live);
    expect(replayed.queued).toEqual([]);
    expect(replayed.blocks.map((b) => (b.type === 'message' ? `${b.role}:${b.text}` : b.type)))
      .toEqual(['user:Do the task', 'tool', 'user:use Postgres', 'agent:Using Postgres.']);
  });
});
