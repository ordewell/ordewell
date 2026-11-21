#!/usr/bin/env node
// A finished run's score over time, after the fact, with no key. The run kept
// the git history of its work: for arm B every landed task is a merge commit on
// the run's integration branch (ordewell/<run>/integration), with the time it
// landed; for arm A the task's branch holds the commits the agent made as it
// went. This picks N-1 points in time, and for arm B every landing after the
// last slice besides, takes the source at each commit and scores it through the harness's own `materialize` and `scoreInFreshBox`
// (drive.mjs), the same eval box and the same selection of the arm's non-test
// source files as the run's final score: nothing here scores anything itself.
// The final point is the run's own final tree, and it must equal result.json's
// score, or the whole timeline is marked unverified. See bench/README.md,
// "Commit0".
//
//   node bench/commit0/timeline.mjs <run dir> --libs <libraries.json> [--points 8 | --minutes 20,40,60] [--jobs 2]

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as L from './lib.mjs';
import * as R from './rehearsal.mjs';
import { fanOutShape } from './fanout.mjs';

export const DEFAULT_POINTS = 8;
export const DEFAULT_JOBS = 2;

const HELP = `Usage: node bench/commit0/timeline.mjs <run dir> --libs <libraries.json> [options]

  <run dir>             a finished run's directory: result.json, arm-workdir/ (its git history)
                        and workspace-ordewell/ (its session)
  --libs <file>         the libraries the run was made with (its image and test settings)
  --points <n>          n - 1 points in time (default ${DEFAULT_POINTS}), evenly spaced over the run's
                        wall clock, each the newest commit at or before it; the final tree is always
                        one, and for arm B so is every landing after the last slice landed (the
                        closing check's and what follows), on top of the n - 1
  --minutes <a,b,c>     the minutes after the run began to take, in place of --points; the final
                        tree and arm B's landings from the closing check on are still scored
  --jobs <n>            containers at once (default ${DEFAULT_JOBS})
  --branch <ref>        the branch holding the run's work, when it is not the one found

Scores each point in a fresh eval box on no network, with no key (any key is removed from the
environment) and writes timeline.json into the run directory. A point whose pytest was killed
(exit 137) with no counts fails, is tried once more alone, and if killed again is left out of
the threshold crossings. The final point must equal the score
in result.json; when it does not, the timeline is marked unverified and the exit is non-zero.`;

/** Every variable that holds a credential, taken out: this reads a finished run and calls no model. */
export function dropKeys(env) {
  for (const k of R.realKeysIn(env)) delete env[k];
  delete env.OPENROUTER_API_KEY;
  return env;
}

// --- The run's history ------------------------------------------------------

/**
 * An empty file for GIT_CONFIG_GLOBAL, made once: os.devNull is `\\.\nul` on
 * Windows, which git cannot open as a configuration.
 */
let emptyConfig = null;
function noGlobalConfig() {
  if (!emptyConfig) {
    emptyConfig = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'commit0-gitconfig-')), 'empty');
    fs.writeFileSync(emptyConfig, '');
  }
  return emptyConfig;
}

/**
 * The commits of a finished run's work, from the repository copied out of the
 * arm's box, read by a git that takes no configuration from the machine or the
 * arm's own hooks beyond what reading history touches.
 *
 * Arm B: the first-parent commits of the integration branch, one per landing,
 * newest last; `lastLanding` the newest. After the end-of-run merge the
 * workdir holds no integration branch, only `commit0-base` (and a remote ref
 * that may be behind), and the first-parent line of `commit0-base` holds every
 * landing: that is read then, and for any `branch` named. Arm B never reads a
 * full `git log`, which would reach a slice's own commit, a tree no landing
 * produced; a tree off the first-parent line is never a point. Arm A: every commit of the task's
 * branch since the stubs (the newest `ordewell/<run>/<task>` branch, or a
 * preserved one). `final` is that branch's tip, the tree the run ended on.
 * The root, the stubs, is never a point of its own unless nothing landed.
 */
export function runHistory(runDir, { arm, branch = null, merged = false }) {
  const gitDir = path.join(runDir, 'arm-workdir', '.git');
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: noGlobalConfig() };
  const git = (...args) => {
    const r = spawnSync('git', ['--git-dir', gitDir, ...args], { encoding: 'utf8', env, maxBuffer: 2 ** 28 });
    if (r.status !== 0) throw new Error(`git ${args[0]}: ${(r.stderr || r.error?.message || '').trim()}`);
    return r.stdout.trim();
  };
  const refs = git('for-each-ref', '--format=%(refname)\t%(objectname)\t%(committerdate:unix)', 'refs/heads').split('\n').filter(Boolean)
    .map((l) => { const [ref, sha, ct] = l.split('\t'); return { name: ref.replace(/^refs\/heads\//, ''), sha, ct: Number(ct) }; });
  const root = git('rev-list', '--max-parents=0', 'commit0-base').split('\n')[0];
  const wanted = branch
    ? (n) => n === branch
    : arm === 'B' ? (n) => /^ordewell\/[^/]+\/integration$/.test(n) : (n) => /^ordewell(-preserved)?\/[^/]+\/(?!integration$).+/.test(n);
  // A single agent scored from what was merged (a continued one lands each attempt that reports done, and the end-of-run merge folds them into
  // commit0-base): its tree is commit0-base's, and the branch of an attempt left behind is an earlier point of it, never the final.
  const tip = (merged && !branch && arm !== 'B' ? refs.find((r) => r.name === 'commit0-base') : undefined)
    ?? refs.filter((r) => wanted(r.name)).sort((a, b) => b.ct - a.ct)[0]
    ?? (arm === 'B' && !branch ? refs.find((r) => r.name === 'commit0-base') : undefined);
  if (!tip) throw new Error(`no branch of the run's work in ${gitDir}: ${branch ?? (arm === 'B' ? 'ordewell/<run>/integration' : 'ordewell/<run>/<task>')}`);
  const format = '--format=%H\t%ct\t%P\t%s';
  const lines = arm === 'B'
    ? git('log', '--first-parent', format, tip.sha)
    : git('log', format, `${root}..${tip.sha}`);
  const commits = lines.split('\n').filter(Boolean).map((l) => {
    const [sha, ct, parents, ...subject] = l.split('\t');
    return { sha, ms: Number(ct) * 1000, parents: parents ? parents.split(' ').length : 0, subject: subject.join('\t') };
  }).filter((c) => c.sha !== root && c.parents > 0).reverse();
  commits.sort((a, b) => a.ms - b.ms);
  return {
    gitDir, root, branch: tip.name, commits, final: tip.sha,
    lastLanding: arm === 'B' ? commits.at(-1)?.sha ?? null : null,
    armTree: git('rev-parse', `${root}^{tree}`),
  };
}

/** When the run began: its session's creation, which the planner or the arm's setup makes within seconds of the clock; else the run's own start. */
export function runStartMs(runDir, result) {
  const dir = path.join(runDir, 'workspace-ordewell', 'sessions');
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')).sort(); } catch { /* the copy holds no session */ }
  for (const name of names) {
    try {
      const at = Date.parse(JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'))?.meta?.createdAt);
      if (Number.isFinite(at)) return at;
    } catch { /* a file that does not parse is not a session */ }
  }
  const at = Date.parse(result.startedAt);
  if (!Number.isFinite(at)) throw new Error('the run has no start time: no session in workspace-ordewell and no startedAt in result.json');
  return at;
}

// --- Which points -----------------------------------------------------------

/**
 * The plan a run's session saved (`{meta, plan}` in workspace-ordewell), the
 * session `sessionId` names when result.json has one, else the first that
 * holds a plan; null when the copy holds none.
 */
export function savedPlan(runDir, sessionId = null) {
  const dir = path.join(runDir, 'workspace-ordewell', 'sessions');
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')).sort(); } catch { /* the copy holds no session */ }
  const plans = [];
  for (const name of names) {
    try {
      const saved = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      if (Array.isArray(saved?.plan?.tasks)) plans.push({ id: saved.meta?.id ?? null, plan: saved.plan });
    } catch { /* a file that does not parse is not a session */ }
  }
  return (plans.find((p) => sessionId && p.id === sessionId) ?? plans[0])?.plan ?? null;
}

/**
 * The landings that come after the last slice has landed: the closing check's
 * and whatever follows it. The closing check waits for every slice (core's
 * fan-out shape, fanout.mjs), so its first attempt starts after the last
 * slice's landing, and a landing later than that start (to the second, the
 * resolution of a commit's time) is its or a later one's. Empty where the plan
 * has no closing check or its attempts carry no start time: the last landing
 * is forced anyway.
 */
export function landingsAfterSlices({ commits, plan }) {
  const closer = plan ? fanOutShape(plan).closers[0] : null;
  const starts = (closer?.attemptUsage ?? []).map((u) => Date.parse(u?.startedAt)).filter(Number.isFinite);
  if (!starts.length) return [];
  const from = Math.floor(Math.min(...starts) / 1000) * 1000;
  return commits.filter((c) => c.ms > from).map((c) => c.sha);
}

/**
 * The commits to score. `commits` is `{sha, ms}`, oldest first, without the
 * stubs. Each target time (`minutes` after `t0Ms`, else `points` less the
 * final's own slot, spaced evenly over the run's length) takes the newest
 * commit at or before it, and a target before any commit takes none. The
 * final commit is always a point, and so is `lastLanding` where there is one,
 * and every one of `afterSlices` (arm B's landings from the closing check on):
 * these come on top, so `points` bounds only the evenly spaced part. Points
 * that name one commit are one point: the answer is in time order.
 */
export function timelinePoints({ commits, finalSha, lastLanding = null, afterSlices = [], t0Ms, endMs, points = DEFAULT_POINTS, minutes = null }) {
  const forced = [...new Set([finalSha, lastLanding, ...afterSlices].filter(Boolean))];
  const spaced = Math.max(0, points - 1);
  const targets = minutes
    ? minutes.map((m) => ({ targetMin: m, at: t0Ms + m * 60_000 }))
    : Array.from({ length: spaced }, (_, i) => {
      const at = t0Ms + ((i + 1) * (endMs - t0Ms)) / (spaced + 1);
      return { targetMin: (at - t0Ms) / 60_000, at };
    });
  const byTime = new Map();
  for (const t of targets) {
    const hit = commits.filter((c) => c.ms <= t.at).at(-1);
    if (hit && !forced.includes(hit.sha) && !byTime.has(hit.sha)) byTime.set(hit.sha, { sha: hit.sha, kind: 'time', targetMin: t.targetMin });
  }
  const msOf = (sha) => commits.find((c) => c.sha === sha)?.ms ?? Infinity;
  const picked = [
    ...byTime.values(),
    ...forced.map((sha) => ({ sha, kind: sha === finalSha ? 'final' : 'landing', targetMin: null })),
  ].sort((a, b) => msOf(a.sha) - msOf(b.sha) || (a.kind === 'final') - (b.kind === 'final'));
  return picked.map((p) => ({ ...p, atMin: Number.isFinite(msOf(p.sha)) ? round1((msOf(p.sha) - t0Ms) / 60_000) : null }));
}

/**
 * A run's history, its start and the points to score, from its directory.
 * `arm` is the arm's id; `result` is its result.json.
 */
export function chooseTimelinePoints(runDir, { arm, result = null, points = DEFAULT_POINTS, minutes = null, branch = null }) {
  runDir = path.resolve(runDir);
  result ??= JSON.parse(fs.readFileSync(path.join(runDir, 'result.json'), 'utf8'));
  const history = runHistory(runDir, { arm, branch, merged: result.scoredFrom === 'merged' });
  const t0Ms = runStartMs(runDir, result);
  const endMs = t0Ms + (result.wallClockMs ?? 0);
  const afterSlices = arm === 'B' ? landingsAfterSlices({ commits: history.commits, plan: savedPlan(runDir, result.sessionId) }) : [];
  const chosen = timelinePoints({ commits: history.commits, finalSha: history.final, lastLanding: history.lastLanding, afterSlices, t0Ms, endMs, points, minutes });
  return { history, t0Ms, chosen };
}

const round1 = (x) => Math.round(x * 10) / 10;

/**
 * A test run the system killed (exit 137, an out-of-memory kill or a signal)
 * that printed no summary: it counted nothing, which is not a count of zero.
 * A summary that came out is read as it says, whatever the exit.
 */
export const isKilledRun = (tests) => Boolean(tests) && tests.exit === 137 && typeof tests.passed !== 'number';

/** The shares of the tests collected whose first crossing the timeline reports. */
export const CROSSING_SHARES = Object.freeze([0.25, 0.5, 0.75, 0.9, 1]);

/**
 * The first point, in time order, at which the passed tests reach each share
 * of `collected`; null where none does, or where `collected` is not known.
 * Only a point that was scored counts: one that failed, a killed run
 * included, is no evidence of what the tree passed at that time.
 */
export function thresholdCrossings(points, collected, shares = CROSSING_SHARES) {
  const scored = points.filter((p) => p.ok && !p.killed && typeof p.tests?.passed === 'number');
  return shares.map((share) => {
    const hit = Number.isFinite(collected) && collected > 0 ? scored.find((p) => p.tests.passed >= share * collected - 1e-9) : undefined;
    return { share, atMin: hit?.atMin ?? null, label: hit?.label ?? null };
  });
}

/** The numbers a score is read by, as result.json keeps them. */
const scoreOf = (tests) => (tests ? { passed: tests.passed ?? 0, failed: tests.failed ?? 0, errors: tests.errors ?? 0 } : null);

/** Whether the final point's score is the run's own: the same passed, failed and errors. */
export function judgeFinal({ resultTests, final }) {
  const want = scoreOf(resultTests);
  if (!want) return { ok: false, reason: 'result.json holds no score to compare the final point to' };
  if (!final) return { ok: false, reason: 'no final point was scored' };
  if (final.error) return { ok: false, reason: `the final point could not be scored: ${final.error}` };
  const got = scoreOf(final.tests);
  if (!got) return { ok: false, reason: 'the final point has no test summary' };
  const same = want.passed === got.passed && want.failed === got.failed && want.errors === got.errors;
  return same ? { ok: true, reason: null } : { ok: false, reason: `the final point scored ${got.passed} passed, ${got.failed} failed, ${got.errors} errors; result.json says ${want.passed}, ${want.failed}, ${want.errors}` };
}

// --- Scoring ----------------------------------------------------------------

/** The harness's own scoring, loaded as the module it exports, in the dry-run mode that keeps a key out of every child. */
export async function loadDriver() {
  return import(pathToFileURL(path.join(import.meta.dirname, 'drive.mjs')).href);
}

/**
 * Scores a run's points and writes timeline.json into its directory.
 * `driver` is `{materialize, scoreInFreshBox}` of drive.mjs. Returns the
 * timeline and `ok`: verified, and every point scored.
 */
export async function scoreTimeline({ runDir, libraries, points = DEFAULT_POINTS, minutes = null, jobs = DEFAULT_JOBS, branch = null, driver = null }) {
  dropKeys(process.env);
  runDir = path.resolve(runDir);
  const result = JSON.parse(fs.readFileSync(path.join(runDir, 'result.json'), 'utf8'));
  const raw = libraries.find((l) => l.name === result.library);
  if (!raw) throw new Error(`the run's library ${result.library} is not in the libraries file`);
  const arm = L.isSingleAgent(result.arm) ? L.ARMS[result.arm] : L.ARMS.B;
  const { history, t0Ms, chosen } = chooseTimelinePoints(runDir, { arm: arm.id, result, points, minutes, branch });
  const d = driver ?? await loadDriver();
  const settings = L.armSettings(arm, { parallel: result.parallel, cpus: result.cpus, memory: result.memory, capUsd: result.capUsd, wallCapMs: result.wallCapMs, callBudget: result.callBudget });
  const lib = { ...L.validateLibrary(raw), flatTree: history.armTree, flatCommit: history.root };
  const out = path.join(runDir, 'timeline');
  fs.mkdirSync(out, { recursive: true });

  const scoreOne = async (p, index) => {
    const label = `p${index + 1}-${p.sha.slice(0, 8)}`;
    const dir = path.join(out, label);
    fs.mkdirSync(dir, { recursive: true });
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'commit0-timeline-'));
    const started = Date.now();
    const rec = { label, ...p };
    try {
      const tree = path.join(work, 'files');
      d.materialize(history.gitDir, p.sha, tree);
      const runId = `timescore-${path.basename(runDir)}-${label}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');
      const scored = await d.scoreInFreshBox({ ...lib }, tree, { runId, settings, runDir: dir, inspect: null });
      const killed = isKilledRun(scored.tests);
      Object.assign(rec, {
        ok: Boolean(scored.treeCheck?.ok && scored.tests) && !killed,
        ...(killed ? { killed: true, error: 'pytest was killed (exit 137) and printed no counts: the point has no score' } : {}),
        treeCheck: scored.treeCheck, tests: scored.tests ?? null, copied: scored.copied?.length ?? 0, removed: scored.removed?.length ?? 0,
        needsInspection: scored.needsInspection ?? [], patchError: scored.patchError ?? null,
      });
    } catch (err) {
      Object.assign(rec, { ok: false, error: String(err?.message ?? err) });
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
    rec.secs = Math.round((Date.now() - started) / 1000);
    L.writeJsonAtomic(path.join(dir, 'score.json'), rec);
    console.log(`point ${label} at ${p.atMin ?? '?'} min (${p.kind}): ${rec.tests ? `${rec.tests.passed} passed, ${rec.tests.failed} failed, ${rec.tests.errors ?? 0} errors` : rec.error ?? 'no score'} (${rec.secs} s)`);
    return rec;
  };

  // At most `jobs` containers at once: a worker takes the next point as it finishes its own.
  const scored = new Array(chosen.length);
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < chosen.length; i = next++) scored[i] = await scoreOne(chosen[i], i);
  };
  await Promise.all(Array.from({ length: Math.min(jobs, chosen.length) }, worker));
  // A kill is often the host's memory with several boxes up at once: each such point gets one more try, alone.
  for (let i = 0; i < scored.length; i++) {
    if (!scored[i].killed) continue;
    const retry = await scoreOne(chosen[i], i);
    scored[i] = { ...retry, retried: true };
    L.writeJsonAtomic(path.join(out, retry.label, 'score.json'), scored[i]);
  }

  const final = scored.find((p) => p.kind === 'final');
  const verdict = judgeFinal({ resultTests: result.tests, final });
  const timeline = {
    run: path.basename(runDir), library: result.library, arm: result.arm, branch: history.branch,
    startedAtMs: t0Ms, wallClockMs: result.wallClockMs ?? null, collected: result.tests?.collected ?? null,
    requested: minutes ? { minutes } : { points },
    verified: verdict.ok, unverified: verdict.ok ? null : verdict.reason,
    finalMatchesResult: verdict.ok,
    jobs, generatedAt: new Date().toISOString(),
    crossings: thresholdCrossings(scored, result.tests?.collected),
    points: scored,
  };
  L.writeJsonAtomic(path.join(runDir, 'timeline.json'), timeline);
  const failed = scored.filter((p) => !p.ok);
  return { timeline, ok: verdict.ok && failed.length === 0 };
}

// --- Command line -----------------------------------------------------------

export function parseTimelineArgs(argv) {
  const o = { runDir: null, libs: null, points: DEFAULT_POINTS, minutes: null, jobs: DEFAULT_JOBS, branch: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === '--help' || a === '-h') o.help = true;
    else if (a === '--libs') o.libs = path.resolve(value());
    else if (a === '--points') {
      o.points = Number(value());
      if (!Number.isInteger(o.points) || o.points < 1) throw new Error('--points takes a whole number, 1 or more');
    } else if (a === '--minutes') {
      const v = value();
      o.minutes = v.split(',').filter(Boolean).map(Number);
      if (!o.minutes.length || o.minutes.some((m) => !Number.isFinite(m) || m < 0)) throw new Error(`--minutes takes minutes after the run began, 0 or more, comma-separated, not ${v}`);
    } else if (a === '--jobs') {
      o.jobs = Number(value());
      if (!Number.isInteger(o.jobs) || o.jobs < 1) throw new Error('--jobs takes a whole number, 1 or more');
    } else if (a === '--branch') o.branch = value();
    else if (a.startsWith('--')) throw new Error(`unknown argument ${a}`);
    else if (o.runDir === null) o.runDir = path.resolve(a);
    else throw new Error(`one run directory, not also ${a}`);
  }
  if (o.help) return o;
  if (!o.runDir) throw new Error('a run directory is needed');
  if (!o.libs) throw new Error('--libs <file> is needed: the library\'s image and test settings');
  return o;
}

async function main() {
  let o;
  try {
    o = parseTimelineArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`${err.message}\n\n${HELP}`);
    return 2;
  }
  if (o.help) {
    console.log(HELP);
    return 0;
  }
  const raw = JSON.parse(fs.readFileSync(o.libs, 'utf8'));
  const { timeline, ok } = await scoreTimeline({ runDir: o.runDir, libraries: Array.isArray(raw) ? raw : raw.libraries ?? [], points: o.points, minutes: o.minutes, jobs: o.jobs, branch: o.branch });
  console.log(`\ntimeline: ${timeline.points.length} points of ${timeline.library} ${timeline.arm} in ${path.join(o.runDir, 'timeline.json')}`);
  if (!timeline.verified) console.error(`UNVERIFIED: ${timeline.unverified}`);
  else if (!ok) console.error('verified, but a point could not be scored: see timeline.json');
  return ok ? 0 : 1;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(import.meta.filename)) {
  main().then((code) => { process.exitCode = code; }, (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
