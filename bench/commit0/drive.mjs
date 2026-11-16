#!/usr/bin/env node
// The Commit0 comparison's driver: per library and arm, a box on an internal
// network whose one way out is a gateway that opens openrouter.ai alone, the
// checks that make a result worth reading (the window, the egress, the
// reference implementation out of reach, the dependencies in the image), the
// arm itself, and the record. Its logic lives in lib.mjs; this file is the
// docker and git calls around it. See bench/README.md, "Commit0".
//
//   node bench/commit0/drive.mjs --dry-run --fixture --image <image>
//   node bench/commit0/drive.mjs --dry-run --libs <libraries.json>
//   node bench/commit0/drive.mjs --run --libs <libraries.json> --provider-pin <provider>

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT, checkedBenchDir } from '../lib/data-dir.mjs';
import * as L from './lib.mjs';

const HELP = `Usage: node bench/commit0/drive.mjs (--dry-run | --run) [options]

  --dry-run            set up the box and run every check; no model call, no key in the box
  --run                run the arms: spends on the OpenRouter key in OPENROUTER_API_KEY
  --libs <file>        the libraries, as libraries.example.json shows
  --only <a,b>         only these libraries of --libs
  --fixture            a synthetic library built in --image, to prove the checks (dry run only)
  --image <image>      the image for --fixture
  --arm A|B|both       which arms (default both)
  --provider-pin <p>   the OpenRouter provider the key is pinned to, recorded in every result
  --keep               leave the box and its network up after a dry run, for a look inside

Run data goes under ${'$'}ORDEWELL_BENCH_DIR or ~/.local/share/ordewell-bench/commit0, never the repository.`;

const LABEL = 'commit0-bench=1';
const NODE_IN_BOX = '/opt/node/bin/node';
const ORDEWELL_IN_BOX = '/opt/ordewell';
const BOX_HOME = '/root';
const POLL_MS = 30_000;
const EVAL_TIMEOUT_S = 1800;
const MERGE_TIMEOUT_MS = 15 * 60 * 1000;

const opts = (() => {
  try {
    return L.parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`${err.message}\n\n${HELP}`);
    process.exit(2);
  }
})();
if (opts.help) {
  console.log(HELP);
  process.exit(0);
}

/**
 * What every child of this process sees. A dry run drops the key from it, so
 * not even a `-e` written by mistake could carry it into the box.
 */
const hostEnv = { ...process.env };
if (opts.dryRun) delete hostEnv.OPENROUTER_API_KEY;

function exec(cmd, args, { input, timeoutMs, log, cwd } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env: hostEnv, cwd, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], shell: process.platform === 'win32' && cmd === 'npm' });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.on('data', (d) => { stdout += d; log?.write(d); });
    child.stderr.on('data', (d) => { stderr += d; log?.write(d); });
    const timer = timeoutMs ? setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs) : null;
    child.on('error', (err) => { stderr += String(err); });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr, timedOut });
    });
    if (child.stdin) {
      // A child that exits before reading its input is reported by its exit, not by a write error.
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    }
  });
}

const docker = (args, o) => exec('docker', args, o);

// --- Output -----------------------------------------------------------------

const checks = [];
function check(scope, name, ok, detail, { expectedFailure = false, unverified = false } = {}) {
  const entry = { scope, name, ok, detail, ...(expectedFailure ? { expectedFailure } : {}), ...(unverified ? { unverified } : {}) };
  checks.push(entry);
  const mark = unverified ? 'UNVERIFIED' : ok ? 'ok' : 'FAIL';
  const lines = Array.isArray(detail) ? detail : [detail];
  console.log(`  [${mark}] ${scope}: ${name}${lines[0] ? `: ${lines[0]}` : ''}`);
  for (const line of lines.slice(1)) console.log(`         ${line}`);
  return ok;
}

class Abort extends Error {}
const must = (ok, why) => { if (!ok) throw new Abort(why); };

// --- Preflight --------------------------------------------------------------

async function git(...args) {
  return exec('git', ['-C', REPO_ROOT, ...args]);
}

async function preflight() {
  const head = await git('rev-parse', 'HEAD');
  const sha = head.stdout.trim();
  const ancestor = await git('merge-base', '--is-ancestor', L.PR177_MERGE, 'HEAD');
  const containsPr177 = ancestor.code === 0;
  check('preflight', 'ordewell checkout', containsPr177, `${sha}, ${containsPr177 ? 'contains' : 'does not contain'} the PR 177 merge ${L.PR177_MERGE.slice(0, 12)}`);
  const dirty = (await git('status', '--porcelain', '--untracked-files=no')).stdout.trim();
  check('preflight', 'checkout clean', dirty === '' || opts.dryRun, dirty === '' ? 'no tracked change' : `tracked changes: the run would not be the commit it names${opts.dryRun ? ' (a dry run goes on)' : ''}`);
  const dists = ['packages/core/dist/index.js', 'packages/web/dist/server/main.js', 'packages/cli/dist/main.js'];
  const missing = dists.filter((d) => !fs.existsSync(path.join(REPO_ROOT, d)));
  check('preflight', 'built', missing.length === 0, missing.length ? `missing ${missing.join(', ')}: run npm run build` : 'core, web and cli dist present');
  const ver = await docker(['version', '--format', '{{.Server.Version}}']);
  check('preflight', 'docker', ver.code === 0, ver.code === 0 ? `engine ${ver.stdout.trim()}` : ver.stderr.trim());
  must(containsPr177 && missing.length === 0 && ver.code === 0 && (dirty === '' || opts.dryRun), 'preflight failed');
  const runtime = await prepareRuntime(sha, dirty !== '');
  return { sha, containsPr177, dirty: dirty !== '', runtime };
}

/**
 * The Ordewell the box runs: core, web and cli packed from this checkout as a
 * release would pack them, installed with the lockfile's versions of their
 * dependencies, outside the repository. The checkout's own node_modules will
 * not do: an Ordewell worktree's is links into another checkout, which mean
 * nothing inside the box and need not hold this commit's dependencies.
 */
async function prepareRuntime(sha, dirty) {
  const dir = path.join(checkedBenchDir('commit0', 'runtime'), dirty ? `${sha}-dirty` : sha);
  const coreEntry = path.join(dir, 'node_modules', '@ordewell', 'core', 'dist', 'index.js');
  const loads = async () => (await exec(process.execPath, ['-e', `if (typeof require(${JSON.stringify(coreEntry)}).fetchAllProviderModels !== 'function') process.exit(1)`])).code === 0;
  // A dirty checkout's dist may have moved since, so only a clean commit's runtime is reused.
  if (!dirty && fs.existsSync(coreEntry) && (await loads())) {
    check('preflight', 'runtime', true, `${dir} (packed earlier from ${sha.slice(0, 12)})`);
    return dir;
  }
  const tmp = `${dir}.tmp`;
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(path.join(tmp, 'tarballs'), { recursive: true });
  const packed = await exec('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', path.join(tmp, 'tarballs'),
    '-w', 'packages/core', '-w', 'packages/web', '-w', 'packages/cli'], { cwd: REPO_ROOT });
  let tarballs = [];
  try { tarballs = JSON.parse(packed.stdout).map((t) => ({ name: t.name, file: t.filename })); } catch { /* reported below */ }
  must(check('preflight', 'runtime packed', packed.code === 0 && tarballs.length === 3, packed.code === 0 ? tarballs.map((t) => t.file).join(', ') : packed.stderr.trim().split('\n').slice(-4)), 'npm pack failed');
  const lock = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package-lock.json'), 'utf8'));
  const overrides = {};
  for (const p of ['core', 'web', 'cli']) {
    const deps = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'packages', p, 'package.json'), 'utf8')).dependencies ?? {};
    for (const name of Object.keys(deps)) {
      const version = lock.packages?.[`node_modules/${name}`]?.version;
      if (!name.startsWith('@ordewell/') && version) overrides[name] = version;
    }
  }
  const manifest = {
    name: 'commit0-ordewell-runtime', private: true, description: `Ordewell ${sha} for the Commit0 box`,
    dependencies: Object.fromEntries(tarballs.map((t) => [t.name, `file:tarballs/${t.file}`])),
    overrides,
  };
  fs.writeFileSync(path.join(tmp, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  const installed = await exec('npm', ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: tmp, timeoutMs: 600_000 });
  must(check('preflight', 'runtime installed', installed.code === 0, installed.code === 0 ? `${Object.keys(overrides).length} dependencies at the lockfile's versions` : installed.stderr.trim().split('\n').slice(-4)), 'npm install failed');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.renameSync(tmp, dir);
  must(check('preflight', 'runtime', await loads(), `${dir}: core loads and exports fetchAllProviderModels`), 'the packed core does not load');
  return dir;
}

// --- The box ----------------------------------------------------------------

/**
 * One library's sandbox for one arm: an internal network, the gateway on it
 * and the bridge, and the box on it alone. The box runs the image's own
 * python and git, the host's node and the runtime packed from the checkout,
 * mounted read-only, so the Ordewell it runs is the commit the record names.
 */
async function openSandbox(lib, runId, runtime) {
  const name = `commit0-${runId}`;
  const sb = { name, network: `${name}-net`, proxy: `${name}-egress`, box: `${name}-box`, proxyUrl: null };
  const close = async () => {
    await docker(['rm', '-f', sb.box, sb.proxy]);
    await docker(['network', 'rm', sb.network]);
  };
  sb.close = close;
  const node = fs.realpathSync(process.execPath);
  const nodeMount = ['-v', `${node}:${NODE_IN_BOX}:ro`];

  const image = await docker(['image', 'inspect', '-f', '{{json .Config.Env}}', lib.image]);
  must(check(lib.name, 'image present', image.code === 0, image.code === 0 ? lib.image : `${lib.image} is not on this engine: pull or build it first`), 'no image');
  const imageEnv = JSON.parse(image.stdout || '[]');
  const imagePath = imageEnv.find((e) => e.startsWith('PATH='))?.slice(5) ?? '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

  const made = await docker(['network', 'create', '--internal', '--label', LABEL, sb.network]);
  must(made.code === 0, `network: ${made.stderr.trim()}`);
  try {
    const source = fs.readFileSync(path.join(REPO_ROOT, 'packages/core/src/services/container/egressSidecar.ts'), 'utf8');
    const entry = L.extractEgressEntry(source);
    const egress = JSON.stringify({ port: L.EGRESS_PORT, allow: L.EGRESS_ALLOW });
    // `-i` holds its stdin open: the sidecar ends when its stdin does, as core runs it.
    const px = await docker(['run', '-d', '-i', '--name', sb.proxy, '--label', LABEL, '--network', sb.network, ...nodeMount,
      '--entrypoint', NODE_IN_BOX, '-e', `ORDEWELL_EGRESS=${egress}`, lib.image, '-e', entry]);
    must(px.code === 0, `gateway: ${px.stderr.trim()}`);
    let ready = false;
    for (let i = 0; i < 40 && !ready; i++) {
      const logs = await docker(['logs', sb.proxy]);
      ready = /^ready \d+$/m.test(logs.stdout);
      if (!ready) await new Promise((r) => setTimeout(r, 250));
    }
    must(check(lib.name, 'gateway', ready, ready ? `allows ${L.EGRESS_ALLOW.join(', ')} on 443 and nothing else` : 'did not report ready'), 'gateway did not start');
    const joined = await docker(['network', 'connect', 'bridge', sb.proxy]);
    must(joined.code === 0, `gateway's way out: ${joined.stderr.trim()}`);
    const ip = (await docker(['inspect', '-f', `{{(index .NetworkSettings.Networks "${sb.network}").IPAddress}}`, sb.proxy])).stdout.trim();
    sb.proxyUrl = `http://${ip}:${L.EGRESS_PORT}`;

    const env = {
      HOME: BOX_HOME,
      PATH: `/opt/node/bin:${imagePath}`,
      HTTPS_PROXY: sb.proxyUrl, https_proxy: sb.proxyUrl, HTTP_PROXY: sb.proxyUrl, http_proxy: sb.proxyUrl,
      NO_PROXY: '127.0.0.1,localhost,::1', no_proxy: '127.0.0.1,localhost,::1',
      // Node's fetch ignores the proxy variables without it, and the runner's calls are node's.
      NODE_USE_ENV_PROXY: '1',
      ORDEWELL_NO_MODELS_DEV: '1',
      ORDEWELL_NO_VERSION_CHECK: '1',
      PIP_NO_INDEX: '1',
      AI_PROVIDER: L.PROVIDER,
      ORCHESTRATOR_MODEL: L.PROVIDER_MODEL,
    };
    const envArgs = Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
    // By name only, so the value never sits in an argument list; and never on a dry run.
    if (opts.run) envArgs.push('-e', 'OPENROUTER_API_KEY');
    const mounts = ['-v', `${runtime}:${ORDEWELL_IN_BOX}:ro`];
    const box = await docker(['run', '-d', '--init', '--name', sb.box, '--label', LABEL, '--network', sb.network, '--user', '0:0',
      ...nodeMount, ...mounts, ...envArgs, '--entrypoint', 'sleep', lib.image, 'infinity']);
    must(box.code === 0, `box: ${box.stderr.trim()}`);
    const wrapper = `#!/bin/sh\nexec ${NODE_IN_BOX} ${ORDEWELL_IN_BOX}/node_modules/@ordewell/cli/dist/main.js "$@"\n`;
    const setup = await inBox(sb, ['sh', '-c', [
      'cat > /usr/local/bin/ordewell && chmod +x /usr/local/bin/ordewell',
      'git config --system user.name commit0-bench',
      'git config --system user.email commit0-bench@localhost',
      'git config --system --add safe.directory "*"',
      `${NODE_IN_BOX} --version`,
      'python3 --version || python --version',
      'git --version',
    ].join(' && ')], { input: wrapper });
    must(check(lib.name, 'box', setup.code === 0, setup.code === 0 ? setup.stdout.trim().split('\n').join(', ') : setup.stderr.trim()), 'box setup failed');
    const key = await inBox(sb, ['sh', '-c', 'test -n "${OPENROUTER_API_KEY:-}"']);
    const keyIn = key.code === 0;
    must(check(lib.name, 'key in the box', keyIn === opts.run, opts.run ? (keyIn ? 'present, for the run' : 'missing: export OPENROUTER_API_KEY') : (keyIn ? 'present on a dry run' : 'absent, as a dry run needs')), 'key check');
    return sb;
  } catch (err) {
    if (!opts.keep || opts.run) await close();
    throw err;
  }
}

function inBox(sb, argv, { workdir, env = {}, input, timeoutMs, log } = {}) {
  return docker(['exec', ...(input === undefined ? [] : ['-i']), ...(workdir ? ['-w', workdir] : []), ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]), sb.box, ...argv], { input, timeoutMs, log });
}

// --- Checks -----------------------------------------------------------------

async function checkEgress(lib, sb) {
  const urls = [...L.EGRESS_ALLOWED_PROBES, ...L.EGRESS_DENIED_PROBES];
  const probe = async (bypass) => {
    const argv = bypass
      ? ['env', '-u', 'HTTPS_PROXY', '-u', 'https_proxy', '-u', 'HTTP_PROXY', '-u', 'http_proxy', '-u', 'NODE_USE_ENV_PROXY', NODE_IN_BOX, '-e', L.EGRESS_PROBE_JS, JSON.stringify(urls)]
      : [NODE_IN_BOX, '-e', L.EGRESS_PROBE_JS, JSON.stringify(urls)];
    const r = await inBox(sb, argv, { timeoutMs: 120_000 });
    try { return JSON.parse(r.stdout); } catch { return []; }
  };
  const proxied = await probe(false);
  const direct = await probe(true);
  // pip is the way out a stuck agent reaches for, and python honours the proxy variables on its own.
  const py = await inBox(sb, ['sh', '-c', `${lib.python} -c "import urllib.request; urllib.request.urlopen('https://pypi.org/simple/', timeout=15)"`], { timeoutMs: 60_000 });
  const verdict = L.judgeEgress({ proxied, direct });
  const pythonRefused = py.code !== 0;
  const fmt = (list) => list.map((p) => `${new URL(p.url).host} ${p.status ?? p.error}`).join(', ');
  check(lib.name, 'egress', verdict.ok && pythonRefused, [
    `through the gateway: ${fmt(proxied)}`,
    `around it: ${fmt(direct)}`,
    `python to pypi.org: ${pythonRefused ? 'refused' : 'ANSWERED'}`,
    ...verdict.failures,
  ]);
  return { ok: verdict.ok && pythonRefused, allow: L.EGRESS_ALLOW, proxied, direct, pythonPypiRefused: pythonRefused, failures: verdict.failures };
}

async function checkWindow(lib, sb) {
  const r = await inBox(sb, [NODE_IN_BOX, '-e', L.WINDOW_PROBE_JS, L.PROVIDER_MODEL], { timeoutMs: 60_000 });
  let probe;
  try { probe = JSON.parse(r.stdout); } catch { probe = { listed: 0, models: [], errors: { probe: r.stderr.trim().slice(-500) } }; }
  const table = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'packages/core/src/services/modelDetailsSnapshot.json'), 'utf8'));
  const listed = L.listedWindow(probe.models);
  const snapshot = L.snapshotWindow(table);
  const verdict = L.judgeWindow({ listed, snapshot });
  const errors = Object.entries(probe.errors ?? {}).map(([k, v]) => `${k}: ${v}`);
  check(lib.name, 'context window', verdict.ok, [
    verdict.reason,
    `core's listing (fetchAllProviderModels, through the gateway${probe.keyed ? '' : ', keyless'}) returned ${probe.listed} models; offline catalog: ${snapshot ?? 'none'}`,
    ...errors,
  ]);
  return { ...verdict, coreListed: probe.listed, errors: probe.errors ?? {} };
}

/** A synthetic library with every leak the probe looks for, to prove it sees them. */
const FIXTURE_SH = String.raw`
set -eu
W=/testbed
rm -rf "$W"; mkdir -p "$W/src/calc" "$W/tests"; cd "$W"
git init -q -b main
printf '[pytest]\npythonpath = src\nmarkers =\n    network: needs the network\n' > pytest.ini
printf '__version__ = "1.0"\n\ndef add(a, b):\n    return a + b\n\ndef sub(a, b):\n    return a - b\n' > src/calc/__init__.py
cat > tests/test_calc.py <<'PY'
import pytest
import calc

def test_add():
    assert calc.add(2, 3) == 5

def test_sub():
    assert calc.sub(5, 3) == 2

def test_version():
    assert calc.__version__ == "1.0"

@pytest.mark.network
def test_fetch():
    import urllib.request
    urllib.request.urlopen("https://pypi.org/simple/", timeout=5)
PY
git add -A; git commit -qm "the implementation"
git tag v1.0; git update-ref refs/remotes/origin/main HEAD
REF=$(git rev-parse HEAD)
printf '__version__ = "1.0"\n\ndef add(a, b):\n    raise NotImplementedError\n\ndef sub(a, b):\n    raise NotImplementedError\n' > src/calc/__init__.py
git commit -qam "the stubs"
BASE=$(git rev-parse HEAD)
SP=$(python3 -c 'import sysconfig; print(sysconfig.get_paths()["purelib"])')
mkdir -p "$SP/calc" "$SP/calc-1.0.dist-info"
git show "$REF:src/calc/__init__.py" > "$SP/calc/__init__.py"
printf 'calc/__init__.py,,\ncalc-1.0.dist-info/RECORD,,\n' > "$SP/calc-1.0.dist-info/RECORD"
printf 'Metadata-Version: 2.1\nName: calc\nVersion: 1.0\n' > "$SP/calc-1.0.dist-info/METADATA"
: > /tmp/calc-1.0-py3-none-any.whl
echo "$REF $BASE $SP"
`;

async function probeLeak(lib, sb) {
  const r = await inBox(sb, [lib.python, '-c', L.LEAK_PROBE_PY, lib.workdir, lib.importName, lib.distName, lib.referenceCommit ?? '-'], { workdir: '/', timeoutMs: 600_000 });
  try { return JSON.parse(r.stdout.trim().split('\n').pop()); } catch { return { error: r.stderr.trim().slice(-800) }; }
}

/** Builds the fixture's repository and plant, and proves the probe finds each. */
async function prepareFixture(lib, sb) {
  const r = await inBox(sb, ['sh', '-c', FIXTURE_SH]);
  must(check(lib.name, 'fixture', r.code === 0, r.code === 0 ? 'a repository with its implementation in history, a tag and a remote ref; a copy in site-packages; a wheel in /tmp' : r.stderr.trim()), 'fixture');
  const [ref, base, sitePackages] = r.stdout.trim().split(/\s+/);
  lib.referenceCommit = ref;
  lib.baseCommit = base;
  const before = await probeLeak(lib, sb);
  const verdict = L.judgeLeak(before);
  const seen = L.leakKinds(before);
  const all = ['history', 'reference', 'import', 'installed', 'archive'];
  const caught = all.every((k) => seen.includes(k));
  check(lib.name, 'leak probe sees a planted leak', !verdict.ok && caught, [`caught: ${seen.join(', ')}${caught ? '' : `; missed: ${all.filter((k) => !seen.includes(k)).join(', ')}`}`, ...verdict.failures], { expectedFailure: true });
  await inBox(sb, ['sh', '-c', `rm -rf "${sitePackages}/calc" "${sitePackages}/calc-1.0.dist-info" /tmp/calc-1.0-py3-none-any.whl`]);
}

async function flattenAndProbe(lib, sb) {
  const flat = await inBox(sb, ['sh', '-c', `${L.flattenScript(lib)}\ngit rev-parse HEAD`]);
  must(check(lib.name, 'flatten history', flat.code === 0, flat.code === 0 ? `one commit, the tree of ${lib.baseCommit.slice(0, 12)}, on commit0-base` : flat.stderr.trim()), 'flatten failed');
  // `ordewell merge` lands on commit0-base, so the arm's diff and the restore are taken against this commit, not the branch.
  lib.flatCommit = flat.stdout.trim().split('\n').pop();
  const probe = await probeLeak(lib, sb);
  const verdict = probe.error ? { ok: false, failures: [`the probe failed: ${probe.error}`] } : L.judgeLeak(probe);
  check(lib.name, 'reference implementation out of reach', verdict.ok, verdict.ok
    ? [`git log --all: ${probe.commits} commit; ${probe.objectCommits} commit object; reference ${probe.reference ?? 'not named'}; ${lib.importName} imports from ${probe.resolves.length ? probe.resolves.join(', ') : 'nowhere'} outside a test run; no installed copy, no archive`]
    : verdict.failures);
  const clean = await inBox(sb, ['git', 'status', '--porcelain', '--untracked-files=no'], { workdir: lib.workdir });
  check(lib.name, 'workspace clean', clean.stdout.trim() === '', clean.stdout.trim() === '' ? 'no tracked change, so `ordewell run` isolates without a stash' : clean.stdout.trim());
  return { ...probe, ok: verdict.ok, failures: verdict.failures };
}

function pytestLine(lib, extra) {
  return `${lib.testCmd} ${[...extra, ...L.pytestArgs(lib)].map(L.shellQuote).join(' ')}`;
}

const REF_MARK = '/tmp/commit0-reference-collection';

/**
 * The denominator, counted at the reference commit before flattening drops
 * it. No bytecode is written, and anything the collection wrote is removed, so
 * no compiled copy of the implementation stays behind for the arm to find.
 */
async function collectReference(lib, sb) {
  if (!lib.referenceCommit) {
    must(check(lib.name, 'tests collect at the reference', false, 'no referenceCommit: the denominator is counted there'), 'no denominator');
  }
  const co = await inBox(sb, ['git', '-c', 'advice.detachedHead=false', 'checkout', '-q', '--detach', lib.referenceCommit], { workdir: lib.workdir });
  must(check(lib.name, 'reference checked out', co.code === 0, co.code === 0 ? lib.referenceCommit.slice(0, 12) : co.stderr.trim()), 'the reference commit cannot be checked out');
  const r = await inBox(sb, ['sh', '-c', `touch ${REF_MARK} && PYTHONDONTWRITEBYTECODE=1 ${pytestLine(lib, ['--collect-only', '-q'])}`], { workdir: lib.workdir, timeoutMs: 600_000 });
  const verdict = L.judgeReferenceCollection({ code: r.code, output: r.stdout + r.stderr });
  const written = await inBox(sb, ['sh', '-c', L.removeWrittenScript(REF_MARK)], { workdir: lib.workdir });
  const left = written.stdout.trim() ? written.stdout.trim().split('\n') : [];
  const back = await inBox(sb, ['git', '-c', 'advice.detachedHead=false', 'checkout', '-q', '--detach', lib.baseCommit], { workdir: lib.workdir });
  const ok = verdict.ok && written.code === 0 && back.code === 0;
  check(lib.name, 'tests collect at the reference', ok, ok
    ? [`${verdict.counts.collected} tests collected with the network closed, the denominator; ${verdict.counts.deselected} marked "${lib.networkMarker}" left out`, ...(left.length ? [`removed what collection wrote: ${left.slice(0, 5).join(', ')}${left.length > 5 ? ` and ${left.length - 5} more` : ''}`] : [])]
    : [...verdict.failures, ...(written.code !== 0 ? [`cleaning up failed: ${written.stderr.trim()}`] : []), ...(back.code !== 0 ? [`back to the base failed: ${back.stderr.trim()}`] : [])]);
  return { ok, ...(verdict.counts ?? {}) };
}

/** At the stubs: with the network closed, a dependency the image lacks fails an import, and only that fails the check. */
async function collect(lib, sb, reference) {
  const r = await inBox(sb, ['sh', '-c', pytestLine(lib, ['--collect-only', '-q'])], { workdir: lib.workdir, timeoutMs: 600_000 });
  const verdict = L.judgeStubCollection({ code: r.code, output: r.stdout + r.stderr });
  check(lib.name, 'dependencies in the image', verdict.ok, verdict.ok
    ? `at the stubs: no module missing (exit ${r.code}, ${verdict.counts?.collected ?? 'no'} collected; a stub that breaks an import is the task)`
    : verdict.failures.slice(0, 6));
  return { ...reference, ok: reference.ok && verdict.ok, stubs: { exit: r.code, collected: verdict.counts?.collected ?? null } };
}

async function evaluate(lib, sb, log) {
  const r = await inBox(sb, ['sh', '-c', `timeout ${EVAL_TIMEOUT_S} ${pytestLine(lib, ['-q', '-rN'])}`], { workdir: lib.workdir, timeoutMs: (EVAL_TIMEOUT_S + 60) * 1000, log });
  const summary = L.parsePytestSummary(r.stdout);
  return { exit: r.code, timedOut: r.code === 124, ...(summary ?? {}) };
}

// --- Arms -------------------------------------------------------------------

async function writeSettings(sb) {
  const r = await inBox(sb, ['sh', '-c', `mkdir -p ${BOX_HOME}/.ordewell && cat > ${BOX_HOME}/.ordewell/settings.json`], { input: JSON.stringify(L.boxSettings(), null, 2) });
  return r.code === 0;
}

async function createArmASession(lib, sb) {
  const r = await inBox(sb, [NODE_IN_BOX, '-e', L.ARM_A_PLAN_JS, lib.workdir, L.goalText(lib), L.MODEL_ID, L.MODEL_LABEL]);
  return r.code === 0 ? r.stdout.trim() : null;
}

async function readPlan(lib, sb, sessionId) {
  const r = await inBox(sb, [NODE_IN_BOX, '-e', L.READ_PLAN_JS, lib.workdir, sessionId]);
  try { return JSON.parse(r.stdout); } catch { return null; }
}

/** The arm in a dry run: everything it does before its first model call. */
async function dryArm(lib, sb, arm) {
  check(lib.name, `arm ${arm.id} settings`, await writeSettings(sb), `${BOX_HOME}/.ordewell/settings.json: ${JSON.stringify(L.boxSettings())}`);
  if (arm.id === 'A') {
    const sessionId = await createArmASession(lib, sb);
    const plan = sessionId ? await readPlan(lib, sb, sessionId) : null;
    const verdict = L.judgePlan(plan);
    check(lib.name, 'arm A session', Boolean(sessionId) && verdict.ok, sessionId
      ? [`session ${sessionId}: ${plan?.tasks?.length ?? 0} task on ${plan?.tasks?.[0]?.assignedRunner} with ${plan?.tasks?.[0]?.assignedModel?.modelId}, plan ${plan?.status}`, ...verdict.failures]
      : 'core could not save the session');
    if (sessionId) {
      // Starts the daemon in the box and reads the plan through it; status calls no model.
      const st = await inBox(sb, ['ordewell', 'status', '--session-id', sessionId, '--workspace', lib.workdir], { workdir: lib.workdir, timeoutMs: 120_000 });
      check(lib.name, 'arm A daemon reads it', st.code === 0, st.code === 0 ? st.stdout.trim().split('\n').slice(0, 4) : `exit ${st.code}: ${(st.stderr || st.stdout).trim().split('\n').slice(-4).join(' | ')}`);
    }
    const cmds = L.armCommands(arm, { workspace: lib.workdir, goal: L.goalText(lib), sessionId: sessionId ?? '<session>' }).slice(1);
    check(lib.name, 'arm A run and merge', true, cmds.map((c) => c.join(' ')), { unverified: true });
  } else {
    const cmds = L.armCommands(arm, { workspace: lib.workdir, goal: L.goalText(lib) });
    check(lib.name, 'arm B plan, run and merge', true, [
      'not run: the planner turn is a model call',
      ...cmds.map((c) => c.map((a) => (a === L.goalText(lib) ? JSON.stringify(a) : a)).join(' ')),
    ], { unverified: true });
  }
}

async function keySpent() {
  if (!process.env.OPENROUTER_API_KEY) return null;
  try {
    const res = await fetch('https://openrouter.ai/api/v1/key', { headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;
    const body = await res.json();
    return typeof body?.data?.usage === 'number' ? body.data.usage : null;
  } catch {
    return null;
  }
}

/** The key's usage once it stops moving: OpenRouter books a call some seconds after it returns. */
async function settledKeySpent() {
  let last = await keySpent();
  for (let i = 0; i < 8; i++) {
    await new Promise((r) => setTimeout(r, 15_000));
    const now = await keySpent();
    if (now !== null && now === last) return now;
    last = now;
  }
  return last;
}

async function transcriptSpend(sb) {
  const r = await inBox(sb, ['sh', '-c', `cat ${BOX_HOME}/.ordewell/runners/ordewell/sessions/*/transcript.jsonl 2>/dev/null || true`]);
  return L.summarizeTranscript(r.stdout).spendUsd;
}

/**
 * The arm for real, under its caps. Ordewell holds no spend cap of its own,
 * so a watchdog reads the key every poll and stops the run once either cap
 * is met; a stop lands between polls, so set the key's own limit to the cap too.
 */
async function realArm(lib, sb, arm, runDir) {
  must(await writeSettings(sb), 'settings');
  const log = fs.createWriteStream(path.join(runDir, 'ordewell.log'));
  const started = Date.now();
  const before = await keySpent();
  let sessionId = null;
  let current = null;
  let stopped = null;
  const watchdog = setInterval(async () => {
    if (stopped) return;
    const now = await keySpent();
    const decision = L.capDecision({
      elapsedMs: Date.now() - started,
      keySpentUsd: now !== null && before !== null ? now - before : null,
      transcriptSpentUsd: await transcriptSpend(sb),
      capUsd: arm.capUsd,
    });
    if (!decision.stop) return;
    stopped = { why: decision.why, atMs: Date.now() - started, spentUsd: decision.spentUsd };
    log.write(`\n[commit0] cap met (${decision.why}, $${decision.spentUsd}): stopping\n`);
    if (sessionId) await inBox(sb, ['ordewell', 'stop', '--session-id', sessionId, '--workspace', lib.workdir], { timeoutMs: 60_000 });
    setTimeout(async () => {
      if (!current) return;
      await inBox(sb, ['sh', '-c', 'pkill -f /opt/ordewell/node_modules || true']);
    }, 60_000);
  }, POLL_MS);
  const step = async (argv, timeoutMs) => {
    log.write(`\n[commit0] $ ${argv.join(' ')}\n`);
    current = inBox(sb, argv, { workdir: lib.workdir, log, timeoutMs });
    const r = await current;
    current = null;
    return r;
  };
  const steps = {};
  try {
    if (arm.id === 'A') {
      sessionId = await createArmASession(lib, sb);
      must(sessionId, 'arm A session');
    } else {
      steps.plan = await step(['ordewell', 'plan', '--goal', L.goalText(lib), '--runner', 'ordewell', '--no-chat', '--yes', '--workspace', lib.workdir], L.WALL_CAP_MS);
      const last = await inBox(sb, ['cat', path.posix.join(lib.workdir, '.ordewell', 'last-session.json')]);
      try { sessionId = JSON.parse(last.stdout).sessionId; } catch { sessionId = null; }
      must(sessionId && !stopped, `the planner left no session (exit ${steps.plan.code})`);
    }
    const plan = await readPlan(lib, sb, sessionId);
    const planCheck = L.judgePlan(plan);
    steps.planCheck = planCheck;
    fs.writeFileSync(path.join(runDir, 'plan.json'), JSON.stringify(plan, null, 2));
    must(check(lib.name, `arm ${arm.id} plan`, planCheck.ok, planCheck.ok ? `${plan.tasks.length} tasks, all on ordewell with ${L.MODEL_ID}` : planCheck.failures), 'the plan breaks the protocol');
    if (!stopped) steps.run = await step(['ordewell', 'run', '--session-id', sessionId, '--workspace', lib.workdir], Math.max(1, L.WALL_CAP_MS - (Date.now() - started)));
    steps.merge = await step(['ordewell', 'merge', '--session-id', sessionId, '--yes', '--workspace', lib.workdir], MERGE_TIMEOUT_MS);
  } finally {
    clearInterval(watchdog);
    log.end();
  }
  const wallClockMs = Date.now() - started;
  const after = before === null ? null : await settledKeySpent();
  return { sessionId, steps: Object.fromEntries(Object.entries(steps).map(([k, v]) => [k, v && 'code' in v ? { exit: v.code, timedOut: v.timedOut } : v])), wallClockMs, stopped, billed: before !== null && after !== null ? { billedUsd: L.round6(after - before), source: 'openrouter key usage' } : null };
}

/**
 * The tests as the dataset wrote them, whatever the arm did to them, and
 * whether it did. Only the tests: networkx's testDir is its srcDir, so
 * restoring the whole directory would undo the arm's work.
 */
async function restoreTests(lib, sb) {
  const o = { workdir: lib.workdir };
  const diff = await inBox(sb, ['git', 'diff', '--name-status', '-z', '--no-renames', lib.flatCommit, '--', lib.testDir], o);
  const untracked = await inBox(sb, ['git', 'ls-files', '-z', '--others', '--exclude-standard', '--', lib.testDir], o);
  const plan = L.testRestorePlan(lib, diff.stdout, untracked.stdout);
  if (plan.checkout.length) await inBox(sb, ['git', 'checkout', '-q', lib.flatCommit, '--', ...plan.checkout], o);
  if (plan.remove.length) await inBox(sb, ['rm', '-f', '--', ...plan.remove], o);
  return plan.checkout.length + plan.remove.length > 0;
}

async function copyOut(sb, from, to) {
  const r = await docker(['cp', `${sb.box}:${from}`, to]);
  return r.code === 0;
}

function readTranscripts(home) {
  const root = path.join(home, 'runners', 'ordewell', 'sessions');
  if (!fs.existsSync(root)) return L.combineTranscripts([]);
  const summaries = fs.readdirSync(root)
    .map((id) => path.join(root, id, 'transcript.jsonl'))
    .filter((f) => fs.existsSync(f))
    .map((f) => L.summarizeTranscript(fs.readFileSync(f, 'utf8')));
  return L.combineTranscripts(summaries);
}

// --- One library, one arm ---------------------------------------------------

async function runOne(lib, arm, ordewell, runsDir) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const runId = `${stamp.slice(0, 19)}-${lib.name}-${arm.id}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  const runDir = path.join(runsDir, runId);
  fs.mkdirSync(runDir, { recursive: true });
  console.log(`\n${lib.name}, arm ${arm.id} (${arm.label}; cap $${arm.capUsd}, ${L.WALL_CAP_MS / 3_600_000} h) -> ${runDir}`);
  const startedAt = new Date().toISOString();
  const first = checks.length;
  let sb = null;
  const record = { window: { window: null }, egress: null, leak: null, network: null, tests: null, baseline: null, arm: null, transcripts: null, testsModified: null };
  try {
    sb = await openSandbox(lib, runId, ordewell.runtime);
    record.egress = await checkEgress(lib, sb);
    record.window = await checkWindow(lib, sb);
    must(record.egress.ok && record.window.ok, 'the window or egress check failed: nothing runs');
    if (opts.fixture) {
      await prepareFixture(lib, sb);
    }
    const reference = await collectReference(lib, sb);
    must(reference.ok, 'the tests do not collect offline at the reference');
    record.leak = await flattenAndProbe(lib, sb);
    must(record.leak.ok, 'the reference implementation is reachable: nothing runs');
    record.network = await collect(lib, sb, reference);
    must(record.network.ok, 'a dependency is missing from the image');
    record.baseline = await evaluate(lib, sb, fs.createWriteStream(path.join(runDir, 'baseline-tests.log')));
    check(lib.name, 'baseline on the stubs', record.baseline.passed !== undefined, `${record.baseline.passed ?? '?'} passed, ${record.baseline.failed ?? '?'} failed, ${record.baseline.errors ?? 0} errors of ${record.network.collected} collected`);
    if (opts.dryRun) {
      for (const a of [arm]) await dryArm(lib, sb, a);
    } else {
      record.arm = await realArm(lib, sb, arm, runDir);
      record.testsModified = await restoreTests(lib, sb);
      const evaluated = await evaluate(lib, sb, fs.createWriteStream(path.join(runDir, 'tests.log')));
      record.tests = { ...evaluated, collected: record.network.collected };
      await inBox(sb, ['sh', '-c', `git diff ${lib.flatCommit} > /tmp/arm.patch`], { workdir: lib.workdir });
      await copyOut(sb, '/tmp/arm.patch', path.join(runDir, 'arm.patch'));
    }
  } catch (err) {
    if (!(err instanceof Abort)) throw err;
    console.log(`  stopped: ${err.message}`);
    record.aborted = err.message;
  } finally {
    if (sb) {
      await copyOut(sb, `${BOX_HOME}/.ordewell`, path.join(runDir, 'ordewell-home'));
      await copyOut(sb, path.posix.join(lib.workdir, '.ordewell'), path.join(runDir, 'workspace-ordewell'));
      record.transcripts = readTranscripts(path.join(runDir, 'ordewell-home'));
      if (opts.keep && opts.dryRun) console.log(`  kept: docker exec -it ${sb.box} sh; clean up with: docker rm -f ${sb.box} ${sb.proxy}; docker network rm ${sb.network}`);
      else await sb.close();
    }
  }
  const result = {
    ...L.resultRecord({
      lib, arm, window: record.window, ordewell, egress: record.egress, leak: record.leak, network: record.network,
      tests: record.tests, wallClockMs: record.arm?.wallClockMs, spend: record.arm?.billed ?? (record.transcripts?.sessions ? { billedUsd: record.transcripts.spendUsd, source: 'runner transcripts (the key could not be read)' } : null),
      transcripts: record.transcripts, stopped: record.arm?.stopped, providerPin: opts.providerPin, dryRun: opts.dryRun, startedAt, endedAt: new Date().toISOString(),
    }),
    sessionId: record.arm?.sessionId ?? null,
    steps: record.arm?.steps ?? null,
    testsModified: record.testsModified,
    baseline: record.baseline,
    aborted: record.aborted ?? null,
    checks: checks.slice(first),
  };
  fs.writeFileSync(path.join(runDir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
  if (!opts.dryRun) fs.appendFileSync(path.join(path.dirname(runsDir), 'results.jsonl'), `${JSON.stringify(result)}\n`);
  return result;
}

// --- Main -------------------------------------------------------------------

function loadLibraries() {
  if (opts.fixture) {
    return [L.validateLibrary({
      name: 'fixture-calc', image: opts.image, workdir: '/testbed', srcDir: 'src/calc', testDir: 'tests', testCmd: 'python3 -m pytest',
      importName: 'calc', distName: 'calc', baseCommit: 'HEAD', networkMarker: 'network',
    })];
  }
  const raw = JSON.parse(fs.readFileSync(path.resolve(opts.libs), 'utf8'));
  const list = (Array.isArray(raw) ? raw : raw.libraries ?? []).map(L.validateLibrary);
  const picked = opts.only.length ? list.filter((l) => opts.only.includes(l.name)) : list;
  if (picked.length === 0) throw new Error('no library to run');
  return picked;
}

/**
 * Billed spend is the key's usage before and after, which counts every caller:
 * two drivers on one key would bill each other's calls, so a run holds the key.
 */
function lockKey(dir) {
  const lock = path.join(dir, 'key.lock');
  try {
    fs.writeFileSync(lock, `${process.pid}\n`, { flag: 'wx' });
  } catch {
    throw new Error(`${lock} is held: another run is billing this key. Remove it if no run is.`);
  }
  const release = () => fs.rmSync(lock, { force: true });
  process.on('exit', release);
  return release;
}

async function main() {
  const dataDir = checkedBenchDir('commit0');
  const runsDir = path.join(dataDir, opts.dryRun ? 'dry-runs' : 'runs');
  fs.mkdirSync(runsDir, { recursive: true });
  const libs = loadLibraries();
  console.log(`Commit0 driver: ${opts.dryRun ? 'DRY RUN, no model call' : 'RUN, spending on the key'}; model ${L.MODEL_ID}; provider pin ${opts.providerPin ?? 'not given'}; data in ${dataDir}`);
  if (opts.run && !process.env.OPENROUTER_API_KEY) throw new Error('--run needs OPENROUTER_API_KEY');
  const release = opts.run ? lockKey(dataDir) : () => {};
  const results = [];
  try {
    const ordewell = await preflight();
    for (const lib of libs) {
      for (const arm of L.armsOf(opts.arm)) results.push(await runOne({ ...lib }, arm, ordewell, runsDir));
    }
  } catch (err) {
    if (!(err instanceof Abort)) throw err;
    console.log(`stopped: ${err.message}`);
  } finally {
    release();
  }
  const failed = checks.filter((c) => !c.ok && !c.unverified);
  const unverified = checks.filter((c) => c.unverified);
  console.log(`\n${checks.length} checks: ${checks.length - failed.length - unverified.length} ok, ${failed.length} failed, ${unverified.length} unverified`);
  for (const r of results) console.log(`  ${r.library} ${r.arm}: window ${r.contextWindow ?? '-'}, ${r.tests ? `${r.tests.passed}/${r.tests.collected} passed` : 'no arm run'}, ${r.networkDeselected ?? '-'} network-marked left out${r.aborted ? `, stopped: ${r.aborted}` : ''}`);
  process.exitCode = failed.length || results.some((r) => r.aborted) ? 1 : 0;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
