// The Commit0 comparison's logic, apart from the docker calls that drive.mjs
// makes: what the protocol fixes, how each check judges what it saw, and how a
// run's record is read back. Everything here is pure, so its tests need no
// engine, no key and no network.

import fs from 'node:fs';
import path from 'node:path';

/** The model both arms run, in Ordewell's `<provider>:<model>` form. */
export const PROVIDER = 'openrouter';
export const PROVIDER_MODEL = 'deepseek/deepseek-v4.1-flash';
export const MODEL_ID = `${PROVIDER}:${PROVIDER_MODEL}`;
export const MODEL_LABEL = 'DeepSeek V4.1 Flash';

/**
 * The built-in runner both arms run on: Ordewell's own loop on the protocol's
 * provider, whose runner id is the provider's (ADR-0070, providerRunners.ts).
 * The one id it had before, `ordewell`, is moved onto a provider's as a plan
 * is read, so a plan still naming it no longer holds the runner fixed.
 */
export const RUNNER = PROVIDER;

/**
 * The window the runner assumes for a model no listing states
 * (core's DEFAULT_MODEL_INFO.contextWindow). A run on it compacts a
 * million-token model at a fraction of what it holds, so meeting it is a
 * failed check, never a value to record and go on with.
 */
export const FALLBACK_WINDOW = 32_000;

/** The PR 177 merge (the built-in runner) every result names, and the checkout must contain. */
export const PR177_MERGE = '3c4ad79fb4bbde91872693ae18c000c43d9af277';

export const WALL_CAP_MS = 3 * 60 * 60 * 1000;

/**
 * Per-run spend caps. B's covers its planner turn as well as its tasks, which
 * is why it is larger: the spend is the key's, whichever caller made it.
 */
export const ARMS = Object.freeze({
  A: Object.freeze({ id: 'A', capUsd: 2.5, label: 'one hand-written task, no planner' }),
  B: Object.freeze({ id: 'B', capUsd: 5.5, label: 'ordewell plan, run, merge' }),
});

/**
 * Both arms take the same step limit. The default (200 per attempt) would be
 * the binding cap on A's one long task while B's several tasks each get 200,
 * so it would measure the limit, not the arms; set high, the wall-clock and
 * spend caps bind instead.
 */
export const STEP_LIMIT = 1000;

/**
 * The built-in runner's modes (core's ordewell.manifest.ts). A task in any
 * other mode, such as createTask's default 'build', is held at start as one
 * the runner cannot take, so the run spends nothing until the wall-clock cap.
 */
export const RUNNER_MODES = Object.freeze(['full', 'guarded', 'read-only']);
/** Arm A's one task runs in the autonomous mode, the one ModeResolver gives B's planned tasks under autonomousMode. */
export const ARM_A_MODE = 'full';

/**
 * How long `ordewell run` may go without one model call before the watchdog
 * calls it stuck: a started attempt calls the model within seconds, so this
 * is many times the slowest first reply, and far short of the wall-clock cap.
 */
export const NO_START_MS = 10 * 60 * 1000;

/** The one host a run may reach; a CONNECT to any other is refused at the gateway. */
export const EGRESS_ALLOW = Object.freeze(['openrouter.ai']);

/** Hosts the egress check expects refused: the package indexes, the forge, and models.dev. */
export const EGRESS_DENIED_PROBES = Object.freeze([
  'https://pypi.org/simple/',
  'https://files.pythonhosted.org/',
  'https://github.com/',
  'https://models.dev/api.json',
]);
/** The listing is free and needs no key, so it proves the way out without spending. */
export const EGRESS_ALLOWED_PROBES = Object.freeze(['https://openrouter.ai/api/v1/models']);

/** The port core's egress gateway listens on (egressSidecar.ts, EGRESS_PORT). */
export const EGRESS_PORT = 3128;

/**
 * Core's egress gateway program, read from its source: core does not export
 * it, and running the very program a container task's gateway runs is the
 * point, so a copy here could drift from it unseen.
 */
export function extractEgressEntry(source) {
  const m = /export const EGRESS_ENTRY = String\.raw`([\s\S]*?)`;/.exec(source);
  if (!m) throw new Error('EGRESS_ENTRY not found in egressSidecar.ts: core moved it');
  return m[1];
}

export const NETWORK_MARKER = 'network';

const PLACEHOLDER = /^<.*>$/;

/**
 * A library entry as the driver needs it: the image Commit0 built for it and
 * the dataset's fields. Defaults fill what Commit0's images share.
 */
export function validateLibrary(raw) {
  if (typeof raw !== 'object' || raw === null) throw new Error('a library entry must be an object');
  const lib = {
    workdir: '/testbed',
    networkMarker: NETWORK_MARKER,
    ...raw,
  };
  // Commit0's images install into a venv in the workdir that `docker exec` puts on no PATH: a bare `python` has no pytest.
  if (lib.testCmd === undefined && typeof lib.workdir === 'string') lib.testCmd = `${lib.workdir.replace(/\/+$/, '')}/${VENV_DIR}/bin/python -m pytest`;
  // The leak probe imports with the interpreter the tests run under, which a venv's PATH may decide.
  lib.python ??= lib.testCmd.trim().split(/\s+/)[0];
  const required = ['name', 'image', 'workdir', 'srcDir', 'testDir', 'testCmd', 'python', 'importName', 'distName', 'baseCommit', 'networkMarker'];
  for (const key of required) {
    const value = lib[key];
    if (typeof value !== 'string' || value.trim() === '') throw new Error(`library ${lib.name ?? '?'}: "${key}" is missing`);
    if (PLACEHOLDER.test(value.trim())) throw new Error(`library ${lib.name ?? '?'}: "${key}" is still the placeholder ${value}`);
  }
  if (lib.referenceCommit !== undefined && (typeof lib.referenceCommit !== 'string' || PLACEHOLDER.test(lib.referenceCommit))) {
    throw new Error(`library ${lib.name}: "referenceCommit" must be the dataset's commit or left out`);
  }
  if (!/^[\w.-]+$/.test(lib.name)) throw new Error(`library name "${lib.name}" must be a plain file name`);
  if (!/^[A-Za-z_]\w*$/.test(lib.networkMarker)) throw new Error(`library ${lib.name}: networkMarker "${lib.networkMarker}" is not a pytest marker name`);
  if (!/^[A-Za-z_][\w.]*$/.test(lib.importName)) throw new Error(`library ${lib.name}: importName "${lib.importName}" is not a Python module name`);
  if (!/^[0-9a-f]{7,40}$/i.test(lib.baseCommit) && lib.baseCommit !== 'HEAD') throw new Error(`library ${lib.name}: baseCommit must be a commit sha`);
  return lib;
}

/** The goal both arms are given, word for word: A as its one task's prompt, B as the planner's goal. */
export function goalText(lib) {
  return [
    `Implement the ${lib.name} library in this repository.`,
    `Its source under ${lib.srcDir} has the public API as stubs: the bodies of its functions and methods are left unimplemented.`,
    `Fill them in so that the unit tests under ${lib.testDir} pass; run them with \`${lib.testCmd} ${lib.testDir}\`.`,
    'The repository may not import until its stubbed functions are implemented: implementing them is the task, and a repository that fails to import is not a reason to stop.',
    'The tests in the repository are the specification.',
    'Do not edit, delete or skip the tests.',
    'Every dependency is already installed and the network is closed, so do not install or download anything.',
  ].join(' ');
}

// --- Context window ---------------------------------------------------------

/** The offline catalog's window for the model (core's modelDetailsSnapshot.json). */
export function snapshotWindow(table, model = PROVIDER_MODEL) {
  const entry = table?.[PROVIDER]?.[model];
  return typeof entry?.contextWindow === 'number' && entry.contextWindow > 0 ? entry.contextWindow : undefined;
}

/**
 * What the provider's listing states for the model, as core's
 * `fetchAllProviderModels` returns it (the call the runner's own lookup
 * makes): undefined when the model is not listed, 0 when listed without one.
 */
export function listedWindow(models, model = PROVIDER_MODEL) {
  const entry = Array.isArray(models) ? models.find((m) => m?.id === model || m?.id === `${PROVIDER}:${model}`) : undefined;
  if (!entry) return undefined;
  return typeof entry.contextLength === 'number' ? entry.contextLength : 0;
}

/**
 * Run in the box with its node and the checkout's core, through the gateway,
 * as the runner's lookup is: core's listing call with a fetch of its own, so
 * no cached catalog answers for a listing that failed. Without a key (a dry
 * run) the Authorization header is stripped before it leaves: the listing is
 * public, and core only lists a provider it holds a key for.
 */
export const WINDOW_PROBE_JS = String.raw`
const core = require('/opt/ordewell/node_modules/@ordewell/core/dist/index.js');
const model = process.argv[1];
const key = process.env.OPENROUTER_API_KEY;
const keyless = (url, init = {}) => {
  const headers = new Headers(init.headers);
  headers.delete('authorization');
  return fetch(url, { ...init, headers });
};
core.fetchAllProviderModels({ apiKeys: { openrouter: key || 'keyless' }, baseUrls: {}, fetchImpl: key ? fetch : keyless })
  .then(({ models, errors }) => {
    const list = models.openrouter ?? [];
    const mine = list.filter((m) => m.id === model || m.id === 'openrouter:' + model).map((m) => ({ id: m.id, contextLength: m.contextLength }));
    process.stdout.write(JSON.stringify({ listed: list.length, models: mine, errors, keyed: Boolean(key) }));
  })
  .catch((err) => { process.stdout.write(JSON.stringify({ listed: 0, models: [], errors: { openrouter: String(err?.message ?? err) } })); });
`;

/**
 * The window an attempt will run on, and whether to run. The runner looks the
 * model up in the provider's listing at every attempt's start and falls back
 * to 32k when the listing fails or omits it; models.dev (here, its offline
 * snapshot) fills only a window the listing states as 0. So the listing must
 * answer: a snapshot alone does not save a run whose listing fails.
 */
export function judgeWindow({ listed, snapshot }) {
  const out = { listed: listed ?? null, snapshot: snapshot ?? null, fallback: FALLBACK_WINDOW };
  if (listed === undefined) {
    return { ...out, ok: false, window: null, source: null, reason: `OpenRouter's listing did not answer for ${PROVIDER_MODEL}: every attempt would run on the ${FALLBACK_WINDOW}-token fallback` };
  }
  const window = listed > 0 ? listed : snapshot;
  const source = listed > 0 ? 'openrouter listing' : 'offline catalog (the listing states 0)';
  if (window === undefined) return { ...out, ok: false, window: null, source: null, reason: 'neither the listing nor the offline catalog states a window' };
  if (window <= FALLBACK_WINDOW) return { ...out, ok: false, window, source, reason: `the window ${window} is no more than the ${FALLBACK_WINDOW}-token fallback` };
  const agrees = snapshot === undefined || snapshot === window;
  return {
    ...out, ok: true, window, source,
    reason: agrees ? `${window} tokens, as the ${source} states` : `${window} tokens from the ${source}; the offline catalog says ${snapshot}`,
  };
}

/**
 * Whether a finished run compacted as if its window were smaller than the one
 * checked. Core compacts once the prompt passes its threshold, which is never
 * under half the window (compaction.ts, THRESHOLD_FLOOR_FRACTION), and an
 * overflow retry needs a prompt past the window itself: a compaction from
 * under half the window means an attempt ran on another, the fallback most
 * likely, despite the check before the run.
 */
export function windowFallbackSuspected(compactionPreTokens, window) {
  return compactionPreTokens.some((pre) => pre < window / 2);
}

// --- Egress -----------------------------------------------------------------

/**
 * Each probe as the box saw it, through the gateway and around it. The
 * listing must answer through the gateway; every other host must fail there;
 * and nothing may answer around it, which is what the internal network is for.
 */
export function judgeEgress({ proxied, direct }) {
  const failures = [];
  for (const url of EGRESS_ALLOWED_PROBES) {
    const r = proxied.find((p) => p.url === url);
    if (!r || typeof r.status !== 'number') failures.push(`${url} did not answer through the gateway${r?.error ? ` (${r.error})` : ''}`);
  }
  for (const url of EGRESS_DENIED_PROBES) {
    const r = proxied.find((p) => p.url === url);
    if (!r) failures.push(`${url} was not probed`);
    else if (typeof r.status === 'number') failures.push(`${url} answered ${r.status} through the gateway`);
  }
  for (const r of direct) {
    if (typeof r.status === 'number') failures.push(`${r.url} answered ${r.status} without the gateway`);
  }
  if (direct.length === 0) failures.push('nothing was probed without the gateway');
  return { ok: failures.length === 0, failures };
}

/** The probe the box runs with its own node: one fetch per URL, under a deadline, reported as JSON. */
export const EGRESS_PROBE_JS = String.raw`
const urls = JSON.parse(process.argv[1]);
(async () => {
  const out = [];
  for (const url of urls) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15000), redirect: 'manual' });
      out.push({ url, status: res.status });
      await res.body?.cancel();
    } catch (err) {
      const cause = err?.cause;
      out.push({ url, error: String(cause?.code || cause?.message || err?.message || err) });
    }
  }
  process.stdout.write(JSON.stringify(out));
})();
`;

// --- The venv ---------------------------------------------------------------

/**
 * The image's venv, relative to the workdir. Commit0 leaves it untracked and
 * unignored, and core's worktree bootstrap links it into each task worktree,
 * where an agent's own `git add -A` commits the link: merged back, it replaced
 * the workspace's venv with a link to itself (task #203).
 */
export const VENV_DIR = '.venv';

/**
 * Ignores the venv in the box's workspace, through `info/exclude`, which every
 * worktree of the repository shares: anchored and without a trailing slash, so
 * it matches the bootstrap's link as well as the directory. The box's rule,
 * not the product's: the repository under test is left as the dataset made it.
 */
export function workspaceIgnoreScript(lib) {
  const q = shellQuote;
  const rule = `/${VENV_DIR}`;
  return [
    'set -eu',
    `cd ${q(lib.workdir)}`,
    'exclude=$(git rev-parse --git-path info/exclude)',
    'mkdir -p "$(dirname "$exclude")"',
    `grep -qxF ${q(rule)} "$exclude" 2>/dev/null || printf '%s\\n' ${q(rule)} >> "$exclude"`,
  ].join('\n');
}

/** The arm's diff from the flattened base, the venv and everything under it left out. */
export function armPatchScript(lib) {
  return `git diff ${shellQuote(lib.flatCommit)} -- . ${shellQuote(`:(exclude,literal)${VENV_DIR}`)}`;
}

/**
 * Fails, saying why, unless the workspace's venv is still the image's: not a
 * link and nothing of it tracked. Run before the eval, whose interpreter lives
 * there; a venv the arm replaced is not a score.
 */
export function venvIntactScript(lib) {
  const q = shellQuote;
  const v = q(VENV_DIR);
  return [
    `cd ${q(lib.workdir)}`,
    `if [ -L ${v} ]; then echo "${VENV_DIR} is a link to $(readlink ${v}), not the image's venv" >&2; exit 1; fi`,
    `if [ -n "$(git ls-files -- ${v})" ]; then echo "HEAD tracks ${VENV_DIR}: the arm committed the venv" >&2; exit 1; fi`,
  ].join('\n');
}

// --- The reference implementation -------------------------------------------

/**
 * Leaves the task's repository holding one commit, the base tree, and nothing
 * that reaches another: Commit0's base commit sits on the library's own
 * history, whose parents hold the implementation the task asks for. Committed
 * from the base's index, not the working tree, so nothing untracked (a venv, a
 * build) joins the commit.
 */
export function flattenScript(lib) {
  const q = shellQuote;
  return [
    'set -eu',
    `cd ${q(lib.workdir)}`,
    // An alternate store would answer for objects this repository dropped.
    'if [ -s .git/objects/info/alternates ]; then echo "alternates: this repository borrows objects from another" >&2; exit 3; fi',
    `git -c advice.detachedHead=false checkout -q --detach ${q(lib.baseCommit)}`,
    'git checkout -q --orphan commit0-base',
    'git -c user.name=commit0-bench -c user.email=commit0-bench@localhost commit -q --allow-empty -m "Commit0 base"',
    'git for-each-ref --format="%(refname)" | while read -r ref; do [ "$ref" = refs/heads/commit0-base ] || git update-ref -d "$ref"; done',
    'for r in $(git remote); do git remote remove "$r"; done',
    'rm -rf .git/refs/replace .git/logs .git/shallow .git/info/grafts',
    // Each names a commit gc would otherwise keep.
    'rm -f .git/ORIG_HEAD .git/FETCH_HEAD .git/MERGE_HEAD .git/CHERRY_PICK_HEAD .git/REVERT_HEAD .git/AUTO_MERGE',
    'git worktree prune',
    'git reflog expire --expire=now --all',
    'git -c gc.reflogExpire=now -c gc.reflogExpireUnreachable=now gc -q --prune=now',
  ].join('\n');
}

/**
 * Reports, as JSON, every way the box could reach the implementation: the
 * repository's history and objects, and an installed copy outside the
 * repository (a site-packages directory, or a wheel or sdist on disk). An
 * editable install that resolves into the repository is the task's own stubs
 * and fine. Run from `/`, so the repository is not on the path through the
 * working directory. A fifth argument roots the archive search elsewhere than `/`, for a test on a host.
 */
export const LEAK_PROBE_PY = String.raw`
import importlib.util, json, os, site, subprocess, sys, sysconfig
workdir, import_name, dist_name, ref = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
scan_root = sys.argv[5] if len(sys.argv) > 5 else '/'
workdir = os.path.realpath(workdir)
def git(*args):
    return subprocess.run(['git', '-C', workdir, *args], capture_output=True, text=True)
def inside(p):
    p = os.path.realpath(p)
    return p == workdir or p.startswith(workdir + os.sep)
out = {}
log = git('log', '--all', '--format=%H')
out['commits'] = len(log.stdout.split()) if log.returncode == 0 else None
objs = git('cat-file', '--batch-all-objects', '--batch-check=%(objecttype)')
out['objectCommits'] = objs.stdout.split().count('commit') if objs.returncode == 0 else None
out['reference'] = None if ref == '-' else ('present' if git('cat-file', '-e', ref + '^{commit}').returncode == 0 else 'absent')
out['alternates'] = os.path.exists(os.path.join(workdir, '.git', 'objects', 'info', 'alternates'))
spec = None
try:
    spec = importlib.util.find_spec(import_name)
except Exception as e:
    out['specError'] = repr(e)
places = []
if spec is not None:
    if spec.origin and spec.origin not in ('built-in', 'frozen', 'namespace'):
        places.append(spec.origin)
    places += list(spec.submodule_search_locations or [])
out['resolves'] = places
out['resolvesOutside'] = [p for p in places if not inside(p)]
dirs = set(site.getsitepackages() if hasattr(site, 'getsitepackages') else [])
dirs.add(site.getusersitepackages())
for key in ('purelib', 'platlib'):
    dirs.add(sysconfig.get_paths()[key])
norm = lambda s: s.lower().replace('-', '_').replace('.', '_')
foreign = []
for d in sorted(x for x in dirs if x and os.path.isdir(x)):
    for name in os.listdir(d):
        stem = norm(name.split('-')[0] if name.endswith(('.dist-info', '.egg-info')) else name.rsplit('.', 1)[0] if name.endswith('.py') else name)
        if stem not in (norm(import_name), norm(dist_name)):
            continue
        full = os.path.join(d, name)
        if name.endswith('.dist-info'):
            direct = os.path.join(full, 'direct_url.json')
            if os.path.exists(direct):
                try:
                    url = json.load(open(direct)).get('url', '')
                    if url.startswith('file://') and inside(url[7:]):
                        continue
                except Exception:
                    pass
            if not os.path.exists(os.path.join(full, 'RECORD')) or not any(
                    line.split(',')[0].replace('-', '_').lower().startswith(norm(import_name) + '/') or line.split(',')[0].lower() == norm(import_name) + '.py'
                    for line in open(os.path.join(full, 'RECORD'))):
                continue
        if name.endswith(('.egg-link', '.pth')) or (name.endswith('.egg-info') and not os.path.isdir(os.path.join(d, import_name))):
            continue
        foreign.append(full)
out['installedOutside'] = foreign
archives = []
want = norm(dist_name) + '_'
for root, subdirs, files in os.walk(scan_root, topdown=True):
    subdirs[:] = [s for s in subdirs if not (root == '/' and s in ('proc', 'sys', 'dev'))]
    if inside(root) or root.startswith('/opt/ordewell') or root.startswith('/opt/node'):
        subdirs[:] = []
        continue
    for f in files:
        # uv's editable wheel (-0.editable-) holds a finder and metadata pointing at the repository, no source.
        if norm(f).startswith(want) and f.endswith(('.whl', '.tar.gz', '.zip', '.tar.bz2')) and '.editable-' not in f:
            archives.append(os.path.join(root, f))
out['archives'] = archives
print(json.dumps(out))
`;

/** Whether the implementation is out of reach, and if not, every way it is reachable. */
export function judgeLeak(probe) {
  const failures = [];
  if (probe.commits !== 1) failures.push(`git log --all shows ${probe.commits ?? 'no readable'} commits, not the one base commit`);
  if (probe.objectCommits !== 1) failures.push(`the object store holds ${probe.objectCommits ?? 'no readable'} commits, not one`);
  if (probe.reference === 'present') failures.push('the reference commit is still in the repository');
  if (probe.alternates) failures.push('the repository borrows objects from an alternate store');
  for (const p of probe.resolvesOutside ?? []) failures.push(`the library imports from ${p}, outside the repository`);
  for (const p of probe.installedOutside ?? []) failures.push(`an installed copy sits at ${p}`);
  for (const p of probe.archives ?? []) failures.push(`a package archive sits at ${p}`);
  return { ok: failures.length === 0, failures };
}

/** Which kinds of leak a probe saw, so the planted canary can prove each is caught. */
export function leakKinds(probe) {
  const kinds = [];
  if ((probe.commits ?? 0) > 1 || (probe.objectCommits ?? 0) > 1) kinds.push('history');
  if (probe.reference === 'present') kinds.push('reference');
  if (probe.alternates) kinds.push('alternates');
  if ((probe.resolvesOutside ?? []).length) kinds.push('import');
  if ((probe.installedOutside ?? []).length) kinds.push('installed');
  if ((probe.archives ?? []).length) kinds.push('archive');
  return kinds;
}

// --- Tests ------------------------------------------------------------------

/**
 * The pytest arguments every count uses: network-marked tests deselected (the
 * network is closed, so they could only fail), no cache written into the repository.
 */
export function pytestArgs(lib) {
  return ['-m', `not ${lib.networkMarker ?? NETWORK_MARKER}`, '-p', 'no:cacheprovider', lib.testDir];
}

/**
 * pytest's collection summary: `N tests collected`, or with a deselection
 * `N/M tests collected (K deselected)`, where N is what runs.
 */
export function parseCollection(text) {
  const m = /(?:^|\n)\s*(?:(\d+)\/(\d+)|(\d+)) tests? collected(?: \((\d+) deselected\))?/.exec(text)
    ?? /(?:^|\n)\s*no tests collected(?: \((\d+) deselected\))?/.exec(text);
  if (!m) return null;
  if (m.length === 2) return { collected: 0, total: Number(m[1] ?? 0), deselected: Number(m[1] ?? 0) };
  const collected = Number(m[1] ?? m[3]);
  const deselected = Number(m[4] ?? 0);
  return { collected, total: m[2] !== undefined ? Number(m[2]) : collected + deselected, deselected };
}

const tail = (text, n = 6) => text.trim().split('\n').slice(-n).join(' | ');

/**
 * The denominator, counted at the reference commit before the history goes:
 * there every module imports, so every test collects, and with the network
 * closed a dependency missing from the image fails that import.
 */
export function judgeReferenceCollection({ code, output }) {
  const counts = parseCollection(output);
  const ok = code === 0 && counts !== null && counts.collected > 0;
  return { ok, counts, failures: ok ? [] : [`collection at the reference failed (exit ${code}): ${tail(output)}`] };
}

/**
 * Collection at the stubs, where it may fail outright: a stub that raises at
 * import breaks every test module importing it (networkx exits 4 with none
 * collected, tlslite-ng 2), so neither its exit nor its count says anything.
 * Only a module the image lacks does.
 */
export function judgeStubCollection({ code, output }) {
  const missing = [...new Set(output.split('\n').filter((l) => /ModuleNotFoundError|No module named/.test(l)).map((l) => l.trim()))];
  return { ok: missing.length === 0, exit: code, counts: parseCollection(output), failures: missing.map((l) => `a module is missing from the image: ${l}`) };
}

/**
 * Removes, and lists, every file under the working directory but .git written
 * after the marker was touched, then the marker. (find will not combine
 * -prune with -delete.)
 */
export function removeWrittenScript(mark) {
  const q = shellQuote;
  const list = `${mark}.list`;
  return [
    'set -eu',
    `find . -path ./.git -prune -o -type f -newer ${q(mark)} -print > ${q(list)}`,
    `while IFS= read -r f; do rm -f -- "$f"; done < ${q(list)}`,
    `cat ${q(list)}`,
    `rm -f ${q(mark)} ${q(list)}`,
  ].join('\n');
}

/**
 * Whether a path under testDir is a test the restore puts back: a test_*.py,
 * a conftest.py, or anything in a tests/ or unit_tests/ directory. The rest is
 * the arm's work wherever testDir lies inside srcDir, as networkx's does.
 */
export function isTestPath(lib, p) {
  const dir = lib.testDir.replace(/^\.\//, '').replace(/\/+$/, '');
  if (dir !== '' && dir !== '.' && !p.startsWith(`${dir}/`)) return false;
  const parts = p.split('/');
  const base = parts.pop();
  return /^test_.*\.py$/.test(base) || base === 'conftest.py' || parts.some((d) => d === 'tests' || d === 'unit_tests');
}

/**
 * What to put back under testDir, from `git diff --name-status -z --no-renames
 * <base>` and `git ls-files -z --others --exclude-standard`: a changed or
 * deleted test checked out from the base, an added one removed.
 */
export function testRestorePlan(lib, nameStatusZ, untrackedZ) {
  const checkout = [];
  const remove = [];
  const f = nameStatusZ.split('\0');
  for (let i = 0; i + 1 < f.length; i += 2) {
    const [status, p] = [f[i], f[i + 1]];
    if (!status || !isTestPath(lib, p)) continue;
    (status === 'A' ? remove : checkout).push(p);
  }
  for (const p of untrackedZ.split('\0')) if (p && isTestPath(lib, p)) remove.push(p);
  return { checkout, remove };
}

/** pytest's last summary line, as counts per outcome; null when the run printed none. */
export function parsePytestSummary(text) {
  const lines = text.split('\n').map((l) => l.replace(/^=+\s*|\s*=+$/g, '').trim()).filter(Boolean);
  const line = [...lines].reverse().find((l) => / in [\d.]+s(?: \([^)]*\))?$/.test(l) && /\d+ \w+/.test(l));
  if (!line) return null;
  const counts = { passed: 0, failed: 0, errors: 0, skipped: 0, xfailed: 0, xpassed: 0, deselected: 0 };
  for (const [, n, word] of line.matchAll(/(\d+) (passed|failed|errors?|skipped|xfailed|xpassed|deselected)/g)) {
    counts[word.startsWith('error') ? 'errors' : word] += Number(n);
  }
  return counts;
}

/**
 * Flags the scoring run adds: a test file that fails to import is one error,
 * and pytest would otherwise stop at the first and run nothing, zeroing the
 * whole library for one file.
 */
export const EVAL_PYTEST_FLAGS = Object.freeze(['--continue-on-collection-errors']);

/** The files pytest could not collect, from its `ERROR collecting <file>` headers and `ERROR <file>` summary lines. */
export function collectionErrorFiles(text) {
  const files = new Set();
  for (const m of text.matchAll(/^_+ ERROR collecting (\S+) _+$/gm)) files.add(m[1]);
  for (const m of text.matchAll(/^ERROR ([^\s:]+\.py)(?:::\S+)?(?: - .*)?$/gm)) files.add(m[1]);
  return [...files];
}

/**
 * A test run's counts. A file that failed to collect is an error of its own
 * (`collectionErrors` names it) and the rest still score. A run whose
 * collection broke before any test could run prints no summary when a conftest
 * fails to import (networkx's stubs, exit 4): no test ran, so it counts as
 * none passed, the error kept. Any other run without a summary is unread, so a
 * driver mistake never reads as a score.
 */
export function parseEvaluation(code, output) {
  const summary = parsePytestSummary(output);
  if (summary) return { ...summary, collectionErrors: collectionErrorFiles(output) };
  const broke = /^(ImportError while loading conftest.*|Interrupted: \d+ errors? during collection.*)$/m.exec(output);
  if (!broke || code === 0) return null;
  return { passed: 0, failed: 0, errors: 0, skipped: 0, xfailed: 0, xpassed: 0, deselected: 0, collectionErrors: [], collectionError: broke[1].trim() };
}

// --- Sessions ---------------------------------------------------------------

/**
 * Arm A's plan, written in the box with the checkout's core as `ordewell plan`
 * would save one: one task on the built-in runner and the protocol's model,
 * its prompt the goal, approved, so `ordewell run` starts it with no planner
 * turn. Prints the session id.
 */
export const ARM_A_PLAN_JS = String.raw`
const core = require('/opt/ordewell/node_modules/@ordewell/core/dist/index.js');
const [workspace, goal, modelId, modelLabel] = process.argv.slice(1);
const now = new Date().toISOString();
const task = core.createTask({
  order: 1,
  title: 'Implement the library so its tests pass',
  description: goal,
  prompt: goal,
  assignedRunner: '${RUNNER}',
  assignedModel: { modelId, modelLabel },
  taskMode: '${ARM_A_MODE}',
});
const meta = core.saveSession({ tasks: [task], generatedAt: now, status: 'approved', runners: ['${RUNNER}'], lastUpdated: now }, goal, workspace);
process.stdout.write(meta.id);
`;

/** A saved session's plan, read back with core, as JSON on stdout. */
export const READ_PLAN_JS = String.raw`
const core = require('/opt/ordewell/node_modules/@ordewell/core/dist/index.js');
const [workspace, sessionId] = process.argv.slice(1);
const loaded = core.loadSession(sessionId, workspace);
process.stdout.write(JSON.stringify(loaded ? loaded.plan : null));
`;

/** The settings both arms run under, written to the box's `~/.ordewell/settings.json`. */
export function boxSettings() {
  return {
    autonomousMode: true,
    enabledRunners: [RUNNER],
    modelAllowlist: { [RUNNER]: [MODEL_ID] },
    ordewellStepLimit: STEP_LIMIT,
  };
}

/** The commands an arm runs in the box, in order, so a dry run can show them without running them. */
export function armCommands(arm, { workspace, goal, sessionId = '<session>' }) {
  const ws = ['--workspace', workspace];
  const run = ['ordewell', 'run', '--session-id', sessionId, ...ws];
  const merge = ['ordewell', 'merge', '--session-id', sessionId, '--yes', ...ws];
  if (arm.id === 'A') return [['<write the one-task session with core>'], run, merge];
  return [['ordewell', 'plan', '--goal', goal, '--runner', RUNNER, '--no-chat', '--yes', ...ws], run, merge];
}

// --- Run records ------------------------------------------------------------

/**
 * One runner session's transcript (`transcript.jsonl`) as the result needs it.
 * The context a step left is its prompt plus its reply, the measure the
 * runner itself sizes the next request by; the spend is OpenRouter's own
 * figure per call, which each usage line carries, and a compaction's summary
 * call, which only the compaction line does.
 */
export function summarizeTranscript(text) {
  const s = { usageLines: 0, uncosted: 0, spendUsd: 0, peakContext: 0, compactions: 0, compactionPreTokens: [], steps: 0, model: null };
  const cost = (usage) => {
    if (usage?.cost && typeof usage.cost.amount === 'number') {
      s.spendUsd += usage.cost.amount;
      return true;
    }
    return false;
  };
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (e?.v !== 1) continue;
    if (typeof e.step === 'number') s.steps = Math.max(s.steps, e.step);
    if (e.kind === 'session') s.model = e.model ?? null;
    if (e.kind === 'usage') {
      s.usageLines += 1;
      if (!cost(e.usage)) s.uncosted += 1;
      const context = (e.usage?.inputTokens ?? 0) + (e.usage?.outputTokens ?? 0);
      s.peakContext = Math.max(s.peakContext, context);
    }
    if (e.kind === 'compaction') {
      s.compactions += 1;
      if (typeof e.preTokens === 'number') s.compactionPreTokens.push(e.preTokens);
      cost(e.usage);
    }
  }
  return s;
}

/** Every session of a run together: spend adds up, the peak is the largest any one reached. */
export function combineTranscripts(summaries) {
  const out = { sessions: summaries.length, usageLines: 0, uncosted: 0, spendUsd: 0, peakContext: 0, compactions: 0, compactionPreTokens: [], models: [] };
  for (const s of summaries) {
    out.usageLines += s.usageLines;
    out.uncosted += s.uncosted;
    out.spendUsd += s.spendUsd;
    out.peakContext = Math.max(out.peakContext, s.peakContext);
    out.compactions += s.compactions;
    out.compactionPreTokens.push(...s.compactionPreTokens);
    if (s.model && !out.models.includes(s.model)) out.models.push(s.model);
  }
  out.spendUsd = round6(out.spendUsd);
  return out;
}

/**
 * Whether a plan may run: every AI task on the built-in runner and the
 * protocol's model, since the comparison holds both fixed, and in a mode that
 * runner has, since it cannot start a task in any other.
 */
export function judgePlan(plan) {
  const failures = [];
  const walk = (tasks) => {
    for (const t of tasks ?? []) {
      if ((t.type ?? 'ai') === 'ai') {
        if (t.assignedRunner !== RUNNER) failures.push(`task "${t.title}" runs on ${t.assignedRunner}, not ${RUNNER}`);
        if (t.assignedModel?.modelId !== MODEL_ID) failures.push(`task "${t.title}" runs ${t.assignedModel?.modelId ?? 'no model'}, not ${MODEL_ID}`);
        if (!RUNNER_MODES.includes(t.taskMode)) failures.push(`task "${t.title}" is in mode ${t.taskMode ?? 'none'}, which the built-in runner does not have (${RUNNER_MODES.join(', ')})`);
      }
      walk(t.subtasks);
    }
  };
  walk(plan?.tasks);
  if (!plan?.tasks?.length) failures.push('the plan holds no task');
  return { ok: failures.length === 0, failures };
}

/**
 * The cap a watchdog enforces, read every poll. The key's own usage counts
 * every caller's spend, B's planner included; the transcripts are the
 * fallback when the key cannot be read, and both are checked when both are known.
 */
export function capDecision({ elapsedMs, keySpentUsd, transcriptSpentUsd, capUsd, wallCapMs = WALL_CAP_MS }) {
  const spent = Math.max(keySpentUsd ?? 0, transcriptSpentUsd ?? 0);
  if (spent >= capUsd) return { stop: true, why: 'spend', spentUsd: round6(spent) };
  if (elapsedMs >= wallCapMs) return { stop: true, why: 'wall-clock', spentUsd: round6(spent) };
  return { stop: false, why: null, spentUsd: round6(spent) };
}

/**
 * Whether `ordewell run` is stuck before its first model call: NO_START_MS
 * into the run with no usage line in any runner transcript. That is a task
 * held at start (a mode or model the runner refuses) or never scheduled, and
 * polling on would only reach the wall-clock cap with nothing spent.
 */
export function startDecision({ sinceRunMs, usageLines, plan, boundMs = NO_START_MS }) {
  if (sinceRunMs < boundMs || usageLines > 0) return { stop: false, why: null, detail: null };
  const waiting = [];
  const walk = (tasks) => {
    for (const t of tasks ?? []) {
      if ((t.type ?? 'ai') === 'ai' && t.status !== 'completed' && t.status !== 'skipped') {
        waiting.push(`"${t.title}" ${t.status ?? 'pending'}${t.attempted ? '' : ', no attempt'}${t.taskMode ? `, mode ${t.taskMode}` : ''}`);
      }
      walk(t.subtasks);
    }
  };
  walk(plan?.tasks);
  const minutes = Math.round(boundMs / 60_000);
  return { stop: true, why: 'no-start', detail: `no model call ${minutes} min into the run; ${waiting.length ? `waiting: ${waiting.join('; ')}` : 'the plan could not be read or holds no open AI task'}` };
}

/** Worktree paths in `git worktree list --porcelain` other than the workspace's own: where a task's work lives until it merges. */
export function otherWorktrees(porcelain, workdir) {
  return porcelain.split('\n').filter((l) => l.startsWith('worktree ')).map((l) => l.slice('worktree '.length)).filter((p) => path.posix.normalize(p) !== path.posix.normalize(workdir));
}

/**
 * Whether a run's work is partial. A run stopped at a cap, or leaving a task
 * not completed (blocked, failed, awaiting the user), never merged, so its
 * patch comes from the task worktree and its score reads as a truncated one.
 */
export function judgeLanding({ stopped, plan, runExit }) {
  if (stopped) return { truncated: true, why: `cap: ${stopped.why}` };
  const open = (plan?.tasks ?? []).filter((t) => t.status !== 'completed' && t.status !== 'skipped').length;
  if (open > 0) return { truncated: true, why: `blocked: ${open} task${open === 1 ? '' : 's'} not completed` };
  if (!plan && runExit) return { truncated: true, why: `blocked: run exit ${runExit}, no plan to read` };
  return { truncated: false, why: null };
}

/** One library's result for one arm, with every field the comparison reports. */
export function resultRecord({ lib, arm, window, ordewell, egress, leak, network, tests, wallClockMs, spend, transcripts, stopped, truncated, providerPin, dryRun, startedAt, endedAt }) {
  return {
    library: lib.name,
    arm: arm.id,
    dryRun,
    model: MODEL_ID,
    providerPin: providerPin ?? null,
    ordewellSha: ordewell.sha,
    pr177Merge: PR177_MERGE,
    containsPr177: ordewell.containsPr177,
    contextWindow: window.window,
    windowCheck: window,
    egress,
    leak,
    networkDeselected: network?.deselected ?? null,
    tests: tests ? { passed: tests.passed, collected: tests.collected, failed: tests.failed, errors: tests.errors, skipped: tests.skipped, collectionErrors: tests.collectionErrors ?? [] } : null,
    wallClockMs: wallClockMs ?? null,
    capUsd: arm.capUsd,
    billedUsd: spend?.billedUsd ?? null,
    billedSource: spend?.source ?? null,
    runnerReportedUsd: transcripts?.spendUsd ?? null,
    peakContext: transcripts?.peakContext ?? null,
    compactions: transcripts?.compactions ?? null,
    windowFallbackSuspected: transcripts && window.window ? windowFallbackSuspected(transcripts.compactionPreTokens, window.window) : null,
    stopped: stopped ?? null,
    truncated: truncated ?? { truncated: false, why: null },
    stepLimit: STEP_LIMIT,
    startedAt,
    endedAt,
  };
}

// --- Command line -----------------------------------------------------------

export function parseArgs(argv) {
  const out = { dryRun: false, run: false, fixture: false, arm: 'both', libs: null, only: [], image: null, providerPin: null, keep: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--run') out.run = true;
    else if (a === '--fixture') out.fixture = true;
    else if (a === '--keep') out.keep = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--arm') {
      const v = value().toUpperCase();
      if (!['A', 'B', 'BOTH'].includes(v)) throw new Error('--arm takes A, B or both');
      out.arm = v === 'BOTH' ? 'both' : v;
    } else if (a === '--libs') out.libs = value();
    else if (a === '--only') out.only.push(...value().split(',').filter(Boolean));
    else if (a === '--image') out.image = value();
    else if (a === '--provider-pin') out.providerPin = value();
    else throw new Error(`unknown argument ${a}`);
  }
  if (out.help) return out;
  // Spending is never the default: a run that bills the key has to say so.
  if (out.dryRun === out.run) throw new Error('pass --dry-run to set up and check without a model call, or --run to run the arms and spend');
  if (out.fixture && !out.dryRun) throw new Error('--fixture is a dry-run library: pass --dry-run with it');
  if (out.fixture && !out.image) throw new Error('--fixture needs --image: an image with python3, pytest and git to build it in');
  if (!out.fixture && !out.libs) throw new Error('pass --libs <file>, a list of libraries as libraries.example.json shows, or --fixture');
  if (out.run && !out.providerPin) throw new Error('a run needs --provider-pin <provider>: the one OpenRouter provider the key is pinned to');
  return out;
}

export const armsOf = (arm) => (arm === 'both' ? [ARMS.A, ARMS.B] : [ARMS[arm]]);

export function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/**
 * Billed spend is the key's usage before and after, which counts every caller:
 * two drivers on one key would bill each other's calls, so a run holds the key.
 * A lock whose pid is dead (a run that was killed) is removed and logged; one
 * that names no pid is left, since nothing says it is stale.
 */
export function lockKey(dir, { log = console.log, isAlive = pidAlive } = {}) {
  const lock = path.join(dir, 'key.lock');
  for (let attempt = 0; ; attempt++) {
    try {
      fs.writeFileSync(lock, `${process.pid}\n`, { flag: 'wx' });
      break;
    } catch (err) {
      const held = Number.parseInt(fs.existsSync(lock) ? fs.readFileSync(lock, 'utf8') : '', 10);
      if (attempt > 0 || !Number.isInteger(held) || held <= 0 || isAlive(held)) {
        throw new Error(`${lock} is held: another run is billing this key. Remove it if no run is.`, { cause: err });
      }
      log(`[commit0] removing stale ${lock}: pid ${held} is not running`);
      fs.rmSync(lock, { force: true });
    }
  }
  return () => fs.rmSync(lock, { force: true });
}

export function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

export const round6 = (x) => Math.round(x * 1e6) / 1e6;
