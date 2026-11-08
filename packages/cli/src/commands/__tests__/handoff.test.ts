import { describe, it, expect, vi } from 'vitest';
import http from 'http';
import { ApiClient } from '../../apiClient';
import { wireRoute } from '../../__tests__/wireRoute';

vi.mock('../../utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils')>()),
  readLastSession: () => ({ sessionId: 'session-1', goal: 'g', runners: ['claude-code'], workspace: '/tmp/ws' }),
}));

interface Hit { method: string; url: string; body: string }

function daemon(respond: (hit: Hit) => { status?: number; body: unknown }): Promise<{ port: number; hits: Hit[]; close: () => void }> {
  const hits: Hit[] = [];
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const hit = { method: req.method ?? '', url: wireRoute(req.url), body: Buffer.concat(chunks).toString('utf8') };
        hits.push(hit);
        const answer = respond(hit);
        res.writeHead(answer.status ?? 200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(answer.body));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({ port: (server.address() as { port: number }).port, hits, close: () => server.close() });
    });
  });
}

async function capture(fn: () => Promise<void>): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  const logs: string[] = [];
  const errs: string[] = [];
  const logSpy = vi.spyOn(console, 'log').mockImplementation((m: string) => { logs.push(m); });
  const errSpy = vi.spyOn(console, 'error').mockImplementation((m: string) => { errs.push(m); });
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit:${code}`); }) as never);
  let exitCode: number | null = null;
  try {
    await fn();
  } catch (e: unknown) {
    const match = ((e as Error).message || '').match(/^exit:(\d+)$/);
    if (match) exitCode = parseInt(match[1], 10);
    else throw e;
  } finally {
    logSpy.mockRestore();
    errSpy.mockRestore();
    exitSpy.mockRestore();
  }
  return { stdout: logs.join('\n'), stderr: errs.join('\n'), exitCode };
}

const isolatedPlan = {
  tasks: [],
  isolation: {
    resolvers: {},
    run: {
      id: 'r1', workspaceRoot: '/tmp/ws', baseRef: 'abcdef1234567890', baseBranch: 'main', integrationBranch: 'ordewell/r1/integration',
      tasks: { t1: { taskId: 't1', order: 1, title: 'One', branch: 'ordewell/r1/1-t1', worktree: '/w', status: 'merged', linked: [] } },
    },
  },
};

const repoRecord = (path: string, changed: boolean) => ({ worktree: `/w/${path}`, linked: [], changed });
const groupPlan = {
  tasks: [],
  isolation: {
    resolvers: {},
    run: {
      id: 'r1', workspaceRoot: '/tmp/ws', shared: [], sharedRepos: [],
      repos: ['api', 'web', 'infra'].map((path) => ({ path, root: `/tmp/ws/${path}`, baseRef: `${path}base1234567890`, baseBranch: 'main', integrationBranch: 'ordewell/r1/integration' })),
      tasks: {
        t1: { taskId: 't1', order: 1, title: 'One', branch: 'ordewell/r1/1-t1', workspace: '/w', status: 'merged', repos: { api: repoRecord('api', true), web: repoRecord('web', true), infra: repoRecord('infra', false) } },
        t2: { taskId: 't2', order: 2, title: 'Two', branch: 'ordewell/r1/2-t2', workspace: '/w', status: 'merged', repos: { api: repoRecord('api', true), web: repoRecord('web', false), infra: repoRecord('infra', false) } },
      },
    },
  },
};

/**
 * A daemon holding a session with an isolated run, answering each handoff route.
 * Like the real one, only adoption answers with the saved plan itself; reading a
 * session answers the phase-shaped view, which carries no run record.
 */
type Answer = { status?: number; body: unknown };
function isolatedDaemon(over: Record<string, Answer | ((hit: Hit) => Answer)> = {}, savedPlan: unknown = isolatedPlan) {
  return daemon((hit) => {
    const { method, url } = hit;
    if (url.includes('/load')) return { body: { plan: savedPlan, goal: 'g' } };
    if (method === 'GET' && url.startsWith('/api/sessions/session-1')) {
      return { body: { meta: { id: 'session-1' }, plan: { phase: 'executing', history: [], message: '', executionLog: [], pendingTasks: [] } } };
    }
    const route = Object.keys(over).find((key) => url.endsWith(key));
    const answer = route ? over[route] : undefined;
    return typeof answer === 'function' ? answer(hit) : answer ?? { body: { ok: true } };
  });
}

const run = async (args: string[], srv: { port: number }, confirm = vi.fn().mockResolvedValue(true)) => {
  const { handleHandoff } = await import('../handoff');
  return { ...(await capture(() => handleHandoff(['--workspace', '/tmp/ws', ...args], new ApiClient(srv.port), confirm))), confirm };
};

describe('ordewell handoff', () => {
  it('with no argument prints the options and needs no daemon', async () => {
    const { handleHandoff } = await import('../handoff');
    const { stdout, exitCode } = await capture(() => handleHandoff([]));

    expect(exitCode).toBeNull();
    for (const action of ['review', 'merge', 'discard', 'cleanup']) expect(stdout).toContain(action);
  });

  it('rejects an action it does not know', async () => {
    const { handleHandoff } = await import('../handoff');
    const { stderr, exitCode } = await capture(() => handleHandoff(['deploy']));

    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/Unknown handoff action "deploy"/);
  });

  it('review prints the integration diff', async () => {
    const srv = await isolatedDaemon({ '/isolation/diff': { body: { diff: 'diff --git a/x b/x' } } });
    const { stdout, exitCode } = await run(['review'], srv);
    srv.close();

    expect(exitCode).toBeNull();
    expect(stdout).toBe('diff --git a/x b/x');
  });

  it('review says which branch an empty diff is against', async () => {
    const srv = await isolatedDaemon({ '/isolation/diff': { body: { diff: '\n' } } });
    const { stdout } = await run(['review'], srv);
    srv.close();

    expect(stdout).toBe('Nothing differs from main @ abcdef12.');
  });

  it('merge asks first, then merges', async () => {
    const srv = await isolatedDaemon({ '/isolation/merge': { body: { outcome: 'merged' } } });
    const { stdout, confirm } = await run(['merge'], srv);
    srv.close();

    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('Merge ordewell/r1/integration into main?'));
    expect(srv.hits.some((h) => h.url.endsWith('/isolation/merge'))).toBe(true);
    expect(stdout).toMatch(/Merged ordewell\/r1\/integration/);
  });

  describe('past a check that has not passed (ADR-0055 D9)', () => {
    const ASKED = 'This merges work no check has passed: #2 "Check the subtree" has not.';
    /** The daemon refuses a Merge all that does not carry the yes, naming the check. */
    const holding = () => isolatedDaemon({
      '/isolation/merge': (hit) => (JSON.parse(hit.body || '{}').pastChecks === true
        ? { body: { outcome: 'merged' } }
        : { status: 409, body: { error: ASKED, code: 'merge_past_check' } }),
    });
    const merges = (srv: { hits: Hit[] }) => srv.hits.filter((h) => h.url.endsWith('/isolation/merge'));

    it('asks again, naming the check, and merges when told to', async () => {
      const srv = await holding();
      const { stdout, confirm } = await run(['merge'], srv);
      srv.close();

      expect(confirm).toHaveBeenCalledTimes(2);
      expect(confirm).toHaveBeenLastCalledWith(`${ASKED} Merge anyway?`);
      expect(merges(srv).map((h) => JSON.parse(h.body || '{}'))).toEqual([{}, { pastChecks: true }]);
      expect(stdout).toMatch(/Merged ordewell\/r1\/integration/);
    });

    it('merges nothing when the second answer is no', async () => {
      const srv = await holding();
      const { stderr, exitCode } = await run(['merge'], srv, vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false));
      srv.close();

      expect(exitCode).toBe(1);
      expect(stderr).toMatch(/Not confirmed/);
      expect(merges(srv)).toHaveLength(1);
    });

    it('is not covered by --yes alone, which stands in for the first question only', async () => {
      const srv = await holding();
      const { stderr, exitCode, confirm } = await run(['merge', '--yes'], srv, vi.fn().mockResolvedValue(false));
      srv.close();

      expect(exitCode).toBe(1);
      expect(confirm).toHaveBeenCalledTimes(1);
      expect(stderr).toMatch(/Not confirmed/);
    });

    it('is told by --past-checks, which sends the yes with the first request', async () => {
      const srv = await holding();
      const { stdout, confirm } = await run(['merge', '--yes', '--past-checks'], srv);
      srv.close();

      expect(confirm).not.toHaveBeenCalled();
      expect(merges(srv).map((h) => JSON.parse(h.body || '{}'))).toEqual([{ pastChecks: true }]);
      expect(stdout).toMatch(/Merged/);
    });
  });

  it('merge does nothing when the answer is no', async () => {
    const srv = await isolatedDaemon();
    const { stderr, exitCode } = await run(['merge'], srv, vi.fn().mockResolvedValue(false));
    srv.close();

    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/Not confirmed/);
    expect(srv.hits.some((h) => h.url.endsWith('/isolation/merge'))).toBe(false);
  });

  it('--yes stands in for the question', async () => {
    const srv = await isolatedDaemon({ '/isolation/discard': { body: { ok: true } } });
    const { stdout, confirm } = await run(['discard', '--yes'], srv);
    srv.close();

    expect(confirm).not.toHaveBeenCalled();
    expect(srv.hits.some((h) => h.url.endsWith('/isolation/discard'))).toBe(true);
    expect(stdout).toMatch(/Discarded the run/);
  });

  it('reports a conflicted merge as a failure that left the tree alone', async () => {
    const srv = await isolatedDaemon({ '/isolation/merge': { body: { outcome: 'conflict' } } });
    const { stderr, exitCode } = await run(['merge', '--yes'], srv);
    srv.close();

    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/conflicted.*your tree is as it was/);
  });

  it('cleanup needs no confirmation', async () => {
    const srv = await isolatedDaemon();
    const { stdout, confirm } = await run(['cleanup'], srv);
    srv.close();

    expect(confirm).not.toHaveBeenCalled();
    expect(stdout).toMatch(/worktrees and task branches; ordewell\/r1\/integration is kept/);
  });

  it('names a task that only landed after a conflict repair, before asking to merge (ADR-0015)', async () => {
    const repairedPlan = {
      tasks: [],
      isolation: {
        resolvers: {},
        run: {
          id: 'r1', workspaceRoot: '/tmp/ws', shared: [], sharedRepos: [],
          repos: [{ path: '.', root: '/tmp/ws', baseRef: 'abcdef1234567890', integrationBranch: 'ordewell/r1/integration' }],
          tasks: {
            t1: {
              taskId: 't1', order: 1, title: 'One', branch: 'ordewell/r1/1-t1', workspace: '/w', status: 'merged',
              repos: { '.': { worktree: '/w', linked: [], changed: true } }, repairs: 1, repairedFiles: ['a.ts'],
            },
          },
        },
      },
    };
    const srv = await isolatedDaemon({ '/isolation/merge': { body: { outcome: 'merged' } } }, repairedPlan);
    const { confirm } = await run(['merge'], srv);
    srv.close();

    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('One (a.ts) landed through a conflict repair.'));
  });

  it('says so when the session never isolated', async () => {
    const srv = await daemon(({ url }) => ({ body: url.includes('/load') ? { plan: { tasks: [] }, goal: 'g' } : { meta: {}, plan: { tasks: [] } } }));
    const { stderr, exitCode } = await run(['merge', '--yes'], srv);
    srv.close();

    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/no isolated run/);
  });
});

describe('ordewell handoff over a repo group', () => {
  const group = (over: Record<string, { status?: number; body: unknown }> = {}) => isolatedDaemon(over, groupPlan);

  it('prints what landed in each repo beside the action', async () => {
    const srv = await group({ '/isolation/diff': { body: { diff: '# api\n+x' } } });
    const { stdout, stderr } = await run(['review'], srv);
    srv.close();

    expect(stdout).toBe('# api\n+x');
    expect(stderr).toContain('api: 2 tasks landed');
    expect(stderr).toContain('web: 1 task landed');
    expect(stderr).toContain('infra: nothing to merge');
  });

  it('asks before Merge all, naming the repos with work, then says it merged them all', async () => {
    const srv = await group({ '/isolation/merge': { body: { outcome: 'merged' } } });
    const { stdout, confirm } = await run(['merge'], srv);
    srv.close();

    expect(confirm).toHaveBeenCalledWith(expect.stringMatching(/into main in each of api, web.*unless every repository can take it/));
    expect(stdout).toBe('Merged ordewell/r1/integration into the checked-out branch of every repository.');
  });

  it('reports a blocked Merge all as a failure, each repo with its reason and files', async () => {
    const blocked = [{ repo: 'api', reason: 'conflict', files: ['a.ts'] }, { repo: 'web', reason: 'uncommitted-changes', files: ['w.ts'] }];
    const srv = await group({ '/isolation/merge': { body: { outcome: 'blocked', blocked } } });
    const { stderr, exitCode } = await run(['merge', '--yes'], srv);
    srv.close();

    expect(exitCode).toBe(1);
    expect(stderr).toContain('api would conflict in a.ts; web has uncommitted changes to w.ts');
    expect(stderr).toContain("Each repository's ordewell/r1/integration is a plain branch you can merge by hand.");
  });

  it('says which repos landed before a merge stopped, on git without merge-tree', async () => {
    const srv = await group({ '/isolation/merge': { body: { outcome: 'failed', repo: 'web', landed: ['api'] } } });
    const { stderr, exitCode } = await run(['merge', '--yes'], srv);
    srv.close();

    expect(exitCode).toBe(1);
    expect(stderr).toContain('Could not merge ordewell/r1/integration in web');
    expect(stderr).toContain('api was merged already and stays merged.');
  });

  it('discards and cleans up in every repository', async () => {
    const srv = await group();
    const discarded = await run(['discard', '--yes'], srv);
    const cleaned = await run(['cleanup'], srv);
    srv.close();

    expect(discarded.confirm).not.toHaveBeenCalled();
    expect(discarded.stdout).toBe('Discarded the run and ordewell/r1/integration in every repository.');
    expect(cleaned.stdout).toBe("Removed the run's worktrees and task branches; ordewell/r1/integration is kept in every repository.");
  });

  it('says nothing about repos for a group of one', async () => {
    const srv = await isolatedDaemon({ '/isolation/diff': { body: { diff: 'd' } } });
    const { stderr } = await run(['review'], srv);
    srv.close();

    expect(stderr).not.toMatch(/landed|nothing to merge/);
  });
});
