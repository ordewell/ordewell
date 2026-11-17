import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { AcpAdapter } from '../harness/AcpAdapter';
import type { AcpProfile } from '../harness/acpProfiles';
import type { AgentEvent, AgentProcessDeps } from '../harness/AgentAdapter';
import { resolveTaskRunnerFlags } from '../../plugins/resolveArgs';
import type { RunnerManifest } from '../../plugins/types';
import { mcpClientConfig } from '../mcp';
import { TaskOrchestrator } from '../TaskOrchestrator';
import { VerdictEngine } from '../VerdictEngine';
import { runningLongThreshold, type RunningLongFacts } from '../RunningLong';
import { BufferedTaskOutputSource } from '../BufferedTaskOutputSource';
import { RunnerRegistry } from '../../plugins/RunnerRegistry';
import { createTask } from '../../models/Task';
import type { UsageRecord } from '../../models/Usage';
import type { IRunner, IRunnerSession } from '../../interfaces/IRunner';
import type { RunnerSpawnOptions } from '../AbstractRunner';
import { fakeConfig, FakeRunnerSession } from '../../testing';
import { fakeAcpSpawn } from './fakeAcpAgent';
import { fakeNotification } from './sessionTestKit';

/**
 * What each runner Ordewell drives itself reports of a compaction reaches the
 * supervision every harness has (ADR-0018 C3, W1): the runner is told its
 * brief again, and running long sees it. An ACP agent says nothing of one, so
 * its events here are the ones its adapter reads from the meter falling.
 */

const MANIFEST = {
  name: 'fake-acp',
  displayName: 'Fake Agent',
  runner: { command: 'fake-agent' },
  features: { modeSettings: { approvals: { auto: 'auto' } } },
  modelDiscovery: { method: 'hardcoded', models: [] },
  modes: [{ id: 'ask', label: 'Ask', description: 'Asks before it acts.', safe: true }],
  auth: { statusArgs: ['status'], loginArgs: ['login'] },
} as unknown as RunnerManifest;
const PROFILE: AcpProfile = { manifest: MANIFEST, args: ['--acp'], ordewellTool: () => null, instructions: { kind: 'prompt' } };

const usage = (used: number) => ({ notify: 'session/update', params: { sessionId: 'sess-1', update: { sessionUpdate: 'usage_update', used, size: 200_000 } } }) as const;

/** The events an ACP adapter reports over two turns in which the agent compacted its context on its own. */
/** The events supervision reads of a compaction; the rest StructuredRunner handles itself. */
type MeterEvent = Extract<AgentEvent, { type: 'usage' | 'compaction' }>;
const isMeterEvent = (event: AgentEvent): event is MeterEvent => event.type === 'usage' || event.type === 'compaction';

async function acpCompacting(): Promise<MeterEvent[]> {
  const spawned = fakeAcpSpawn([
    { expect: 'initialize', reply: { protocolVersion: 1, agentCapabilities: { mcpCapabilities: { http: true } } } },
    { expect: 'session/new', reply: { sessionId: 'sess-1' } },
    { expect: 'session/prompt' }, usage(150_000), { answer: { stopReason: 'end_turn' }, to: 'session/prompt' },
    { expect: 'session/prompt' }, usage(170_000), usage(24_000), { answer: { stopReason: 'end_turn' }, to: 'session/prompt' },
  ]);
  const deps: AgentProcessDeps = {
    spawn: spawned.spawn,
    fetch: (async () => { throw new Error('no HTTP in this test'); }) as unknown as typeof fetch,
    resolvePath: async () => '/usr/bin',
    platform: 'linux',
    isDirectory: () => true,
    exists: () => true,
    workspaceEnv: async () => ({}),
  };
  const adapter = new AcpAdapter(deps, PROFILE);
  try {
    await adapter.start({
      kind: 'task', cwd: '/repo', mode: 'ask', flags: resolveTaskRunnerFlags(MANIFEST, { mode: 'ask' }),
      mcp: mcpClientConfig({ url: 'http://127.0.0.1:4555/mcp', token: 'tok' }),
    });
    const events: AgentEvent[] = [];
    for (const message of ['go', 'go on']) await adapter.send(message, (event) => events.push(event));
    return events.filter(isMeterEvent);
  } finally {
    adapter.dispose();
  }
}

/** What the built-in runner's compactor reports of one compaction (compaction.ts `announce`): the event, then the meter's reset. */
const builtInCompacting = (): MeterEvent[] => {
  const reset: UsageRecord = { source: 'ordewell', model: 'openrouter:acme/m', compacted: true, contextTokens: 9_000, contextWindow: 200_000 };
  return [
    { type: 'usage', record: { source: 'ordewell', model: 'openrouter:acme/m', contextTokens: 160_000, contextWindow: 200_000 } },
    { type: 'compaction', trigger: 'auto', preTokens: 170_000, postTokens: 9_000 },
    { type: 'usage', record: reset },
  ];
};

const runners: Array<[string, () => Promise<MeterEvent[]> | MeterEvent[]]> = [['an ACP runner', acpCompacting], ['the built-in runner', builtInCompacting]];

describe('a compaction on an ACP runner or the built-in runner', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] }));
  afterEach(() => vi.useRealTimers());

  it.each(runners)('on %s, is flagged as running long when Ordewell set no window', async (_, compacting) => {
    const events = await compacting();
    const engine = new VerdictEngine({ runningLongThreshold: () => runningLongThreshold([]) });
    const flags: RunningLongFacts[] = [];
    engine.onRunningLong((_taskId, facts) => flags.push(facts));
    const session = new FakeRunnerSession();
    engine.watch(createTask({ id: 't1', title: 'do thing', taskMode: 'build' }), session);

    for (const event of events) session.emitEvent(event);

    expect(flags.map((f) => [f.reason, f.compactions])).toEqual([['compaction', 1]]);
  });
});

describe('a runner that compacted on its own is told its brief again', () => {
  it.each(runners)('on %s', async (_, compacting) => {
    vi.useRealTimers();
    const events = await compacting();
    const sessions: FakeRunnerSession[] = [];
    const runner = {
      spawn: vi.fn(async (o: RunnerSpawnOptions): Promise<IRunnerSession> => {
        const session = new FakeRunnerSession(`s${sessions.length + 1}`, o.taskId, `native-${o.taskId}`);
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

    for (const event of events) sessions[0].emitEvent(event);

    const reminders = sessions[0].queued().filter((m) => m.from === 'ordewell');
    expect(reminders).toHaveLength(1);
    expect(reminders[0].text).toContain('Parse objects and arrays.');
  });
});
