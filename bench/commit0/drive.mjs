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
//   node bench/commit0/drive.mjs --sweep

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { REPO_ROOT, checkedBenchDir } from '../lib/data-dir.mjs';
import * as L from './lib.mjs';

const HELP = `Usage: node bench/commit0/drive.mjs (--dry-run | --run | --sweep) [options]

  --dry-run              set up the box and run every check; no model call, no key in the box
  --run                  run the arms: spends on the OpenRouter key in OPENROUTER_API_KEY
  --sweep                remove the boxes and networks of drivers no longer running, then exit
                         (with --dry-run or --run: sweep first, then go on)
  --libs <file>          the libraries, as libraries.example.json shows
  --only <a,b>           only these libraries of --libs
  --fixture              a synthetic library built in --image, to prove the checks (dry run only)
  --image <image>        the image for --fixture
  --arm A|B|both         which arms (default both)
  --provider-pin <p>     the OpenRouter provider the key is pinned to, recorded in every result
  --cap-usd <usd>        the spend cap, the same for both arms (default ${L.CAP_USD})
  --parallel <n>         arm B's ORDEWELL_MAX_PARALLEL (default ${L.PARALLEL}); arm A runs one task
  --cpus <n>             the box's CPU quota (default ${L.CPUS})
  --memory <size>        the box's memory quota, swap held to it (default ${L.MEMORY})
  --stall-min <min>      stop a run that waits this long on a person with nothing running (default ${L.STALL_MIN})
  --ordewell-root <dir>  the built Ordewell tree to pack into the box (default: the tree this driver is in)
  --allow-stale-dist     run a dist older than that tree's sources; the result says so and is not valid
  --keep                 leave the box and its network up after a dry run, for a look inside
  --seed <label>         a label for repeated runs, kept in result.json and the run directory's name
  --batch-dir <dir>      set by batch.mjs: write the run here, stop when the batch's stop file appears,
                         and leave the key lock and results.jsonl to the batch
  --batch-shared         set by batch.mjs when runs overlap: the key's delta is not this run's

Several runs at once on one key: node bench/commit0/batch.mjs --help.

Both arms share one wall-clock cap of ${L.WALL_CAP_MS / 3_600_000} h and the spend cap.
Run data goes under ${'$'}ORDEWELL_BENCH_DIR or ~/.local/share/ordewell-bench/commit0, never the repository.`;

const LABEL = 'commit0-bench=1';
const NODE_IN_BOX = '/opt/node/bin/node';
const ORDEWELL_IN_BOX = '/opt/ordewell';
const BOX_HOME = '/root';
const POLL_MS = 30_000;
const MERGE_TIMEOUT_MS = 15 * 60 * 1000;
const STOP_TIMEOUT_MS = 2 * 60 * 1000;
/** How long a stopped run's attempts get to end before the followers are signalled. */
const DRAIN_MS = 3 * 60 * 1000;
const LEFTOVER_WAIT_MS = 60_000;
const DISTS = Object.freeze(['packages/core/dist/index.js', 'packages/web/dist/server/main.js', 'packages/cli/dist/main.js']);

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

const ORDEWELL_ROOT = opts.ordewellRoot ?? REPO_ROOT;

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

// --- Cleanup ----------------------------------------------------------------

/** The boxes this driver has up, so a signal or a crash takes them down with it. */
const openSandboxes = new Set();

function removeSandboxSync(sb) {
  spawnSync('docker', ['rm', '-f', sb.box, ...(sb.proxy ? [sb.proxy] : [])], { env: hostEnv, stdio: 'ignore' });
  if (sb.network) spawnSync('docker', ['network', 'rm', sb.network], { env: hostEnv, stdio: 'ignore' });
  openSandboxes.delete(sb);
}

let exiting = false;
/** A box left up keeps its daemon spending on the key, so the driver never leaves without taking its own down. */
function bailOut(why, code) {
  if (exiting) return;
  exiting = true;
  if (openSandboxes.size) console.error(`\n[commit0] ${why}: removing ${[...openSandboxes].map((sb) => sb.box).join(', ')} and their networks`);
  for (const sb of [...openSandboxes]) removeSandboxSync(sb);
  process.exit(code);
}

process.on('SIGINT', () => bailOut('interrupted', 130));
process.on('SIGTERM', () => bailOut('terminated', 143));
process.on('uncaughtException', (err) => { console.error(err); bailOut('uncaught error', 1); });
process.on('unhandledRejection', (err) => { console.error(err); bailOut('unhandled rejection', 1); });

/**
 * `--sweep`: the labelled containers and networks whose driver, on this host,
 * is no longer running. `onlyNames` narrows it to a dry run's own probes.
 */
async function sweep({ onlyNames = null } = {}) {
  const list = async (args, kind) => (await docker(args)).stdout.split('\n').filter(Boolean).map((line) => {
    const [name, driver = ''] = line.split('\t');
    return { kind, name, driver };
  });
  const format = (field) => `${field}\t{{.Label "${L.DRIVER_LABEL}"}}`;
  let items = [
    ...(await list(['ps', '-a', '--filter', `label=${LABEL}`, '--format', format('{{.Names}}')], 'container')),
    ...(await list(['network', 'ls', '--filter', `label=${LABEL}`, '--format', format('{{.Name}}')], 'network')),
  ];
  if (onlyNames) items = items.filter((i) => onlyNames.includes(i.name));
  const { remove, keep } = L.sweepTargets(items);
  const removed = [];
  const failed = [];
  // Containers first: a network still in use cannot be removed.
  for (const item of [...remove.filter((i) => i.kind === 'container'), ...remove.filter((i) => i.kind === 'network')]) {
    const r = await docker(item.kind === 'container' ? ['rm', '-f', item.name] : ['network', 'rm', item.name]);
    (r.code === 0 ? removed : failed).push({ ...item, ...(r.code === 0 ? {} : { error: r.stderr.trim() }) });
  }
  return { removed, failed, keep };
}

function printSweep(s) {
  for (const i of s.removed) console.log(`  removed ${i.kind} ${i.name} (driver ${i.driver}, not running)`);
  for (const i of s.failed) console.log(`  could not remove ${i.kind} ${i.name}: ${i.error}`);
  for (const i of s.keep) console.log(`  kept ${i.kind} ${i.name}: ${i.why}`);
  if (!s.removed.length && !s.failed.length && !s.keep.length) console.log('  nothing labelled commit0-bench');
}

/** Proves the sweep on probes of its own: one of a dead driver, removed; one of a live driver, kept. */
async function checkSweep(image) {
  const dead = spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' }).pid;
  const deadDriver = `${L.driverId().split('/')[0]}/${dead}`;
  const tag = `commit0-sweep-probe-${process.pid}`;
  const names = { dead: `${tag}-dead`, live: `${tag}-live`, net: `${tag}-net` };
  const labels = (driver) => ['--label', LABEL, '--label', `${L.DRIVER_LABEL}=${driver}`];
  const made = [
    await docker(['create', '--name', names.dead, ...labels(deadDriver), '--entrypoint', 'true', image]),
    await docker(['create', '--name', names.live, ...labels(L.driverId()), '--entrypoint', 'true', image]),
    await docker(['network', 'create', '--internal', ...labels(deadDriver), names.net]),
  ];
  try {
    if (made.some((r) => r.code !== 0) || L.pidAlive(dead)) {
      return check('preflight', '--sweep', false, made.find((r) => r.code !== 0)?.stderr.trim() || `pid ${dead} is alive again`);
    }
    const s = await sweep({ onlyNames: Object.values(names) });
    const removed = s.removed.map((i) => i.name).sort();
    const kept = s.keep.map((i) => i.name);
    const ok = removed.join() === [names.dead, names.net].sort().join() && kept.join() === names.live && s.failed.length === 0;
    return check('preflight', '--sweep', ok, ok
      ? `removed a container and a network of dead driver ${deadDriver}; kept the container of this live driver`
      : [`removed: ${removed.join(', ') || 'nothing'}`, `kept: ${s.keep.map((i) => `${i.name} (${i.why})`).join(', ') || 'nothing'}`, ...s.failed.map((i) => `${i.name}: ${i.error}`)]);
  } finally {
    await docker(['rm', '-f', names.dead, names.live]);
    await docker(['network', 'rm', names.net]);
  }
}

// --- Preflight --------------------------------------------------------------

async function git(...args) {
  return exec('git', ['-C', ORDEWELL_ROOT, ...args]);
}

/**
 * The tree whose dist is packed: its HEAD is the sha the result records, so
 * it must hold no tracked change and its dist must be newer than its sources.
 * The driver builds nothing: a build is the user's to run, in that tree.
 */
async function preflight() {
  const head = await git('rev-parse', 'HEAD');
  must(check('preflight', 'ordewell tree', head.code === 0, head.code === 0 ? ORDEWELL_ROOT : `${ORDEWELL_ROOT} is not a git tree: ${head.stderr.trim()}`), 'no ordewell tree');
  const sha = head.stdout.trim();
  const ancestor = await git('merge-base', '--is-ancestor', L.PR177_MERGE, 'HEAD');
  const containsPr177 = ancestor.code === 0;
  check('preflight', 'ordewell checkout', containsPr177, `${sha}, ${containsPr177 ? 'contains' : 'does not contain'} the PR 177 merge ${L.PR177_MERGE.slice(0, 12)}`);
  const dirty = (await git('status', '--porcelain', '--untracked-files=no')).stdout.trim();
  check('preflight', 'checkout clean', dirty === '', dirty === '' ? 'no tracked change' : [`tracked changes: the run would not be the commit it names; commit them first`, ...dirty.split('\n').slice(0, 5)]);
  const missing = DISTS.filter((d) => !fs.existsSync(path.join(ORDEWELL_ROOT, d)));
  check('preflight', 'built', missing.length === 0, missing.length ? `missing ${missing.join(', ')}: run npm run build in ${ORDEWELL_ROOT}` : 'core, web and cli dist present');
  const freshness = await distFreshness();
  check('preflight', 'dist fresh', freshness.ok, freshness.allowed ? `${freshness.detail}: allowed by --allow-stale-dist, so no result is valid` : freshness.stale ? `${freshness.detail}: run npm run build in ${ORDEWELL_ROOT}, or pass --allow-stale-dist` : freshness.detail);
  const ver = await docker(['version', '--format', '{{.Server.Version}}']);
  check('preflight', 'docker', ver.code === 0, ver.code === 0 ? `engine ${ver.stdout.trim()}` : ver.stderr.trim());
  must(containsPr177 && dirty === '' && missing.length === 0 && freshness.ok && ver.code === 0, 'preflight failed');
  const runtime = await prepareRuntime(sha, freshness.stamp);
  return { sha, root: ORDEWELL_ROOT, containsPr177, freshness, staleDistAllowed: freshness.allowed, runtime };
}

/** The packed dist's age against the tracked sources it is built from. */
async function distFreshness() {
  const listed = await git('ls-files', '-z', '--', ...L.FRESHNESS_SOURCES);
  const stat = (rel) => {
    try { return { path: rel, mtimeMs: fs.statSync(path.join(ORDEWELL_ROOT, rel)).mtimeMs }; } catch { return null; }
  };
  const sources = listed.stdout.split('\0').filter(Boolean).map(stat).filter(Boolean);
  const dists = DISTS.map(stat).filter(Boolean);
  const verdict = L.distFreshness({ dists: dists.length === DISTS.length ? dists : [], sources, allowStale: opts.allowStaleDist });
  const stamp = dists.length ? Math.trunc(Math.max(...dists.map((d) => d.mtimeMs))).toString(36) : 'none';
  return { ...verdict, sources: sources.length, stamp };
}

/**
 * The Ordewell the box runs: core, web and cli packed from the tree as a
 * release would pack them, installed with the lockfile's versions of their
 * dependencies, outside the repository. The tree's own node_modules will
 * not do: an Ordewell worktree's is links into another checkout, which mean
 * nothing inside the box and need not hold this commit's dependencies.
 * Keyed by the sha and the dist's build time, so a rebuild is packed afresh.
 */
async function prepareRuntime(sha, distStamp) {
  const dir = path.join(checkedBenchDir('commit0', 'runtime'), `${sha}-${distStamp}`);
  const coreEntry = path.join(dir, 'node_modules', '@ordewell', 'core', 'dist', 'index.js');
  const loads = async () => (await exec(process.execPath, ['-e', `if (typeof require(${JSON.stringify(coreEntry)}).fetchAllProviderModels !== 'function') process.exit(1)`])).code === 0;
  if (fs.existsSync(coreEntry) && (await loads())) {
    check('preflight', 'runtime', true, `${dir} (packed earlier from ${sha.slice(0, 12)})`);
    return dir;
  }
  // A batch's runs prepare at once: each packs into a directory of its own, and the first to finish is the one kept.
  const tmp = `${dir}.tmp-${process.pid}`;
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(path.join(tmp, 'tarballs'), { recursive: true });
  const packed = await exec('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', path.join(tmp, 'tarballs'),
    '-w', 'packages/core', '-w', 'packages/web', '-w', 'packages/cli'], { cwd: ORDEWELL_ROOT });
  let tarballs = [];
  try { tarballs = JSON.parse(packed.stdout).map((t) => ({ name: t.name, file: t.filename })); } catch { /* reported below */ }
  must(check('preflight', 'runtime packed', packed.code === 0 && tarballs.length === 3, packed.code === 0 ? tarballs.map((t) => t.file).join(', ') : packed.stderr.trim().split('\n').slice(-4)), 'npm pack failed');
  const lock = JSON.parse(fs.readFileSync(path.join(ORDEWELL_ROOT, 'package-lock.json'), 'utf8'));
  const overrides = {};
  for (const p of ['core', 'web', 'cli']) {
    const deps = JSON.parse(fs.readFileSync(path.join(ORDEWELL_ROOT, 'packages', p, 'package.json'), 'utf8')).dependencies ?? {};
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
  if (fs.existsSync(coreEntry) && (await loads())) {
    fs.rmSync(tmp, { recursive: true, force: true });
  } else {
    fs.rmSync(dir, { recursive: true, force: true });
    try {
      fs.renameSync(tmp, dir);
    } catch (err) {
      // Another run renamed its own into place between the check and the rename.
      if (!fs.existsSync(coreEntry)) throw err;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
  must(check('preflight', 'runtime', await loads(), `${dir}: core loads and exports fetchAllProviderModels`), 'the packed core does not load');
  return dir;
}

// --- The box ----------------------------------------------------------------

/**
 * One library's sandbox for one arm: an internal network, the gateway on it
 * and the bridge, and the box on it alone, under the arm's CPU and memory
 * quota (D4). The box runs the image's own python and git, the host's node
 * and the runtime packed from the tree, mounted read-only, so the Ordewell it
 * runs is the commit the record names. Everything carries this driver's id.
 */
async function openSandbox(lib, runId, runtime, settings) {
  const name = `commit0-${runId}`;
  const driver = L.driverId();
  const labels = ['--label', LABEL, '--label', `${L.DRIVER_LABEL}=${driver}`];
  const sb = { name, network: `${name}-net`, proxy: `${name}-egress`, box: `${name}-box`, proxyUrl: null };
  const close = async () => {
    await docker(['rm', '-f', sb.box, sb.proxy]);
    await docker(['network', 'rm', sb.network]);
    openSandboxes.delete(sb);
  };
  sb.close = close;
  const node = fs.realpathSync(process.execPath);
  const nodeMount = ['-v', `${node}:${NODE_IN_BOX}:ro`];

  const image = await docker(['image', 'inspect', '-f', '{{json .Config.Env}}', lib.image]);
  must(check(lib.name, 'image present', image.code === 0, image.code === 0 ? lib.image : `${lib.image} is not on this engine: pull or build it first`), 'no image');
  const imageEnv = JSON.parse(image.stdout || '[]');
  const imagePath = imageEnv.find((e) => e.startsWith('PATH='))?.slice(5) ?? '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

  openSandboxes.add(sb);
  const made = await docker(['network', 'create', '--internal', ...labels, sb.network]);
  must(made.code === 0, `network: ${made.stderr.trim()}`);
  try {
    const source = fs.readFileSync(path.join(ORDEWELL_ROOT, 'packages/core/src/services/container/egressSidecar.ts'), 'utf8');
    const entry = L.extractEgressEntry(source);
    const egress = JSON.stringify({ port: L.EGRESS_PORT, allow: L.EGRESS_ALLOW });
    // `-i` holds its stdin open: the sidecar ends when its stdin does, as core runs it.
    const px = await docker(['run', '-d', '-i', '--name', sb.proxy, ...labels, '--network', sb.network, ...nodeMount,
      '--entrypoint', NODE_IN_BOX, '-e', `ORDEWELL_EGRESS=${egress}`, lib.image, '-e', entry]);
    must(px.code === 0, `gateway: ${px.stderr.trim()}`);
    let ready = false;
    for (let i = 0; i < 40 && !ready; i++) {
      const logs = await docker(['logs', sb.proxy]);
      ready = /^ready \d+$/m.test(logs.stdout);
      if (!ready) await sleep(250);
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
      ...L.boxRunArgs({ cpus: settings.cpus, memory: settings.memory, parallel: settings.parallel, driver }),
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

/** The box's quota as the engine holds it (D4). */
async function checkQuota(lib, sb, settings) {
  const r = await docker(['inspect', '-f', '{{.HostConfig.NanoCpus}} {{.HostConfig.Memory}} {{.HostConfig.MemorySwap}}', sb.box]);
  const [nanoCpus, memory, swap] = r.stdout.trim().split(/\s+/).map(Number);
  const want = { nanoCpus: Math.round(settings.cpus * 1e9), memory: L.dockerBytes(settings.memory) };
  const ok = r.code === 0 && nanoCpus === want.nanoCpus && memory === want.memory && swap === want.memory;
  return check(lib.name, 'box quota', ok, ok
    ? `${settings.cpus} CPUs, ${settings.memory} of memory and no swap beyond it`
    : `the engine holds ${nanoCpus / 1e9} CPUs, ${memory} bytes, swap ${swap}; wanted ${settings.cpus}, ${want.memory}, ${want.memory}`);
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
  const table = JSON.parse(fs.readFileSync(path.join(ORDEWELL_ROOT, 'packages/core/src/services/modelDetailsSnapshot.json'), 'utf8'));
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
mkdir -p src/calc/__pycache__
: > src/calc/__pycache__/__init__.cpython-3.pyc
echo "$REF $BASE $SP"
`;

async function probeLeak(lib, sb) {
  const r = await inBox(sb, [lib.python, '-c', L.LEAK_PROBE_PY, lib.workdir, lib.importName, lib.distName, lib.referenceCommit ?? '-'], { workdir: '/', timeoutMs: 600_000 });
  try { return JSON.parse(r.stdout.trim().split('\n').pop()); } catch { return { error: r.stderr.trim().slice(-800) }; }
}

/** Builds the fixture's repository and plant, and, in the arm's box, proves the probe finds each. */
async function prepareFixture(lib, sb, { probe = true } = {}) {
  const r = await inBox(sb, ['sh', '-c', FIXTURE_SH]);
  must(check(lib.name, 'fixture', r.code === 0, r.code === 0 ? 'a repository with its implementation in history, a tag and a remote ref; a copy in site-packages; a wheel in /tmp; bytecode in __pycache__' : r.stderr.trim()), 'fixture');
  const [ref, base, sitePackages] = r.stdout.trim().split(/\s+/);
  lib.referenceCommit = ref;
  lib.baseCommit = base;
  if (probe) {
    const before = await probeLeak(lib, sb);
    const verdict = L.judgeLeak(before);
    const seen = L.leakKinds(before);
    const all = ['history', 'reference', 'import', 'installed', 'archive', 'untracked'];
    const caught = all.every((k) => seen.includes(k));
    check(lib.name, 'leak probe sees a planted leak', !verdict.ok && caught, [`caught: ${seen.join(', ')}${caught ? '' : `; missed: ${all.filter((k) => !seen.includes(k)).join(', ')}`}`, ...verdict.failures], { expectedFailure: true });
  }
  await inBox(sb, ['sh', '-c', `rm -rf "${sitePackages}/calc" "${sitePackages}/calc-1.0.dist-info" /tmp/calc-1.0-py3-none-any.whl`]);
}

/** The setup both boxes share, the arm's and the eval's: `where` names the box in each check. */
async function flattenAndProbe(lib, sb, where = '') {
  const n = (name) => (where ? `${name} (${where})` : name);
  const flat = await inBox(sb, ['sh', '-c', `${L.flattenScript(lib)}\ngit rev-parse HEAD HEAD^{tree}`]);
  must(check(lib.name, n('flatten history'), flat.code === 0, flat.code === 0 ? `one commit, the tree of ${lib.baseCommit.slice(0, 12)}, on commit0-base` : flat.stderr.trim()), 'flatten failed');
  // Before any worktree exists: the rule is what keeps an agent's `git add -A` from committing the bootstrap's venv link.
  const ignore = await inBox(sb, ['sh', '-c', L.workspaceIgnoreScript(lib)]);
  must(check(lib.name, n('venv ignored'), ignore.code === 0, ignore.code === 0 ? `/${L.VENV_DIR} in the workspace's info/exclude, so no arm commits the link to it` : ignore.stderr.trim()), 'the venv cannot be ignored');
  // `ordewell merge` lands on commit0-base, so the scored diff is taken against this commit, not the branch; the tree is what both boxes must share.
  [lib.flatCommit, lib.flatTree] = flat.stdout.trim().split('\n').slice(-2);
  // The image's build and the reference collection can leave bytecode of the implementation, which a supervisor once pointed a task at.
  const cleaned = await inBox(sb, ['sh', '-c', L.leftoverCleanupScript(lib)]);
  const removed = cleaned.stdout.split('\n').map((l) => l.replace(/^Removing /, '').trim()).filter(Boolean);
  must(check(lib.name, n('leftovers removed'), cleaned.code === 0, cleaned.code === 0
    ? (removed.length ? `untracked and ignored, the venv kept: ${removed.slice(0, 5).join(', ')}${removed.length > 5 ? ` and ${removed.length - 5} more` : ''}` : 'nothing untracked or ignored but the venv')
    : cleaned.stderr.trim()), 'the leftovers cannot be removed');
  const probe = await probeLeak(lib, sb);
  const verdict = probe.error ? { ok: false, failures: [`the probe failed: ${probe.error}`] } : L.judgeLeak(probe);
  check(lib.name, n('reference implementation out of reach'), verdict.ok, verdict.ok
    ? [`git log --all: ${probe.commits} commit; ${probe.objectCommits} commit object; reference ${probe.reference ?? 'not named'}; ${lib.importName} imports from ${probe.resolves.length ? probe.resolves.join(', ') : 'nowhere'} outside a test run; no installed copy, no archive, nothing untracked or ignored`]
    : verdict.failures);
  const clean = await inBox(sb, ['git', 'status', '--porcelain', '--untracked-files=no'], { workdir: lib.workdir });
  check(lib.name, n('workspace clean'), clean.stdout.trim() === '', clean.stdout.trim() === '' ? 'no tracked change, so `ordewell run` isolates without a stash' : clean.stdout.trim());
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
  // Written afresh for every count, so nothing an arm did to it carries into the score.
  const plugin = await inBox(sb, ['sh', '-c', `rm -rf ${L.shellQuote(L.TEST_TIMEOUT_PLUGIN_DIR)} && mkdir -p ${L.shellQuote(L.TEST_TIMEOUT_PLUGIN_DIR)} && cat > ${L.shellQuote(`${L.TEST_TIMEOUT_PLUGIN_DIR}/${L.TEST_TIMEOUT_PLUGIN}.py`)}`], { input: L.TEST_TIMEOUT_PLUGIN_PY });
  must(check(lib.name, 'per-test timeout', plugin.code === 0, plugin.code === 0 ? `each test fails past ${L.TEST_TIMEOUT_S} s, the run past ${L.EVAL_TIMEOUT_S} s` : plugin.stderr.trim()), 'the timeout plugin cannot be written');
  const r = await inBox(sb, ['sh', '-c', L.evalCommand(lib)], { workdir: lib.workdir, timeoutMs: (L.EVAL_TIMEOUT_S + 60) * 1000, log });
  const summary = L.parseEvaluation(r.code, r.stdout + r.stderr);
  return { exit: r.code, timedOut: r.code === 124, ...(summary ?? {}) };
}

// --- Arms -------------------------------------------------------------------

async function writeSettings(sb, arm, settings) {
  const r = await inBox(sb, ['sh', '-c', `mkdir -p ${BOX_HOME}/.ordewell && cat > ${BOX_HOME}/.ordewell/settings.json`], { input: JSON.stringify(L.boxSettings(arm, settings), null, 2) });
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

async function lastSessionId(lib, sb) {
  const last = await inBox(sb, ['cat', path.posix.join(lib.workdir, '.ordewell', 'last-session.json')]);
  try { return JSON.parse(last.stdout).sessionId ?? null; } catch { return null; }
}

/** Asks the box's daemon what a session opened with, and judges it against the arm's settings. */
async function checkSettingsReadback(lib, sb, arm, settings, sessionId) {
  const r = await inBox(sb, [NODE_IN_BOX, '-e', L.SETTINGS_PROBE_JS, lib.workdir, sessionId], { timeoutMs: 60_000 });
  let response;
  try { response = JSON.parse(r.stdout); } catch { response = { error: (r.stderr || r.stdout).trim().slice(-300) || `exit ${r.code}` }; }
  const v = L.judgeSettingsReadback(settings, response);
  return check(lib.name, `arm ${arm.id} daemon reads the settings back`, v.ok, v.ok
    ? `supervisor ${v.read.supervisorLevel}, autorun ${v.read.autorun}, automatic merging ${v.read.mergeAtGatesAutomatically}, up to ${v.read.maxParallel} at once`
    : v.failures);
}

/**
 * The scan for Ordewell processes in the box: every process whose command line
 * names the runtime. The pattern is split in the script so the scan's own
 * shell never matches it.
 */
const ORDEWELL_PS_SH = `for p in /proc/[0-9]*; do pid=\${p#/proc/}; [ "$pid" = "$$" ] && continue; c=$(tr '\\0' ' ' < "$p/cmdline" 2>/dev/null) || continue; case "$c" in *"${ORDEWELL_IN_BOX.slice(0, 9)}""${ORDEWELL_IN_BOX.slice(9)}/"*) echo "$pid $c";; esac; done`;

async function ordewellProcesses(sb) {
  const r = await inBox(sb, ['sh', '-c', ORDEWELL_PS_SH]);
  return r.stdout.split('\n').filter(Boolean).map((line) => ({ pid: Number(line.split(' ')[0]), cmd: line.slice(line.indexOf(' ') + 1).trim() }));
}

/**
 * Waits for the box to hold no Ordewell process, killing what outlives the
 * wait, so nothing spends on the key after the closing reading.
 */
async function confirmNoOrdewell(lib, sb) {
  const deadline = Date.now() + LEFTOVER_WAIT_MS;
  let left = await ordewellProcesses(sb);
  while (left.length && Date.now() < deadline) {
    await sleep(3000);
    left = await ordewellProcesses(sb);
  }
  const killed = left;
  if (killed.length) {
    await inBox(sb, ['sh', '-c', `kill -9 ${killed.map((p) => p.pid).join(' ')} 2>/dev/null; true`]);
    await sleep(1000);
    left = await ordewellProcesses(sb);
  }
  check(lib.name, 'no Ordewell process left', left.length === 0, left.length
    ? left.map((p) => `still running: ${p.pid} ${p.cmd.slice(0, 160)}`)
    : killed.length ? [`killed what outlived the stop by ${LEFTOVER_WAIT_MS / 1000} s:`, ...killed.map((p) => `${p.pid} ${p.cmd.slice(0, 160)}`)] : 'the daemon and every follower ended');
  return { killed, left };
}

/** A step in the box whose pid is written down, so the stop can signal it, and only it. */
function startStep(lib, sb, name, argv, timeoutMs, log) {
  log.write(`\n[commit0] $ ${argv.join(' ')}\n`);
  const pidFile = `/tmp/commit0-${name}.pid`;
  const promise = inBox(sb, ['sh', '-c', `echo $$ > ${pidFile}; exec "$@"`, 'sh', ...argv], { workdir: lib.workdir, log, timeoutMs });
  const step = { name, pidFile, done: false, result: null };
  step.promise = promise.then((r) => { step.done = true; step.result = r; return r; });
  return step;
}

async function signalStep(sb, step, signal) {
  await inBox(sb, ['sh', '-c', `test -s ${step.pidFile} && kill -${signal} "$(cat ${step.pidFile})" 2>/dev/null; true`]);
}

/**
 * The one way a run ends, on a cap, a stall, a settled run or an abort: ask
 * the daemon to stop the session and wait for its attempts to end; end the
 * `plan` and `run` followers, never `merge`; merge what landed when asked
 * (D3); stop the daemon; and confirm nothing of Ordewell is left before the
 * closing spend reading. `ordewell run` may already have exited, at any
 * status (D5): its exit is recorded, never judged.
 */
async function stopRun(lib, sb, { sessionId, followers = [], merge = false, log }) {
  const ws = ['--workspace', lib.workdir];
  const out = { stop: null, drained: null, merge: null, server: null, leftovers: null };
  const record = (r) => ({ exit: r.code, timedOut: r.timedOut });
  if (sessionId) {
    log.write(`\n[commit0] $ ordewell stop --session-id ${sessionId}\n`);
    out.stop = record(await inBox(sb, ['ordewell', 'stop', '--session-id', sessionId, ...ws], { workdir: lib.workdir, log, timeoutMs: STOP_TIMEOUT_MS }));
    const deadline = Date.now() + DRAIN_MS;
    for (;;) {
      const plan = await readPlan(lib, sb, sessionId);
      out.drained = !L.allTasks(plan).some((t) => t.status === 'in_progress');
      if (out.drained || Date.now() >= deadline) break;
      await sleep(5000);
    }
  }
  for (const step of followers.filter((s) => !s.done)) {
    await signalStep(sb, step, 'TERM');
    await Promise.race([step.promise, sleep(30_000)]);
    if (!step.done) await signalStep(sb, step, 'KILL');
    await step.promise;
  }
  if (merge && sessionId) {
    const m = startStep(lib, sb, 'merge', ['ordewell', 'merge', '--session-id', sessionId, '--yes', ...ws], MERGE_TIMEOUT_MS, log);
    out.merge = record(await m.promise);
    check(lib.name, 'merge after the stop', !out.merge.timedOut, out.merge.timedOut ? `still merging after ${MERGE_TIMEOUT_MS / 60_000} min` : `exit ${out.merge.exit}`);
  }
  log.write('\n[commit0] $ ordewell stop --server\n');
  out.server = record(await inBox(sb, ['ordewell', 'stop', '--server'], { log, timeoutMs: STOP_TIMEOUT_MS }));
  out.leftovers = await confirmNoOrdewell(lib, sb);
  return out;
}

/** The arm in a dry run: everything it does before its first model call. */
async function dryArm(lib, sb, arm, settings, runDir) {
  check(lib.name, `arm ${arm.id} settings written`, await writeSettings(sb, arm, settings), `${BOX_HOME}/.ordewell/settings.json: ${JSON.stringify(L.boxSettings(arm, settings))}`);
  await checkQuota(lib, sb, settings);
  // B's planner turn is a model call, so B's settings are read back on a session written as A's is.
  const sessionId = await createArmASession(lib, sb);
  const plan = sessionId ? await readPlan(lib, sb, sessionId) : null;
  const verdict = L.judgePlan(plan);
  check(lib.name, arm.id === 'A' ? 'arm A session' : 'arm B probe session', Boolean(sessionId) && verdict.ok, sessionId
    ? [`session ${sessionId}: ${plan?.tasks?.length ?? 0} task on ${plan?.tasks?.[0]?.assignedRunner} with ${plan?.tasks?.[0]?.assignedModel?.modelId} in mode ${plan?.tasks?.[0]?.taskMode}, plan ${plan?.status}`, ...verdict.failures]
    : 'core could not save the session');
  const log = fs.createWriteStream(path.join(runDir, 'ordewell.log'));
  try {
    if (sessionId) {
      // Starts the daemon in the box and reads the plan through it; status calls no model.
      const st = await inBox(sb, ['ordewell', 'status', '--session-id', sessionId, '--workspace', lib.workdir], { workdir: lib.workdir, timeoutMs: 120_000, log });
      check(lib.name, `arm ${arm.id} daemon reads it`, st.code === 0, st.code === 0 ? st.stdout.trim().split('\n').slice(0, 4) : `exit ${st.code}: ${(st.stderr || st.stdout).trim().split('\n').slice(-4).join(' | ')}`);
      await checkSettingsReadback(lib, sb, arm, settings, sessionId);
    }
    await checkChooser(lib, sb);
    // The stop path on an idle session: stop, no follower, no merge, the daemon down, nothing left.
    await stopRun(lib, sb, { sessionId, followers: [], merge: false, log });
  } finally {
    log.end();
  }
  const cmds = L.armCommands(arm, { workspace: lib.workdir, goal: L.goalText(lib), sessionId: sessionId ?? '<session>' });
  check(lib.name, `arm ${arm.id} ${arm.id === 'A' ? 'run and merge' : 'plan, run and merge'}`, true, [
    'not run: each is a model call, or merges what one made',
    ...(arm.id === 'A' ? cmds.slice(1) : cmds).map((c) => c.map((a) => (a === L.goalText(lib) ? JSON.stringify(a) : a)).join(' ')),
  ], { unverified: true });
}

/**
 * A worktree layout as a stopped run leaves it, built in the box with git and
 * read on the host as the scoring reads an arm's: the chooser must find each
 * task's work where it is, never in the integration worktree, and its files
 * must come out whole, from a worktree or a preserved branch.
 */
const CHOOSER_SH = String.raw`
set -eu
R=/tmp/commit0-chooser
rm -rf "$R" "$R-tmp"; mkdir -p "$R/pkg"; cd "$R"
git init -q -b commit0-base
printf 'a = 1\n' > pkg/a.py; printf 'b = 1\n' > pkg/b.py
printf '/.venv\n' >> .git/info/exclude
git add -A; git commit -qm flat
FLAT=$(git rev-parse HEAD)
W=.ordewell/worktrees/run1
git worktree add -q -b ordewell/run1/integration "$W/integration"
(cd "$W/integration" && printf 'merged = 1\n' > pkg/merged.py && git add -A && git commit -qm merged)
git worktree add -q -b ordewell/run1/1-one "$W/1-one"
(cd "$W/1-one" && printf 'one = 1\n' > pkg/one.py && git add -A && git commit -qm one && printf 'a = 2\n' > pkg/a.py && printf 'new = 1\n' > pkg/new.py && mkdir .venv && printf junk > .venv/junk)
mk() { git branch "$1" "$FLAT"; git worktree add -q "$R-tmp" "$1"; (cd "$R-tmp" && printf '%s\n' "$2" > pkg/two.py && git add -A && git commit -qm "$1"); git worktree remove --force "$R-tmp"; }
mk ordewell/run1/2-two branch
mk ordewell-preserved/run1/2-two older
mk ordewell-preserved/run1/2-two-2 newest
git worktree add -q -b ordewell/run1/4-four "$W/4-four"
(cd "$W/4-four" && printf 'b = 4\n' > pkg/b.py)
`;

async function checkChooser(lib, sb) {
  const root = '/tmp/commit0-chooser';
  const made = await inBox(sb, ['sh', '-c', CHOOSER_SH]);
  if (made.code !== 0) return check(lib.name, 'patch chooser', false, `the layout could not be built: ${made.stderr.trim().split('\n').slice(-3).join(' | ')}`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'commit0-chooser-'));
  const failures = [];
  try {
    const copy = path.join(tmp, 'copy');
    if (!(await copyOut(sb, root, copy))) failures.push('the layout could not be copied out');
    const w = (name) => `${root}/.ordewell/worktrees/run1/${name}`;
    const rec = (taskId, name, status, worktree = w(name)) => ({ taskId, branch: `ordewell/run1/${name}`, workspace: w(name), status, repos: { '.': { worktree } } });
    const plan = {
      tasks: [
        { id: 't1', order: 1, title: 'one', status: 'failed' },
        { id: 't2', order: 2, title: 'two', status: 'failed' },
        { id: 't3', order: 3, title: 'three', status: 'completed' },
        { id: 't4', order: 4, title: 'four', status: 'completed', subtasks: [{ id: 't4a', title: 'four, a', status: 'failed' }] },
        { id: 't5', order: 5, title: 'five', status: 'blocked' },
      ],
      isolation: {
        run: { id: 'run1', workspaceRoot: root, repos: [{ path: '.', integrationBranch: 'ordewell/run1/integration' }] },
        tasks: {
          t1: rec('t1', '1-one', 'active'),
          t2: rec('t2', '2-two', 'kept'),
          t3: rec('t3', '3-three', 'merged'),
          t4: rec('t4', '4-four', 'kept'),
          t5: rec('t5', '5-five', 'active', w('integration')),
        },
      },
    };
    const layout = L.readGitLayout(copy, root);
    const chosen = L.choosePatches({ plan, worktrees: layout.worktrees, branches: [...layout.branches.keys()] });
    const got = Object.fromEntries(chosen.map((c) => [c.taskId, c.landed ? 'landed' : c.source ? (c.source.path ?? c.source.ref) : 'none']));
    const want = { t1: w('1-one'), t2: 'ordewell-preserved/run1/2-two-2', t3: 'landed', t4: w('4-four'), t5: 'none' };
    failures.push(...Object.keys(want).filter((k) => got[k] !== want[k]).map((k) => `${k}: chose ${got[k]}, not ${want[k]}`));
    const a = L.scoringPlan(L.ARMS.A, chosen);
    const b = L.scoringPlan(L.ARMS.B, chosen);
    if (a.scoredFrom !== 'task-worktree' || a.apply?.taskId !== 't1') failures.push(`arm A scores ${a.scoredFrom} from ${a.apply?.taskId ?? 'nothing'}, not the task worktree of t1`);
    if (b.scoredFrom !== 'merged' || b.diagnostic.map((c) => c.taskId).join() !== 't1,t2,t4') failures.push(`arm B scores ${b.scoredFrom} and keeps ${b.diagnostic.map((c) => c.taskId).join(', ')} for diagnosis, not merged and t1, t2, t4`);
    // The files each source yields on the host, as the scoring reads them.
    const expect = (dir, files) => {
      for (const [file, text] of files) {
        let body = null;
        try { body = fs.readFileSync(path.join(dir, ...file.split('/')), 'utf8').trim(); } catch { /* missing */ }
        if (body !== text) failures.push(`${dir}: ${file} holds ${body === null ? 'nothing' : JSON.stringify(body)}, not ${JSON.stringify(text)}`);
      }
    };
    const one = L.hostPathOf(copy, root, w('1-one'));
    expect(one, [['pkg/one.py', 'one = 1'], ['pkg/a.py', 'a = 2'], ['pkg/new.py', 'new = 1']]);
    if (!L.treeManifest(one).get(L.VENV_DIR)?.pruned) failures.push('the worktree\'s venv is read as the arm\'s work');
    const sha = layout.branches.get('ordewell-preserved/run1/2-two-2');
    if (sha) expect(materialize(path.join(copy, '.git'), sha, path.join(tmp, 't2')), [['pkg/two.py', 'newest'], ['pkg/a.py', 'a = 1']]);
    else failures.push('the preserved branch is not read from the copy');
  } catch (err) {
    failures.push(err.message);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    await inBox(sb, ['rm', '-rf', root]);
  }
  return check(lib.name, 'patch chooser', failures.length === 0, failures.length ? failures : [
    'read on the host from the copied files: a failed task\'s own worktree, committed and uncommitted work, its venv left out;',
    'a gone worktree: the newest preserved branch, its files whole; an open subtask: not landed; the integration worktree: nothing',
  ]);
}

const keySpent = () => L.keyUsage(process.env.OPENROUTER_API_KEY);
const settledKeySpent = () => L.settledKeyUsage(process.env.OPENROUTER_API_KEY);

async function transcriptSummary(sb) {
  const r = await inBox(sb, ['sh', '-c', `cat ${BOX_HOME}/.ordewell/runners/ordewell/sessions/*/transcript.jsonl 2>/dev/null || true`]);
  return L.summarizeTranscript(r.stdout);
}

/**
 * The arm for real, under the one cap both arms share (D1). Ordewell holds no
 * spend cap of its own, so every poll reads the key and the transcripts and
 * stops the run once the cap is met; a stop lands between polls, so set the
 * key's own limit to the cap too. A run also ends when it has made no model
 * call L.NO_START_MS in, when a person has been waited on for --stall-min
 * with nothing running, or when it has settled: never on `ordewell run`'s
 * exit (D5). Every end goes through stopRun.
 */
async function realArm(lib, sb, arm, settings, runDir) {
  must(await writeSettings(sb, arm, settings), 'settings');
  const log = fs.createWriteStream(path.join(runDir, 'ordewell.log'));
  const started = Date.now();
  const before = opts.batchShared ? null : await keySpent();
  const stallMs = opts.stallMin * 60_000;
  const steps = {};
  const followers = [];
  let sessionId = null;
  let runStart = null;
  let stopped = null;
  let stalled = null;
  let endMs = null;
  let stall = { sinceMs: null };
  let settle = null;
  let aborted = false;

  /** One look at the run; returns why it is over, or null. */
  const poll = async () => {
    const nowMs = Date.now();
    // Under a batch whose runs overlap, the key's delta is every run's: only the batch reads it.
    const key = opts.batchShared ? null : await keySpent();
    const transcripts = await transcriptSummary(sb);
    if (!sessionId && arm.id === 'B') sessionId = await lastSessionId(lib, sb);
    const plan = sessionId ? await readPlan(lib, sb, sessionId) : null;
    const cap = L.capDecision({
      elapsedMs: nowMs - started,
      recordedSpentUsd: plan ? L.recordedSpend(plan).usd : null,
      keySpentUsd: key !== null && before !== null ? key - before : null,
      transcriptSpentUsd: transcripts.spendUsd,
      capUsd: settings.capUsd,
      wallCapMs: settings.wallCapMs,
    });
    if (cap.stop) {
      stopped = { why: cap.why, atMs: nowMs - started, spentUsd: cap.spentUsd };
      return `capped by ${cap.why} at $${cap.spentUsd}`;
    }
    if (opts.batchDir && fs.existsSync(path.join(opts.batchDir, L.BATCH_STOP_FILE))) {
      stopped = { why: 'batch-budget', atMs: nowMs - started, spentUsd: cap.spentUsd };
      return 'the batch budget is spent';
    }
    if (!runStart || !plan) return null;
    const start = L.startDecision({ sinceRunMs: nowMs - runStart.atMs, usageLines: transcripts.usageLines - runStart.usageLines, plan });
    if (start.stop) {
      stopped = { why: start.why, atMs: nowMs - started, spentUsd: cap.spentUsd, detail: start.detail };
      return start.detail;
    }
    const s = L.stallDecision({ plan, nowMs, sinceMs: stall.sinceMs, stallMs });
    stall = s;
    if (s.stalled) {
      stalled = s.stalled;
      return `stalled: "${s.stalled.task.title}" waits on ${s.stalled.waiting} for ${Math.round(s.stalled.sinceMs / 60_000)} min with nothing running`;
    }
    const d = L.settleDecision({ plan, fingerprint: L.planFingerprint(plan, transcripts.usageLines), nowMs, state: settle });
    settle = d.state;
    if (d.settled) {
      endMs = d.state.sinceMs;
      return 'settled: nothing running, nobody waited on, nothing moved';
    }
    return null;
  };

  /** Polls until the run is over, or `until` (a step) ends first. */
  const watch = async (until) => {
    for (;;) {
      const done = until ? await Promise.race([until.promise.then(() => true), sleep(POLL_MS).then(() => false)]) : (await sleep(POLL_MS), false);
      if (done) return null;
      const why = await poll();
      if (why) {
        log.write(`\n[commit0] ${why}: stopping\n`);
        console.log(`  ${why}: stopping`);
        return why;
      }
    }
  };

  let closing = null;
  try {
    if (arm.id === 'A') {
      sessionId = await createArmASession(lib, sb);
      must(sessionId, 'arm A session');
    } else {
      const plan = startStep(lib, sb, 'plan', ['ordewell', 'plan', '--goal', L.goalText(lib), '--runner', L.RUNNER, '--no-chat', '--yes', '--workspace', lib.workdir], settings.wallCapMs, log);
      followers.push(plan);
      // The caps hold from the planner's first call; the start, stall and settle rules wait for the run, which the planner's calls are not.
      const why = await watch(plan);
      if (plan.done) steps.plan = { exit: plan.result.code, timedOut: plan.result.timedOut };
      sessionId = sessionId ?? (await lastSessionId(lib, sb));
      must(sessionId || why, `the planner left no session (exit ${steps.plan?.exit})`);
    }
    if (sessionId && !stopped && !stalled && !endMs) {
      const plan = await readPlan(lib, sb, sessionId);
      const planCheck = L.judgePlan(plan);
      steps.planCheck = planCheck;
      fs.writeFileSync(path.join(runDir, 'plan.json'), JSON.stringify(plan, null, 2));
      must(check(lib.name, `arm ${arm.id} plan`, planCheck.ok, planCheck.ok ? `${plan.tasks.length} tasks, all on ${L.RUNNER} with ${L.MODEL_ID}, in ${[...new Set(plan.tasks.map((t) => t.taskMode))].join(', ')}` : planCheck.failures), 'the plan breaks the protocol');
      runStart = { atMs: Date.now(), usageLines: (await transcriptSummary(sb)).usageLines };
      followers.push(startStep(lib, sb, 'run', ['ordewell', 'run', '--session-id', sessionId, '--workspace', lib.workdir], Math.max(1, settings.wallCapMs - (Date.now() - started)), log));
      await watch(null);
    }
  } catch (err) {
    aborted = true;
    throw err;
  } finally {
    endMs = endMs ?? Date.now();
    // A run that never started has nothing to merge, and its result is the failure, not a score.
    closing = await stopRun(lib, sb, { sessionId, followers, merge: !aborted && stopped?.why !== 'no-start', log });
    for (const f of followers) if (f.done) steps[f.name] = { exit: f.result.code, timedOut: f.result.timedOut };
    if (closing.merge) steps.merge = closing.merge;
    log.end();
  }
  const after = before === null ? null : await settledKeySpent();
  const finalPlan = sessionId ? await readPlan(lib, sb, sessionId) : null;
  return {
    sessionId,
    steps,
    closing: { stop: closing.stop, drained: closing.drained, server: closing.server, killed: closing.leftovers.killed.map((p) => p.cmd) },
    wallClockMs: (stopped ? started + stopped.atMs : endMs) - started,
    stopped,
    stalled,
    billed: opts.batchShared
      ? { billedUsd: null, source: 'not available: runs overlapped on the key; see the batch\'s batch.json' }
      : before !== null && after !== null ? { billedUsd: L.round6(after - before), source: 'openrouter key usage' } : null,
    finalPlan,
  };
}

// --- Scoring, in a fresh box ------------------------------------------------

/** A shell line run on the host, its arguments as $1, $2, ... */
const onHost = (script, args, input) => exec('bash', ['-o', 'pipefail', '-c', script, 'bash', ...args], { input });
const nul = (paths) => paths.map((p) => `${p}\0`).join('');

/**
 * The arm's box stopped, then its workdir copied to the host by the engine,
 * the venv left behind. Nothing in that box runs again, so no git
 * configuration, hook or process the arm left there touches what is scored.
 */
async function copyArmWorkdir(lib, sb, dest) {
  await docker(['kill', sb.box]);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  const r = await onHost('docker cp "$1" - | tar -x -C "$2" --strip-components=1 --exclude="$3"', [`${sb.box}:${lib.workdir}`, dest, `${path.posix.basename(lib.workdir)}/${L.VENV_DIR}`]);
  must(check(lib.name, 'the arm\'s files copied out', r.code === 0, r.code === 0 ? `${lib.workdir} from the stopped box, without ${L.VENV_DIR}, into ${dest}` : r.stderr.trim()), 'the arm\'s files cannot be copied out');
  return dest;
}

/**
 * A commit's files, from a copied repository's objects, by a git that reads
 * none of that repository's configuration or attributes: a bare repository of
 * its own borrows the objects, and each blob is written as it is stored.
 */
function materialize(gitDir, sha, out) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'commit0-git-'));
  try {
    const env = { ...hostEnv, GIT_DIR: path.join(tmp, 'objects.git'), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(tmp, 'gitconfig'), HOME: tmp };
    const git = (args, input) => {
      const r = spawnSync('git', args, { env, input, maxBuffer: 2 ** 31 - 1 });
      if (r.status !== 0) throw new Error(`git ${args[0]}: ${String(r.stderr).trim()}`);
      return r.stdout;
    };
    git(['init', '-q', '--bare']);
    fs.writeFileSync(path.join(env.GIT_DIR, 'objects', 'info', 'alternates'), `${path.join(gitDir, 'objects')}\n`);
    const entries = [...L.parseLsTree(git(['ls-tree', '-r', '-z', sha]).toString())];
    const blobs = git(['cat-file', '--batch'], entries.map(([, e]) => `${e.oid}\n`).join(''));
    fs.rmSync(out, { recursive: true, force: true });
    let at = 0;
    for (const [p, e] of entries) {
      const nl = blobs.indexOf(10, at);
      const size = Number(blobs.toString('latin1', at, nl).split(' ')[2]);
      const body = blobs.subarray(nl + 1, nl + 1 + size);
      at = nl + 2 + size;
      const file = path.join(out, ...p.split('/'));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      if (e.mode === '120000') fs.symlinkSync(body.toString(), file);
      else fs.writeFileSync(file, body, { mode: e.mode === '100755' ? 0o755 : 0o644 });
    }
    return out;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * Where the files to score are (D2, D3), read from the copy alone: arm A's
 * unlanded task's worktree, or its newest preserved branch, written out; else,
 * and always for B, the workspace Ordewell merged into. B's unlanded work stays
 * in the copy, for diagnosis, and is never scored.
 */
function filesToScore(lib, arm, copy, plan) {
  const layout = L.readGitLayout(copy, lib.workdir);
  const chosen = L.choosePatches({ plan, worktrees: layout.worktrees, branches: [...layout.branches.keys()] });
  const s = L.scoringPlan(arm, chosen);
  let dir = copy;
  let scoredFrom = s.scoredFrom;
  if (s.apply) {
    const src = s.apply.source;
    try {
      dir = src.kind === 'worktree' ? L.hostPathOf(copy, lib.workdir, src.path) : materialize(path.join(copy, '.git'), layout.branches.get(src.ref), `${copy}-task`);
      if (dir && !fs.existsSync(dir)) dir = null;
    } catch (err) {
      dir = null;
      src.error = err.message;
    }
    check(lib.name, `arm ${arm.id} task work found`, Boolean(dir), dir
      ? `task ${s.apply.order} did not land: scored on its ${src.kind} ${src.path ?? src.ref}`
      : `the work of task ${s.apply.order} cannot be read from ${src.path ?? src.ref}: ${src.error ?? 'outside the workdir'}`);
    if (!dir) [dir, scoredFrom] = [copy, 'merged'];
  }
  const patches = [
    { file: 'arm.patch', taskId: s.apply?.taskId ?? null, order: s.apply?.order ?? null, source: dir === copy ? { kind: 'workspace', path: lib.workdir } : s.apply.source, scored: true },
    ...s.diagnostic.map((c) => ({ file: null, taskId: c.taskId, order: c.order, source: c.source, scored: false, kept: 'arm-workdir' })),
  ];
  return { dir, scoredFrom, chosen, patches };
}

/**
 * The box an arm's files are scored in: the arm's image and quota, and nothing
 * else, no network, mount, key or Ordewell. Set up as the arm's box was before
 * its run, through the same steps, and checked to flatten to the same tree.
 */
async function openEvalBox(lib, runId, settings) {
  const sb = { name: `commit0-${runId}`, box: `commit0-${runId}-eval`, network: null, proxy: null };
  sb.close = async () => { await docker(['rm', '-f', sb.box]); openSandboxes.delete(sb); };
  openSandboxes.add(sb);
  const r = await docker(['run', '-d', '--init', '--name', sb.box, '--label', LABEL, '--network', 'none', '--user', '0:0',
    ...L.boxRunArgs({ cpus: settings.cpus, memory: settings.memory, parallel: settings.parallel, driver: L.driverId() }),
    '--entrypoint', 'sleep', lib.image, 'infinity']);
  must(r.code === 0, `eval box: ${r.stderr.trim()}`);
  const setup = await inBox(sb, ['sh', '-c', 'git config --system user.name commit0-bench && git config --system user.email commit0-bench@localhost && git config --system --add safe.directory "*"']);
  must(check(lib.name, 'eval box', setup.code === 0, setup.code === 0 ? `${lib.image}, no network, no mount, no key, no Ordewell` : setup.stderr.trim()), 'the eval box cannot be set up');
  return sb;
}

/**
 * Scores the files under `dir` in a fresh box, through L.scoreFiles, the one
 * path every arm takes from its files onward. `inspect(box)`, when given, looks
 * at the eval box before it goes.
 */
async function scoreInFreshBox(lib, dir, { runId, settings, runDir, inspect }) {
  const box = await openEvalBox(lib, runId, settings);
  const fresh = { ...lib };
  const o = { workdir: lib.workdir };
  let patchError = null;
  try {
    const io = {
      prepare: async () => {
        if (opts.fixture) await prepareFixture(fresh, box, { probe: false });
        must((await flattenAndProbe(fresh, box, 'eval box')).ok, 'the reference implementation is reachable in the eval box');
        const ls = await inBox(box, ['git', 'ls-tree', '-r', '-z', 'HEAD'], o);
        const std = await inBox(box, [lib.python, '-I', '-c', L.STDLIB_NAMES_PY], { workdir: '/' });
        must(ls.code === 0 && std.code === 0, `the eval box's tree or standard library cannot be read: ${(ls.stderr + std.stderr).trim()}`);
        return { tree: fresh.flatTree, lsTree: ls.stdout, stdlib: std.stdout.split('\n').filter(Boolean) };
      },
      manifest: async (d, algo) => L.treeManifest(d, algo),
      remove: async (paths) => {
        if (paths.length) must((await inBox(box, ['xargs', '-0', 'rm', '-f', '--'], { ...o, input: nul(paths) })).code === 0, 'the arm\'s deletions cannot be made');
      },
      put: async (d, paths) => {
        if (!paths.length) return;
        const r = await onHost('tar -c -C "$1" --null --verbatim-files-from -T - | docker cp - "$2"', [d, `${box.box}:${lib.workdir}`], nul(paths));
        must(r.code === 0, `the arm's files cannot be put in: ${r.stderr.trim()}`);
      },
      patch: async (paths) => {
        const r = await inBox(box, ['sh', '-c', L.armPatchScript(fresh)], { ...o, input: nul(paths) });
        fs.writeFileSync(path.join(runDir, 'arm.patch'), r.stdout);
        if (r.code !== 0) patchError = r.stderr.trim().slice(-300);
      },
      evaluate: () => evaluate(fresh, box, fs.createWriteStream(path.join(runDir, 'tests.log'))),
    };
    const scored = await L.scoreFiles({ lib, dir, armTree: lib.flatTree }, io);
    check(lib.name, 'eval box flattens to the arm\'s tree', scored.treeCheck.ok, scored.treeCheck.detail);
    check(lib.name, 'files scored', scored.treeCheck.ok, [
      `${scored.copied.length} copied in, ${scored.removed.length} removed, ${scored.excluded.length} left out${patchError ? `; the diff failed: ${patchError}` : ''}`,
      ...scored.needsInspection.map((r) => `needs inspection: ${r}`),
    ]);
    if (inspect) await inspect(box, scored);
    return { ...scored, patchError };
  } finally {
    if (opts.keep && opts.dryRun) {
      openSandboxes.delete(box);
      console.log(`  kept: docker exec -it ${box.box} sh; clean up with: docker rm -f ${box.box}`);
    } else await box.close();
  }
}

// --- The dry run's fixture arm ----------------------------------------------

const REF_FILES = '/tmp/commit0-reference-files.tar';
const DRY_MODULE = '_commit0_dry';
const DRY_TEST = 'test_commit0_dry_edit';
const DRY_MARKS = ['/tmp/commit0-smudge-ran', '/tmp/commit0-fsmonitor-ran'];
const srcDirOf = (lib) => lib.srcDir.replace(/^\.\//, '').replace(/\/+$/, '');

/** The reference's source files, for the dry run's fixture arm, taken to the host before the flatten and the leak probe. */
async function exportReferenceFiles(lib, sb, runDir) {
  const r = await inBox(sb, ['git', 'archive', '-o', REF_FILES, lib.referenceCommit, '--', srcDirOf(lib)], { workdir: lib.workdir });
  const file = path.join(runDir, 'reference-files.tar');
  const ok = r.code === 0 && (await copyOut(sb, REF_FILES, file));
  await inBox(sb, ['rm', '-f', REF_FILES]);
  must(check(lib.name, 'reference source taken out', ok, ok ? `the reference's ${srcDirOf(lib)} files, for the fixture arm` : r.stderr.trim()), 'the reference files cannot be taken out');
  return file;
}

/**
 * What the dry run's fixture arm does in the arm's box: the reference's
 * source, a module added inside the library and imported, a test edited to
 * pass one more, and git configuration that would run on the driver's git.
 */
async function fixtureArm(lib, sb, refFiles) {
  const put = await onHost('docker cp - "$1" < "$2"', [`${sb.box}:${lib.workdir}`, refFiles]);
  const src = srcDirOf(lib);
  const script = [
    'set -eu',
    `T=$(git ls-files -- ${L.shellQuote(lib.testDir)} | grep -E '(^|/)test_[^/]*\\.py$' | head -n 1)`,
    `printf '\\n\\ndef ${DRY_TEST}():\\n    pass\\n' >> "$T"`,
    `printf 'VALUE = 1\\n' > ${L.shellQuote(`${src}/${DRY_MODULE}.py`)}`,
    `printf '\\nfrom . import ${DRY_MODULE}\\n' >> ${L.shellQuote(`${src}/__init__.py`)}`,
    'mkdir -p .git/info && printf \'* filter=commit0\\n\' >> .git/info/attributes',
    `git config filter.commit0.smudge 'touch ${DRY_MARKS[0]}; cat'`,
    `git config filter.commit0.clean 'touch ${DRY_MARKS[0]}; cat'`,
    `printf '#!/bin/sh\\ntouch ${DRY_MARKS[1]}\\n' > /tmp/commit0-fsmonitor && chmod +x /tmp/commit0-fsmonitor`,
    'git config core.fsmonitor /tmp/commit0-fsmonitor',
    'echo "$T"',
  ].join('\n');
  const r = put.code === 0 ? await inBox(sb, ['sh', '-c', script], { workdir: lib.workdir }) : put;
  const test = r.stdout.trim();
  must(check(lib.name, 'fixture arm', r.code === 0 && Boolean(test), r.code === 0
    ? `the reference's source, ${src}/${DRY_MODULE}.py imported by ${src}/__init__.py, ${test} edited, a smudge and clean filter and core.fsmonitor set`
    : r.stderr.trim()), 'the fixture arm failed');
  return { module: `${src}/${DRY_MODULE}.py`, init: `${src}/__init__.py`, test };
}

/** Whether the fresh eval counted the fixture arm's source and nothing else of its box. */
async function checkFixtureScored(lib, sb, fixture, scored, evalBox, baseline) {
  const failures = [];
  for (const p of [fixture.module, fixture.init]) if (!scored.copied.includes(p)) failures.push(`${p} did not cross`);
  if (!scored.excluded.some((e) => e.path === fixture.test && /test/.test(e.reason))) failures.push(`${fixture.test} was not left out as a test`);
  const edited = await inBox(evalBox, ['grep', '-c', DRY_TEST, fixture.test], { workdir: lib.workdir });
  if (edited.stdout.trim() !== '0') failures.push(`the eval box's ${fixture.test} holds the arm's edit`);
  const ran = await inBox(evalBox, ['sh', '-c', `ls ${DRY_MARKS.join(' ')} 2>/dev/null; true`]);
  if (ran.stdout.trim()) failures.push(`the arm's git configuration ran in the eval box: ${ran.stdout.trim()}`);
  for (const mark of DRY_MARKS) if ((await docker(['cp', `${sb.box}:${mark}`, os.devNull])).code === 0) failures.push(`the arm's git configuration ran in its own box after it ended: ${mark}`);
  const t = scored.tests;
  if (!(t?.passed > (baseline?.passed ?? 0))) failures.push(`${t?.passed ?? 'no'} passed, not more than the baseline's ${baseline?.passed ?? 0}`);
  const broken = (t?.collectionErrors ?? []).filter((e) => String(e).includes(DRY_MODULE));
  if (broken.length) failures.push(`collection errors name ${DRY_MODULE}: ${broken.slice(0, 2).join(' | ')}`);
  check(lib.name, 'fresh eval counts the fixture arm\'s source alone', failures.length === 0, failures.length ? failures
    : `${t.passed} passed against the baseline's ${baseline?.passed ?? 0}: the source edit and ${fixture.module} counted; the test edit, the filters and core.fsmonitor did not reach the eval`);
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

async function runOne(lib, arm, ordewell, runsDir, preflightChecks) {
  const settings = L.armSettings(arm, opts);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const runId = L.runIdFor({ stamp, lib: lib.name, arm: arm.id, seed: opts.seed });
  const runDir = path.join(runsDir, runId);
  fs.mkdirSync(runDir, { recursive: true });
  console.log(`\n${lib.name}, arm ${arm.id} (${arm.label}; cap $${settings.capUsd}, ${settings.wallCapMs / 3_600_000} h; supervisor ${settings.supervisorLevel}, ${settings.parallel} at once, ${settings.cpus} CPUs, ${settings.memory}) -> ${runDir}`);
  const startedAt = new Date().toISOString();
  const first = checks.length;
  let sb = null;
  const record = { window: { window: null }, egress: null, leak: null, network: null, tests: null, baseline: null, baselineEval: null, arm: null, transcripts: null, files: null, scoring: null };
  try {
    sb = await openSandbox(lib, runId, ordewell.runtime, settings);
    record.egress = await checkEgress(lib, sb);
    record.window = await checkWindow(lib, sb);
    must(record.egress.ok && record.window.ok, 'the window or egress check failed: nothing runs');
    if (opts.fixture) {
      await prepareFixture(lib, sb);
    }
    const reference = await collectReference(lib, sb);
    must(reference.ok, 'the tests do not collect offline at the reference');
    const refFiles = opts.dryRun ? await exportReferenceFiles(lib, sb, runDir) : null;
    record.leak = await flattenAndProbe(lib, sb);
    must(record.leak.ok, 'the reference implementation is reachable: nothing runs');
    record.network = await collect(lib, sb, reference);
    must(record.network.ok, 'a dependency is missing from the image');
    const base = await evaluate(lib, sb, fs.createWriteStream(path.join(runDir, 'baseline-tests.log')));
    const br = L.baselineRecord(base);
    record.baselineEval = base;
    record.baseline = br.baseline ?? { collected: (base.passed ?? 0) + (base.failed ?? 0) + (base.errors ?? 0) + (base.skipped ?? 0), passed: base.passed, failed: base.failed, errors: base.errors, exit: base.exit, timedOut: base.timedOut };
    check(lib.name, 'baseline on the stubs', br.ok, br.baseline
      ? `collected 0 at the stubs (exit ${base.exit}): ${br.baseline.reason}; the library's own, recorded as the baseline`
      : br.ok ? `${base.passed} passed, ${base.failed} failed, ${base.errors ?? 0} errors of ${record.network.collected} collected (exit ${base.exit})` : `no summary (exit ${base.exit}${base.timedOut ? ', timed out' : ''})`);
    let fixture = null;
    if (opts.dryRun) {
      await dryArm(lib, sb, arm, settings, runDir);
      fixture = await fixtureArm(lib, sb, refFiles);
    } else {
      record.arm = await realArm(lib, sb, arm, settings, runDir);
      if (record.arm.stopped?.why === 'no-start') {
        check(lib.name, `arm ${arm.id} run started`, false, record.arm.stopped.detail);
        throw new Abort(`the run never started: ${record.arm.stopped.detail}`);
      }
      record.truncated = L.judgeLanding({ stopped: record.arm.stopped, stalled: record.arm.stalled, plan: record.arm.finalPlan });
    }
    const copy = await copyArmWorkdir(lib, sb, path.join(runDir, 'arm-workdir'));
    record.files = filesToScore(lib, arm, copy, record.arm?.finalPlan ?? null);
    const inspect = fixture ? (box, scored) => checkFixtureScored(lib, sb, fixture, scored, box, record.baseline) : null;
    record.scoring = await scoreInFreshBox(lib, record.files.dir, { runId, settings, runDir, inspect });
    if (record.scoring.patchError) record.files.patches[0].error = record.scoring.patchError;
    record.tests = record.scoring.tests ? { ...record.scoring.tests, collected: record.network.collected } : null;
  } catch (err) {
    if (!(err instanceof Abort)) throw err;
    console.log(`  stopped: ${err.message}`);
    record.aborted = err.message;
  } finally {
    if (sb) {
      await copyOut(sb, `${BOX_HOME}/.ordewell`, path.join(runDir, 'ordewell-home'));
      await copyOut(sb, path.posix.join(lib.workdir, '.ordewell'), path.join(runDir, 'workspace-ordewell'));
      record.transcripts = readTranscripts(path.join(runDir, 'ordewell-home'));
      if (opts.keep && opts.dryRun) {
        openSandboxes.delete(sb);
        console.log(`  kept, stopped once its files were copied out: docker start ${sb.box}; clean up with: docker rm -f ${sb.box} ${sb.proxy}; docker network rm ${sb.network}`);
      } else await sb.close();
    }
  }
  const armChecks = checks.slice(first);
  const plan = record.arm?.finalPlan ?? null;
  const recorded = plan ? L.recordedSpend(plan) : null;
  const sessionId = record.arm?.sessionId ?? null;
  const metrics = plan && sessionId ? L.runMetrics(plan, L.readTaskLogs(path.join(runDir, 'workspace-ordewell'), sessionId, plan)) : null;
  const validity = L.judgeValidity({ aborted: record.aborted, checks: [...preflightChecks, ...armChecks], tests: record.tests, freshness: ordewell.freshness, stopped: record.arm?.stopped, dryRun: opts.dryRun });
  const result = {
    ...L.resultRecord({
      lib, arm, settings, window: record.window, ordewell, egress: record.egress, leak: record.leak, network: record.network,
      tests: record.tests, baseline: record.baseline, wallClockMs: record.arm?.wallClockMs,
      spend: record.arm?.billed ?? (record.transcripts?.sessions ? { billedUsd: record.transcripts.spendUsd, source: 'runner transcripts (the key could not be read)' } : null),
      transcripts: record.transcripts, stopped: record.arm?.stopped, stalled: record.arm?.stalled, truncated: record.truncated,
      scoredFrom: record.files?.scoredFrom, scoring: record.scoring, patches: record.files?.patches, validity,
      providerPin: opts.providerPin, dryRun: opts.dryRun, startedAt, endedAt: new Date().toISOString(),
    }),
    seed: opts.seed,
    batchDir: opts.batchDir,
    // What Ordewell recorded for the session: the planner's turns, the supervisor's and every attempt's, as the providers priced them.
    recordedUsd: recorded?.usd ?? null,
    recorded,
    metrics,
    ordewellRoot: ordewell.root,
    distFreshness: { stale: ordewell.freshness.stale, allowed: ordewell.freshness.allowed, detail: ordewell.freshness.detail },
    sessionId,
    steps: record.arm?.steps ?? null,
    closing: record.arm?.closing ?? null,
    tasks: record.files?.chosen ?? null,
    baselineEval: record.baselineEval,
    aborted: record.aborted ?? null,
    checks: armChecks,
  };
  fs.writeFileSync(path.join(runDir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
  // A batch appends its runs' results itself, one at a time, once they have all ended.
  if (!opts.dryRun && !opts.batchDir) fs.appendFileSync(path.join(path.dirname(runsDir), 'results.jsonl'), `${JSON.stringify(result)}\n`);
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

async function main() {
  if (opts.sweep) {
    console.log('Commit0 sweep: labelled containers and networks of drivers no longer running');
    printSweep(await sweep());
    if (!opts.dryRun && !opts.run) return;
  }
  const dataDir = checkedBenchDir('commit0');
  const runsDir = opts.batchDir ?? path.join(dataDir, opts.dryRun ? 'dry-runs' : 'runs');
  fs.mkdirSync(runsDir, { recursive: true });
  const libs = loadLibraries();
  console.log(`Commit0 driver: ${opts.dryRun ? 'DRY RUN, no model call' : 'RUN, spending on the key'}; model ${L.MODEL_ID}; provider pin ${opts.providerPin ?? 'not given'}; Ordewell from ${ORDEWELL_ROOT}; data in ${dataDir}`);
  if (opts.run && !process.env.OPENROUTER_API_KEY) throw new Error('--run needs OPENROUTER_API_KEY');
  // A batch holds the key's lock for all its runs.
  const release = opts.run && !opts.batchDir ? L.lockKey(dataDir) : () => {};
  if (opts.run) process.on('exit', release);
  const results = [];
  try {
    const ordewell = await preflight();
    if (opts.dryRun) await checkSweep(libs[0].image);
    const preflightChecks = checks.filter((c) => c.scope === 'preflight');
    for (const lib of libs) {
      for (const arm of L.armsOf(opts.arm)) results.push(await runOne({ ...lib }, arm, ordewell, runsDir, preflightChecks));
    }
  } catch (err) {
    if (!(err instanceof Abort)) throw err;
    console.log(`stopped: ${err.message}`);
  } finally {
    release();
  }
  const failed = checks.filter(L.failedCheck);
  const unverified = checks.filter((c) => c.unverified);
  const expected = checks.filter((c) => c.expectedFailure && !c.ok);
  console.log(`\n${checks.length} checks: ${checks.length - failed.length - unverified.length - expected.length} ok, ${failed.length} failed, ${unverified.length} unverified${expected.length ? `, ${expected.length} failed as expected` : ''}`);
  for (const r of results) console.log(`  ${r.library} ${r.arm}: window ${r.contextWindow ?? '-'}, ${r.tests ? `${r.tests.passed}/${r.tests.collected} passed, scored from ${r.scoredFrom}` : 'no arm run'}, ${r.networkDeselected ?? '-'} network-marked left out; ${r.valid ? 'valid' : `not valid: ${r.invalidReasons.join('; ')}`}${r.aborted ? `, stopped: ${r.aborted}` : ''}`);
  process.exitCode = failed.length || results.some((r) => r.aborted) ? 1 : 0;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  bailOut('error', 1);
});
