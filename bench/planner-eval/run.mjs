#!/usr/bin/env node
/**
 * Planner eval: planning only, A/B across builds of Ordewell, scored against
 * answer keys. Each run drives the real `ordewell tui` under a pseudo-terminal
 * against a throwaway clone of the repository, answers the planner's
 * questions with a fixed line, confirms its outline, and stops the moment
 * submit_plan lands. Nothing a plan holds is ever approved or run.
 *
 *   node bench/planner-eval/run.mjs --smoke
 *   node bench/planner-eval/run.mjs --full
 *   node bench/planner-eval/run.mjs --mock          offline, against bench/live/mock-provider.mjs
 *   node bench/planner-eval/run.mjs --report <dir>  aggregate a results directory again
 *   node bench/planner-eval/run.mjs --rescore <dir> score a results directory again with today's keys
 *
 * See bench/planner-eval/README.md for the flags and what every metric means.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { aggregate, isComplete, markdown } from './lib/aggregate.mjs';
import { ensureBuild, repoRoot, resolveRef, cliMain } from './lib/builds.mjs';
import {
  CELLS, HERE, MAX_DRIVER_TURNS, VARIANTS, goalText, loadGoals, missingFor, mockCell, parseArgs, quotaOf,
  approvalPolicy, runEnv, runSettings, selectRuns, substituteFor, timeoutFor,
} from './lib/config.mjs';
import { guardFiles } from './lib/guard.mjs';
import { keyChecks, keyHash } from './lib/keys.mjs';
import { planDigest, runMetrics, sessionParts } from './lib/metrics.mjs';
import { classifyTurn, daemonClient, newestSession, plannerApprovals, readToken, replyLanded, tokenPath } from './lib/observe.mjs';
import { freePort, onPath, run, sleep, until } from './lib/proc.mjs';
import { redactJson, redactor } from './lib/redact.mjs';
import { reviewPlan } from './lib/rubric.mjs';
import { cloneTarget, ensureTemplate, workParent } from './lib/target.mjs';
import { startTui } from './lib/tui.mjs';
import { startMock as start } from '../live/start-mock.mjs';

const USAGE = `usage: node bench/planner-eval/run.mjs (--smoke | --full | --mock | --report <dir> | --rescore <dir>) [options]

  --smoke                 G1 on claude-code/haiku, once per variant
  --full                  every goal, backend and variant, three times
  --mock                  offline dry run against bench/live/mock-provider.mjs, this checkout's build
  --report <dir>          aggregate the records in <dir> again; runs nothing
  --rescore <dir>         score the runs stored in <dir> again with the current keys and metrics, into --out
                          (default <dir>-rescored); the rubric is reviewed again only where a key changed

  --backend a,b           cells by id or prefix (claude-code, opencode/glm-5.3-flash, openrouter, cline ...)
  --goal g1,g4            goals by id
  --variant V0,V1         variants (V0 baseline + nudges, V1 candidate; V2 candidate
                          with the planner read limit, only when named)
  --repeats N             repeats per (goal, backend, variant)
  --concurrency N         runs at once (default 2)
  --timeout S             seconds a run may take before it is stopped (default 900); a stopped run is a failed run
  --api-timeout S         the same for an API (openrouter) planner (default twice --timeout)
  --candidate-ref REF     the build V1 uses (default HEAD)
  --baseline-ref REF      the build V0 uses and every target is cut from (default 0ecc6412)
  --runners a,b           ORDEWELL_ENABLED_RUNNERS for every run (default: the cell's planner runner)
  --max-parallel N        ORDEWELL_MAX_PARALLEL for every run (default 4)
  --no-review             skip the rubric review
  --review-model M        the reviewer's model (default opus)
  --review-timeout S      seconds the reviewer may take (default 600)
  --with-optional         include the ACP cells (cline, copilot-cli, qwen-code, gemini-cli, cursor-agent)
  --mock-persona M        the mock provider's persona (default mock/interviewer)
  --out <dir>             results directory (default bench/planner-eval/.results/<stamp>)
  --resume <dir>          continue a results directory, skipping every run already complete
  --baseline-from <dir>   take V0's runs from <dir> (a stored or re-scored directory) where this one has none
  --keep                  keep each run's target clone
  --list                  print the runs and the cells this host cannot run, and stop`;

const ORDEWELL_HOME = path.join(os.homedir(), '.ordewell');
const redact = redactor(process.env);
const say = (line) => process.stderr.write(`${redact(line)}\n`);

const POLL_MS = 2000;
const STARTUP_MS = 120_000;

/** The runner that plans for a cell; an API planner gets claude-code to assign tasks to. */
const plannerRunner = (cell) => (cell.provider === 'openrouter' ? 'claude-code' : cell.provider);

function writeJson(file, value, extra = []) {
  const scrub = extra.length ? redactor(process.env, extra) : redact;
  fs.writeFileSync(file, `${redactJson(value, scrub)}\n`);
}

/** How long a sent line may go unseen (no new message, no busy turn) before the driver sends it once more. */
const LANDING_MS = 45_000;

/**
 * Drive one planning conversation to a plan, a stop or the deadline. Two
 * things the TUI does can lose the driver's line without a trace: its modal
 * approval card swallows a bracketed paste. So the driver answers any open
 * planner approval card (the goal's `approvals`, allow by default) through the
 * daemon, confirms each line landed, and resends it once if not. A run that
 * ends with a card still open is its own outcome, not a silent planner.
 */
async function drive({ tui, client, workspace, goal, variant, timeoutMs }) {
  const started = Date.now();
  const deadline = started + timeoutMs;
  const policy = approvalPolicy(goal);
  let turns = 0;
  let sentAt = 0;
  let sawBusy = false;
  let session = null;
  let lastText = '';
  let pending = null;
  let approvalsAnswered = 0;
  let openApprovals = 0;
  let resends = 0;
  const send = async (text) => {
    sentAt = session ? sessionParts(session).history.length : 0;
    sawBusy = false;
    turns++;
    pending = { text, at: Date.now(), resent: false };
    await tui.send(text);
  };
  const done = (stopped, extra = {}) => ({
    stopped, turns, session, lastText, wallMs: Date.now() - started, approvalsAnswered, resends, ...extra,
  });
  /** Answer every planner card the daemon lists; the count left open afterwards. */
  const settleApprovals = async (id) => {
    const body = await client.approvals(id, workspace).catch(() => null);
    let open = 0;
    for (const card of plannerApprovals(body)) {
      const ok = await client.decide(id, card.id, workspace, policy === 'allow').then(() => true, () => false);
      if (ok) approvalsAnswered++;
      else open++;
    }
    return open;
  };
  await send(goalText(goal, variant));
  for (;;) {
    if (!tui.alive) {
      const { code, signal } = await tui.exited;
      return done('tui exited', { exitCode: code, signal });
    }
    await sleep(POLL_MS);
    const meta = newestSession(await client.sessions(workspace).catch(() => []));
    if (meta) {
      const next = await client.session(meta.id, workspace).catch(() => null);
      if (next) session = next;
      openApprovals = await settleApprovals(meta.id);
    }
    if (Date.now() > deadline) {
      // A card the planner is blocked on is not a planner that fell silent.
      const open = meta ? plannerApprovals(await client.approvals(meta.id, workspace).catch(() => null)).length : 0;
      return done(open > 0 || openApprovals > 0 ? 'timeout with a pending approval' : 'timeout');
    }
    if (!meta || !session) continue;
    if (pending && !replyLanded(session, { sentAt, sawBusy })) {
      if (!pending.resent && Date.now() - pending.at > LANDING_MS && openApprovals === 0) {
        pending.resent = true;
        resends++;
        await tui.send(pending.text);
      }
      continue;
    }
    pending = null;
    const turn = classifyTurn(session, { sentAt, sawBusy });
    if (turn.state === 'busy') {
      sawBusy = sawBusy || Boolean(session.plannerTurnId) || (session.conversation?.pendingTurns ?? []).length > 0;
      continue;
    }
    lastText = turn.text ?? '';
    if (turn.state === 'plan') return done('plan submitted');
    if (turn.state === 'error') return done('error');
    if (turns >= MAX_DRIVER_TURNS) return done('turn limit');
    await send(turn.reply);
  }
}

/** One planning run, start to finish: target, settings, TUI, conversation, capture, teardown. */
async function planOnce({ spec, cell, build, template, modulesFrom, opts, dir, workRoot }) {
  const workspace = path.join(workRoot, spec.id);
  fs.rmSync(workspace, { recursive: true, force: true });
  await cloneTarget({ template, dir: workspace, modulesFrom });
  const port = await freePort();
  const tokenFile = tokenPath(port);
  const tokenExisted = fs.existsSync(tokenFile);
  const settingsPath = path.join(dir, `${spec.id}.settings.json`);
  const enabledRunners = opts.runners ?? [plannerRunner(cell)];
  writeJson(settingsPath, runSettings({ cell, enabledRunners }));
  const env = runEnv(process.env, { cell, variant: spec.variant, settingsPath, maxParallel: opts.maxParallel, enabledRunners });
  const tui = startTui({ main: build.main, workspace, port, env, logFile: path.join(dir, `${spec.id}.screen.log`), redact });
  let token = null;
  try {
    token = await until('the daemon token', STARTUP_MS, async () => (tui.alive ? readToken(port) : Promise.reject(new Error('tui exited'))));
    const client = daemonClient(port, token);
    await until('the daemon to answer', STARTUP_MS, () => client.sessions(workspace).then(() => true));
    // The TUI attaches after the daemon answers; a paste before its first frame is lost.
    await until('the TUI to draw', STARTUP_MS, async () => tui.screen().trim().length > 0);
    await sleep(3000);
    const outcome = await drive({ tui, client, workspace, goal: spec.goal, variant: spec.variant, timeoutMs: timeoutFor(cell, opts) });
    return { outcome, screen: tui.screen(), token };
  } finally {
    await tui.stop();
    // The TUI stops the daemon it owns; this covers a TUI that died before it could.
    await run(process.execPath, [build.main, 'stop', '--server', '--port', String(port)], { env, timeoutMs: 30_000 });
    if (!tokenExisted) fs.rmSync(tokenFile, { force: true });
    if (!opts.keep) fs.rmSync(workspace, { recursive: true, force: true });
  }
}

/**
 * Why a stop that is not the planner's answer failed the run. A timeout is the
 * bench's limit, not a plan with nothing wrong in it: scored as one, a run
 * that never finished read as zero violations.
 */
function stopError(stopped, { timeoutMs, lastText = '' } = {}) {
  if (stopped === 'timeout') return `timeout after ${Math.round(timeoutMs / 1000)}s`;
  if (stopped === 'timeout with a pending approval') return `timeout with a pending approval after ${Math.round(timeoutMs / 1000)}s`;
  if (stopped === 'tui exited') return 'the TUI exited before the planner answered';
  if (stopped === 'error') return lastText.slice(0, 300) || 'the planner turn failed';
  return null;
}

/** A run's metrics and key checks from its session, with the keys and metrics as they are now. */
function score(goal, session, { driver }) {
  const parts = sessionParts(session);
  const metrics = runMetrics(session, { driver, autoMerge: true, goalText: goal.goal });
  return { metrics, keyChecks: metrics.submitted ? keyChecks(goal, parts.tasks, { researchLog: parts.researchLog }) : [] };
}

async function record({ spec, builds, templates, opts, dir, workRoot }) {
  const build = builds[spec.variant.build];
  const base = {
    id: spec.id, cell: spec.cell.id, variant: spec.variant.id, goal: spec.goal.id, repeat: spec.repeat, build: build.sha, keyHash: keyHash(spec.goal),
    // What the variant changed of the environment, such as the planner read limit, so a record says what it ran under.
    ...(Object.keys(spec.variant.env).length ? { env: spec.variant.env } : {}),
  };
  let cell = spec.cell;
  let substitution;
  for (;;) {
    try {
      const { outcome, screen, token } = await planOnce({
        spec, cell, build, template: templates[spec.goal.id], modulesFrom: builds.baseline.mock ? null : builds.baseline.dir, opts, dir, workRoot,
      });
      const quota = quotaOf({ ...outcome, screen });
      const fallback = quota && !substitution ? substituteFor(cell) : null;
      if (fallback && missingFor(fallback, { env: process.env, onPath }).length === 0) {
        say(`${spec.id}: quota hit on ${cell.model}; rerunning with ${fallback.model}`);
        substitution = { from: cell.model, to: fallback.model, reason: quota };
        cell = fallback;
        continue;
      }
      const session = outcome.session ?? {};
      fs.writeFileSync(path.join(dir, `${spec.id}.session.json`), `${redactJson(session, redactor(process.env, [token]))}\n`);
      const { metrics, keyChecks: checks } = score(spec.goal, session, { driver: outcome });
      let rubric;
      if (metrics.submitted && opts.review) {
        say(`${spec.id}: reviewing the plan`);
        rubric = await reviewPlan(spec.goal, planDigest(sessionParts(session).tasks), { model: opts.reviewModel, timeoutMs: opts.reviewTimeoutMs });
      }
      const error = quota && !metrics.submitted ? `quota: ${quota}` : stopError(outcome.stopped, { timeoutMs: timeoutFor(cell, opts), lastText: outcome.lastText });
      return {
        ...base,
        model: cell.model,
        metrics,
        keyChecks: checks,
        ...(rubric ? { rubric } : {}),
        ...(error ? { error } : {}),
        ...(substitution ? { substitution } : {}),
      };
    } catch (error) {
      return { ...base, model: cell.model, error: String(error?.message ?? error).slice(0, 500), ...(substitution ? { substitution } : {}) };
    }
  }
}

async function pool(items, size, work) {
  let next = 0;
  const lane = async () => {
    while (next < items.length) await work(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, lane));
}

function loadRecords(dir) {
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.json') && !/\.(session|settings)\.json$/.test(f) && !['report.json', 'meta.json'].includes(f))
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')))
    .filter((r) => r && r.id && r.cell);
}

/**
 * A results directory's passes, oldest first. Each invocation adds one rather
 * than replacing the last, so a directory resumed with other flags still says
 * what produced each of its runs. A directory from before passes holds one
 * object, which becomes the first.
 */
function readPasses(dir) {
  const file = path.join(dir, 'meta.json');
  if (!fs.existsSync(file)) return [];
  const meta = JSON.parse(fs.readFileSync(file, 'utf8'));
  return Array.isArray(meta?.passes) ? meta.passes : [meta];
}

function addPass(dir, pass) {
  writeJson(path.join(dir, 'meta.json'), { passes: [...readPasses(dir), pass] });
}

/**
 * V0's runs from a stored directory, for a comparison that does not run V0
 * again: every one whose (backend, goal) this directory has no V0 run of, so
 * a fresh V0 run replaces the stored ones rather than mixing with them.
 */
function borrowedBaseline(records, from) {
  const own = new Set(records.filter((r) => r.variant === 'V0').map((r) => `${r.cell}\u0000${r.goal}`));
  return loadRecords(from)
    .filter((r) => r.variant === 'V0' && !own.has(`${r.cell}\u0000${r.goal}`))
    .map((r) => ({ ...r, source: from }));
}

function writeReport(dir, goals, { baselineFrom } = {}) {
  const passes = readPasses(dir);
  const from = baselineFrom ?? passes.findLast((p) => p.baselineFrom)?.baselineFrom;
  const own = loadRecords(dir);
  const records = from ? [...own, ...borrowedBaseline(own, path.resolve(from))] : own;
  const result = aggregate(records, goals);
  writeJson(path.join(dir, 'report.json'), { meta: { passes }, ...result, records });
  const flat = Object.fromEntries(passes.flatMap((pass, i) => Object.entries(pass)
    .map(([k, v]) => [passes.length > 1 ? `pass ${i + 1} ${k}` : k, typeof v === 'string' ? v : JSON.stringify(v)])));
  fs.writeFileSync(path.join(dir, 'report.md'), redact(markdown(result, { title: 'Planner eval', meta: flat })));
  return { records, result };
}

/** The goal files as the stored runs that carry no key hash were scored: as the bench was first committed. */
const LEGACY_GOALS_REF = '312cc3c1';

async function legacyKeyHashes(repo) {
  const listing = await run('git', ['ls-tree', '--name-only', LEGACY_GOALS_REF, 'bench/planner-eval/goals/'], { cwd: repo, timeoutMs: 30_000 });
  const hashes = new Map();
  if (listing.code !== 0) return hashes;
  for (const file of listing.out.split('\n').map((l) => l.trim()).filter((l) => l.endsWith('.json'))) {
    const shown = await run('git', ['show', `${LEGACY_GOALS_REF}:${file}`], { cwd: repo, timeoutMs: 30_000 });
    if (shown.code !== 0) continue;
    const goal = JSON.parse(shown.out);
    hashes.set(goal.id, keyHash(goal));
  }
  return hashes;
}

/** A stored run's files in a new directory: linked where the two share a file system, copied where not. */
function carry(from, to, name) {
  const src = path.join(from, name);
  if (!fs.existsSync(src)) return;
  const dest = path.join(to, name);
  fs.rmSync(dest, { force: true });
  try {
    fs.linkSync(src, dest);
  } catch {
    fs.copyFileSync(src, dest);
  }
}

/**
 * Every stored run scored again with the keys and metrics as they are now,
 * from the session file it kept. The rubric reviewer read the goal and its
 * key, so a review stands where the key hash it was made under still holds
 * and is made again where the key changed (or dropped, marked stale, with
 * --no-review). A stored timeout scored as a plan becomes the failed run it was.
 */
async function rescore(opts, goals) {
  const from = path.resolve(opts.rescore);
  const to = path.resolve(opts.out ?? `${from}-rescored`);
  if (to === from) throw new Error('--rescore writes into a new directory: give --out another path');
  fs.mkdirSync(to, { recursive: true });
  const legacy = await legacyKeyHashes(await repoRoot(HERE));
  const stored = loadRecords(from);
  const tally = { rescored: 0, kept: 0, reviewed: 0, stale: 0, failed: 0 };
  await pool(stored, opts.concurrency, async (old) => {
    for (const ext of ['session.json', 'screen.log', 'settings.json']) carry(from, to, `${old.id}.${ext}`);
    const goal = goals.find((g) => g.id === old.goal);
    const sessionFile = path.join(from, `${old.id}.session.json`);
    if (!goal || !old.metrics || !fs.existsSync(sessionFile)) {
      writeJson(path.join(to, `${old.id}.json`), old);
      tally.kept++;
      return;
    }
    const session = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    const driver = { turns: old.metrics.turns, wallMs: old.metrics.wallMs, stopped: old.metrics.stopped, approvalsAnswered: old.metrics.approvalsAnswered, resends: old.metrics.resends };
    const { metrics, keyChecks: checks } = score(goal, session, { driver });
    const hash = keyHash(goal);
    const error = old.error ?? stopError(driver.stopped, { timeoutMs: driver.wallMs ?? 0 });
    let rubric = old.rubric;
    let rubricStale = false;
    if (rubric && (old.keyHash ?? legacy.get(goal.id)) !== hash) {
      rubric = undefined;
      rubricStale = true;
    }
    if (rubricStale && opts.review && metrics.submitted && !error) {
      say(`${old.id}: reviewing the plan again under the changed key`);
      rubric = await reviewPlan(goal, planDigest(sessionParts(session).tasks), { model: opts.reviewModel, timeoutMs: opts.reviewTimeoutMs });
      rubricStale = false;
      tally.reviewed++;
    }
    const rest = Object.fromEntries(Object.entries(old).filter(([k]) => !['rubric', 'rubricStale', 'error'].includes(k)));
    const rec = {
      ...rest,
      keyHash: hash,
      metrics,
      keyChecks: checks,
      ...(rubric ? { rubric } : {}),
      ...(rubricStale ? { rubricStale: true } : {}),
      ...(error ? { error } : {}),
      rescoredFrom: old.keyHash ?? `${LEGACY_GOALS_REF} (legacy)`,
    };
    writeJson(path.join(to, `${old.id}.json`), rec);
    tally.rescored++;
    if (rubricStale) tally.stale++;
    if (error && !old.error) tally.failed++;
  });
  addPass(to, {
    mode: 'rescore',
    started: new Date().toISOString(),
    from,
    fromPasses: readPasses(from),
    keys: goals.map((g) => `${g.id} ${keyHash(g)}`).join(', '),
    review: opts.review ? `claude -p --model ${opts.reviewModel}, where a key changed` : 'off: changed keys leave their rubric stale',
    ...(opts.baselineFrom ? { baselineFrom: path.resolve(opts.baselineFrom) } : {}),
  });
  writeReport(to, goals);
  return { to, tally };
}

/** The mock provider, on a port the OS picks, for `--mock`. */
async function startMock() {
  const { port, child } = await start();
  return { port, stop: () => child.kill() };
}

async function harnessVersions(cells) {
  const versions = {};
  for (const bin of [...new Set(cells.map((c) => c.needs?.bin).filter(Boolean))]) {
    if (!onPath(bin)) continue;
    const r = await run(bin, ['--version'], { timeoutMs: 20_000 });
    versions[bin] = r.code === 0 ? r.out.trim().split('\n')[0].slice(0, 120) : `exit ${r.code}`;
  }
  return versions;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help || !opts.mode) {
    process.stdout.write(`${USAGE}\n`);
    return opts.help ? 0 : 2;
  }
  const goals = loadGoals();
  if (opts.mode === 'report') {
    const { records } = writeReport(path.resolve(opts.report), goals, { baselineFrom: opts.baselineFrom });
    say(`aggregated ${records.length} record(s) into ${path.join(opts.report, 'report.md')}`);
    return 0;
  }
  if (opts.mode === 'rescore') {
    const { to, tally } = await rescore(opts, goals);
    say(`re-scored ${tally.rescored} run(s) into ${to}: ${tally.reviewed} reviewed again, ${tally.stale} rubric(s) left stale, `
      + `${tally.failed} now failed (a timeout or lost TUI), ${tally.kept} kept as stored`);
    say(`report: ${path.join(to, 'report.md')}`);
    return 0;
  }
  const repo = await repoRoot(HERE);
  const mock = opts.mode === 'mock' ? await startMock() : null;
  try {
    const cells = mock ? [mockCell(mock.port, opts.mockPersona)] : CELLS;
    const runs = selectRuns(opts, { goals, cells });
    const skipped = [...new Set(runs.map((r) => r.cell))]
      .map((cell) => ({ cell: cell.id, missing: missingFor(cell, { env: process.env, onPath }) }))
      .filter((s) => s.missing.length);
    const runnable = runs.filter((r) => !skipped.some((s) => s.cell === r.cell.id));
    if (opts.list) {
      for (const r of runnable) process.stdout.write(`${r.id}\n`);
      for (const s of skipped) process.stdout.write(`skipped ${s.cell}: ${s.missing.join('; ')}\n`);
      return 0;
    }
    if (!onPath('script')) throw new Error('script(1) is not on PATH; the TUI driver needs it for a pseudo-terminal');
    if (runnable.length === 0) throw new Error(`no run this host can make${skipped.length ? `: ${skipped.map((s) => `${s.cell} (${s.missing.join('; ')})`).join(', ')}` : ''}`);

    const dir = path.resolve(opts.resume ?? opts.out ?? path.join(HERE, '.results', new Date().toISOString().replace(/[:.]/g, '-')));
    fs.mkdirSync(dir, { recursive: true });
    const done = new Set(loadRecords(dir).filter(isComplete).map((r) => r.id));
    const todo = runnable.filter((r) => !opts.resume || !done.has(r.id));

    // Every planner variable is set per run and the settings file is the run's own; the token and `.env` have no override.
    guardFiles([path.join(ORDEWELL_HOME, 'settings.json'), path.join(ORDEWELL_HOME, '.env')], {
      onRestore: (files) => say(`restored ${files.join(', ')}, which a run changed`),
    });

    const buildsDir = path.join(HERE, '.builds');
    const builds = {};
    if (mock) {
      if (!fs.existsSync(cliMain(repo))) throw new Error('--mock drives this checkout\'s build: run `npm run build` first');
      const here = { dir: repo, main: cliMain(repo), sha: await resolveRef(repo, 'HEAD'), mock: true };
      builds.baseline = here;
      builds.candidate = here;
    } else {
      const wanted = new Set(todo.map((r) => r.variant.build));
      const shas = { baseline: await resolveRef(repo, opts.baselineRef), candidate: await resolveRef(repo, opts.candidateRef) };
      // The baseline build also lends the target clones its node_modules, so it is built even when only V1 runs.
      for (const which of ['baseline', ...(wanted.has('candidate') ? ['candidate'] : [])]) {
        builds[which] = await ensureBuild({ repo, buildsDir, sha: shas[which], say });
      }
    }
    const targetSha = await resolveRef(repo, opts.baselineRef);
    const templatesDir = path.join(buildsDir, 'targets');
    const templates = {};
    for (const goal of goals) if (todo.some((r) => r.goal.id === goal.id)) templates[goal.id] = await ensureTemplate({ repo, templatesDir, sha: targetSha, goal });

    addPass(dir, {
      mode: opts.mode,
      started: new Date().toISOString(),
      baseline: `${opts.baselineRef} (${builds.baseline.sha.slice(0, 12)})`,
      candidate: builds.candidate ? `${opts.candidateRef} (${builds.candidate.sha.slice(0, 12)})` : 'not built',
      target: `${opts.baselineRef} (${targetSha.slice(0, 12)})`,
      variants: Object.values(VARIANTS).map((v) => `${v.id}: ${v.about}`).join('; '),
      surface: 'ordewell tui under script(1)',
      review: opts.review ? `claude -p --model ${opts.reviewModel}` : 'off',
      harnesses: await harnessVersions(cells),
      skipped: skipped.map((s) => `${s.cell} (${s.missing.join('; ')})`).join(', ') || 'none',
      goals: [...new Set(todo.map((r) => r.goal.id))].join(', '),
      runs: todo.length,
      timeouts: `${opts.timeoutMs / 1000}s, API planners ${opts.apiTimeoutMs / 1000}s`,
      ...(opts.baselineFrom ? { baselineFrom: path.resolve(opts.baselineFrom) } : {}),
    });

    const workRoot = fs.mkdtempSync(path.join(workParent(buildsDir), 'planner-eval-'));
    say(`${todo.length} run(s), ${opts.concurrency} at a time, into ${dir}`);
    let finished = 0;
    await pool(todo, opts.concurrency, async (spec) => {
      say(`${spec.id}: planning`);
      const rec = await record({ spec, builds, templates, opts, dir, workRoot });
      writeJson(path.join(dir, `${spec.id}.json`), rec);
      finished++;
      say(`${spec.id}: ${rec.error ? `error: ${rec.error}` : `${rec.metrics.stopped}, ${rec.metrics.taskCount} task(s)`} (${finished}/${todo.length})`);
    });
    if (!opts.keep) fs.rmSync(workRoot, { recursive: true, force: true });

    const { result } = writeReport(dir, goals, { baselineFrom: opts.baselineFrom });
    for (const v of result.verdicts) say(`${v.cell}: ${v.candidate} vs ${v.baseline}: ${v.result}`);
    say(`report: ${path.join(dir, 'report.md')}`);
    return 0;
  } finally {
    mock?.stop();
  }
}

main().then((code) => process.exit(code), (error) => {
  say(String(error?.stack ?? error));
  process.exit(1);
});
