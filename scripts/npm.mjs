// npm, started the same way on every platform. On Windows npm is npm.cmd,
// which Node starts only through a shell, so spawnSync('npm') failed there
// before a step ran. Run as `npm run …`, npm names its own CLI in
// npm_execpath, and node starts that anywhere; started some other way on
// Windows, the shell is used, which these fixed arguments need no quoting for.
import { spawnSync } from 'node:child_process';

const cli = /npm-cli\.[cm]?js$/.test(process.env.npm_execpath ?? '') ? process.env.npm_execpath : undefined;

/** Run npm with `args`, its output on this terminal, and answer its exit status. */
export function npm(args, env = {}) {
  const options = { stdio: 'inherit', env: { ...process.env, ...env } };
  const done = cli
    ? spawnSync(process.execPath, [cli, ...args], options)
    : spawnSync('npm', args, { ...options, shell: process.platform === 'win32' });
  return done.status ?? 1;
}
