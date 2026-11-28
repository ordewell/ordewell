// npm, started the same way on every platform. On Windows npm is npm.cmd,
// which Node starts only through a shell, so spawnSync('npm') failed there
// before a step ran. Run as `npm run …`, npm names its own CLI in
// npm_execpath, and node starts that anywhere. Started some other way on
// Windows, the CLI beside node.exe is used, and failing that the shell.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

// Windows' Node installer puts npm's CLI beside node.exe: started from there,
// a path argument with a space in it never meets a shell that would split it.
const besideNode = process.platform === 'win32' ? join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js') : undefined;
const cli = /npm-cli\.[cm]?js$/.test(process.env.npm_execpath ?? '')
  ? process.env.npm_execpath
  : besideNode && existsSync(besideNode) ? besideNode : undefined;

/** How to start npm with `args`: the file, its arguments and whether it needs a shell, for a caller that keeps npm's output. */
export function npmCommand(args) {
  return cli
    ? { file: process.execPath, args: [cli, ...args], shell: false }
    : { file: 'npm', args, shell: process.platform === 'win32' };
}

/** Run npm with `args`, its output on this terminal, and answer its exit status. */
export function npm(args, env = {}) {
  const { file, args: argv, shell } = npmCommand(args);
  return spawnSync(file, argv, { stdio: 'inherit', env: { ...process.env, ...env }, shell }).status ?? 1;
}
