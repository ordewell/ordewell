import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BubblewrapBackend } from '../bubblewrap';
import { MEMORY_LIMIT_SIGNAL, type SandboxProfile } from '../SandboxBackend';

/**
 * The memory watcher bubblewrap's prelude starts, run as text under the shells
 * Linux's `/bin/sh` is, against a fake `/proc` and a program standing for
 * bubblewrap. A Mac has no real one to run it in, and this is what that leaves
 * checkable there: `scripts/linux-sandbox-e2e.sh` runs the real thing.
 */

const SHELLS = ['/bin/dash', '/bin/bash'].filter((shell) => existsSync(shell));
const LIMIT_KB = 100 * 1024;

describe.each(SHELLS)('the bubblewrap memory watcher, under %s', (shell) => {
  let proc: string;

  beforeEach(() => {
    proc = mkdtempSync(join(tmpdir(), 'ordewell-fake-proc-'));
  });

  afterEach(() => {
    rmSync(proc, { recursive: true, force: true });
  });

  const SEALED: SandboxProfile = {
    write: [], read: ['/usr'], network: false, env: {},
    limits: { processes: 2000, memoryBytes: LIMIT_KB * 1024, addressSpaceBytes: 8 * 1024 ** 4, wallTimeMs: 60_000 },
  };
  /** A planner command's profile: no limits, so nothing of the sum the memory limit needs. */
  const PLANNER: SandboxProfile = { write: [], read: 'host', network: false, env: {} };

  function launcherArgs(profile: SandboxProfile, edit: (script: string) => string = (script) => script): string[] {
    const [flag, script, name] = new BubblewrapBackend('/usr/bin/bwrap').wrap({ shell: '/bin/sh', shellArgs: ['-c'], env: {} }, profile).args;
    // Linux's `/proc/$$` is there from the start, and the watcher takes its going to mean the run ended.
    return [flag, `mkdir -p '${proc}/'$$ '${proc}/'$PPID\n${edit(script).replaceAll('/proc/', `${proc}/`)}`, name];
  }

  /** The launcher's last argument: a program file, since bubblewrap takes the arguments the prelude adds. */
  function program(body: string): string {
    const file = join(proc, 'bwrap');
    writeFileSync(file, `#!${shell}\n${body}\n`);
    chmodSync(file, 0o755);
    return file;
  }

  /**
   * Stands for bubblewrap: the same pid as the prelude, since that execs it,
   * with its namespace's first process, a child, as a `sleep` the watcher can
   * really kill. The fake entries say what `/proc` would.
   */
  function bubblewrap(rssKb: number): string {
    return [
      `mkdir -p '${proc}/'$$/ns '${proc}/host' && : > '${proc}/host/pid' && ln '${proc}/host/pid' '${proc}/'$$/ns/pid`,
      `printf 'Name:\\tbwrap\\nPPid:\\t1\\n' > '${proc}/'$$/status`,
      'sleep 30 & root=$!',
      `mkdir -p '${proc}/'$root/ns '${proc}/sandbox' && : > '${proc}/sandbox/pid' && ln '${proc}/sandbox/pid' '${proc}/'$root/ns/pid`,
      `printf 'Name:\\tsh\\nPPid:\\t%s\\nVmRSS:\\t  1024 kB\\n' $$ > '${proc}/'$root/status`,
      // Another process in the namespace, and one in a namespace of its own, which is not the run's.
      `mkdir -p '${proc}/7/ns' '${proc}/8/ns' && ln '${proc}/sandbox/pid' '${proc}/7/ns/pid' && : > '${proc}/8/ns/pid'`,
      `printf 'Name:\\tnode\\nPPid:\\t%s\\nVmRSS:\\t  ${rssKb} kB\\n' $root > '${proc}/7/status'`,
      `printf 'Name:\\tother\\nPPid:\\t1\\nVmRSS:\\t  ${LIMIT_KB * 8} kB\\n' > '${proc}/8/status'`,
      'echo root=$root',
      'wait $root',
      'exit 7',
    ].join('\n');
  }

  function run(rssKb: number): Promise<{ code: number | null; signal: NodeJS.Signals | null; root: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(shell, [...launcherArgs(SEALED), program(bubblewrap(rssKb))], { stdio: ['ignore', 'pipe', 'ignore'] });
      let out = '';
      child.stdout.on('data', (chunk) => { out += String(chunk); });
      child.on('error', reject);
      child.on('close', (code, signal) => resolve({ code, signal, root: /root=(\d+)/.exec(out)?.[1] ?? '' }));
      // Past the first polls, a run still under its limit ends on its own.
      if (rssKb <= LIMIT_KB) setTimeout(() => { process.kill(Number(/root=(\d+)/.exec(out)?.[1]), 'SIGTERM'); }, 3_500);
    });
  }

  it('ends the launch with the signal, and the sandbox with it, when the namespace passes the limit', async () => {
    const result = await run(LIMIT_KB + 1);

    expect(result).toMatchObject({ code: null, signal: MEMORY_LIMIT_SIGNAL });
    // The watcher signals the launcher first and the namespace's first process next, so the
    // launch can close between the two kills, and a killed process is there until init reaps it.
    await vi.waitFor(() => expect(() => process.kill(Number(result.root), 0)).toThrow());
  });

  it('sums only the namespace, and leaves a run under the limit to end on its own', async () => {
    expect(await run(LIMIT_KB - 2048)).toMatchObject({ code: 7, signal: null });
  });

  /**
   * Stands for bubblewrap killed before its child armed the death signal: a
   * child that outlives it, and whose parent no longer says whose it was. Its
   * `cmdline` is bubblewrap's own, as a clone's is, so a fake `/proc` says of it
   * what the real one would. A neighbour has the same but for the pid, which
   * is the launcher's with a digit more, so it is another run's.
   */
  function orphaned(): string {
    return [
      'exec 3>&1 >/dev/null 2>&1',
      'sleep 30 & root=$!',
      'sleep 30 & other=$!',
      `mkdir -p '${proc}/'$root '${proc}/'$other`,
      `printf '%s\\000' "$0" "$@" > '${proc}/'$root/cmdline`,
      `printf '%s\\000' "$0" "$@" | sed "s/$$/$$0/g" > '${proc}/'$other/cmdline`,
      'echo "root=$root other=$other launcher=$$" >&3',
      'wait $root',
    ].join('\n');
  }

  function start(args: string[]): { child: ReturnType<typeof spawn>; pids: Promise<{ root: number; other: number; launcher: number }> } {
    const child = spawn(shell, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    const pids = new Promise<{ root: number; other: number; launcher: number }>((resolve) => {
      let out = '';
      child.stdout!.on('data', (chunk) => {
        out += String(chunk);
        const found = /root=(\d+) other=(\d+) launcher=(\d+)/.exec(out);
        if (found) resolve({ root: Number(found[1]), other: Number(found[2]), launcher: Number(found[3]) });
      });
    });
    return { child, pids };
  }

  function alive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  const LAUNCHES: [string, SandboxProfile][] = [['a sealed run', SEALED], ['a planner command', PLANNER]];

  it.each(LAUNCHES)("ends %s the launcher's death left behind, and no other run's", async (_launch, profile) => {
    const { child, pids } = start([...launcherArgs(profile), program(orphaned())]);
    const { root, other } = await pids;
    try {
      child.kill('SIGKILL');
      rmSync(join(proc, String(child.pid)), { recursive: true });

      await vi.waitFor(() => expect(alive(root)).toBe(false));
      expect(alive(other)).toBe(true);
    } finally {
      for (const pid of [root, other]) if (alive(pid)) process.kill(pid, 'SIGKILL');
    }
  });

  it.each(LAUNCHES)('ends the launcher of %s, and so the sandbox, when its caller died before the launcher armed its own death signal', async (_launch, profile) => {
    // The caller: a shell that can be killed while the launcher, in the background, goes on.
    const { child, pids } = start(['-c', '"$@" & wait', 'caller', shell, ...launcherArgs(profile), program(orphaned())]);
    const { root, other, launcher } = await pids;
    try {
      child.kill('SIGKILL');
      rmSync(join(proc, String(child.pid)), { recursive: true });

      await vi.waitFor(() => expect(alive(launcher)).toBe(false));
      rmSync(join(proc, String(launcher)), { recursive: true });
      await vi.waitFor(() => expect(alive(root)).toBe(false));
    } finally {
      for (const pid of [root, other, launcher]) if (alive(pid)) process.kill(pid, 'SIGKILL');
    }
  });

  it('runs a planner command with no watcher on a host where it cannot wait, and does not spin', async () => {
    const noPrograms = (script: string) => script.replaceAll(/PATH=\S+/g, `PATH=${proc}/nothing`);
    const children = program(['/bin/sleep 1', '/usr/bin/pgrep -P $$', 'exit 0'].join('\n'));
    const child = spawn(shell, [...launcherArgs(PLANNER, noPrograms), children], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (chunk) => { out += String(chunk); });
    const [code] = await once(child, 'close');

    expect(code).toBe(0);
    expect(out).toBe('');
  });
});
