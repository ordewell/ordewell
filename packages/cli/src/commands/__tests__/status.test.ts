import { describe, it, expect, afterEach, vi } from 'vitest';
import http from 'http';
import { readFileSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ApiClient } from '../../apiClient';
import { stripAnsi } from '../../tui/ansi';

vi.mock('../../utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils')>()),
  readLastSession: () => null,
}));

function startServer(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ port, close: () => server.close() });
    });
  });
}

async function capture(fn: () => Promise<void>): Promise<{ stdout: string }> {
  const logs: string[] = [];
  const logSpy = vi.spyOn(console, 'log').mockImplementation((m: string) => { logs.push(m); });
  await fn();
  logSpy.mockRestore();
  return { stdout: logs.join('\n') };
}

const SESSION = {
  meta: { id: 'session-1', goal: 'export me', runners: ['claude-code'], taskCount: 1, status: 'completed', createdAt: '', updatedAt: '' },
  plan: { pendingTasks: [{ id: 't1', order: 1, title: 'One', status: 'completed' }] },
};

const SESSION_WITH_SUBTASKS = {
  meta: { id: 'session-1', goal: 'export me', runners: ['claude-code'], taskCount: 1, status: 'completed', createdAt: '', updatedAt: '' },
  plan: {
    pendingTasks: [{
      id: 't1', order: 1, title: 'One', status: 'completed',
      subtasks: [
        { id: 't1a', order: 1, title: 'Nested', status: 'completed' },
        { id: 't1b', order: 2, title: 'Second nested', status: 'pending' },
      ],
    }],
  },
};

describe('handleStatus --output', () => {
  let outDir = '';
  afterEach(() => {
    if (outDir) rmSync(outDir, { recursive: true, force: true });
  });

  it('writes the session JSON to a file and implies --json', async () => {
    const srv = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(SESSION));
    });
    outDir = mkdtempSync(join(tmpdir(), 'ordewell-status-'));
    const out = join(outDir, 'plan.json');
    const { handleStatus } = await import('../status');
    const { stdout } = await capture(() =>
      handleStatus(['--session-id', 'session-1', '--output', out], new ApiClient(srv.port)),
    );

    expect(stdout).toContain(`Wrote ${out}`);
    expect(JSON.parse(readFileSync(out, 'utf8'))).toEqual(SESSION);
    srv.close();
  });

  it('still prints JSON to stdout without --output', async () => {
    const srv = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(SESSION));
    });
    const { handleStatus } = await import('../status');
    const { stdout } = await capture(() =>
      handleStatus(['--session-id', 'session-1', '--json'], new ApiClient(srv.port)),
    );
    expect(JSON.parse(stdout)).toEqual(SESSION);
    srv.close();
  });

  it('reads a task\'s usage as its whole spend across attempts, with no wall time', async () => {
    const attempt = (n: number, over: Record<string, unknown>) => ({ attempt: n, runner: 'claude-code', startedAt: '', wallTimeMs: 65_000, totals: {}, ...over });
    const plan = { pendingTasks: [{
      id: 't1', order: 1, type: 'ai', title: 'One', status: 'completed',
      attemptUsage: [
        attempt(1, { totals: { inputTokens: 1000, outputTokens: 100, reportedCost: { USD: 0.5 }, costProvenance: { USD: { kind: 'estimate', billing: 'subscription' } } }, lastPromptTokens: 90, contextWindow: 100 }),
        attempt(2, { totals: { inputTokens: 500, outputTokens: 50, cachedInputTokens: 200 }, lastPromptTokens: 50, contextWindow: 200 }),
      ],
    }] };
    const srv = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ...SESSION, plan }));
    });
    const { handleStatus } = await import('../status');
    const { stdout } = await capture(() => handleStatus(['--session-id', 'session-1'], new ApiClient(srv.port)));
    const lines = stripAnsi(stdout).split('\n').map((l) => l.trim());
    expect(lines).toContain('Tasks total: ≈$0.50 API-equivalent');
    expect(lines).toContain('ctx 50 (25%) · ≈$0.50 API-equivalent');
    expect(stdout).not.toMatch(/\bin ·|cached|\bout\b/);
    expect(stdout).not.toMatch(/\d+s\b|time unknown/);
    srv.close();
  });

  it('renders subtasks as indented dotted-label lines', async () => {
    const srv = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(SESSION_WITH_SUBTASKS));
    });
    const { handleStatus } = await import('../status');
    const { stdout } = await capture(() =>
      handleStatus(['--session-id', 'session-1'], new ApiClient(srv.port)),
    );
    expect(stdout).toContain('    1.1. ');
    expect(stdout).toContain('Nested');
    expect(stdout).toContain('    1.2. ');
    expect(stdout).toContain('Second nested');
    srv.close();
  });

  it('says why a live session holds a task, so it does not read as merely unstarted', async () => {
    const session = {
      ...SESSION,
      plan: { pendingTasks: [{ id: 't1', order: 1, title: 'One', status: 'pending' }] },
      run: {
        tasks: [{ id: 't1', order: 1, title: 'One', status: 'pending', holdReason: 'could not connect to Ordewell\'s tools; start it again' }],
        runMerge: null,
        handoff: null,
        mergeResult: null,
      },
    };
    const srv = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(session));
    });
    const { handleStatus } = await import('../status');
    const { stdout } = await capture(() =>
      handleStatus(['--session-id', 'session-1'], new ApiClient(srv.port)),
    );
    expect(stdout).toContain('On hold: could not connect to Ordewell\'s tools; start it again');
    srv.close();
  });

  it('marks a research task', async () => {
    const session = {
      ...SESSION,
      plan: { pendingTasks: [
        { id: 't1', order: 1, type: 'ai', title: 'Scout the cache', status: 'pending', research: true },
        { id: 't2', order: 2, type: 'ai', title: 'Plain task', status: 'pending' },
      ] },
      run: {
        tasks: [
          { id: 't1', order: 1, title: 'Scout the cache', status: 'pending', research: true },
          { id: 't2', order: 2, title: 'Plain task', status: 'pending' },
        ],
        runMerge: null,
        handoff: null,
        mergeResult: null,
      },
    };
    const srv = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(session));
    });
    const { handleStatus } = await import('../status');
    const { stdout } = await capture(() => handleStatus(['--session-id', 'session-1'], new ApiClient(srv.port)));
    const lines = stripAnsi(stdout).split('\n');
    expect(lines.find((l) => l.includes('Scout the cache'))).toContain(' [RES] ');
    expect(lines.find((l) => l.includes('Plain task'))).not.toContain('[RES]');
    srv.close();
  });

  // A running session's finished tasks come back in a flat execution log, a
  // finished subtask both on its own and inside its parent.
  it('lists each task once, at its own depth, when finished ones come from the execution log', async () => {
    const fn = { id: 'mul-fn', order: 1, title: 'Add and export mul', status: 'completed' };
    const test = { id: 'mul-test', order: 2, title: 'Test mul', status: 'completed' };
    const executing = {
      meta: SESSION.meta,
      plan: {
        phase: 'executing',
        executionLog: [{ id: 'mul', order: 1, title: 'Add mul', status: 'completed', subtasks: [fn, test] }, fn, { id: 'readme', order: 2, title: 'README check', status: 'completed' }, test],
        pendingTasks: [{ id: 'status', order: 3, title: 'Run git status', status: 'pending' }],
      },
    };
    const srv = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(executing));
    });
    const { handleStatus } = await import('../status');
    const { stdout } = await capture(() =>
      handleStatus(['--session-id', 'session-1'], new ApiClient(srv.port)),
    );
    const rows = stdout.split('\n').filter((line) => /^\s+[\d.]+\. /.test(line)).map((line) => stripAnsi(line).replace(/\[[^\]]*\] /, '').replace(/[✓○✗⟳⊘]/g, '').replace(/\s+/g, ' ').trim());

    expect(rows).toEqual(['1. Add mul', '1.1. Add and export mul', '1.2. Test mul', '2. README check', '3. Run git status']);
    expect(stdout).toContain('Tasks:    5 total  |  4 done');
    srv.close();
  });

  describe('the base branch of an isolated run', () => {
    const isolated = (repos: Array<Record<string, unknown>>) => ({
      meta: SESSION.meta,
      plan: {
        pendingTasks: SESSION.plan.pendingTasks,
        isolation: { resolvers: {}, run: { id: 'r1', workspaceRoot: '/ws', repos, shared: [], sharedRepos: [], tasks: {} } },
      },
    });
    const statusOf = async (session: unknown) => {
      const srv = await startServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(session));
      });
      const { handleStatus } = await import('../status');
      const { stdout } = await capture(() => handleStatus(['--session-id', 'session-1'], new ApiClient(srv.port)));
      srv.close();
      return stripAnsi(stdout);
    };
    const repo = (path: string, baseRef: string, baseBranch?: string, startedDetached = baseBranch === undefined) => (
      { path, root: `/ws/${path}`, baseRef, integrationBranch: 'ordewell/r1/integration', ...(baseBranch ? { baseBranch } : {}), ...(startedDetached ? { startedDetached: true } : {}) }
    );

    it('names the branch the run started on, and the commit', async () => {
      expect(await statusOf(isolated([repo('.', 'abcdef1234567890', 'main')]))).toContain('Base:     main @ abcdef12\n');
    });

    it('names a record that never noted its branch by the commit alone', async () => {
      expect(await statusOf(isolated([repo('.', 'abcdef1234567890', undefined, false)]))).toContain('Base:     base abcdef12\n');
    });

    it('names each repo of a group, a detached HEAD as that', async () => {
      const out = await statusOf(isolated([repo('api', 'aaaa1111bbbb', 'main'), repo('web', 'cccc2222dddd')]));

      expect(out).toContain('Base:     api: main @ aaaa1111, web: detached at cccc2222\n');
    });

    it('says nothing for a session with no isolation record', async () => {
      expect(await statusOf(SESSION)).not.toContain('Base:');
    });
  });

  it('counts and names the tasks a failure blocks (ADR-0034)', async () => {
    const session = {
      meta: { ...SESSION.meta, status: 'approved' },
      plan: {
        pendingTasks: [
          { id: 't1', order: 1, title: 'One', status: 'failed', dependencies: [] },
          { id: 't2', order: 2, title: 'Two', status: 'pending', dependencies: ['t1'] },
          { id: 't3', order: 3, title: 'Three', status: 'pending', dependencies: ['t2'] },
        ],
      },
    };
    const srv = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(session));
    });
    const { handleStatus } = await import('../status');
    const { stdout } = await capture(() => handleStatus(['--session-id', 'session-1'], new ApiClient(srv.port)));

    expect(stdout).toContain('1 failed  |  0 running  |  2 blocked');
    expect(stripAnsi(stdout).match(/Blocked by #1/g)).toHaveLength(2);
    srv.close();
  });

  it('names a task added after the user approved the plan as waiting for them, from the plan\'s approval record (ADR-0035)', async () => {
    const session = {
      meta: { ...SESSION.meta, status: 'approved' },
      plan: {
        approved: true,
        approvedTasks: ['t1'],
        pendingTasks: [
          { id: 't1', order: 1, title: 'One', type: 'ai', status: 'in_progress', dependencies: [] },
          { id: 't2', order: 2, title: 'Two', type: 'ai', status: 'pending', dependencies: [] },
        ],
      },
    };
    const srv = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(session));
    });
    const { handleStatus } = await import('../status');
    const { stdout } = await capture(() => handleStatus(['--session-id', 'session-1'], new ApiClient(srv.port)));

    const lines = stripAnsi(stdout).split('\n');
    const waiting = lines.filter((l) => l.includes('Waits for your approval'));
    expect(waiting).toEqual(['      Waits for your approval: `ordewell force-start 2` approves it, `ordewell run` approves all']);
    expect(lines[lines.indexOf(waiting[0]) - 1]).toContain('Two');
    srv.close();
  });

  it('shows a script task\'s body and time limit, as `ordewell plan` does (ADR-0035)', async () => {
    const session = {
      meta: SESSION.meta,
      plan: {
        pendingTasks: [
          {
            id: 't1', order: 1, type: 'script', title: 'Tag the release', status: 'pending', dependencies: [],
            commands: [['git', 'tag', 'v1.2.3']], timeoutMs: 90_000,
          },
        ],
      },
    };
    const srv = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(session));
    });
    const { handleStatus } = await import('../status');
    const { stdout } = await capture(() => handleStatus(['--session-id', 'session-1'], new ApiClient(srv.port)));

    expect(stdout).toContain('git tag v1.2.3');
    expect(stdout).toContain('Time limit: 90 seconds.');
    srv.close();
  });

  it('tags a script task [SCR] in the task list (ADR-0035)', async () => {
    const session = {
      meta: SESSION.meta,
      plan: {
        pendingTasks: [
          { id: 't1', order: 1, title: 'Change', type: 'ai', status: 'pending', dependencies: [] },
          { id: 't2', order: 2, title: 'Push the tag', type: 'script', status: 'pending', dependencies: [], commands: [['git', 'push']] },
        ],
      },
    };
    const srv = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(session));
    });
    const { handleStatus } = await import('../status');
    const { stdout } = await capture(() => handleStatus(['--session-id', 'session-1'], new ApiClient(srv.port)));

    const rows = stripAnsi(stdout).split('\n').filter((line) => /^\s+\d+\. /.test(line));
    expect(rows).toHaveLength(2);
    expect(rows[0]).not.toContain('[SCR]');
    expect(rows[1]).toMatch(/\[[^\]]+\] \[SCR\] Push the tag/);
    srv.close();
  });

  it('names no runner and flags none on a script or a manual task stored with a runner that is switched off', async () => {
    const session = {
      meta: SESSION.meta,
      plan: {
        pendingTasks: [
          { id: 't1', order: 1, title: 'Push the tag', type: 'script', status: 'pending', assignedRunner: 'codex', dependencies: [], commands: [['git', 'push']] },
          { id: 't2', order: 2, title: 'Sign off', type: 'user', status: 'pending', assignedRunner: 'codex', dependencies: [] },
        ],
      },
    };
    const srv = await startServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(req.url?.startsWith('/api/runners') ? { runners: [{ id: 'codex', name: 'Codex', enabled: false }, { id: 'claude-code', name: 'Claude Code', enabled: true }] } : session));
    });
    const { handleStatus } = await import('../status');
    const { stdout } = await capture(() => handleStatus(['--session-id', 'session-1'], new ApiClient(srv.port)));
    const rows = stripAnsi(stdout).split('\n').filter((line) => /^\s+\d+\. |⚠/.test(line));
    expect(rows).toHaveLength(2);
    expect(rows.join('\n')).not.toMatch(/codex|switched off|⚠/);
    srv.close();
  });

  // The flag every surface shows for a task outside the user's scope (ADR-0043).
  it('flags a task on a runner switched off or a model off its allowlist, subtasks too, and never a finished one', async () => {
    const session = {
      meta: { ...SESSION.meta, status: 'approved' },
      plan: {
        pendingTasks: [
          { id: 't1', order: 1, title: 'On codex', type: 'ai', status: 'pending', assignedRunner: 'codex', dependencies: [] },
          { id: 't2', order: 2, title: 'On opus', type: 'ai', status: 'pending', assignedRunner: 'claude-code', assignedModel: { modelId: 'claude-opus-4', modelLabel: 'Opus 4' }, dependencies: [] },
          { id: 't3', order: 3, title: 'Done on codex', type: 'ai', status: 'completed', assignedRunner: 'codex', dependencies: [] },
          {
            id: 't4', order: 4, title: 'Parent', type: 'ai', status: 'pending', assignedRunner: 'claude-code', dependencies: [],
            subtasks: [{ id: 't4a', order: 1, title: 'Child on codex', type: 'ai', status: 'pending', assignedRunner: 'codex', dependencies: [] }],
          },
        ],
      },
    };
    const sonnet = { modelId: 'claude-sonnet-4-5', modelLabel: 'Sonnet 4.5', variants: [] };
    const opus = { modelId: 'claude-opus-4', modelLabel: 'Opus 4', variants: [] };
    const srv = await startServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      const url = req.url ?? '';
      if (url.startsWith('/api/runners')) {
        res.end(JSON.stringify({ runners: [{ id: 'claude-code', name: 'Claude Code', enabled: true }, { id: 'codex', name: 'Codex', enabled: false }], orchestratorModel: '' }));
      } else if (url.startsWith('/api/settings')) {
        res.end(JSON.stringify({ modelAllowlist: { 'claude-code': ['claude-sonnet-4-5'] } }));
      } else if (url.startsWith('/api/models')) {
        res.end(JSON.stringify({ models: [sonnet, opus], modelsByRunner: { 'claude-code': [sonnet, opus] } }));
      } else {
        res.end(JSON.stringify(session));
      }
    });
    const { handleStatus } = await import('../status');
    const { stdout } = await capture(() => handleStatus(['--session-id', 'session-1'], new ApiClient(srv.port)));

    const flags = stripAnsi(stdout).split('\n').filter((l) => l.includes('⚠'));
    expect(flags).toEqual([
      '      ⚠ codex is switched off — runs as assigned unless moved',
      '      ⚠ Opus 4 is not in the allowlist — runs as assigned unless moved',
      '        ⚠ codex is switched off — runs as assigned unless moved',
    ]);
    srv.close();
  });
});

describe('handleStatus with a handoff (ADR-0047)', () => {
  const handoff = {
    summary: 'The cache key omits the tenant.',
    findings: [
      { id: 'F1', severity: 'blocker', title: 'Cache key leaks across tenants' },
      { id: 'F2', severity: 'major', title: 'No regression test' },
    ],
    findingCount: 4,
    artifacts: [{ kind: 'file', path: 'src/cache.ts', line: 42 }, { kind: 'url', url: 'https://example.com/pr/7' }],
  };

  async function statusOf(plan: unknown): Promise<string> {
    const srv = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ...SESSION, plan }));
    });
    const { handleStatus } = await import('../status');
    const { stdout } = await capture(() => handleStatus(['--session-id', 'session-1'], new ApiClient(srv.port)));
    srv.close();
    return stripAnsi(stdout);
  }

  it('prints a completed task\'s summary, finding titles and artifacts under its row', async () => {
    const out = await statusOf({ pendingTasks: [
      { id: 't1', order: 1, type: 'ai', title: 'Fix the cache', status: 'completed', dependencies: [], handoff },
      { id: 't2', order: 2, type: 'ai', title: 'Ship it', status: 'pending', dependencies: ['t1'] },
    ] });

    const lines = out.split('\n');
    const row = lines.findIndex((l) => l.includes('Fix the cache'));
    expect(lines.slice(row + 1, row + 6)).toEqual([
      '      ↳ Handoff: The cache key omits the tenant.',
      '      F1 [blocker] Cache key leaks across tenants',
      '      F2 [major] No regression test',
      '      +2 more findings, in the attempt\'s log',
      '      Artifacts: src/cache.ts:42 (unresolved); https://example.com/pr/7',
    ]);
    expect(out).not.toMatch(/Ship it[\s\S]*↳ Handoff/);
  });

  it('prints a script task\'s derived summary after the body it ran', async () => {
    const out = await statusOf({ pendingTasks: [{
      id: 't1', order: 1, type: 'script', title: 'Tag the release', status: 'completed', dependencies: [],
      commands: [['git', 'tag', 'v1.2.3']], timeoutMs: 90_000,
      handoff: { summary: 'exited 0 in 1.2 s', findings: [], findingCount: 0 },
    }] });

    const lines = out.split('\n');
    expect(lines).toContain('      ↳ Handoff: exited 0 in 1.2 s');
    expect(lines.indexOf('      ↳ Handoff: exited 0 in 1.2 s')).toBeGreaterThan(lines.findIndex((l) => l.includes('git tag v1.2.3')));
  });

  it('prints a user task\'s derived summary', async () => {
    const out = await statusOf({ pendingTasks: [{
      id: 't1', order: 1, type: 'user', title: 'Add the DNS record', status: 'completed', dependencies: [],
      handoff: { summary: 'Completed by the user', findings: [], findingCount: 0 },
    }] });

    expect(out).toContain('      ↳ Handoff: Completed by the user');
  });

  it('carries the handoff in --json', async () => {
    const plan = { pendingTasks: [{ id: 't1', order: 1, type: 'ai', title: 'Fix the cache', status: 'completed', dependencies: [], handoff }] };
    const srv = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ...SESSION, plan }));
    });
    const { handleStatus } = await import('../status');
    const { stdout } = await capture(() => handleStatus(['--session-id', 'session-1', '--json'], new ApiClient(srv.port)));

    expect(JSON.parse(stdout).plan.pendingTasks[0].handoff).toEqual(handoff);
    srv.close();
  });
});

describe('handleStatus on a loop (ADR-0045)', () => {
  const found = { outcome: 'fail', reason: 'two problems', checks: [], reported: 'failed' };
  const loopSession = (tasks: unknown[]) => ({ meta: { ...SESSION.meta, status: 'approved' }, plan: { pendingTasks: tasks } });
  const check = (over: Record<string, unknown> = {}) => ({ id: 'c', order: 1, title: 'Review', type: 'ai', status: 'pending', dependencies: [], loop: { body: ['f'], maxRounds: 3 }, ...over });
  const fix = (over: Record<string, unknown> = {}) => ({ id: 'f', order: 2, title: 'Fix', type: 'ai', status: 'pending', dependencies: ['c'], ...over });
  const dependent = { id: 'd', order: 3, title: 'Ship', type: 'ai', status: 'pending', dependencies: ['c'] };

  async function status(session: unknown): Promise<string> {
    const srv = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(session));
    });
    const { handleStatus } = await import('../status');
    const { stdout } = await capture(() => handleStatus(['--session-id', 'session-1'], new ApiClient(srv.port)));
    srv.close();
    return stripAnsi(stdout);
  }

  it('says what the loop will do, on the check and on its body', async () => {
    const out = await status(loopSession([check(), fix()]));

    expect(out).toContain('      ↻ Loop of up to 3 rounds · Runs #2 if it fails');
    expect(out).toContain('      ↻ Runs if #1 fails');
  });

  it('counts a check nothing will run as the failure it is, told by the run', async () => {
    const between = check({ status: 'failed', loopRound: 1, verdict: found });
    const session = loopSession([between, fix()]) as Record<string, unknown>;
    const out = await status({ ...session, run: { tasks: [{ ...between, loopStranded: true }, fix()], runMerge: null, handoff: null, mergeResult: null } });

    expect(out).toContain('      ↻ Stopped in round 1 of 3 · Nothing runs it now: execute the plan and the loop goes on');
    expect(out).toContain('1 failed');
  });

  it.each([
    ['landed', 'completed', 'start it for round 2 of 3'],
    ['not landed', 'pending', 'execute the plan and the loop goes on'],
  ])('counts a check of a session no run holds as the failure it is, its fix %s', async (_, status_, next) => {
    const out = await status(loopSession([check({ status: 'failed', loopRound: 1, verdict: found }), fix({ status: status_ })]));

    expect(out).toContain(`      ↻ Stopped in round 1 of 3 · Nothing runs it now: ${next}`);
    expect(out).toContain('1 failed');
    expect(out).not.toContain('fixing');
  });

  it('offers no start of a check whose dependency has not finished', async () => {
    const dep = { id: 'b', order: 3, title: 'Before', type: 'ai', status: 'pending', dependencies: [] };
    const out = await status(loopSession([check({ status: 'failed', loopRound: 1, verdict: found, dependencies: ['b'] }), fix({ status: 'completed' }), dep]));

    expect(out).toContain('Nothing runs it now: execute the plan and the loop goes on');
  });

  it('shows a check between rounds as no failure, and what is fixing it', async () => {
    const tasks = [check({ status: 'failed', loopRound: 1, verdict: found }), fix({ status: 'in_progress' }), dependent];
    const out = await status({ ...loopSession(tasks), run: { tasks, runMerge: null, handoff: null, mergeResult: null } });

    expect(out).toContain('      ↻ Round 1 of 3: fixing · Found problems: runs again once #2 has landed');
    expect(out).toContain('      ↻ Runs if #1 fails (round 1 of 3)');
    expect(out).toContain('0 failed  |  1 running  |  0 blocked');
    expect(out).not.toContain('Blocked by');
    expect(out).not.toContain('✗');
  });

  it('counts the failure and blocks its dependents once the loop is out of rounds', async () => {
    const out = await status(loopSession([check({ status: 'failed', loopRound: 3, verdict: found }), fix({ status: 'skipped', skipReason: 'not run: the loop ran out of rounds' }), dependent]));

    expect(out).toContain('      ↻ Failed after 3 rounds');
    expect(out).toContain('1 failed  |  0 running  |  1 blocked');
    expect(out).toContain('Blocked by #1');
  });

  it('says how the loop ended when its check passed', async () => {
    const out = await status(loopSession([check({ status: 'completed', loopRound: 2, verdict: { outcome: 'pass', reason: 'clean', checks: [], reported: 'done' } }), fix({ status: 'skipped', skipReason: 'not needed: its check passed' })]));

    expect(out).toContain('      ↻ Passed in round 2 of 3');
  });
});
