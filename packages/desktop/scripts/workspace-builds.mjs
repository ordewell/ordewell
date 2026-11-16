// The workspaces the desktop app is built from their dist/, rebuilt before
// `desktop:dev` and `desktop:package` use them. Main and the renderer import
// @ordewell/core and @ordewell/ui by their package exports, which are dist/,
// and the daemon main forks is @ordewell/web's dist, which loads core's. A
// dist/ left from an older checkout would otherwise run under a current app,
// with nothing at run time able to tell: the daemon reports the same version
// and contract. Whether a dist/ is current cannot be read off it (a
// modification time says when, not from what), and the builds take seconds,
// so they always run.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { npm } from '../../../scripts/npm.mjs';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

/** In build order: ui and web compile against core's types. */
export const DESKTOP_WORKSPACES = ['core', 'ui', 'web'];

/**
 * The npm arguments that build one of them. By name, not by path as the root
 * `npm run build` has it: npm resolves a path against its working directory,
 * which is packages/desktop when these run as its scripts.
 */
export function buildArgs(name) {
  return ['run', 'build', '-w', `@ordewell/${name}`];
}

const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
};

/**
 * The dependencies the builds read whose installed copy is not the one
 * package-lock.json pins, each as `name (wants X, has Y)`. A checkout that
 * added or bumped one leaves node_modules behind until `npm install`, and the
 * build then fails on a missing module as if the code were wrong.
 */
export function installDrift(root = REPO_ROOT) {
  const lock = readJson(join(root, 'package-lock.json'))?.packages;
  if (!lock) return [];
  const drift = [];
  for (const dir of ['.', ...DESKTOP_WORKSPACES.map((name) => `packages/${name}`), 'packages/desktop']) {
    const { dependencies = {}, devDependencies = {} } = readJson(join(root, dir, 'package.json')) ?? {};
    for (const name of Object.keys({ ...dependencies, ...devDependencies })) {
      // npm hoists to the root unless two versions clash, as its resolver does.
      const keys = dir === '.' ? [`node_modules/${name}`] : [`${dir}/node_modules/${name}`, `node_modules/${name}`];
      const key = keys.find((candidate) => lock[candidate]);
      const pinned = key && lock[key];
      // A workspace is a link, and an optional one is absent on other platforms by design.
      if (!pinned || pinned.link || pinned.optional) continue;
      const installed = readJson(join(root, ...key.split('/'), 'package.json'))?.version;
      if (installed !== pinned.version) drift.push(`${name} (wants ${pinned.version}, has ${installed ?? 'none'})`);
    }
  }
  return [...new Set(drift)];
}

/**
 * Build each in order and stop at the first that fails. `run` answers an exit
 * status. Returns null, or a message naming why it stopped.
 */
export function buildWorkspaces(run = npm, env = {}, root = REPO_ROOT) {
  const drift = existsSync(join(root, 'node_modules')) ? installDrift(root) : ['node_modules (none installed)'];
  if (drift.length > 0) {
    const shown = drift.slice(0, 8).join(', ') + (drift.length > 8 ? `, and ${drift.length - 8} more` : '');
    return `The installed dependencies do not match package-lock.json: ${shown}. Run \`npm install\` from the repository root (a pull or a branch switch changes them), then run this again.`;
  }
  for (const name of DESKTOP_WORKSPACES) {
    const args = buildArgs(name);
    const status = run(args, env);
    if (status !== 0) {
      return `Building @ordewell/${name} failed (\`npm ${args.join(' ')}\` exited with ${status}). The desktop app runs on its dist/, so fix the build above and run this again.`;
    }
  }
  return null;
}
