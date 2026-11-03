import { afterEach, describe, expect, it, vi } from 'vitest';
import { RunnerInstallation } from '../RunnerInstallation';
import type { ExecImpl } from '../ModelDiscovery';
import type { RunnerRegistry } from '../../plugins/RunnerRegistry';
import { CLAUDE_CODE_MANIFEST } from '../../plugins/builtin/claude-code.manifest';
import { CODEX_MANIFEST } from '../../plugins/builtin/codex.manifest';
import { OPENCODE_MANIFEST } from '../../plugins/builtin/opencode.manifest';
import type { RunnerAuthExec } from '../runnerAuth';
import {
  defaultEnabledRunners, detectInstalledPlanner, findInstalledPlanner, installedPlannerAnswered, installedPlannerDetected, recordedInstalledPlanner, resetInstalledPlanner,
} from '../InstalledPlanner';

const ALL = [CLAUDE_CODE_MANIFEST, CODEX_MANIFEST, OPENCODE_MANIFEST];

function registryWith(...manifests: Array<{ name: string; runner: { command: string } }>): RunnerRegistry {
  const byName = new Map(manifests.map((m) => [m.name, m]));
  return { getManifest: (id: string) => byName.get(id) } as unknown as RunnerRegistry;
}

/** An exec that answers `--version` only for the given commands. */
function installedOnly(...commands: string[]): ExecImpl {
  return vi.fn(async (command: string) => {
    if (commands.some((c) => command === `${c} --version`)) return { stdout: '1.0.0' };
    throw new Error('command not found');
  });
}

// Auth is beside usability here, so these cases inject a status command that
// answers nothing rather than spawning a real agent.
const quietAuth: RunnerAuthExec = async () => ({ code: -1, stdout: '', stderr: '' });

function installation(manifests: Array<{ name: string; runner: { command: string } }>, exec: ExecImpl): RunnerInstallation {
  // Off Windows' PATH lookup: `exec` alone says what is installed here.
  return new RunnerInstallation(registryWith(...manifests), exec, Date.now, { authExec: quietAuth, launch: { platform: 'linux' } });
}

describe('findInstalledPlanner', () => {
  it('picks the first harness planner in display order when several are installed', async () => {
    const inst = installation(ALL, installedOnly('claude', 'codex', 'opencode'));
    expect(await findInstalledPlanner(inst)).toBe('claude-code');
  });

  it('skips an agent that is not installed', async () => {
    const inst = installation(ALL, installedOnly('opencode'));
    expect(await findInstalledPlanner(inst)).toBe('opencode');
  });

  it('chooses the second agent when only Codex is installed', async () => {
    const inst = installation(ALL, installedOnly('codex'));
    expect(await findInstalledPlanner(inst)).toBe('codex');
  });

  it('skips a first agent whose version answers but whose planner is unusable', async () => {
    const installation = { plannerUsability: vi.fn(async (runner: string) => ({ usable: runner === 'codex' })) };
    expect(await findInstalledPlanner(installation)).toBe('codex');
    expect(installation.plannerUsability.mock.calls.map(([runner]) => runner)).toEqual(['claude-code', 'codex', 'opencode']);
  });

  it('skips an agent with no manifest registered', async () => {
    const inst = installation([CODEX_MANIFEST], installedOnly('claude', 'codex'));
    expect(await findInstalledPlanner(inst)).toBe('codex');
  });

  it('answers null when no coding agent is installed', async () => {
    const inst = installation(ALL, installedOnly());
    expect(await findInstalledPlanner(inst)).toBeNull();
  });

  it('counts one agent\'s failing check as not usable for that agent only', async () => {
    const throwsForClaude = { plannerUsability: vi.fn(async (runner: string) => {
      if (runner === 'claude-code') throw new Error('boom');
      return { usable: runner === 'codex' };
    }) };
    expect(await findInstalledPlanner(throwsForClaude)).toBe('codex');
  });

  it('keeps the display order when a higher-priority check fails', async () => {
    const allUsableButClaudeThrows = { plannerUsability: vi.fn(async (runner: string) => {
      if (runner === 'claude-code') throw new Error('boom');
      return { usable: true };
    }) };
    expect(await findInstalledPlanner(allUsableButClaudeThrows)).toBe('codex');
  });
});

describe('detectInstalledPlanner', () => {
  afterEach(() => resetInstalledPlanner());

  it('records the agent it finds, for detectProvider to read', async () => {
    const inst = installation(ALL, installedOnly('codex'));
    await detectInstalledPlanner(inst);
    expect(recordedInstalledPlanner()).toBe('codex');
  });

  it('lets a planner turn wait for a probe still in flight', async () => {
    let answer!: (value: { usable: boolean }) => void;
    const gate = new Promise<{ usable: boolean }>((resolve) => { answer = resolve; });
    const slow = { plannerUsability: vi.fn(() => gate) };
    void detectInstalledPlanner(slow);

    let settled = false;
    const waiting = installedPlannerDetected().then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(installedPlannerAnswered()).toBe(false);

    answer({ usable: true });
    await waiting;
    expect(installedPlannerAnswered()).toBe(true);
    expect(recordedInstalledPlanner()).toBe('claude-code');
  });

  it('does not hold a turn up when no probe was started', async () => {
    expect(installedPlannerAnswered()).toBe(true);
    await expect(installedPlannerDetected()).resolves.toBeUndefined();
  });

  it('records no agent when the probe itself fails, rather than failing the turn that waits', async () => {
    const broken = { plannerUsability: vi.fn(async () => { throw new Error('boom'); }) };
    await expect(detectInstalledPlanner(broken)).resolves.toBeNull();
    await expect(installedPlannerDetected()).resolves.toBeUndefined();
    expect(recordedInstalledPlanner()).toBeNull();
  });

  /** A probe whose every agent check waits on one gate, usable only for `usableRunner` (none: null). */
  function gatedProbe(usableRunner: string | null) {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    const installation = { plannerUsability: vi.fn(async (runner: string) => { await gate; return { usable: runner === usableRunner }; }) };
    return { installation, open };
  }

  it('keeps a newer probe\'s answer when an older probe finishes after it', async () => {
    const a = gatedProbe('claude-code');
    const b = gatedProbe('codex');
    const probeA = detectInstalledPlanner(a.installation);
    const probeB = detectInstalledPlanner(b.installation);

    b.open();
    await probeB;
    a.open();
    await probeA;

    expect(recordedInstalledPlanner()).toBe('codex');
  });

  it('does not let an older probe that finds nothing wipe a newer probe\'s answer', async () => {
    const a = gatedProbe(null);
    const b = gatedProbe('codex');
    const probeA = detectInstalledPlanner(a.installation);
    const probeB = detectInstalledPlanner(b.installation);

    b.open();
    await probeB;
    a.open();
    await probeA;

    expect(recordedInstalledPlanner()).toBe('codex');
    expect(installedPlannerAnswered()).toBe(true);
  });

  it('keeps a waiter waiting through an older probe until the latest one answers', async () => {
    const a = gatedProbe('claude-code');
    const b = gatedProbe('codex');
    const probeA = detectInstalledPlanner(a.installation);
    let settled = false;
    const waiting = installedPlannerDetected().then(() => { settled = true; });
    const probeB = detectInstalledPlanner(b.installation);

    a.open();
    await probeA;
    await new Promise((resolve) => setImmediate(resolve));
    expect(installedPlannerAnswered()).toBe(false);
    expect(settled).toBe(false);

    b.open();
    await probeB;
    await waiting;
    expect(installedPlannerAnswered()).toBe(true);
    expect(recordedInstalledPlanner()).toBe('codex');
  });

  it('wakes a waiter as soon as a newer probe answers, while the older one is still held', async () => {
    const a = gatedProbe('claude-code');
    const b = gatedProbe('codex');
    const probeA = detectInstalledPlanner(a.installation);
    let settled = false;
    const waiting = installedPlannerDetected().then(() => { settled = true; });
    const probeB = detectInstalledPlanner(b.installation);

    b.open();
    await probeB;
    await waiting;
    expect(settled).toBe(true);
    expect(installedPlannerAnswered()).toBe(true);
    expect(recordedInstalledPlanner()).toBe('codex');

    a.open();
    await probeA;
    expect(recordedInstalledPlanner()).toBe('codex');
  });

  it('keeps a waiter that spans a reset waiting for the probe started after it', async () => {
    const a = gatedProbe('claude-code');
    const c = gatedProbe('opencode');
    void detectInstalledPlanner(a.installation);
    let settled = false;
    const waiting = installedPlannerDetected().then(() => { settled = true; });

    resetInstalledPlanner();
    const probeC = detectInstalledPlanner(c.installation);
    await new Promise((resolve) => setImmediate(resolve));
    expect(installedPlannerAnswered()).toBe(false);
    expect(settled).toBe(false);

    c.open();
    await probeC;
    await waiting;
    expect(settled).toBe(true);
    expect(recordedInstalledPlanner()).toBe('opencode');
  });

  it('resolves every waiter, however many, when the latest probe answers', async () => {
    const a = gatedProbe('claude-code');
    const b = gatedProbe(null);
    void detectInstalledPlanner(a.installation);
    const first = installedPlannerDetected();
    const probeB = detectInstalledPlanner(b.installation);
    const second = installedPlannerDetected();

    b.open();
    await probeB;
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
    expect(recordedInstalledPlanner()).toBeNull();
  });

  it('ignores a probe outstanding across a reset, so a disposed host cannot refill the state', async () => {
    const stale = gatedProbe('claude-code');
    const probe = detectInstalledPlanner(stale.installation);
    let settled = false;
    const waiting = installedPlannerDetected().then(() => { settled = true; });

    resetInstalledPlanner();
    expect(installedPlannerAnswered()).toBe(true);

    stale.open();
    await probe;
    await waiting;
    expect(settled).toBe(true);
    expect(recordedInstalledPlanner()).toBeNull();
    expect(installedPlannerAnswered()).toBe(true);
  });

  it('records an agent that is usable even though another agent\'s check throws', async () => {
    const flaky = { plannerUsability: vi.fn(async (runner: string) => {
      if (runner === 'claude-code') throw new Error('boom');
      return { usable: runner === 'opencode' };
    }) };
    await expect(detectInstalledPlanner(flaky)).resolves.toBe('opencode');
    expect(recordedInstalledPlanner()).toBe('opencode');
  });

  it('a reset removes the prior process answer before another test probes', async () => {
    await detectInstalledPlanner({ plannerUsability: async (runner) => ({ usable: runner === 'claude-code' }) });
    expect(recordedInstalledPlanner()).toBe('claude-code');
    resetInstalledPlanner();
    expect(recordedInstalledPlanner()).toBeNull();
    await detectInstalledPlanner({ plannerUsability: async (runner) => ({ usable: runner === 'opencode' }) });
    expect(recordedInstalledPlanner()).toBe('opencode');
  });
});

describe('defaultEnabledRunners', () => {
  afterEach(() => resetInstalledPlanner());

  it('is claude-code alone before any probe has answered, as it was before detection existed', () => {
    expect(defaultEnabledRunners()).toEqual(['claude-code']);
  });

  it('is every agent the probe found usable, in the order the registry lists them', async () => {
    await detectInstalledPlanner({ plannerUsability: async (runner) => ({ usable: runner !== 'claude-code' }) });
    expect(defaultEnabledRunners()).toEqual(['codex', 'opencode']);
  });

  it('is the only installed agent on a Codex-only or OpenCode-only host', async () => {
    await detectInstalledPlanner({ plannerUsability: async (runner) => ({ usable: runner === 'codex' }) });
    expect(defaultEnabledRunners()).toEqual(['codex']);
    await detectInstalledPlanner({ plannerUsability: async (runner) => ({ usable: runner === 'opencode' }) });
    expect(defaultEnabledRunners()).toEqual(['opencode']);
  });

  it('falls back to claude-code when nothing is installed', async () => {
    await detectInstalledPlanner({ plannerUsability: async () => ({ usable: false }) });
    expect(defaultEnabledRunners()).toEqual(['claude-code']);
  });

  it('follows a reset back to the fallback', async () => {
    await detectInstalledPlanner({ plannerUsability: async (runner) => ({ usable: runner === 'codex' }) });
    resetInstalledPlanner();
    expect(defaultEnabledRunners()).toEqual(['claude-code']);
  });

  it('hands out a copy, so a caller editing its list cannot change the next answer', async () => {
    await detectInstalledPlanner({ plannerUsability: async (runner) => ({ usable: runner === 'codex' }) });
    defaultEnabledRunners().push('opencode');
    expect(defaultEnabledRunners()).toEqual(['codex']);
  });
});
