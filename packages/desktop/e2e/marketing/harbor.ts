/**
 * Harbor, the invented service every marketing shot shows: a temp HOME whose
 * ~/code holds harbor and three smaller projects, harbor's three weeks of
 * history by five invented people (a feature branch merged, a release branch,
 * a fix and a feature in flight, two stashes, a tag), an origin two commits
 * ahead of the local main, three earlier sessions of Noa's, the welcome
 * window's recent folders, and the stage the fake runners (fakes/scene.mjs)
 * hold and release their tasks on.
 *
 * The app reads real time, so a task's elapsed time and a session's start are
 * what they look like; what is seeded is dated back from the moment it is
 * written, at working hours in a time zone where that moment is the afternoon,
 * which the app is launched in.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { freePort, untilListening, type Sandbox } from '../fixtures';
import * as files from './harbor-files';

const MARKETING = __dirname;
const FAKES = path.join(MARKETING, 'fakes');

interface Person { name: string; email: string }
const NOA: Person = { name: 'Noa Berg', email: 'noa.berg@example.com' };
const TOMAS: Person = { name: 'Tomas Lind', email: 'tomas.lind@example.com' };
const PRIYA: Person = { name: 'Priya Raman', email: 'priya.raman@example.com' };
const JONAH: Person = { name: 'Jonah Weiss', email: 'jonah.weiss@example.com' };
const INES: Person = { name: 'Ines Duarte', email: 'ines.duarte@example.com' };

/** The planner's model, which mock-planner.mjs's catalog lists first. */
const PLANNER_MODEL = 'anthropic/claude-sonnet-5.5';

/** The planner's goal, as the capture types it. */
export const GOAL = 'Add rate limiting to sign-in, with tests and docs';

/**
 * The fixed-offset zone whose wall clock reads two in the afternoon, give or
 * take the minutes, at `now`. POSIX's Etc/GMT names count the other way: east
 * of Greenwich is Etc/GMT-<hours>.
 */
export function afternoonZone(now: Date): { zone: string; offsetHours: number } {
  const offsetHours = ((((14 - now.getUTCHours() + 12) % 24) + 24) % 24) - 12;
  return { zone: offsetHours === 0 ? 'Etc/GMT' : `Etc/GMT${offsetHours > 0 ? '-' : '+'}${Math.abs(offsetHours)}`, offsetHours };
}

/** A git date (`2026-11-08T10:12:00+11:00`) at local `hh:mm`, `days` before the local day of `now`, never after `now`. */
function dater(now: Date, offsetHours: number): (days: number, hh: number, mm: number) => string {
  const local = new Date(now.getTime() + offsetHours * 3_600_000);
  const sign = offsetHours < 0 ? '-' : '+';
  const zone = `${sign}${String(Math.abs(offsetHours)).padStart(2, '0')}:00`;
  return (days, hh, mm) => {
    const wall = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() - days, hh, mm));
    if (wall.getTime() - offsetHours * 3_600_000 > now.getTime()) throw new Error(`a Harbor commit at day -${days} ${hh}:${mm} would be in the future`);
    return `${wall.toISOString().slice(0, 19)}${zone}`;
  };
}

export interface Harbor {
  readonly sandbox: Sandbox;
  /** ~/code/harbor. */
  readonly repo: string;
  /** The directory the fake runners hold their gates in and read their pace from. */
  readonly stage: string;
  /** The zone the app is launched in. */
  readonly zone: string;
  /** What the app's environment adds to appEnv's: the fakes first on PATH, every runner enabled, the stage and the zone. */
  env(base: Record<string, string>): Record<string, string>;
  /** Scales every beat of every scene: 0 runs a task through at once, 1 reads calmly. */
  pace(value: number): void;
  /** Seconds the origin takes to answer a fetch or a pull, so its busy state is seen. */
  fetchDelay(seconds: number): void;
  /** Waits until a scene has reached `gate`, and is holding there. */
  reached(gate: string, timeoutMs?: number): Promise<void>;
  /** Lets a scene held at `gate` go on. */
  release(gate: string): void;
  /** The planner the app talks to, on a free port. */
  planner(): Promise<{ port: number; process: ChildProcess }>;
  /** Uncommitted edits in harbor, for the Changes view: a HOST setting beside PORT. */
  editLocally(): void;
  /** Takes editLocally's edits back, staged or not, so Merge all finds the checkout clean. */
  undoLocal(): void;
}

/**
 * One root for every take: the app prints the repository's path in a pull's
 * confirm and a task's details, and a random one would read differently in each
 * shot. Claimed by creating it, so a run that finds it held, by another capture
 * or one that died before tidying, takes a random root instead.
 */
function sandboxRoot(): string {
  const steady = path.join(os.tmpdir(), 'ordewell-studio');
  try {
    fs.mkdirSync(steady);
    return fs.realpathSync(steady);
  } catch {
    return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-harbor-')));
  }
}

/** Builds the sandbox; nothing is running yet. */
export function harbor(): Harbor {
  const now = new Date();
  const { zone, offsetHours } = afternoonZone(now);
  const at = dater(now, offsetHours);
  const tmp = sandboxRoot();
  const home = path.join(tmp, 'home');
  const code = path.join(home, 'code');
  const repo = path.join(code, 'harbor');
  const stage = path.join(tmp, 'stage');
  const sandbox: Sandbox = { tmp, home, repo, userData: path.join(tmp, 'user-data'), fakeClaudeLog: path.join(tmp, 'fake-claude.log') };
  for (const dir of [repo, stage, sandbox.userData]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(home, '.gitconfig'), `[user]\n\tname = ${NOA.name}\n\temail = ${NOA.email}\n[init]\n\tdefaultBranch = main\n[advice]\n\tdetachedHead = false\n`);

  const gitIn = (dir: string, args: readonly string[], env: Record<string, string> = {}): string => execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: '1', ...env },
  });
  const as = (who: Person, date: string): Record<string, string> => ({
    GIT_AUTHOR_NAME: who.name, GIT_AUTHOR_EMAIL: who.email, GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_NAME: who.name, GIT_COMMITTER_EMAIL: who.email, GIT_COMMITTER_DATE: date,
  });
  const write = (dir: string, changes: Readonly<Record<string, string>>): void => {
    for (const [file, content] of Object.entries(changes)) {
      fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      fs.writeFileSync(path.join(dir, file), content);
    }
  };
  const commit = (dir: string, who: Person, date: string, subject: string, changes: Readonly<Record<string, string>>): void => {
    write(dir, changes);
    gitIn(dir, ['add', '-A']);
    gitIn(dir, ['commit', '-q', '-m', subject], as(who, date));
  };
  const h = (...args: string[]): string => gitIn(repo, args);
  const hAs = (who: Person, date: string, ...args: string[]): string => gitIn(repo, args, as(who, date));

  h('init', '-q');
  commit(repo, NOA, at(21, 10, 4), 'Start harbor: an HTTP service for accounts', {
    'package.json': files.PACKAGE('0.0.0'), 'tsconfig.json': files.TSCONFIG, '.gitignore': files.GITIGNORE,
    'README.md': files.README_FIRST, 'src/http.ts': files.HTTP,
  });
  commit(repo, NOA, at(20, 15, 22), 'Add the request router and a health check', {
    'src/app.ts': files.APP_FIRST, 'src/routes/health.ts': files.HEALTH(files.UPTIME), 'src/server.ts': files.SERVER('first'),
    'test/health.test.ts': files.HEALTH_TEST('', '2.5'),
  });
  commit(repo, TOMAS, at(18, 11, 47), 'Store users in memory behind a small interface', { 'src/users.ts': files.USERS });
  commit(repo, PRIYA, at(16, 16, 9), 'Hash passwords with scrypt', { 'src/auth/passwords.ts': files.PASSWORDS });

  h('checkout', '-q', '-b', 'feature/sign-in');
  commit(repo, PRIYA, at(14, 10, 31), 'Issue opaque session tokens', { 'src/auth/sessions.ts': files.SESSIONS });
  commit(repo, PRIYA, at(13, 14, 55), 'Add POST /sign-in with email and password', {
    'src/routes/signIn.ts': files.SIGN_IN, 'src/app.ts': files.APP, 'src/server.ts': files.SERVER('users'),
    'test/health.test.ts': files.HEALTH_TEST('users: memoryUsers([]), ', '2.5'),
  });
  commit(repo, PRIYA, at(12, 11, 18), 'Cover sign-in with tests', { 'test/signIn.test.ts': files.SIGN_IN_TEST });
  h('checkout', '-q', 'main');
  commit(repo, JONAH, at(13, 9, 42), 'Add a CI workflow', { '.github/workflows/ci.yml': files.CI('push') });
  hAs(NOA, at(11, 10, 15), 'merge', '-q', '--no-ff', '-m', "Merge branch 'feature/sign-in'", 'feature/sign-in');
  h('branch', '-q', '-d', 'feature/sign-in');

  commit(repo, INES, at(10, 13, 36), 'Document the HTTP API', { 'docs/api.md': files.API_DOCS });
  commit(repo, TOMAS, at(8, 10, 52), 'Read the port from PORT', { 'src/server.ts': files.SERVER('port'), 'docs/configuration.md': files.CONFIG_DOCS('sever') });
  commit(repo, NOA, at(7, 16, 40), 'Prepare the 0.1.0 release', { 'package.json': files.PACKAGE('0.1.0'), 'CHANGELOG.md': files.CHANGELOG([]) });
  hAs(NOA, at(7, 16, 41), 'tag', '-a', 'v0.1.0', '-m', 'harbor 0.1.0');
  h('branch', '-q', 'release/0.1');
  commit(repo, PRIYA, at(5, 11, 3), 'Log each request\'s method, path and status', { 'src/server.ts': files.SERVER('logged'), 'CHANGELOG.md': files.CHANGELOG([files.LOGGED]) });

  h('checkout', '-q', 'release/0.1');
  commit(repo, JONAH, at(6, 15, 27), 'Return 400 for a malformed JSON body', { 'src/server.ts': files.SERVER('malformed') });
  h('checkout', '-q', '-b', 'fix/health-uptime', 'main');
  commit(repo, JONAH, at(4, 9, 58), 'Report uptime in whole seconds', {
    'src/routes/health.ts': files.HEALTH(files.UPTIME_WHOLE), 'test/health.test.ts': files.HEALTH_TEST('users: memoryUsers([]), ', '2'),
  });
  h('checkout', '-q', '-b', 'feature/password-reset', 'main');
  commit(repo, INES, at(3, 10, 26), 'Add password reset tokens', { 'src/auth/resetTokens.ts': files.RESET_TOKENS });
  commit(repo, INES, at(2, 14, 12), 'Email a reset link through the mailer interface', { 'src/mail.ts': files.MAIL, 'src/routes/passwordReset.ts': files.PASSWORD_RESET });
  h('checkout', '-q', 'main');
  commit(repo, NOA, at(3, 11, 44), 'Explain local setup in the README', { 'README.md': files.README });

  // origin is a bare repository beside HOME, whose upload-pack waits as long as the stage says before it answers.
  const bare = path.join(tmp, 'remote', 'harbor.git');
  execFileSync('git', ['init', '-q', '--bare', bare], { env: { ...process.env, HOME: home } });
  const slow = path.join(tmp, 'upload-pack');
  fs.writeFileSync(slow, `#!/bin/sh\nsleep "$(cat '${path.join(stage, 'fetch-delay')}' 2>/dev/null || echo 0)"\nexec git upload-pack "$@"\n`, { mode: 0o755 });
  h('remote', 'add', 'origin', bare);
  h('config', 'remote.origin.uploadpack', slow);
  h('push', '-q', '-u', 'origin', 'main', 'release/0.1', 'feature/password-reset');
  h('push', '-q', 'origin', 'v0.1.0');

  // A teammate's two commits reach origin after this clone last fetched: Fetch finds main two behind.
  const teammate = path.join(tmp, 'teammate');
  execFileSync('git', ['clone', '-q', bare, teammate], { env: { ...process.env, HOME: home } });
  commit(teammate, INES, at(1, 12, 8), 'Fix a typo in the configuration guide', { 'docs/configuration.md': files.CONFIG_DOCS('server') });
  commit(teammate, JONAH, at(0, 9, 37), 'Run CI on pull requests as well', { '.github/workflows/ci.yml': files.CI('[push, pull_request]') });
  gitIn(teammate, ['push', '-q', 'origin', 'main']);
  fs.rmSync(teammate, { recursive: true, force: true });

  h('checkout', '-q', 'feature/password-reset');
  fs.appendFileSync(path.join(repo, 'src/mail.ts'), '\n// TODO: retry once when the mailer times out, then give up and log it.\n');
  hAs(NOA, at(2, 17, 5), 'stash', 'push', '-q', '-m', 'WIP: retry the mailer on a timeout');
  h('checkout', '-q', 'main');
  const sessions = path.join(repo, 'src/auth/sessions.ts');
  fs.writeFileSync(sessions, fs.readFileSync(sessions, 'utf8').replace(/\n/, '\n// Trying 8 hours instead of 30 days: see what support hears first.\n'));
  hAs(NOA, at(1, 16, 20), 'stash', 'push', '-q', '-m', 'Try a shorter session lifetime');

  siblings(code, (dir, who, date, subject, changes) => {
    if (!fs.existsSync(path.join(dir, '.git'))) {
      fs.mkdirSync(dir, { recursive: true });
      gitIn(dir, ['init', '-q']);
    }
    commit(dir, who, date, subject, changes);
  }, (dir, branch) => { gitIn(dir, ['checkout', '-q', '-b', branch]); }, at);
  pastSessions(repo, at);

  // The welcome window's recent folders, as src/main/recents.ts keeps them.
  const recents = [
    { path: repo, openedAt: new Date(now.getTime() - 35 * 60_000).toISOString(), git: { kind: 'branch', name: 'main' } },
    { path: path.join(code, 'ledger-api'), openedAt: new Date(now.getTime() - 26 * 3_600_000).toISOString(), git: { kind: 'branch', name: 'main' } },
    { path: path.join(code, 'tidepool-ui'), openedAt: new Date(now.getTime() - 3 * 86_400_000 - 2 * 3_600_000).toISOString(), git: { kind: 'branch', name: 'feature/date-picker' } },
    { path: path.join(code, 'field-notes'), openedAt: new Date(now.getTime() - 9 * 86_400_000).toISOString(), git: { kind: 'branch', name: 'main' } },
  ];
  fs.writeFileSync(path.join(sandbox.userData, 'recents.json'), `${JSON.stringify({ entries: recents }, null, 2)}\n`);

  const flag = (name: string, value: string): void => { fs.writeFileSync(path.join(stage, name), value); };
  flag('pace', '1');
  flag('fetch-delay', '0');

  return {
    sandbox, repo, stage, zone,
    env: (base) => ({
      ...base,
      // node's own directory holds the npm a task's `npm test` runs; the fakes shadow every runner the base PATH has.
      PATH: [FAKES, path.dirname(process.execPath), base.PATH].join(path.delimiter),
      ORDEWELL_ENABLED_RUNNERS: 'claude-code,codex,opencode,copilot-cli',
      ORCHESTRATOR_MODEL: PLANNER_MODEL,
      HARBOR_STAGE: stage,
      TZ: zone,
    }),
    pace: (value) => flag('pace', String(value)),
    fetchDelay: (seconds) => flag('fetch-delay', String(seconds)),
    async reached(gate, timeoutMs = 120_000) {
      const marker = path.join(stage, 'at', gate);
      const deadline = Date.now() + timeoutMs;
      while (!fs.existsSync(marker)) {
        if (Date.now() > deadline) throw new Error(`no scene reached the gate "${gate}" within ${timeoutMs / 1000}s; see ${path.join(stage, 'runners.log')}`);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    },
    release(gate) {
      fs.mkdirSync(path.join(stage, 'go'), { recursive: true });
      fs.writeFileSync(path.join(stage, 'go', gate), '');
    },
    async planner() {
      const port = await freePort();
      const child = spawn(process.execPath, [path.join(MARKETING, 'mock-planner.mjs'), '--port', String(port)], { stdio: 'ignore' });
      if (!await untilListening(port, true)) {
        child.kill();
        throw new Error(`the Harbor planner never listened on ${port}`);
      }
      return { port, process: child };
    },
    editLocally() {
      const server = path.join(repo, 'src/server.ts');
      const text = fs.readFileSync(server, 'utf8');
      const listen = 'server.listen(port, () => console.log(`harbor listening on :${port}`));';
      if (!text.includes(listen)) throw new Error('src/server.ts no longer reads as editLocally expects');
      fs.writeFileSync(server, text.replace(listen, "const host = process.env.HOST ?? '127.0.0.1';\nserver.listen(port, host, () => console.log(`harbor listening on ${host}:${port}`));"));
      fs.appendFileSync(path.join(repo, 'docs/configuration.md'), '| `HOST` | `127.0.0.1` | The address the server listens on; `0.0.0.0` in a container. |\n');
    },
    undoLocal() {
      // From HEAD, so what the capture staged goes too.
      h('checkout', 'HEAD', '--', 'src/server.ts', 'docs/configuration.md');
    },
  };
}

/**
 * Noa's earlier sessions in harbor, written as the session store writes them, so the Sessions list has a history under the
 * live one. Two ran (a finished run's plan stays Approved, as the app saves it) and one is a plan never approved. Each
 * matches what Noa committed afterwards.
 */
function pastSessions(repo: string, at: (days: number, hh: number, mm: number) => string): void {
  const dir = path.join(repo, '.ordewell', 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  // The rules the app writes beside its state the first time it saves (STATE_DIR_IGNORE in core's fsHelpers).
  fs.writeFileSync(path.join(repo, '.ordewell', '.gitignore'), '*\n!.gitignore\n!skills/\n!skills/**\n');
  const sessions: ReadonlyArray<{ hex: string; goal: string; status: 'approved' | 'draft'; created: string; updated: string; tasks: ReadonlyArray<{ title: string; runner: string; model: string; label: string }> }> = [
    {
      hex: '3c1e9a07b52d4f68a0e4c7d19b6f2a85', goal: 'Prepare the 0.1.0 release: version, changelog and tag', status: 'approved', created: at(7, 15, 48), updated: at(7, 16, 31),
      tasks: [
        { title: 'Write the 0.1.0 changelog', runner: 'claude-code', model: 'sonnet', label: 'Sonnet' },
        { title: 'Bump the version to 0.1.0', runner: 'codex', model: 'gpt-5.4-mini', label: 'GPT-5.4 mini' },
        { title: 'Check the release notes against the API docs', runner: 'claude-code', model: 'sonnet', label: 'Sonnet' },
      ],
    },
    {
      hex: '8f04d6b1e93a4c27b5d08e6a1c7f3b92', goal: 'Explain local setup in the README', status: 'approved', created: at(3, 11, 2), updated: at(3, 11, 39),
      tasks: [
        { title: 'Write the local setup section', runner: 'opencode', model: 'kimi-k2.6', label: 'Kimi K2.6' },
        { title: 'Follow the steps in a clean checkout', runner: 'codex', model: 'gpt-5.5', label: 'GPT-5.5' },
      ],
    },
    {
      hex: 'b7a2e5c09d164f3e8a51c4d7e2096b3f', goal: 'Paginate the users list', status: 'draft', created: at(1, 10, 30), updated: at(1, 10, 44),
      tasks: [
        { title: 'Add cursor pagination to the users store', runner: 'claude-code', model: 'opus', label: 'Opus' },
        { title: 'Page GET /users with limit and cursor', runner: 'codex', model: 'gpt-5.5', label: 'GPT-5.5' },
        { title: 'Document the paging parameters', runner: 'copilot-cli', model: 'gpt-5.4-mini', label: 'GPT-5.4 mini' },
      ],
    },
  ];
  for (const session of sessions) {
    const createdAt = new Date(session.created).toISOString();
    const updatedAt = new Date(session.updated).toISOString();
    const runners = [...new Set(session.tasks.map((task) => task.runner))];
    const meta = { id: `session-${session.hex}`, goal: session.goal, runners, taskCount: session.tasks.length, status: session.status, createdAt, updatedAt };
    const ran = session.status === 'approved';
    const tasks = session.tasks.map((task, i) => ({
      id: `${session.hex.slice(0, 6)}-${i + 1}`, order: i + 1, title: task.title, description: task.title, type: 'ai',
      dependencies: i === 0 ? [] : [`${session.hex.slice(0, 6)}-1`], prompt: task.title, subtasks: [],
      assignedModel: { modelId: task.model, modelLabel: task.label }, assignedRunner: task.runner,
      taskMode: 'auto', autonomy: 'AFK', sliceType: 'AFK', status: ran ? 'completed' : 'pending', ...(ran ? { attempted: true } : {}),
    }));
    const plan = {
      tasks, generatedAt: createdAt, status: session.status, runners, lastUpdated: updatedAt, approved: ran,
      ...(ran ? { approvedTasks: tasks.map((task) => task.id) } : {}),
      conversationHistory: [
        { role: 'user', content: session.goal, timestamp: createdAt },
        { role: 'assistant', content: `Plan generated with ${tasks.length} tasks.`, timestamp: createdAt, kind: 'plan_generated' },
      ],
    };
    const stem = `${createdAt.replace(/:/g, '-').replace(/\..+/, '')}_${session.goal.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)}`;
    fs.writeFileSync(path.join(dir, `${stem}_${session.hex.slice(0, 8)}.json`), `${JSON.stringify({ meta, plan }, null, 2)}\n`);
  }
}

type Committer = (dir: string, who: Person, date: string, subject: string, changes: Readonly<Record<string, string>>) => void;

/** The three other projects in ~/code, each with a little history of its own, for the welcome window. */
function siblings(code: string, commit: Committer, branch: (dir: string, name: string) => void, at: (days: number, hh: number, mm: number) => string): void {
  const ledger = path.join(code, 'ledger-api');
  commit(ledger, TOMAS, at(30, 10, 0), 'Start ledger-api', { 'README.md': '# ledger-api\n\nDouble-entry bookkeeping behind a small HTTP API.\n' });
  commit(ledger, NOA, at(1, 15, 12), 'Round amounts to the currency\'s minor unit', { 'src/money.ts': 'export function toMinor(amount: number, exponent = 2): number {\n  return Math.round(amount * 10 ** exponent);\n}\n' });
  const tidepool = path.join(code, 'tidepool-ui');
  commit(tidepool, INES, at(40, 11, 30), 'Start tidepool-ui', { 'README.md': '# tidepool-ui\n\nThe components harbor\'s web front end is built from.\n' });
  branch(tidepool, 'feature/date-picker');
  commit(tidepool, INES, at(3, 14, 2), 'Add a date picker with keyboard navigation', { 'src/DatePicker.tsx': 'export function DatePicker(): null {\n  return null;\n}\n' });
  const notes = path.join(code, 'field-notes');
  commit(notes, NOA, at(9, 18, 40), 'Start field-notes', { 'README.md': '# field-notes\n\nWhat the team learned, one page per lesson.\n' });
}
