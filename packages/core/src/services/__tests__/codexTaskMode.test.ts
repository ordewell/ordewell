import { afterEach, describe, it, expect, vi } from 'vitest';
import { join, resolve } from 'path';
import { CodexAdapter } from '../harness/CodexAdapter';
import type { AgentEvent, AgentProcessDeps, AgentStartOptions, TaskStartOptions, TaskModeAgentAdapter } from '../harness/AgentAdapter';
import { resolveTaskRunnerFlags } from '../../plugins/resolveArgs';
import { CODEX_MANIFEST } from '../../plugins/builtin/codex.manifest';
import { RunnerRegistry } from '../../plugins/RunnerRegistry';
import { StructuredRunner } from '../StructuredRunner';
import type { StructuredEvent } from '../../interfaces/IRunner';
import { toTaskLogEvent } from '../../models/TaskLog';
import { replayTaskLog } from '../../conversation/taskLog';
import { mcpClientConfig, TASK_COMPLETION_CONTRACT, taskCompletionContract } from '../mcp';
import { CODEX_ORDEWELL } from '../harness/codexOrdewell';
import { CODEX_WINDOWS_SHELL_ADVICE } from '../harness/codexSandbox';
import { ApprovalPolicy, effectiveApprovalMode, type ApprovalModeSetting } from '../ApprovalPolicy';
import { WebReadPolicy } from '../webReadPolicy';
import type { PlacedLaunch, RunnerLaunch } from '../executionLease';
import { codexAnswer, modeIds, fakeSpawn, fixture, type FakeSpawnOptions, type ScriptedReply } from './harnessTestKit';

/**
 * Codex's task mode (ADR-0018, #54) over `codex app-server`. The traffic is
 * shaped by the schema `codex app-server generate-json-schema` emits for
 * codex-cli 0.159.3; field names are the protocol's, not invented here.
 */

interface RpcLine {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code?: number; message?: string };
}

function deps(replies: ScriptedReply[], options: FakeSpawnOptions = {}) {
  const spawned = fakeSpawn(replies, options);
  const processDeps: AgentProcessDeps = {
    spawn: spawned.spawn,
    fetch: (async () => { throw new Error('no HTTP in this test'); }) as unknown as typeof fetch,
    resolvePath: async () => '/usr/bin',
    platform: 'linux',
    isDirectory: () => true,
    exists: () => true,
    workspaceEnv: async () => ({}),
  };
  return { spawned, processDeps };
}

function taskStart(mode: string, overrides: Partial<TaskStartOptions> = {}): TaskStartOptions {
  return {
    kind: 'task',
    cwd: '/repo',
    mode,
    flags: resolveTaskRunnerFlags(CODEX_MANIFEST, { mode, model: overrides.model, thinkingEffort: 'high' }),
    ...overrides,
  };
}

const handshake = (): ScriptedReply[] => [fixture('codex', 'handshake'), codexAnswer('task-thread')];

function line(msg: RpcLine): string {
  return `${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`;
}

/** A changed file as an unplaced task shows it: relative to the worktree, in this host's separators. */
const shownPath = (...parts: string[]): string => join(...parts);

/** The workspace and every directory above it, as this host resolves them (ADR-0028). */
const untrustedRepo = () => ({ [resolve('/repo')]: { trust_level: 'untrusted' }, [resolve('/')]: { trust_level: 'untrusted' } });

function written(lines: string[]): RpcLine[] {
  return lines.map((line) => JSON.parse(line) as RpcLine);
}

function sentNamed(lines: string[], method: string): RpcLine[] {
  return written(lines).filter((msg) => msg.method === method);
}

/** The usage-limit capture's reset is a fixed instant, and a reset already past
 *  is dropped as stale: pin the clock before it so the tests do not expire. */
function beforeRecordedReset(): void {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-17T18:00:00.000Z'));
}
afterEach(() => { vi.useRealTimers(); });

describe('CodexAdapter task start', () => {
  it('opens the task thread in the worktree under the manifest\'s agent settings', async () => {
    const { spawned, processDeps } = deps(handshake());
    const adapter = new CodexAdapter(processDeps);
    await adapter.start(taskStart('agent', { cwd: '/worktrees/task-4', model: 'gpt-5.5' }));

    expect(spawned.lastArgs()).toEqual(['app-server', '-c', 'features.memories=false']);
    const [threadStart] = sentNamed(spawned.processes[0].written, 'thread/start');
    expect(threadStart.params).toEqual({
      cwd: '/worktrees/task-4',
      model: 'gpt-5.5',
      sandbox: 'workspace-write',
      approvalPolicy: 'on-request',
      approvalsReviewer: 'auto_review',
    });
    expect(adapter.nativeSessionId()).toBe('thr-task-1');
    adapter.dispose();
  });

  it('runs full access with no sandbox and nobody asked, and no reviewer', async () => {
    const { spawned, processDeps } = deps(handshake());
    const adapter = new CodexAdapter(processDeps);
    await adapter.start(taskStart('fullAccess'));

    const [threadStart] = sentNamed(spawned.processes[0].written, 'thread/start');
    expect(threadStart.params).toEqual({ cwd: '/repo', sandbox: 'danger-full-access', approvalPolicy: 'never' });
    adapter.dispose();
  });

  it('puts the task\'s effort on every turn it starts', async () => {
    const { spawned, processDeps } = deps(handshake());
    const adapter = new CodexAdapter(processDeps);
    await adapter.start(taskStart('agent', { model: 'gpt-5.5' }));
    const proc = spawned.processes[0];

    for (const text of ['first', 'second']) {
      const turn = adapter.send(text, () => {});
      proc.emitStdout(line({ method: 'turn/completed', params: { threadId: 'thr-task-1', turn: { id: `turn-${text}`, status: 'completed', items: [] } } }));
      await turn;
    }

    expect(sentNamed(proc.written, 'turn/start').map((msg) => msg.params)).toEqual([
      { threadId: 'thr-task-1', input: [{ type: 'text', text: 'first' }], effort: 'high' },
      { threadId: 'thr-task-1', input: [{ type: 'text', text: 'second' }], effort: 'high' },
    ]);
    adapter.dispose();
  });

  it('opens the thread on the legacy Landlock backend where bubblewrap cannot start', async () => {
    const { spawned, processDeps } = deps(handshake(), {
      probe: (args) => (args.includes('use_legacy_landlock') ? { code: 0 } : { code: 1, output: 'bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted' }),
    });
    const adapter = new CodexAdapter(processDeps);
    await adapter.start(taskStart('agent'));

    const [threadStart] = sentNamed(spawned.processes[0].written, 'thread/start');
    expect(threadStart.params?.config).toEqual({ features: { use_legacy_landlock: true } });
    expect(threadStart.params?.sandbox).toBe('workspace-write');
    adapter.dispose();
  });

  it('resumes a task\'s thread with its full settings, not a bare id that would reset them', async () => {
    const { spawned, processDeps } = deps(handshake());
    const adapter = new CodexAdapter(processDeps);
    await adapter.start(taskStart('agent', { model: 'gpt-5.5', resumeSessionId: 'thr-task-1' }));

    const sent = written(spawned.processes[0].written);
    expect(sent.find((msg) => msg.method === 'thread/start')).toBeUndefined();
    expect(sent.find((msg) => msg.method === 'thread/resume')?.params).toEqual({
      threadId: 'thr-task-1',
      cwd: '/repo',
      model: 'gpt-5.5',
      sandbox: 'workspace-write',
      approvalPolicy: 'on-request',
      approvalsReviewer: 'auto_review',
    });
    expect(adapter.nativeSessionId()).toBe('thr-task-1');
    adapter.dispose();
  });

  it('reports a refused resume in Codex\'s words rather than pretending with a fresh thread (K1)', async () => {
    const { spawned, processDeps } = deps([fixture('codex', 'handshake'), fixture('codex', 'resume-rejected')]);
    const adapter = new CodexAdapter(processDeps);

    await expect(adapter.start(taskStart('agent', { resumeSessionId: 'thr-codex-1' }))).rejects.toThrow('thread thr-codex-1 not found');
    expect(sentNamed(spawned.processes[0].written, 'thread/start')).toHaveLength(0);
    expect(adapter.nativeSessionId()).toBeNull();
    expect(spawned.processes[0].killed).toBe(true);
  });
});

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !condition(); i++) await tick();
  if (!condition()) throw new Error('condition never held');
}

async function startedTask(mode = 'agent') {
  const { spawned, processDeps } = deps(handshake());
  const adapter = new CodexAdapter(processDeps);
  await adapter.start(taskStart(mode));
  return { adapter, proc: spawned.processes[0] };
}

const turnStarted = (id: string) => line({ method: 'turn/started', params: { threadId: 'thr-task-1', turn: { id, status: 'inProgress', items: [] } } });
const turnCompleted = (id: string, status = 'completed') => line({ method: 'turn/completed', params: { threadId: 'thr-task-1', turn: { id, status, items: [] } } });
type Change = { path: string; kind: { type: string; move_path?: string | null }; diff: string };
const fileChangeStarted = (id: string, changes: Change[]) => line({ method: 'item/started', params: { threadId: 'thr-task-1', turnId: 'turn-a', item: { id, type: 'fileChange', status: 'inProgress', changes } } });
const fileChangeDone = (id: string, status: string, changes: Change[]) => line({ method: 'item/completed', params: { threadId: 'thr-task-1', turnId: 'turn-a', item: { id, type: 'fileChange', status, changes } } });
const threadIdle = (threadId = 'thr-task-1') => line({ method: 'thread/status/changed', params: { threadId, status: { type: 'idle' } } });

describe('CodexAdapter task sandbox', () => {
  const BWRAP_FAILURE = 'bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted';
  const noSandbox = { probe: () => ({ code: 1, output: BWRAP_FAILURE }) };

  it('refuses a sandboxed task on a machine where no sandbox can start, naming the task and the fixes', async () => {
    const { spawned, processDeps } = deps(handshake(), noSandbox);
    const adapter = new CodexAdapter(processDeps);

    const started = adapter.start(taskStart('agent'));
    await expect(started).rejects.toThrow('kernel.apparmor_restrict_unprivileged_userns=0');
    await expect(started).rejects.toThrow(/run the task again/);
    await expect(started).rejects.toThrow(/Full access or another runner/);
    await expect(started).rejects.not.toThrow(/plan/i);
    expect(sentNamed(spawned.processes[0]?.written ?? [], 'thread/start')).toHaveLength(0);
    // Refused before any thread existed, the app-server is no use to anyone.
    expect(spawned.processes[0].killed).toBe(true);
  });

  it('runs a full-access task anyway, since it asks for no sandbox', async () => {
    const { spawned, processDeps } = deps(handshake(), noSandbox);
    const adapter = new CodexAdapter(processDeps);
    await adapter.start(taskStart('fullAccess'));

    expect(sentNamed(spawned.processes[0].written, 'thread/start')[0].params?.sandbox).toBe('danger-full-access');
    adapter.dispose();
  });

  it('explains the Landlock fallback in a task\'s words, not a planner\'s', async () => {
    const { processDeps } = deps([fixture('codex', 'handshake-warning'), fixture('codex', 'task-thread'), fixture('codex', 'task-turn')], {
      probe: (args) => (args.includes('use_legacy_landlock') ? { code: 0 } : { code: 1, output: BWRAP_FAILURE }),
    });
    const adapter = new CodexAdapter(processDeps);
    await adapter.start(taskStart('agent'));
    const events: AgentEvent[] = [];
    await adapter.send('fix sum', (e) => e.type !== 'runner_loaded' && events.push(e));

    const note = events.find((e) => e.type === 'thinking');
    expect(note?.type === 'thinking' && note.text).toMatch(/legacy Landlock/);
    expect(note?.type === 'thinking' && note.text).not.toMatch(/plan|writes are still denied/i);
    adapter.dispose();
  });
});

describe('CodexAdapter task on a Windows host', () => {
  /** Codex's answer to whether the user set up its Windows sandbox; the rest of discovery is empty. */
  const readiness = (status: string | null) => ({
    codexDiscovery: (method: string) => {
      if (method === 'config/read') return { result: { config: { mcp_servers: {} }, origins: {} } };
      if (method !== 'windowsSandbox/readiness') return { data: [], nextCursor: null };
      return status === null ? { error: { code: -32600, message: 'unknown variant `windowsSandbox/readiness`' } } : { result: { status } };
    },
  });
  /** `task-thread` as codex-cli 0.166.0 answers a `workspace-write` thread on a Windows host whose sandbox is not set up. */
  const grantedReadOnly: ScriptedReply = (written, proc) => {
    const { id } = JSON.parse(written) as { id: number };
    const answer = JSON.parse(fixture('codex', 'task-thread')) as { result: Record<string, unknown> };
    proc.emitStdout(line({ ...answer, id, result: { ...answer.result, sandbox: { type: 'readOnly', networkAccess: false } } }));
  };
  const windows = (replies: ScriptedReply[], status: string | null) => {
    const { spawned, processDeps } = deps(replies, readiness(status));
    return { spawned, adapter: new CodexAdapter({ ...processDeps, platform: 'win32' }) };
  };
  const notes = async (adapter: CodexAdapter): Promise<string[]> => {
    const events: AgentEvent[] = [];
    await adapter.send('fix sum', (e) => events.push(e));
    return events.flatMap((e) => (e.type === 'thinking' ? [e.text] : []));
  };

  it('keeps the planned mode where Codex grants only read-only, and says so to the model and to the user once', async () => {
    const { spawned, adapter } = windows([fixture('codex', 'handshake'), grantedReadOnly, fixture('codex', 'task-turn')], 'notConfigured');
    await adapter.start(taskStart('agent'));

    const sent = written(spawned.processes[0].written).map((msg) => msg.method).filter(Boolean);
    expect(sent.slice(0, 3)).toEqual(['initialize', 'windowsSandbox/readiness', 'thread/start']);
    const [threadStart] = sentNamed(spawned.processes[0].written, 'thread/start');
    expect(threadStart.params?.sandbox).toBe('workspace-write');
    expect(threadStart.params?.config).toBeUndefined();
    expect(threadStart.params?.developerInstructions).toMatch(/Do not end the task because the sandbox is read-only/);
    const shown = await notes(adapter);
    expect(shown).toHaveLength(1);
    expect(shown[0]).toMatch(/Windows sandbox is not set up/);
    expect(shown[0]).toMatch(/Set up default sandbox/);
    adapter.dispose();
  });

  it('tells the model, but shows no note, where Codex grants the write sandbox after all', async () => {
    const { spawned, adapter } = windows([fixture('codex', 'handshake'), codexAnswer('task-thread'), fixture('codex', 'task-turn')], 'notConfigured');
    await adapter.start(taskStart('agent'));

    expect(sentNamed(spawned.processes[0].written, 'thread/start')[0].params?.developerInstructions).toMatch(/sandbox may be read-only/);
    expect(await notes(adapter)).toEqual([]);
    adapter.dispose();
  });

  it('says the same of a sandbox whose setup Codex wants run again', async () => {
    const { spawned, adapter } = windows([fixture('codex', 'handshake'), grantedReadOnly, fixture('codex', 'task-turn')], 'updateRequired');
    await adapter.start(taskStart('agent'));

    expect(sentNamed(spawned.processes[0].written, 'thread/start')[0].params?.developerInstructions).toMatch(/sandbox may be read-only/);
    const shown = await notes(adapter);
    expect(shown).toHaveLength(1);
    expect(shown[0]).toMatch(/needs its setup run again/);
    adapter.dispose();
  });

  it('asks before a resumed thread too, and says what Codex granted it', async () => {
    const { spawned, adapter } = windows([fixture('codex', 'handshake'), grantedReadOnly, fixture('codex', 'task-turn')], 'notConfigured');
    await adapter.start(taskStart('agent', { resumeSessionId: 'thr-task-1' }));

    const sent = written(spawned.processes[0].written).map((msg) => msg.method).filter(Boolean);
    expect(sent.slice(0, 3)).toEqual(['initialize', 'windowsSandbox/readiness', 'thread/resume']);
    expect(sentNamed(spawned.processes[0].written, 'thread/resume')[0].params?.sandbox).toBe('workspace-write');
    expect(await notes(adapter)).toHaveLength(1);
    adapter.dispose();
  });

  it.each([
    ['the user set up', 'ready'],
    ['this Codex was not asked about', null],
  ])('leaves a sandbox %s as Codex configures it', async (_label, status) => {
    const { spawned, adapter } = windows([fixture('codex', 'handshake'), grantedReadOnly, fixture('codex', 'task-turn')], status);
    await adapter.start(taskStart('agent'));

    const [threadStart] = sentNamed(spawned.processes[0].written, 'thread/start');
    expect(threadStart.params).toEqual({ cwd: '/repo', sandbox: 'workspace-write', approvalPolicy: 'on-request', approvalsReviewer: 'auto_review', developerInstructions: CODEX_WINDOWS_SHELL_ADVICE });
    expect(await notes(adapter)).toEqual([]);
    adapter.dispose();
  });

  it.each([
    ['a Guarded task', 'agent', true],
    ['a full-access task', 'fullAccess', true],
    ['a read-only task, whose only shell is run_command', 'plan', false],
  ])('tells %s whether its shell is PowerShell, whose policy refuses npm.ps1', async (_label, mode, told) => {
    const { spawned, adapter } = windows(handshake(), 'ready');
    await adapter.start(taskStart(mode));

    const instructions = String(sentNamed(spawned.processes[0].written, 'thread/start')[0].params?.developerInstructions ?? '');
    expect(instructions.includes('call the .cmd beside it instead')).toBe(told);
    adapter.dispose();
  });

  it.each(['linux', 'darwin'])('asks nothing of a Windows sandbox on %s', async (platform) => {
    const { spawned, processDeps } = deps([fixture('codex', 'handshake'), codexAnswer('task-thread')], readiness('notConfigured'));
    const adapter = new CodexAdapter({ ...processDeps, platform: platform as NodeJS.Platform });
    await adapter.start(taskStart('agent'));

    expect(sentNamed(spawned.processes[0].written, 'windowsSandbox/readiness')).toEqual([]);
    expect(sentNamed(spawned.processes[0].written, 'thread/start')[0].params).toEqual({ cwd: '/repo', sandbox: 'workspace-write', approvalPolicy: 'on-request', approvalsReviewer: 'auto_review' });
    adapter.dispose();
  });

  it.each([
    ['full access, which runs no sandbox', 'fullAccess'],
    ['read-only, whose own shell is off', 'plan'],
  ])('asks nothing of a task in %s', async (_label, mode) => {
    const { spawned, adapter } = windows(handshake(), 'notConfigured');
    await adapter.start(taskStart(mode));

    expect(sentNamed(spawned.processes[0].written, 'windowsSandbox/readiness')).toEqual([]);
    expect(JSON.stringify(sentNamed(spawned.processes[0].written, 'thread/start')[0].params)).not.toMatch(/Windows sandbox|"windows"/);
    adapter.dispose();
  });
});

describe('CodexAdapter task turn end', () => {
  it.each([
    ['turn/completed alone', [turnCompleted('turn-a')]],
    ['the thread going idle alone', [threadIdle()]],
    ['turn/completed, then idle', [turnCompleted('turn-a'), threadIdle()]],
    ['idle, then turn/completed', [threadIdle(), turnCompleted('turn-a')]],
  ])('ends the turn exactly once on %s', async (_label, endings) => {
    const { adapter, proc } = await startedTask();
    const events: string[] = [];
    const turn = adapter.send('go', (e) => e.type !== 'runner_loaded' && events.push(e.type));
    proc.emitStdout(turnStarted('turn-a'));
    for (const ending of endings) proc.emitStdout(ending);
    await turn;

    // A late second signal must not settle the next turn either.
    const next: string[] = [];
    void adapter.send('again', (e) => next.push(e.type));
    await tick();
    expect(events.filter((type) => type === 'turn_end')).toHaveLength(1);
    expect(next).toEqual([]);
    adapter.dispose();
  });

  it('leaves the next turn open when the previous turn\'s completion lands after it was sent', async () => {
    const { adapter, proc } = await startedTask();
    const first = adapter.send('go', () => {});
    proc.emitStdout(turnStarted('turn-a') + threadIdle());
    await first;

    const events: string[] = [];
    const second = adapter.send('again', (e) => e.type !== 'runner_loaded' && events.push(e.type));
    // Both late: the first turn's completion, and an idle before the new turn has started.
    proc.emitStdout(turnCompleted('turn-a') + threadIdle());
    await tick();
    expect(events).toEqual([]);

    proc.emitStdout(turnStarted('turn-b') + turnCompleted('turn-b'));
    await second;
    expect(events).toEqual(['turn_end']);
    adapter.dispose();
  });

  it('treats a retrying error as a heartbeat, not the end of the turn', async () => {
    const { adapter, proc } = await startedTask();
    const events: AgentEvent[] = [];
    const turn = adapter.send('go', (e) => e.type !== 'runner_loaded' && events.push(e));
    proc.emitStdout(turnStarted('turn-a') + line({ method: 'error', params: { threadId: 'thr-task-1', turnId: 'turn-a', willRetry: true, error: { message: 'stream disconnected; retrying' } } }));
    await tick();
    expect(events).toEqual([]);

    proc.emitStdout(turnCompleted('turn-a'));
    await turn;
    expect(events).toEqual([{ type: 'turn_end' }]);
    adapter.dispose();
  });

  it('ignores a subagent thread going idle', async () => {
    const { adapter, proc } = await startedTask();
    const events: string[] = [];
    void adapter.send('go', (e) => e.type !== 'runner_loaded' && events.push(e.type));
    proc.emitStdout(turnStarted('turn-a') + threadIdle('thr-child-1'));
    await tick();
    expect(events).toEqual([]);
    adapter.dispose();
  });
});

describe('CodexAdapter task interrupt', () => {
  it('interrupts the running turn by both its ids, and the turn ends as interrupted', async () => {
    const { adapter, proc } = await startedTask();
    const events: AgentEvent[] = [];
    const turn = adapter.send('go', (e) => e.type !== 'runner_loaded' && events.push(e));
    proc.emitStdout(turnStarted('turn-a'));

    const acknowledged = adapter.interrupt(1000);
    await until(() => sentNamed(proc.written, 'turn/interrupt').length > 0);
    const [request] = sentNamed(proc.written, 'turn/interrupt');
    expect(request.params).toEqual({ threadId: 'thr-task-1', turnId: 'turn-a' });
    proc.emitStdout(line({ id: request.id, result: {} }));
    expect(await acknowledged).toBe(true);

    proc.emitStdout(turnCompleted('turn-a', 'interrupted') + threadIdle());
    await turn;
    expect(events).toEqual([{ type: 'turn_end', interrupted: true }]);
    adapter.dispose();
  });

  it('waits for the turn\'s id when interrupted before Codex has named it', async () => {
    const { adapter, proc } = await startedTask();
    void adapter.send('go', () => {});
    const acknowledged = adapter.interrupt(1000);
    await tick();
    expect(sentNamed(proc.written, 'turn/interrupt')).toHaveLength(0);

    const [turnStart] = sentNamed(proc.written, 'turn/start');
    proc.emitStdout(line({ id: turnStart.id, result: { turn: { id: 'turn-a', status: 'inProgress', items: [] } } }));
    await until(() => sentNamed(proc.written, 'turn/interrupt').length > 0);
    const [request] = sentNamed(proc.written, 'turn/interrupt');
    expect(request.params).toEqual({ threadId: 'thr-task-1', turnId: 'turn-a' });
    proc.emitStdout(line({ id: request.id, result: {} }));
    expect(await acknowledged).toBe(true);
    adapter.dispose();
  });

  it('sends every interrupt asked for before Codex names the turn, not only the last', async () => {
    const { adapter, proc } = await startedTask();
    void adapter.send('go', () => {});
    const first = adapter.interrupt(1000);
    const second = adapter.interrupt(1000);
    await tick();
    expect(sentNamed(proc.written, 'turn/interrupt')).toHaveLength(0);

    const [turnStart] = sentNamed(proc.written, 'turn/start');
    proc.emitStdout(line({ id: turnStart.id, result: { turn: { id: 'turn-a', status: 'inProgress', items: [] } } }));
    await until(() => sentNamed(proc.written, 'turn/interrupt').length > 1);
    for (const request of sentNamed(proc.written, 'turn/interrupt')) proc.emitStdout(line({ id: request.id, result: {} }));
    expect(await Promise.all([first, second])).toEqual([true, true]);
    adapter.dispose();
  });

  it('reports an unanswered or refused interrupt as false, so the caller can kill and resume', async () => {
    const { adapter, proc } = await startedTask();
    void adapter.send('go', () => {});
    proc.emitStdout(turnStarted('turn-a'));
    expect(await adapter.interrupt(20)).toBe(false);

    const refused = adapter.interrupt(1000);
    await until(() => sentNamed(proc.written, 'turn/interrupt').length > 1);
    proc.emitStdout(line({ id: sentNamed(proc.written, 'turn/interrupt')[1].id, error: { code: -32600, message: 'no active turn' } }));
    expect(await refused).toBe(false);
    adapter.dispose();
  });

  it('takes the runner\'s own end for an interrupted turn: a finish that raced the interrupt is a finish', async () => {
    const { adapter, proc } = await startedTask();
    const events: AgentEvent[] = [];
    const turn = adapter.send('go', (e) => e.type !== 'runner_loaded' && events.push(e));
    proc.emitStdout(turnStarted('turn-a'));
    const acknowledged = adapter.interrupt(1000);
    await until(() => sentNamed(proc.written, 'turn/interrupt').length > 0);
    proc.emitStdout(line({ id: sentNamed(proc.written, 'turn/interrupt')[0].id, result: {} }) + turnCompleted('turn-a', 'completed'));
    await acknowledged;
    await turn;

    expect(events).toEqual([{ type: 'turn_end' }]);
    adapter.dispose();
  });

  it('reports a turn that failed after an interrupt as failed, with the runner\'s error', async () => {
    const { adapter, proc } = await startedTask();
    const events: AgentEvent[] = [];
    const turn = adapter.send('go', (e) => e.type !== 'runner_loaded' && events.push(e));
    proc.emitStdout(turnStarted('turn-a'));
    const acknowledged = adapter.interrupt(1000);
    await until(() => sentNamed(proc.written, 'turn/interrupt').length > 0);
    const error = { message: 'Rate limit reached for gpt-5.5.', codexErrorInfo: 'other', additionalDetails: null };
    proc.emitStdout(line({ id: sentNamed(proc.written, 'turn/interrupt')[0].id, result: {} })
      + line({ method: 'turn/completed', params: { threadId: 'thr-task-1', turn: { id: 'turn-a', status: 'failed', error, items: [] } } }));
    await acknowledged;
    await turn;

    expect(events).toEqual([expect.objectContaining({ type: 'error', message: 'Rate limit reached for gpt-5.5.' })]);
    adapter.dispose();
  });

  it('forgets an interrupt the runner refused, so the turn that follows is not called interrupted', async () => {
    const { adapter, proc } = await startedTask();
    const events: AgentEvent[] = [];
    const turn = adapter.send('go', (e) => e.type !== 'runner_loaded' && events.push(e));
    proc.emitStdout(turnStarted('turn-a'));
    const refused = adapter.interrupt(1000);
    await until(() => sentNamed(proc.written, 'turn/interrupt').length > 0);
    proc.emitStdout(line({ id: sentNamed(proc.written, 'turn/interrupt')[0].id, error: { code: -32600, message: 'no active turn' } }));
    expect(await refused).toBe(false);
    proc.emitStdout(turnCompleted('turn-a'));
    await turn;

    expect(events).toEqual([{ type: 'turn_end' }]);
    adapter.dispose();
  });

  it('drops the late report of a command the interrupt left running, inside the turn that replaced it (ADR-0023, F4)', async () => {
    const { adapter, proc } = await startedTask();
    const sleep = { id: 'cmd-1', type: 'commandExecution', command: 'sleep 60', cwd: '/repo' };
    const interrupted = adapter.send('go', () => {});
    proc.emitStdout(turnStarted('turn-a') + line({ method: 'item/started', params: { threadId: 'thr-task-1', turnId: 'turn-a', item: sleep } }));
    const acknowledged = adapter.interrupt(1000);
    await until(() => sentNamed(proc.written, 'turn/interrupt').length > 0);
    proc.emitStdout(line({ id: sentNamed(proc.written, 'turn/interrupt')[0].id, result: {} }) + turnCompleted('turn-a', 'interrupted'));
    await acknowledged;
    await interrupted;

    const events: AgentEvent[] = [];
    const next = adapter.send('stop sleeping, write the file', (e) => e.type !== 'runner_loaded' && events.push(e));
    proc.emitStdout(turnStarted('turn-b')
      + line({ method: 'item/completed', params: { threadId: 'thr-task-1', turnId: 'turn-a', item: { ...sleep, aggregatedOutput: '', exitCode: 0 } } })
      + line({ method: 'item/started', params: { threadId: 'thr-task-1', turnId: 'turn-b', item: { id: 'cmd-2', type: 'commandExecution', command: 'touch done', cwd: '/repo' } } })
      + turnCompleted('turn-b'));
    await next;

    expect(events.filter((e) => e.type === 'tool_call' || e.type === 'tool_result').map((e) => e.id)).toEqual(['cmd-2']);
    adapter.dispose();
  });

  it('has nothing to interrupt between turns', async () => {
    const { adapter } = await startedTask();
    expect(await adapter.interrupt(1000)).toBe(false);
    adapter.dispose();
  });
});

const commandApproval = (id: number) => line({
  id,
  method: 'item/commandExecution/requestApproval',
  params: { threadId: 'thr-task-1', turnId: 'turn-a', itemId: 'item_c1', startedAtMs: 1, command: 'npm install left-pad', cwd: '/repo', reason: 'Needs the network' },
});

/** Opens a turn and replays `lines` into it, returning what the adapter emitted. */
async function openTurn(lines: string[], mode = 'agent') {
  const started = await startedTask(mode);
  const events: AgentEvent[] = [];
  void started.adapter.send('go', (e) => e.type !== 'runner_loaded' && events.push(e));
  started.proc.emitStdout(turnStarted('turn-a') + lines.join(''));
  await tick();
  return { ...started, events };
}

function answerTo(proc: { written: string[] }, id: number | string): RpcLine | undefined {
  return written(proc.written).find((msg) => msg.id === id && !msg.method);
}

describe('CodexAdapter task approvals', () => {
  it('leaves a command approval open, passing the request on with a session-wide grant to offer', async () => {
    const { adapter, proc, events } = await openTurn([commandApproval(7)]);

    const params = { threadId: 'thr-task-1', turnId: 'turn-a', itemId: 'item_c1', startedAtMs: 1, command: 'npm install left-pad', cwd: '/repo', reason: 'Needs the network' };
    expect(events).toEqual([{
      type: 'permission_request',
      id: '7',
      name: 'shell',
      detail: JSON.stringify(params),
      input: params,
      suggestions: [{ decision: 'acceptForSession' }],
      toolUseId: 'item_c1',
    }]);
    expect(answerTo(proc, 7)).toBeUndefined();
    adapter.dispose();
  });

  it.each([
    ['allow', { decision: 'allow' } as const, { decision: 'accept' }],
    ['allow for this task', { decision: 'allowForTask' } as const, { decision: 'acceptForSession' }],
    ['deny', { decision: 'deny' } as const, { decision: 'decline' }],
  ])('answers a command approval: %s', async (_label, decision, result) => {
    const { adapter, proc } = await openTurn([commandApproval(7)]);

    expect(adapter.answerPermission('7', decision)).toBe(true);
    expect(answerTo(proc, 7)).toEqual({ jsonrpc: '2.0', id: 7, result });
    // Answered once: a second answer has nothing to settle.
    expect(adapter.answerPermission('7', decision)).toBe(false);
    adapter.dispose();
  });

  it('passes a deny note on to the agent in the running turn', async () => {
    const { adapter, proc } = await openTurn([commandApproval(7)]);

    adapter.answerPermission('7', { decision: 'deny', note: 'Use the vendored copy instead.' });
    expect(answerTo(proc, 7)?.result).toEqual({ decision: 'decline' });
    const [steer] = sentNamed(proc.written, 'turn/steer');
    expect(steer.params).toEqual({ threadId: 'thr-task-1', expectedTurnId: 'turn-a', input: [{ type: 'text', text: 'Use the vendored copy instead.' }] });
    adapter.dispose();
  });

  it('names the files a file-change approval would write, from the item that announced them', async () => {
    const { adapter, proc, events } = await openTurn([
      line({ method: 'item/started', params: { threadId: 'thr-task-1', turnId: 'turn-a', item: { id: 'item_f1', type: 'fileChange', status: 'inProgress', changes: [{ path: '/repo/a.ts', kind: { type: 'add' }, diff: '+a' }, { path: '/repo/b.ts', kind: { type: 'update' }, diff: '-b\n+B' }] } } }),
      line({ id: 8, method: 'item/fileChange/requestApproval', params: { threadId: 'thr-task-1', turnId: 'turn-a', itemId: 'item_f1', startedAtMs: 1, reason: null } }),
    ]);

    const request = events.find((e) => e.type === 'permission_request');
    expect(request).toMatchObject({ id: '8', name: 'file_change', suggestions: [{ decision: 'acceptForSession' }], toolUseId: 'item_f1' });
    expect(request?.type === 'permission_request' && request.input?.path).toBe('/repo/a.ts, /repo/b.ts');

    adapter.answerPermission('8', { decision: 'allowForTask' });
    expect(answerTo(proc, 8)?.result).toEqual({ decision: 'acceptForSession' });
    adapter.dispose();
  });

  it.each([
    ['allow', { decision: 'allow' } as const, { permissions: { fileSystem: { write: ['/opt/cache'] } }, scope: 'turn' }],
    ['allow for this task', { decision: 'allowForTask' } as const, { permissions: { fileSystem: { write: ['/opt/cache'] } }, scope: 'session' }],
    ['deny', { decision: 'deny' } as const, { permissions: {}, scope: 'turn' }],
  ])('grants or withholds asked-for permissions: %s', async (_label, decision, result) => {
    const { adapter, proc, events } = await openTurn([
      line({ id: 9, method: 'item/permissions/requestApproval', params: { threadId: 'thr-task-1', turnId: 'turn-a', itemId: 'item_p1', startedAtMs: 1, cwd: '/repo', reason: 'Write the build cache', permissions: { fileSystem: { write: ['/opt/cache'] } } } }),
    ]);

    expect(events.find((e) => e.type === 'permission_request')).toMatchObject({ id: '9', name: 'permissions', suggestions: [{ scope: 'session' }] });
    adapter.answerPermission('9', decision);
    expect(answerTo(proc, 9)?.result).toEqual(result);
    adapter.dispose();
  });

  it.each([
    ['allow', { decision: 'allow' } as const, { action: 'accept', content: {} }],
    ['deny', { decision: 'deny' } as const, { action: 'decline', content: null }],
  ])('answers an MCP server\'s yes-or-no elicitation: %s', async (_label, decision, result) => {
    const { adapter, proc, events } = await openTurn([
      line({ id: 10, method: 'mcpServer/elicitation/request', params: { threadId: 'thr-task-1', turnId: 'turn-a', serverName: 'linear', mode: 'form', message: 'Allow linear to create an issue?', requestedSchema: { type: 'object', properties: {} } } }),
    ]);

    // MCP has no session-wide answer, so "Allow for this task" is not offered.
    expect(events.find((e) => e.type === 'permission_request')).toMatchObject({ id: '10', name: 'mcp_elicitation', suggestions: [] });
    adapter.answerPermission('10', decision);
    expect(answerTo(proc, 10)?.result).toEqual(result);
    adapter.dispose();
  });

  it('declines an elicitation that asks for input no approval card can give', async () => {
    const { adapter, proc, events } = await openTurn([
      line({ id: 11, method: 'mcpServer/elicitation/request', params: { threadId: 'thr-task-1', turnId: 'turn-a', serverName: 'linear', mode: 'form', message: 'Which team?', requestedSchema: { type: 'object', properties: { team: { type: 'string' } } } } }),
    ]);

    expect(events).toEqual([]);
    expect(answerTo(proc, 11)?.result).toEqual({ action: 'decline', content: null });
    adapter.dispose();
  });

  it('withdraws a request Codex settled itself, and it can no longer be answered', async () => {
    const { adapter, proc, events } = await openTurn([commandApproval(7)]);
    proc.emitStdout(line({ method: 'serverRequest/resolved', params: { threadId: 'thr-task-1', requestId: 7 } }));
    await tick();

    expect(events.at(-1)).toEqual({ type: 'permission_cancelled', id: '7' });
    expect(adapter.answerPermission('7', { decision: 'allow' })).toBe(false);
    adapter.dispose();
  });

  it('cancels a request still open when the turn ends, as every runner does', async () => {
    const { adapter, proc, events } = await openTurn([commandApproval(7)]);
    proc.emitStdout(turnCompleted('turn-a'));
    await tick();

    expect(events.slice(-2)).toEqual([{ type: 'permission_cancelled', id: '7' }, { type: 'turn_end' }]);
    expect(adapter.answerPermission('7', { decision: 'allow' })).toBe(false);
    expect(answerTo(proc, 7)).toBeUndefined();
    adapter.dispose();
  });

  it('withdraws nothing when Codex confirms an answer this adapter gave', async () => {
    const { adapter, proc, events } = await openTurn([commandApproval(7)]);
    adapter.answerPermission('7', { decision: 'allow' });
    proc.emitStdout(line({ method: 'serverRequest/resolved', params: { threadId: 'thr-task-1', requestId: 7 } }));
    await tick();

    expect(events.filter((e) => e.type === 'permission_cancelled')).toEqual([]);
    adapter.dispose();
  });

  it('refuses a structured question, telling the agent to ask in plain text and end its turn', async () => {
    const { adapter, proc, events } = await openTurn([
      line({ id: 12, method: 'item/tool/requestUserInput', params: { threadId: 'thr-task-1', turnId: 'turn-a', itemId: 'item_q1', isBlocking: true, questions: [{ id: 'q1', header: 'Framework', question: 'Which test framework?' }] } }),
    ]);

    const answer = answerTo(proc, 12);
    expect(answer?.result).toBeUndefined();
    expect(answer?.error?.message).toMatch(/plain text/i);
    expect(answer?.error?.message).toMatch(/end your turn/i);
    expect(events.filter((e) => e.type === 'permission_request')).toEqual([]);
    adapter.dispose();
  });

  it('answers a request it does not know with -32601 at once, so no turn can deadlock', async () => {
    const { adapter, proc, events } = await openTurn([
      line({ id: 13, method: 'item/tool/call', params: { threadId: 'thr-task-1', turnId: 'turn-a', callId: 'c1', tool: 'lookup', arguments: {} } }),
      line({ id: 14, method: 'something/new', params: {} }),
    ]);

    expect(answerTo(proc, 13)?.error?.code).toBe(-32601);
    expect(answerTo(proc, 14)?.error?.code).toBe(-32601);
    expect(events.filter((e) => e.type === 'permission_request')).toEqual([]);
    adapter.dispose();
  });
});

describe('CodexAdapter task channels', () => {
  it('reports commands, file changes, usage and reply text as the planner does, a changed file as a row named for its change', async () => {
    const { adapter, proc } = await startedTask();
    const events: AgentEvent[] = [];
    const turn = adapter.send('fix sum', (e) => e.type !== 'runner_loaded' && events.push(e));
    proc.emitStdout(fixture('codex', 'task-turn'));
    await turn;

    expect(events).toEqual([
      { type: 'tool_call', id: 'item_c1', name: 'shell', args: { command: 'npm test', cwd: '/repo' } },
      { type: 'tool_result', id: 'item_c1', name: 'shell', output: '1 failing\n', success: false },
      { type: 'tool_call', id: 'item_f1', name: 'Update', args: { path: shownPath('src', 'sum.ts') } },
      { type: 'tool_result', id: 'item_f1', name: 'Update', output: '-return a - b;\n+return a + b;\n', success: true },
      { type: 'usage', record: { source: 'codex', model: 'gpt-5.5', inputTokens: 9000, outputTokens: 100, cachedInputTokens: 4000, contextWindow: 258400, contextTokens: 9100 } },
      { type: 'assistant_text_delta', runId: 'item_m1', text: 'Fixed the sign in sum.ts.\n<<<ORDE' },
      { type: 'assistant_text_delta', runId: 'item_m1', text: 'WELL_DONE>>>' },
      { type: 'assistant_text', runId: 'item_m1', text: 'Fixed the sign in sum.ts.\n<<<ORDEWELL_DONE>>>' },
      { type: 'turn_end' },
    ]);
    expect(adapter.nativeSessionId()).toBe('thr-task-1');
    adapter.dispose();
  });

  it('records an explicitly reported API-key login without inventing a cost', async () => {
    const { adapter, proc } = await startedTask();
    const events: AgentEvent[] = [];
    const turn = adapter.send('fix sum', (event) => events.push(event));
    proc.emitStdout(line({ method: 'account/updated', params: { authMode: 'apikey', planType: null } }));
    proc.emitStdout(fixture('codex', 'task-turn'));
    await turn;
    expect(events.filter((event) => event.type === 'usage' && event.record.sessionBilling)).toEqual([
      { type: 'usage', record: { source: 'codex', aggregate: true, sessionBilling: { type: 'api-key' } } },
    ]);
    adapter.dispose();
  });

  it('marks a turn that failed on the usage limit as one, with the exhausted window\'s reset', async () => {
    beforeRecordedReset();
    const { adapter, proc } = await startedTask();
    const events: AgentEvent[] = [];
    const turn = adapter.send('fix sum', (e) => e.type !== 'runner_loaded' && events.push(e));
    proc.emitStdout(fixture('codex', 'usage-limit'));
    await turn;

    expect(events).toEqual([{ type: 'usage', record: { source: 'codex', aggregate: true, sessionBilling: { type: 'subscription', plan: 'plus' } } }, {
      type: 'error',
      message: "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again later.",
      usageLimit: { resetsAt: '2026-10-17T20:42:55.000Z' },
    }]);
    adapter.dispose();
  });

  it('marks the limit with no reset when no used-up window is known, an error Codex names as another cause as not the limit, and leaves an unnamed one to its words', async () => {
    const limitError = { message: "You've hit your usage limit. Try again at 8:10 PM.", codexErrorInfo: 'usageLimitExceeded', additionalDetails: null };
    // A used-up window whose reset has passed is not this limit's.
    const stale = line({ method: 'account/rateLimits/updated', params: { rateLimits: { limitId: 'codex', primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 1700000000 }, secondary: null } } });
    const limited = await openTurn([stale, line({ method: 'error', params: { threadId: 'thr-task-1', turnId: 'turn-a', willRetry: false, error: limitError } })]);
    expect(limited.events).toEqual([{ type: 'error', message: limitError.message, usageLimit: {} }]);
    limited.adapter.dispose();

    const throttled = await openTurn([line({ method: 'turn/completed', params: { threadId: 'thr-task-1', turn: { id: 'turn-a', status: 'failed', items: [], error: { message: 'Rate limit reached for gpt-5.5.', codexErrorInfo: 'rateLimitExceeded' } } } })]);
    // The provider's throttle, worded like a limit: Codex's field says it is not the account's.
    expect(throttled.events).toEqual([{ type: 'error', message: 'Rate limit reached for gpt-5.5.', usageLimit: false }]);
    throttled.adapter.dispose();

    const unnamed = await openTurn([line({ method: 'turn/completed', params: { threadId: 'thr-task-1', turn: { id: 'turn-a', status: 'failed', items: [], error: { message: 'stream disconnected', codexErrorInfo: 'other' } } } })]);
    expect(unnamed.events).toEqual([{ type: 'error', message: 'stream disconnected' }]);
    unnamed.adapter.dispose();
  });

  it('says nothing of a used-up window reported while no turn is in flight', async () => {
    const { adapter, proc } = await startedTask();
    const outOfTurn: AgentEvent[] = [];
    adapter.onOutOfTurn((e) => outOfTurn.push(e));
    proc.emitStdout(line({ method: 'account/rateLimits/updated', params: { rateLimits: { limitId: 'codex', primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 1792269775 }, secondary: null, rateLimitReachedType: 'rate_limit_reached' } } }));
    await tick();

    expect(outOfTurn).toEqual([]);
    adapter.dispose();
  });

  it('reports a declined file change as a failed row, announcing a change it never saw start', async () => {
    const { adapter, proc } = await startedTask();
    const events: AgentEvent[] = [];
    void adapter.send('fix sum', (e) => e.type !== 'runner_loaded' && events.push(e));
    proc.emitStdout(turnStarted('turn-a') + fileChangeDone('item_f2', 'declined', [{ path: '/repo/x.ts', kind: { type: 'add' }, diff: 'x\n' }]));
    await tick();

    expect(events).toEqual([
      { type: 'tool_call', id: 'item_f2', name: 'Add', args: { path: 'x.ts' } },
      { type: 'tool_result', id: 'item_f2', name: 'Add', output: '+x\n', success: false },
    ]);
    adapter.dispose();
  });

  it('gives each file of a patch its own row, the first under the item\'s id so its approval still points at it', async () => {
    const changes = [
      { path: '/repo/src/new.ts', kind: { type: 'add' }, diff: 'export const a = 1;\n' },
      { path: '/repo/src/sum.ts', kind: { type: 'update', move_path: null }, diff: '@@ -1 +1 @@\n-a - b\n+a + b\n' },
      { path: '/repo/old.ts', kind: { type: 'delete' }, diff: 'gone\nfor good\n' },
    ];
    const { adapter, events } = await openTurn([fileChangeStarted('item_f1', changes), fileChangeDone('item_f1', 'completed', changes)]);

    expect(events).toEqual([
      { type: 'tool_call', id: 'item_f1', name: 'Add', args: { path: shownPath('src', 'new.ts') } },
      { type: 'tool_call', id: `item_f1:${shownPath('src', 'sum.ts')}`, name: 'Update', args: { path: shownPath('src', 'sum.ts') } },
      { type: 'tool_call', id: 'item_f1:old.ts', name: 'Delete', args: { path: 'old.ts' } },
      { type: 'tool_result', id: 'item_f1', name: 'Add', output: '+export const a = 1;\n', success: true },
      { type: 'tool_result', id: `item_f1:${shownPath('src', 'sum.ts')}`, name: 'Update', output: '@@ -1 +1 @@\n-a - b\n+a + b\n', success: true },
      { type: 'tool_result', id: 'item_f1:old.ts', name: 'Delete', output: '-gone\n-for good\n', success: true },
    ]);
    adapter.dispose();
  });

  it('settles each file by its path, whatever order the completed item lists them in', async () => {
    const a = { path: '/repo/a.ts', kind: { type: 'update', move_path: null }, diff: '-a\n+A\n' };
    const b = { path: '/repo/b.ts', kind: { type: 'update', move_path: null }, diff: '-b\n+B\n' };
    const { adapter, events } = await openTurn([fileChangeStarted('item_f1', [a, b]), fileChangeDone('item_f1', 'completed', [b, a])]);

    expect(events.filter((e) => e.type === 'tool_result')).toEqual([
      { type: 'tool_result', id: 'item_f1:b.ts', name: 'Update', output: '-b\n+B\n', success: true },
      { type: 'tool_result', id: 'item_f1', name: 'Update', output: '-a\n+A\n', success: true },
    ]);
    adapter.dispose();
  });

  it('names a move by both paths, and keeps a path outside the worktree whole', async () => {
    const changes = [
      { path: '/repo/src/a.ts', kind: { type: 'update', move_path: '/repo/lib/a.ts' }, diff: '' },
      { path: '/etc/hosts', kind: { type: 'update', move_path: null }, diff: '+127.0.0.1 x\n' },
    ];
    const { adapter, events } = await openTurn([fileChangeStarted('item_f1', changes)]);

    expect(events).toEqual([
      { type: 'tool_call', id: 'item_f1', name: 'Update', args: { path: `${shownPath('src', 'a.ts')} → ${shownPath('lib', 'a.ts')}` } },
      { type: 'tool_call', id: 'item_f1:/etc/hosts', name: 'Update', args: { path: '/etc/hosts' } },
    ]);
    adapter.dispose();
  });
});

describe('CodexAdapter planner boundary (ADR-0008/0009)', () => {
  const plannerHandshake = (): ScriptedReply[] => [fixture('codex', 'handshake'), fixture('codex', 'new-conversation')];

  it.each([
    ['nothing else', {}],
    ['a model, an effort and a resume', { model: 'gpt-5.5', effort: 'high', resumeSessionId: 'thr-codex-1' }],
    // Task fields smuggled onto a planner start: nothing on the planner path reads them.
    ['a task\'s full-access mode and flags', { mode: 'fullAccess', flags: { permissionMode: 'danger-full-access', effort: 'xhigh', modeSettings: { approvalPolicy: 'never' } } }],
    ['a task\'s agent mode and reviewer', { mode: 'agent', flags: { permissionMode: 'workspace-write', modeSettings: { approvalPolicy: 'on-request', approvalsReviewer: 'auto_review' } } }],
  ])('opens a planner thread read-only, its approvals asked of Ordewell, whatever else its start carries: %s', async (_label, extra) => {
    const { spawned, processDeps } = deps(plannerHandshake());
    const adapter = new CodexAdapter(processDeps);
    await adapter.start({ kind: 'planner', cwd: '/repo', systemPrompt: 'PLAN', ...extra } as unknown as AgentStartOptions);

    const [thread] = written(spawned.processes[0].written).filter((msg) => msg.method === 'thread/start' || msg.method === 'thread/resume');
    // Only the thread to resume and the model may vary with what the start carried.
    expect(thread.params).toEqual({
      ...('resumeSessionId' in extra ? { threadId: extra.resumeSessionId } : {}),
      ...('model' in extra ? { model: extra.model } : {}),
      cwd: '/repo',
      sandbox: 'read-only',
      approvalPolicy: 'on-request',
      // The repository's own config never loads for a planner (ADR-0028).
      config: { web_search: 'disabled', projects: untrustedRepo() },
      developerInstructions: 'PLAN',
    });
    adapter.dispose();
  });

  // Codex's sandboxes on Windows cannot keep a command off the network: with
  // none set up there is none, and under the non-admin one Node reaches it.
  it.each([
    ['Windows, with its own shell off and nothing asked of its sandbox', 'win32', { shell_tool: false, unified_exec: false }],
    ['Linux, with its own shell', 'linux', undefined],
    ['macOS, with its own shell', 'darwin', undefined],
  ])('plans read-only on %s', async (_label, platform, features) => {
    const mcp = mcpClientConfig({ url: 'http://127.0.0.1:4555/mcp', token: 'tok-secret' });
    const { spawned, processDeps } = deps(plannerHandshake());
    const adapter = new CodexAdapter({ ...processDeps, platform: platform as NodeJS.Platform });
    await adapter.start({ kind: 'planner', cwd: '/repo', systemPrompt: 'PLAN', mcp });

    const sent = written(spawned.processes[0].written);
    expect(sent.map((msg) => msg.method)).not.toContain('windowsSandbox/readiness');
    const thread = sent.find((msg) => msg.method === 'thread/start');
    expect(thread?.params?.sandbox).toBe('read-only');
    expect(thread?.params?.approvalPolicy).toBe('on-request');
    const config = thread?.params?.config as { features?: unknown; windows?: unknown } | undefined;
    expect(config?.features).toEqual(features);
    expect(config?.windows).toBeUndefined();
    expect(thread?.params?.developerInstructions).toContain(features ? 'You have no shell of your own on this machine' : 'not your own shell');
    adapter.dispose();
  });

  it('keeps Codex\'s own shell on Windows for a planner offered no run_command, its one way to read', async () => {
    // A one-shot plan runs no command (CliAgentAiService.oneShot), so it withholds the tool.
    const mcp = mcpClientConfig({ url: 'http://127.0.0.1:4555/mcp', token: 'tok-secret', hidden: ['run_command'] });
    const { spawned, processDeps } = deps(plannerHandshake());
    const adapter = new CodexAdapter({ ...processDeps, platform: 'win32' });
    await adapter.start({ kind: 'planner', cwd: '/repo', systemPrompt: 'PLAN', mcp });

    const thread = written(spawned.processes[0].written).find((msg) => msg.method === 'thread/start');
    expect((thread?.params?.config as { features?: unknown } | undefined)?.features).toBeUndefined();
    expect(thread?.params?.developerInstructions).not.toContain('run_command');
    expect(thread?.params?.developerInstructions).not.toContain('  ');
    adapter.dispose();
  });

  it('refuses every approval at once, leaving nothing open for anyone to grant', async () => {
    const { spawned, processDeps } = deps(plannerHandshake());
    const adapter = new CodexAdapter(processDeps);
    await adapter.start({ kind: 'planner', cwd: '/repo', systemPrompt: 'PLAN' });
    const proc = spawned.processes[0];
    void adapter.send('plan it', () => {});
    proc.emitStdout(
      line({ id: 21, method: 'item/commandExecution/requestApproval', params: { threadId: 'thr-codex-1', turnId: 't', itemId: 'c', startedAtMs: 1, command: 'rm -rf src' } })
      + line({ id: 22, method: 'item/fileChange/requestApproval', params: { threadId: 'thr-codex-1', turnId: 't', itemId: 'f', startedAtMs: 1 } })
      + line({ id: 23, method: 'item/permissions/requestApproval', params: { threadId: 'thr-codex-1', turnId: 't', itemId: 'p', startedAtMs: 1, cwd: '/repo', permissions: { fileSystem: { write: ['/'] } } } })
      + line({ id: 24, method: 'mcpServer/elicitation/request', params: { threadId: 'thr-codex-1', serverName: 'x', mode: 'form', message: 'ok?', requestedSchema: { type: 'object', properties: {} } } }),
    );
    await tick();

    expect(answerTo(proc, 21)?.result).toEqual({ decision: 'decline' });
    expect(answerTo(proc, 22)?.result).toEqual({ decision: 'decline' });
    expect(answerTo(proc, 23)?.error?.message).toContain('read-only');
    expect(answerTo(proc, 24)?.result).toEqual({ action: 'decline' });
    for (const id of ['21', '22', '23', '24']) expect(adapter.answerPermission(id, { decision: 'allow' })).toBe(false);
    adapter.dispose();
  });

  // The request as Codex 0.162 raised it for a configured server's tool under `on-request`.
  const mcpToolApproval = (id: number, message: string) => line({
    id,
    method: 'mcpServer/elicitation/request',
    params: {
      threadId: 'thr-codex-1', turnId: 't', serverName: 'todoist', mode: 'form', message,
      _meta: { codex_approval_kind: 'mcp_tool_call', persist: ['session', 'always'], tool_params: { filter: 'today' } },
      requestedSchema: { type: 'object', properties: {} },
    },
  });

  it('holds a user\'s MCP tool approval open for the planner\'s envelope, and answers it as decided', async () => {
    const { spawned, processDeps } = deps(plannerHandshake());
    const adapter = new CodexAdapter(processDeps);
    await adapter.start({ kind: 'planner', cwd: '/repo', systemPrompt: 'PLAN' });
    const proc = spawned.processes[0];
    const events: AgentEvent[] = [];
    void adapter.send('plan it', (e) => e.type !== 'runner_loaded' && events.push(e));
    proc.emitStdout(mcpToolApproval(31, 'Allow the todoist MCP server to run tool "find-tasks"?'));
    await tick();

    expect(answerTo(proc, 31)).toBeUndefined();
    expect(events.find((e) => e.type === 'permission_request')).toEqual({
      type: 'permission_request',
      id: '31',
      name: 'mcp__todoist__find-tasks',
      detail: JSON.stringify({ filter: 'today' }),
      input: { filter: 'today' },
      ask: { kind: 'mcp', scope: 'mcp__todoist__find-tasks', tool: 'find-tasks', server: 'todoist' },
    });
    expect(adapter.answerPermission('31', { decision: 'deny', note: 'not approved' })).toBe(true);
    expect(answerTo(proc, 31)?.result).toEqual({ action: 'decline', content: null });
    // The note is the envelope's, not a person's message: nothing is steered into the planner's thread.
    expect(sentNamed(proc.written, 'turn/steer')).toEqual([]);
    adapter.dispose();
  });

  it('names the tool from the call it started when the question does not', async () => {
    const { spawned, processDeps } = deps(plannerHandshake());
    const adapter = new CodexAdapter(processDeps);
    await adapter.start({ kind: 'planner', cwd: '/repo', systemPrompt: 'PLAN' });
    const proc = spawned.processes[0];
    const events: AgentEvent[] = [];
    void adapter.send('plan it', (e) => e.type !== 'runner_loaded' && events.push(e));
    proc.emitStdout(
      line({ method: 'item/started', params: { threadId: 'thr-codex-1', turnId: 't', item: { type: 'mcpToolCall', id: 'm1', server: 'todoist', tool: 'add-tasks', status: 'inProgress', arguments: {} } } })
      + mcpToolApproval(32, 'Allow this call?'),
    );
    await tick();

    expect(events.find((e) => e.type === 'permission_request')).toMatchObject({ ask: { kind: 'mcp', tool: 'add-tasks', server: 'todoist' } });
    adapter.dispose();
  });

  it('does not name the tool from a call that has finished: a later approval may be for another', async () => {
    const { spawned, processDeps } = deps(plannerHandshake());
    const adapter = new CodexAdapter(processDeps);
    await adapter.start({ kind: 'planner', cwd: '/repo', systemPrompt: 'PLAN' });
    const proc = spawned.processes[0];
    const events: AgentEvent[] = [];
    void adapter.send('plan it', (e) => e.type !== 'runner_loaded' && events.push(e));
    const call = (status: string, method: string) => line({ method, params: { threadId: 'thr-codex-1', turnId: 't', item: { type: 'mcpToolCall', id: 'm1', server: 'todoist', tool: 'find-tasks', status, arguments: {} } } });
    proc.emitStdout(call('inProgress', 'item/started') + call('completed', 'item/completed') + mcpToolApproval(33, 'Allow this call?'));
    await tick();

    // With no tool to scope an approval to, it is refused rather than held.
    expect(events.filter((e) => e.type === 'permission_request')).toEqual([expect.objectContaining({ id: '33', decided: { decision: 'deny' } })]);
    expect(answerTo(proc, 33)?.result).toEqual({ action: 'decline' });
    adapter.dispose();
  });
});

describe('a Codex task on the structured transport', () => {
  function codexRunner(replies: ScriptedReply[]) {
    const { spawned, processDeps } = deps(replies);
    const runner = new StructuredRunner({ process: processDeps });
    return { runner, spawned };
  }

  const spawnOptions = { taskId: 'task-0004-codex', runner: 'codex', prompt: 'Fix sum', modelId: 'gpt-5.5', mode: 'agent', thinkingEffort: 'high', cwd: '/repo', registry: new RunnerRegistry() };

  it('writes tool lines and the whole marker to the plain-text channel, and sends the prompt as the first turn', async () => {
    const { runner, spawned } = codexRunner([...handshake(), fixture('codex', 'task-turn')]);
    const session = await runner.spawn(spawnOptions);

    const chunks: string[] = [];
    session.onOutput((text) => chunks.push(text));
    await new Promise<void>((resolve) => session.onTurnEnd(() => resolve()));

    const [turnStart] = sentNamed(spawned.processes[0].written, 'turn/start');
    expect(turnStart.params).toEqual({ threadId: 'thr-task-1', input: [{ type: 'text', text: 'Fix sum' }], effort: 'high' });
    expect(session.getOutput()).toBe(`› shell(npm test)\n› Update(${shownPath('src', 'sum.ts')})\nFixed the sign in sum.ts.\n<<<ORDEWELL_DONE>>>\n`);
    expect(chunks.some((chunk) => chunk.includes('<<<ORDEWELL_DONE>>>'))).toBe(true);
    expect(session.nativeSessionId()).toBe('thr-task-1');
    session.kill();
  });

  // Codex streams a message's deltas with no paragraph break before them; its
  // completed `agentMessage` used to carry one, so the plain-text channel took
  // the copy for a different text and wrote the message a second time.
  it('writes each streamed message once, a paragraph apart, to the plain-text channel', async () => {
    const message = (id: string, deltas: string[]) => [
      ...deltas.map((delta) => line({ method: 'item/agentMessage/delta', params: { threadId: 'thr-task-1', turnId: 'turn-m', itemId: id, delta } })),
      line({ method: 'item/completed', params: { threadId: 'thr-task-1', turnId: 'turn-m', item: { id, type: 'agentMessage', text: deltas.join('') } } }),
    ].join('');
    const { runner } = codexRunner([...handshake(), [
      line({ method: 'turn/started', params: { threadId: 'thr-task-1', turn: { id: 'turn-m', status: 'inProgress', items: [] } } }),
      message('item_m1', ['Checked ', 'the tests.']),
      message('item_m2', ['Fixed the sign.\n', '<<<ORDEWELL_DONE>>>']),
      line({ method: 'turn/completed', params: { threadId: 'thr-task-1', turn: { id: 'turn-m', status: 'completed', items: [] } } }),
    ].join('')]);
    const session = await runner.spawn(spawnOptions);
    await new Promise<void>((resolve) => session.onTurnEnd(() => resolve()));

    expect(session.getOutput()).toBe('Checked the tests.\n\nFixed the sign.\n<<<ORDEWELL_DONE>>>\n');
    session.kill();
  });

  it('shows a usage limit in the task log in Codex\'s words, and hands the limit and its reset to the session', async () => {
    beforeRecordedReset();
    const { runner } = codexRunner([...handshake(), fixture('codex', 'usage-limit')]);
    const session = await runner.spawn(spawnOptions);
    const events: StructuredEvent[] = [];
    session.onEvent((e) => events.push(e));
    const ended = await new Promise((resolve) => session.onTurnEnd(resolve));

    const message = "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again later.";
    expect(ended).toBe('failed');
    expect(events).toContainEqual({ type: 'error', message, usageLimit: { resetsAt: '2026-10-17T20:42:55.000Z' } });
    const log = replayTaskLog(events.flatMap((e) => toTaskLogEvent(e) ?? []));
    expect(log.blocks).toContainEqual(expect.objectContaining({ type: 'message', role: 'error', text: message }));
    session.kill();
  });

  it('answers an approval by the session\'s own id with the JSON-RPC id Codex asked under', async () => {
    const { runner, spawned } = codexRunner(handshake());
    const session = await runner.spawn(spawnOptions);

    const events: StructuredEvent[] = [];
    session.onEvent((e) => e.type !== 'runner_loaded' && events.push(e));
    await until(() => sentNamed(spawned.processes[0].written, 'turn/start').length > 0);
    const proc = spawned.processes[0];
    proc.emitStdout(turnStarted('turn-a') + commandApproval(0));
    await until(() => events.some((e) => e.type === 'permission_request'));

    const request = events.find((e) => e.type === 'permission_request');
    const id = request?.type === 'permission_request' ? request.id : '';
    expect(id).not.toBe('0');
    expect(session.answerPermission(id, { decision: 'allowForTask' })).toBe(true);
    expect(answerTo(proc, 0)).toEqual({ jsonrpc: '2.0', id: 0, result: { decision: 'acceptForSession' } });
    session.kill();
  });
});

describe('CodexAdapter with the Ordewell MCP server (ADR-0022)', () => {
  const mcp = mcpClientConfig({ url: 'http://127.0.0.1:4555/mcp', token: 'tok-secret' });
  const plannerHandshake = (): ScriptedReply[] => [fixture('codex', 'handshake'), fixture('codex', 'new-conversation')];
  const ordewellServer = {
    url: 'http://127.0.0.1:4555/mcp',
    env_http_headers: { Authorization: 'ORDEWELL_MCP_TOKEN_0' },
    default_tools_approval_mode: 'approve',
  };
  const startup = (status: string) => line({ method: 'mcpServer/startupStatus/updated', params: { name: 'ordewell', status, threadId: 'thr-task-1' } });

  it('gives a task thread the server, pre-approved, with the token in the environment and nowhere else', async () => {
    const { spawned, processDeps } = deps(handshake());
    const adapter = new CodexAdapter(processDeps);
    await adapter.start(taskStart('agent', { mcp }));

    const [threadStart] = sentNamed(spawned.processes[0].written, 'thread/start');
    expect(threadStart.params?.config).toEqual({ mcp_servers: { ordewell: ordewellServer } });
    // Codex lists MCP tools only on request, so the thread says where to look.
    expect(threadStart.params?.developerInstructions).toContain('mcp__ordewell__task_complete');
    expect(spawned.lastArgs()).toEqual(['app-server', '-c', 'features.memories=false']);
    expect(spawned.lastEnv().ORDEWELL_MCP_TOKEN_0).toBe('Bearer tok-secret');
    expect(JSON.stringify(spawned.processes[0].written)).not.toContain('tok-secret');
    adapter.dispose();
  });

  it.each(modeIds(CODEX_MANIFEST))('pre-approves the server on a task thread under %s, whatever the approval policy', async (mode) => {
    const { spawned, processDeps } = deps(handshake());
    const adapter = new CodexAdapter(processDeps);
    await adapter.start(taskStart(mode, { mcp }));

    const [threadStart] = sentNamed(spawned.processes[0].written, 'thread/start');
    expect(threadStart.params?.config).toMatchObject({ mcp_servers: { ordewell: { default_tools_approval_mode: 'approve' } } });
    expect(spawned.lastArgs().join(' ')).not.toContain('tok-secret');
    adapter.dispose();
  });

  it('keeps the Landlock fallback beside the server in the thread config', async () => {
    const { spawned, processDeps } = deps(handshake(), {
      probe: (args) => (args.includes('use_legacy_landlock') ? { code: 0 } : { code: 1, output: 'bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted' }),
    });
    const adapter = new CodexAdapter(processDeps);
    await adapter.start(taskStart('agent', { mcp }));

    const [threadStart] = sentNamed(spawned.processes[0].written, 'thread/start');
    expect(threadStart.params?.config).toEqual({ features: { use_legacy_landlock: true }, mcp_servers: { ordewell: ordewellServer } });
    adapter.dispose();
  });

  it('resumes a task\'s thread with the new attempt\'s server', async () => {
    const { spawned, processDeps } = deps(handshake());
    const adapter = new CodexAdapter(processDeps);
    await adapter.start(taskStart('agent', { mcp, resumeSessionId: 'thr-task-1' }));

    const [resume] = sentNamed(spawned.processes[0].written, 'thread/resume');
    expect(resume.params).toMatchObject({ threadId: 'thr-task-1', config: { mcp_servers: { ordewell: ordewellServer } } });
    adapter.dispose();
  });

  it('gives a planner thread the server and keeps it read-only', async () => {
    const { spawned, processDeps } = deps(plannerHandshake());
    const adapter = new CodexAdapter(processDeps);
    await adapter.start({ kind: 'planner', cwd: '/repo', systemPrompt: 'PLAN', mcp });

    const [thread] = sentNamed(spawned.processes[0].written, 'thread/start');
    expect(thread.params).toEqual({
      cwd: '/repo',
      sandbox: 'read-only',
      approvalPolicy: 'on-request',
      config: { mcp_servers: { ordewell: ordewellServer }, web_search: 'disabled', projects: untrustedRepo() },
      developerInstructions: `PLAN\n\n${CODEX_ORDEWELL.plannerInstructions(false)}`,
    });
    // Codex lists MCP tools only behind its own discovery, and its shell has no network (ADR-0026).
    expect(CODEX_ORDEWELL.plannerInstructions(false)).toContain('`mcp__ordewell__run_command`');
    expect(spawned.lastEnv().ORDEWELL_MCP_TOKEN_0).toBe('Bearer tok-secret');
    adapter.dispose();
  });

  it('adds nothing without a server: no config, no token in the environment', async () => {
    const { spawned, processDeps } = deps(handshake());
    const adapter = new CodexAdapter(processDeps);
    await adapter.start(taskStart('agent'));

    const [threadStart] = sentNamed(spawned.processes[0].written, 'thread/start');
    expect(threadStart.params).not.toHaveProperty('config');
    expect(Object.keys(spawned.lastEnv()).filter((name) => name.startsWith('ORDEWELL_MCP'))).toEqual([]);
    expect(await adapter.mcpAttached()).toBe('failed');
    adapter.dispose();
  });

  describe('under a host that is itself an Ordewell runner\'s child', () => {
    afterEach(() => { vi.unstubAllEnvs(); });

    const tokenNames = (env: NodeJS.ProcessEnv) => Object.keys(env).filter((name) => name.toUpperCase().startsWith('ORDEWELL_MCP_TOKEN_'));

    function inheritParentTokens(): void {
      vi.stubEnv('ORDEWELL_MCP_TOKEN_0', 'Bearer parent-synthetic-0');
      vi.stubEnv('ORDEWELL_MCP_TOKEN_1', 'Bearer parent-synthetic-1');
      vi.stubEnv('ordewell_mcp_token_0', 'Bearer parent-synthetic-lower');
      vi.stubEnv('ORDEWELL_TEST_KEPT', 'yes');
    }

    it('passes none of the parent\'s tokens to a runner given no server', async () => {
      inheritParentTokens();
      const { spawned, processDeps } = deps(handshake());
      const adapter = new CodexAdapter(processDeps);
      await adapter.start(taskStart('agent'));

      expect(tokenNames(spawned.lastEnv())).toEqual([]);
      expect(spawned.lastEnv().ORDEWELL_TEST_KEPT).toBe('yes');
      // Windows spells the one PATH key `Path` (withPath).
      expect(Object.entries(spawned.lastEnv()).filter(([name]) => name.toUpperCase() === 'PATH').map(([, value]) => value)).toEqual(['/usr/bin']);
      adapter.dispose();
    });

    it('replaces the parent\'s token with the attempt\'s, under any spelling, and leaves no surplus one', async () => {
      inheritParentTokens();
      const { spawned, processDeps } = deps(handshake());
      const adapter = new CodexAdapter(processDeps);
      await adapter.start(taskStart('agent', { mcp }));

      expect(tokenNames(spawned.lastEnv())).toEqual(['ORDEWELL_MCP_TOKEN_0']);
      expect(spawned.lastEnv().ORDEWELL_MCP_TOKEN_0).toBe('Bearer tok-secret');
      expect(spawned.lastEnv().ORDEWELL_TEST_KEPT).toBe('yes');
      adapter.dispose();
    });

    it('hands on none of the parent\'s OpenCode server, keeping the rest of that configuration', async () => {
      const parent = { type: 'remote', url: 'http://127.0.0.1:4999/mcp', headers: { Authorization: 'Bearer parent-synthetic' } };
      vi.stubEnv('OPENCODE_CONFIG_CONTENT', JSON.stringify({ model: 'host/model', mcp: { ordewell: parent }, permission: { 'ordewell_*': 'allow' } }));
      for (const opts of [taskStart('agent'), taskStart('agent', { mcp })]) {
        const { spawned, processDeps } = deps(handshake());
        const adapter = new CodexAdapter(processDeps);
        await adapter.start(opts);

        expect(Object.values(spawned.lastEnv()).some((value) => value?.includes('parent-synthetic'))).toBe(false);
        expect(JSON.parse(spawned.lastEnv().OPENCODE_CONFIG_CONTENT ?? 'null')).toEqual({ model: 'host/model' });
        adapter.dispose();
      }
    });

    it('takes no token from the workspace\'s own variables either', async () => {
      const { spawned, processDeps } = deps(handshake());
      const adapter = new CodexAdapter({
        ...processDeps,
        workspaceEnv: async () => ({ ORDEWELL_MCP_TOKEN_0: 'Bearer workspace-synthetic', ordewell_mcp_token_2: 'Bearer workspace-synthetic', PROJECT_VAR: 'kept' }),
      });
      await adapter.start(taskStart('agent', { mcp }));

      expect(tokenNames(spawned.lastEnv())).toEqual(['ORDEWELL_MCP_TOKEN_0']);
      expect(spawned.lastEnv().ORDEWELL_MCP_TOKEN_0).toBe('Bearer tok-secret');
      expect(spawned.lastEnv().PROJECT_VAR).toBe('kept');
      adapter.dispose();
    });
  });

  describe('attachment, as Codex reports it', () => {
    it('is attached once Codex says the server is ready, even when it said so before it was asked', async () => {
      const { spawned, processDeps } = deps(handshake());
      const adapter = new CodexAdapter(processDeps);
      await adapter.start(taskStart('agent', { mcp }));
      spawned.processes[0].emitStdout(startup('starting') + startup('ready'));
      expect(await adapter.mcpAttached()).toBe('connected');
      adapter.dispose();
    });

    it('waits through starting for the answer', async () => {
      const { spawned, processDeps } = deps(handshake());
      const adapter = new CodexAdapter(processDeps);
      await adapter.start(taskStart('agent', { mcp }));
      spawned.processes[0].emitStdout(startup('starting'));
      const attached = adapter.mcpAttached();
      await tick();
      spawned.processes[0].emitStdout(startup('ready'));
      expect(await attached).toBe('connected');
      adapter.dispose();
    });

    it.each(['failed', 'cancelled'])('is not attached when the server %s', async (status) => {
      const { spawned, processDeps } = deps(handshake());
      const adapter = new CodexAdapter(processDeps);
      await adapter.start(taskStart('agent', { mcp }));
      spawned.processes[0].emitStdout(startup(status));
      expect(await adapter.mcpAttached()).toBe('failed');
      adapter.dispose();
    });

    it('is not attached when the process ends before saying', async () => {
      const { spawned, processDeps } = deps(handshake(), { autoMcpAttached: false });
      const adapter = new CodexAdapter(processDeps);
      await adapter.start(taskStart('agent', { mcp }));
      const attached = adapter.mcpAttached();
      spawned.processes[0].exit(1);
      expect(await attached).toBe('failed');
    });

    it('ignores another server\'s report', async () => {
      const { spawned, processDeps } = deps(handshake());
      const adapter = new CodexAdapter(processDeps);
      await adapter.start(taskStart('agent', { mcp }));
      spawned.processes[0].emitStdout(line({ method: 'mcpServer/startupStatus/updated', params: { name: 'linear', status: 'ready' } }) + startup('failed'));
      expect(await adapter.mcpAttached()).toBe('failed');
      adapter.dispose();
    });
  });

  it('answers an approval Codex still raises for an Ordewell tool at once and shows it decided, in a task and in a planner', async () => {
    const ask = (id: number) => line({ id, method: 'mcpServer/elicitation/request', params: { threadId: 'thr-task-1', turnId: 'turn-a', serverName: 'ordewell', mode: 'form', message: 'Allow ordewell to run task_complete?', requestedSchema: { type: 'object', properties: {} } } });
    const task = await (async () => {
      const { spawned, processDeps } = deps(handshake());
      const adapter = new CodexAdapter(processDeps);
      await adapter.start(taskStart('agent', { mcp }));
      const events: AgentEvent[] = [];
      void adapter.send('go', (e) => e.type !== 'runner_loaded' && events.push(e));
      spawned.processes[0].emitStdout(turnStarted('turn-a') + ask(30));
      await tick();
      return { adapter, proc: spawned.processes[0], events };
    })();
    expect(answerTo(task.proc, 30)?.result).toEqual({ action: 'accept', content: {} });
    // Its question names no tool and no call of the server is under way, so only the server can be named.
    expect(task.events.filter((e) => e.type === 'permission_request')).toEqual([
      { type: 'permission_request', id: '30', name: 'ordewell', detail: '{}', input: {}, decided: { decision: 'allow' } },
    ]);
    task.adapter.dispose();

    const { spawned, processDeps } = deps(plannerHandshake());
    const planner = new CodexAdapter(processDeps);
    await planner.start({ kind: 'planner', cwd: '/repo', systemPrompt: 'PLAN', mcp });
    void planner.send('plan', () => {});
    spawned.processes[0].emitStdout(ask(31));
    await tick();
    expect(answerTo(spawned.processes[0], 31)?.result).toEqual({ action: 'accept', content: {} });
    planner.dispose();
  });

  it.each(['ordewell_x', 'ordewellx', 'Ordewell'])('asks about an elicitation from a server named %s like any other', async (serverName) => {
    const { spawned, processDeps } = deps(handshake());
    const adapter = new CodexAdapter(processDeps);
    await adapter.start(taskStart('agent', { mcp }));
    const events: AgentEvent[] = [];
    void adapter.send('go', (e) => e.type !== 'runner_loaded' && events.push(e));
    spawned.processes[0].emitStdout(turnStarted('turn-a') + line({ id: 32, method: 'mcpServer/elicitation/request', params: { threadId: 'thr-task-1', turnId: 'turn-a', serverName, mode: 'form', message: `Allow ${serverName} to run task_complete?`, requestedSchema: { type: 'object', properties: {} } } }));
    await tick();

    expect(answerTo(spawned.processes[0], 32)).toBeUndefined();
    expect(events.find((e) => e.type === 'permission_request')).toMatchObject({ id: '32', name: 'mcp_elicitation' });
    adapter.dispose();
  });

  it('shows an Ordewell tool call under the name Claude Code gives it, and another server\'s under its own', async () => {
    const call = (id: string, server: string, tool: string) => line({ method: 'item/started', params: { threadId: 'thr-task-1', turnId: 'turn-a', item: { id, type: 'mcpToolCall', server, tool, status: 'inProgress', arguments: { status: 'done', summary: 'ok' } } } });
    const done = (id: string, server: string, tool: string) => line({ method: 'item/completed', params: { threadId: 'thr-task-1', turnId: 'turn-a', item: { id, type: 'mcpToolCall', server, tool, status: 'completed', arguments: {}, result: { content: [{ type: 'text', text: 'Recorded.' }] } } } });
    const { adapter, events } = await openTurn([call('m1', 'ordewell', 'task_complete'), done('m1', 'ordewell', 'task_complete'), call('m2', 'linear', 'create_issue'), done('m2', 'linear', 'create_issue')]);

    expect(events.filter((e) => e.type === 'tool_call' || e.type === 'tool_result').map((e) => [e.type, e.type === 'tool_call' || e.type === 'tool_result' ? e.name : ''])).toEqual([
      ['tool_call', 'mcp__ordewell__task_complete'],
      ['tool_result', 'mcp__ordewell__task_complete'],
      ['tool_call', 'create_issue'],
      ['tool_result', 'create_issue'],
    ]);
    expect(events.find((e) => e.type === 'tool_result')).toMatchObject({ output: 'Recorded.', success: true });
    adapter.dispose();
  });

  // Codex's search raises no request, so the policy decides it once, at thread start (ADR-0027).
  describe('a planner thread\'s built-in web search', () => {
    function reads(setting: ApprovalModeSetting, autonomous: boolean, allow: string[] = []) {
      const approval = new ApprovalPolicy({ mode: (kind) => effectiveApprovalMode(setting, autonomous, kind), preApproved: allow });
      return new WebReadPolicy({ approval, env: () => ({}) });
    }

    async function plannerThread(policy?: WebReadPolicy) {
      const { spawned, processDeps } = deps(plannerHandshake());
      const adapter = new CodexAdapter(processDeps);
      await adapter.start({ kind: 'planner', cwd: '/repo', systemPrompt: 'PLAN', mcp, ...(policy ? { nativeSearch: policy.searchesUnasked(CODEX_ORDEWELL.sessionSearchProvider!) } : {}) });
      const [thread] = sentNamed(spawned.processes[0].written, 'thread/start');
      adapter.dispose();
      return thread.params as { config: Record<string, unknown>; developerInstructions: string };
    }

    it.each<[string, ApprovalModeSetting, boolean, string[], 'cached' | 'disabled']>([
      ['Full under auto', 'auto', true, [], 'cached'],
      ['an explicit allow', 'allow', false, [], 'cached'],
      ['Guarded under auto', 'auto', false, [], 'cached'],
      ['an explicit ask', 'ask', true, [], 'disabled'],
      ['an explicit allowlist, in Full', 'deny', true, [], 'disabled'],
      ['an explicit allowlist that names OpenAI search', 'deny', true, ['web_search:openai'], 'cached'],
    ])('is %s → %s', async (_label, setting, autonomous, allow, mode) => {
      const thread = await plannerThread(reads(setting, autonomous, allow));

      expect(thread.config.web_search).toBe(mode);
      expect(thread.developerInstructions).toContain(CODEX_ORDEWELL.plannerInstructions(mode === 'cached'));
    });

    it('is off when nothing can decide it', async () => {
      expect((await plannerThread()).config.web_search).toBe('disabled');
    });

    // Planner-only: a task, an ops task above all (ADR-0020), keeps the user's own search setting.
    it.each(modeIds(CODEX_MANIFEST).filter((mode) => mode !== 'plan'))('leaves a %s task thread with no search setting of Ordewell\'s, fresh or resumed', async (mode) => {
      const { spawned, processDeps } = deps([...handshake(), ...handshake()]);
      const opened: RpcLine[] = [];
      for (const resumeSessionId of [undefined, 'thr-task-1']) {
        const adapter = new CodexAdapter(processDeps);
        await adapter.start(taskStart(mode, { mcp, ...(resumeSessionId ? { resumeSessionId } : {}) }));
        opened.push(...written(spawned.processes.at(-1)!.written).filter((msg) => msg.method === 'thread/start' || msg.method === 'thread/resume'));
        adapter.dispose();
      }

      const { approvalPolicy, approvalsReviewer } = taskStart(mode).flags.modeSettings;
      const expected = {
        cwd: '/repo',
        sandbox: taskStart(mode).flags.permissionMode,
        ...(approvalPolicy ? { approvalPolicy } : {}),
        ...(approvalsReviewer ? { approvalsReviewer } : {}),
        developerInstructions: CODEX_ORDEWELL.taskInstructions(),
        config: { mcp_servers: { ordewell: ordewellServer } },
      };
      expect(opened.map((msg) => msg.params)).toEqual([expected, { threadId: 'thr-task-1', ...expected }]);
    });

    it('asks a change task thread for its commit, and no other (ADR-0047)', async () => {
      const { spawned, processDeps } = deps([...handshake(), ...handshake()]);
      const instructions: string[] = [];
      for (const commits of [undefined, true] as const) {
        const adapter = new CodexAdapter(processDeps);
        await adapter.start(taskStart('agent', { mcp, ...(commits ? { commits } : {}) }));
        const [thread] = sentNamed(spawned.processes.at(-1)!.written, 'thread/start');
        instructions.push((thread.params as { developerInstructions: string }).developerInstructions);
        adapter.dispose();
      }

      expect(instructions[0]).toBe(CODEX_ORDEWELL.taskInstructions());
      expect(instructions[0].endsWith(TASK_COMPLETION_CONTRACT)).toBe(true);
      expect(instructions[1].endsWith(taskCompletionContract({ commits: true }))).toBe(true);
    });

    it('is never live, which opens pages the model chose', () => {
      expect([CODEX_ORDEWELL.plannerWebSearch(true), CODEX_ORDEWELL.plannerWebSearch(false)]).toEqual(['cached', 'disabled']);
    });

    it('is named first when on, and Ordewell\'s web_search only when off; pages are fetched through Ordewell either way', () => {
      const on = CODEX_ORDEWELL.plannerInstructions(true);
      const off = CODEX_ORDEWELL.plannerInstructions(false);

      expect(on).toContain('Search the web with your built-in web search.');
      expect(on).not.toContain('Your built-in web search is off');
      expect(off).toContain('search with `mcp__ordewell__web_search`');
      for (const text of [on, off]) expect(text).toContain('Fetch web pages with `mcp__ordewell__fetch`, not curl');
    });
  });

  it('shows what each built-in search did: every query, and the page it opened or searched in', async () => {
    const search = (id: string, action: Record<string, unknown> | null, query = '') => line({ method: 'item/completed', params: { threadId: 'thr-task-1', turnId: 'turn-a', item: { id, type: 'webSearch', query, action, results: null } } });
    const { adapter, events } = await openTurn([
      // Codex starts every search with an empty query; the call must not carry it.
      line({ method: 'item/started', params: { threadId: 'thr-task-1', turnId: 'turn-a', item: { id: 'w1', type: 'webSearch', query: '', action: { type: 'other' } } } }),
      search('w1', { type: 'search', query: 'tokio 1.40 changelog', queries: null }),
      search('w2', { type: 'search', query: null, queries: ['hono routing', 'hono middleware'] }),
      search('w3', { type: 'openPage', url: 'https://hono.dev/docs' }),
      search('w4', { type: 'findInPage', url: 'https://hono.dev/docs', pattern: 'basePath' }),
      search('w5', null, 'legacy query'),
    ]);

    expect(events.filter((e) => e.type === 'tool_result').map((e) => (e.type === 'tool_result' ? e.output : ''))).toEqual([
      'tokio 1.40 changelog',
      'hono routing\nhono middleware',
      'open https://hono.dev/docs',
      'find "basePath" in https://hono.dev/docs',
      'legacy query',
    ]);
    expect(events.filter((e) => e.type === 'tool_call').map((e) => (e.type === 'tool_call' ? [e.id, e.args] : []))).toEqual([
      ['w1', { query: 'tokio 1.40 changelog' }],
      ['w2', { queries: ['hono routing', 'hono middleware'] }],
      ['w3', { url: 'https://hono.dev/docs' }],
      ['w4', { url: 'https://hono.dev/docs', pattern: 'basePath' }],
      ['w5', { query: 'legacy query' }],
    ]);
    // Each call lands right before its result, so no row waits with an empty query.
    expect(events.filter((e) => e.type === 'tool_call' || e.type === 'tool_result').map((e) => e.type)).toEqual(Array(5).fill(['tool_call', 'tool_result']).flat());
    adapter.dispose();
  });

  it('is a runner whose structured tasks are taught the tools', () => {
    const instructions = CODEX_ORDEWELL.taskInstructions();
    for (const tool of ['task_complete', 'checkpoint', 'read']) expect(instructions).toContain(`\`mcp__ordewell__${tool}\``);
    expect(instructions).toContain('ALL_TOOLS');
    expect(instructions.endsWith(TASK_COMPLETION_CONTRACT)).toBe(true);

    // A read-only task is told its one shell is Ordewell's, and a plain task is not (ADR-0046).
    const readOnly = CODEX_ORDEWELL.taskInstructions({ readOnly: true });
    expect(readOnly).toContain('`mcp__ordewell__run_command`');
    expect(readOnly).toContain('It is your only shell');
    expect(instructions).not.toContain('run_command');
  });
});

const userMessage = (clientId: string | null, method = 'item/started') => line({
  method, params: { threadId: 'thr-task-1', turnId: 'turn-a', item: { id: `item-${clientId}`, type: 'userMessage', clientId, content: [{ type: 'text', text: 'steered' }] } },
});

describe('CodexAdapter task steer (ADR-0023)', () => {
  it('steers into the running turn by both its ids, under a client message id its userMessage item later names', async () => {
    const { adapter, proc } = await startedTask();
    const events: AgentEvent[] = [];
    void adapter.send('go', (e) => e.type !== 'runner_loaded' && events.push(e));
    proc.emitStdout(turnStarted('turn-a'));

    const accepted = adapter.steer('msg-1', 'use Postgres');
    const [steer] = sentNamed(proc.written, 'turn/steer');
    expect(steer.params).toEqual({
      threadId: 'thr-task-1', expectedTurnId: 'turn-a', input: [{ type: 'text', text: 'use Postgres' }],
      clientUserMessageId: expect.any(String),
    });
    proc.emitStdout(line({ id: steer.id, result: { turnId: 'turn-a' } }));
    expect(await accepted).toBe(true);
    expect(events).toEqual([]);

    const clientId = String(steer.params?.clientUserMessageId);
    proc.emitStdout(userMessage(clientId) + userMessage(clientId, 'item/completed') + turnCompleted('turn-a'));
    await tick();
    expect(events).toEqual([{ type: 'message_delivered', id: 'msg-1' }, { type: 'turn_end' }]);
    adapter.dispose();
  });

  it('holds a steer until Codex names the turn, as it does an interrupt', async () => {
    const { adapter, proc } = await startedTask();
    void adapter.send('go', () => {});
    const accepted = adapter.steer('msg-1', 'use Postgres');
    await tick();
    expect(sentNamed(proc.written, 'turn/steer')).toHaveLength(0);

    const [turnStart] = sentNamed(proc.written, 'turn/start');
    proc.emitStdout(line({ id: turnStart.id, result: { turn: { id: 'turn-a', status: 'inProgress', items: [] } } }));
    await until(() => sentNamed(proc.written, 'turn/steer').length > 0);
    const [steer] = sentNamed(proc.written, 'turn/steer');
    expect(steer.params?.expectedTurnId).toBe('turn-a');
    proc.emitStdout(line({ id: steer.id, result: { turnId: 'turn-a' } }));
    expect(await accepted).toBe(true);
    adapter.dispose();
  });

  it('answers false when Codex refuses the steer, so the message waits for the turn to end', async () => {
    const { adapter, proc } = await startedTask();
    void adapter.send('go', () => {});
    proc.emitStdout(turnStarted('turn-a'));

    const refused = adapter.steer('msg-1', 'use Postgres');
    const [steer] = sentNamed(proc.written, 'turn/steer');
    proc.emitStdout(line({ id: steer.id, error: { code: -32600, message: 'no active turn to steer' } }));
    expect(await refused).toBe(false);
    adapter.dispose();
  });

  it('has nothing to steer into between turns', async () => {
    const { adapter, proc } = await startedTask();
    expect(await adapter.steer('msg-1', 'use Postgres')).toBe(false);
    expect(sentNamed(proc.written, 'turn/steer')).toHaveLength(0);
    adapter.dispose();
  });

  it.each([
    ['completed', [turnCompleted('turn-a')], { type: 'turn_end' }],
    ['interrupted', [turnCompleted('turn-a', 'interrupted')], { type: 'turn_end', interrupted: true }],
    ['by the thread going idle', [threadIdle()], { type: 'turn_end' }],
  ] as const)('drops a steer the turn ended %s without consuming, ahead of the turn\'s end', async (_label, endings, ended) => {
    const { adapter, proc } = await startedTask();
    const events: AgentEvent[] = [];
    void adapter.send('go', (e) => e.type !== 'runner_loaded' && events.push(e));
    proc.emitStdout(turnStarted('turn-a'));
    const accepted = adapter.steer('msg-1', 'use Postgres');
    const [steer] = sentNamed(proc.written, 'turn/steer');
    proc.emitStdout(line({ id: steer.id, result: { turnId: 'turn-a' } }));
    expect(await accepted).toBe(true);

    for (const ending of endings) proc.emitStdout(ending);
    await tick();
    expect(events).toEqual([{ type: 'message_dropped', id: 'msg-1' }, ended]);
    adapter.dispose();
  });

  it('refuses a steer still unanswered when the turn ends, and ignores the answer that lands after', async () => {
    const { adapter, proc } = await startedTask();
    const events: AgentEvent[] = [];
    void adapter.send('go', (e) => e.type !== 'runner_loaded' && events.push(e));
    proc.emitStdout(turnStarted('turn-a'));
    const refused = adapter.steer('msg-1', 'use Postgres');
    const [steer] = sentNamed(proc.written, 'turn/steer');

    proc.emitStdout(turnCompleted('turn-a') + line({ id: steer.id, result: { turnId: 'turn-a' } }));
    expect(await refused).toBe(false);
    expect(events).toEqual([{ type: 'turn_end' }]);
    adapter.dispose();
  });

  it('refuses a steer held for a turn Codex refused to start', async () => {
    const { adapter, proc } = await startedTask();
    void adapter.send('go', () => {});
    const refused = adapter.steer('msg-1', 'use Postgres');
    const [turnStart] = sentNamed(proc.written, 'turn/start');
    proc.emitStdout(line({ id: turnStart.id, error: { message: 'thread busy' } }));
    expect(await refused).toBe(false);
    expect(sentNamed(proc.written, 'turn/steer')).toHaveLength(0);
    adapter.dispose();
  });

  it('refuses a steer in flight when the process ends', async () => {
    const { adapter, proc } = await startedTask();
    void adapter.send('go', () => {});
    proc.emitStdout(turnStarted('turn-a'));
    const refused = adapter.steer('msg-1', 'use Postgres');
    proc.exit(1);
    expect(await refused).toBe(false);
  });

  it('delivers a message whose userMessage item lands before its steer is answered, once', async () => {
    const { adapter, proc } = await startedTask();
    const events: AgentEvent[] = [];
    void adapter.send('go', (e) => e.type !== 'runner_loaded' && events.push(e));
    proc.emitStdout(turnStarted('turn-a'));
    const accepted = adapter.steer('msg-1', 'use Postgres');
    const [steer] = sentNamed(proc.written, 'turn/steer');

    proc.emitStdout(userMessage(String(steer.params?.clientUserMessageId)) + line({ id: steer.id, result: { turnId: 'turn-a' } }) + turnCompleted('turn-a'));
    expect(await accepted).toBe(true);
    await tick();
    expect(events).toEqual([{ type: 'message_delivered', id: 'msg-1' }, { type: 'turn_end' }]);
    adapter.dispose();
  });

  it('takes the turn\'s own input and another client\'s messages for nothing it sent', async () => {
    const { adapter, proc } = await startedTask();
    const events: AgentEvent[] = [];
    void adapter.send('go', (e) => e.type !== 'runner_loaded' && events.push(e));
    proc.emitStdout(turnStarted('turn-a') + userMessage(null) + userMessage('someone-else'));
    await tick();
    expect(events).toEqual([]);
    adapter.dispose();
  });
});

describe('a Codex task taking a message mid-turn on the structured transport', () => {
  it('hands the message to the running turn and logs it where Codex delivered it, in one turn', async () => {
    const { spawned, processDeps } = deps(handshake());
    const runner = new StructuredRunner({ process: processDeps });
    const session = await runner.spawn({ taskId: 'task-0012-steer', runner: 'codex', prompt: 'Fix sum', modelId: 'gpt-5.5', mode: 'fullAccess', cwd: '/repo', registry: new RunnerRegistry() });

    const events: StructuredEvent[] = [];
    session.onEvent((e) => e.type !== 'runner_loaded' && events.push(e));
    await until(() => sentNamed(spawned.processes[0].written, 'turn/start').length > 0);
    const proc = spawned.processes[0];
    proc.emitStdout(turnStarted('turn-a') + line({ method: 'item/started', params: { threadId: 'thr-task-1', turnId: 'turn-a', item: { id: 'cmd-1', type: 'commandExecution', command: 'sleep 20', cwd: '/repo' } } }));

    const id = session.sendMessage('use Postgres');
    await until(() => sentNamed(proc.written, 'turn/steer').length > 0);
    const [steer] = sentNamed(proc.written, 'turn/steer');
    proc.emitStdout(line({ id: steer.id, result: { turnId: 'turn-a' } }));
    await until(() => events.some((e) => e.type === 'message_handed_over'));
    expect(session.queued()).toEqual([{ id, text: 'use Postgres', handedOver: true }]);

    const ended = new Promise<void>((resolve) => session.onTurnEnd(() => resolve()));
    proc.emitStdout(
      line({ method: 'item/completed', params: { threadId: 'thr-task-1', turnId: 'turn-a', item: { id: 'cmd-1', type: 'commandExecution', command: 'sleep 20', cwd: '/repo', aggregatedOutput: '', exitCode: 0 } } })
      + userMessage(String(steer.params?.clientUserMessageId))
      + line({ method: 'item/completed', params: { threadId: 'thr-task-1', turnId: 'turn-a', item: { id: 'msg-a', type: 'agentMessage', text: 'Using Postgres.' } } })
      + turnCompleted('turn-a'),
    );
    await ended;

    expect(events.map((e) => e.type)).toEqual([
      'turn_start', 'tool_call', 'message_queued', 'message_handed_over', 'tool_result', 'message_delivered', 'assistant_text', 'turn_end',
    ]);
    expect(session.queued()).toEqual([]);
    expect(sentNamed(proc.written, 'turn/start')).toHaveLength(1);
    expect(session.turnState()).toBe('idle');
    session.kill();
  });

  it('sends a message Codex dropped unread as the next turn', async () => {
    const { spawned, processDeps } = deps(handshake());
    const runner = new StructuredRunner({ process: processDeps });
    const session = await runner.spawn({ taskId: 'task-0012-steer', runner: 'codex', prompt: 'Fix sum', modelId: 'gpt-5.5', mode: 'fullAccess', cwd: '/repo', registry: new RunnerRegistry() });

    await until(() => sentNamed(spawned.processes[0].written, 'turn/start').length > 0);
    const proc = spawned.processes[0];
    proc.emitStdout(turnStarted('turn-a'));

    session.sendMessage('use Postgres');
    await until(() => sentNamed(proc.written, 'turn/steer').length > 0);
    proc.emitStdout(line({ id: sentNamed(proc.written, 'turn/steer')[0].id, result: { turnId: 'turn-a' } }) + turnCompleted('turn-a'));

    await until(() => sentNamed(proc.written, 'turn/start').length > 1);
    expect(sentNamed(proc.written, 'turn/start')[1].params?.input).toEqual([{ type: 'text', text: 'use Postgres' }]);
    expect(session.turnState()).toBe('working');
    session.kill();
  });

  it('force sends a message Codex already accepted: interrupts, and re-sends the steer it discards as the next turn, forced (ADR-0023, F1)', async () => {
    const { spawned, processDeps } = deps(handshake());
    const runner = new StructuredRunner({ process: processDeps });
    const session = await runner.spawn({ taskId: 'task-0012-steer', runner: 'codex', prompt: 'Fix sum', modelId: 'gpt-5.5', mode: 'fullAccess', cwd: '/repo', registry: new RunnerRegistry() });
    const events: StructuredEvent[] = [];
    session.onEvent((e) => events.push(e));

    await until(() => sentNamed(spawned.processes[0].written, 'turn/start').length > 0);
    const proc = spawned.processes[0];
    proc.emitStdout(turnStarted('turn-a'));
    const id = session.sendMessage('use Postgres');
    await until(() => sentNamed(proc.written, 'turn/steer').length > 0);
    proc.emitStdout(line({ id: sentNamed(proc.written, 'turn/steer')[0].id, result: { turnId: 'turn-a' } }));
    await until(() => session.queued().some((m) => m.handedOver));

    expect(session.forceSendQueued(id)).toBe(true);
    await until(() => sentNamed(proc.written, 'turn/interrupt').length > 0);
    proc.emitStdout(line({ id: sentNamed(proc.written, 'turn/interrupt')[0].id, result: {} }) + turnCompleted('turn-a', 'interrupted'));

    await until(() => sentNamed(proc.written, 'turn/start').length > 1);
    expect(sentNamed(proc.written, 'turn/start')[1].params?.input).toEqual([{ type: 'text', text: 'use Postgres' }]);
    expect(sentNamed(proc.written, 'turn/steer')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'turn_start').at(-1)).toEqual({ type: 'turn_start', text: 'use Postgres', messageId: id, forced: true });
    expect(session.turnState()).toBe('working');
    session.kill();
  });
});


describe('CodexAdapter native commands', () => {
  it('lists native compaction and enabled skills for this workspace, without custom prompts or TUI commands', async () => {
    const { processDeps, spawned } = deps(handshake(), { codexDiscovery: (method) => method === 'skills/list'
      ? { data: [{ cwd: '/repo', skills: [
        { name: 'hello', description: 'Say hello', path: '/repo/.agents/skills/hello/SKILL.md', enabled: true },
        { name: 'off', description: 'Disabled', path: '/repo/off', enabled: false },
      ], errors: [] }] }
      : { data: [{ name: 'ordewell', runtimeStatus: 'ready' }, { name: 'docs', runtimeStatus: 'ready' }], nextCursor: null } });
    const adapter: TaskModeAgentAdapter = new CodexAdapter(processDeps);
    await adapter.start(taskStart('fullAccess'));
    expect(adapter.commands?.()).toEqual([
      { name: 'compact', description: 'Compact the conversation context', kind: 'builtin' },
      { name: 'hello', description: 'Say hello', kind: 'skill' },
    ]);
    const events: AgentEvent[] = [];
    const turn = adapter.send('hi', (e) => events.push(e));
    spawned.processes[0].emitStdout(line({ method: 'turn/completed', params: { threadId: 'thr-task-1', turn: { id: 'turn-hello', status: 'completed' } } }));
    await turn;
    expect(events.find((e) => e.type === 'runner_loaded')).toEqual({ type: 'runner_loaded', commands: adapter.commands?.(), mcpServers: [{ name: 'docs', status: 'ready' }] });
    expect(sentNamed(spawned.processes[0].written, 'skills/list')[0].params).toEqual({ cwds: ['/repo'] });
    adapter.dispose();
  });
});


it('invokes a discovered Codex skill as typed native input with its arguments and plan effort', async () => {
  const { processDeps, spawned } = deps(handshake(), { codexDiscovery: (method) => method === 'skills/list'
    ? { data: [{ cwd: '/repo', skills: [{ name: 'hello', description: 'Say hello', path: '/repo/hello/SKILL.md', enabled: true }] }] }
    : { data: [] } });
  const adapter: TaskModeAgentAdapter = new CodexAdapter(processDeps);
  await adapter.start(taskStart('fullAccess', { model: 'gpt-5.5' }));
  const events: AgentEvent[] = [];
  const turn = adapter.invokeCommand!('hello', 'Bob', (e) => events.push(e));
  spawned.processes[0].emitStdout(line({ method: 'turn/completed', params: { threadId: 'thr-task-1', turn: { id: 'skill-turn', status: 'completed' } } }));
  await turn;
  expect(sentNamed(spawned.processes[0].written, 'turn/start')[0].params).toEqual({
    threadId: 'thr-task-1', input: [{ type: 'skill', name: 'hello', path: '/repo/hello/SKILL.md' }, { type: 'text', text: 'Bob' }], effort: 'high',
  });
  expect(events.at(-1)).toEqual({ type: 'turn_end' });
  adapter.dispose();
});


it('waits for Codex native compaction to finish and reports manual and automatic boundaries', async () => {
  const { processDeps, spawned } = deps(handshake());
  const adapter: TaskModeAgentAdapter = new CodexAdapter(processDeps);
  await adapter.start(taskStart('fullAccess'));
  const events: AgentEvent[] = [];
  let ended = false;
  const turn = adapter.invokeCommand!('compact', '', (e) => events.push(e)).then(() => { ended = true; });
  const proc = spawned.processes[0];
  const request = sentNamed(proc.written, 'thread/compact/start')[0];
  expect(request.params).toEqual({ threadId: 'thr-task-1' });
  proc.emitStdout(line({ id: request.id, result: {} }) + line({ method: 'item/completed', params: { threadId: 'unrelated-thread', item: { id: 'unrelated-compact', type: 'contextCompaction' } } }));
  await tick();
  expect(ended).toBe(false);
  proc.emitStdout(turnStarted('compact-turn') + line({ method: 'item/completed', params: { threadId: 'thr-task-1', item: { id: 'compact-item', type: 'contextCompaction' } } }) + turnCompleted('compact-turn'));
  await turn;
  expect(events.filter((e) => e.type === 'compaction')).toEqual([{ type: 'compaction', trigger: 'manual' }]);
  const next = adapter.send('continue', (e) => events.push(e));
  proc.emitStdout(turnStarted('next-turn') + line({ method: 'item/completed', params: { threadId: 'thr-task-1', item: { id: 'auto-item', type: 'contextCompaction' } } }) + turnCompleted('next-turn'));
  await next;
  expect(events.filter((e) => e.type === 'compaction')).toEqual([{ type: 'compaction', trigger: 'manual' }, { type: 'compaction', trigger: 'auto' }]);
  // Codex reports no size after one, so the meter knows none until the next call.
  expect(events.filter((e) => e.type === 'usage')).toEqual([
    { type: 'usage', record: { source: 'codex', compacted: true } },
    { type: 'usage', record: { source: 'codex', compacted: true } },
  ]);
  expect(sentNamed(proc.written, 'turn/start')).toHaveLength(1);
  adapter.dispose();
});

describe('CodexAdapter in a lease\'s container (ADR-0059 L7)', () => {
  const BWRAP_FAILURE = 'bwrap: No permissions to create a new namespace, likely because the kernel does not allow non-privileged user namespaces.';
  const noSandbox = { probe: () => ({ code: 1, output: BWRAP_FAILURE }) };

  /** Docker on this host, whatever the runner asked for: a probe spawned as `codex` here would be asking the wrong machine. */
  function placed() {
    const launches: RunnerLaunch[] = [];
    const ended = vi.fn();
    const placement = {
      cwd: '/task/work/repo',
      place: async (launch: RunnerLaunch): Promise<PlacedLaunch> => {
        launches.push(launch);
        return { command: 'docker', args: [...launch.args], env: { OPENAI_API_KEY: 'ordewell-lease-token' }, stop: () => {}, ended };
      },
      reach: async (url: string) => url,
      blob: async () => undefined,
    };
    return { placement, launches, ended };
  }

  function placedDeps(replies: ScriptedReply[], options: FakeSpawnOptions = {}) {
    const { spawned, processDeps } = deps(replies, options);
    const commands: Array<{ command: string; args: readonly string[]; env: NodeJS.ProcessEnv | undefined }> = [];
    const { placement, launches, ended } = placed();
    const spawn: AgentProcessDeps['spawn'] = (command, args, spawnOptions) => {
      commands.push({ command, args, env: spawnOptions?.env });
      return spawned.spawn(command, args, spawnOptions);
    };
    // A mac's Codex is no answer for the Linux one in the container.
    return { spawned, commands, launches, ended, adapter: new CodexAdapter({ ...processDeps, spawn, platform: 'darwin', placement }) };
  }

  it('tells Codex where it runs: this host\'s path means nothing in there', async () => {
    const { spawned, adapter } = placedDeps(handshake());
    await adapter.start(taskStart('fullAccess', { cwd: '/Users/me/worktrees/task-4' }));

    const proc = spawned.processes[0];
    expect(sentNamed(proc.written, 'thread/start')[0].params?.cwd).toBe('/task/work/repo');
    expect(sentNamed(proc.written, 'skills/list')[0].params).toEqual({ cwds: ['/task/work/repo'] });
    expect(JSON.stringify(proc.written)).not.toContain('/Users/me');
    adapter.dispose();
  });

  it('lists the skills Codex reports for the container\'s path', async () => {
    const { processDeps } = deps(handshake(), {
      codexDiscovery: (method) => method === 'skills/list' ? { data: [{ cwd: '/task/work/repo', skills: [{ name: 'lint', description: 'Lint it', path: '/task/work/repo/.agents/skills/lint/SKILL.md', enabled: true }] }] } : { data: [], nextCursor: null },
    });
    const adapter = new CodexAdapter({ ...processDeps, placement: placed().placement });
    await adapter.start(taskStart('fullAccess', { cwd: '/Users/me/worktrees/task-4' }));

    expect(adapter.commands?.().map(({ name }) => name)).toContain('lint');
    adapter.dispose();
  });

  it('shows a changed file relative to the container\'s worktree', async () => {
    const { spawned, adapter } = placedDeps(handshake());
    await adapter.start(taskStart('fullAccess', { cwd: '/Users/me/worktrees/task-4' }));
    const events: AgentEvent[] = [];
    const turn = adapter.send('go', (e) => events.push(e));
    const proc = spawned.processes[0];
    const change = [{ path: '/task/work/repo/src/sum.js', kind: { type: 'update' }, diff: '' }];
    proc.emitStdout(turnStarted('turn-a') + fileChangeStarted('item-1', change) + fileChangeDone('item-1', 'completed', change) + turnCompleted('turn-a'));
    await turn;

    const call = events.find((e) => e.type === 'tool_call');
    expect(call?.type === 'tool_call' && call.args).toEqual({ path: 'src/sum.js' });
    adapter.dispose();
  });

  it('asks the container, not this host, whether a sandboxed task can run, and refuses in its own words', async () => {
    const { spawned, commands, launches, ended, adapter } = placedDeps(handshake(), noSandbox);

    const started = adapter.start(taskStart('agent', { cwd: '/Users/me/worktrees/task-4' }));
    await expect(started).rejects.toThrow(/container/);
    await expect(started).rejects.toThrow(/Full access or another runner/);
    await expect(started).rejects.not.toThrow(/sysctl/);
    expect(launches.filter(({ args }) => args[0] === 'sandbox').map(({ command, args }) => [command, ...args])).toEqual([
      ['codex', 'sandbox', '--', '/bin/true'],
      ['codex', 'sandbox', '--enable', 'use_legacy_landlock', '--', '/bin/true'],
    ]);
    const probes = commands.filter(({ args }) => args[0] === 'sandbox');
    expect(probes.map(({ command }) => command)).toEqual(['docker', 'docker']);
    // What a lease handed by name, the docker CLI must have to pass on.
    expect(probes[0].env?.OPENAI_API_KEY).toBe('ordewell-lease-token');
    expect(sentNamed(spawned.processes[0].written, 'thread/start')).toHaveLength(0);
    // The two probes and the app-server: a lease waits for each to end before it closes.
    await vi.waitFor(() => expect(ended).toHaveBeenCalledTimes(3));
  });

  it('asks a container\'s Codex nothing of a Windows sandbox, whichever host places it', async () => {
    const { spawned, processDeps } = deps(handshake(), { probe: () => ({ code: 0 }) });
    const adapter = new CodexAdapter({ ...processDeps, platform: 'win32', placement: placed().placement });
    await adapter.start(taskStart('agent'));

    expect(sentNamed(spawned.processes[0].written, 'windowsSandbox/readiness')).toEqual([]);
    adapter.dispose();
  });

  it('runs a sandboxed task when the sandbox does start in the container', async () => {
    const { spawned, adapter } = placedDeps(handshake(), { probe: () => ({ code: 0 }) });
    await adapter.start(taskStart('agent'));

    expect(sentNamed(spawned.processes[0].written, 'thread/start')[0].params?.sandbox).toBe('workspace-write');
    adapter.dispose();
  });

  it('asks nothing of a sandbox a full-access task does not use, whose absence is no fault in a container', async () => {
    const { spawned, commands, adapter } = placedDeps([fixture('codex', 'handshake-warning'), fixture('codex', 'task-thread'), fixture('codex', 'task-turn')], noSandbox);
    await adapter.start(taskStart('fullAccess'));
    const events: AgentEvent[] = [];
    await adapter.send('fix sum', (e) => e.type !== 'runner_loaded' && events.push(e));

    expect(commands.filter(({ args }) => args[0] === 'sandbox')).toEqual([]);
    expect(sentNamed(spawned.processes[0].written, 'thread/start')[0].params?.sandbox).toBe('danger-full-access');
    expect(events.filter((e) => e.type === 'thinking' && /bubblewrap/i.test(e.text))).toEqual([]);
    adapter.dispose();
  });
});
