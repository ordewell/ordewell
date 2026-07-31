import { describe, it, expect, vi } from 'vitest';
import { RunnerInstallation } from '../RunnerInstallation';
import type { ExecImpl } from '../ModelDiscovery';
import type { RunnerRegistry } from '../../plugins/RunnerRegistry';
import { CLAUDE_CODE_MANIFEST } from '../../plugins/builtin/claude-code.manifest';
import { OPENCODE_MANIFEST } from '../../plugins/builtin/opencode.manifest';

function registryWith(...manifests: Array<{ name: string; runner: { command: string } }>): RunnerRegistry {
  const byName = new Map(manifests.map((m) => [m.name, m]));
  return { getManifest: (id: string) => byName.get(id) } as unknown as RunnerRegistry;
}

describe('RunnerInstallation', () => {
  it('runs `<command> --version` and treats a clean exit as installed', async () => {
    const exec: ExecImpl = vi.fn(async (command: string) => {
      expect(command).toBe('opencode --version');
      return { stdout: '0.1.0' };
    });
    const inst = new RunnerInstallation(registryWith(OPENCODE_MANIFEST), exec);

    expect(await inst.isInstalled('opencode')).toBe(true);
  });

  it('treats a thrown exec (CLI missing) as not installed', async () => {
    const exec: ExecImpl = vi.fn(async () => {
      throw new Error('command not found');
    });
    const inst = new RunnerInstallation(registryWith(CLAUDE_CODE_MANIFEST), exec);

    expect(await inst.isInstalled('claude-code')).toBe(false);
  });

  it('filterInstalled returns only the installed subset', async () => {
    const exec: ExecImpl = vi.fn(async (command: string) => {
      if (command.startsWith('opencode')) return { stdout: 'ok' };
      throw new Error('not found');
    });
    const inst = new RunnerInstallation(
      registryWith(CLAUDE_CODE_MANIFEST, OPENCODE_MANIFEST),
      exec,
    );

    expect(await inst.filterInstalled(['claude-code', 'opencode'])).toEqual(['opencode']);
  });

  it('unknown runner (no manifest) is not installed', async () => {
    const exec: ExecImpl = vi.fn(async () => ({ stdout: '' }));
    const inst = new RunnerInstallation(registryWith(OPENCODE_MANIFEST), exec);

    expect(await inst.isInstalled('nonexistent')).toBe(false);
    expect(exec).not.toHaveBeenCalled();
  });

  it('caches the result — one probe per runner even across concurrent calls', async () => {
    const exec: ExecImpl = vi.fn(async () => ({ stdout: 'ok' }));
    const inst = new RunnerInstallation(registryWith(OPENCODE_MANIFEST), exec);

    const [a, b] = await Promise.all([
      inst.isInstalled('opencode'),
      inst.isInstalled('opencode'),
    ]);

    expect(a).toBe(true);
    expect(b).toBe(true);
    expect(exec).toHaveBeenCalledTimes(1);
  });
});

describe('RunnerInstallation.plannerUsability (ADR-0009 preflight)', () => {
  it('reports a planner-capable runner whose CLI answers as usable', async () => {
    const exec: ExecImpl = vi.fn(async () => ({ stdout: '2.0.0' }));
    const inst = new RunnerInstallation(registryWith(CLAUDE_CODE_MANIFEST), exec);

    expect(await inst.plannerUsability('claude-code')).toEqual({ usable: true });
  });

  it('names the missing binary so the picker can say why an agent is greyed out', async () => {
    const exec: ExecImpl = vi.fn(async () => { throw new Error('command not found'); });
    const inst = new RunnerInstallation(registryWith(OPENCODE_MANIFEST), exec);

    const result = await inst.plannerUsability('opencode');
    expect(result.usable).toBe(false);
    expect(result.reason).toContain('opencode');
    expect(result.reason).toMatch(/not installed|PATH/);
  });

  it('refuses a runner with no planner transport, even when its CLI is installed', async () => {
    const exec: ExecImpl = vi.fn(async () => ({ stdout: 'ok' }));
    const inst = new RunnerInstallation(
      registryWith({ name: 'aider', displayName: 'Aider', runner: { command: 'aider' } } as never),
      exec,
    );

    const result = await inst.plannerUsability('aider');
    expect(result.usable).toBe(false);
    expect(result.reason).toContain('no planner transport');
  });

  it('refuses an unregistered runner without probing anything', async () => {
    const exec: ExecImpl = vi.fn(async () => ({ stdout: 'ok' }));
    const inst = new RunnerInstallation(registryWith(CLAUDE_CODE_MANIFEST), exec);

    expect((await inst.plannerUsability('nonexistent')).usable).toBe(false);
    expect(exec).not.toHaveBeenCalled();
  });
});
