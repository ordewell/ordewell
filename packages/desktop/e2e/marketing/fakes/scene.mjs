/**
 * What each task of the Harbor marketing plan does, as steps every fake
 * runner plays in its own protocol: thinking, a message, a real file read, a
 * real command, a real edit with its diff, a hold the capture releases, a
 * checkpoint, and task_complete. The work is real: the files are the task's
 * own worktree's, the commands run there, and the suite fails or passes on
 * what the tasks wrote, so the check's verdict is evidence like any other.
 *
 * A scene is chosen by a phrase only its own task's prompt holds. Ordewell puts
 * the task's prompt last, after the plan's titles and earlier outputs, so the
 * phrase found latest in the prompt names the scene.
 *
 * The stage is a directory the capture shares with the fakes (HARBOR_STAGE):
 * a scene that reaches `gate(name)` writes at/<name> and waits for go/<name>,
 * so a still is taken while a task is mid-work and nothing on screen moves.
 * The pace file there scales every beat (0 is instant, 1 reads calmly).
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const STAGE = process.env.HARBOR_STAGE ?? path.join(os.homedir(), '.harbor-stage');

export class Cancelled extends Error {
  constructor() { super('cancelled'); }
}

export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Cancelled());
    const timer = setTimeout(() => { signal?.removeEventListener('abort', stop); resolve(); }, ms);
    const stop = () => { clearTimeout(timer); reject(new Cancelled()); };
    signal?.addEventListener('abort', stop, { once: true });
  });
}

function pace() {
  try {
    const value = Number(fs.readFileSync(path.join(STAGE, 'pace'), 'utf8'));
    return Number.isFinite(value) && value >= 0 ? value : 1;
  } catch {
    return 1;
  }
}

/** A pause of about `ms` at the stage's pace. */
export function beat(ms, signal) {
  return sleep(Math.round(ms * pace()), signal);
}

/** A line in the stage's log, so a capture that stalls says which runner was asked what. */
export function note(runner, text) {
  try {
    fs.mkdirSync(STAGE, { recursive: true });
    fs.appendFileSync(path.join(STAGE, 'runners.log'), `${new Date().toISOString()} ${runner}[${process.pid}] ${text}\n`);
  } catch {
    // A log that cannot be written changes nothing the scene does.
  }
}

export async function gate(name, signal) {
  fs.mkdirSync(path.join(STAGE, 'at'), { recursive: true });
  fs.writeFileSync(path.join(STAGE, 'at', name), `${process.pid}\n`);
  while (!fs.existsSync(path.join(STAGE, 'go', name))) await sleep(100, signal);
}

/** The lines of a file, without the empty one after its final newline. */
function linesOf(text) {
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** A line diff by longest common subsequence: removals before additions where both fit. */
function lineOps(a, b) {
  const n = a.length;
  const m = b.length;
  const common = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) common[i][j] = a[i] === b[j] ? common[i + 1][j + 1] + 1 : Math.max(common[i + 1][j], common[i][j + 1]);
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { ops.push([' ', a[i]]); i++; j++; } else if (common[i + 1][j] >= common[i][j + 1]) ops.push(['-', a[i++]]);
    else ops.push(['+', b[j++]]);
  }
  while (i < n) ops.push(['-', a[i++]]);
  while (j < m) ops.push(['+', b[j++]]);
  return ops;
}

/** Hunks shaped like Claude Code's structuredPatch, with three lines of context. */
export function hunks(before, after, context = 3) {
  const ops = lineOps(linesOf(before), linesOf(after));
  const groups = [];
  ops.forEach(([op], k) => {
    if (op === ' ') return;
    const last = groups[groups.length - 1];
    if (last && k - last.end <= 2 * context) last.end = k;
    else groups.push({ start: k, end: k });
  });
  const oldAt = [];
  const newAt = [];
  let o = 1;
  let n = 1;
  for (const [op] of ops) {
    oldAt.push(o);
    newAt.push(n);
    if (op !== '+') o++;
    if (op !== '-') n++;
  }
  return groups.map(({ start, end }) => {
    const from = Math.max(0, start - context);
    const slice = ops.slice(from, Math.min(ops.length, end + context + 1));
    const oldLines = slice.filter(([op]) => op !== '+').length;
    const newLines = slice.filter(([op]) => op !== '-').length;
    return {
      oldStart: oldLines ? oldAt[from] : oldAt[from] - 1,
      oldLines,
      newStart: newLines ? newAt[from] : newAt[from] - 1,
      newLines,
      lines: slice.map(([op, line]) => `${op}${line}`),
    };
  });
}

const range = (start, lines) => (lines === 1 ? `${start}` : `${start},${lines}`);

/** The hunks as unified diff text, without file headers. */
export function hunkText(patch) {
  return patch.map((h) => `@@ -${range(h.oldStart, h.oldLines)} +${range(h.newStart, h.newLines)} @@\n${h.lines.join('\n')}\n`).join('');
}

function inside(cwd, file) {
  const target = path.resolve(cwd, file);
  if (target !== cwd && !target.startsWith(cwd + path.sep)) throw new Error(`a scene step reaches outside the workspace: ${file}`);
  return target;
}

/** The environment a scene's command runs in: the runner's, less what would make a nested node a test child. */
function commandEnv() {
  const env = { ...process.env };
  for (const key of ['NODE_OPTIONS', 'NODE_TEST_CONTEXT', 'FORCE_COLOR']) delete env[key];
  return { ...env, NO_COLOR: '1' };
}

/**
 * Does one step's work in `cwd` and says what happened, in the terms every
 * runner's tool events are made of. An edit whose text is not in the file
 * throws: a scene that drifted from the Harbor files fails the capture loudly.
 */
export function perform(step, cwd) {
  if (step.read) {
    const content = fs.readFileSync(inside(cwd, step.read), 'utf8');
    return { kind: 'read', path: step.read, abs: inside(cwd, step.read), content, output: content, success: true };
  }
  if (step.run) {
    const done = spawnSync('sh', ['-c', step.run], { cwd, env: commandEnv(), encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    const output = `${done.stdout ?? ''}${done.stderr ?? ''}`.replace(/\n+$/, '');
    return { kind: 'run', command: step.run, description: step.why, output, exitCode: done.status ?? 1, success: done.status === 0 };
  }
  if (step.edit) {
    const abs = inside(cwd, step.edit);
    const before = fs.readFileSync(abs, 'utf8');
    if (!before.includes(step.find)) throw new Error(`${step.edit} has no ${JSON.stringify(step.find.slice(0, 60))}`);
    const after = before.replace(step.find, () => step.replace);
    fs.writeFileSync(abs, after);
    const patch = hunks(before, after);
    return { kind: 'edit', path: step.edit, abs, find: step.find, replace: step.replace, before, after, patch, diff: hunkText(patch), output: `Edited ${step.edit}`, success: true };
  }
  if (step.write) {
    const abs = inside(cwd, step.write);
    const existed = fs.existsSync(abs);
    const before = existed ? fs.readFileSync(abs, 'utf8') : '';
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, step.content);
    const patch = hunks(before, step.content);
    return { kind: 'write', path: step.write, abs, content: step.content, created: !existed, patch, diff: hunkText(patch), output: `Wrote ${step.write}`, success: true };
  }
  throw new Error(`a scene step does nothing: ${JSON.stringify(step)}`);
}

/**
 * Plays `scene` from where `state.next` left it, through `io`, the runner's
 * protocol: think(text), say(text), tool(step) and mcp(name, args). A turn
 * cancelled mid-scene keeps its place, so a message that interrupts it is
 * answered and the scene goes on from the step it stopped at. A runner that
 * takes messages mid-turn hands them over through `io.inbox()`, and each is
 * answered after the step it arrived during, as a real agent reads a steer.
 */
export async function play(scene, state, io, signal) {
  while (state.next < scene.steps.length) {
    for (const message of io.inbox?.() ?? []) await io.say(replyTo(scene, message), signal);
    const step = scene.steps[state.next];
    await beat(step.before ?? 700, signal);
    if (step.think) await io.think(step.think, signal);
    else if (step.say) await io.say(step.say, signal);
    else if (step.gate) await gate(step.gate, signal);
    else if (step.checkpoint) {
      const answer = await io.mcp('checkpoint', { question: step.checkpoint }, signal);
      if (/^rejected/i.test(answer.text.trim())) {
        state.next = scene.steps.length;
        await io.say(scene.rejected ?? 'Understood. I have left it as it was.', signal);
        await io.mcp('task_complete', { status: 'blocked', summary: 'Stopped at the checkpoint, as asked.', reason: answer.text.trim() }, signal);
        return;
      }
    } else if (step.complete) await io.mcp('task_complete', { status: 'done', ...step.complete }, signal);
    else await io.tool(step, signal);
    state.next += 1;
  }
}

/** The text a continuation prompt carries from the user, without Ordewell's own note after it. */
export function userMessage(prompt) {
  const at = prompt.indexOf('\n\n---\n(Ordewell)');
  return (at >= 0 ? prompt.slice(0, at) : prompt).trim();
}

export function sceneFor(prompt) {
  let best = null;
  let at = -1;
  for (const scene of Object.values(SCENES)) {
    const found = prompt.lastIndexOf(scene.marker);
    if (found > at) { best = scene; at = found; }
  }
  return best;
}

/** What a scene says to a message that reaches it mid-work, before it goes on. */
export function replyTo(scene, message) {
  for (const [pattern, reply] of scene.replies ?? []) if (pattern.test(message)) return reply;
  return 'Understood. I will fold that in as I go.';
}

const SIGN_IN = 'src/routes/signIn.ts';
const RATE_LIMIT = 'src/auth/rateLimit.ts';

const RATE_LIMIT_SOURCE = `export interface RateLimitOptions {
  /** Failed attempts allowed within one window. */
  limit: number;
  windowMs: number;
  now?: () => number;
}

export interface Decision {
  allowed: boolean;
  /** Seconds until the next attempt is allowed, when it is not. */
  retryAfter: number;
}

export interface RateLimiter {
  check(key: string): Decision;
  fail(key: string): void;
  reset(key: string): void;
}

export function createRateLimiter({ limit, windowMs, now = Date.now }: RateLimitOptions): RateLimiter {
  const failures = new Map<string, number[]>();

  const recent = (key: string): number[] => {
    const since = now() - windowMs;
    const kept = (failures.get(key) ?? []).filter((at) => at > since);
    failures.set(key, kept);
    return kept;
  };

  return {
    check(key) {
      const attempts = recent(key);
      if (attempts.length < limit) return { allowed: true, retryAfter: 0 };
      return { allowed: false, retryAfter: Math.ceil((attempts[0] + windowMs - now()) / 1000) };
    },
    fail(key) {
      recent(key).push(now());
    },
    reset(key) {
      failures.delete(key);
    },
  };
}
`;

const LIMIT_TESTS = `
describe('sign-in limit', () => {
  const minutes = (n: number) => n * 60_000;

  function limited() {
    let clock = Date.parse('2026-03-17T09:00:00Z');
    const app = createApp({ users, now: () => clock });
    const attempt = (password: string, ip = '203.0.113.7') =>
      app({ method: 'POST', path: '/sign-in', body: { email: 'mara@example.com', password }, ip });
    return { attempt, advance: (ms: number) => { clock += ms; } };
  }

  test('refuses the sixth attempt after five failures', async () => {
    const { attempt } = limited();
    for (let i = 0; i < 5; i++) assert.equal((await attempt('wrong')).status, 401);
    const refused = await attempt('correct horse');
    assert.equal(refused.status, 429);
    assert.equal(refused.headers?.['retry-after'], '900');
  });

  test('counts each address apart', async () => {
    const { attempt } = limited();
    for (let i = 0; i < 5; i++) await attempt('wrong', '203.0.113.7');
    assert.equal((await attempt('correct horse', '198.51.100.20')).status, 200);
  });

  test('opens again once the window has passed', async () => {
    const { attempt, advance } = limited();
    for (let i = 0; i < 5; i++) await attempt('wrong');
    advance(minutes(15));
    assert.equal((await attempt('correct horse')).status, 200);
  });

  test('a successful sign-in clears earlier failures', async () => {
    const { attempt } = limited();
    for (let i = 0; i < 4; i++) await attempt('wrong');
    assert.equal((await attempt('correct horse')).status, 200);
    assert.equal((await attempt('wrong')).status, 401);
    assert.equal((await attempt('correct horse')).status, 200);
  });
});
`;

/**
 * The markers are phrases from the task prompts in mock-planner.mjs, and the
 * edits' `find` texts are the Harbor files' (harbor-files.ts) as each task
 * meets them; the three change the same suite the check runs.
 */
export const SCENES = {
  limit: {
    marker: 'Count failed sign-ins per email and address',
    steps: [
      { think: 'The route is src/routes/signIn.ts and createApp wires it. A limiter of its own, keyed by email and address with an injected clock, keeps the route small and the tests deterministic.', before: 400 },
      { read: SIGN_IN },
      { read: 'src/app.ts' },
      { say: 'I’ll add the limiter as its own module, count only failed attempts, and wire it into the route through createApp.' },
      { write: RATE_LIMIT, content: RATE_LIMIT_SOURCE, before: 1100 },
      {
        edit: SIGN_IN,
        find: "import { verifyPassword } from '../auth/passwords.ts';\nimport type { Sessions } from '../auth/sessions.ts';",
        replace: "import { verifyPassword } from '../auth/passwords.ts';\nimport type { RateLimiter } from '../auth/rateLimit.ts';\nimport type { Sessions } from '../auth/sessions.ts';",
      },
      {
        edit: SIGN_IN,
        find: '  sessions: Sessions;\n}\n\nexport function signIn({ users, sessions }: SignInDeps) {',
        replace: '  sessions: Sessions;\n  limiter: RateLimiter;\n}\n\nexport function signIn({ users, sessions, limiter }: SignInDeps) {',
      },
      {
        edit: SIGN_IN,
        find: "    const user = users.byEmail(email);\n    if (!user || !verifyPassword(password, user.passwordHash)) {\n      return json(401, { error: 'invalid_credentials' });",
        replace: "    const key = `${email.toLowerCase()}|${request.ip}`;\n    const decision = limiter.check(key);\n    if (!decision.allowed) {\n      return json(429, { error: 'too_many_attempts' }, { 'retry-after': String(decision.retryAfter) });\n    }\n    const user = users.byEmail(email);\n    if (!user || !verifyPassword(password, user.passwordHash)) {\n      limiter.fail(key);\n      return json(401, { error: 'invalid_credentials' });",
      },
      {
        edit: 'src/app.ts',
        find: "import { memorySessions, type Sessions } from './auth/sessions.ts';",
        replace: "import { createRateLimiter } from './auth/rateLimit.ts';\nimport { memorySessions, type Sessions } from './auth/sessions.ts';",
      },
      {
        edit: 'src/app.ts',
        find: '  sessions?: Sessions;\n  now?: () => number;',
        replace: '  sessions?: Sessions;\n  /** Failed sign-ins allowed per email and address within the window. */\n  signInLimit?: { limit: number; windowMs: number };\n  now?: () => number;',
      },
      {
        edit: 'src/app.ts',
        find: "  const now = options.now ?? Date.now;\n  const routes: Record<string, Handler> = {\n    'GET /health': health(now(), now),\n    'POST /sign-in': signIn({ users: options.users, sessions: options.sessions ?? memorySessions() }),",
        replace: "  const now = options.now ?? Date.now;\n  const limiter = createRateLimiter({ ...(options.signInLimit ?? { limit: 5, windowMs: 15 * 60_000 }), now });\n  const routes: Record<string, Handler> = {\n    'GET /health': health(now(), now),\n    'POST /sign-in': signIn({ users: options.users, sessions: options.sessions ?? memorySessions(), limiter }),",
      },
      { run: 'npm test', why: 'Run the test suite', before: 900 },
      { gate: 'limit' },
      { say: 'The limiter is in src/auth/rateLimit.ts and POST /sign-in uses it: five failed attempts per email and address within fifteen minutes, then 429 with Retry-After. The existing suite passes.' },
      {
        complete: {
          summary: 'Added src/auth/rateLimit.ts (createRateLimiter, with an injected clock) and wired it into POST /sign-in through createApp. Five failed attempts per email and address within fifteen minutes answer 429 { error: "too_many_attempts" } with Retry-After; createApp takes signInLimit to change the numbers. The existing suite passes.',
          commit: { subject: 'Limit failed sign-in attempts per email and address', body: 'Five failures within fifteen minutes answer 429 with Retry-After until the oldest leaves the window.' },
        },
      },
    ],
  },

  tests: {
    marker: 'Cover the limit through POST /sign-in',
    steps: [
      { think: 'Read the sign-in tests first, then the app factory, to see how a test can move time.', before: 600 },
      { run: "sed -n '1,40p' test/signIn.test.ts", why: 'Read the sign-in tests' },
      { run: 'grep -n "now" src/app.ts', why: 'Find the app clock' },
      { say: 'createApp already takes a now() clock, so each test can own one and move it across the window.' },
      {
        edit: 'test/signIn.test.ts',
        find: "import { test } from 'node:test';",
        replace: "import { describe, test } from 'node:test';",
        before: 1000,
      },
      { edit: 'test/signIn.test.ts', find: "  assert.equal((await signIn('', 'mara@example.com')).status, 400);\n});\n", replace: `  assert.equal((await signIn('', 'mara@example.com')).status, 400);\n});\n${LIMIT_TESTS}` },
      { run: 'node --test --test-reporter=spec --test-name-pattern="^(signs in|rejects|asks)" test/signIn.test.ts', why: 'Run the existing sign-in tests', before: 900 },
      { gate: 'tests' },
      { say: 'Added four tests for the limit in test/signIn.test.ts. They need #1’s limiter, so on this branch I ran the existing four, which pass; the check runs the whole suite once both land.' },
      {
        complete: {
          summary: 'Added a "sign-in limit" block to test/signIn.test.ts: the sixth attempt after five failures answers 429 with Retry-After 900, each address counts apart, the window reopens after fifteen minutes, and a successful sign-in clears earlier failures. They exercise #1’s limiter, so they run in the check; the existing four pass here.',
          commit: { subject: 'Test the sign-in limit through POST /sign-in', body: 'Each test owns the app clock, so the window moves without waiting.' },
        },
      },
    ],
  },

  docs: {
    marker: 'Document the sign-in limit for the people who call the API',
    // Sending now glues every queued message into one, so the first pattern answers both at once.
    replies: [
      [/sign-in attempts?[\s\S]*retry-after|retry-after[\s\S]*sign-in attempts?/i, 'Good calls, both. I’ll say “failed sign-in attempts” throughout, to match the error code, and the changelog entry will name `Retry-After` beside the 429.'],
      [/sign-in attempts?/i, 'Good call. I’ll say “failed sign-in attempts” throughout, to match the error code.'],
      [/retry-after/i, 'Will do: the changelog entry will name `Retry-After` beside the 429.'],
    ],
    steps: [
      { think: 'The API reference lists each status of POST /sign-in in one table. The 429 belongs there, with its header and when the count clears.', before: 500 },
      { run: 'grep -rn "sign-in" README.md docs', why: 'Find where sign-in is documented' },
      { read: 'docs/api.md' },
      { say: 'POST /sign-in lists its answers in one table in docs/api.md. I’ll add the 429 there, then a short section on when the count clears and what Retry-After holds.' },
      {
        edit: 'docs/api.md',
        find: '| 401 | `{ "error": "invalid_credentials" }` | The email or the password is wrong. |\n',
        replace: '| 401 | `{ "error": "invalid_credentials" }` | The email or the password is wrong. |\n| 429 | `{ "error": "too_many_attempts" }` | Too many failed sign-in attempts. See below. |\n\n### Failed sign-in attempts\n\nAfter five failed sign-in attempts for one email from one address within fifteen minutes, `POST /sign-in` answers `429` until the oldest of them leaves the window. `Retry-After` holds the seconds to wait. A successful sign-in clears the count.\n',
        before: 1000,
      },
      { read: 'CHANGELOG.md' },
      { gate: 'docs' },
      { checkpoint: 'The API reference is public. Publish the limit’s numbers there (five attempts, fifteen minutes), or describe the 429 without them?' },
      { say: 'Keeping the numbers in the public reference. Adding the change to the changelog next.' },
      {
        edit: 'CHANGELOG.md',
        find: '## Unreleased\n\n',
        replace: '## Unreleased\n\n- `POST /sign-in` refuses an email and address after five failed sign-in attempts within fifteen minutes, with `429` and `Retry-After`.\n',
      },
      {
        complete: {
          summary: 'Documented the limit in docs/api.md (a 429 row and a "Failed sign-in attempts" section, numbers published as approved at the checkpoint) and added it to the Unreleased section of CHANGELOG.md.',
          commit: { subject: 'Document the sign-in limit', body: 'The public API reference states the numbers, as approved at the checkpoint.' },
        },
      },
    ],
  },

  fix: {
    marker: 'Make the failing sign-in tests pass',
    steps: [
      { think: 'The check reports one failure: after a successful sign-in, the next right password answers 429. Either the limiter never clears, or the route never asks it to.', before: 500 },
      { read: SIGN_IN },
      { read: RATE_LIMIT },
      { say: 'The limiter has reset(), but the route never calls it, so earlier failures still count after a successful sign-in.' },
      { gate: 'fix' },
      {
        edit: SIGN_IN,
        find: "    return json(200, { token: sessions.issue(user.id) });",
        replace: "    limiter.reset(key);\n    return json(200, { token: sessions.issue(user.id) });",
        before: 900,
      },
      { run: 'node --test --test-reporter=spec test/signIn.test.ts', why: 'Run the sign-in tests', before: 800 },
      { say: 'POST /sign-in now clears the count after a successful sign-in, and every sign-in test passes.' },
      {
        complete: {
          summary: 'POST /sign-in now calls limiter.reset(key) after a successful sign-in, so earlier failures stop counting. test/signIn.test.ts passes, with no test changed.',
          commit: { subject: 'Clear failed sign-ins after a successful one', body: 'The limiter could reset a key, but the route never asked it to.' },
        },
      },
    ],
  },

  review: {
    marker: 'Review the rate limiting change as it landed',
    steps: [
      { think: 'Read the limiter, then the route, and look for what changes under production traffic rather than in the tests.', before: 500 },
      { read: RATE_LIMIT },
      { read: SIGN_IN },
      { run: 'git log --oneline -6', why: 'See what landed' },
      { say: 'The change does what the plan asked, and the suite covers each rule. Two things to know before it ships: the counts live in one process’s memory, and an idle key is pruned only when it comes back.' },
      {
        complete: {
          summary: 'The limiter and the route match the plan, and the tests cover each rule. Two findings, neither blocking: counts live in one process’s memory, and idle keys stay until they come back.',
          findings: [
            { severity: 'minor', title: 'Counts live in one process’s memory', detail: 'Each instance keeps its own counts and a restart clears them, so behind a load balancer the effective limit grows with the instance count. A shared store would fix it when there is more than one.', evidence: [{ kind: 'file', path: RATE_LIMIT, line: 21 }] },
            { severity: 'minor', title: 'An idle key is pruned only when it comes back', detail: 'recent() drops old failures for the key it is asked about, so an email that never returns keeps its entry. A periodic sweep, or an LRU cap, bounds the map.', evidence: [{ kind: 'file', path: RATE_LIMIT, line: 23 }] },
          ],
        },
      },
    ],
  },
};
