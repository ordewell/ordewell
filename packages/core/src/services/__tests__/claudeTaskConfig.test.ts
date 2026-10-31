import { describe, it, expect } from 'vitest';
import { ClaudeCodeAdapter } from '../harness/ClaudeCodeAdapter';
import type { AgentProcessDeps, TaskStartOptions } from '../harness/AgentAdapter';
import { fakeSpawn } from './harnessTestKit';

/**
 * What a Claude task runner carries into its context beyond Ordewell's own
 * prompt: the compaction window every task gets, and the user's ambient setup
 * a `minimal` run leaves behind. Checked against `claude` 2.1.314: under
 * `--setting-sources project,local` with connectors off, the `init` event lists
 * a `.mcp.json` server as connected and the repository's skills and commands,
 * and no server of the user's and no connector.
 */

function deps() {
  const spawned = fakeSpawn([]);
  const processDeps: AgentProcessDeps = {
    spawn: spawned.spawn,
    fetch: (async () => { throw new Error('no HTTP in this test'); }) as unknown as typeof fetch,
    resolvePath: async () => '/usr/bin',
    platform: 'linux',
    isDirectory: () => true,
    exists: () => true,
    workspaceEnv: async () => ({}),
  };
  return { spawned, processDeps };
}

function taskStart(overrides: Partial<TaskStartOptions> = {}): TaskStartOptions {
  return { kind: 'task', cwd: '/repo', mode: 'acceptEdits', flags: { permissionMode: 'acceptEdits', modeSettings: {} }, ...overrides };
}

const readOnlyFlags: TaskStartOptions['flags'] = { readOnly: true, permissionMode: 'plan', modeSettings: {} };

async function started(start: Parameters<ClaudeCodeAdapter['start']>[0]) {
  const { spawned, processDeps } = deps();
  const adapter = new ClaudeCodeAdapter(processDeps);
  await adapter.start(start);
  adapter.dispose();
  return { args: spawned.lastArgs(), env: spawned.lastEnv() };
}

/** Each drops what a repository ships too, so only a task that loads none of it may carry them (ADR-0028). */
const REPOSITORY_TOO = ['--strict-mcp-config', '--disable-slash-commands'];

describe('a Claude task runner\'s compaction window', () => {
  it('is set for a task, so a long attempt compacts instead of growing to the model window', async () => {
    const { env } = await started(taskStart());
    expect(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('150000');
  });

  it('is set for a read-only task too', async () => {
    const { env } = await started(taskStart({ flags: readOnlyFlags }));
    expect(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('150000');
  });

  it('is never set for a planner, whose conversation is the user\'s', async () => {
    const { env } = await started({ kind: 'planner', cwd: '/repo', systemPrompt: 'PLAN' });
    expect(env).not.toHaveProperty('CLAUDE_CODE_AUTO_COMPACT_WINDOW');
  });
});

describe('what a Claude task runner loads of the user\'s setup', () => {
  it.each([
    ['by default', taskStart()],
    ['when asked for the user\'s', taskStart({ runnerConfig: 'user' })],
  ])('is all of it %s', async (_label, start) => {
    const { args, env } = await started(start);
    for (const flag of REPOSITORY_TOO) expect(args).not.toContain(flag);
    expect(args).not.toContain('--setting-sources');
    expect(env).not.toHaveProperty('ENABLE_CLAUDEAI_MCP_SERVERS');
  });

  it('is none of it when minimal, and a task keeps the servers, skills and commands the repository ships', async () => {
    const { args, env } = await started(taskStart({ runnerConfig: 'minimal' }));
    for (const flag of REPOSITORY_TOO) expect(args).not.toContain(flag);
    expect(args[args.indexOf('--setting-sources') + 1]).toBe('project,local');
    expect(env.ENABLE_CLAUDEAI_MCP_SERVERS).toBe('false');
  });

  it('leaves the read-only profile\'s own settings in place when minimal, and drops the user\'s source', async () => {
    const { args } = await started(taskStart({ flags: readOnlyFlags, runnerConfig: 'minimal' }));
    expect(args).toEqual(expect.arrayContaining(REPOSITORY_TOO));
    expect(args).toContain('--setting-sources=');
    expect(args).not.toContain('user');
    expect(JSON.parse(args[args.indexOf('--settings') + 1])).toMatchObject({ disableAllHooks: true });
  });

  it('keeps a read-only task on the user\'s settings, as before, unless minimal', async () => {
    const { args } = await started(taskStart({ flags: readOnlyFlags }));
    expect(args[args.indexOf('--setting-sources') + 1]).toBe('user');
    for (const flag of REPOSITORY_TOO) expect(args).not.toContain(flag);
  });

  it('keeps Ordewell\'s own server on a minimal read-only task: the strict flag admits the --mcp-config it is given', async () => {
    const { args } = await started(taskStart({
      flags: readOnlyFlags,
      runnerConfig: 'minimal',
      mcp: { name: 'ordewell', url: 'http://127.0.0.1:1/mcp', headers: { Authorization: 'Bearer t' }, hidden: [] },
    }));
    expect(args).toContain('--strict-mcp-config');
    expect(args).toContain('--mcp-config');
  });
});
