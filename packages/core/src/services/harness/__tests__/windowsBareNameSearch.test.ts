import { spawnSync } from 'child_process';
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * How Windows, through Node, finds a program started by bare name, the way Pi
 * starts its search tools when it has none of its own: `spawnSync('rg',
 * ['--version'])` from its cwd, then `spawn('rg', ..., { cwd })` in the folder
 * searched. A repository that ships an `rg.exe` could have it run by a Pi
 * planner or read-only task, which must never execute repository code
 * (ADR-0008). Each case is observed with a copy of this node.exe named
 * `rg.exe`, which prints its own path when asked for `process.execPath`.
 *
 * Windows only: POSIX never looks in the current directory for a bare name.
 */
describe.runIf(process.platform === 'win32')('a bare program name on Windows, started through Node', () => {
  let root: string;
  /** The "repository": a folder holding an rg.exe. */
  let repo: string;
  /** A folder on PATH holding another rg.exe. */
  let onPath: string;
  /** A folder on PATH holding no rg. */
  let empty: string;

  beforeAll(() => {
    root = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'ordewell-bare-name-')));
    repo = path.join(root, 'repo');
    onPath = path.join(root, 'on-path');
    empty = path.join(root, 'empty');
    for (const dir of [repo, onPath, empty]) mkdirSync(dir);
    copyFileSync(process.execPath, path.join(repo, 'rg.exe'));
    copyFileSync(process.execPath, path.join(onPath, 'rg.exe'));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  /** This process's environment with PATH replaced and `extra` added, one key per name as Windows holds them. */
  function env(pathValue: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
    const kept = Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'PATH' && key.toUpperCase() !== 'NODEFAULTCURRENTDIRECTORYINEXEPATH');
    return { ...Object.fromEntries(kept), PATH: pathValue, ...extra };
  }

  /** Which rg.exe a bare `rg` started from `cwd` ran, by its own word, or why none did. */
  function whichRan(cwd: string, childEnv: NodeJS.ProcessEnv): string {
    const run = spawnSync('rg', ['-p', 'process.execPath'], { cwd, env: childEnv, encoding: 'utf8' });
    const seen = run.error ? `error ${(run.error as NodeJS.ErrnoException).code}` : realpathSync.native(run.stdout.trim());
    // A record for whoever reads CI's log: the outcome is the evidence, whichever way it goes.
    console.log(`[bare-name] cwd=${path.relative(root, cwd)} PATH=${childEnv.PATH === undefined ? '' : path.relative(root, childEnv.PATH)} NoDefault=${childEnv.NoDefaultCurrentDirectoryInExePath ?? '-'} -> ${run.error ? seen : path.relative(root, seen)}`);
    return seen;
  }

  /**
   * The same, with the start made by a node child whose own environment
   * carries `childEnv`, as Pi's would when Ordewell started it so: the child
   * spawns `rg` without naming an environment, as Pi does.
   */
  function whichRanThroughChild(cwd: string, childEnv: NodeJS.ProcessEnv): string {
    const script = `const r = require('child_process').spawnSync('rg', ['-p', 'process.execPath'], { cwd: ${JSON.stringify(cwd)}, encoding: 'utf8' }); process.stdout.write(r.error ? 'error ' + r.error.code : r.stdout.trim());`;
    const run = spawnSync(process.execPath, ['-e', script], { cwd: empty, env: childEnv, encoding: 'utf8' });
    const out = run.stdout.trim();
    const seen = out.startsWith('error ') ? out : realpathSync.native(out);
    console.log(`[bare-name] through a child: cwd=${path.relative(root, cwd)} NoDefault=${childEnv.NoDefaultCurrentDirectoryInExePath ?? '-'} -> ${out.startsWith('error ') ? seen : path.relative(root, seen)}`);
    return seen;
  }

  it('runs Pi\'s probe, `rg --version`, from a cwd holding rg.exe when PATH holds none', () => {
    const run = spawnSync('rg', ['--version'], { cwd: repo, env: env(empty), encoding: 'utf8' });
    console.log(`[bare-name] rg --version from repo, PATH=empty -> status=${run.status} error=${run.error ? (run.error as NodeJS.ErrnoException).code : '-'} stdout=${(run.stdout ?? '').trim()}`);
    expect(run.error).toBeUndefined();
    expect(run.stdout.trim()).toBe(process.version);
  });

  it('runs the cwd\'s rg.exe when PATH holds none', () => {
    expect(whichRan(repo, env(empty))).toBe(path.join(repo, 'rg.exe'));
  });

  it('runs the cwd\'s rg.exe ahead of one PATH holds', () => {
    expect(whichRan(repo, env(onPath))).toBe(path.join(repo, 'rg.exe'));
  });

  it('runs PATH\'s rg.exe from a cwd holding none', () => {
    expect(whichRan(empty, env(onPath))).toBe(path.join(onPath, 'rg.exe'));
  });

  it('skips the cwd when NoDefaultCurrentDirectoryInExePath is in the child\'s environment', () => {
    expect(whichRan(repo, env(onPath, { NoDefaultCurrentDirectoryInExePath: '1' }))).toBe(path.join(onPath, 'rg.exe'));
    expect(whichRan(repo, env(empty, { NoDefaultCurrentDirectoryInExePath: '1' }))).toBe('error ENOENT');
  });

  it('skips the cwd for a process started with NoDefaultCurrentDirectoryInExePath, as Pi would be, when it starts rg by bare name', () => {
    expect(whichRanThroughChild(repo, env(onPath))).toBe(path.join(repo, 'rg.exe'));
    expect(whichRanThroughChild(repo, env(onPath, { NoDefaultCurrentDirectoryInExePath: '1' }))).toBe(path.join(onPath, 'rg.exe'));
    expect(whichRanThroughChild(repo, env(empty, { NoDefaultCurrentDirectoryInExePath: '1' }))).toBe('error ENOENT');
  });
});
