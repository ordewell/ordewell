// The workspaces the desktop app is built from their dist/, rebuilt before
// `desktop:dev` and `desktop:package` use them. Main and the renderer import
// @ordewell/core and @ordewell/ui by their package exports, which are dist/,
// and the daemon main forks is @ordewell/web's dist, which loads core's. A
// dist/ left from an older checkout would otherwise run under a current app,
// with nothing at run time able to tell: the daemon reports the same version
// and contract. Whether a dist/ is current cannot be read off it (a
// modification time says when, not from what), and the builds take seconds,
// so they always run.
import { npm } from '../../../scripts/npm.mjs';

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

/**
 * Build each in order and stop at the first that fails. `run` answers an exit
 * status. Returns null, or a message naming the build that failed.
 */
export function buildWorkspaces(run = npm, env = {}) {
  for (const name of DESKTOP_WORKSPACES) {
    const args = buildArgs(name);
    const status = run(args, env);
    if (status !== 0) {
      return `Building @ordewell/${name} failed (\`npm ${args.join(' ')}\` exited with ${status}). The desktop app runs on its dist/, so fix the build above and run this again.`;
    }
  }
  return null;
}
