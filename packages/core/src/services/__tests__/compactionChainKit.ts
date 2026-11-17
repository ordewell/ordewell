import { expect, vi } from 'vitest';
import { TaskOrchestrator } from '../TaskOrchestrator';
import { VerdictEngine } from '../VerdictEngine';
import { runningLongThreshold, type RunningLongFacts } from '../RunningLong';
import { createTask } from '../../models/Task';
import { BufferedTaskOutputSource } from '../BufferedTaskOutputSource';
import { RunnerRegistry } from '../../plugins/RunnerRegistry';
import { fakeConfig, FakeRunnerSession } from '../../testing';
import { fakeNotification } from './sessionTestKit';
import type { IRunner, IRunnerSession } from '../../interfaces/IRunner';
import type { AgentEvent } from '../harness/AgentAdapter';
import type { CompactionPoint } from '../../models/Usage';

/** Which compaction running long first flags, and the compaction window it names there, where one is in force. */
export interface Flagged { at: number; window?: number }

/**
 * What a harness adapter reported for one automatic compaction, carried
 * through what a StructuredRunner session passes on unchanged (its events and
 * the adapter's compactWindowTokens and compactStartTokens) to the readers that
 * act on it: the reminder of the brief (Attempts), the running-long clock
 * (VerdictEngine) and the context meter's stored start. Returns that stored
 * `{ windowTokens, startsAtTokens }`, or undefined where no window is in force.
 * `flagged` is what running long should make of it, by default the first
 * compaction with no window and the third under one.
 */
export async function expectCompactionChain(
  adapterEvents: readonly AgentEvent[],
  compactWindowTokens: number | undefined,
  compactStartTokens?: number,
  flagged: Flagged = compactWindowTokens === undefined ? { at: 1 } : { at: 3, window: compactWindowTokens },
): Promise<CompactionPoint | undefined> {
  const compaction = adapterEvents.find((e): e is Extract<AgentEvent, { type: 'compaction' }> => e.type === 'compaction' && e.trigger === 'auto');
  expect(compaction).toBeDefined();
  if (!compaction) return undefined;

  const sessions: FakeRunnerSession[] = [];
  const runner = {
    spawn: vi.fn(async (): Promise<IRunnerSession> => {
      const session = new FakeRunnerSession(`s${sessions.length + 1}`, 't1', 'native-t1');
      session.compactWindowTokens = compactWindowTokens;
      session.compactStartTokens = compactStartTokens;
      sessions.push(session);
      return session;
    }),
    stop: vi.fn(),
    stopAll: vi.fn(),
    activeCount: 0,
  } satisfies IRunner;
  const orchestrator = TaskOrchestrator.compose({
    config: fakeConfig({ worktreeIsolation: false }),
    notifications: fakeNotification(),
    runner,
    output: new BufferedTaskOutputSource(),
    registry: new RunnerRegistry(),
    workspaceRoot: () => '/repo',
    workspaceEnv: async () => ({ env: {}, blockedEnvrc: null, refused: [], trackedEnvFile: null }),
  });
  orchestrator.loadPlan([createTask({ id: 't1', order: 1, title: 'Parse JSON', prompt: 'Parse objects and arrays.' })]);
  await orchestrator.forceStartTask('t1');
  const meter = orchestrator.storeInstance.get('t1')!.attemptUsage!.at(-1)!.compaction;
  sessions[0].emitEvent(compaction);
  const reminders = sessions[0].queued().filter((m) => m.from === 'ordewell');
  expect(reminders).toHaveLength(1);
  expect(reminders[0].text).toContain('Parse objects and arrays.');

  // Under a window Ordewell set below 200,000, compactions are routine until the third (RunningLong); with none, the first is flagged.
  const engine = new VerdictEngine({ runningLongThreshold: () => runningLongThreshold([]) });
  const flags: RunningLongFacts[] = [];
  engine.onRunningLong((_taskId, facts) => flags.push(facts));
  const session = new FakeRunnerSession();
  session.compactWindowTokens = compactWindowTokens;
  session.compactStartTokens = compactStartTokens;
  engine.watch(createTask({ id: 't2', title: 'watched', taskMode: 'build' }), session);
  for (let i = 1; i <= flagged.at; i += 1) {
    expect(flags).toEqual([]);
    session.emitEvent(compaction);
  }
  expect(flags).toEqual([expect.objectContaining({ reason: 'compaction', compactions: flagged.at })]);
  expect(flags[0].compactionWindow).toBe(flagged.window);
  engine.reset();
  return meter;
}
