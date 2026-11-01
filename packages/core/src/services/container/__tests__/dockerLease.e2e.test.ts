import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFileSync, spawnSync, type ChildProcess } from 'child_process';
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { createWorktreeIsolation } from '../../GitWorktreeIsolation';
import { LeaseHost } from '../../sessionLease';
import { RUN_SETTINGS_DEFAULTS } from '../../SettingsService';
import { StructuredRunner } from '../../StructuredRunner';
import { BufferedTaskOutputSource } from '../../BufferedTaskOutputSource';
import { GUARANTEES, type LeaseRepo } from '../../executionLease';
import { fakeFs, fakeNotification, makeSession } from '../../__tests__/sessionTestKit';
import { createTask, type LegacyPlanState, type Task } from '../../../models/Task';
import { fakeConfig, FakeExecutionBackend } from '../../../testing';
import { saveSession } from '../../../utils/sessionStore';
import { openTaskLog } from '../../../utils/taskLogStore';
import { CredentialBroker } from '../credentialBroker';
import { DockerExecutionBackend } from '../dockerLease';
import { parseContainerSettings } from '../containerSettings';
import { SpawnedDockerCli } from '../dockerCli';
import { LeaseRelay, RELAY_ENTRY } from '../leaseRelay';

/*
 * A real task in a real container (ADR-0059 L5, L6). Nothing is faked but the
 * harness's binary, the fake `claude` of bench/pipeline, built into a small
 * image: the real adapter, `docker exec`, the real MCP server through the relay,
 * the gate, and Landing with real git. Off CI's default path, like the sandbox's
 * end-to-end runs: it skips where no engine answers, and where CI has one unless
 * ORDEWELL_REQUIRE_DOCKER=1 asks for it. One suite, so one at a time.
 */

const REQUIRE_DOCKER = process.env.ORDEWELL_REQUIRE_DOCKER === '1';
const engineAnswers = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf8', timeout: 20_000 }).status === 0;
const skip = (!engineAnswers || process.env.CI !== undefined) && !REQUIRE_DOCKER;

const IMAGE = `ordewell-e2e-fake:${process.pid}`;
const FAKE_CLAUDE = resolve(__dirname, '../../../../../../bench/pipeline/fake-claude/fake-claude.mjs');
const DOCKERFILE = `FROM node:22-slim
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends git >/dev/null
RUN mkdir -p /task /mirror /login /caches/npm && chown -R node:node /task /mirror /login /caches
COPY fake-claude.mjs /opt/fake-claude.mjs
COPY claude /usr/local/bin/claude
USER node
`;
/** Says where it ran, in the work it leaves: on any host but Linux, only a container makes this read Linux. */
const FAKE_LAUNCHER = `#!/bin/sh
echo "$(uname -s) $(id -u) $HOME" > where-i-ran.txt
echo run >> "$HOME/runs"
wc -l < "$HOME/runs" | tr -d ' ' > runs-of-this-home.txt
exec node /opt/fake-claude.mjs "$@"
`;

const env = () => {
  const e = { ...process.env };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_PREFIX']) delete e[k];
  return e;
};
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: env(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const ours = (kind: 'container' | 'volume') => (kind === 'container'
  ? docker('container', 'ls', '-a', '--filter', 'name=ordewell-', '--format', '{{.Names}}')
  : docker('volume', 'ls', '--filter', 'name=ordewell-', '--format', '{{.Name}}')).split('\n').filter(Boolean);

const dirs: string[] = [];
function tempDir(prefix = 'ordewell-container-'): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
}
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

function repo(): string {
  const root = tempDir();
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'T');
  git(root, 'config', 'user.email', 't@example.com');
  git(root, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(root, 'README.md'), 'hello\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'initial');
  return root;
}

const cue = (spec: unknown) => `<fake-claude>${JSON.stringify(spec)}</fake-claude>`;
const settingsOf = (over: Record<string, unknown> = {}) => parseContainerSettings({ image: IMAGE, memory: '512m', login: { kind: 'broker', variables: ['ANTHROPIC_API_KEY'] }, ...over });

function session(root: string, tasks: Task[], settings = settingsOf()) {
  const told: string[] = [];
  const notifications = fakeNotification();
  const taskOutput = new BufferedTaskOutputSource();
  const parent = makeSession({
    runner: new StructuredRunner(),
    taskOutput,
    isolation: createWorktreeIsolation({ resolvePath: async () => process.env.PATH ?? '', config: fakeConfig({ worktreeIsolation: true }) }),
    workspaceRoot: () => root, saveSession, openTaskLog, leaseHost: new LeaseHost(), sessionId: `docker-e2e-${process.pid}-${tasks[0].id}`,
    config: fakeConfig({ maxParallelSessions: 2, aiProvider: 'claude-code' }),
    notifications,
    settings: () => ({ run: { ...RUN_SETTINGS_DEFAULTS, supervisorLevel: 'off' } }),
    childDeps: () => ({ fsAdapter: { ...fakeFs(), getWorkspaceRoot: () => root } }),
    execution: (local, context) => new DockerExecutionBackend(local, {
      settings,
      broker: new CredentialBroker({ ANTHROPIC_API_KEY: 'sk-ant-api03-not-a-real-key' }),
      sessionId: context.sessionId,
      tell: (level, text) => { told.push(`${level}: ${text}`); context.tell(level, text); },
    }),
  });
  parent.loadPlan({ tasks, runners: ['claude-code'], status: 'approved', generatedAt: '2026-11-01T10:00:00.000Z' } as unknown as LegacyPlanState, 'the goal', root, { sessionId: `docker-e2e-${process.pid}-${tasks[0].id}` });
  return { parent, told, notifications, taskOutput, integration: () => parent.planState?.isolation?.run.repos[0].integrationBranch ?? '' };
}

const settled = (s: ReturnType<typeof session>['parent'], index = 0) => vi.waitFor(() => expect(s.planTasks[index].status).not.toMatch(/approved|pending|in_progress/), { timeout: 60_000, interval: 100 });

describe.skipIf(skip)('a task in a real container', () => {
  const before: Record<'container' | 'volume', string[]> = { container: [], volume: [] };

  beforeAll(() => {
    before.container = ours('container');
    before.volume = ours('volume');
    const context = tempDir('ordewell-image-');
    writeFileSync(join(context, 'Dockerfile'), DOCKERFILE);
    copyFileSync(FAKE_CLAUDE, join(context, 'fake-claude.mjs'));
    writeFileSync(join(context, 'claude'), FAKE_LAUNCHER);
    chmodSync(join(context, 'claude'), 0o755);
    docker('build', '-q', '-t', IMAGE, context);
  }, 180_000);

  afterAll(() => {
    for (const name of ours('container').filter((n) => !before.container.includes(n))) spawnSync('docker', ['rm', '-f', name]);
    for (const name of ours('volume').filter((n) => !before.volume.includes(n))) spawnSync('docker', ['volume', 'rm', '-f', name]);
    spawnSync('docker', ['image', 'rm', '-f', IMAGE]);
  }, 60_000);

  it('runs in the container, comes back through the gate, and lands on the integration branch', async () => {
    const root = repo();
    const main = git(root, 'rev-parse', 'main');
    const tasks = [createTask({ id: 'a', order: 1, title: 'Write a', prompt: cue({ write: { 'a.txt': 'written in the container\n' }, summary: 'Wrote a.' }), assignedRunner: 'claude-code' })];
    const env = session(root, tasks);

    await env.parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await settled(env.parent);

    expect(env.parent.planTasks[0]).toMatchObject({ status: 'completed', verdict: { outcome: 'pass', reported: 'done' } });
    const integration = env.integration();
    expect(git(root, 'show', `${integration}:a.txt`)).toBe('written in the container');
    expect(git(root, 'show', `${integration}:where-i-ran.txt`)).toBe('Linux 1000 /task/home');
    expect(git(root, 'rev-parse', 'main')).toBe(main);
    expect(env.told.filter((line) => line.startsWith('warn')).join()).toContain('network');
    await vi.waitFor(() => expect(ours('container').filter((n) => !before.container.includes(n))).toEqual([]), { timeout: 30_000 });
    await vi.waitFor(() => expect(ours('volume').filter((n) => n.startsWith('ordewell-task-') && !before.volume.includes(n))).toEqual([]), { timeout: 30_000 });

    expect(await env.parent.execute({ command: 'merge_all' }, { kind: 'user' })).toMatchObject({ ok: true });
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('written in the container\n');
    env.parent.destroy();
  }, 120_000);

  it("keeps a failed attempt's work in its worktree, as a local attempt's stays", async () => {
    const root = repo();
    const tasks = [createTask({ id: 'b', order: 1, title: 'Fail b', prompt: cue({ write: { 'partial.txt': 'half done\n' }, status: 'blocked', reason: 'stuck' }), assignedRunner: 'claude-code' })];
    const env = session(root, tasks);

    await env.parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await settled(env.parent);

    expect(env.parent.planTasks[0].status).toBe('failed');
    const record = Object.values(env.parent.planState?.isolation?.run.tasks ?? {})[0];
    const worktree = Object.values(record.repos)[0].worktree;
    await vi.waitFor(() => expect(existsSync(join(worktree, 'partial.txt'))).toBe(true), { timeout: 30_000 });
    expect(readFileSync(join(worktree, 'partial.txt'), 'utf8')).toBe('half done\n');
    env.parent.destroy();
  }, 120_000);

  it('stops every process of a running attempt, and leaves no container', async () => {
    const root = repo();
    const tasks = [createTask({ id: 'c', order: 1, title: 'Stop c', prompt: cue({ delayMs: 60_000 }), assignedRunner: 'claude-code' })];
    const env = session(root, tasks);

    await env.parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(ours('container').filter((n) => !before.container.includes(n))).toHaveLength(1), { timeout: 60_000, interval: 100 });
    await new Promise((done) => setTimeout(done, 1500));

    await env.parent.execute({ command: 'stop_run' }, { kind: 'user' });

    await vi.waitFor(() => expect(ours('container').filter((n) => !before.container.includes(n))).toEqual([]), { timeout: 45_000, interval: 200 });
    expect(env.parent.planTasks[0].status).toBe('pending');
    env.parent.destroy();
  }, 120_000);

  it('a Continue resumes the session in the home its volume kept, on the work it left (ADR-0059 L2)', async () => {
    const root = repo();
    const tasks = [createTask({ id: 'k', order: 1, title: 'Block k', prompt: cue({ write: { 'partial.txt': 'half done\n' }, status: 'blocked', reason: 'stuck' }), assignedRunner: 'claude-code' })];
    const env = session(root, tasks);

    await env.parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await settled(env.parent);
    expect(env.parent.planTasks[0].status).toBe('failed');
    const resumed = env.parent.planTasks[0].runnerSessionId;
    expect(resumed).toMatch(/^fake-claude-/);

    const continued = await env.parent.execute({ command: 'retry_task', task: 'k', from: 'session', message: cue({ write: { 'k.txt': 'continued\n' }, summary: 'Went on.' }) }, { kind: 'user' });
    expect(continued).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(env.parent.planTasks[0].status).toBe('completed'), { timeout: 60_000, interval: 100 });

    const integration = env.integration();
    expect(git(root, 'show', `${integration}:k.txt`)).toBe('continued');
    expect(git(root, 'show', `${integration}:partial.txt`)).toBe('half done');
    // The second run of one home, which only a kept volume makes it.
    expect(git(root, 'show', `${integration}:runs-of-this-home.txt`)).toBe('2');
    expect(env.parent.planTasks[0].attemptUsage?.map((usage) => usage.sessionId)).toEqual([resumed, resumed]);
    env.parent.destroy();
  }, 120_000);

  it('brings the work back for a Mark complete straight after a Stop: nothing lands an empty worktree', async () => {
    const root = repo();
    const tasks = [createTask({ id: 'm', order: 1, title: 'Vouch m', prompt: cue({ delayMs: 60_000 }), assignedRunner: 'claude-code' })];
    const env = session(root, tasks);
    await env.parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(ours('container').filter((n) => !before.container.includes(n))).toHaveLength(1), { timeout: 60_000, interval: 100 });
    const [box] = ours('container').filter((n) => !before.container.includes(n));
    await vi.waitFor(() => expect(spawnSync('docker', ['exec', box, 'sh', '-c', 'test -d /task/work/.git && echo vouched > /task/work/vouched.txt']).status).toBe(0), { timeout: 30_000, interval: 200 });

    await env.parent.execute({ command: 'stop_run' }, { kind: 'user' });
    const marked = await env.parent.execute({ command: 'mark_complete', task: 'm', confirmed: true, seen: env.parent.planTasks[0].status }, { kind: 'user' });

    expect(marked).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(env.parent.planTasks[0].status).toBe('completed'), { timeout: 60_000, interval: 100 });
    expect(git(root, 'show', `${env.integration()}:vouched.txt`)).toBe('vouched');
    env.parent.destroy();
  }, 120_000);

  it('plants nothing on this host: what a hostile attempt writes under `.git` stays in its volume', async () => {
    const root = repo();
    const planted = { '.git/hooks/post-merge': '#!/bin/sh\ntouch /tmp/owned\n', '.git/config.bad': 'x', 'b.txt': 'ordinary work\n' };
    const tasks = [createTask({ id: 'd', order: 1, title: 'Plant', prompt: cue({ write: planted, summary: 'Planted.' }), assignedRunner: 'claude-code' })];
    const env = session(root, tasks);

    await env.parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await settled(env.parent);

    expect(env.parent.planTasks[0].status).toBe('completed');
    expect(git(root, 'ls-tree', '-r', '--name-only', env.integration()).split('\n').sort()).toEqual(['README.md', 'b.txt', 'runs-of-this-home.txt', 'where-i-ran.txt']);
    expect(existsSync(join(root, '.git', 'hooks', 'post-merge'))).toBe(false);
    env.parent.destroy();
  }, 120_000);

  it('refuses the lease, and starts no runner, when the settings require what no probe can prove', async () => {
    const root = repo();
    const tasks = [createTask({ id: 'e', order: 1, title: 'Needs an allowlist', prompt: cue({ write: { 'e.txt': 'x' } }), assignedRunner: 'claude-code' })];
    const env = session(root, tasks, settingsOf({ required: ['net.allowlist'] }));

    await env.parent.execute({ command: 'run_plan' }, { kind: 'user' });

    await vi.waitFor(() => expect(vi.mocked(env.notifications.error).mock.calls.join()).toContain('net.allowlist'), { timeout: 60_000, interval: 100 });
    expect(env.parent.planTasks[0].status).not.toBe('completed');
    expect(env.parent.planTasks[0].verdict).toBeUndefined();
    await vi.waitFor(() => expect(ours('container').filter((n) => !before.container.includes(n))).toEqual([]), { timeout: 30_000 });
    env.parent.destroy();
  }, 120_000);

  it('proves on a real engine what it says it proves, and that it has no network guarantee', async () => {
    const backend = new DockerExecutionBackend(new FakeExecutionBackend(), { settings: settingsOf(), sessionId: () => 'probe', tell: () => undefined });

    const report = await backend.probe();

    for (const guarantee of ['fs.hostHidden', 'fs.writeScope', 'limits.memory', 'cred.unreadable'] as const) {
      expect(report[guarantee], `${guarantee}: ${report[guarantee].by}`).toMatchObject({ proven: true });
    }
    expect(report['net.allowlist'].proven).toBe(false);
    expect(Object.keys(report).sort()).toEqual([...GUARANTEES].sort());
  }, 60_000);

  it.each<[string, (entry: ChildProcess) => void]>([
    ['its client is killed', (entry) => entry.kill('SIGKILL')],
    // What a host's death is to the client it leaves behind: its stdin closes.
    ['its host dies and the pipe closes', (entry) => entry.stdin?.end()],
  ])('goes with its host: the container ends when %s', async (label, end) => {
    const name = `ordewell-e2e-entry-${process.pid}-${label.length}`;
    const entry = await new SpawnedDockerCli().entry(['run', '-i', '--rm', '--name', name, '--init', '--pids-limit', '8192', '--memory', '256m', '--memory-swap', '256m', IMAGE, 'node', '-e', RELAY_ENTRY]);
    await new LeaseRelay(entry).ready;
    expect(docker('ps', '--filter', `name=${name}`, '--format', '{{.Names}}')).toBe(name);

    end(entry);

    await vi.waitFor(() => expect(docker('ps', '-a', '--filter', `name=${name}`, '--format', '{{.Names}}')).toBe(''), { timeout: 30_000, interval: 200 });
  }, 60_000);

  const leaseOver = (taskId: string, repos: LeaseRepo[], memory = '512m') => leaseWith(taskId, repos, settingsOf({ memory }));
  const leaseOverImage = (taskId: string, repos: LeaseRepo[], image: string) => leaseWith(taskId, repos, settingsOf({ image }));

  /** One lease on real repositories with no Session around it, to run a command by placement as a runner would be. */
  function leaseWith(taskId: string, repos: LeaseRepo[], settings: ReturnType<typeof settingsOf>) {
    const local = new FakeExecutionBackend();
    local.repos = repos;
    const told: string[] = [];
    const backend = new DockerExecutionBackend(local, { settings, broker: new CredentialBroker({ ANTHROPIC_API_KEY: 'sk-ant-api03-x' }), sessionId: () => `${taskId}-${process.pid}`, tell: (_level, text) => told.push(text) });
    return {
      backend,
      told,
      open: async (intent: 'fresh' | 'repair' = 'fresh') => {
        const reserved = backend.reserve({ node: { sessionId: taskId, taskId }, role: 'task', runner: 'claude-code' });
        if ('refused' in reserved) throw new Error(reserved.refused);
        const opened = await reserved.lease.open({ task: createTask({ id: taskId, order: 1, title: taskId, prompt: 'x' }), workspace: { kind: 'worktree', intent }, required: [] }, new AbortController().signal);
        const run = async (script: string, cwd?: string) => {
          const placed = await opened.placement!.place({ command: 'sh', args: ['-c', cwd ? `cd ${cwd} && ${script}` : script], env: {}, files: [] });
          const ran = spawnSync('docker', placed.args, { encoding: 'utf8', env: { ...process.env, ...placed.env } });
          placed.ended();
          return ran;
        };
        return { opened, run, lease: reserved.lease };
      },
    };
  }

  function worktreeOf(root: string, branch: string): LeaseRepo {
    const worktree = join(tempDir(), 'wt');
    git(root, 'worktree', 'add', '-q', '-b', branch, worktree);
    git(root, 'branch', `${branch}-integration`);
    return { path: '.', root, worktree, branch, integrationBranch: `${branch}-integration`, linked: [] };
  }

  it('reports a process killed at the memory limit as `oom`', async () => {
    const lease = leaseOver('oom', [worktreeOf(repo(), 'ordewell/oom')], '128m');
    const { opened, run, lease: reserved } = await lease.open();

    const killed = await run('exec node -e "const a=[];for(;;)a.push(Buffer.alloc(1<<24,1))"');

    expect(killed.status).toBe(137);
    await expect(opened.ended!()).resolves.toBe('oom');
    expect(lease.told.join()).toContain('memory limit');
    reserved.release('oom');
    await lease.backend.letGo('oom', { keep: false, reason: 'done' });
  }, 90_000);

  it('holds a process to the limit it proved: a fork bomb stays in its cgroup', async () => {
    const lease = leaseOver('pids', [worktreeOf(repo(), 'ordewell/pids')]);
    const { run, lease: reserved } = await lease.open();

    const counted = await run('cat /sys/fs/cgroup/pids.max; cat /sys/fs/cgroup/memory.max; cat /sys/fs/cgroup/memory.swap.max; id -u');

    expect(counted.stdout.trim().split('\n')).toEqual(['8192', String(512 * 1024 ** 2), '0', '1000']);
    reserved.release('done');
    await lease.backend.letGo('pids', { keep: false, reason: 'done' });
  }, 60_000);

  it('seeds a repair with the integration tip, and brings back the merge it makes (ADR-0015)', async () => {
    const root = repo();
    const repaired = worktreeOf(root, 'ordewell/repair');
    writeFileSync(join(repaired.worktree, 'task.txt'), 'the task\n');
    git(repaired.worktree, 'add', '-A');
    git(repaired.worktree, 'commit', '-q', '-m', 'The task');
    const landed = join(tempDir(), 'wt');
    git(root, 'worktree', 'add', '-q', landed, repaired.integrationBranch);
    writeFileSync(join(landed, 'landed.txt'), 'landed meanwhile\n');
    git(landed, 'add', '-A');
    git(landed, 'commit', '-q', '-m', 'Landed meanwhile');
    const tip = git(root, 'rev-parse', repaired.integrationBranch);
    const lease = leaseOver('repair', [repaired]);
    const { run, lease: reserved } = await lease.open('repair');

    const merged = await run(`git merge -q --no-edit ${repaired.integrationBranch}`);
    expect(merged.stderr).toBe('');
    expect(merged.status).toBe(0);
    await lease.backend.collect('repair');

    expect(git(repaired.worktree, 'merge-base', '--is-ancestor', tip, 'HEAD')).toBe('');
    expect(existsSync(join(repaired.worktree, 'landed.txt'))).toBe(true);
    expect(git(repaired.worktree, 'status', '--porcelain')).toBe('');
    reserved.release('verdict');
    await lease.backend.letGo('repair', { keep: false, reason: 'done' });
  }, 90_000);

  it('brings back every repository of a group, or none of them', async () => {
    const roots = [repo(), repo()];
    const repos = roots.map((root, i) => ({ ...worktreeOf(root, `ordewell/group-${i}`), path: `repo-${i}` }));
    const lease = leaseOver('group', repos);
    const { run, lease: reserved } = await lease.open();

    expect((await run('ls /task/work && echo one > /task/work/repo-0/one.txt && echo two > /task/work/repo-1/two.txt')).stdout.trim().split('\n')).toEqual(['repo-0', 'repo-1']);
    await lease.backend.collect('group');

    expect(readFileSync(join(repos[0].worktree, 'one.txt'), 'utf8')).toBe('one\n');
    expect(readFileSync(join(repos[1].worktree, 'two.txt'), 'utf8')).toBe('two\n');
    reserved.release('verdict');
    await lease.backend.letGo('group', { keep: false, reason: 'done' });
  }, 90_000);

  /*
   * The real binary, in an image built from docker/task.Dockerfile: set
   * ORDEWELL_E2E_HARNESS_IMAGE to one. It is given an empty sign-in, so no key
   * goes anywhere and no model answers: what this proves is its launch, its
   * protocol through `docker exec` and its attach to Ordewell's server through
   * the relay. What it says of memory is a harness at rest, not one at work.
   */
  const HARNESS_IMAGE = process.env.ORDEWELL_E2E_HARNESS_IMAGE;
  it.skipIf(!HARNESS_IMAGE)('attaches the real harness to its tools through the relay, and measures it', async () => {
    const login = 'ordewell-login-claude-code';
    const hadLogin = spawnSync('docker', ['volume', 'inspect', login]).status === 0;
    if (!hadLogin) docker('volume', 'create', login);
    const root = repo();
    const tasks = [createTask({ id: 'h', order: 1, title: 'Real harness', prompt: 'Say hello.', assignedRunner: 'claude-code' })];
    const env = session(root, tasks, parseContainerSettings({ image: HARNESS_IMAGE, memory: '2g', login: { kind: 'own-sign-in' } }));

    await env.parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(ours('container').filter((n) => !before.container.includes(n))).toHaveLength(1), { timeout: 60_000, interval: 100 });
    const [box] = ours('container').filter((n) => !before.container.includes(n));
    const memory = (file: string) => Number(spawnSync('docker', ['exec', box, 'cat', `/sys/fs/cgroup/${file}`], { encoding: 'utf8' }).stdout.trim());

    // Attached: only then is it sent a turn, and without a login that turn ends it waiting on the user.
    await vi.waitFor(() => expect(env.parent.planTasks[0].status).toBe('awaiting_user'), { timeout: 120_000, interval: 200 });
    expect(vi.mocked(env.notifications.warn).mock.calls.join()).not.toContain("started without Ordewell's tools");
    expect(env.parent.planTasks[0].awaitingReason).toBe('input');
    console.log(`[measure] the harness said: ${JSON.stringify(env.taskOutput.finalText('h')).slice(0, 200)}`);
    const rss = spawnSync('docker', ['exec', box, 'sh', '-c', 'for p in /proc/[0-9]*; do if tr "\\0" " " < $p/cmdline 2>/dev/null | grep -q claude; then grep VmRSS $p/status; fi; done'], { encoding: 'utf8' }).stdout.trim();
    console.log(`[measure] harness at rest: cgroup current ${Math.round(memory('memory.current') / 1024 ** 2)} MiB, peak ${Math.round(memory('memory.peak') / 1024 ** 2)} MiB, ${rss.replace(/\s+/g, ' ')}`);

    await env.parent.execute({ command: 'stop_run' }, { kind: 'user' });
    await vi.waitFor(() => expect(ours('container').filter((n) => !before.container.includes(n))).toEqual([]), { timeout: 45_000, interval: 200 });
    env.parent.destroy();
    if (!hadLogin) docker('volume', 'rm', '-f', login);

    const lease = leaseOverImage('timing', [worktreeOf(repo(), 'ordewell/timing')], HARNESS_IMAGE!);
    const opens: number[] = [];
    for (let i = 0; i < 10; i++) {
      const startedAt = Date.now();
      const { lease: reserved } = await lease.open();
      opens.push(Date.now() - startedAt);
      reserved.release('done');
      await lease.backend.letGo('timing', { keep: true, reason: 'done' });
    }
    await lease.backend.letGo('timing', { keep: false, reason: 'done' });
    console.log(`[measure] a lease's whole open, ms: ${[...opens].sort((a, b) => a - b).join(' ')}`);
  }, 240_000);

  it('cannot reach the mirror for writing, or the host: the guarantees hold against a real process', async () => {
    const root = repo();
    const lease = leaseOver('reach', [worktreeOf(root, 'ordewell/reach')]);
    const { run, lease: reserved } = await lease.open();

    const tried = await run(`touch /mirror/self.git/hooks/post-receive; echo "mirror $?"; touch /usr/bin/x; echo "root $?"; ls ${root} 2>&1; echo "host $?"; ls /var/run/docker.sock 2>&1; echo "socket $?"; touch /caches/npm/x; echo "cache $?"; touch "$HOME/x"; echo "home $?"`);

    const lines = tried.stdout.trim().split('\n');
    for (const [where, code] of [['mirror', '1'], ['root', '1'], ['host', '2'], ['socket', '2'], ['cache', '0'], ['home', '0']]) expect(lines).toContain(`${where} ${code}`);
    reserved.release('done');
    await lease.backend.letGo('reach', { keep: false, reason: 'done' });
  }, 60_000);
});
