import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { TaskOrchestrator } from '../TaskOrchestrator';
import { createTask, type Task } from '../../models/Task';
import { BufferedTaskOutputSource } from '../BufferedTaskOutputSource';
import { RunnerRegistry } from '../../plugins/RunnerRegistry';
import { fakeConfig, FakeRunnerSession, flushMicrotasks } from '../../testing';
import { fakeNotification } from './sessionTestKit';
import type { IRunner, IRunnerSession } from '../../interfaces/IRunner';
import type { RunnerSpawnOptions } from '../AbstractRunner';

/**
 * Claude Code asked for `--permission-mode auto` where Auto is not offered
 * starts in `default` and says nothing (ADR-0018 B2): the task fails in the
 * user's words with the mode it did start in offered, and every task that
 * would meet the same refusal is held before it starts, told once for the run.
 */

// The adapter's words for it, as ClaudeCodeAdapter emits them.
const REFUSED = 'Claude Code started in Ask before edits mode, not Auto, the mode this task asked for. Claude Code offers Auto only on some models and accounts, and it does not say why it was not offered here.';

function setup(maxParallelSessions = 1) {
  const sessions: FakeRunnerSession[] = [];
  const runner = {
    spawn: vi.fn(async (o: RunnerSpawnOptions): Promise<IRunnerSession> => {
      const session = new FakeRunnerSession(`s${sessions.length + 1}`, o.taskId, `native-${sessions.length + 1}`);
      sessions.push(session);
      return session;
    }),
    stop: vi.fn(),
    stopAll: vi.fn(),
    activeCount: 0,
  } satisfies IRunner;
  const notifications = fakeNotification();
  const orchestrator = TaskOrchestrator.compose({
    config: fakeConfig({ maxParallelSessions }),
    notifications,
    runner,
    output: new BufferedTaskOutputSource(),
    registry: new RunnerRegistry(),
    workspaceRoot: () => '/repo',
    workspaceEnv: async () => ({ env: {}, blockedEnvrc: null, refused: [], trackedEnvFile: null }),
    runSettings: () => ({ mergeAtGatesAutomatically: false }),
  });
  const task = (id: string): Readonly<Task> => orchestrator.storeInstance.get(id)!;
  return { orchestrator, sessions, spawn: runner.spawn, notifications, task };
}

/** The refusal as the structured transport delivers it: the turn's error, its failed end, then the process the adapter let go exiting. */
function refuse(session: FakeRunnerSession): void {
  session.emitEvent({ type: 'error', message: REFUSED, modeRefused: { asked: 'auto', started: 'default' } });
  session.emitOutput(`${REFUSED}\n`);
  session.emitTurnEnd('failed');
  session.emitExit(0);
}

async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 50 && !condition(); i += 1) await flushMicrotasks();
  expect(condition()).toBe(true);
}

const claudeTask = (overrides: Partial<Task>): Task => createTask({ assignedRunner: 'claude-code', taskMode: 'auto', prompt: 'do it', ...overrides });

beforeEach(() => {
  vi.useFakeTimers({ now: new Date('2026-11-21T10:00:00Z') });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('a task its runner started in another mode', () => {
  it('fails in the user\'s words, offering the mode the runner started in, and leaves the task\'s mode as planned', async () => {
    const { orchestrator, sessions, spawn, task } = setup();
    orchestrator.loadPlan([claudeTask({ id: 't1', order: 1, title: 'Only' })]);
    await orchestrator.forceStartTask('t1');

    refuse(sessions[0]);
    await until(() => task('t1').status === 'failed');

    expect(task('t1').verdict?.reason).toBe(`${REFUSED} Switch this task to Ask before edits and retry it.`);
    expect(task('t1').verdict?.modeRefusal).toEqual({
      runner: 'claude-code',
      runnerLabel: 'Claude Code',
      asked: { mode: 'auto', label: 'Auto' },
      offered: { mode: 'default', label: 'Ask before edits' },
    });
    // Nothing switches the mode but the user (ADR-0001): no new start, no other mode.
    expect(task('t1').taskMode).toBe('auto');
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('holds every task that would meet the same refusal before it starts, and says so once for the run', async () => {
    const { orchestrator, sessions, spawn, notifications, task } = setup();
    orchestrator.loadPlan([
      claudeTask({ id: 't1', order: 1, title: 'First' }),
      claudeTask({ id: 't2', order: 2, title: 'Second' }),
      claudeTask({ id: 't3', order: 3, title: 'Edits', taskMode: 'acceptEdits' }),
      claudeTask({ id: 't4', order: 4, title: 'Other model', assignedModel: { modelId: 'haiku', modelLabel: 'Haiku' } }),
      claudeTask({ id: 't5', order: 5, title: 'Fifth' }),
    ]);
    await orchestrator.approveReview();
    expect(spawn.mock.calls[0][0].taskId).toBe('t1');

    refuse(sessions[0]);
    await until(() => spawn.mock.calls.length === 2);

    // Same runner, mode and model: held. Another mode or another model may run, so it does.
    expect(orchestrator.holdReason('t2')).toBe('Claude Code did not start #1 in Auto mode, so this task would fail the same way: switch it to Ask before edits, or retry it');
    expect(orchestrator.holdReason('t5')).not.toBeNull();
    expect(orchestrator.holdReason('t3')).toBeNull();
    expect(orchestrator.holdReason('t4')).toBeNull();
    expect(spawn.mock.calls[1][0].taskId).toBe('t3');
    expect(task('t2').status).toBe('pending');
    expect(task('t2').taskMode).toBe('auto');

    expect(notifications.error).toHaveBeenCalledTimes(1);
    expect(notifications.error).toHaveBeenCalledWith(expect.stringContaining('Tasks #2 "Second" and #5 "Fifth" use Auto on Claude Code too, so they are on hold rather than failing the same way.'));
  });

  it('tells a second refusal of the same kind on its row, not again in a notice', async () => {
    const { orchestrator, sessions, notifications, task } = setup(2);
    orchestrator.loadPlan([
      claudeTask({ id: 't1', order: 1, title: 'First' }),
      claudeTask({ id: 't2', order: 2, title: 'Second' }),
    ]);
    await orchestrator.approveReview();
    await until(() => sessions.length === 2);

    refuse(sessions[0]);
    await until(() => task('t1').status === 'failed');
    refuse(sessions[1]);
    await until(() => task('t2').status === 'failed');

    expect(task('t2').verdict?.modeRefusal?.offered?.mode).toBe('default');
    expect(notifications.error).toHaveBeenCalledTimes(1);
  });
});

describe('a failed task, told in the user\'s words', () => {
  /** Its first sentence: what a toast or a row shows before anything is opened. */
  const firstSentence = (text: string) => text.split(/(?<=\.)\s/)[0];

  it.each([
    [0, 'Task "Only" failed. The runner stopped before reporting the task done, so nothing it did counts yet. Open its chat to see where it stopped, then retry it.'],
    [3, 'Task "Only" failed. The runner stopped with exit code 3 before reporting the task done, so nothing it did counts yet. Open its chat to see where it stopped, then retry it.'],
  ])('says a runner that exited with code %i without reporting stopped early, once, and what to do', async (code, said) => {
    const { orchestrator, sessions, notifications, task } = setup();
    orchestrator.loadPlan([createTask({ id: 't1', order: 1, title: 'Only', prompt: 'do it' })]);
    await orchestrator.forceStartTask('t1');

    sessions[0].emitExit(code);
    await until(() => task('t1').status === 'failed');

    expect(notifications.error).toHaveBeenCalledWith(said);
    const reason = task('t1').verdict?.reason ?? '';
    expect(firstSentence(reason)).not.toMatch(/task_complete|verdict|verification/i);
    // The evidence keeps its exact terms for whoever opens the checks.
    expect(task('t1').verdict?.checks.map((c) => c.name)).toEqual(['task_complete', 'exit_code']);
  });
});
