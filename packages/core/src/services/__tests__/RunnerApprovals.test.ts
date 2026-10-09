import { describe, it, expect, vi } from 'vitest';
import { RunnerApprovals } from '../RunnerApprovals';
import { PendingApprovals } from '../PendingApprovals';
import type { SessionMessage } from '../SessionMessage';
import type { RunnerSpawnOptions } from '../AbstractRunner';
import type { IRunner, IRunnerSession } from '../../interfaces/IRunner';
import { createTask, type LegacyPlanState } from '../../models/Task';
import { FakeRunnerSession } from '../../testing';
import { makeSession, taskOf } from './sessionTestKit';
import { StructuredRunner } from '../StructuredRunner';
import { TaskLogRecorder } from '../TaskLogRecorder';
import { RunnerRegistry } from '../../plugins/RunnerRegistry';
import { EMPTY_TASK_LOG, reduceTaskLog } from '../../conversation/taskLog';
import { fakeSpawn, fixture } from './harnessTestKit';

/**
 * A structured task's tool requests (ADR-0018, A1): carried to the session's
 * one approval seam, answered through `resolveApproval` with the whole
 * decision, and denied before any attempt's runner is torn down.
 */

const spawnOpts = { taskId: 't1', runner: 'claude-code', prompt: 'Do it', cwd: '/repo' };
const WRITE = { file_path: '/repo/a.txt', content: 'a' };
const SUGGESTIONS = [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }];

function handing(session: IRunnerSession): IRunner & { stop: ReturnType<typeof vi.fn>; stopAll: ReturnType<typeof vi.fn> } {
  return { spawn: vi.fn(async () => session), stop: vi.fn(), stopAll: vi.fn(), activeCount: 0 };
}

describe('RunnerApprovals', () => {
  async function bridged() {
    const approvals = new PendingApprovals({ timeoutMs: 10 });
    const bridge = new RunnerApprovals(approvals);
    const task = new FakeRunnerSession('s1', 't1');
    const inner = handing(task);
    const runner = bridge.wrap(inner);
    await runner.spawn(spawnOpts);
    return { approvals, bridge, task, inner, runner };
  }

  it('asks the session\'s seam as the task, with no timeout and the grant it can offer', async () => {
    vi.useFakeTimers();
    try {
      const { approvals, bridge, task } = await bridged();
      task.requestPermission('s1-perm-1', 'Write', WRITE, SUGGESTIONS);
      await vi.advanceTimersByTimeAsync(60 * 60_000);

      expect(approvals.outstanding()).toEqual([{
        id: 's1-perm-1',
        createdAt: expect.any(String),
        request: {
          kind: 'runner_tool', subject: 'Write(/repo/a.txt)', scope: 'Write', detail: JSON.stringify(WRITE), taskId: 't1', allowForTask: true,
        },
      }]);
      expect(bridge.waiting('t1')).toBe(1);
      expect(bridge.waiting('t2')).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    [{ decision: 'allow' as const }],
    [{ decision: 'allowForTask' as const }],
    [{ decision: 'deny' as const, note: 'write it under notes/' }],
  ])('hands the answer %o to the runner that asked', async (decision) => {
    const { approvals, bridge, task } = await bridged();
    task.requestPermission('s1-perm-1', 'Write', WRITE, SUGGESTIONS);
    expect(approvals.resolve('s1-perm-1', decision)).toBe(true);
    expect(task.answers).toEqual([{ id: 's1-perm-1', decision }]);
    expect(bridge.waiting('t1')).toBe(0);
  });

  it('puts nothing on the seam for a request the task\'s mode already answered', async () => {
    const { approvals, bridge, task } = await bridged();
    task.emitEvent({ type: 'permission_request', id: 's1-perm-1', name: 'bash', detail: '{}', decided: { decision: 'allow' } });
    task.emitEvent({ type: 'permission_decided', id: 's1-perm-1', decision: { decision: 'allow' } });
    expect(approvals.outstanding()).toEqual([]);
    expect(bridge.waiting('t1')).toBe(0);
  });

  it('offers no grant for the task when the runner suggested none', async () => {
    const { approvals, task } = await bridged();
    task.requestPermission('s1-perm-1', 'Bash', { command: 'npm test' });
    expect(approvals.outstanding()[0].request).toMatchObject({ subject: 'Bash(npm test)', allowForTask: false });
    approvals.resolve('s1-perm-1', { decision: 'allowForTask' });
    expect(task.answers[0].decision).toEqual({ decision: 'allow' });
  });

  it('denies a task\'s open requests before its runner is stopped', async () => {
    const { approvals, task, inner, runner } = await bridged();
    task.requestPermission('s1-perm-1', 'Write', WRITE);
    task.requestPermission('s1-perm-2', 'Bash', { command: 'npm test' });
    let answeredAtStop = -1;
    inner.stop.mockImplementation(() => { answeredAtStop = task.answers.length; });

    runner.stop('s1');
    expect(answeredAtStop).toBe(2);
    expect(task.answers.map((a) => a.decision.decision)).toEqual(['deny', 'deny']);
    expect(approvals.outstanding()).toEqual([]);
  });

  it('denies every runner request on stopAll, and leaves the planner\'s alone', async () => {
    const { approvals, task, inner, runner } = await bridged();
    task.requestPermission('s1-perm-1', 'Write', WRITE);
    const planner = approvals.ask({ kind: 'shell_command', subject: 'npm test', scope: 'npm test' });
    let answeredAtStop = -1;
    inner.stopAll.mockImplementation(() => { answeredAtStop = task.answers.length; });

    runner.stopAll();
    expect(answeredAtStop).toBe(1);
    expect(approvals.outstanding().map((p) => p.request.kind)).toEqual(['shell_command']);
    approvals.clear();
    await planner;
  });

  it('takes a request the runner withdrew off the seam, without answering it', async () => {
    const { approvals, bridge, task } = await bridged();
    task.requestPermission('s1-perm-1', 'Write', WRITE);
    task.withdrawPermission('s1-perm-1');
    expect(approvals.outstanding()).toEqual([]);
    expect(bridge.waiting('t1')).toBe(0);
    expect(task.answers).toEqual([]);
  });

  it('lets nothing outlive the session that asked', async () => {
    const { approvals, task } = await bridged();
    task.requestPermission('s1-perm-1', 'Write', WRITE);
    task.emitExit(0);
    expect(approvals.outstanding()).toEqual([]);
  });

  it('keeps an attempt with no permission requests free of approvals', async () => {
    const approvals = new PendingApprovals();
    const session = new FakeRunnerSession('s1', 't1');
    const inner = handing(session);
    expect(await new RunnerApprovals(approvals).wrap(inner).spawn(spawnOpts)).toBe(session);
    expect(approvals.outstanding()).toEqual([]);
  });
});

describe('a session\'s runner approvals', () => {
  function plan(): LegacyPlanState {
    return {
      tasks: [createTask({ id: 't1', order: 1, title: 'Only', prompt: 'do it', assignedRunner: 'claude-code' })],
      generatedAt: new Date().toISOString(),
      status: 'approved',
      runners: ['claude-code'],
      lastUpdated: new Date().toISOString(),
    };
  }

  async function running() {
    const sessions: FakeRunnerSession[] = [];
    const runner: IRunner & { stop: ReturnType<typeof vi.fn>; stopAll: ReturnType<typeof vi.fn> } = {
      spawn: vi.fn(async (opts: RunnerSpawnOptions) => {
        const session = new FakeRunnerSession(`s${sessions.length + 1}`, opts.taskId);
        sessions.push(session);
        return session;
      }),
      stop: vi.fn(),
      stopAll: vi.fn(),
      activeCount: 0,
    };
    const sent: SessionMessage[] = [];
    const session = makeSession({ runner, broadcast: (m) => sent.push(m) });
    session.loadPlan(plan(), 'Goal', '/repo');
    await session.executePlan();
    await vi.waitFor(() => expect(sessions).toHaveLength(1));
    return { session, sessions, sent, runner };
  }

  const statusOf = (sent: SessionMessage[]) => {
    const last = sent.filter((m): m is Extract<SessionMessage, { type: 'status_update' }> => m.type === 'status_update').at(-1);
    return last?.tasks.find((t) => t.id === 't1');
  };
  const logged = (sent: SessionMessage[]) =>
    sent.flatMap((m) => (m.type === 'task_log' ? m.events : [])).filter((e) => e.type.startsWith('approval_'));

  it('keeps the task in progress, says it waits for approval, and logs the request — never a planner card', async () => {
    const { session, sessions, sent } = await running();
    sessions[0].requestPermission('s1-perm-1', 'Write', WRITE, SUGGESTIONS);

    expect(statusOf(sent)).toMatchObject({ status: 'in_progress', awaitingApproval: 1 });
    expect(taskOf(session, 't1')?.status).toBe('in_progress');
    expect(sent.some((m) => m.type === 'approval_request' || m.type === 'approval_settled')).toBe(false);
    expect(session.outstandingApprovals()).toEqual([expect.objectContaining({ id: 's1-perm-1', request: expect.objectContaining({ kind: 'runner_tool', taskId: 't1' }) })]);
    expect(logged(sent)).toEqual([
      { type: 'approval_requested', approvalId: 's1-perm-1', tool: 'Write', args: JSON.stringify(WRITE), allowForTask: true },
    ]);
  });

  it('takes the whole decision through resolveApproval, and the task stops waiting', async () => {
    const { session, sessions, sent } = await running();
    sessions[0].requestPermission('s1-perm-1', 'Write', WRITE, SUGGESTIONS);

    expect(session.resolveApproval('s1-perm-1', { decision: 'deny', note: 'not in the repo root' })).toBe(true);
    expect(sessions[0].answers).toEqual([{ id: 's1-perm-1', decision: { decision: 'deny', note: 'not in the repo root' } }]);
    expect(statusOf(sent)).not.toHaveProperty('awaitingApproval');
    expect(logged(sent).at(-1)).toEqual({ type: 'approval_decided', approvalId: 's1-perm-1', decision: 'deny', note: 'not in the repo root' });
    expect(session.resolveApproval('s1-perm-1', true)).toBe(false);
  });

  it.each([
    ['cancel', (s: Awaited<ReturnType<typeof running>>['session']) => s.cancelTask('t1')],
    ['retry', (s: Awaited<ReturnType<typeof running>>['session']) => s.retryTask('t1')],
    ['stop', async (s: Awaited<ReturnType<typeof running>>['session']) => { s.stopExecution(); }],
  ])('denies what the task still waits on when it is %s-ed, before its runner goes', async (_how, end) => {
    const { session, sessions, runner } = await running();
    sessions[0].requestPermission('s1-perm-1', 'Bash', { command: 'npm test' });
    const answeredWhenStopped: number[] = [];
    runner.stop.mockImplementation(() => { answeredWhenStopped.push(sessions[0].answers.length); });
    runner.stopAll.mockImplementation(() => { answeredWhenStopped.push(sessions[0].answers.length); });

    await end(session);
    expect(answeredWhenStopped[0]).toBe(1);
    expect(sessions[0].answers[0].decision).toEqual({ decision: 'deny' });
    expect(session.outstandingApprovals()).toEqual([]);
  });
});

describe('a runner approval through the real Claude adapter', () => {
  it('shows the card, answers Claude in its own shape, and settles the card', async () => {
    const spawned = fakeSpawn([fixture('claude-code', 'permission-task'), fixture('claude-code', 'permission-task-allowed')]);
    const approvals = new PendingApprovals();
    const sent: SessionMessage[] = [];
    const recorder = new TaskLogRecorder({ broadcast: (m) => sent.push(m), location: () => ({ baseDir: '/ws', sessionId: 'sess' }), open: () => ({ attempt: 1, append: () => {} }), flushMs: 1 });
    const structured = new StructuredRunner({
      process: { spawn: spawned.spawn, resolvePath: async () => '/usr/bin', platform: 'linux', isDirectory: () => true, exists: () => true },
    });
    const runner = recorder.wrap(new RunnerApprovals(approvals).wrap(structured));
    const session = await runner.spawn({ ...spawnOpts, registry: new RunnerRegistry(), mode: 'default' });
    const view = () => sent.flatMap((m) => (m.type === 'task_log' ? m.events : [])).reduce(reduceTaskLog, EMPTY_TASK_LOG);

    await vi.waitFor(() => expect(approvals.outstanding()).toHaveLength(1));
    const [pending] = approvals.outstanding();
    expect(view().blocks.find((b) => b.type === 'approval')).toMatchObject({ approvalId: pending.id, status: 'pending', allowForTask: true, subject: 'Write(/repo/a.txt)' });

    approvals.resolve(pending.id, { decision: 'allow' });
    expect(JSON.parse(spawned.processes[0].written[2])).toEqual({
      type: 'control_response',
      response: { subtype: 'success', request_id: '9a948184-6792-4049-85b1-3e837387f618', response: { behavior: 'allow', updatedInput: WRITE } },
    });
    await vi.waitFor(() => expect(view().blocks.find((b) => b.type === 'approval' && b.approvalId === pending.id)).toMatchObject({ status: 'granted' }));

    // The next request is open when the attempt ends; stopping denies it first.
    await vi.waitFor(() => expect(approvals.outstanding()).toHaveLength(1));
    runner.stop(session.id);
    const last = JSON.parse(spawned.processes[0].written[3]) as { response: { response: { behavior: string } } };
    expect(last.response.response.behavior).toBe('deny');
    await vi.waitFor(() => expect(view().blocks.filter((b) => b.type === 'approval').map((b) => b.type === 'approval' && b.status)).toEqual(['granted', 'denied']));
  });
});
