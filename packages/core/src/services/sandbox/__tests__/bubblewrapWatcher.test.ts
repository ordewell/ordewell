import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

  function prelude(): string {
    const profile: SandboxProfile = {
      write: [], read: ['/usr'], network: false, env: {},
      limits: { processes: 2000, memoryBytes: LIMIT_KB * 1024, addressSpaceBytes: 8 * 1024 ** 4, wallTimeMs: 60_000 },
    };
    const [, script] = new BubblewrapBackend('/usr/bin/bwrap').wrap({ shell: '/bin/sh', shellArgs: ['-c'], env: {} }, profile).args;
    // Linux's `/proc/$$` is there from the start, and the watcher takes its going to mean the run ended.
    return `mkdir -p '${proc}/'$$\n${script.replaceAll('/proc/', `${proc}/`)}`;
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
      const child = spawn(shell, ['-c', prelude(), 'ordewell-sealed', shell, '-c', bubblewrap(rssKb)], { stdio: ['ignore', 'pipe', 'ignore'] });
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
    // The namespace's first process is gone with the rest of it.
    expect(() => process.kill(Number(result.root), 0)).toThrow();
  });

  it('sums only the namespace, and leaves a run under the limit to end on its own', async () => {
    expect(await run(LIMIT_KB - 2048)).toMatchObject({ code: 7, signal: null });
  });
});
