import { describe, it, expect, vi, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createWorktreeIsolation } from '../GitWorktreeIsolation';
import { BufferedTaskOutputSource } from '../BufferedTaskOutputSource';
import { HomeTranscriptReader } from '../transcriptCapture';
import type { Session } from '../createSession';
import type { ConversationTurn, IAiService } from '../AiService';
import type { SessionMessage } from '../SessionMessage';
import { createTask, type ConversationMessage, type LegacyPlanState, type Task } from '../../models/Task';
import type { ITerminalRunner } from '../../interfaces/ITerminalRunner';
import type { IsolationHandoff, IsolationRun, TaskIsolation } from '../../interfaces/IWorktreeIsolation';
import * as sessionStore from '../../utils/sessionStore';
import { fakeConfig, FakeTerminalSession, makeSession } from './sessionTestKit';

const hasGit = (() => {
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
})();

// A git hook that runs the suite exports GIT_DIR & co., which would point every
// fixture command at the outer repository instead of the temp one.
function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_PREFIX']) delete env[key];
  return env;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: cleanEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

const isAncestor = (cwd: string, ancestor: string, of: string) => {
  try { git(cwd, 'merge-base', '--is-ancestor', ancestor, of); return true; } catch { return false; }
};

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ordewell-multi-e2e-')));
  roots.push(dir);
  return dir;
}

function repo(root: string, files: Record<string, string>): string {
  mkdirSync(root, { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'commit.gpgsign', 'false');
  for (const [name, content] of Object.entries(files)) writeFileSync(join(root, name), content);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'initial');
  return root;
}

const REPOS = ['api', 'infra', 'web'] as const;
type RepoName = typeof REPOS[number];

/** A folder that is not a repository: three repositories and a loose notes file every task shares live. */
function workspace() {
  const dir = tempDir();
  const roots: Record<RepoName, string> = {
    api: repo(join(dir, 'api'), { 'api.txt': 'api\n', '.gitignore': '.env\n' }),
    infra: repo(join(dir, 'infra'), { 'main.tf': '# infra\n' }),
    web: repo(join(dir, 'web'), { 'web.txt': 'web\n' }),
  };
  writeFileSync(join(dir, 'api', '.env'), 'API_KEY=local\n');
  writeFileSync(join(dir, 'NOTES.md'), 'notes\n');
  const bases = Object.fromEntries(REPOS.map((r) => [r, git(roots[r], 'rev-parse', 'HEAD')])) as Record<RepoName, string>;
  return { dir, roots, bases };
}

/** What the scripted agent does for one task, in the cwd it is handed. */
interface Job {
  /** Printed first, so a reader of the task's live output has something to see. */
  say?: string;
  /** The agent holds until this is true. */
  until?: () => boolean;
  write?: Record<string, string>;
  act?: (cwd: string) => void;
  /** The final answer, written to a Claude Code transcript for the cwd as Claude Code would. */
  answer?: string;
}

/**
 * A runner that does what a coding agent does, minus the model: works in the
 * directory it was handed, writes its transcript where Claude Code keeps it,
 * and prints the task's marker. An agent that throws is recorded, not raised
 * out of a timer.
 */
function scriptedAgent(home: string, session: () => Session, jobFor: (taskId: string, title: string) => Job) {
  const spawned: { taskId: string; cwd: string }[] = [];
  const said = new Set<string>();
  const errors: unknown[] = [];
  const runner: ITerminalRunner = {
    spawn: vi.fn(async (opts) => {
      spawned.push({ taskId: opts.taskId, cwd: opts.cwd });
      const terminal = new FakeTerminalSession(`s${spawned.length}`, opts.taskId);
      const job = jobFor(opts.taskId, opts.title ?? '');
      const finish = () => {
        try {
          for (const [file, content] of Object.entries(job.write ?? {})) writeFileSync(join(opts.cwd, file), content);
          job.act?.(opts.cwd);
          if (job.answer) writeTranscript(home, opts.cwd, opts.prompt, job.answer);
          terminal.emitOutput(`<<<ORDEWELL_DONE_${session().getTask(opts.taskId)!.completionMarker}>>>`);
        } catch (err) {
          errors.push(err);
        }
      };
      setTimeout(() => {
        if (job.say) {
          terminal.emitOutput(`${job.say}\n`);
          said.add(opts.taskId);
        }
        const poll = setInterval(() => {
          if (job.until && !job.until()) return;
          clearInterval(poll);
          finish();
        }, 10);
      }, 5);
      return terminal;
    }),
    stop: vi.fn(),
    stopAll: vi.fn(),
    activeCount: 0,
  };
  return { runner, spawned, said, errors };
}

/** Claude Code's layout: `~/.claude/projects/<cwd with every non-alphanumeric as ->/<session>.jsonl`. */
function writeTranscript(home: string, cwd: string, prompt: string, answer: string): void {
  const dir = join(home, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'session.jsonl'), [
    JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: prompt }] } }),
    JSON.stringify({ type: 'assistant', isSidechain: false, message: { role: 'assistant', content: [{ type: 'text', text: answer }] } }),
  ].join('\n'));
}

const talk = (...exchanges: [string, string][]): ConversationMessage[] => exchanges.flatMap(([user, reply], i) => [
  { role: 'user' as const, content: user, timestamp: `2026-01-01T00:00:0${2 * i}Z` },
  { role: 'assistant' as const, content: reply, timestamp: `2026-01-01T00:00:0${2 * i + 1}Z` },
]);

function plan(tasks: Task[], conversationHistory?: ConversationMessage[]): LegacyPlanState {
  const now = new Date().toISOString();
  return { tasks, generatedAt: now, status: 'approved', runners: ['claude-code'], lastUpdated: now, ...(conversationHistory ? { conversationHistory } : {}) };
}

const say = (text: string): ConversationTurn => ({ kind: 'message', text, researchLog: [] });
const read = (tasks: string[]): ConversationTurn => ({ kind: 'task_query', query: { tasks, fields: ['output'], catalog: false }, text: '', researchLog: [] });

function marked(isolation: TaskIsolation | undefined): Exclude<TaskIsolation, { state: 'none' }> {
  if (!isolation || isolation.state === 'none') throw new Error('task has no isolation mark');
  return isolation;
}

/** Every Ordewell branch and every registered worktree, per repo: what git holds of a run. */
function gitState(roots: Record<RepoName, string>) {
  return Object.fromEntries(REPOS.map((r) => [r, {
    branches: git(roots[r], 'for-each-ref', '--format=%(refname:short) %(objectname)', 'refs/heads/ordewell/'),
    worktrees: git(roots[r], 'worktree', 'list', '--porcelain'),
  }]));
}

function envFor(opts: { aiService?: Partial<IAiService> } = {}) {
  const { dir, roots, bases } = workspace();
  const home = tempDir();
  const messages: SessionMessage[] = [];
  const jobs = new Map<string, Job>();
  let resolverJob: Job = {};
  const agent = scriptedAgent(home, () => session, (taskId, title) => (title.startsWith('Resolve merge conflict') ? resolverJob : jobs.get(taskId) ?? {}));
  const session: Session = makeSession({
    config: fakeConfig({ maxParallelSessions: 3 }),
    runner: agent.runner,
    isolation: createWorktreeIsolation({ config: fakeConfig({ worktreeIsolation: true }), resolvePath: async () => process.env.PATH ?? '' }),
    taskOutput: new BufferedTaskOutputSource({ transcripts: new HomeTranscriptReader({ homeDir: home }) }),
    workspaceRoot: () => dir,
    broadcast: (m) => messages.push(m),
    aiService: opts.aiService,
  });
  const run = (): IsolationRun => session.planState!.isolation!.run;
  const integration = () => run().repos[0].integrationBranch;
  const handoff = () => messages.find((m): m is Extract<SessionMessage, { type: 'isolation_handoff' }> => m.type === 'isolation_handoff');
  const setResolver = (job: Job) => { resolverJob = job; };
  return { dir, roots, bases, home, messages, session: () => session, jobs, setResolver, agent, run, integration, handoff };
}

type Env = ReturnType<typeof envFor>;

/**
 * Three tasks start at once. Task 1 changes api and the shared notes, task 2
 * changes web; each holds until all three have started, so they can only
 * finish by running in parallel. Task 3 changes api and web from the same base
 * and lands after both, so it collides in web. Task 4 depends on task 3.
 */
async function conflictedRun(env: Env, conversationHistory?: ConversationMessage[]) {
  const session = env.session();
  const started = (...ids: string[]) => ids.every((id) => env.agent.spawned.some((s) => s.taskId === id));
  let tipsBeforeTask3: Record<string, string> = {};
  env.jobs.set('t1', { until: () => started('t1', 't2', 't3'), write: { 'api/endpoint.txt': 'endpoint\n', 'NOTES.md': 'notes\nt1 was here\n' }, answer: 'Added the endpoint.' });
  env.jobs.set('t2', { until: () => started('t1', 't2', 't3'), write: { 'web/web.txt': 'web by t2\n' } });
  env.jobs.set('t3', {
    say: 'renaming across api and web',
    until: () => {
      if (['t1', 't2'].some((id) => session.getTask(id)?.status !== 'completed')) return false;
      tipsBeforeTask3 = Object.fromEntries(REPOS.map((r) => [r, git(env.roots[r], 'rev-parse', env.integration())]));
      return true;
    },
    write: { 'api/api.txt': 'api by t3\n', 'web/web.txt': 'web by t3\n' },
  });
  env.jobs.set('t4', { write: { 'infra/docs.tf': 'docs\n' } });
  const tasks = [
    createTask({ id: 't1', order: 1, title: 'Add the endpoint', prompt: 'add an endpoint to api' }),
    createTask({ id: 't2', order: 2, title: 'Restyle the page', prompt: 'restyle web' }),
    createTask({ id: 't3', order: 3, title: 'Rename across api and web', prompt: 'rename in both' }),
    createTask({ id: 't4', order: 4, title: 'Describe the rename in infra', prompt: 'document it', dependencies: ['t3'] }),
  ];
  session.loadPlan(plan(tasks, conversationHistory), 'goal', env.dir);
  await session.executePlan();
  await vi.waitFor(() => expect(session.getTask('t3')!.status).toBe('awaiting_user'), { timeout: 20_000 });
  return { tipsBeforeTask3 };
}

/** The resolver's agent: merge task 3's branch in each repo it changed, resolving the one that collides. */
function resolveTask3(env: Env): { sawConflict: () => boolean } {
  const branch = marked(env.session().isolationView()!.tasks.t3).branch;
  let conflicted = false;
  env.setResolver({
    act: (cwd) => {
      git(join(cwd, 'api'), 'merge', '--no-ff', '--no-edit', branch);
      try { git(join(cwd, 'web'), 'merge', '--no-ff', '--no-edit', branch); } catch { conflicted = true; }
      writeFileSync(join(cwd, 'web', 'web.txt'), 'web by t2 and t3\n');
      git(join(cwd, 'web'), 'add', 'web.txt');
      git(join(cwd, 'web'), 'commit', '-q', '--no-edit');
    },
  });
  return { sawConflict: () => conflicted };
}

async function settled(env: Env): Promise<IsolationHandoff> {
  await vi.waitFor(() => expect(env.handoff()).toBeDefined(), { timeout: 20_000 });
  await vi.waitFor(() => expect(env.messages.map((m) => m.type)).toContain('execution_complete'));
  return env.handoff()!;
}

describe.skipIf(!hasGit)('isolated execution over a folder of three repositories and a loose file', () => {
  it('lands parallel tasks per repository, rolls a two-repository task back on a conflict, lands it through a resolver, and merges all only once nothing blocks', async () => {
    const env = envFor();
    const { roots, bases, dir } = env;
    const session = env.session();
    const { tipsBeforeTask3 } = await conflictedRun(env);
    const integration = env.integration();

    // Tasks 1 and 2 ran side by side, each in its own task workspace laid out like the folder.
    expect(session.getTask('t1')!.status).toBe('completed');
    expect(session.getTask('t2')!.status).toBe('completed');
    const cwdOf = (taskId: string) => env.agent.spawned.find((s) => s.taskId === taskId)!.cwd;
    expect(cwdOf('t1')).toBe(join(dir, '.ordewell', 'worktrees', env.run().id, '1-add-the-endpoint'));
    expect(git(roots.api, 'log', '--merges', '--format=%s', `${bases.api}..${integration}`)).toBe('Merge task 1: Add the endpoint');
    expect(git(roots.web, 'log', '--merges', '--format=%s', `${bases.web}..${integration}`)).toBe('Merge task 2: Restyle the page');
    expect(git(roots.infra, 'rev-parse', integration)).toBe(bases.infra);

    // Task 3 merged cleanly into api, conflicted in web, and api was put back: none of it landed.
    for (const r of REPOS) expect(git(roots[r], 'rev-parse', integration), r).toBe(tipsBeforeTask3[r]);
    expect(git(roots.api, 'show', `${integration}:api.txt`)).toBe('api');
    expect(marked(session.isolationView()!.tasks.t3)).toMatchObject({ state: 'conflict', conflictRepo: 'web', repos: ['api', 'web'] });
    const t3 = marked(session.isolationView()!.tasks.t3);
    for (const r of ['api', 'web'] as const) {
      expect(git(roots[r], 'show', `${t3.branch}:${r}.txt`)).toBe(`${r} by t3`);
      expect(git(roots[r], 'worktree', 'list', '--porcelain')).toContain(join(t3.worktree, r));
    }
    // Its dependent waits for all of it.
    expect(env.agent.spawned.map((s) => s.taskId)).not.toContain('t4');

    // The loose file is shared live, and never committed; the linked .env neither.
    expect(readFileSync(join(dir, 'NOTES.md'), 'utf8')).toBe('notes\nt1 was here\n');
    for (const r of REPOS) expect(git(roots[r], 'ls-tree', '-r', '--name-only', integration).split('\n')).not.toContain('NOTES.md');
    expect(git(roots.api, 'ls-tree', '-r', '--name-only', integration).split('\n')).not.toContain('.env');

    const t3Tips = { api: git(roots.api, 'rev-parse', t3.branch), web: git(roots.web, 'rev-parse', t3.branch) };
    const resolver = resolveTask3(env);
    await session.resolveConflictAsTask('t3');
    const handoff = await settled(env);

    expect(resolver.sawConflict()).toBe(true);
    expect(env.agent.errors).toEqual([]);
    expect(session.planTasks.map((t) => t.status)).toEqual(['completed', 'completed', 'completed', 'completed', 'completed']);
    const resolverId = session.planTasks[4].id;
    expect(handoff.repos.map((r) => [r.path, r.baseRef, r.landed.map((l) => l.taskId)])).toEqual([
      ['api', bases.api, ['t1', 't3', resolverId]],
      ['infra', bases.infra, ['t4']],
      ['web', bases.web, ['t2', 't3', resolverId]],
    ]);
    expect(isAncestor(roots.api, t3Tips.api, integration)).toBe(true);
    expect(isAncestor(roots.web, t3Tips.web, integration)).toBe(true);
    expect(git(roots.api, 'show', `${integration}:api.txt`)).toBe('api by t3');
    expect(git(roots.web, 'show', `${integration}:web.txt`)).toBe('web by t2 and t3');
    expect(git(roots.infra, 'log', '--merges', '--format=%s', `${bases.infra}..${integration}`)).toBe('Merge task 4: Describe the rename in infra');
    // Handed over: only the integration branches are left, and no worktree but the user's.
    for (const r of REPOS) {
      expect(git(roots[r], 'branch', '--list', 'ordewell/*', '--format=%(refname:short)'), r).toBe(integration);
      expect(git(roots[r], 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree '))).toEqual([`worktree ${roots[r]}`]);
      expect(git(roots[r], 'rev-parse', 'main'), r).toBe(bases[r]);
      expect(git(roots[r], 'status', '--porcelain', '--untracked-files=no'), r).toBe('');
    }

    // A commit of the user's in web would conflict: Merge all touches no repository.
    writeFileSync(join(roots.web, 'web.txt'), 'the user\'s web\n');
    git(roots.web, 'commit', '-q', '-am', 'user edit');
    const heads = () => REPOS.map((r) => git(roots[r], 'rev-parse', 'HEAD'));
    const before = heads();
    const blocked = await session.mergeRun();
    expect(blocked).toEqual({ outcome: 'blocked', blocked: [{ repo: 'web', reason: 'conflict', files: ['web.txt'] }] });
    expect(heads()).toEqual(before);
    expect(existsSync(join(roots.api, 'endpoint.txt'))).toBe(false);
    expect(existsSync(join(roots.infra, 'docs.tf'))).toBe(false);
    for (const r of REPOS) expect(() => git(roots[r], 'rev-parse', '-q', '--verify', 'MERGE_HEAD'), r).toThrow();
    expect(env.messages).toContainEqual({ type: 'isolation_merge', result: blocked });

    // Once the user takes their commit back, every repository takes its merge.
    git(roots.web, 'reset', '-q', '--hard', 'HEAD~1');
    expect(await session.mergeRun()).toEqual({ outcome: 'merged' });
    for (const r of REPOS) expect(isAncestor(roots[r], integration, 'HEAD'), r).toBe(true);
    expect(readFileSync(join(roots.api, 'endpoint.txt'), 'utf8')).toBe('endpoint\n');
    expect(readFileSync(join(roots.web, 'web.txt'), 'utf8')).toBe('web by t2 and t3\n');
    expect(readFileSync(join(roots.infra, 'docs.tf'), 'utf8')).toBe('docs\n');

    // Discard gives the run up in every repository; what was merged stays merged.
    const runId = env.run().id;
    await session.discardRun();
    for (const r of REPOS) {
      expect(git(roots[r], 'branch', '--list', 'ordewell/*'), r).toBe('');
      expect(git(roots[r], 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree '))).toEqual([`worktree ${roots[r]}`]);
    }
    expect(existsSync(join(dir, '.ordewell', 'worktrees', runId))).toBe(false);
    expect(session.isolationView()).toBeNull();
    expect(readFileSync(join(roots.api, 'endpoint.txt'), 'utf8')).toBe('endpoint\n');
  }, 60_000);

  it('discards a run with a conflicted task, leaving every repository as it was before the run', async () => {
    const env = envFor();
    const { roots, bases, dir } = env;
    const session = env.session();
    await conflictedRun(env);
    const runId = env.run().id;

    session.stopExecution();
    await session.discardRun();

    for (const r of REPOS) {
      expect(git(roots[r], 'branch', '--list', 'ordewell/*'), r).toBe('');
      expect(git(roots[r], 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree '))).toEqual([`worktree ${roots[r]}`]);
      expect(git(roots[r], 'rev-parse', 'HEAD'), r).toBe(bases[r]);
      expect(git(roots[r], 'status', '--porcelain'), r).toBe('');
    }
    expect(existsSync(join(dir, '.ordewell', 'worktrees', runId))).toBe(false);
    // The loose file was never isolated, so discarding the run cannot take the edit back.
    expect(readFileSync(join(dir, 'NOTES.md'), 'utf8')).toBe('notes\nt1 was here\n');
    expect(readFileSync(join(roots.api, '.env'), 'utf8')).toBe('API_KEY=local\n');
  }, 60_000);

  it('tells the planner the group, reads a task running in its task workspace by its live output, and summarises it from the transcript written there', async () => {
    const startConversation = vi.fn().mockResolvedValue(say('hi'));
    const continueConversation = vi.fn().mockResolvedValueOnce(read(['#1'])).mockResolvedValueOnce(say('ok'));
    const env = envFor({ aiService: { startConversation, continueConversation, hasActiveConversation: () => true } });
    const session = env.session();
    await session.startPlanning('goal', ['claude-code']);
    expect(startConversation).toHaveBeenCalledWith(expect.objectContaining({ isolatedExecution: { repos: ['api', 'infra', 'web'], shared: ['NOTES.md'] } }));

    let release = false;
    env.jobs.set('t1', { say: 'working across api and web', until: () => release, write: { 'api/api.txt': 'renamed\n', 'web/web.txt': 'renamed\n' }, answer: 'Renamed in both repositories.' });
    session.loadPlan(plan([createTask({ id: 't1', order: 1, title: 'Rename everywhere', prompt: 'rename' })], talk(['goal', 'Plan generated.'])), 'goal', env.dir);
    await session.executePlan();
    await vi.waitFor(() => expect(env.agent.spawned).toHaveLength(1));
    const { cwd } = env.agent.spawned[0];
    expect(cwd).toBe(join(env.dir, '.ordewell', 'worktrees', env.run().id, '1-rename-everywhere'));
    await vi.waitFor(() => expect(env.agent.said.has('t1')).toBe(true));

    await session.continueConversation('how is task 1 doing?');

    const answer = String(continueConversation.mock.calls[1][0]);
    expect(answer).toMatch(/output: \(running;/);
    expect(answer).toContain('working across api and web');

    release = true;
    await settled(env);
    expect(session.getTask('t1')!.status).toBe('completed');
    expect(session.getTask('t1')!.outputSummary?.logTail).toBe('Renamed in both repositories.');
    expect(env.agent.errors).toEqual([]);
  }, 60_000);

  it('never forks the run, and leaves it where it is through a rewind and a compaction', async () => {
    const continueConversation = vi.fn().mockResolvedValue(say('<conversation_summary>A group, a rename and a conflict.</conversation_summary>'));
    const env = envFor({ aiService: { continueConversation, hasActiveConversation: () => true } });
    const session = env.session();
    await conflictedRun(env, talk(['goal', 'Plan generated.'], ['add an endpoint', 'Added.'], ['restyle', 'Done.'], ['rename', 'Added.']));
    const record = structuredClone(session.planState!.isolation);
    const before = gitState(env.roots);

    const fork = session.forkConversation();
    const [forked] = vi.mocked(sessionStore.saveSession).mock.calls.find((call) => call[3] === fork.sessionId)!;
    expect(forked.isolation).toBeUndefined();
    expect(JSON.stringify(forked)).not.toContain(env.run().id);

    session.rewindConversation(6);
    await session.compactConversation();

    expect(session.planState!.conversationHistory![0].kind).toBe('compaction');
    expect(session.planState!.isolation).toEqual(record);
    expect(gitState(env.roots)).toEqual(before);

    // And the run carries on from where it was.
    resolveTask3(env);
    await session.resolveConflictAsTask('t3');
    const handoff = await settled(env);
    expect(handoff.landed.map((l) => l.taskId)).toEqual(['t1', 't2', 't3', 't4', session.planTasks[4].id]);
    expect(env.agent.errors).toEqual([]);
  }, 60_000);
});
