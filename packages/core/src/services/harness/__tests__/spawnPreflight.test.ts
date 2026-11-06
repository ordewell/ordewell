import { describe, it, expect, vi } from 'vitest';
import { ClaudeCodeAdapter } from '../ClaudeCodeAdapter';
import { OpenCodeAdapter } from '../OpenCodeAdapter';
import type { AgentProcessDeps, AgentStartOptions } from '../AgentAdapter';
import { WorkspaceNotFoundError } from '../../../utils/workspace';
import { ExecutableNotFoundError } from '../../../utils/launch';
import { fakeSpawn } from '../../__tests__/harnessTestKit';

/**
 * The `spawn` ENOENT this repo used to blame on a missing agent binary was
 * actually a workspace directory that did not exist — `child_process.spawn`
 * reports the same error for either cause. Every adapter checks both,
 * separately, before it ever calls `spawn`.
 */

const noFetch = (async () => { throw new Error('no HTTP in this test'); }) as unknown as typeof fetch;

function startOptions(cwd: string): AgentStartOptions {
  return { kind: 'planner', cwd, systemPrompt: 'plan read-only' };
}

describe('StdioAgentAdapter (via ClaudeCodeAdapter) — spawn preflight', () => {
  it('rejects with WorkspaceNotFoundError for a workspace that does not exist, without spawning', async () => {
    const spawned = fakeSpawn([]);
    const deps: AgentProcessDeps = {
      spawn: spawned.spawn,
      fetch: noFetch,
      resolvePath: async () => '/usr/bin',
      isDirectory: () => false,
    };
    const adapter = new ClaudeCodeAdapter(deps);

    await expect(adapter.start(startOptions('/nope'))).rejects.toThrow(WorkspaceNotFoundError);
    await expect(adapter.start(startOptions('/nope'))).rejects.toThrow('/nope');
    expect(spawned.processes).toHaveLength(0);
  });

  it('rejects with ExecutableNotFoundError when the workspace exists but "claude" is not on PATH, without spawning', async () => {
    const spawned = fakeSpawn([]);
    const deps: AgentProcessDeps = {
      spawn: spawned.spawn,
      fetch: noFetch,
      resolvePath: async () => '/usr/local/bin:/usr/bin',
      isDirectory: () => true,
      exists: () => false,
    };
    const adapter = new ClaudeCodeAdapter(deps);

    const err = await adapter.start(startOptions('/repo')).catch((e) => e);
    expect(err).toBeInstanceOf(ExecutableNotFoundError);
    expect(err.message).toContain('claude');
    expect(err.message).toContain('/usr/local/bin:/usr/bin');
    expect(spawned.processes).toHaveLength(0);
  });

  it('spawns once the workspace exists and the binary resolves', async () => {
    const spawned = fakeSpawn([]);
    const deps: AgentProcessDeps = {
      spawn: spawned.spawn,
      fetch: noFetch,
      resolvePath: async () => '/usr/bin',
      // Pinned: Windows would spawn the `.exe` it resolved, not the bare name.
      platform: 'linux',
      isDirectory: () => true,
      exists: () => true,
    };
    const adapter = new ClaudeCodeAdapter(deps);

    await adapter.start(startOptions('/repo'));

    expect(spawned.processes).toHaveLength(1);
    expect(spawned.lastCommand()).toBe('claude');
  });
});

describe('OpenCodeAdapter — spawn preflight', () => {
  it('rejects with WorkspaceNotFoundError for a workspace that does not exist, without spawning', async () => {
    const spawned = fakeSpawn([]);
    const deps: AgentProcessDeps = {
      spawn: spawned.spawn,
      fetch: noFetch,
      resolvePath: async () => '/usr/bin',
      isDirectory: () => false,
    };
    const adapter = new OpenCodeAdapter(deps);

    await expect(adapter.start(startOptions('/nope'))).rejects.toThrow(WorkspaceNotFoundError);
    expect(spawned.processes).toHaveLength(0);
  });

  it('rejects with ExecutableNotFoundError when the workspace exists but "opencode" is not on PATH, without spawning', async () => {
    const spawned = fakeSpawn([]);
    const deps: AgentProcessDeps = {
      spawn: spawned.spawn,
      fetch: noFetch,
      resolvePath: async () => '/usr/local/bin:/usr/bin',
      isDirectory: () => true,
      exists: () => false,
    };
    const adapter = new OpenCodeAdapter(deps);

    const err = await adapter.start(startOptions('/repo')).catch((e) => e);
    expect(err).toBeInstanceOf(ExecutableNotFoundError);
    expect(err.message).toContain('opencode');
    expect(err.message).toContain('/usr/local/bin:/usr/bin');
    expect(spawned.processes).toHaveLength(0);
  });
});

describe('planner agents run with the workspace environment (ADR-0016)', () => {
  it.each([
    ['Claude Code', (deps: AgentProcessDeps) => new ClaudeCodeAdapter(deps)],
    ['OpenCode', (deps: AgentProcessDeps) => new OpenCodeAdapter(deps)],
  ])('%s gets the variables its workspace sets', async (_name, make) => {
    const spawned = fakeSpawn([]);
    const envs: NodeJS.ProcessEnv[] = [];
    const deps: AgentProcessDeps = {
      spawn: (cmd, argv, opts) => { envs.push(opts.env ?? {}); return spawned.spawn(cmd, argv, opts); },
      fetch: noFetch,
      resolvePath: async () => '/usr/bin',
      isDirectory: () => true,
      exists: () => true,
      workspaceEnv: async (cwd): Promise<Record<string, string>> => (cwd === '/repo' ? { CLAUDE_CONFIG_DIR: '/home/me/.claude-work' } : {}),
    };

    // OpenCode's start then waits for a server banner this fake never prints.
    void make(deps).start(startOptions('/repo')).catch(() => undefined);

    await vi.waitFor(() => expect(envs[0]?.CLAUDE_CONFIG_DIR).toBe('/home/me/.claude-work'));
  });
});
