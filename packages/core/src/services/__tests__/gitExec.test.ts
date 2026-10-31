import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join, relative } from 'path';
import { cleanEnv, execFileWithTimeout, git, isAncestor, subcommandOf } from '../gitExec';

const REPO_ROOT = join(__dirname, '../../../../..');

/** Every source file of every package, tests aside. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' || entry.name === 'node_modules' ? [] : sourceFiles(file);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [file] : [];
  });
}

const withoutComments = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('gitExec', () => {
  const saved = { ...process.env };
  afterEach(() => { process.env = { ...saved }; });

  it('names the subcommand past global options', () => {
    expect(subcommandOf(['-c', 'commit.gpgsign=false', 'commit', '--no-verify', '-q'])).toBe('commit');
    expect(subcommandOf(['-C', '/repo', 'status'])).toBe('status');
    expect(subcommandOf(['--version'])).toBe('--version');
  });

  it('reports a failed rescue commit as a commit', async () => {
    const invoker = {
      exec: async () => { throw Object.assign(new Error('boom'), { stderr: 'hook refused', code: 1 }); },
      resolvePath: async () => '',
    };
    await expect(git(invoker, '/repo', ['-c', 'commit.gpgsign=false', 'commit', '-m', 'x'])).rejects.toThrow('git commit failed: hook refused');
  });

  describe('isAncestor', () => {
    const answering = (outcome: { code?: string | number } | 'exit 0') => ({
      exec: async () => {
        if (outcome === 'exit 0') return { stdout: '', stderr: '' };
        throw Object.assign(new Error('git'), { stderr: '', ...outcome });
      },
      resolvePath: async () => '',
    });

    it.each([
      ['exit 0', 'exit 0', 'yes'],
      ['exit 1', { code: 1 }, 'no'],
      ['exit 128', { code: 128 }, 'unknown'],
      ['a timeout', { code: 'ETIMEDOUT' }, 'unknown'],
      ['a signal, which leaves no exit code', { code: undefined }, 'unknown'],
    ] as const)('reads %s', async (_, outcome, answer) => {
      expect(await isAncestor(answering(outcome), '/repo', 'a', 'b')).toBe(answer);
    });

    it('asks git about the two commits, the ancestor first', async () => {
      const asked: string[][] = [];
      const invoker = { exec: async (_: string, args: string[]) => { asked.push(args); return { stdout: '', stderr: '' }; }, resolvePath: async () => '' };
      await isAncestor(invoker, '/repo', 'a', 'b');
      expect(asked).toEqual([['merge-base', '--is-ancestor', 'a', 'b']]);
    });

    // Rounds 9, 10 and 11 of the revert review each found a read that took a failed query as no.
    it('is the one place any package asks', () => {
      const packages = join(REPO_ROOT, 'packages');
      const files = readdirSync(packages).map((name) => join(packages, name, 'src')).filter((src) => existsSync(src)).flatMap(sourceFiles);
      expect(files.length).toBeGreaterThan(100);
      const asking = files.flatMap((file) => {
        const uses = withoutComments(readFileSync(file, 'utf8')).match(/--is-ancestor/g) ?? [];
        return uses.map(() => relative(REPO_ROOT, file).replace(/\\/g, '/'));
      });
      expect(asking).toEqual(['packages/core/src/services/gitExec.ts']);
    });
  });

  it('drops inherited variables that would redirect or reconfigure git', () => {
    Object.assign(process.env, { GIT_DIR: '/outer', GIT_CONFIG_PARAMETERS: "'core.hooksPath'='/x'", GIT_CONFIG_COUNT: '1', GIT_EXEC_PATH: '/other' });
    const env = cleanEnv();
    for (const key of ['GIT_DIR', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT', 'GIT_EXEC_PATH']) expect(env[key]).toBeUndefined();
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
  });

  describe('a call that never returns', () => {
    const hang = ['-e', 'setInterval(() => {}, 1000)'];

    it('is ended with SIGTERM so git can release its locks, and reported as a timeout', async () => {
      const exec = execFileWithTimeout(300);
      const err = await exec(process.execPath, hang, { env: process.env }).catch((e: unknown) => e);

      expect(err).toMatchObject({
        code: 'ETIMEDOUT',
        killed: true,
        signal: 'SIGTERM',
        stderr: expect.stringMatching(/^timed out after 0\.3 seconds/),
      });
    });
  });
});
