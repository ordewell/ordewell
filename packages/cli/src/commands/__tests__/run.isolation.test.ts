import { describe, it, expect, vi } from 'vitest';
import type { ApiClient } from '../../apiClient';
import { followExecution } from '../run';

type Event = Parameters<Parameters<ApiClient['streamExecution']>[1]>[0];

const blocked: Event = { type: 'isolation_blocked', reason: 'dirty', message: 'Tracked files have uncommitted changes' };
const handoff: Event = { type: 'isolation_handoff', branch: 'ordewell/r1/integration', baseRef: 'abc', landed: [{ taskId: 't1', order: 1, title: 'One' }] };
const complete: Event = { type: 'execution_complete', summary: { total: 1, completed: 1, failed: 0 } };

/** Each call to streamExecution plays the next script of events, then settles. */
function fakeApi(...scripts: Event[][]) {
  const api = {
    streamExecution: vi.fn(async (_id: string, onEvent: (e: Event) => void) => {
      for (const event of scripts.shift() ?? []) onEvent(event);
    }),
    stopExecution: vi.fn().mockResolvedValue({ status: 'stopped' }),
    continueWithStash: vi.fn().mockResolvedValue(undefined),
    continueWithoutIsolation: vi.fn().mockResolvedValue(undefined),
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

describe('followExecution over a run a dirty tree blocked', () => {
  it('releases the parked start and says how to choose, when no choice was given', async () => {
    const { api, client } = fakeApi([blocked]);

    const { stderr, exit } = await capture(() => followExecution(client, 's1'));

    expect(api.stopExecution).toHaveBeenCalledWith('s1');
    expect(exit).toBe('exit:1');
    expect(stderr).toMatch(/--stash.*--without-isolation/);
  });

  it.each([
    ['stash', 'continueWithStash'],
    ['shared', 'continueWithoutIsolation'],
  ] as const)('%s: continues the run and follows it to the end', async (choice, method) => {
    const { api, client } = fakeApi([blocked], [handoff, complete]);

    const { stdout, exit } = await capture(() => followExecution(client, 's1', choice));

    expect(exit).toBeNull();
    expect(api[method]).toHaveBeenCalledWith('s1');
    expect(api.stopExecution).not.toHaveBeenCalled();
    expect(stdout).toMatch(/Done\. 1 completed/);
  });
});

describe('followExecution at the end of an isolated run', () => {
  it('names the branch and the handoff command', async () => {
    const { client } = fakeApi([handoff, complete]);

    const { stdout } = await capture(() => followExecution(client, 's1'));

    expect(stdout).toContain('Run finished on ordewell/r1/integration — 1 task landed.');
    expect(stdout).toContain('ordewell handoff');
  });
});
