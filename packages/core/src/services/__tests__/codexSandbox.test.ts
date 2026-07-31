import { describe, it, expect } from 'vitest';
import { probeCodexSandbox, codexSandboxUnavailableMessage } from '../harness/codexSandbox';
import type { AgentProcessDeps } from '../harness/AgentAdapter';
import { fakeSpawn } from './harnessTestKit';

/**
 * The sandbox capability probe (see `codexSandbox.ts`). What matters here is
 * restraint as much as rescue: the Landlock fallback is deprecated upstream, so
 * it must be reached for only on a machine that demonstrably needs it.
 */

const BWRAP_FAILURE = 'bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted\n';

function deps(
  probe: (args: string[]) => { code: number; output?: string },
  platform: NodeJS.Platform = 'linux',
): { deps: AgentProcessDeps; probes: () => string[][] } {
  const spawned = fakeSpawn([], { probe });
  return {
    deps: {
      spawn: spawned.spawn,
      fetch: (async () => { throw new Error('no HTTP in this test'); }) as unknown as typeof fetch,
      platform,
    },
    probes: spawned.probeArgs,
  };
}

const probe = (d: AgentProcessDeps) => probeCodexSandbox(d, '/repo', {});

describe('probeCodexSandbox', () => {
  it('leaves a working sandbox alone, with one probe', async () => {
    const { deps: d, probes } = deps(() => ({ code: 0 }));

    expect(await probe(d)).toBe('default');
    expect(probes()).toHaveLength(1);
    // Read-only by construction: the probe itself must not be able to write.
    expect(probes()[0]).toEqual(['sandbox', '--', '/bin/true']);
  });

  it('falls back to the legacy Landlock backend when bubblewrap cannot start', async () => {
    const { deps: d, probes } = deps((args) =>
      args.includes('use_legacy_landlock') ? { code: 0 } : { code: 1, output: BWRAP_FAILURE });

    expect(await probe(d)).toBe('legacy-landlock');
    expect(probes()[1]).toEqual(['sandbox', '--enable', 'use_legacy_landlock', '--', '/bin/true']);
  });

  it('reports the sandbox unavailable when neither backend starts', async () => {
    const { deps: d } = deps(() => ({ code: 1, output: BWRAP_FAILURE }));

    expect(await probe(d)).toBe('unavailable');
  });

  it('changes nothing when the probe fails for an unrecognized reason', async () => {
    // An older `codex` without the subcommand, a binary that is not Codex at
    // all: none of these are the user-namespace problem, and opting a healthy
    // Codex into a deprecated backend on that evidence would be a regression.
    const { deps: d, probes } = deps(() => ({ code: 2, output: "error: unrecognized subcommand 'sandbox'\n" }));

    expect(await probe(d)).toBe('default');
    expect(probes()).toHaveLength(1);
  });

  it('does not probe off Linux, where bubblewrap is not the backend', async () => {
    const { deps: d, probes } = deps(() => ({ code: 1, output: BWRAP_FAILURE }), 'darwin');

    expect(await probe(d)).toBe('default');
    expect(probes()).toHaveLength(0);
  });

  it('names both documented fixes when it gives up', async () => {
    const message = codexSandboxUnavailableMessage();

    expect(message).toContain('kernel.apparmor_restrict_unprivileged_userns=0');
    expect(message).toContain('AppArmor profile');
  });
});
