import { it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { createTask } from '../../models/Task';
import type { IRunner } from '../../interfaces/IRunner';
import { openTaskLog, readTaskLog } from '../../utils/taskLogStore';
import { makeSession, FakeRunnerSession } from './sessionTestKit';

it('resolves file and commit claims on pull, marks missing or escaping claims unresolved, and checks again on the next read', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-reference-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-outside-'));
  const repo = path.join(root, 'api');
  fs.mkdirSync(repo);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-qm', 'Initial');
  const sha = git('rev-parse', 'HEAD');
  fs.writeFileSync(path.join(root, 'present.ts'), 'present');
  fs.writeFileSync(path.join(outside, 'secret'), 'outside');
  fs.symlinkSync(outside, path.join(root, 'escape'), 'dir');
  const agents: FakeRunnerSession[] = [];
  const spawn = vi.fn(async (opts: Parameters<IRunner['spawn']>[0]) => {
    const agent = new FakeRunnerSession(`s${agents.length + 1}`, opts.taskId);
    agents.push(agent);
    return agent;
  });
  const session = makeSession({ workspaceRoot: () => root, openTaskLog, runner: { spawn, stop: vi.fn(), stopAll: vi.fn(), activeCount: 0 } });
  try {
    session.loadPlan({ tasks: [createTask({ id: 'a', order: 1, prompt: 'Produce' }), createTask({ id: 'b', order: 2, prompt: 'Read', dependencies: ['a'] })], generatedAt: '', lastUpdated: '', status: 'approved', runners: ['claude-code'] }, 'Read claims', root);
    await session.execute({ command: 'run_plan' }, { kind: 'user' });
    agents[0].reportComplete({ status: 'done', summary: 'Claims', artifacts: [
      { kind: 'file', path: 'present.ts' }, { kind: 'file', path: 'missing.ts' }, { kind: 'file', path: 'escape/secret' },
      { kind: 'commit', sha, repo: 'api' }, { kind: 'commit', sha: 'deadbeef', repo: 'api' },
    ] });
    await vi.waitFor(() => expect(agents).toHaveLength(2));
    const read = spawn.mock.calls[1][0].readTask!;
    const first = (await read({ task: 'a' })).text;
    expect(first).toContain('missing.ts (unresolved)');
    expect(first).toContain('escape/secret (unresolved)');
    expect(first).toContain('commit deadbeef in api (unresolved)');
    expect(first).not.toContain('present.ts (unresolved)');
    expect(first).not.toContain(`commit ${sha} in api (unresolved)`);
    const saved = readTaskLog(session.taskLogLocation, 'a', 1).find((e) => e.type === 'handoff');
    if (saved?.type !== 'handoff') throw new Error('No saved handoff');
    expect(saved.handoff.artifacts?.[0]).not.toHaveProperty('resolved');
    fs.unlinkSync(path.join(root, 'present.ts'));
    expect((await read({ task: 'a' })).text).toContain('present.ts (unresolved)');
    expect(session.taskLog('a', 1).find((e) => e.type === 'handoff')).toMatchObject({ handoff: { artifacts: [{ resolved: false }, { resolved: false }, { resolved: false }, { resolved: true }, { resolved: false }] } });
  } finally {
    session.destroy();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});
