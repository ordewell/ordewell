#!/usr/bin/env node
/**
 * Live smoke check of the built-in `ordewell` runner (ADR-0070), one task per
 * dialect. Run by hand, or as a script task:
 *
 *   npm run build -w packages/core && node bench/live/runner-smoke.mjs
 *
 * It SPENDS API CREDIT, a few cents a dialect, so no CI job and no `test:bench`
 * run starts it; only its offline test (runner-smoke.test.mjs) does, against
 * bench/live/mock-provider.mjs.
 *
 * For each dialect with a key it makes a throwaway git repository holding a
 * tiny project with one failing test and a one-line fix, runs one task on the
 * runner through a real in-process session, and reads the verdict from the
 * session and the usage from the runner's transcript. Keys come the way the
 * daemon gets them: ~/.ordewell/.env fills what the shell did not export.
 *
 *   ORDEWELL_SMOKE_MODELS  `<provider>:<model>[,…]`: run exactly these, instead
 *                          of each dialect's default model
 *   ORDEWELL_SMOKE_TIMEOUT_MS  per task, default 300000
 *   <PROVIDER>_API_KEY, <PROVIDER>_BASE_URL  as for the daemon (OPENAI_API_KEY,
 *                          ANTHROPIC_API_KEY, GEMINI_API_KEY, OPENROUTER_API_KEY…)
 *
 * Exit 0 when every run that had a key passed; a dialect without a key is
 * UNVERIFIED, never a pass. Caching counts as checked only where the largest
 * prompt exceeded the provider's minimum cacheable prefix and a second step
 * could have read it; then a run that never read or wrote the cache fails.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO = path.resolve(import.meta.dirname, '../..');

/** The cheap default per dialect, and the provider that stands for it. */
export const DEFAULTS = [
  { dialect: 'chat-completions', model: 'openrouter:openai/gpt-4.1-mini' },
  { dialect: 'responses', model: 'openai:gpt-5-mini' },
  { dialect: 'anthropic-messages', model: 'anthropic:claude-haiku-5-5' },
  { dialect: 'gemini', model: 'google:gemini-2.5-flash' },
];

// Every other vendor speaks Chat Completions (services/model/dialects.ts).
const NATIVE = { anthropic: 'anthropic-messages', openai: 'responses', google: 'gemini' };
export const dialectOfProvider = (provider) => NATIVE[provider] ?? 'chat-completions';

/**
 * The smallest prompt prefix a provider caches. Below it a missing cache hit
 * says nothing, so the run reports UNVERIFIED instead of a verdict on caching.
 */
export function minCacheableTokens(provider, model) {
  if (provider === 'anthropic') return /haiku/i.test(model) ? 4096 : /opus|fable|mythos/i.test(model) ? 4096 : 2048;
  if (provider === 'google') return /pro/i.test(model) ? 2048 : 1024;
  return 1024;
}

/** `.env` lines the way the CLI reads them; a variable already exported wins. */
export function loadEnvFile(file, env = process.env) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim().replace(/^export\s+/, '');
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    const quote = value[0];
    if (value.length >= 2 && (quote === '"' || quote === "'") && value.endsWith(quote)) value = value.slice(1, -1);
    if (key && env[key] === undefined) env[key] = value;
  }
}

function git(cwd, ...args) {
  const env = { ...process.env };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_PREFIX']) delete env[k];
  return execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function makeFixture(parent) {
  const root = fs.mkdtempSync(path.join(parent, 'fixture-'));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Smoke');
  git(root, 'config', 'user.email', 'smoke@example.com');
  git(root, 'config', 'commit.gpgsign', 'false');
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'add.mjs'), 'export const add = (a, b) => a - b;\n');
  fs.writeFileSync(path.join(root, 'test.mjs'), "import { add } from './src/add.mjs';\nif (add(2, 3) === 5) console.log('pass');\nelse { console.log('fail'); process.exit(1); }\n");
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'initial');
  return fs.realpathSync.native(root);
}

/** Every usage line of the transcripts the runner wrote under `dir`, summed. */
function readUsage(dir) {
  const files = [];
  const walk = (d) => {
    for (const entry of fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }) : []) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === 'transcript.jsonl') files.push(full);
    }
  };
  walk(dir);
  const total = { steps: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: undefined, maxInput: 0, anyCache: false };
  for (const file of files) {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      if (entry.kind !== 'usage') continue;
      const u = entry.usage ?? {};
      total.steps += 1;
      total.input += u.inputTokens ?? 0;
      total.output += u.outputTokens ?? 0;
      total.cacheRead += u.cacheReadTokens ?? 0;
      total.cacheWrite += u.cacheWriteTokens ?? 0;
      total.maxInput = Math.max(total.maxInput, u.inputTokens ?? 0);
      if ((u.cacheReadTokens ?? 0) > 0 || (u.cacheWriteTokens ?? 0) > 0) total.anyCache = true;
      if (u.cost && typeof u.cost.amount === 'number') total.cost = (total.cost ?? 0) + u.cost.amount;
    }
  }
  return total;
}

/** Whether the fix landed on the integration branch and the project's test passes there. */
function fixHolds(root, branch, scratch) {
  const out = fs.mkdtempSync(path.join(scratch, 'check-'));
  fs.mkdirSync(path.join(out, 'src'));
  for (const file of ['src/add.mjs', 'test.mjs']) fs.writeFileSync(path.join(out, file), git(root, 'show', `${branch}:${file}`) + '\n');
  return spawnSync(process.execPath, ['test.mjs'], { cwd: out, encoding: 'utf8' }).status === 0;
}

async function runOne(core, testing, { provider, model }, scratch, timeoutMs) {
  const root = makeFixture(scratch);
  const ordewellId = `${provider}:${model}`;
  const tasks = [
    core.createTask({
      id: 't', order: 1, title: 'Fix add',
      prompt: 'add() in src/add.mjs subtracts instead of adding. Make `node test.mjs` pass by fixing it, run the test to confirm, then call task_complete.',
      assignedRunner: 'ordewell', assignedModel: { modelId: ordewellId, modelLabel: model }, taskMode: 'full',
    }),
  ];
  const config = testing.fakeConfig({ aiProvider: provider, worktreeIsolation: true });
  const session = core.createSession({
    config, registry: new core.RunnerRegistry(), runner: new core.StructuredRunner(),
    notifications: { info() {}, warn() {}, error() {}, async confirm() { return undefined; } },
    workspaceRoot: () => root, fsAdapter: testing.fakeFileSystem(), broadcast: () => undefined,
    modelResolver: new core.ModelResolver(new core.RunnerRegistry(), config, { execImpl: async () => ({ stdout: '' }) }),
    settings: () => ({ run: { ...core.RUN_SETTINGS_DEFAULTS, supervisorLevel: 'off' } }),
    sessionId: 'runner-smoke', saveSession: core.saveSession, openTaskLog: core.openTaskLog, leaseHost: new core.LeaseHost(),
    isolation: core.createWorktreeIsolation({ resolvePath: async () => process.env.PATH ?? '', config }),
  });
  session.loadPlan({ tasks, runners: ['ordewell'], status: 'approved', generatedAt: new Date().toISOString() }, 'fix add', root, { sessionId: 'runner-smoke' });
  try {
    await session.execute({ command: 'run_plan' }, { kind: 'user' });
    const deadline = Date.now() + timeoutMs;
    while (/approved|pending|in_progress|queued/.test(session.planTasks[0].status) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
    }
    const task = session.planTasks[0];
    const reasons = [];
    if (/approved|pending|in_progress|queued/.test(task.status)) reasons.push(`still ${task.status} after ${timeoutMs} ms`);
    else if (task.verdict?.outcome !== 'pass' || task.status !== 'completed') {
      reasons.push(`verdict ${task.verdict?.outcome ?? 'none'}, status ${task.status}${task.verdict?.reason ? `: ${String(task.verdict.reason).slice(0, 200)}` : ''}`);
    } else {
      const branch = session.planState?.isolation?.run.repos[0]?.integrationBranch;
      if (!branch) reasons.push('no integration branch');
      else if (!fixHolds(root, branch, scratch)) reasons.push('task_complete reported done but the test does not pass on the integration branch');
    }
    return { reasons, ...(reasons.length > 0 ? { detail: failureDetail(session, task.id) } : {}) };
  } finally {
    session.destroy();
    await session.gone;
  }
}

/** How many of a failed task's last log events the report shows. */
const DETAIL_EVENTS = 12;

/**
 * Why a run failed, read before the session and its scratch home are gone:
 * the runner's errors (the provider's status and message), what waits on a
 * person, and the tail of the last attempt's log. Keys are redacted again,
 * though the runner already hides the ones it holds.
 */
export function failureDetail(session, taskId) {
  const out = [];
  try {
    const attempts = session.taskLogAttempts(taskId);
    const events = attempts.length > 0 ? session.taskLog(taskId, attempts[attempts.length - 1]) : [];
    for (const e of events) if (e.type === 'error') out.push(`runner error: ${e.message}`);
    for (const esc of session.escalations()) if (esc.task?.id === taskId) out.push(`escalation (${esc.kind}): ${esc.reason}`);
    out.push(`log tail (attempt ${attempts[attempts.length - 1] ?? 'none'}, ${events.length} events):`);
    for (const e of events.slice(-DETAIL_EVENTS)) out.push(`  ${JSON.stringify(e).slice(0, 400)}`);
  } catch (error) {
    out.push(`could not read the task log: ${error instanceof Error ? error.message : String(error)}`);
  }
  return out.map(redactKeys);
}

const redactKeys = (text) => text.replace(/\b(sk-[a-z]{2,8}-)[\w-]{8,}/gi, '$1…').replace(/\b(AIza)[\w-]{20,}/g, '$1…');

function fmtCost(cost) {
  return cost === undefined ? 'cost n/a' : `cost $${cost.toFixed(5)}`;
}

async function main() {
  // The daemon's order: what the shell exported wins, ~/.ordewell/.env fills the rest.
  const corePath = path.join(REPO, 'packages/core/dist/index.mjs');
  if (!fs.existsSync(corePath)) {
    console.error('packages/core/dist is missing: run `npm run build -w packages/core` first.');
    return 2;
  }
  const core = await import(pathToFileURL(corePath).href);
  const testing = await import(pathToFileURL(path.join(REPO, 'packages/core/dist/testing.mjs')).href);
  loadEnvFile(path.join(core.globalDataDir(), '.env'));

  const requested = (process.env.ORDEWELL_SMOKE_MODELS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const plan = requested.length > 0
    ? requested.map((spec) => {
      const colon = spec.indexOf(':');
      if (colon < 1 || colon === spec.length - 1) throw new Error(`ORDEWELL_SMOKE_MODELS entry "${spec}" is not <provider>:<model>`);
      const provider = spec.slice(0, colon);
      return { dialect: dialectOfProvider(provider), provider, model: spec.slice(colon + 1) };
    })
    : DEFAULTS.map(({ dialect, model }) => ({ dialect, provider: model.slice(0, model.indexOf(':')), model: model.slice(model.indexOf(':') + 1) }));
  const timeoutMs = Number(process.env.ORDEWELL_SMOKE_TIMEOUT_MS) || 300_000;

  const lines = [];
  const failures = [];
  // The run's own home: the runner's transcripts land in it, not in the user's
  // ~/.ordewell, and the usage read back is only this run's.
  const scratch = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-runner-smoke-')));
  const realEnv = { ...process.env };
  const homeDir = path.join(scratch, 'home');
  fs.mkdirSync(homeDir);
  try {
    for (const entry of plan) {
      const label = `${entry.dialect.padEnd(18)} ${entry.provider}:${entry.model}`;
      const meta = core.getProviderMeta(entry.provider);
      if (!meta) { lines.push(`FAIL        ${label}  unknown provider "${entry.provider}"`); failures.push(`${label}: unknown provider`); continue; }
      const vars = [meta.apiKeyEnvVar, ...meta.detectEnvVars].filter(Boolean);
      if (!vars.some((v) => realEnv[v]?.trim())) {
        lines.push(`UNVERIFIED  ${label}  no key: set ${meta.apiKeyEnvVar}`);
        continue;
      }
      process.env.HOME = homeDir;
      process.env.USERPROFILE = homeDir;
      const started = Date.now();
      let result;
      try {
        result = await runOne(core, testing, entry, scratch, timeoutMs);
      } catch (error) {
        result = { reasons: [`threw: ${error instanceof Error ? error.message : String(error)}`] };
      }
      const usage = readUsage(homeDir);
      fs.rmSync(path.join(homeDir, '.ordewell'), { recursive: true, force: true });
      const min = minCacheableTokens(entry.provider, entry.model);
      let cache;
      if (usage.steps >= 2 && usage.maxInput > min) {
        cache = usage.anyCache ? 'cache ok' : `cache MISSING (prompt reached ${usage.maxInput} > ${min})`;
        if (!usage.anyCache && result.reasons.length === 0) result.reasons.push(`prompt reached ${usage.maxInput} tokens (minimum cacheable ${min}) but the cache was never read or written`);
      } else {
        cache = `cache UNVERIFIED (largest prompt ${usage.maxInput} <= ${min} or fewer than 2 steps)`;
      }
      if (usage.steps === 0 && result.reasons.length === 0) result.reasons.push('no usage was recorded in the transcript');
      const ok = result.reasons.length === 0;
      lines.push(`${ok ? 'PASS' : 'FAIL'}${ok ? '        ' : '        '}${label}  steps ${usage.steps}  in ${usage.input}  out ${usage.output}  cache-read ${usage.cacheRead}  cache-write ${usage.cacheWrite}  ${fmtCost(usage.cost)}  ${cache}  ${((Date.now() - started) / 1000).toFixed(1)}s`);
      if (!ok) {
        failures.push(`${label}: ${result.reasons.join('; ')}`);
        lines.push(`            reason: ${result.reasons.join('; ')}`);
        for (const line of result.detail ?? []) lines.push(`            ${line}`);
      }
    }
    if (requested.length > 0) {
      const covered = new Set(plan.map((p) => p.dialect));
      for (const d of DEFAULTS) if (!covered.has(d.dialect)) lines.push(`UNVERIFIED  ${d.dialect.padEnd(18)} not requested by ORDEWELL_SMOKE_MODELS`);
    }
  } finally {
    Object.assign(process.env, { HOME: realEnv.HOME, USERPROFILE: realEnv.USERPROFILE });
    if (realEnv.HOME === undefined) delete process.env.HOME;
    if (realEnv.USERPROFILE === undefined) delete process.env.USERPROFILE;
    fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }

  console.log(lines.join('\n'));
  if (failures.length > 0) {
    console.error(`\nFAILED: ${failures.join(' | ')}`);
    return 1;
  }
  if (!lines.some((l) => l.startsWith('PASS'))) {
    console.error('\nNothing ran: no dialect had a key, so nothing is verified.');
    return 1;
  }
  console.log('\nEvery dialect with a key passed. UNVERIFIED lines were not checked.');
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().then((code) => process.exit(code), (error) => { console.error(error instanceof Error ? error.message : error); process.exit(2); });
}
