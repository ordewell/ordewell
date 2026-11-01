import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClaudeCodeAdapter } from '../harness/ClaudeCodeAdapter';
import type { AgentEvent, AgentProcessDeps } from '../harness/AgentAdapter';
import { PlannerShellSandbox, plannerShellProfile, sealedShellProfile, type SealedAvailability } from '../sandbox/plannerSandbox';
import type { SandboxBackend, SandboxProfile } from '../sandbox/SandboxBackend';
import { decidePlannerPermission } from '../harness/plannerPermissions';
import { fakeSpawn, type FakeSpawnResult } from './harnessTestKit';

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ordewell-native-claude-'));
  dirs.push(dir);
  return realpathSync(dir);
}

/** The host's sandbox, with a backend that only records what it was asked to wrap. */
function nativeSandbox(profiles: SandboxProfile[]): () => PlannerShellSandbox {
  const backend: SandboxBackend = {
    name: 'fake',
    probe: async () => ({ ok: true }),
    wrap: (invocation, profile) => {
      profiles.push(profile);
      return {
        file: '/usr/bin/sandbox-exec',
        args: ['-p', 'PROFILE', '-D', 'WORKSPACE=/repo', invocation.shell, ...invocation.shellArgs],
        env: { ...invocation.env, ...profile.env },
      };
    },
  };
  const sealed: SealedAvailability = {
    available: true,
    profile: (opts) => sealedShellProfile({ platform: 'darwin', reads: ['/usr'], masked: [], overlay: false }, opts),
  };
  return () => new PlannerShellSandbox(async () => ({
    available: true,
    backend,
    profile: (opts) => plannerShellProfile({ platform: 'darwin', services: [] }, opts),
    sealed,
  }));
}

function deps(spawned: FakeSpawnResult, sandbox = nativeSandbox([])): AgentProcessDeps {
  return {
    spawn: spawned.spawn,
    fetch: (async () => { throw new Error('no HTTP in this test'); }) as unknown as typeof fetch,
    resolvePath: async () => '/usr/bin',
    platform: 'darwin',
    isDirectory: () => true,
    exists: () => true,
    workspaceEnv: async () => ({}),
    nativeShellSandbox: sandbox,
  };
}

interface ClaudeSettings {
  disableAllHooks?: boolean;
  permissions?: { ask?: string[] };
  sandbox?: { enabled?: boolean };
  env?: Record<string, string>;
}

function settingsOf(spawned: FakeSpawnResult): ClaudeSettings {
  const args = spawned.lastArgs();
  return JSON.parse(args[args.indexOf('--settings') + 1]) as ClaudeSettings;
}

function disallowedOf(spawned: FakeSpawnResult): string[] {
  const args = spawned.lastArgs();
  return args[args.indexOf('--disallowedTools') + 1].split(',');
}

describe('Claude Code with its own shell under Ordewell\'s sandbox (ADR-0036 N2)', () => {
  it('keeps both shell tools on a subplanner\'s narrowed list, with the user\'s opt-in (ADR-0057 R11)', async () => {
    const spawned = fakeSpawn([]);
    const adapter = new ClaudeCodeAdapter(deps(spawned, nativeSandbox([])));
    try {
      await adapter.start({ kind: 'planner', cwd: workspace(), systemPrompt: 'PLAN', nativeShell: true, runnerConfig: 'minimal', noSubagents: true });
      const args = spawned.lastArgs();
      expect(args[args.indexOf('--tools') + 1].split(',')).toEqual(['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'ToolSearch', 'Bash', 'Monitor']);
      expect(spawned.lastEnv().ENABLE_CLAUDEAI_MCP_SERVERS).toBe('false');
      expect(spawned.lastEnv().CLAUDE_CODE_SHELL_PREFIX).toBeDefined();
    } finally {
      adapter.dispose();
    }
  });

  it('names the launcher and its short temp folder in --settings env, with Claude\'s own sandbox off and both shell tools let through', async () => {
    const spawned = fakeSpawn([]);
    const profiles: SandboxProfile[] = [];
    const cwd = workspace();
    const adapter = new ClaudeCodeAdapter(deps(spawned, nativeSandbox(profiles)));
    try {
      await adapter.start({ kind: 'planner', cwd, systemPrompt: 'PLAN', nativeShell: true });

      const settings = settingsOf(spawned);
      expect(settings.disableAllHooks).toBe(true);
      expect(settings.permissions?.ask).toEqual(expect.arrayContaining(['Bash', 'Monitor']));
      // Claude Code's own sandbox takes extra writable paths from user
      // settings that --settings cannot remove, so it is off (N2.1).
      expect(settings.sandbox).toEqual({ enabled: false });
      expect(settings.env?.CLAUDE_CODE_SHELL_PREFIX).toBeDefined();
      expect(settings.env?.CLAUDE_CODE_TMPDIR).toBeDefined();
      expect(settings.env!.CLAUDE_CODE_TMPDIR.length).toBeLessThan(30);
      expect(existsSync(settings.env!.CLAUDE_CODE_SHELL_PREFIX)).toBe(true);
      // The settings block is authoritative; the process carries the same two
      // for whatever reads them before settings are parsed.
      expect(spawned.lastEnv().CLAUDE_CODE_SHELL_PREFIX).toBe(settings.env!.CLAUDE_CODE_SHELL_PREFIX);
      expect(spawned.lastEnv().CLAUDE_CODE_TMPDIR).toBe(settings.env!.CLAUDE_CODE_TMPDIR);

      const disallowed = disallowedOf(spawned);
      expect(disallowed).not.toContain('Bash');
      expect(disallowed).not.toContain('Monitor');
      expect(disallowed).toEqual(expect.arrayContaining(['Edit', 'Write', 'KillShell', 'PowerShell']));

      const script = readFileSync(settings.env!.CLAUDE_CODE_SHELL_PREFIX, 'utf8');
      expect(script).toContain(`'/usr/bin/sandbox-exec' '-p' 'PROFILE'`);
      expect(script).toContain(`'/bin/zsh' '-c' "$command"`);
      // The harness's resolved PATH, not whatever the host process inherited.
      expect(script).toContain(`'PATH=/usr/bin'`);

      const profile = profiles[0];
      expect(profile.network).toBe(true);
      expect(profile.read).toContain(cwd);
      expect(profile.write).toContain(realpathSync(settings.env!.CLAUDE_CODE_TMPDIR));
      expect(profile.write.some((dir) => settings.env!.CLAUDE_CODE_SHELL_PREFIX.startsWith(`${dir}/`))).toBe(false);
    } finally {
      adapter.dispose();
    }
    expect(existsSync(settingsOf(spawned).env!.CLAUDE_CODE_SHELL_PREFIX)).toBe(false);
  });

  it('withholds both shell tools and leaves the settings alone with the flag off', async () => {
    const spawned = fakeSpawn([]);
    const adapter = new ClaudeCodeAdapter(deps(spawned));
    try {
      await adapter.start({ kind: 'planner', cwd: workspace(), systemPrompt: 'PLAN' });

      expect(disallowedOf(spawned)).toEqual(expect.arrayContaining(['Bash', 'Monitor']));
      expect(settingsOf(spawned)).toEqual({
        disableAllHooks: true,
        permissions: { ask: ['WebFetch', 'WebFetch(domain:*)', 'WebSearch', 'mcp__*', 'Read', 'Grep', 'Glob', 'LS'] },
      });
    } finally {
      adapter.dispose();
    }
  });

  it('starts Claude Code without the user\'s credential variables and keeps its own login (N2.2, N3)', async () => {
    vi.stubEnv('GITHUB_TOKEN', 'ghp_secret');
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'aws-secret');
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-login');
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'oauth-login');
    vi.stubEnv('EDITOR', 'vim');
    const spawned = fakeSpawn([]);
    const adapter = new ClaudeCodeAdapter(deps(spawned));
    try {
      await adapter.start({ kind: 'planner', cwd: workspace(), systemPrompt: 'PLAN', nativeShell: true });

      const env = spawned.lastEnv();
      expect(env.GITHUB_TOKEN).toBeUndefined();
      expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
      expect(env.ANTHROPIC_API_KEY).toBe('sk-ant-login');
      expect(env.ANTHROPIC_AUTH_TOKEN).toBe('oauth-login');
      expect(env.EDITOR).toBe('vim');
    } finally {
      adapter.dispose();
    }
  });

  it('routes Bash and Monitor requests to the native-shell kind and allows them', async () => {
    const spawned = fakeSpawn([]);
    const adapter = new ClaudeCodeAdapter(deps(spawned));
    try {
      await adapter.start({ kind: 'planner', cwd: workspace(), systemPrompt: 'PLAN', nativeShell: true });
      const events: AgentEvent[] = [];
      void adapter.send('Look around', (event) => events.push(event));
      const proc = spawned.processes[0];

      for (const [index, tool] of ['Bash', 'Monitor'].entries()) {
        const id = `native-${index}`;
        proc.emitStdout(`${JSON.stringify({
          type: 'control_request',
          request_id: id,
          request: { subtype: 'can_use_tool', tool_name: tool, input: { command: 'for f in *; do echo "$f"; done' } },
        })}\n`);

        const ask = events.find((event) => event.type === 'permission_request' && event.name === tool);
        expect(ask).toMatchObject({ ask: { kind: 'native-shell', tool, command: 'for f in *; do echo "$f"; done' } });
        expect(adapter.answerPermission(id, { decision: 'allow' })).toBe(true);
        await vi.waitFor(() => expect(proc.written.some((line) => line.includes(`"request_id":"${id}"`))).toBe(true));
        const response = proc.written
          .map((line) => JSON.parse(line) as { response?: { request_id: string; response: { behavior: string } } })
          .find((line) => line.response?.request_id === id);
        expect(response?.response?.response?.behavior).toBe('allow');
      }
    } finally {
      adapter.dispose();
    }
  });

  it('fails the start rather than run the shell outside a sandbox', async () => {
    const spawned = fakeSpawn([]);
    const adapter = new ClaudeCodeAdapter(deps(spawned, () => new PlannerShellSandbox(async () => ({ available: false, notice: 'no sandbox' }))));
    await expect(adapter.start({ kind: 'planner', cwd: workspace(), systemPrompt: 'PLAN', nativeShell: true }))
      .rejects.toThrow('could not put this planner\'s shell in its sandbox');
    adapter.dispose();
  });
});

describe('the native-shell permission kind (ADR-0036 N2)', () => {
  it('allows the command the opt-in already consented to, even where nobody can be asked', async () => {
    await expect(decidePlannerPermission(
      { kind: 'native-shell', tool: 'Bash', command: 'ls' },
      {},
      { workspaceRoot: '/repo' },
    )).resolves.toEqual({ decision: 'allow' });
  });

  it('still denies a tool the envelope has no rule for', async () => {
    await expect(decidePlannerPermission({ kind: 'other' }, {}, { workspaceRoot: '/repo' }))
      .resolves.toMatchObject({ decision: 'deny' });
  });
});
