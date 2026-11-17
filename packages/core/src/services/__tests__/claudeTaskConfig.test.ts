import { afterEach, describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { ClaudeCodeAdapter } from '../harness/ClaudeCodeAdapter';
import { compactionStartOf } from '../taskCompactWindow';
import type { AgentProcessDeps, TaskStartOptions } from '../harness/AgentAdapter';
import { fakeSpawn, flagJson } from './harnessTestKit';

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
  return { args: spawned.lastArgs(), env: spawned.lastEnv(), launch: spawned.lastLaunch() };
}

/** Each drops what a repository ships too, so only a task that loads none of it may carry them (ADR-0028). */
const REPOSITORY_TOO = ['--strict-mcp-config', '--disable-slash-commands'];

describe('a Claude task runner\'s compaction window', () => {
  it.each([
    ['a Haiku', 'claude-haiku-5-5'],
    ['a Haiku alias', 'haiku'],
  ])('is set for %s task by default so that it starts compacting just under its 100000-token price step', async (_label, model) => {
    const { env } = await started(taskStart({ model }));
    const startsAt = compactionStartOf(Number(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW));
    expect(startsAt).toBeGreaterThanOrEqual(90_000);
    expect(startsAt).toBeLessThanOrEqual(95_000);
  });

  it.each([
    ['an Opus', 'opus'],
    ['a Sonnet', 'claude-sonnet-5-5'],
    ['an unnamed', undefined],
  ])('is not set for %s task by default, so it compacts near its model\'s own window', async (_label, model) => {
    // Ordewell sets none here, and passes on what the user's own shell set.
    vi.stubEnv('CLAUDE_CODE_AUTO_COMPACT_WINDOW', undefined);
    const { env } = await started(taskStart(model ? { model } : {}));
    vi.unstubAllEnvs();
    expect(env).not.toHaveProperty('CLAUDE_CODE_AUTO_COMPACT_WINDOW');
  });

  describe('as the user sets it', () => {
    afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

    /** A settings file of its own holding `taskCompactAt: value`. */
    const inFile = (value: unknown): void => {
      const file = path.join(mkdtempSync(path.join(tmpdir(), 'compact-at-')), 'settings.json');
      writeFileSync(file, JSON.stringify({ taskCompactAt: value }));
      vi.stubEnv('ORDEWELL_SETTINGS_PATH', file);
    };

    it('gives a number N in the settings file the window N plus the buffer, whatever the model', async () => {
      inFile(250_000);
      const { env } = await started(taskStart({ model: 'haiku' }));
      expect(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('282000');
    });

    it('starts compacting where the user said, by the CLI\'s own rule', async () => {
      inFile(200_000);
      const { env } = await started(taskStart({ model: 'opus' }));
      expect(compactionStartOf(Number(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW))).toBe(200_000);
    });

    it.each([
      [1, 68_000, 100_000],
      [67_999, 68_000, 100_000],
      [968_001, 968_000, 1_000_000],
      [5_000_000, 968_000, 1_000_000],
    ])('clamps %i to a start of %i, the CLI\'s window %i, saying so once', async (value, start, window) => {
      const log = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      inFile(value);
      const { env } = await started(taskStart({ model: 'opus' }));
      expect(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe(String(window));
      expect(log).toHaveBeenCalledTimes(1);
      expect(String(log.mock.calls[0]?.[0])).toMatch(new RegExp(`Claude Code.*taskCompactAt.*${value}.*${start}`));
    });

    it.each([[68_000, '100000'], [968_000, '1000000']])('takes %i, a bound, without a word', async (value, window) => {
      const log = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      inFile(value);
      const { env } = await started(taskStart({ model: 'opus' }));
      expect(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe(window);
      expect(log).not.toHaveBeenCalled();
    });

    it('says nothing when the number is within the CLI\'s bounds', async () => {
      const log = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      inFile(68_001);
      const { env } = await started(taskStart({ model: 'opus' }));
      expect(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('100001');
      expect(log).not.toHaveBeenCalled();
    });

    it.each([0, -5, 150_000.5, 'big', '12k'])('refuses %s, saying what is accepted', async (value) => {
      inFile(value);
      await expect(started(taskStart({ model: 'opus' }))).rejects.toThrow(/taskCompactAt.*auto, off or a whole number of tokens greater than zero/);
    });

    it('sets nothing when off, not even for Haiku, and passes on what the user\'s own shell set', async () => {
      inFile('off');
      vi.stubEnv('CLAUDE_CODE_AUTO_COMPACT_WINDOW', undefined);
      const { spawned, processDeps } = deps();
      const adapter = new ClaudeCodeAdapter(processDeps);
      await adapter.start(taskStart({ model: 'haiku' }));
      adapter.dispose();
      expect(spawned.lastEnv()).not.toHaveProperty('CLAUDE_CODE_AUTO_COMPACT_WINDOW');
      expect(adapter.compactWindowTokens).toBeUndefined();
    });

    it('chooses per model when auto', async () => {
      inFile('auto');
      const { env } = await started(taskStart({ model: 'haiku' }));
      expect(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('125000');
    });

    it.each([
      ['300000', 'opus', '332000'],
      [' Auto ', 'haiku', '125000'],
    ])('reads ORDEWELL_TASK_COMPACT_AT=%s over the settings file', async (value, model, window) => {
      inFile(250_000);
      vi.stubEnv('ORDEWELL_TASK_COMPACT_AT', value);
      const { env } = await started(taskStart({ model }));
      expect(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe(window);
    });

    it('sets none for an Opus task when ORDEWELL_TASK_COMPACT_AT is auto, over a number in the file', async () => {
      inFile(250_000);
      vi.stubEnv('ORDEWELL_TASK_COMPACT_AT', 'auto');
      vi.stubEnv('CLAUDE_CODE_AUTO_COMPACT_WINDOW', undefined);
      const { env } = await started(taskStart({ model: 'opus' }));
      expect(env).not.toHaveProperty('CLAUDE_CODE_AUTO_COMPACT_WINDOW');
    });

    it('reads off from ORDEWELL_TASK_COMPACT_AT', async () => {
      vi.stubEnv('ORDEWELL_TASK_COMPACT_AT', 'off');
      vi.stubEnv('CLAUDE_CODE_AUTO_COMPACT_WINDOW', undefined);
      const { env } = await started(taskStart({ model: 'opus' }));
      expect(env).not.toHaveProperty('CLAUDE_CODE_AUTO_COMPACT_WINDOW');
    });

    it('refuses a non-numeric ORDEWELL_TASK_COMPACT_AT, naming it', async () => {
      vi.stubEnv('ORDEWELL_TASK_COMPACT_AT', 'soon');
      await expect(started(taskStart({ model: 'opus' }))).rejects.toThrow(/ORDEWELL_TASK_COMPACT_AT.*greater than zero/);
    });

    it('leaves a planner without one, whatever the setting', async () => {
      inFile(300_000);
      vi.stubEnv('CLAUDE_CODE_AUTO_COMPACT_WINDOW', undefined);
      const { env } = await started({ kind: 'planner', cwd: '/repo', systemPrompt: 'PLAN' });
      expect(env).not.toHaveProperty('CLAUDE_CODE_AUTO_COMPACT_WINDOW');
    });
  });

  it('starts compacting a fixed buffer below the window, as the CLI\'s recorded compactions do', () => {
    expect([compactionStartOf(150_000), compactionStartOf(400_000)]).toEqual([118_000, 368_000]);
  });

  it('is set for a read-only task too', async () => {
    const { env } = await started(taskStart({ flags: readOnlyFlags, model: 'haiku' }));
    expect(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('125000');
  });

  it('is the window the adapter states it compacts at, which a planner has none of', async () => {
    const { spawned, processDeps } = deps();
    const task = new ClaudeCodeAdapter(processDeps);
    await task.start(taskStart({ model: 'haiku' }));
    const planner = new ClaudeCodeAdapter(deps().processDeps);
    await planner.start({ kind: 'planner', cwd: '/repo', systemPrompt: 'PLAN' });
    const windows = [task.compactWindowTokens, planner.compactWindowTokens];
    task.dispose();
    planner.dispose();

    expect(windows).toEqual([Number(spawned.lastEnv().CLAUDE_CODE_AUTO_COMPACT_WINDOW), undefined]);
  });

  it('is never set for a planner, whose conversation is the user\'s', async () => {
    // Ordewell sets none here, and passes on what the user's own shell set.
    vi.stubEnv('CLAUDE_CODE_AUTO_COMPACT_WINDOW', undefined);
    const { env } = await started({ kind: 'planner', cwd: '/repo', systemPrompt: 'PLAN' });
    vi.unstubAllEnvs();
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
    const { args, launch } = await started(taskStart({ flags: readOnlyFlags, runnerConfig: 'minimal' }));
    expect(args).toEqual(expect.arrayContaining(REPOSITORY_TOO));
    expect(args).toContain('--setting-sources=');
    expect(args).not.toContain('user');
    expect(flagJson(launch, '--settings')).toMatchObject({ disableAllHooks: true });
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
