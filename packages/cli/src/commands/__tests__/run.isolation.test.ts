import { describe, it, expect, vi } from 'vitest';
import type { ApiClient } from '../../apiClient';
import { handleRun } from '../run';
import { handleApprove } from '../approve';

type Event = Parameters<Parameters<ApiClient['streamExecution']>[1]>[0];

const blocked: Event = { type: 'isolation_blocked', reason: 'dirty', message: 'Tracked files have uncommitted changes' };
const landed = [{ taskId: 't1', order: 1, title: 'One' }];
const handoff: Event = { type: 'isolation_handoff', repos: [{ path: '.', integrationBranch: 'ordewell/r1/integration', baseRef: 'abc', landed }], landed };
const complete: Event = { type: 'execution_complete', summary: { total: 1, completed: 1, failed: 0 } };

const TERMINAL = new Set(['execution_complete', 'execution_stopped', 'isolation_blocked']);

/**
 * Like the daemon: an event reaches only a stream already subscribed when it
 * is broadcast. Each call that starts or resumes work broadcasts its script.
 */
function liveDaemon(scripts: { execute?: Event[]; approve?: Event[]; stash?: Event[]; shared?: Event[] }) {
  const subscribers = new Set<(event: Event) => void>();
  const broadcast = (events: Event[] = []) => { for (const event of events) for (const s of [...subscribers]) s(event); };
  const api = {
    streamExecution: vi.fn((_id: string, onEvent: (e: Event) => void, onReady?: (error?: Error) => void) => new Promise<void>((resolve) => {
      const subscriber = (event: Event) => {
        onEvent(event);
        if (TERMINAL.has(event.type)) { subscribers.delete(subscriber); resolve(); }
      };
      subscribers.add(subscriber);
      setTimeout(() => onReady?.(), 0);
    })),
    executePlan: vi.fn(async () => { broadcast(scripts.execute); return { status: 'running' }; }),
    approveReview: vi.fn(async () => { broadcast(scripts.approve); }),
    stopExecution: vi.fn().mockResolvedValue({ status: 'stopped' }),
    continueWithStash: vi.fn(async () => { broadcast(scripts.stash); }),
    continueWithoutIsolation: vi.fn(async () => { broadcast(scripts.shared); }),
  };
  return { api, client: api as unknown as ApiClient };
}

async function capture(fn: () => Promise<void>) {
  const logs: string[] = [];
  const errs: string[] = [];
  const spies = [
    vi.spyOn(console, 'log').mockImplementation((m: string) => { logs.push(m); }),
    vi.spyOn(console, 'error').mockImplementation((m: string) => { errs.push(m); }),
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit:${code}`); }) as never),
  ];
  let exit: string | null = null;
  try {
    await fn();
  } catch (e) {
    exit = (e as Error).message;
  } finally {
    spies.forEach((spy) => spy.mockRestore());
  }
  return { stdout: logs.join('\n'), stderr: errs.join('\n'), exit };
}

// The block is announced while the start call is still in flight, so a command
// that subscribed only after it returned waited forever for a run that never began.
describe('ordewell run on a tree that blocks isolation', () => {
  it('releases the parked start and says how to choose, when no choice was given', async () => {
    const { api, client } = liveDaemon({ execute: [blocked] });

    const { stderr, exit } = await capture(() => handleRun(['--session-id', 's1'], client));

    expect(api.stopExecution).toHaveBeenCalledWith('s1');
    expect(exit).toBe('exit:1');
    expect(stderr).toMatch(/--stash.*--without-isolation/);
  });

  it.each([
    ['--stash', 'stash', 'continueWithStash'],
    ['--without-isolation', 'shared', 'continueWithoutIsolation'],
  ] as const)('%s: continues the run and follows it to the end', async (flag, script, method) => {
    const { api, client } = liveDaemon({ execute: [blocked], [script]: [handoff, complete] });

    const { stdout, exit } = await capture(() => handleRun(['--session-id', 's1', flag], client));

    expect(exit).toBeNull();
    expect(api[method]).toHaveBeenCalledWith('s1');
    expect(api.stopExecution).not.toHaveBeenCalled();
    expect(stdout).toMatch(/Done\. 1 completed/);
  });

  it('ordewell approve reports a block the same way', async () => {
    const { api, client } = liveDaemon({ approve: [blocked] });

    const { exit } = await capture(() => handleApprove(['--session-id', 's1'], client));

    expect(api.stopExecution).toHaveBeenCalledWith('s1');
    expect(exit).toBe('exit:1');
  });
});

describe('ordewell run at the end of an isolated run', () => {
  it('names the branch and the handoff command', async () => {
    const { client } = liveDaemon({ execute: [handoff, complete] });

    const { stdout } = await capture(() => handleRun(['--session-id', 's1'], client));

    expect(stdout).toContain('Run finished on ordewell/r1/integration — 1 task landed.');
    expect(stdout).toContain('ordewell handoff');
  });
});

describe('ordewell run over a repo group', () => {
  const at = (order: number) => ({ taskId: `t${order}`, order, title: `Task ${order}` });
  const groupRepos = [
    { path: 'api', integrationBranch: 'ordewell/r1/integration', baseRef: 'a', landed: [at(1), at(2), at(3)] },
    { path: 'infra', integrationBranch: 'ordewell/r1/integration', baseRef: 'b', landed: [] },
  ];
  const groupHandoff: Event = { type: 'isolation_handoff', repos: groupRepos, landed: [at(1), at(2), at(3)] };

  it('says per repo what landed, and where to land it', async () => {
    const { client } = liveDaemon({ execute: [groupHandoff, complete] });

    const { stdout } = await capture(() => handleRun(['--session-id', 's1'], client));

    expect(stdout).toContain('Run finished on ordewell/r1/integration in api, infra — 3 tasks landed.');
    expect(stdout).toContain('  api: 3 tasks landed');
    expect(stdout).toContain('  infra: nothing to merge');
    expect(stdout).toContain('ordewell handoff');
  });

  it('prints the notices a run gives about how it isolates', async () => {
    const { client } = liveDaemon({ execute: [
      { type: 'notice', level: 'info', message: 'NOTES.md is shared live with every task, so edits to it are not isolated.' },
      complete,
    ] });

    const { stderr } = await capture(() => handleRun(['--session-id', 's1'], client));

    expect(stderr).toContain('NOTES.md is shared live with every task, so edits to it are not isolated.');
  });

  it('names the dirty repos, and says --stash stashes all of them', async () => {
    const dirty: Event = { type: 'isolation_blocked', reason: 'dirty', repos: ['api', 'web'], message: 'Tracked files have uncommitted changes in api, web' };
    const { client } = liveDaemon({ execute: [dirty] });

    const { stderr } = await capture(() => handleRun(['--session-id', 's1'], client));

    expect(stderr).toContain('Tracked files have uncommitted changes in api, web');
    expect(stderr).toContain('`--stash` to stash your tracked changes in api, web first');
  });

  it('--stash stashes every dirty repo through the one call, and follows the run', async () => {
    const dirty: Event = { type: 'isolation_blocked', reason: 'dirty', repos: ['api', 'web'], message: 'dirty' };
    const { api, client } = liveDaemon({ execute: [dirty], stash: [groupHandoff, complete] });

    const { stdout, exit } = await capture(() => handleRun(['--session-id', 's1', '--stash'], client));

    expect(exit).toBeNull();
    expect(api.continueWithStash).toHaveBeenCalledTimes(1);
    expect(stdout).toContain('api: 3 tasks landed');
  });
});
