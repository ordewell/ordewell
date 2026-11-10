/**
 * What the bench runs: the backend matrix, the three variants, the goals, and
 * the command line that filters them. Pure apart from `loadGoals`, which reads
 * the goal files, so `planner-eval.test.mjs` proves the matrix and the flags.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const HERE = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** The commit every target clone and the V0 build are cut from. */
export const BASELINE_REF = '0ecc6412';

/** V0's nudges, appended to each goal verbatim, one per paragraph. */
export const NUDGES = [
  'Parallelize as much as possible.',
  'Keep your context as clear as possible: make use of research tasks to surface to you only the relevant information to make decisions.',
];

export const VARIANTS = {
  V0: { id: 'V0', build: 'baseline', nudges: true, env: {}, about: `Ordewell at ${BASELINE_REF}, goal plus the two nudges` },
  V1: { id: 'V1', build: 'candidate', nudges: false, env: {}, about: 'the candidate ref, goal alone' },
  V2: { id: 'V2', build: 'candidate', nudges: false, env: { ORDEWELL_PLANNER_READ_METER: '1' }, about: 'V1 with ORDEWELL_PLANNER_READ_METER=1' },
};

/** The answer to a clarifying question and the confirmation of an outline, verbatim. */
export const ANSWER = 'No preference: decide yourself, note your assumption, and continue.';
export const CONFIRM = 'Confirmed. Submit the plan.';
export const MAX_DRIVER_TURNS = 4;

/**
 * The backend matrix. A cell is one planner: `provider` is what AI_PROVIDER
 * names (a runner id for a harness planner, a vendor for an API one), `model`
 * what ORCHESTRATOR_MODEL and the settings' `plannerModels` hold. `needs`
 * lists what the host must have for the cell to run: a binary on PATH or a
 * variable in the environment; a cell missing one is recorded as skipped.
 * `fallback` is the model an OpenCode Go cell reruns with when its quota runs
 * out, through OpenRouter, with the substitution recorded.
 *
 * Every built-in harness Ordewell drives can plan (CONNECTORS in
 * packages/core/src/services/harness/connectors.ts; the ACP ones by their
 * profile's `roles.plans`), so each has a cell; the ACP cells are `optional`,
 * left out of `--full` unless asked for by `--backend` or `--with-optional`,
 * since their models are each account's own.
 */
export const CELLS = [
  { id: 'claude-code/haiku', provider: 'claude-code', model: 'haiku', needs: { bin: 'claude' } },
  { id: 'codex/gpt-6-luna', provider: 'codex', model: 'gpt-6-luna', needs: { bin: 'codex' } },
  {
    id: 'opencode/deepseek-v4.1-flash', provider: 'opencode', model: 'opencode-go/deepseek-v4.1-flash', needs: { bin: 'opencode' },
    fallback: { model: 'openrouter/deepseek/deepseek-v4.1-flash', needs: { env: 'OPENROUTER_API_KEY' } },
  },
  {
    id: 'opencode/glm-5.3-flash', provider: 'opencode', model: 'opencode-go/glm-5.3-flash', needs: { bin: 'opencode' },
    fallback: { model: 'openrouter/z-ai/glm-5.3-flash', needs: { env: 'OPENROUTER_API_KEY' } },
  },
  { id: 'openrouter/deepseek-v4.1-flash', provider: 'openrouter', model: 'deepseek/deepseek-v4.1-flash', needs: { env: 'OPENROUTER_API_KEY' } },
  { id: 'openrouter/glm-5.3-flash', provider: 'openrouter', model: 'z-ai/glm-5.3-flash', needs: { env: 'OPENROUTER_API_KEY' } },
  // ACP harnesses with their own default model: a foreign slug is dropped by
  // Cline while its catalog is cold (BaseConfig.plannerChoiceFor), so none is named.
  { id: 'cline/default', provider: 'cline', model: '', needs: { bin: 'cline' }, optional: true },
  { id: 'copilot-cli/default', provider: 'copilot-cli', model: '', needs: { bin: 'copilot' }, optional: true },
  { id: 'qwen-code/default', provider: 'qwen-code', model: '', needs: { bin: 'qwen' }, optional: true },
  { id: 'gemini-cli/default', provider: 'gemini-cli', model: '', needs: { bin: 'gemini' }, optional: true },
  { id: 'cursor-agent/default', provider: 'cursor-agent', model: '', needs: { bin: 'cursor-agent' }, optional: true },
];

/** The offline cell `--mock` runs against bench/live/mock-provider.mjs, whose persona the model names. */
export const mockCell = (port, persona = 'mock/interviewer') => ({
  id: `mock/${persona.replace(/^mock\//, '')}`,
  provider: 'openrouter',
  model: persona,
  needs: {},
  env: { OPENROUTER_BASE_URL: `http://127.0.0.1:${port}/v1`, OPENROUTER_API_KEY: 'mock-key' },
});

/** A usage limit or exhausted quota, as OpenCode and the providers behind it word one. */
export const QUOTA = /\b(quota|usage limit|rate[- ]limit(ed)?|insufficient (credits?|balance|funds)|credits? (exhausted|exceeded)|limit (reached|exceeded)|too many requests|429)\b/i;

/**
 * The quota text of a run that ended without a plan, or null. Only what the
 * runner or provider reported counts: the turn's error event, or the output of
 * a TUI that died with a non-zero status. The planner's own prose never does:
 * a goal about token usage says 'usage limit' without any provider having.
 */
export function quotaOf({ stopped, lastText = '', exitCode = 0, signal = null, screen = '' }) {
  if (stopped === 'plan submitted') return null;
  const report = stopped === 'error' ? lastText : stopped === 'tui exited' && (exitCode || signal) ? screen.slice(-4000) : '';
  const match = QUOTA.exec(report);
  return match ? report.trim().slice(-400) : null;
}

/** The cell an OpenCode Go cell becomes when its quota runs out, or null when it has no fallback. */
export function substituteFor(cell) {
  if (!cell.fallback) return null;
  return { ...cell, model: cell.fallback.model, needs: { ...cell.needs, ...cell.fallback.needs }, fallback: undefined, substitutedFrom: cell.model };
}

/** The goal text a variant sends: V0 appends the nudges, the others send it as written. */
export function goalText(goal, variant) {
  return variant.nudges ? [goal.goal, ...NUDGES].join('\n\n') : goal.goal;
}

export function loadGoals(dir = path.join(HERE, 'goals')) {
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
}

/**
 * The test commands a planner may run in its clone without asking, added to
 * the built-in planner allowlist (ADR-0026) through ORDEWELL_APPROVAL_ALLOW.
 * A command no rule covers runs sealed, and a sealed run is stopped at a
 * minute, which a cold vitest start in this repository can take: G4 asks the
 * planner to see a test fail, so the bench lets it. Each entry is a binary
 * and its leading words, as `plannerAllowlist.ts` reads a rule.
 */
export const TEST_COMMANDS = [
  'npx vitest', 'npx vitest run', 'npx vitest run *', 'npx vitest *',
  'npm test', 'npm run test', 'npm run test *', 'npm exec vitest',
  'node_modules/.bin/vitest', './node_modules/.bin/vitest', 'vitest', 'vitest run', 'vitest run *',
];

/**
 * The environment one planning run's daemon and TUI start with. It starts
 * from the bench's own, since HOME must stay real for every harness's login,
 * and then sets every planner variable the CLI would otherwise fill from
 * `~/.ordewell/.env` (which fills only what is unset, an empty value
 * included), so the user's own `.env` decides nothing.
 */
export function runEnv(base, { cell, variant, settingsPath, maxParallel, enabledRunners }) {
  const env = { ...base };
  // A vendor key is handed only to the cell that plans through it.
  const usesOpenRouter = cell.provider === 'openrouter' || /^openrouter\//.test(cell.model);
  if (!usesOpenRouter) delete env.OPENROUTER_API_KEY;
  delete env.ORDEWELL_PLANNER_READ_METER;
  delete env.NODE_OPTIONS;
  return {
    ...env,
    AI_PROVIDER: cell.provider,
    ORCHESTRATOR_MODEL: cell.model,
    ORDEWELL_PLANNER_EFFORT: '',
    ORDEWELL_SUBAGENT_MODEL: '',
    ORDEWELL_MAX_PARALLEL: String(maxParallel),
    ORDEWELL_ENABLED_RUNNERS: enabledRunners.join(','),
    ORDEWELL_SETTINGS_PATH: settingsPath,
    ORDEWELL_NO_VERSION_CHECK: '1',
    ORDEWELL_APPROVAL_ALLOW: TEST_COMMANDS.join(','),
    ...(cell.env ?? {}),
    ...variant.env,
  };
}

/** The settings file a run plans under: nothing runs by itself, and a gate merges by itself. */
export function runSettings({ cell, enabledRunners }) {
  return {
    autorun: false,
    mergeAtGatesAutomatically: true,
    enabledRunners,
    ...(cell.model ? { plannerModels: { [cell.provider]: { model: cell.model } } } : {}),
  };
}

const FLAG_VALUES = new Set(['--backend', '--goal', '--variant', '--repeats', '--concurrency', '--timeout', '--candidate-ref',
  '--baseline-ref', '--resume', '--out', '--max-parallel', '--runners', '--review-model', '--review-timeout', '--mock-persona', '--report',
  '--rescore', '--baseline-from', '--api-timeout']);
const FLAG_SWITCHES = new Set(['--smoke', '--full', '--mock', '--no-review', '--with-optional', '--keep', '--list', '--help']);

const list = (v) => (v === undefined ? undefined : String(v).split(',').map((s) => s.trim()).filter(Boolean));

/** The command line, parsed. Throws on a flag it does not know, so a typo cannot widen a run. */
export function parseArgs(argv) {
  const raw = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const [name, inline] = a.includes('=') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, undefined];
    if (FLAG_SWITCHES.has(name)) raw[name] = true;
    else if (FLAG_VALUES.has(name)) {
      const value = inline ?? argv[++i];
      if (value === undefined || value.startsWith('--')) throw new Error(`${name} needs a value`);
      raw[name] = value;
    } else throw new Error(`unknown argument: ${a}`);
  }
  const mode = raw['--smoke'] ? 'smoke' : raw['--full'] ? 'full' : raw['--mock'] ? 'mock' : raw['--report'] ? 'report' : raw['--rescore'] ? 'rescore' : null;
  const positive = (name, fallback) => {
    if (raw[name] === undefined) return fallback;
    const n = Number(raw[name]);
    if (!Number.isInteger(n) || n < 1) throw new Error(`${name} must be a whole number, 1 or more`);
    return n;
  };
  const timeout = positive('--timeout', 900);
  return {
    mode,
    help: Boolean(raw['--help']),
    list: Boolean(raw['--list']),
    backends: list(raw['--backend']),
    goals: list(raw['--goal']),
    variants: list(raw['--variant']),
    repeats: positive('--repeats', mode === 'full' ? 3 : 1),
    concurrency: positive('--concurrency', 2),
    timeoutMs: timeout * 1000,
    apiTimeoutMs: positive('--api-timeout', 2 * timeout) * 1000,
    candidateRef: raw['--candidate-ref'] ?? 'HEAD',
    baselineRef: raw['--baseline-ref'] ?? BASELINE_REF,
    resume: raw['--resume'],
    out: raw['--out'],
    report: raw['--report'],
    rescore: raw['--rescore'],
    baselineFrom: raw['--baseline-from'],
    maxParallel: positive('--max-parallel', 4),
    runners: list(raw['--runners']),
    review: !raw['--no-review'] && !raw['--mock'],
    reviewModel: raw['--review-model'] ?? 'opus',
    reviewTimeoutMs: positive('--review-timeout', 600) * 1000,
    mockPersona: raw['--mock-persona'] ?? 'mock/interviewer',
    withOptional: Boolean(raw['--with-optional']),
    keep: Boolean(raw['--keep']),
  };
}

const matches = (wanted, id) => !wanted || wanted.some((w) => w === id || id.startsWith(`${w}/`) || id.split('/')[0] === w || id.toLowerCase().startsWith(w.toLowerCase()));

/**
 * The runs a mode asks for, as (cell, variant, goal, repeat) in the order they
 * start. `--smoke` is G1 on claude-code/haiku once per variant; `--full` every
 * goal, cell and variant, three times; the filters narrow either.
 */
export function selectRuns(opts, { goals, cells = CELLS }) {
  const smoke = opts.mode === 'smoke';
  const pickedCells = cells.filter((c) => (opts.backends ? matches(opts.backends, c.id) : smoke ? c.id === 'claude-code/haiku' : !c.optional || opts.withOptional || opts.mode === 'mock'));
  const pickedGoals = goals.filter((g) => (opts.goals ? opts.goals.some((w) => w.toLowerCase() === g.id) : smoke || opts.mode === 'mock' ? g.id === 'g1' : true));
  const pickedVariants = Object.values(VARIANTS).filter((v) => !opts.variants || opts.variants.includes(v.id));
  const runs = [];
  for (let repeat = 1; repeat <= opts.repeats; repeat++) {
    for (const goal of pickedGoals) {
      for (const cell of pickedCells) {
        for (const variant of pickedVariants) runs.push({ id: runId(cell, variant, goal, repeat), cell, variant, goal, repeat });
      }
    }
  }
  return runs;
}

export const runId = (cell, variant, goal, repeat) => `${goal.id}--${cell.id.replace(/[^A-Za-z0-9.-]+/g, '_')}--${variant.id}--r${repeat}`;

/**
 * How long one run of `cell` may plan. An API planner reads through
 * OpenRouter, one round trip per tool call, and the stored runs show it
 * taking longest of every backend, so it gets a limit of its own rather than
 * having its slow runs scored as failures of the planner.
 */
export const timeoutFor = (cell, opts) => (cell.provider === 'openrouter' && !cell.id.startsWith('mock/') ? opts.apiTimeoutMs : opts.timeoutMs);

/** What a cell lacks on this host: a binary not on PATH, a variable not set. Empty when it can run. */
export function missingFor(cell, { env, onPath }) {
  const missing = [];
  if (cell.needs?.bin && !onPath(cell.needs.bin)) missing.push(`${cell.needs.bin} is not on PATH`);
  if (cell.needs?.env && !env[cell.needs.env]) missing.push(`${cell.needs.env} is not set`);
  return missing;
}
