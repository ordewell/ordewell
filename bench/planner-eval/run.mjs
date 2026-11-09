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
 *
 * See bench/planner-eval/README.md for the flags and what every metric means.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { aggregate, markdown } from './lib/aggregate.mjs';
import { ensureBuild, repoRoot, resolveRef, cliMain } from './lib/builds.mjs';
import {
  CELLS, HERE, MAX_DRIVER_TURNS, QUOTA, VARIANTS, goalText, loadGoals, missingFor, mockCell, parseArgs,
  runEnv, runSettings, selectRuns, substituteFor,
} from './lib/config.mjs';
import { guardFiles } from './lib/guard.mjs';
import { keyChecks } from './lib/keys.mjs';
import { planDigest, runMetrics, sessionParts } from './lib/metrics.mjs';
import { classifyTurn, daemonClient, newestSession, readToken, tokenPath } from './lib/observe.mjs';
import { freePort, onPath, run, sleep, until } from './lib/proc.mjs';
import { redactJson, redactor } from './lib/redact.mjs';
import { reviewPlan } from './lib/rubric.mjs';
import { cloneTarget, ensureTemplate } from './lib/target.mjs';
import { startTui } from './lib/tui.mjs';

const USAGE = `usage: node bench/planner-eval/run.mjs (--smoke | --full | --mock | --report <dir>) [options]

  --smoke                 G1 on claude-code/haiku, once per variant
  --full                  every goal, backend and variant, three times
  --mock                  offline dry run against bench/live/mock-provider.mjs, this checkout's build
  --report <dir>          aggregate the records in <dir> again; runs nothing

  --backend a,b           cells by id or prefix (claude-code, opencode/glm-5.3-flash, openrouter, cline ...)
  --goal g1,g4            goals by id
  --variant V0,V1         variants (V0 baseline + nudges, V1 candidate, V2 candidate + read meter)
  --repeats N             repeats per (goal, backend, variant)
  --concurrency N         runs at once (default 2)
  --timeout S             seconds a run may take before it is stopped (default 900)
  --candidate-ref REF     the build V1 and V2 use (default HEAD)
  --baseline-ref REF      the build V0 uses and every target is cut from (default 0ecc6412)
  --runners a,b           ORDEWELL_ENABLED_RUNNERS for every run (default: the cell's planner runner)
  --max-parallel N        ORDEWELL_MAX_PARALLEL for every run (default 4)
  --no-review             skip the rubric review
  --review-model M        the reviewer's model (default opus)
  --review-timeout S      seconds the reviewer may take (default 600)
  --with-optional         include the ACP cells (cline, copilot-cli, qwen-code, gemini-cli, cursor-agent)
  --mock-persona M        the mock provider's persona (default mock/interviewer)
  --out <dir>             results directory (default bench/planner-eval/.results/<stamp>)
  --resume <dir>          continue a results directory, skipping every run already recorded without an error
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

/** Drive one planning conversation to a plan, a stop or the deadline. */
async function drive({ tui, client, workspace, goal, variant, timeoutMs }) {
  const started = Date.now();
  const deadline = started + timeoutMs;
  let turns = 0;
  let sentAt = 0;
  let sawBusy = false;
  let session = null;
  let lastText = '';
  const send = async (text) => {
    sentAt = session ? sessionParts(session).history.length : 0;
    sawBusy = false;
    turns++;
    await tui.send(text);
  };
  await send(goalText(goal, variant));
  for (;;) {
    if (!tui.alive) return { stopped: 'tui exited', turns, session, lastText, wallMs: Date.now() - started };
    if (Date.now() > deadline) return { stopped: 'timeout', turns, session, lastText, wallMs: Date.now() - started };
    await sleep(POLL_MS);
    const meta = newestSession(await client.sessions(workspace).catch(() => []));
    if (!meta) continue;
    const next = await client.session(meta.id, workspace).catch(() => null);
    if (!next) continue;
    session = next;
    const turn = classifyTurn(session, { sentAt, sawBusy });
    if (turn.state === 'busy') {
      sawBusy = sawBusy || Boolean(session.plannerTurnId) || (session.conversation?.pendingTurns ?? []).length > 0;
      continue;
    }
    lastText = turn.text ?? '';
    if (turn.state === 'plan') return { stopped: 'plan submitted', turns, session, lastText, wallMs: Date.now() - started };
    if (turn.state === 'error') return { stopped: 'error', turns, session, lastText, wallMs: Date.now() - started };
    if (turns >= MAX_DRIVER_TURNS) return { stopped: 'turn limit', turns, session, lastText, wallMs: Date.now() - started };
    await send(turn.reply);
  }
}

/** Whether a run that ended without a plan ran out of its provider's quota. */
function quotaHit(outcome, screen) {
  if (outcome.stopped === 'plan submitted') return null;
  const said = outcome.stopped === 'error' || outcome.lastText.length < 600 ? outcome.lastText : '';
  const match = QUOTA.exec(said) ?? QUOTA.exec(screen.slice(-4000));
  return match ? (said || screen.slice(-400)).trim().slice(0, 300) : null;
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
    const outcome = await drive({ tui, client, workspace, goal: spec.goal, variant: spec.variant, timeoutMs: opts.timeoutMs });
    return { outcome, screen: tui.screen(), token };
  } finally {
    await tui.stop();
    // The TUI stops the daemon it owns; this covers a TUI that died before it could.
    await run(process.execPath, [build.main, 'stop', '--server', '--port', String(port)], { env, timeoutMs: 30_000 });
    if (!tokenExisted) fs.rmSync(tokenFile, { force: true });
    if (!opts.keep) fs.rmSync(workspace, { recursive: true, force: true });
  }
}

async function record({ spec, builds, templates, opts, dir, workRoot }) {
  const build = builds[spec.variant.build];
  const base = { id: spec.id, cell: spec.cell.id, variant: spec.variant.id, goal: spec.goal.id, repeat: spec.repeat, build: build.sha };
  let cell = spec.cell;
  let substitution;
  for (;;) {
    try {
      const { outcome, screen, token } = await planOnce({
        spec, cell, build, template: templates[spec.goal.id], modulesFrom: builds.baseline.mock ? null : builds.baseline.dir, opts, dir, workRoot,
      });
      const quota = quotaHit(outcome, screen);
      const fallback = quota && !substitution ? substituteFor(cell) : null;
      if (fallback && missingFor(fallback, { env: process.env, onPath }).length === 0) {
        say(`${spec.id}: quota hit on ${cell.model}; rerunning with ${fallback.model}`);
        substitution = { from: cell.model, to: fallback.model, reason: quota };
        cell = fallback;
        continue;
      }
      const session = outcome.session ?? {};
      fs.writeFileSync(path.join(dir, `${spec.id}.session.json`), `${redactJson(session, redactor(process.env, [token]))}\n`);
      const parts = sessionParts(session);
      const metrics = runMetrics(session, { driver: outcome, autoMerge: true });
      const checks = metrics.submitted ? keyChecks(spec.goal, parts.tasks, { researchLog: parts.researchLog }) : [];
      let rubric;
      if (metrics.submitted && opts.review) {
        say(`${spec.id}: reviewing the plan`);
        rubric = await reviewPlan(spec.goal, planDigest(parts.tasks), { model: opts.reviewModel, timeoutMs: opts.reviewTimeoutMs });
      }
      return {
        ...base,
        model: cell.model,
        metrics,
        keyChecks: checks,
        ...(rubric ? { rubric } : {}),
        ...(quota && !metrics.submitted ? { error: `quota: ${quota}` } : outcome.stopped === 'error' ? { error: outcome.lastText.slice(0, 300) } : {}),
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

function writeReport(dir, goals) {
  const records = loadRecords(dir);
  const meta = fs.existsSync(path.join(dir, 'meta.json')) ? JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')) : {};
  const result = aggregate(records, goals);
  writeJson(path.join(dir, 'report.json'), { meta, ...result, records });
  const flat = Object.fromEntries(Object.entries(meta).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]));
  fs.writeFileSync(path.join(dir, 'report.md'), redact(markdown(result, { title: 'Planner eval', meta: flat })));
  return { records, result };
}

/** The mock provider, on a port of its own, for `--mock`. */
async function startMock(repo) {
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(repo, 'bench', 'live', 'mock-provider.mjs'), '--port', String(port)], { stdio: 'ignore' });
  await until('the mock provider', 15_000, () => fetch(`http://127.0.0.1:${port}/v1/models`).then(() => true));
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
    const { records } = writeReport(path.resolve(opts.report), goals);
    say(`aggregated ${records.length} record(s) into ${path.join(opts.report, 'report.md')}`);
    return 0;
  }
  const repo = await repoRoot(HERE);
  const mock = opts.mode === 'mock' ? await startMock(repo) : null;
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
    const done = new Set(loadRecords(dir).filter((r) => !r.error).map((r) => r.id));
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
      // The baseline build also lends the target clones its node_modules, so it is built even when only V1/V2 run.
      for (const which of ['baseline', ...(wanted.has('candidate') ? ['candidate'] : [])]) {
        builds[which] = await ensureBuild({ repo, buildsDir, sha: shas[which], say });
      }
    }
    const targetSha = await resolveRef(repo, opts.baselineRef);
    const templatesDir = path.join(buildsDir, 'targets');
    const templates = {};
    for (const goal of goals) if (todo.some((r) => r.goal.id === goal.id)) templates[goal.id] = await ensureTemplate({ repo, templatesDir, sha: targetSha, goal });

    const meta = {
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
    };
    writeJson(path.join(dir, 'meta.json'), meta);

    const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'planner-eval-'));
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

    const { result } = writeReport(dir, goals);
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
