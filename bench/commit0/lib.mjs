// The Commit0 comparison's logic, apart from the docker calls that drive.mjs
// makes: what the protocol fixes, how each check judges what it saw, and how a
// run's record is read back. Everything here is pure, so its tests need no
// engine, no key and no network.

import fs from 'node:fs';
import os from 'node:os';
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
 * One spend cap for both arms (D1): B's planner turn spends inside it, as a
 * user's would, so a larger cap for B would hand it a budget A never had.
 */
export const CAP_USD = 8;

/** B's ORDEWELL_MAX_PARALLEL (D3), and the box's quota (D4), so a run's wall-clock does not depend on what else the host runs. */
export const PARALLEL = 8;
export const CPUS = 8;
export const MEMORY = '12g';

/** How long a task may wait on a person, with no attempt running, before the run is called stalled. */
export const STALL_MIN = 15;

/**
 * How long a run must hold still, once nothing runs and nobody is waited on,
 * before it is over. `ordewell run` is no judge of that (D5): at Act the
 * supervisor's closing turn may retry a task after the run's own end.
 */
export const SETTLE_MS = 5 * 60 * 1000;

export const ARMS = Object.freeze({
  A: Object.freeze({ id: 'A', label: 'one hand-written task, no planner, no supervisor' }),
  B: Object.freeze({ id: 'B', label: 'ordewell plan and run, supervisor at Act, automatic merging' }),
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
    'The original implementation is off limits: do not look for it in caches, compiled files, installed packages or on the network; write it from the docstrings and the tests.',
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
 * What no diff carries: the image's venv, the session data Ordewell keeps in
 * the workspace, and bytecode, which is no one's work and once made a partial
 * patch mostly binaries.
 */
const UNSCORED = () => [
  ...[VENV_DIR, '.ordewell'].map((d) => `:(exclude,literal)${d}`),
  ':(exclude,glob)**/__pycache__/**',
  ':(exclude,glob)**/*.pyc',
].map(shellQuote).join(' ');
/** Marks every untracked, unignored file but those as intent-to-add, so `git diff` shows it; `git add -N .` would fail on an ignored venv link. */
const INTENT_TO_ADD = () => `git ls-files -z --others --exclude-standard -- . ${UNSCORED()} | xargs -0 -r git add -N --`;

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

/**
 * The arm's diff from the flattened base: what the eval scores, so a file left
 * untracked (one a task patch applied, an agent's uncommitted new module) is
 * in it through an intent-to-add. The venv and Ordewell's own directory are not.
 */
export function armPatchScript(lib) {
  return `${INTENT_TO_ADD()} && git diff --binary ${shellQuote(lib.flatCommit)} -- . ${UNSCORED()}`;
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
 * editable install that resolves into the repository, or an editable wheel
 * that holds none of the modules, is the task's own stubs and fine. Run from `/`, so the repository is not on the path through the
 * working directory. A fifth argument roots the archive search elsewhere than `/`, for a test on a host.
 */
export const LEAK_PROBE_PY = String.raw`
import importlib.util, json, os, site, subprocess, sys, sysconfig, zipfile
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
top = import_name.split('.')[0]
def carries_source(path):
    try:
        with zipfile.ZipFile(path) as z:
            names = z.namelist()
    except Exception:
        return True
    return any(n.split('/')[0] == top or ('/' not in n and n.split('.')[0] == top and n.endswith(('.py', '.so', '.pyd'))) for n in names)
for root, subdirs, files in os.walk(scan_root, topdown=True):
    subdirs[:] = [s for s in subdirs if not (root == '/' and s in ('proc', 'sys', 'dev'))]
    if inside(root) or root.startswith('/opt/ordewell') or root.startswith('/opt/node'):
        subdirs[:] = []
        continue
    for f in files:
        full = os.path.join(root, f)
        if not (norm(f).startswith(want) and f.endswith(('.whl', '.tar.gz', '.zip', '.tar.bz2'))):
            continue
        # An editable wheel (uv keeps its own under sdists-v4/editable/) is a .pth, or a finder,
        # and metadata pointing at the repository; it leaks only if it also carries the modules.
        editable = '.editable-' in f or '/sdists-v4/editable/' in full
        if editable and f.endswith('.whl') and not carries_source(full):
            continue
        archives.append(full)
out['archives'] = archives
# After the cleanup nothing untracked or ignored is left but the venv, Ordewell's
# own directory and an editable install's metadata: anything else (bytecode, a
# build tree, a stray copy) may carry the implementation, and is a hit.
st = git('status', '--ignored', '--porcelain', '-z', '--untracked-files=all', '--', '.',
         ':(exclude,literal).venv', ':(exclude,literal).ordewell', ':(exclude,glob)**/*.egg-info/**')
if st.returncode == 0:
    entries = [e for e in st.stdout.split('\0') if e]
    out['untracked'] = sorted(e[3:] for e in entries if e[:2] in ('??', '!!'))
else:
    out['untracked'] = None
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
  if (!Array.isArray(probe.untracked)) failures.push('git status could not list the untracked and ignored files');
  for (const p of probe.untracked ?? []) failures.push(`an untracked or ignored file ${p} is left in the workspace`);
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
  if ((probe.untracked ?? []).length) kinds.push('untracked');
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
/**
 * Removes every untracked and ignored file the image or the reference
 * collection left in the flattened workspace, printing each: bytecode compiled
 * from the implementation, a build tree. The venv stays, and so does an
 * editable install's metadata, which names the package and holds no module.
 */
export function leftoverCleanupScript(lib) {
  return `set -eu\ncd ${shellQuote(lib.workdir)}\ngit clean -ffdx -e /${VENV_DIR} -e '*.egg-info'`;
}

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

/** What pytest reads wherever it lies on the way to the tests: a hook, or options that load one. */
const PYTEST_CONFIG = new Set(['conftest.py', 'pytest.ini', 'pyproject.toml', 'setup.cfg', 'tox.ini']);

/** Directories in the workdir that are not the arm's: the image's venv and Ordewell's own state. */
const NOT_THE_ARMS = [VENV_DIR, '.ordewell'];

/**
 * Whether a path is one the restore puts back: a pytest config or conftest.py
 * anywhere, since one at the root rewrites what `pytest tests` reports; under
 * testDir, a test_*.py or *_test.py, or anything in a tests/ or unit_tests/
 * directory. The rest is the arm's work wherever testDir lies inside srcDir,
 * as networkx's does.
 */
export function isTestPath(lib, p) {
  const parts = p.split('/');
  const base = parts.pop();
  if (NOT_THE_ARMS.includes(parts[0])) return false;
  if (PYTEST_CONFIG.has(base)) return true;
  const dir = lib.testDir.replace(/^\.\//, '').replace(/\/+$/, '');
  if (dir !== '' && dir !== '.' && !p.startsWith(`${dir}/`)) return false;
  return /^test_.*\.py$/.test(base) || /_test\.py$/.test(base) || parts.some((d) => d === 'tests' || d === 'unit_tests');
}

/**
 * The commands whose output testRestorePlan reads, run in the workdir: the
 * whole tree, not only testDir, and untracked files the arm's .gitignore
 * hides as well as the rest.
 */
export function testRestoreArgs(lib) {
  const outside = NOT_THE_ARMS.map((d) => `:(exclude)${d}`);
  return {
    diff: ['git', 'diff', '--name-status', '-z', '--no-renames', lib.flatCommit, '--', '.', ...outside],
    untracked: ['git', 'ls-files', '-z', '--others', '--', '.', ...outside],
  };
}

/**
 * What to put back, from testRestoreArgs' output: a changed or deleted test
 * checked out from the base, an added one removed.
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

/** The whole scoring run's limit, past which `timeout` ends it with 124 and nothing is read. */
export const EVAL_TIMEOUT_S = 1800;

/**
 * Each test phase's limit. A stub can make a test spin (tlslite-ng's
 * test_atLengthCheck loops on a stubbed check that returns None), and one
 * spinning test would otherwise hold the run to its limit and lose every count.
 * tlslite-ng's slowest test at the reference takes about 3 s, so a passing test
 * is nowhere near this.
 */
export const TEST_TIMEOUT_S = 120;

/** Where the box holds the timeout plugin: outside the workspace, so no arm's patch carries it. */
export const TEST_TIMEOUT_PLUGIN_DIR = '/opt/commit0-bench';
export const TEST_TIMEOUT_PLUGIN = 'commit0_test_timeout';

/**
 * The per-test timeout, as a pytest plugin, since Commit0's images carry no
 * pytest-timeout and the box cannot install one. An expiry raises a
 * BaseException, not pytest.fail: hypothesis catches Failed and Exception to
 * shrink, which would run the spinning test again unbounded, and a stub's
 * `except Exception` would swallow it. pytest records it as that test's
 * failure (an error in setup or teardown) and goes on to the next.
 */
export const TEST_TIMEOUT_PLUGIN_PY = String.raw`
import signal

import pytest


class Commit0TestTimeout(BaseException):
    pass


def pytest_addoption(parser):
    parser.addoption('--commit0-test-timeout', type=float, default=0.0,
                     help='seconds each test phase may run before it fails')


def _bounded(item):
    seconds = item.config.getoption('commit0_test_timeout')
    if not seconds:
        yield
        return

    def expire(signum, frame):
        raise Commit0TestTimeout('the test ran past %gs' % seconds)

    previous = signal.signal(signal.SIGALRM, expire)
    signal.setitimer(signal.ITIMER_REAL, seconds)
    try:
        yield
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous)


@pytest.hookimpl(hookwrapper=True)
def pytest_runtest_setup(item):
    yield from _bounded(item)


@pytest.hookimpl(hookwrapper=True)
def pytest_runtest_call(item):
    yield from _bounded(item)


@pytest.hookimpl(hookwrapper=True)
def pytest_runtest_teardown(item):
    yield from _bounded(item)
`;

/**
 * The scoring run, as the box's sh runs it: the whole run bounded by
 * EVAL_TIMEOUT_S and each test by TEST_TIMEOUT_S, with the plugin on the path
 * ahead of whatever the image sets.
 */
export function evalCommand(lib) {
  const pytest = [...EVAL_PYTEST_FLAGS, '-p', TEST_TIMEOUT_PLUGIN, `--commit0-test-timeout=${TEST_TIMEOUT_S}`, '-q', '-rN', ...pytestArgs(lib)];
  return `timeout ${EVAL_TIMEOUT_S} env PYTHONPATH=${shellQuote(TEST_TIMEOUT_PLUGIN_DIR)}\${PYTHONPATH:+:$PYTHONPATH} ${lib.testCmd} ${pytest.map(shellQuote).join(' ')}`;
}

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

/**
 * What an arm runs under, as result.json records it. A is one agent alone
 * (D2): no supervisor to answer for it, nothing started or merged on its
 * behalf, one task at a time. B is Ordewell as its user runs it (D3).
 */
export function armSettings(arm, { parallel = PARALLEL, cpus = CPUS, memory = MEMORY, capUsd = CAP_USD, wallCapMs = WALL_CAP_MS } = {}) {
  const b = arm.id === 'B';
  return {
    supervisorLevel: b ? 'act' : 'off',
    autorun: b,
    automerge: b,
    parallel: b ? parallel : 1,
    cpus,
    memory,
    capUsd,
    wallCapMs,
  };
}

/**
 * The box's `~/.ordewell/settings.json` for an arm, under core's own keys
 * (runSettingsDefaults.ts, SettingsService.ts): automatic merging is
 * `mergeAtGatesAutomatically`.
 */
export function boxSettings(arm, settings = armSettings(arm)) {
  return {
    autonomousMode: true,
    enabledRunners: [RUNNER],
    modelAllowlist: { [RUNNER]: [MODEL_ID] },
    ordewellStepLimit: STEP_LIMIT,
    supervisorLevel: settings.supervisorLevel,
    autorun: settings.autorun,
    mergeAtGatesAutomatically: settings.automerge,
  };
}

/**
 * Asks the box's daemon for the settings a session opened with, as a surface
 * would (`GET /api/settings`), with the daemon's own token. Prints
 * `{status, body}`, or `{error}` when it cannot be asked.
 */
export const SETTINGS_PROBE_JS = String.raw`
const core = require('/opt/ordewell/node_modules/@ordewell/core/dist/index.js');
const [workspace, sessionId] = process.argv.slice(1);
(async () => {
  try {
    const port = core.DEFAULT_DAEMON_PORT;
    const token = core.readDaemonToken(port);
    if (!token) throw new Error('no daemon token: the daemon is not running');
    const q = new URLSearchParams({ workspace, sessionId });
    const res = await fetch('http://127.0.0.1:' + port + '/api/settings?' + q, { headers: { Authorization: core.bearerHeaderValue(token) }, signal: AbortSignal.timeout(15000) });
    process.stdout.write(JSON.stringify({ status: res.status, body: await res.json() }));
  } catch (err) {
    process.stdout.write(JSON.stringify({ error: String(err && err.message || err) }));
  }
})();
`;

/** Whether the daemon reads back what the arm's settings say: the session's run settings, and the parallel limit from the box's environment. */
export function judgeSettingsReadback(settings, response) {
  if (!response || response.error || response.status !== 200) {
    return { ok: false, failures: [`the daemon could not be asked: ${response?.error ?? `status ${response?.status ?? 'none'}`}`] };
  }
  const run = response.body?.run ?? {};
  const failures = [];
  const want = [
    ['supervisorLevel', run.supervisorLevel, settings.supervisorLevel],
    ['autorun', run.autorun, settings.autorun],
    ['mergeAtGatesAutomatically', run.mergeAtGatesAutomatically, settings.automerge],
    ['maxParallel', response.body?.maxParallel, settings.parallel],
  ];
  for (const [key, got, expected] of want) if (got !== expected) failures.push(`${key} is ${JSON.stringify(got)}, not ${JSON.stringify(expected)}`);
  return { ok: failures.length === 0, failures, read: { supervisorLevel: run.supervisorLevel, autorun: run.autorun, mergeAtGatesAutomatically: run.mergeAtGatesAutomatically, maxParallel: response.body?.maxParallel } };
}

/**
 * Names the driver on everything it starts, as `<host>/<pid>`, so `--sweep`
 * can tell a box whose driver was killed from one whose driver still runs.
 */
export const DRIVER_LABEL = 'commit0-bench-driver';
export const driverId = () => `${os.hostname()}/${process.pid}`;
export function parseDriver(value) {
  const m = /^(.+)\/(\d+)$/.exec(value ?? '');
  return m ? { host: m[1], pid: Number(m[2]) } : null;
}

/** The box's quota (D4) and its parallel limit, as `docker run` arguments: swap is held to the memory quota, or the quota would not bind. */
export function boxRunArgs({ cpus, memory, parallel, driver }) {
  return ['--cpus', String(cpus), '--memory', memory, '--memory-swap', memory, '--label', `${DRIVER_LABEL}=${driver}`, '-e', `ORDEWELL_MAX_PARALLEL=${parallel}`];
}

/** A `--memory` size in bytes as the engine holds it: binary units, as docker's own parser reads them. */
export function dockerBytes(size) {
  const m = /^(\d+(?:\.\d+)?)([bkmg]?)$/i.exec(String(size));
  if (!m) return null;
  const power = { '': 0, b: 0, k: 1, m: 2, g: 3 }[m[2].toLowerCase()];
  return Math.trunc(Number(m[1]) * 1024 ** power);
}

/**
 * What `--sweep` removes: a labelled container or network whose driver ran on
 * this host and is dead. One from another host, or naming no driver, is left
 * with the reason, since nothing here says its driver is gone.
 */
export function sweepTargets(items, { host = os.hostname(), isAlive = pidAlive } = {}) {
  const remove = [];
  const keep = [];
  for (const item of items) {
    const d = parseDriver(item.driver);
    if (!d) keep.push({ ...item, why: 'it names no driver' });
    else if (d.host !== host) keep.push({ ...item, why: `its driver ran on ${d.host}` });
    else if (isAlive(d.pid)) keep.push({ ...item, why: `its driver, pid ${d.pid}, is running` });
    else remove.push(item);
  }
  return { remove, keep };
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
 * The cap a watchdog enforces, read every poll, on the largest spend it knows.
 * The session's recorded spend (recordedSpend) counts every call Ordewell made
 * for the run, B's planner included; the key's delta counts every caller, so
 * it is passed only for a run alone on the key, and the transcripts are the
 * floor when the session cannot be read.
 */
export function capDecision({ elapsedMs, recordedSpentUsd, keySpentUsd, transcriptSpentUsd, capUsd, wallCapMs = WALL_CAP_MS }) {
  const spent = Math.max(recordedSpentUsd ?? 0, keySpentUsd ?? 0, transcriptSpentUsd ?? 0);
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

// --- Watching a run ---------------------------------------------------------

/** Every task of a plan, subtasks included, depth first. */
export function allTasks(plan) {
  const out = [];
  const walk = (tasks) => {
    for (const t of tasks ?? []) {
      out.push(t);
      walk(t.subtasks);
    }
  };
  walk(plan?.tasks);
  return out;
}

const isOpen = (t) => t.status !== 'completed' && t.status !== 'skipped';
/** A task with an open subtask has not landed, whatever its own status says. */
const isClosed = (t) => !isOpen(t) && (t.subtasks ?? []).every(isClosed);

/**
 * The task a person must answer before the run can go on: one parked on a
 * checkpoint or an input, an open user task, or one core's waitsForApproval (Task.ts) leaves
 * for the user. None while any attempt runs, since that attempt may still
 * finish the run; a usage limit waits on the clock, not a person.
 */
export function waitingOnPerson(plan) {
  const tasks = allTasks(plan);
  if (tasks.some((t) => t.status === 'in_progress')) return null;
  const approved = plan?.approved === true;
  const record = plan?.approvedTasks ?? [];
  for (const t of tasks) {
    let waiting = null;
    if (t.status === 'awaiting_user' && (t.awaitingReason === 'checkpoint' || t.awaitingReason === 'input')) waiting = t.awaitingReason;
    // A user task is a person's to do: nobody in the bench does it, so the run waits on it.
    else if (approved && t.type === 'user' && (t.status === 'pending' || t.status === 'approved')) waiting = 'user-task';
    else if (approved && t.type !== 'user' && (t.status === 'pending' || t.status === 'approved') && !record.includes(t.id)) waiting = 'approval';
    if (waiting) return { task: { id: t.id, title: t.title }, waiting, question: t.parkedQuestion ?? null };
  }
  return null;
}

/**
 * Whether a run has stalled: a person waited on, with nothing running, for
 * stallMs. `sinceMs` is when the wait was first seen, carried poll to poll;
 * the stall records how long it lasted.
 */
export function stallDecision({ plan, nowMs, sinceMs, stallMs }) {
  const w = waitingOnPerson(plan);
  if (!w) return { sinceMs: null, stalled: null };
  const since = sinceMs ?? nowMs;
  return { sinceMs: since, stalled: nowMs - since >= stallMs ? { ...w, sinceMs: nowMs - since } : null };
}

/** What moves while a run goes on: every task's status and attempt, and the model calls made. */
export function planFingerprint(plan, usageLines) {
  return JSON.stringify([usageLines, allTasks(plan).map((t) => [t.id, t.status, t.awaitingReason ?? null, t.attempted ?? null])]);
}

/**
 * Whether a run is over (D5): no attempt running, nobody waited on, some AI
 * task tried or ended, and nothing moved for settleMs. `ordewell run`'s exit
 * says none of this: it may exit non-zero on a failed task, or return before
 * the supervisor's closing turn retries one.
 */
export function settleDecision({ plan, fingerprint, nowMs, state, settleMs = SETTLE_MS }) {
  const tasks = allTasks(plan).filter((t) => (t.type ?? 'ai') === 'ai');
  const quiet = plan && !tasks.some((t) => t.status === 'in_progress') && !waitingOnPerson(plan)
    && tasks.some((t) => t.attempted || !isOpen(t) || t.status === 'failed');
  if (!quiet) return { settled: false, state: null };
  const next = state && state.fingerprint === fingerprint ? state : { fingerprint, sinceMs: nowMs };
  return { settled: nowMs - next.sinceMs >= settleMs, state: next };
}

// --- Choosing what is scored --------------------------------------------------

/** `git worktree list --porcelain` as `{path, branch}`; a detached one's branch is null. */
export function parseWorktrees(porcelain) {
  const out = [];
  for (const block of porcelain.split(/\n\s*\n/)) {
    const wt = /^worktree (.+)$/m.exec(block);
    if (!wt) continue;
    const br = /^branch refs\/heads\/(.+)$/m.exec(block);
    out.push({ path: wt[1], branch: br ? br[1] : null });
  }
  return out;
}

/**
 * Each top-level AI task, whether its work landed, and where its work is if
 * not: its own worktree while git still lists it, never the run's integration
 * worktree; else the newest `ordewell-preserved/<run>/<name>[-N]` branch that
 * core's preserve() left; else its own branch. A task whose subtask is open,
 * or whose isolation never merged, has not landed.
 */
export function choosePatches({ plan, worktrees, branches }) {
  const iso = plan?.isolation;
  const runId = iso?.run?.id ?? null;
  const integrationBranches = new Set((iso?.run?.repos ?? []).map((r) => r.integrationBranch).filter(Boolean));
  const listed = new Map(worktrees.map((w) => [path.posix.normalize(w.path), w]));
  const branchSet = new Set(branches);
  const integrationRoot = runId && iso.run.workspaceRoot ? path.posix.join(iso.run.workspaceRoot, '.ordewell', 'worktrees', runId, 'integration') : null;
  const isIntegration = (p) => {
    const n = path.posix.normalize(p);
    return Boolean(integrationRoot && (n === integrationRoot || n.startsWith(`${integrationRoot}/`))) || integrationBranches.has(listed.get(n)?.branch);
  };
  const out = [];
  for (const t of plan?.tasks ?? []) {
    if ((t.type ?? 'ai') !== 'ai') continue;
    const rec = iso?.tasks?.[t.id];
    // A merged record's worktree is gone and its work is on the integration branch; a released one drops its record.
    const landed = isClosed(t) && (!rec || rec.status === 'merged');
    let source = null;
    if (!landed) {
      const wt = rec?.repos?.['.']?.worktree ?? rec?.workspace;
      if (wt && listed.has(path.posix.normalize(wt)) && !isIntegration(wt)) source = { kind: 'worktree', path: wt };
      else {
        const name = rec?.workspace ? path.posix.basename(rec.workspace) : null;
        const preserved = name && runId ? branches.filter((b) => b === `ordewell-preserved/${runId}/${name}` || new RegExp(`^ordewell-preserved/${escapeRe(runId)}/${escapeRe(name)}-(\\d+)$`).test(b)) : [];
        const n = (b) => Number(/-(\d+)$/.exec(b.slice(`ordewell-preserved/${runId}/${name}`.length))?.[1] ?? 1);
        preserved.sort((a, b) => n(b) - n(a));
        if (preserved.length) source = { kind: 'branch', ref: preserved[0] };
        else if (rec?.branch && branchSet.has(rec.branch) && !integrationBranches.has(rec.branch)) source = { kind: 'branch', ref: rec.branch };
      }
    }
    out.push({ taskId: t.id, order: t.order ?? null, title: t.title, status: t.status, isolation: rec?.status ?? null, landed, source });
  }
  return out;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A task's work as a binary diff from the flattened commit. From a worktree,
 * its committed and uncommitted work, new files included through an
 * intent-to-add; from a branch, the branch's tip. The venv is never in it.
 */
export function taskPatchScript(lib, source) {
  const flat = shellQuote(lib.flatCommit);
  if (source.kind === 'worktree') {
    return `cd ${shellQuote(source.path)} && ${INTENT_TO_ADD()} && git diff --binary ${flat} -- . ${UNSCORED()}`;
  }
  return `git diff --binary ${flat} ${shellQuote(source.ref)} -- . ${UNSCORED()}`;
}

export const applyPatchCommand = (file) => `git apply --binary --whitespace=nowarn ${shellQuote(file)}`;

/**
 * What an arm is scored on. A (D2) on its working tree's final state: an
 * unlanded task's work is applied to the workspace first. B (D3) only on
 * what Ordewell merged; its unlanded work is kept for diagnosis, never scored.
 */
export function scoringPlan(arm, chosen) {
  if (arm.id === 'A') {
    const apply = chosen.find((c) => !c.landed && c.source) ?? null;
    return { scoredFrom: apply ? 'task-worktree' : 'merged', apply, diagnostic: [] };
  }
  return { scoredFrom: 'merged', apply: null, diagnostic: chosen.filter((c) => !c.landed && c.source) };
}

/**
 * Whether a run's work is partial: stopped at a cap, stalled, or leaving a
 * task (or a subtask) not completed. Judged on the session's tasks, never on
 * `ordewell run`'s exit (D5).
 */
export function judgeLanding({ stopped, stalled, plan }) {
  if (stopped) return { truncated: true, why: `cap: ${stopped.why}` };
  if (stalled) return { truncated: true, why: `stalled: waiting on ${stalled.waiting}` };
  if (!plan) return { truncated: true, why: 'blocked: no plan to read' };
  const open = (plan.tasks ?? []).filter((t) => !isClosed(t)).length;
  if (open > 0) return { truncated: true, why: `blocked: ${open} task${open === 1 ? '' : 's'} not completed` };
  return { truncated: false, why: null };
}

// --- Validity -----------------------------------------------------------------

/** The sources a packed dist must be newer than. */
export const FRESHNESS_SOURCES = Object.freeze(['packages/core/src', 'packages/web/server', 'packages/cli/src']);

/**
 * Whether the dist about to be packed was built from the tree whose sha the
 * result records: its oldest file no older than the newest tracked source.
 * An allowed stale dist runs, and the result says so.
 */
export function distFreshness({ dists, sources, allowStale = false }) {
  if (dists.length === 0) return { ok: false, stale: true, allowed: false, detail: 'no dist: build the tree first' };
  const oldest = dists.reduce((a, b) => (b.mtimeMs < a.mtimeMs ? b : a));
  const newest = sources.reduce((a, b) => (!a || b.mtimeMs > a.mtimeMs ? b : a), null);
  const stale = Boolean(newest && oldest.mtimeMs < newest.mtimeMs);
  const detail = stale ? `${oldest.path} is older than ${newest.path}` : `${oldest.path} is newer than every tracked source`;
  return { ok: !stale || allowStale, stale, allowed: stale && allowStale, detail };
}

/** A failed check is one that neither was expected to fail nor could not be verified. */
export const failedCheck = (c) => !c.ok && !c.unverified && !c.expectedFailure;

/** Every reason a result is not one to compare. */
export function judgeValidity({ aborted, checks, tests, freshness, stopped = null, dryRun = false }) {
  const reasons = [];
  if (aborted) reasons.push(`aborted: ${aborted}`);
  for (const c of checks ?? []) if (failedCheck(c)) reasons.push(`failed check: ${c.scope}: ${c.name}`);
  // The batch stops every run at one instant, so this arm got less time and spend than its pair (D1).
  if (stopped?.why === 'batch-budget') reasons.push('stopped by the batch budget');
  if (dryRun) reasons.push('dry run: no arm ran');
  else if (tests?.timedOut) reasons.push('eval timed out');
  else if (!tests || tests.passed === undefined) reasons.push('eval gave no summary');
  else if (typeof tests.collected === 'number') {
    // Each test has at most one call outcome; errors are left out, since a test
    // that passes and then errors in teardown is counted under both.
    const outcomes = ['passed', 'failed', 'skipped', 'xfailed', 'xpassed'].reduce((n, k) => n + (tests[k] ?? 0), 0);
    if (outcomes > tests.collected) reasons.push(`more outcomes than the reference collected: ${outcomes} > ${tests.collected}`);
  }
  if (freshness?.stale && freshness.allowed) reasons.push('stale dist allowed');
  return { valid: reasons.length === 0, invalidReasons: reasons };
}

/**
 * The stub baseline. One that collects nothing is the library's own (the
 * stubs of networkx and sphinx do not import), recorded with its reason
 * rather than failed; one with no summary at all is still a failure.
 */
export function baselineRecord(evaluation) {
  if (!evaluation || evaluation.passed === undefined) return { ok: false, baseline: null };
  const collected = evaluation.passed + evaluation.failed + evaluation.errors + (evaluation.skipped ?? 0);
  if (evaluation.collectionError) return { ok: true, baseline: { collected: 0, reason: evaluation.collectionError } };
  if (collected === 0) return { ok: true, baseline: { collected: 0, reason: 'pytest collected no test' } };
  return { ok: true, baseline: null };
}

/** One library's result for one arm, with every field the comparison reports. */
export function resultRecord({ lib, arm, settings = armSettings(arm), window, ordewell, egress, leak, network, tests, baseline, wallClockMs, spend, transcripts, stopped, stalled, truncated, scoredFrom, patches, validity, providerPin, dryRun, startedAt, endedAt }) {
  return {
    library: lib.name,
    arm: arm.id,
    dryRun,
    valid: validity?.valid ?? null,
    invalidReasons: validity?.invalidReasons ?? [],
    ...settings,
    model: MODEL_ID,
    providerPin: providerPin ?? null,
    ordewellSha: ordewell.sha,
    pr177Merge: PR177_MERGE,
    containsPr177: ordewell.containsPr177,
    staleDistAllowed: ordewell.staleDistAllowed ?? false,
    contextWindow: window.window,
    windowCheck: window,
    egress,
    leak,
    networkDeselected: network?.deselected ?? null,
    tests: tests ? { passed: tests.passed, collected: tests.collected, failed: tests.failed, errors: tests.errors, skipped: tests.skipped, collectionErrors: tests.collectionErrors ?? [], exit: tests.exit ?? null, timedOut: tests.timedOut ?? false } : null,
    baseline: baseline ?? null,
    wallClockMs: wallClockMs ?? null,
    billedUsd: spend?.billedUsd ?? null,
    billedSource: spend?.source ?? null,
    runnerReportedUsd: transcripts?.spendUsd ?? null,
    peakContext: transcripts?.peakContext ?? null,
    compactions: transcripts?.compactions ?? null,
    windowFallbackSuspected: transcripts && window.window ? windowFallbackSuspected(transcripts.compactionPreTokens, window.window) : null,
    stopped: stopped ?? null,
    stalled: stalled ?? null,
    truncated: truncated ?? { truncated: false, why: null },
    scoredFrom: scoredFrom ?? null,
    patches: patches ?? [],
    stepLimit: STEP_LIMIT,
    startedAt,
    endedAt,
  };
}

// --- Recorded spend and run metrics -----------------------------------------

/** What one model call record's provider reported it cost in dollars; undefined when it reported none. */
const reportedUsd = (usage) => {
  const n = usage?.totals?.reportedCost?.USD;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
};

/**
 * Every model call Ordewell recorded for the session, in dollars as the
 * provider reported them: the planner's ledger (`plan.plannerUsage`, its
 * turns and the supervisor's wake-up turns alike, core's PlannerUsageLedger)
 * and each attempt's (`task.attemptUsage`, subtasks included, as core's
 * `planUsage` sums them). Unlike the runner transcripts, it counts the
 * planner. An attempt with no reported price is counted as unpriced, never
 * guessed; usd is null when nothing was priced at all.
 */
export function recordedSpend(plan) {
  const plannerUsd = reportedUsd(plan?.plannerUsage) ?? null;
  let attemptsUsd = null;
  let attempts = 0;
  let unpriced = 0;
  for (const t of allTasks(plan)) {
    for (const u of t.attemptUsage ?? []) {
      attempts++;
      const n = reportedUsd(u);
      if (n === undefined) unpriced++;
      else attemptsUsd = (attemptsUsd ?? 0) + n;
    }
  }
  const usd = plannerUsd === null && attemptsUsd === null ? null : round6((plannerUsd ?? 0) + (attemptsUsd ?? 0));
  return { usd, plannerUsd, attemptsUsd: attemptsUsd === null ? null : round6(attemptsUsd), attempts, unpriced };
}

/**
 * The plan's longest dependency chain and its widest level, a task's level
 * being one more than its deepest dependency's. Top-level tasks only, as the
 * plan orders them; null for a plan with none, a cycle or a dependency on no task.
 */
export function planShape(plan) {
  const tasks = plan?.tasks ?? [];
  const none = { longestChain: null, widestLevel: null };
  if (!tasks.length) return none;
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const level = new Map();
  const visit = (t, stack) => {
    if (level.has(t.id)) return level.get(t.id);
    if (stack.has(t.id)) return null;
    stack.add(t.id);
    let deepest = 0;
    for (const d of t.dependencies ?? []) {
      const dep = byId.get(d);
      const l = dep ? visit(dep, stack) : null;
      if (l === null) return null;
      deepest = Math.max(deepest, l);
    }
    stack.delete(t.id);
    level.set(t.id, deepest + 1);
    return deepest + 1;
  };
  for (const t of tasks) if (visit(t, new Set()) === null) return none;
  const widths = new Map();
  for (const l of level.values()) widths.set(l, (widths.get(l) ?? 0) + 1);
  return { longestChain: Math.max(...level.values()), widestLevel: Math.max(...widths.values()) };
}

/**
 * The mean number of attempts running at once while any ran: their summed
 * wall time over the length of the union of their intervals. Null with none,
 * or with one that has no end, since its length would be a guess.
 */
export function meanConcurrency(attemptUsages) {
  const spans = [];
  for (const u of attemptUsages ?? []) {
    const s = Date.parse(u.startedAt);
    const e = Date.parse(u.endedAt);
    if (!Number.isFinite(s) || !Number.isFinite(e)) return null;
    spans.push([s, Math.max(s, e)]);
  }
  if (!spans.length) return null;
  spans.sort((a, b) => a[0] - b[0]);
  let union = 0;
  let sum = 0;
  let [from, to] = spans[0];
  for (const [s, e] of spans) {
    sum += e - s;
    if (s > to) {
      union += to - from;
      [from, to] = [s, e];
    } else to = Math.max(to, e);
  }
  union += to - from;
  return union > 0 ? round6(sum / union) : null;
}

const toolName = (name, tool) => name === tool || String(name).endsWith(`__${tool}`);
const parseArgsJson = (s) => { try { return JSON.parse(s); } catch { return null; } };

/** Who answered a checkpoint, read from core's reply to the model (checkpointReply, services/mcp/tools.ts). */
function checkpointAnswer(output) {
  const m = /^(approved|rejected): the (supervisor|user) said/.exec(output ?? '');
  if (m) return { answeredBy: m[2], answer: m[1] };
  if (/^The checkpoint was withdrawn/.test(output ?? '')) return { answeredBy: 'withdrawn', answer: 'withdrawn' };
  return { answeredBy: null, answer: null };
}

/**
 * What explains a run's result, read from its session: the plan as core saved
 * it and, when the session's task logs were copied out, each attempt's log
 * (readTaskLogs). A figure the session does not hold is null, never guessed.
 * Steps count the runner's own tool calls, a subagent's left out.
 */
export function runMetrics(plan, taskLogs) {
  if (!plan) return null;
  const tasks = allTasks(plan);
  const count = (f) => tasks.filter(f).length;
  const blocked = (t) => t.verdict?.reported === 'blocked' && t.status !== 'completed';
  const counts = {
    total: tasks.length,
    passed: count((t) => t.status === 'completed'),
    failed: count((t) => t.status === 'failed' && !blocked(t)),
    blocked: count(blocked),
    skipped: count((t) => t.status === 'skipped'),
  };
  counts.open = counts.total - counts.passed - counts.failed - counts.blocked - counts.skipped;
  counts.hitl = count((t) => t.autonomy === 'HITL' || t.sliceType === 'HITL');
  counts.user = count((t) => t.type === 'user');

  const attemptsOf = (t) => {
    const logs = taskLogs?.[t.id] ?? {};
    const numbers = new Set([...(t.attemptUsage ?? []).map((u) => u.attempt), ...Object.keys(logs).map(Number)]);
    return [...numbers].sort((a, b) => a - b).map((n) => ({ n, usage: (t.attemptUsage ?? []).find((u) => u.attempt === n), events: logs[n] ?? null }));
  };
  const checkpoints = taskLogs ? [] : null;
  const perTask = tasks.map((t) => {
    const attempts = attemptsOf(t).map(({ n, usage, events }) => {
      let ended = null;
      let steps = null;
      if (events) {
        const calls = events.filter((e) => e.type === 'tool_call' && !e.subagentId);
        steps = calls.length;
        const done = calls.filter((c) => toolName(c.name, 'task_complete')).pop();
        ended = done ? (parseArgsJson(done.args)?.status ?? 'task_complete without a status') : 'ended without task_complete';
        for (const c of calls.filter((x) => toolName(x.name, 'checkpoint'))) {
          const reply = events.find((e) => e.type === 'tool_result' && e.id === c.id);
          checkpoints.push({ taskId: t.id, attempt: n, question: parseArgsJson(c.args)?.question ?? null, ...checkpointAnswer(reply?.output) });
        }
      }
      return { attempt: n, ended, steps, runningMs: usage?.runningMs ?? null };
    });
    const logged = attempts.filter((a) => a.steps !== null);
    return {
      id: t.id, order: t.order ?? null, title: t.title ?? null, type: t.type ?? null, status: t.status ?? null,
      runningMs: attempts.some((a) => a.runningMs === null) ? null : attempts.reduce((s, a) => s + a.runningMs, 0),
      steps: logged.length && logged.length === attempts.length ? logged.reduce((s, a) => s + a.steps, 0) : null,
      attempts,
    };
  });

  const history = Array.isArray(plan.conversationHistory) ? plan.conversationHistory : null;
  const supervisor = {
    wakeUps: history ? history.filter((m) => m.kind === 'wake_up').length : null,
    actions: history ? history.filter((m) => m.kind === 'execution' && m.execution?.actor === 'supervisor')
      .map(({ execution: x }) => ({ command: x.command, task: x.task?.ref ?? null, outcome: x.outcome, at: x.at })) : null,
  };
  return {
    tasks: counts,
    checkpoints,
    supervisor,
    perTask,
    plan: planShape(plan),
    meanConcurrentAttempts: meanConcurrency(tasks.flatMap((t) => t.attemptUsage ?? [])),
  };
}

/** Core's path segment for an id (utils/sessionDir.ts idSegment). */
const idSegment = (id) => (/^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/.test(id) ? id : `~${Buffer.from(id, 'utf-8').toString('hex')}`);

/**
 * Each task's attempt logs from a copied-out `.ordewell` directory, as core
 * writes them (utils/taskLogStore.ts): `sessions/<session>/tasks/<task>/<n>.jsonl`.
 * Null when the session has no log directory; a line that does not parse is skipped.
 */
export function readTaskLogs(ordewellDir, sessionId, plan) {
  const root = path.join(ordewellDir, 'sessions', idSegment(sessionId), 'tasks');
  if (!fs.existsSync(root)) return null;
  const out = {};
  for (const t of allTasks(plan)) {
    const dir = path.join(root, idSegment(t.id));
    out[t.id] = {};
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const name of names) {
      const n = /^([1-9]\d*)\.jsonl$/.exec(name)?.[1];
      if (!n) continue;
      out[t.id][n] = fs.readFileSync(path.join(dir, name), 'utf8').split('\n').filter(Boolean)
        .map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
    }
  }
  return out;
}

// --- Batches ----------------------------------------------------------------

/** The share of the host's memory a batch's boxes may hold between them, the rest left to the host. */
export const BATCH_MEMORY_SHARE = 0.8;
export const JOBS = 2;
/** The file in a batch's directory whose presence tells every run of the batch to stop: the batch budget is spent. */
export const BATCH_STOP_FILE = 'stop';

/** Whether `jobs` boxes at their fixed quotas fit the host: CPUs at most its count, memory at most 80% of it. */
export function capacityCheck({ jobs, cpus, memory, hostCpus, hostMemBytes }) {
  const failures = [];
  const wantCpus = jobs * cpus;
  if (wantCpus > hostCpus) failures.push(`${jobs} runs × ${cpus} cpus = ${wantCpus} cpus, the host has ${hostCpus}: lower --jobs or --cpus`);
  const each = dockerBytes(memory);
  const gib = (b) => `${round6(b / 2 ** 30)}g`;
  if (each === null) failures.push(`--memory ${memory} is not a docker size`);
  else if (jobs * each > BATCH_MEMORY_SHARE * hostMemBytes) {
    failures.push(`${jobs} runs × ${memory} = ${gib(jobs * each)}, above 80% of the host's ${gib(hostMemBytes)}: lower --jobs or --memory`);
  }
  return { ok: failures.length === 0, failures };
}

/** The key's lifetime usage in dollars from OpenRouter's /api/v1/key; null without a key or on any failure. */
export async function keyUsage(key, fetchImpl = fetch) {
  if (!key) return null;
  try {
    const res = await fetchImpl('https://openrouter.ai/api/v1/key', { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;
    const body = await res.json();
    return typeof body?.data?.usage === 'number' ? body.data.usage : null;
  } catch {
    return null;
  }
}

/**
 * The key's usage when a paid batch begins, retried; an error when it never
 * reads, since the batch budget measures from it and could stop nothing.
 */
export async function startingKeyUsage({ read, tries = 5, waitMs = 10_000 }) {
  for (let i = 0; i < tries; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, waitMs));
    const usd = await read();
    if (usd !== null) return usd;
  }
  throw new Error(`the key's usage could not be read in ${tries} tries: the batch budget would have nothing to measure from, so the batch does not start`);
}

/** The key's usage once it stops moving: OpenRouter books a call some seconds after it returns. */
export async function settledKeyUsage(key, { read = () => keyUsage(key), waitMs = 15_000, tries = 8 } = {}) {
  let last = await read();
  for (let i = 0; i < tries; i++) {
    await new Promise((r) => setTimeout(r, waitMs));
    const now = await read();
    if (now !== null && now === last) return now;
    last = now;
  }
  return last;
}

/** Whether the key's delta since the batch began has reached the batch budget. An unread key stops nothing. */
export function budgetDecision({ keyBeforeUsd, keyNowUsd, budgetUsd }) {
  if (keyBeforeUsd == null || keyNowUsd == null) return { stop: false, spentUsd: null };
  const spentUsd = round6(keyNowUsd - keyBeforeUsd);
  return { stop: budgetUsd != null && spentUsd >= budgetUsd, spentUsd };
}

/**
 * A run's id: its directory's name and its box's, network's and proxy's
 * (`commit0-<id>-…`). The library, the arm and the seed make it unique within
 * a batch, which never holds a pair twice (batchPlan).
 */
export function runIdFor({ stamp, lib, arm, seed = null }) {
  return [stamp.slice(0, 19), lib, arm, ...(seed ? [seed] : [])].join('-').toLowerCase().replace(/[^a-z0-9-]/g, '-');
}

/**
 * batch.json: the key's usage around the batch against the sum of what
 * Ordewell recorded for its runs. The gap is what the records do not explain
 * (a run's unpriced calls, or a call outside the batch on the same key). When
 * runs overlapped, no run's own key delta exists, and each says so.
 */
export function batchRecord({ keyBeforeUsd, keyAfterUsd, budgetUsd, stoppedByBudget, jobs, overlapped, seed, dryRun, startedAt, endedAt, runs }) {
  const recorded = runs.map((r) => r.recordedUsd).filter((n) => typeof n === 'number');
  const recordedSumUsd = recorded.length ? round6(recorded.reduce((a, b) => a + b, 0)) : null;
  const keyDeltaUsd = keyBeforeUsd != null && keyAfterUsd != null ? round6(keyAfterUsd - keyBeforeUsd) : null;
  return {
    dryRun, seed: seed ?? null, jobs, overlapped, startedAt, endedAt,
    keyBeforeUsd: keyBeforeUsd ?? null,
    keyAfterUsd: keyAfterUsd ?? null,
    keyDeltaUsd,
    recordedSumUsd,
    unrecordedRuns: runs.filter((r) => typeof r.recordedUsd !== 'number').map((r) => `${r.lib} ${r.arm}`),
    gapUsd: keyDeltaUsd !== null && recordedSumUsd !== null ? round6(keyDeltaUsd - recordedSumUsd) : null,
    budgetUsd: budgetUsd ?? null,
    stoppedByBudget,
    perRunKeyBilled: overlapped ? 'not available: the runs overlapped on one key' : 'each run\'s result.json, its key delta',
    runs,
  };
}

/** The runs of a batch, library by library and arm by arm; a library named twice would give two runs one name. */
export function batchPlan({ libs, arms, seed }) {
  const seen = new Set();
  for (const name of libs) {
    if (seen.has(name)) throw new Error(`library ${name} is listed twice: each run of a batch needs its own name`);
    seen.add(name);
  }
  return libs.flatMap((lib) => arms.map((arm) => ({ lib, arm, seed })));
}

// --- Command line -----------------------------------------------------------

export function parseArgs(argv) {
  const out = {
    dryRun: false, run: false, fixture: false, arm: 'both', libs: null, only: [], image: null, providerPin: null, keep: false, help: false,
    capUsd: CAP_USD, parallel: PARALLEL, cpus: CPUS, memory: MEMORY, stallMin: STALL_MIN, ordewellRoot: null, allowStaleDist: false, sweep: false,
    seed: null, batchDir: null, batchShared: false,
  };
  const number = (name, v, ok) => {
    const n = Number(v);
    if (!Number.isFinite(n) || !ok(n)) throw new Error(`${name} takes ${name === '--parallel' ? 'a whole number, 1 or more' : 'a number above 0'}, not ${v}`);
    return n;
  };
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
    else if (a === '--cap-usd') out.capUsd = number(a, value(), (n) => n > 0);
    else if (a === '--parallel') out.parallel = number(a, value(), (n) => Number.isInteger(n) && n >= 1);
    else if (a === '--cpus') out.cpus = number(a, value(), (n) => n > 0);
    else if (a === '--memory') {
      const v = value();
      if (!/^\d+(\.\d+)?[bkmg]?$/i.test(v)) throw new Error(`--memory takes a docker size such as 12g, not ${v}`);
      out.memory = v;
    } else if (a === '--stall-min') out.stallMin = number(a, value(), (n) => n > 0);
    else if (a === '--ordewell-root') out.ordewellRoot = path.resolve(value());
    else if (a === '--allow-stale-dist') out.allowStaleDist = true;
    else if (a === '--sweep') out.sweep = true;
    else if (a === '--seed') out.seed = seedLabel(value());
    // Set by batch.mjs on each run it starts: the batch holds the key and its results.
    else if (a === '--batch-dir') out.batchDir = path.resolve(value());
    else if (a === '--batch-shared') out.batchShared = true;
    else throw new Error(`unknown argument ${a}`);
  }
  if (out.batchShared && !out.batchDir) throw new Error('--batch-shared is for a run batch.mjs starts, with --batch-dir');
  if (out.help || (out.sweep && !out.dryRun && !out.run)) return out;
  // Spending is never the default: a run that bills the key has to say so.
  if (out.dryRun === out.run) throw new Error('pass --dry-run to set up and check without a model call, or --run to run the arms and spend');
  if (out.fixture && !out.dryRun) throw new Error('--fixture is a dry-run library: pass --dry-run with it');
  if (out.fixture && !out.image) throw new Error('--fixture needs --image: an image with python3, pytest and git to build it in');
  if (!out.fixture && !out.libs) throw new Error('pass --libs <file>, a list of libraries as libraries.example.json shows, or --fixture');
  if (out.run && !out.providerPin) throw new Error('a run needs --provider-pin <provider>: the one OpenRouter provider the key is pinned to');
  return out;
}

function seedLabel(v) {
  if (!/^[\w.-]{1,40}$/.test(v)) throw new Error(`--seed takes a label of letters, digits, ".", "_" and "-", not ${v}`);
  return v;
}

/** What batch.mjs passes on to each run as given, beside the libraries file. */
const BATCH_PASSED = Object.freeze({
  flags: ['--dry-run', '--run', '--allow-stale-dist', '--keep'],
  values: ['--provider-pin', '--cap-usd', '--parallel', '--cpus', '--memory', '--stall-min', '--ordewell-root'],
});

/**
 * batch.mjs's options: its own (--jobs, --batch-budget-usd, --seed, --only,
 * --arm, --sweep), and every run's, checked as drive.mjs checks them and
 * passed on in `driveArgs`.
 */
export function parseBatchArgs(argv) {
  const own = { jobs: JOBS, budgetUsd: null, seed: null, only: [], arm: 'both', sweep: false, help: false };
  const driveArgs = [];
  const positive = (name, v, ok, what) => {
    const n = Number(v);
    if (!Number.isFinite(n) || !ok(n)) throw new Error(`${name} takes ${what}, not ${v}`);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === '--help' || a === '-h') own.help = true;
    else if (a === '--jobs') own.jobs = positive(a, value(), (n) => Number.isInteger(n) && n >= 1, 'a whole number, 1 or more');
    else if (a === '--batch-budget-usd') own.budgetUsd = positive(a, value(), (n) => n > 0, 'a number above 0');
    else if (a === '--seed') own.seed = seedLabel(value());
    else if (a === '--only') own.only.push(...value().split(',').filter(Boolean));
    else if (a === '--arm') {
      const v = value().toUpperCase();
      if (!['A', 'B', 'BOTH'].includes(v)) throw new Error('--arm takes A, B or both');
      own.arm = v === 'BOTH' ? 'both' : v;
    } else if (a === '--sweep') own.sweep = true;
    else if (a === '--libs') driveArgs.push(a, path.resolve(value()));
    else if (a === '--ordewell-root') driveArgs.push(a, path.resolve(value()));
    else if (BATCH_PASSED.flags.includes(a)) driveArgs.push(a);
    else if (BATCH_PASSED.values.includes(a)) driveArgs.push(a, value());
    else throw new Error(`unknown argument ${a}`);
  }
  if (own.help) return { ...own, driveArgs };
  const run = parseArgs(driveArgs);
  if (!run.libs) throw new Error('a batch runs a list of libraries: pass --libs <file>');
  // The key's delta counts every run of the batch: on a key no cap of one run bounds that.
  if (run.run && own.budgetUsd === null) throw new Error('a paid batch needs --batch-budget-usd <usd>: the most the key may spend across the batch');
  return { ...run, ...own, driveArgs };
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
