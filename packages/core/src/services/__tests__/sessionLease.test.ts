import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createTask, type LegacyPlanState } from '../../models/Task';
import * as sessionStore from '../../utils/sessionStore';
import { LEASE_STALE_MS, LeaseHost, SessionHeldError } from '../sessionLease';
import { leasedIsolation } from '../leasedIsolation';
import { FakeWorktreeIsolation, flushMicrotasks } from '../../testing';
import type { IsolationRun } from '../../interfaces/IWorktreeIsolation';
import { FakeRunnerSession, makeSession } from './sessionTestKit';
import type { IRunner } from '../../interfaces/IRunner';

const GOAL = 'build me a parser';
const SESSION = 'session-shared';

/** The run record host A's worktrees are under: what host B continued in the incident. */
function liveRun(workspace: string): IsolationRun {
  return {
    id: 'c78e9e08',
    workspaceRoot: workspace,
    repos: [{ path: '.', root: workspace, baseRef: 'base0000', baseBranch: 'main', integrationBranch: 'ordewell/c78e9e08/integration' }],
    shared: [],
    sharedRepos: [],
    tasks: {
      t1: { taskId: 't1', order: 1, title: 'Parse', branch: 'ordewell/c78e9e08/1-parse', workspace: `${workspace}/.ordewell/worktrees/c78e9e08/1-parse`, status: 'active', repos: {} },
    },
  };
}

function savedPlan(): LegacyPlanState {
  return {
    tasks: [createTask({ id: 't1', order: 1, title: 'Parse', prompt: 'do it', assignedRunner: 'claude-code' })],
    generatedAt: '2026-10-24T01:00:00.000Z',
    status: 'draft',
    runners: ['claude-code'],
    lastUpdated: '2026-10-24T01:00:00.000Z',
  };
}

/**
 * Two hosts over one real workspace, each a Session with its own host
 * identity: what two Ordewell processes are, minus the second process.
 */
describe('the session lease (ADR-0049)', () => {
  let workspace: string;
  const hosts: LeaseHost[] = [];

  function host(options: ConstructorParameters<typeof LeaseHost>[0] = {}): LeaseHost {
    const made = new LeaseHost(options);
    hosts.push(made);
    return made;
  }

  /** A host's Session, saving through the real store in the shared workspace. */
  function sessionOn(leaseHost: LeaseHost) {
    return makeSession({ saveSession: sessionStore.saveSession, leaseHost, workspaceRoot: () => workspace });
  }

  function adopt(session: ReturnType<typeof sessionOn>): void {
    const saved = sessionStore.loadSession(SESSION, workspace)!;
    session.loadPlan(saved.plan, saved.meta.goal, workspace, { sessionId: SESSION });
  }

  function refusal(fn: () => void): SessionHeldError {
    try {
      fn();
    } catch (err) {
      if (err instanceof SessionHeldError) return err;
      throw err;
    }
    throw new Error('expected the adoption to be refused');
  }

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-lease-'));
    sessionStore.saveSession(savedPlan(), GOAL, workspace, SESSION);
  });

  afterEach(() => {
    for (const made of hosts.splice(0)) made.releaseAll();
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it('refuses a second host while the first holds a live lease, and names the holder', () => {
    const first = sessionOn(host({ id: 'host-a', pid: 37797, alive: () => true, kind: () => ({ kind: 'daemon', port: 49558, ownerPid: 76271 }) }));
    adopt(first);
    const second = sessionOn(host({ id: 'host-b', alive: () => true }));

    const err = refusal(() => adopt(second));

    expect(err.held.holder).toMatchObject({ pid: 37797, host: { kind: 'daemon', port: 49558, ownerPid: 76271 } });
    expect(Date.parse(err.held.holder.since)).not.toBeNaN();
    expect(err.message).toContain('pid 37797');
    expect(err.message).toContain('TUI (pid 76271)');
    expect(err.message).toContain('port 49558');
    // Refused before it took anything: the second host holds no plan of it.
    expect(second.planState).toBeNull();
  });

  it('takes the lease over once the holder\'s pid is dead, so a crashed host\'s session can be reopened', () => {
    adopt(sessionOn(host({ id: 'host-a', pid: 37797 })));
    const second = sessionOn(host({ id: 'host-b', alive: (pid) => pid !== 37797 }));

    adopt(second);

    expect(second.planState?.tasks.map((t) => t.id)).toEqual(['t1']);
    expect(second.heldElsewhere()).toBeNull();
  });

  it('takes the lease over once the holder\'s heartbeat is stale, though its pid answers', () => {
    const start = Date.parse('2026-10-24T01:40:00.000Z');
    adopt(sessionOn(host({ id: 'host-a', pid: 37797, now: () => start })));
    // The pid answers, but nothing has refreshed the lease for over a minute:
    // the holder is hung, or its pid now names another process.
    const second = sessionOn(host({ id: 'host-b', alive: () => true, now: () => start + LEASE_STALE_MS + 1 }));

    adopt(second);

    expect(second.planState).not.toBeNull();
  });

  it('keeps refusing a takeover while runners the dead holder started still run, and names them', () => {
    adopt(sessionOn(host({ id: 'host-a', pid: 37797, runnerGroups: () => [4242, 4343] })));
    const groupsAlive = new Set([4343]);
    const second = sessionOn(host({ id: 'host-b', alive: () => false, groupAlive: (pgid) => groupsAlive.has(pgid) }));

    const err = refusal(() => adopt(second));
    expect(err.held.orphanedRunners).toEqual([4343]);
    expect(err.message).toContain('is gone');
    expect(err.message).toContain('kill -TERM -- -4343');

    groupsAlive.clear();
    adopt(second);
    expect(second.planState).not.toBeNull();
  });

  it('records the runner groups the holder starts with each heartbeat', () => {
    let groups: number[] = [];
    const first = host({ id: 'host-a', pid: 37797, runnerGroups: () => groups });
    adopt(sessionOn(first));
    groups = [5151];

    first.beat();

    const err = refusal(() => adopt(sessionOn(host({ id: 'host-b', alive: () => false, groupAlive: () => true }))));
    expect(err.held.orphanedRunners).toEqual([5151]);
  });

  it('lets the lease go when the session closes', () => {
    const first = sessionOn(host({ id: 'host-a', pid: 37797, alive: () => true }));
    adopt(first);
    const second = sessionOn(host({ id: 'host-b', alive: () => true }));
    refusal(() => adopt(second));

    first.destroy();

    adopt(second);
    expect(second.planState).not.toBeNull();
    expect(fs.existsSync(path.join(sessionStore.sessionDataDir(SESSION, workspace), 'lease.json'))).toBe(true);
  });

  it('does not take the lease again when a save settles after the Session was destroyed', async () => {
    const first = sessionOn(host({ id: 'host-a', pid: 37797, alive: () => true }));
    adopt(first);
    first.destroy();

    // A Run, a close or a replacement still in flight when the Session went
    // saves once it settles: that is not a reason to hold the session again.
    await first.addTask({ title: 'Settled late', prompt: 'p', assignedRunner: 'claude-code' });

    expect(fs.existsSync(path.join(sessionStore.sessionDataDir(SESSION, workspace), 'lease.json'))).toBe(false);
    expect(() => adopt(sessionOn(host({ id: 'host-b', alive: () => true })))).not.toThrow();
  });

  it('lets the lease go with the last Session of a host that a destroyed one saved late for', async () => {
    const first = host({ id: 'host-a', pid: 37797, alive: () => true });
    const old = sessionOn(first);
    adopt(old);
    const replacement = sessionOn(first);
    adopt(replacement);
    old.destroy();
    await old.addTask({ title: 'Settled late', prompt: 'p', assignedRunner: 'claude-code' });

    replacement.destroy();

    expect(fs.existsSync(path.join(sessionStore.sessionDataDir(SESSION, workspace), 'lease.json'))).toBe(false);
  });

  it('lets every lease go when the host shuts down', () => {
    const first = host({ id: 'host-a', pid: 37797, alive: () => true });
    adopt(sessionOn(first));

    first.releaseAll();

    expect(fs.existsSync(path.join(sessionStore.sessionDataDir(SESSION, workspace), 'lease.json'))).toBe(false);
  });

  it('a host whose lease was taken over saves nothing more of the session', async () => {
    const start = Date.parse('2026-10-24T01:40:00.000Z');
    const notices: string[] = [];
    const first = makeSession({
      saveSession: sessionStore.saveSession,
      leaseHost: host({ id: 'host-a', pid: 37797, now: () => start }),
      workspaceRoot: () => workspace,
      onNotice: (notice) => { notices.push(notice.message); },
    });
    adopt(first);
    // A host that judged the first gone took the session and saved it.
    const second = sessionOn(host({ id: 'host-b', alive: () => true, now: () => start + LEASE_STALE_MS + 1, kind: () => ({ kind: 'vscode' }) }));
    adopt(second);
    await second.addTask({ title: 'Added by the host that holds it', prompt: 'p', assignedRunner: 'claude-code' });
    const saved = fs.readFileSync(sessionFile(), 'utf8');
    expect(saved).toContain('Added by the host that holds it');

    // The first host wakes up and edits: nothing it does may reach the file.
    await first.addTask({ title: 'Added by the host that lost it', prompt: 'p', assignedRunner: 'claude-code' });

    expect(fs.readFileSync(sessionFile(), 'utf8')).toBe(saved);
    expect(notices.some((n) => n.includes('Another Ordewell host took this session over') && n.includes('VS Code window'))).toBe(true);
    expect(first.heldElsewhere()?.holder.hostId).toBe('host-b');
  });

  it('a refused host touches nothing of the holder\'s isolation run', async () => {
    sessionStore.saveSession({ ...savedPlan(), isolation: { run: liveRun(workspace), resolvers: {} } }, GOAL, workspace, SESSION);
    adopt(sessionOn(host({ id: 'host-a', pid: 37797, alive: () => true })));
    const isolation = new FakeWorktreeIsolation();
    const second = makeSession({ saveSession: sessionStore.saveSession, leaseHost: host({ id: 'host-b', alive: () => true }), workspaceRoot: () => workspace, isolation });

    refusal(() => adopt(second));
    await flushMicrotasks();

    // Adopting would prune the run's `active` worktrees as a crash's leftovers.
    expect(isolation.calls).toEqual([]);
  });

  it('refuses planning anew under the id of a session another host holds, before any planner turn', async () => {
    adopt(sessionOn(host({ id: 'host-a', pid: 37797, alive: () => true })));
    const startConversation = vi.fn();
    const second = makeSession({
      saveSession: sessionStore.saveSession, leaseHost: host({ id: 'host-b', alive: () => true }), workspaceRoot: () => workspace,
      sessionId: SESSION, aiService: { startConversation },
    });

    await expect(second.startPlanning('a different goal')).rejects.toBeInstanceOf(SessionHeldError);
    await expect(second.generatePlan('a different goal')).rejects.toBeInstanceOf(SessionHeldError);
    expect(startConversation).not.toHaveBeenCalled();
  });

  it('keeps the lease while a host replaces its Session with another of its own for the same session', () => {
    const first = host({ id: 'host-a', pid: 37797, alive: () => true });
    const old = sessionOn(first);
    adopt(old);
    // A daemon replaces a live session under its id: the new one is built and
    // takes the plan before the old one is closed.
    adopt(sessionOn(first));
    old.destroy();

    expect(() => adopt(sessionOn(host({ id: 'host-b', alive: () => true })))).toThrow(SessionHeldError);
  });

  it('stops its runners when another host takes the session over, so they do not work beside that host\'s', async () => {
    const start = Date.parse('2026-10-24T01:40:00.000Z');
    sessionStore.saveSession({ ...savedPlan(), status: 'approved' }, GOAL, workspace, SESSION);
    const runners: FakeRunnerSession[] = [];
    const runner: IRunner = {
      spawn: vi.fn(async ({ taskId }: Parameters<IRunner['spawn']>[0]) => {
        const made = new FakeRunnerSession(`s${runners.length + 1}`, taskId);
        runners.push(made);
        return made;
      }),
      stop: vi.fn(),
      stopAll: vi.fn(),
      activeCount: 0,
    };
    const firstHost = host({ id: 'host-a', pid: 37797, now: () => start });
    const first = makeSession({ saveSession: sessionStore.saveSession, leaseHost: firstHost, workspaceRoot: () => workspace, runner });
    adopt(first);
    await first.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(runners).toHaveLength(1));
    // Its runner has since ended, so a host that judges this one gone may take over.
    adopt(sessionOn(host({ id: 'host-b', alive: () => true, now: () => start + LEASE_STALE_MS + 1 })));

    firstHost.beat();

    await vi.waitFor(() => expect(first.isExecuting).toBe(false));
    expect(runner.stopAll).toHaveBeenCalled();
  });

  it('stops the run and lets the lease go when no save reaches the disk as the session closes', async () => {
    const runners: FakeRunnerSession[] = [];
    const runner: IRunner = {
      spawn: vi.fn(async ({ taskId }: Parameters<IRunner['spawn']>[0]) => {
        const made = new FakeRunnerSession(`s${runners.length + 1}`, taskId);
        runners.push(made);
        return made;
      }),
      stop: vi.fn(),
      stopAll: vi.fn(),
      activeCount: 0,
    };
    const first = makeSession({ saveSession: sessionStore.saveSession, leaseHost: host({ id: 'host-a', alive: () => true }), workspaceRoot: () => workspace, runner });
    adopt(first);
    await first.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(runners).toHaveLength(1));
    runners[0].emitEvent({ type: 'usage', record: { source: 'claude-code', inputTokens: 10 } });
    // A rename over a directory fails as a full disk does: on the save itself, every time.
    const file = sessionFile();
    fs.rmSync(file);
    fs.mkdirSync(file);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => first.destroy()).not.toThrow();

    expect(logged).toHaveBeenCalledWith('[Session] save failed:', expect.objectContaining({ code: 'EISDIR' }));
    logged.mockRestore();
    await vi.waitFor(() => expect(first.activity.running).toBe(false));
    expect(runner.stopAll).toHaveBeenCalled();
    expect(fs.existsSync(path.join(sessionStore.sessionDataDir(SESSION, workspace), 'lease.json'))).toBe(false);
    fs.rmdirSync(file);
    sessionStore.saveSession(savedPlan(), GOAL, workspace, SESSION);
    expect(() => adopt(sessionOn(host({ id: 'host-b', alive: () => true })))).not.toThrow();
  });

  it('keeps the session open and lets the other go when the disk refuses a load', () => {
    const OTHER = 'session-other000';
    const leaseOf = (id: string) => path.join(sessionStore.sessionDataDir(id, workspace), 'lease.json');
    const first = sessionOn(host({ id: 'host-a', alive: () => true }));
    adopt(first);
    const meta = sessionStore.saveSession(savedPlan(), 'another goal', workspace, OTHER);
    const other = path.join(workspace, '.ordewell', 'sessions', fs.readdirSync(path.join(workspace, '.ordewell', 'sessions')).find((f) => f.includes(OTHER.slice('session-'.length, 16)))!);
    const loaded = sessionStore.loadSession(meta.id, workspace)!;
    // A rename over a directory fails as a full disk does.
    fs.rmSync(other);
    fs.mkdirSync(other);

    expect(() => first.loadPlan(loaded.plan, loaded.meta.goal, workspace, { sessionId: OTHER })).toThrow(/not opened/);

    expect(first.sessionId).toBe(SESSION);
    expect(fs.existsSync(leaseOf(SESSION))).toBe(true);
    expect(fs.existsSync(leaseOf(OTHER))).toBe(false);
    fs.rmdirSync(other);
    first.destroy();
  });

  function sessionFile(): string {
    const dir = path.join(workspace, '.ordewell', 'sessions');
    const [file] = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    return path.join(dir, file);
  }
});

describe('leasedIsolation (ADR-0049)', () => {
  const holder = { hostId: 'host-a', pid: 37797, since: '2026-10-24T01:40:00.000Z', heartbeatAt: '2026-10-24T01:40:00.000Z', runnerGroups: [] };

  it('refuses every change to the run while another host holds the session, and lets reads through', async () => {
    const git = new FakeWorktreeIsolation();
    let held: typeof holder | null = holder;
    const isolation = leasedIsolation(git, () => (held ? { holder: held } : null));
    const run = liveRun('/repo');
    const t1 = createTask({ id: 't1', order: 1, title: 'Parse', prompt: 'do it' });

    await expect(isolation.prepare(t1, run)).rejects.toBeInstanceOf(SessionHeldError);
    await expect(isolation.pruneOrphans(run)).rejects.toBeInstanceOf(SessionHeldError);
    await expect(isolation.release(run, 't1', { keep: false })).rejects.toBeInstanceOf(SessionHeldError);
    await expect(isolation.startRun('/repo')).rejects.toBeInstanceOf(SessionHeldError);
    await isolation.isActive('/repo');
    await isolation.reviewDiff(run);
    expect(git.calls.map((c) => c.op)).toEqual(['isActive', 'reviewDiff']);

    held = null;
    await isolation.prepare(t1, run);
    expect(git.taskIdsFor('prepare')).toEqual(['t1']);
  });
});
