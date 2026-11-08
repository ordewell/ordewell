#!/usr/bin/env node
// The one shellcheck that judges the shell scripts, in CI and locally alike.
// Ubuntu's packaged shellcheck lags a release behind and reports codes the
// newer one renamed (SC2317 against 0.11's SC2329), so a verdict read off
// whatever PATH holds depends on the machine. This fetches the release
// scripts/shellcheck.json pins, checks it against the sha256 recorded there,
// and keeps it under .tools/ (gitignored), where the bench tests look for it.
//
//   node scripts/shellcheck.mjs     fetch it unless the cache holds it; print its path
//
// Zero dependencies: Node's fetch, zlib and a tar reader just big enough for
// the release archive, so a machine without tar or xz fetches it too.
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const PIN = JSON.parse(readFileSync(join(ROOT, 'scripts', 'shellcheck.json'), 'utf8'));
export const TOOLS_DIR = join(ROOT, '.tools', 'shellcheck');
export const FETCH_COMMAND = 'node scripts/shellcheck.mjs';
// Set to a shellcheck binary to judge with that one instead of the cached pin.
export const OVERRIDE_ENV = 'ORDEWELL_SHELLCHECK';

const ARCHES = { x64: 'x64', arm64: 'arm64' };
const SYSTEMS = { linux: 'linux', darwin: 'darwin' };

export const platformKey = (platform = process.platform, arch = process.arch) =>
  SYSTEMS[platform] && ARCHES[arch] ? `${SYSTEMS[platform]}-${ARCHES[arch]}` : undefined;

export const cachedPath = ({ dir = TOOLS_DIR, pin = PIN, key = platformKey() } = {}) =>
  key ? join(dir, pin.version, key, 'shellcheck') : undefined;

// The shellcheck a test should judge with, or undefined when there is none.
// Never the one on PATH: its version is the machine's, which is the drift this
// file exists to remove.
export const resolveShellcheck = (env = process.env, where = {}) => {
  const chosen = env[OVERRIDE_ENV] || cachedPath(where);
  return chosen && existsSync(chosen) ? chosen : undefined;
};

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

// The one entry named `name` (any directory) from a ustar archive. Enough for
// the release tarball: regular files with names under 100 bytes, no GNU longnames.
const untarOne = (tar, name) => {
  for (let at = 0; at + 512 <= tar.length;) {
    const header = tar.subarray(at, at + 512);
    if (header.every((b) => b === 0)) break;
    const field = (start, length) => header.subarray(start, start + length).toString('latin1').replace(/\0.*$/s, '');
    const prefix = field(345, 155);
    const path = prefix ? `${prefix}/${field(0, 100)}` : field(0, 100);
    const size = parseInt(field(124, 12).trim() || '0', 8);
    const type = field(156, 1);
    const body = at + 512;
    if ((type === '0' || type === '') && path.split('/').pop() === name) return tar.subarray(body, body + size);
    at = body + Math.ceil(size / 512) * 512;
  }
  return undefined;
};

const defaultFetcher = async (url) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`GET ${url}: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
};
const defaultSleep = (ms) => new Promise((done) => setTimeout(done, ms));

export const archiveUrl = (pin, entry) =>
  `https://github.com/koalaman/shellcheck/releases/download/${pin.version}/${entry.file}`;

// The pin records the archive's sha256, not the binary's, so the cache keeps
// the archive beside the binary and a hit is the binary that verified archive
// holds. Anything else there, corrupt or substituted, is fetched afresh.
const cacheHolds = (target, archive, entry) => {
  if (!existsSync(target) || !existsSync(archive)) return false;
  const bytes = readFileSync(archive);
  return sha256(bytes) === entry.sha256 && untarOne(gunzipSync(bytes), 'shellcheck')?.equals(readFileSync(target)) === true;
};

const writeAtomically = (target, bytes, mode) => {
  // Written beside the target and renamed into place, so a run cut off midway
  // leaves no half-written file for the next one to take as cached.
  const partial = `${target}.${process.pid}.partial`;
  try {
    writeFileSync(partial, bytes);
    chmodSync(partial, mode);
    renameSync(partial, target);
  } finally {
    rmSync(partial, { force: true });
  }
};

// Fetches the pinned shellcheck into `dir` unless it is already there, and
// returns its path. A download that fails is tried again after a growing wait;
// one whose sha256 is not the pinned one is refused outright, since trying it
// again would only fetch the same wrong bytes.
export async function fetchShellcheck({
  dir = TOOLS_DIR, pin = PIN, key = platformKey(),
  fetcher = defaultFetcher, sleep = defaultSleep, tries = 4, log = () => {},
} = {}) {
  const entry = key && pin.archives[key];
  if (!entry) {
    throw new Error(`shellcheck ${pin.version} is pinned for ${Object.keys(pin.archives).join(', ')}, not ${key ?? `${process.platform}-${process.arch}`}`);
  }
  const target = cachedPath({ dir, pin, key });
  const archive = join(dirname(target), entry.file);
  if (cacheHolds(target, archive, entry)) return target;

  const url = archiveUrl(pin, entry);
  let bytes;
  for (let attempt = 1; ; attempt++) {
    try {
      bytes = await fetcher(url);
      break;
    } catch (error) {
      if (attempt >= tries) throw new Error(`could not download ${url} after ${tries} tries: ${error.message}`);
      const wait = 1000 * 2 ** (attempt - 1);
      log(`download failed (${error.message}); trying again in ${wait / 1000}s`);
      await sleep(wait);
    }
  }
  const got = sha256(bytes);
  if (got !== entry.sha256) {
    throw new Error(`${entry.file} has sha256 ${got}, not the pinned ${entry.sha256}: refusing it`);
  }
  const binary = untarOne(gunzipSync(bytes), 'shellcheck');
  if (!binary) throw new Error(`${entry.file} holds no shellcheck`);

  mkdirSync(dirname(target), { recursive: true });
  writeAtomically(archive, bytes, 0o644);
  writeAtomically(target, binary, 0o755);
  return target;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const path = await fetchShellcheck({ log: (line) => console.error(line) });
    console.log(path);
  } catch (error) {
    console.error(`scripts/shellcheck.mjs: ${error.message}`);
    process.exit(1);
  }
}
