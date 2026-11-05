import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RunnerInstallation, parseCliVersion } from '../RunnerInstallation';
import type { ExecImpl } from '../ModelDiscovery';
import type { RunnerRegistry } from '../../plugins/RunnerRegistry';
import { CLAUDE_CODE_MANIFEST } from '../../plugins/builtin/claude-code.manifest';
import { OPENCODE_MANIFEST } from '../../plugins/builtin/opencode.manifest';
import { CODEX_MANIFEST } from '../../plugins/builtin/codex.manifest';
import { CONNECTORS } from '../harness/connectors';
import { recordedRunnerAuth, resetRunnerAuth, type RunnerAuthExec } from '../runnerAuth';

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

describe('parseCliVersion', () => {
  it('reads the first dotted number of what a CLI prints', () => {
    expect(parseCliVersion('1.4.2 (Claude Code)\n')).toBe('1.4.2');
    expect(parseCliVersion('codex-cli 0.9.1')).toBe('0.9.1');
    expect(parseCliVersion('opencode v0.15.0-beta.2')).toBe('0.15.0-beta.2');
    expect(parseCliVersion('ok')).toBeUndefined();
  });
});

describe('RunnerInstallation.plannerUsability (ADR-0009 preflight)', () => {
  it('reports a planner-capable runner whose CLI answers as usable', async () => {
    const exec: ExecImpl = vi.fn(async () => ({ stdout: '2.0.0' }));
    const authExec: RunnerAuthExec = vi.fn(async () => ({ code: 0, stdout: '{}', stderr: '' }));
    const inst = new RunnerInstallation(registryWith(CLAUDE_CODE_MANIFEST), exec, Date.now, { authExec });

    expect(await inst.plannerUsability('claude-code')).toEqual({
      usable: true,
      auth: { state: 'signed-in', loginCommand: ['claude', 'auth', 'login'] },
      version: '2.0.0',
    });
  });

  it('leaves the version out when `--version` printed no number', async () => {
    const exec: ExecImpl = vi.fn(async () => ({ stdout: 'ok' }));
    const authExec: RunnerAuthExec = vi.fn(async () => ({ code: 0, stdout: '{}', stderr: '' }));
    const inst = new RunnerInstallation(registryWith(CLAUDE_CODE_MANIFEST), exec, Date.now, { authExec });

    expect(await inst.plannerUsability('claude-code')).not.toHaveProperty('version');
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

  it('plans with exactly the runners the connector registry holds', async () => {
    const exec: ExecImpl = vi.fn(async () => ({ stdout: 'ok' }));
    const authExec: RunnerAuthExec = vi.fn(async () => ({ code: -1, stdout: '', stderr: '' }));
    const manifests = [CLAUDE_CODE_MANIFEST, CODEX_MANIFEST, OPENCODE_MANIFEST, { name: 'aider', runner: { command: 'aider' } }];
    const inst = new RunnerInstallation(registryWith(...manifests), exec, Date.now, { authExec });

    const plannable: string[] = [];
    for (const m of manifests) if ((await inst.plannerUsability(m.name)).usable) plannable.push(m.name);
    expect(plannable.sort()).toEqual(Object.keys(CONNECTORS).sort());
  });

  it('refuses an unregistered runner without probing anything', async () => {
    const exec: ExecImpl = vi.fn(async () => ({ stdout: 'ok' }));
    const inst = new RunnerInstallation(registryWith(CLAUDE_CODE_MANIFEST), exec);

    expect((await inst.plannerUsability('nonexistent')).usable).toBe(false);
    expect(exec).not.toHaveBeenCalled();
  });
});

describe('RunnerInstallation auth (ADR-0009 preflight)', () => {
  beforeEach(() => resetRunnerAuth());

  const signedOutClaude: RunnerAuthExec = vi.fn(async () => ({
    code: 1,
    stdout: '{"loggedIn":false,"authMethod":"none"}',
    stderr: '',
  }));

  it('carries the auth verdict beside usability, and never lets it make the planner unusable', async () => {
    const exec: ExecImpl = vi.fn(async () => ({ stdout: '2.0.0' }));
    const inst = new RunnerInstallation(registryWith(CLAUDE_CODE_MANIFEST), exec, Date.now, { authExec: signedOutClaude });

    const result = await inst.plannerUsability('claude-code');

    expect(result.usable).toBe(true);
    expect(result.auth).toEqual({
      state: 'signed-out',
      loginCommand: ['claude', 'auth', 'login'],
      detail: 'not logged in',
    });
    expect(recordedRunnerAuth('claude-code')).toEqual(result.auth);
  });

  it('asks the status command with the workspace environment the planner will use', async () => {
    const exec: ExecImpl = vi.fn(async () => ({ stdout: '2.0.0' }));
    const authExec: RunnerAuthExec = vi.fn(async () => ({ code: 0, stdout: '{}', stderr: '' }));
    const inst = new RunnerInstallation(registryWith(CLAUDE_CODE_MANIFEST), exec, Date.now, {
      authExec,
      env: async () => ({ CLAUDE_CONFIG_DIR: '/home/me/.claude-b' }),
    });

    await inst.plannerUsability('claude-code');

    expect(vi.mocked(authExec).mock.calls[0][2].env.CLAUDE_CONFIG_DIR).toBe('/home/me/.claude-b');
  });

  it('records an in-flight probe under the workspace it was started for', async () => {
    // The root can move while a status command runs (a folder change). The
    // verdict was produced with A's account, so it belongs to A, not B.
    let workspace = '/a';
    let release!: (answer: { code: number; stdout: string; stderr: string }) => void;
    const authExec: RunnerAuthExec = vi.fn(() => new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => { release = resolve; }));
    const env = vi.fn(async (root?: string) => ({ ACCOUNT: (root ?? workspace) === '/a' ? 'a' : 'b' }));
    const exec: ExecImpl = vi.fn(async () => ({ stdout: '2.0.0' }));
    const inst = new RunnerInstallation(registryWith(CLAUDE_CODE_MANIFEST), exec, Date.now, {
      authExec,
      workspace: () => workspace,
      env,
    });

    const pending = inst.plannerUsability('claude-code');
    await vi.waitFor(() => expect(authExec).toHaveBeenCalled());
    workspace = '/b';
    release({ code: 1, stdout: '{"loggedIn":false,"authMethod":"none"}', stderr: '' });
    await pending;

    expect(env).toHaveBeenCalledWith('/a');
    expect(recordedRunnerAuth('claude-code', '/a')).toMatchObject({ state: 'signed-out' });
    expect(recordedRunnerAuth('claude-code', '/b')).toBeUndefined();
  });

  it('refresh() forgets a signed-out verdict so the next look asks again', async () => {
    let authMethod = 'none';
    const authExec: RunnerAuthExec = vi.fn(async () => ({
      code: authMethod === 'none' ? 1 : 0,
      stdout: `{"authMethod":"${authMethod}"}`,
      stderr: '',
    }));
    const exec: ExecImpl = vi.fn(async () => ({ stdout: '2.0.0' }));
    const inst = new RunnerInstallation(registryWith(CLAUDE_CODE_MANIFEST), exec, Date.now, { authExec });

    expect((await inst.plannerUsability('claude-code')).auth?.state).toBe('signed-out');
    authMethod = 'claude.ai';
    expect((await inst.plannerUsability('claude-code')).auth?.state).toBe('signed-out');

    inst.refresh();
    expect((await inst.plannerUsability('claude-code')).auth?.state).toBe('signed-in');
    expect(authExec).toHaveBeenCalledTimes(2);
  });

  it('re-probes a verdict once its short TTL expires', async () => {
    let clock = 0;
    const exec: ExecImpl = vi.fn(async () => ({ stdout: '2.0.0' }));
    const authExec: RunnerAuthExec = vi.fn(async () => ({ code: 0, stdout: '{}', stderr: '' }));
    const inst = new RunnerInstallation(registryWith(CLAUDE_CODE_MANIFEST), exec, () => clock, { authExec });

    await inst.plannerUsability('claude-code');
    clock += 29_000;
    await inst.plannerUsability('claude-code');
    expect(authExec).toHaveBeenCalledTimes(1);

    clock += 2_000;
    await inst.plannerUsability('claude-code');
    expect(authExec).toHaveBeenCalledTimes(2);
  });

  it('coalesces concurrent auth probes into one status call', async () => {
    const exec: ExecImpl = vi.fn(async () => ({ stdout: '2.0.0' }));
    const authExec: RunnerAuthExec = vi.fn(async () => ({ code: 0, stdout: '{}', stderr: '' }));
    const inst = new RunnerInstallation(registryWith(CLAUDE_CODE_MANIFEST), exec, Date.now, { authExec });

    const [a, b] = await Promise.all([
      inst.plannerUsability('claude-code'),
      inst.plannerUsability('claude-code'),
    ]);

    expect(a.auth?.state).toBe('signed-in');
    expect(b.auth?.state).toBe('signed-in');
    expect(authExec).toHaveBeenCalledTimes(1);
  });
});

describe('RunnerInstallation verdict freshness', () => {
  it('re-probes a missing CLI once its verdict expires', async () => {
    let present = false;
    let clock = 0;
    const exec: ExecImpl = vi.fn(async () => {
      if (!present) throw new Error('command not found');
      return { stdout: '1.0.0' };
    });
    const inst = new RunnerInstallation(registryWith(OPENCODE_MANIFEST), exec, () => clock);

    expect(await inst.isInstalled('opencode')).toBe(false);
    clock += 59_000;
    expect(await inst.isInstalled('opencode')).toBe(false);
    expect(exec).toHaveBeenCalledTimes(1);

    present = true;
    clock += 2_000;
    expect(await inst.isInstalled('opencode')).toBe(true);
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it('keeps an installed verdict past the expiry — only the miss goes stale', async () => {
    let clock = 0;
    const exec: ExecImpl = vi.fn(async () => ({ stdout: '1.0.0' }));
    const inst = new RunnerInstallation(registryWith(OPENCODE_MANIFEST), exec, () => clock);

    expect(await inst.isInstalled('opencode')).toBe(true);
    clock += 10 * 60_000;
    expect(await inst.isInstalled('opencode')).toBe(true);
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('refresh() forgets the misses so the next probe sees a just-installed CLI', async () => {
    let present = false;
    const exec: ExecImpl = vi.fn(async () => {
      if (!present) throw new Error('command not found');
      return { stdout: '1.0.0' };
    });
    const inst = new RunnerInstallation(registryWith(OPENCODE_MANIFEST), exec);

    expect(await inst.filterInstalled(['opencode'])).toEqual([]);
    present = true;
    expect(await inst.filterInstalled(['opencode'])).toEqual([]);
    expect(exec).toHaveBeenCalledTimes(1);

    inst.refresh();
    expect(await inst.filterInstalled(['opencode'])).toEqual(['opencode']);
  });

  it('refresh() keeps an installed verdict', async () => {
    const exec: ExecImpl = vi.fn(async () => ({ stdout: '1.0.0' }));
    const inst = new RunnerInstallation(registryWith(OPENCODE_MANIFEST), exec);

    expect(await inst.isInstalled('opencode')).toBe(true);
    inst.refresh();
    expect(await inst.isInstalled('opencode')).toBe(true);
    expect(exec).toHaveBeenCalledTimes(1);
  });
});
