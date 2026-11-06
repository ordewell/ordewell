import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import {
  CliAgentAiService, OpenAiService, Session, clearAugmentedPathCache, getProviderMeta, PlannerNotReadyError, PlannerTurnDiscardedError, PlannerTurnStoppedError, PROVIDER_DETECT_PRIORITY,
  RunnerInstallation, createTask, recordedRunnerAuth, recordRunnerAuth, resetInstalledPlanner, resetRunnerAuth, saveSession, type ConversationTurn, type IRunner, type LegacyPlanState,
  type PlannerUsability, type RunnerSpawnOptions,
} from '@ordewell/core';
import { FakeRunnerSession, pathWithFake } from '@ordewell/core/testing';
import { OrchestratorPool } from '../orchestratorPool';

/**
 * A first run with Claude Code installed and no API key (ADR-0009): the daemon
 * finds the agent at startup, and a goal typed before it has answered must
 * wait for it rather than plan with an openrouter key nobody set.
 */
describe('OrchestratorPool default planner', () => {
  const saved = { ...process.env };
  let dir: string;
  let workspace: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ordewell-installed-planner-'));
    workspace = join(dir, 'ws');
    mkdirSync(join(workspace, '.git'), { recursive: true });
    process.env.ORDEWELL_SETTINGS_PATH = join(dir, 'settings.json');
    delete process.env.AI_PROVIDER;
    delete process.env.ORCHESTRATOR_MODEL;
    for (const provider of PROVIDER_DETECT_PRIORITY) {
      const meta = getProviderMeta(provider);
      for (const key of [...meta.detectEnvVars, meta.baseUrlEnvVar]) if (key) delete process.env[key];
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetInstalledPlanner();
    process.env = { ...saved };
    clearAugmentedPathCache();
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * A fake `claude` on PATH whose login state is the presence of
   * `<CLAUDE_CONFIG_DIR>.logged-in`, so an account file can turn from signed-out
   * to signed-in the way a login in another process does.
   */
  function fakeClaudeAgent(): void {
    const bin = join(dir, 'bin');
    mkdirSync(bin, { recursive: true });
    const script = join(bin, 'fake-claude.cjs');
    writeFileSync(script, [
      'const [command] = process.argv.slice(2);',
      "if (command === '--version') { console.log('claude fake'); process.exit(0); }",
      "if (command === 'auth') {",
      "  const signedIn = require('fs').existsSync(`${process.env.CLAUDE_CONFIG_DIR}.logged-in`);",
      "  console.log(JSON.stringify({ authMethod: signedIn ? 'oauth' : 'none' }));",
      '  process.exit(signedIn ? 0 : 1);',
      '}',
      '',
    ].join('\n'));
    // A batch shim on Windows, as npm installs one; `pathWithFake` keeps a real
    // `claude.exe`, which Windows would start ahead of it (ADR-0010), off PATH.
    if (process.platform === 'win32') {
      writeFileSync(join(bin, 'claude.cmd'), `@"${process.execPath}" "${script}" %*\r\n`);
    } else {
      writeFileSync(join(bin, 'claude'), `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
      chmodSync(join(bin, 'claude'), 0o755);
    }
    process.env.PATH = pathWithFake(bin, 'claude');
    clearAugmentedPathCache();
    // The other agents are not what these tests are about; keep detection and
    // the list to the one whose account each workspace chooses.
    vi.spyOn(RunnerInstallation.prototype, 'isInstalled').mockImplementation(async (runner: string) => runner === 'claude-code');
  }

  /** An installation whose agents all answer when the test says so: Claude Code first in order. */
  function gatedInstallation(usable = true) {
    let answer!: (value: PlannerUsability) => void;
    const gate = new Promise<PlannerUsability>((resolve) => { answer = resolve; });
    return {
      installation: { plannerUsability: vi.fn(() => gate), runnerUsability: vi.fn(() => gate), filterInstalled: vi.fn(async () => []) },
      answer: () => answer(usable ? { usable: true } : { usable: false, reason: 'not installed' }),
    };
  }

  const reply: ConversationTurn = { kind: 'message', text: 'Noted.', researchLog: [] };

  /** The detected agent's transport, answering every turn and recording what it was sent. */
  function agentTransport() {
    const asked: string[] = [];
    vi.spyOn(CliAgentAiService.prototype, 'startConversation').mockImplementation(async (req) => {
      asked.push(req.goal);
      return { kind: 'message', text: 'Which database?', researchLog: [] };
    });
    vi.spyOn(CliAgentAiService.prototype, 'continueConversation').mockImplementation(async (message: string) => {
      asked.push(message);
      return { kind: 'message', text: 'Noted.', researchLog: [] };
    });
    vi.spyOn(CliAgentAiService.prototype, 'hasActiveConversation').mockReturnValue(true);
    return asked;
  }

  it('a goal typed before the startup probe answers waits for it, and plans with the agent', async () => {
    const { installation, answer } = gatedInstallation();
    const pool = new OrchestratorPool({ runnerInstallation: installation });
    void pool.detectInstalledPlanner();

    const vendor = vi.spyOn(OpenAiService.prototype, 'startConversation').mockResolvedValue(reply);
    const asked = agentTransport();

    const planning = pool.startPlanning('s1', 'ship it', ['claude-code'], workspace);
    // Registered at once all the same, so a mid-research approval is answerable.
    expect(pool.hasSession('s1')).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(asked).toEqual([]);

    answer();
    await planning;
    expect(asked).toEqual(['ship it']);
    expect(vendor).not.toHaveBeenCalled();
    pool.destroyAll();
  });

  it('judges the planner once the probe answers: with no agent installed, the keyless goal is refused and leaves no session', async () => {
    const { installation, answer } = gatedInstallation(false);
    const pool = new OrchestratorPool({ runnerInstallation: installation });
    void pool.detectInstalledPlanner();
    const vendor = vi.spyOn(OpenAiService.prototype, 'startConversation').mockResolvedValue(reply);
    const asked = agentTransport();

    const planning = pool.startPlanning('s1', 'ship it', ['claude-code'], workspace);
    answer();

    await expect(planning).rejects.toBeInstanceOf(PlannerNotReadyError);
    await expect(planning).rejects.toThrow('No planner is ready. Pick one with /planner');
    expect(asked).toEqual([]);
    expect(vendor).not.toHaveBeenCalled();
    expect(pool.hasSession('s1')).toBe(false);
  });

  it('a session closed while waiting for the probe never starts its planner turn', async () => {
    const { installation, answer } = gatedInstallation();
    const pool = new OrchestratorPool({ runnerInstallation: installation });
    void pool.detectInstalledPlanner();
    const asked = agentTransport();

    const planning = pool.startPlanning('s1', 'ship it', ['claude-code'], workspace);
    pool.destroy('s1');
    answer();

    await expect(planning).rejects.toBeInstanceOf(PlannerTurnDiscardedError);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(asked).toEqual([]);
  });

  /** A saved session holding a message no planner turn answered before the daemon stopped. */
  function savedWithPendingMessage(id: string): void {
    const now = new Date().toISOString();
    const plan: LegacyPlanState = {
      tasks: [],
      generatedAt: now,
      status: 'draft',
      runners: ['claude-code'],
      lastUpdated: now,
      conversationHistory: [
        { role: 'user', content: 'ship it', timestamp: now },
        { role: 'assistant', content: 'Which database?', timestamp: now },
      ],
      pendingTurns: [{ id: 'turn-1', source: 'user', text: 'Postgres', timestamp: now }],
    };
    saveSession(plan, 'ship it', workspace, id);
  }


  it('a restored message stays idle after detection until the user sends a new message', async () => {
    const { installation, answer } = gatedInstallation();
    const pool = new OrchestratorPool({ runnerInstallation: installation });
    void pool.detectInstalledPlanner();
    const vendor = vi.spyOn(OpenAiService.prototype, 'startConversation').mockResolvedValue(reply);
    const agent = vi.spyOn(CliAgentAiService.prototype, 'startConversation').mockResolvedValue(reply);
    savedWithPendingMessage('restored');

    pool.adoptSavedSession('restored', workspace);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(pool.session('restored').planState!.pendingTurns!.map((t) => t.text)).toEqual(['Postgres']);

    answer();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(agent).not.toHaveBeenCalled();
    await pool.continuePlanning('restored', 'go on');
    await vi.waitFor(() => expect(agent).toHaveBeenCalledTimes(1));
    expect(vendor).not.toHaveBeenCalled();
    pool.destroyAll();
  });

  it('a restored message stays queued when no agent is installed and no key is set', async () => {
    const { installation, answer } = gatedInstallation(false);
    const pool = new OrchestratorPool({ runnerInstallation: installation });
    void pool.detectInstalledPlanner();
    const vendor = vi.spyOn(OpenAiService.prototype, 'startConversation').mockResolvedValue(reply);
    savedWithPendingMessage('refused');

    pool.adoptSavedSession('refused', workspace);
    answer();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(vendor).not.toHaveBeenCalled();
    expect(pool.session('refused').planState!.pendingTurns!.map((t) => t.text)).toEqual(['Postgres']);
    pool.destroyAll();
  });

  it('Stop while waiting for the probe cancels the start: it answers true and no turn ever begins', async () => {
    const { installation, answer } = gatedInstallation();
    const pool = new OrchestratorPool({ runnerInstallation: installation });
    void pool.detectInstalledPlanner();
    const asked = agentTransport();

    const planning = pool.startPlanning('s1', 'ship it', ['claude-code'], workspace);
    const settled = expect(planning).rejects.toBeInstanceOf(PlannerTurnDiscardedError);
    expect(pool.cancelPlanning('s1')).toBe(true);
    answer();

    await settled;
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(asked).toEqual([]);
    // Nothing is left to stop, so a second Stop has nothing to report.
    expect(pool.cancelPlanning('s1')).toBe(false);
    pool.destroyAll();
  });

  it('a goal sent after the Stop runs normally once detection resolves', async () => {
    const { installation, answer } = gatedInstallation();
    const pool = new OrchestratorPool({ runnerInstallation: installation });
    void pool.detectInstalledPlanner();
    const asked = agentTransport();

    const first = pool.startPlanning('s1', 'ship it', ['claude-code'], workspace);
    const firstSettled = expect(first).rejects.toBeInstanceOf(PlannerTurnDiscardedError);
    pool.cancelPlanning('s1');
    const second = pool.startPlanning('s1', 'ship it differently', ['claude-code'], workspace);
    answer();

    await firstSettled;
    await second;
    expect(asked).toEqual(['ship it differently']);
    pool.destroyAll();
  });

  it('a loaded message leaves no live turn to Stop, and autorun spawns nothing once the agent is found', async () => {
    const { installation, answer } = gatedInstallation();
    const runner = { spawn: vi.fn(async (opts: RunnerSpawnOptions) => new FakeRunnerSession('s1', opts.taskId)), stop: vi.fn(), stopAll: vi.fn(), activeCount: 0 } satisfies IRunner;
    const pool = new OrchestratorPool({ runnerInstallation: installation, runner });
    pool.updateRunSettings({ autorun: true, supervisorLevel: 'off' });
    void pool.detectInstalledPlanner();
    const submitted: ConversationTurn = { kind: 'plan', tasks: [createTask({ id: 'p1', order: 1, title: 'Use Postgres', prompt: 'use it', assignedRunner: 'claude-code' })], text: '1. Use Postgres', researchLog: [] };
    const agent = vi.spyOn(CliAgentAiService.prototype, 'startConversation').mockResolvedValue(submitted);
    savedWithPendingMessage('stopped');
    pool.adoptSavedSession('stopped', workspace);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(pool.cancelPlanning('stopped')).toBe(false);
    answer();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(agent).not.toHaveBeenCalled();
    expect(runner.spawn).not.toHaveBeenCalled();
    expect(pool.cancelPlanning('stopped')).toBe(false);
    pool.destroyAll();
  });

  it('a reply sent during the first turn\'s wait for the probe is answered after the goal, which it does not replace', async () => {
    const { installation, answer } = gatedInstallation();
    const pool = new OrchestratorPool({ runnerInstallation: installation });
    void pool.detectInstalledPlanner();
    const asked = agentTransport();

    const planning = pool.startPlanning('s1', 'Build an inventory service', ['claude-code'], workspace);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const reply = pool.continuePlanning('s1', 'Use Postgres');
    answer();
    await planning;
    const plan = await reply;

    expect(asked[0]).toBe('Build an inventory service');
    expect(asked).toHaveLength(2);
    expect(asked[1]).toContain('Use Postgres');
    expect((plan.conversationHistory ?? []).filter((m) => m.role === 'user').map((m) => m.content)).toEqual(['Build an inventory service', 'Use Postgres']);
    expect(pool.session('s1').currentGoal).toBe('Build an inventory service');
    pool.destroyAll();
  });

  it('Stop during the first turn\'s wait cancels the goal and the reply sent behind it', async () => {
    const { installation, answer } = gatedInstallation();
    const pool = new OrchestratorPool({ runnerInstallation: installation });
    void pool.detectInstalledPlanner();
    const asked = agentTransport();

    const planning = pool.startPlanning('s1', 'Build an inventory service', ['claude-code'], workspace);
    const planningSettled = expect(planning).rejects.toBeInstanceOf(PlannerTurnDiscardedError);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const reply = pool.continuePlanning('s1', 'Use Postgres');
    const replySettled = expect(reply).rejects.toBeInstanceOf(PlannerTurnStoppedError);
    expect(pool.cancelPlanning('s1')).toBe(true);
    await planningSettled;
    await replySettled;
    answer();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(asked).toEqual([]);
    pool.destroyAll();
  });

  it('reports the detected agent as the planner in effect', async () => {
    const { installation, answer } = gatedInstallation();
    const pool = new OrchestratorPool({ runnerInstallation: installation });
    expect(pool.getSettings().aiProvider).toBe('openrouter');

    answer();
    await pool.detectInstalledPlanner();

    expect(pool.getSettings().aiProvider).toBe('claude-code');
    // Derived on each start, so a key installed later still wins.
    const settingsFile = join(dir, 'settings.json');
    expect(existsSync(settingsFile) ? readFileSync(settingsFile, 'utf8') : '').not.toContain('claude-code');
  });

  it('probes once at startup, not once for each planning turn', async () => {
    const installation = {
      plannerUsability: vi.fn(async (runner: string): Promise<PlannerUsability> => ({ usable: runner === 'codex' })),
      runnerUsability: vi.fn(async (runner: string): Promise<PlannerUsability> => ({ usable: runner === 'codex' })),
      filterInstalled: vi.fn(async () => []),
    };
    const pool = new OrchestratorPool({ runnerInstallation: installation });
    await pool.detectInstalledPlanner();
    expect(pool.getSettings().aiProvider).toBe('codex');
    const callsAfterProbe = installation.plannerUsability.mock.calls.length;
    const startSpy = vi.spyOn(Session.prototype, 'startPlanning').mockResolvedValue({} as LegacyPlanState);

    await pool.startPlanning('s1', 'first', ['codex'], workspace);
    await pool.startPlanning('s2', 'second', ['codex'], workspace);

    expect(startSpy).toHaveBeenCalledTimes(2);
    expect(installation.plannerUsability).toHaveBeenCalledTimes(callsAfterProbe);
    pool.destroyAll();
  });

  it('a /planner pick wins over the detected agent', async () => {
    const { installation, answer } = gatedInstallation();
    const pool = new OrchestratorPool({ runnerInstallation: installation });
    answer();
    await pool.detectInstalledPlanner();

    const result = pool.updateSettings({ env: { AI_PROVIDER: 'codex' } });

    expect(result.aiProvider).toBe('codex');
    delete process.env.AI_PROVIDER;
    expect(pool.getSettings().aiProvider).toBe('claude-code');
  });

  it('a runner installed while the daemon runs becomes the default after a runner-list refresh', async () => {
    let installed: string[] = [];
    const installation = {
      plannerUsability: vi.fn(async (runner: string): Promise<PlannerUsability> => ({ usable: installed.includes(runner) })),
      runnerUsability: vi.fn(async (runner: string): Promise<PlannerUsability> => ({ usable: installed.includes(runner) })),
      filterInstalled: vi.fn(async (runners: string[]) => runners.filter((r) => installed.includes(r))),
      refresh: vi.fn(),
    };
    const pool = new OrchestratorPool({
      runnerInstallation: installation,
      codexSandbox: { ensure: async () => undefined, refresh: async () => undefined },
    });
    // Nothing installed at startup and no key: the openrouter fallback.
    await pool.detectInstalledPlanner();
    expect(pool.getSettings().aiProvider).toBe('openrouter');
    expect(await pool.getInstalledRunners()).toEqual([]);

    installed = ['opencode'];
    const runners = await pool.getInstalledRunners();

    expect(runners.map((r) => r.id)).toEqual(['opencode']);
    expect(pool.getSettings().aiProvider).toBe('opencode');
    pool.destroyAll();
  });

  it('judges a named workspace\'s login with that workspace\'s env, not the daemon cwd', async () => {
    // `ordewell web` may be serving a workspace other than the directory it was
    // started from. The probe must read that workspace's `.ordewell/env`, or
    // `/login` signs in one account while the list keeps reporting another.
    const ws = join(dir, 'workspace-a');
    mkdirSync(join(ws, '.ordewell'), { recursive: true });
    writeFileSync(join(ws, '.ordewell', 'env'), 'CLAUDE_CONFIG_DIR=/accounts/a\n');
    vi.spyOn(RunnerInstallation.prototype, 'filterInstalled').mockResolvedValue([]);
    vi.spyOn(RunnerInstallation.prototype, 'plannerUsability').mockResolvedValue({ usable: true });
    vi.spyOn(RunnerInstallation.prototype, 'runnerUsability').mockResolvedValue({ usable: true });
    const pool = new OrchestratorPool({
      codexSandbox: { ensure: async () => undefined, refresh: async () => undefined },
    });

    await pool.getInstalledRunners(ws);

    const installations = (pool as unknown as {
      workspaceInstallations: Map<string, { env: () => Promise<Record<string, string>> }>;
    }).workspaceInstallations;
    const probe = installations.get(resolve(ws));
    expect(probe).toBeDefined();
    expect(await probe!.env()).toEqual({ CLAUDE_CONFIG_DIR: '/accounts/a' });
    pool.destroyAll();
  });

  it('keeps an installed runner its own usability refuses, with the reason it cannot start', async () => {
    // An installed CLI can still be unspawnable (a Windows `.cmd` shim) or too
    // old for its ACP profile. Dropping it would leave every surface calling a
    // present binary "not installed"; the row says why instead (ADR-0009).
    const usability = async (runner: string): Promise<PlannerUsability> => ({
      usable: runner === 'claude-code',
      ...(runner === 'codex' ? { reason: 'codex: found 0.9.0, needs 1.0.0 or later.' } : {}),
    });
    const installation = {
      plannerUsability: vi.fn(usability),
      runnerUsability: vi.fn(usability),
      filterInstalled: vi.fn(async (runners: string[]) => runners.filter((r) => r === 'claude-code' || r === 'codex')),
      refresh: vi.fn(),
    };
    const pool = new OrchestratorPool({
      runnerInstallation: installation,
      codexSandbox: { ensure: async () => undefined, refresh: async () => undefined },
    });

    const runners = await pool.getInstalledRunners();

    expect(runners).toEqual([
      expect.objectContaining({ id: 'claude-code' }),
      expect.objectContaining({ id: 'codex', usable: false, reason: 'codex: found 0.9.0, needs 1.0.0 or later.' }),
    ]);
    expect(runners.find((r) => r.id === 'claude-code')).not.toHaveProperty('usable');
    pool.destroyAll();
  });

  it('carries each installed runner\'s auth verdict without dropping a signed-out one from the list', async () => {    const auth = { state: 'signed-out' as const, loginCommand: ['claude', 'auth', 'login'], detail: 'not logged in' };
    const usability = async (runner: string): Promise<PlannerUsability> => ({
      usable: runner === 'claude-code',
      ...(runner === 'claude-code' ? { auth } : { auth: { state: 'unknown' as const } }),
    });
    const installation = {
      plannerUsability: vi.fn(usability),
      runnerUsability: vi.fn(usability),
      filterInstalled: vi.fn(async (runners: string[]) => runners.filter((r) => r === 'claude-code')),
      refresh: vi.fn(),
    };
    const pool = new OrchestratorPool({
      runnerInstallation: installation,
      codexSandbox: { ensure: async () => undefined, refresh: async () => undefined },
    });

    const runners = await pool.getInstalledRunners();

    expect(runners).toEqual([expect.objectContaining({ id: 'claude-code', auth })]);
    pool.destroyAll();
  });

  it('lists an installed task-only runner with its login, though it cannot plan', async () => {
    // Copilot runs tasks over ACP and cannot plan yet; it is still an installed
    // agent a user signs in to, from `/login` or the runner row.
    const auth = { state: 'unknown' as const, loginCommand: ['copilot', 'login'] };
    const installation = {
      plannerUsability: vi.fn(async (): Promise<PlannerUsability> => ({ usable: false, reason: 'cannot plan in Ordewell yet' })),
      runnerUsability: vi.fn(async (): Promise<PlannerUsability> => ({ usable: true, auth })),
      filterInstalled: vi.fn(async (runners: string[]) => runners.filter((r) => r === 'copilot-cli')),
      refresh: vi.fn(),
    };
    const pool = new OrchestratorPool({
      runnerInstallation: installation,
      codexSandbox: { ensure: async () => undefined, refresh: async () => undefined },
    });

    expect(await pool.getInstalledRunners()).toEqual([expect.objectContaining({ id: 'copilot-cli', name: 'GitHub Copilot CLI', auth })]);
    pool.destroyAll();
  });

  /** A workspace whose `.ordewell/env` selects `accountDir` as its Claude account. */
  function workspaceWithAccount(name: string, accountDir: string): string {
    const ws = join(dir, name);
    mkdirSync(join(ws, '.ordewell'), { recursive: true });
    mkdirSync(join(ws, '.git'), { recursive: true });
    writeFileSync(join(ws, '.ordewell', 'env'), `CLAUDE_CONFIG_DIR=${accountDir}\n`);
    return ws;
  }

  /** An account directory, signed in when its `.logged-in` marker is present. */
  function accountDir(name: string, signedIn: boolean): string {
    const account = join(dir, 'accounts', name);
    mkdirSync(account, { recursive: true });
    const marker = `${account}.logged-in`;
    if (signedIn) writeFileSync(marker, '');
    else rmSync(marker, { force: true });
    return account;
  }

  // The auth gate is synchronous, while a daemon can serve several workspaces:
  // a runner list for another workspace must not decide whether this one's
  // planner is signed in.
  it('judges a turn by the workspace that will plan, not by the last runner list request', async () => {
    fakeClaudeAgent();
    const wsA = workspaceWithAccount('workspace-a', accountDir('a', true));
    const wsB = workspaceWithAccount('workspace-b', accountDir('b', false));
    const pool = new OrchestratorPool({
      codexSandbox: { ensure: async () => undefined, refresh: async () => undefined },
    });
    try {
      resetRunnerAuth();
      await pool.detectInstalledPlanner();
      expect(await pool.getInstalledRunners(wsA)).toEqual([
        expect.objectContaining({ id: 'claude-code', auth: expect.objectContaining({ state: 'signed-in' }) }),
      ]);
      // Account B is signed out; asking for its list must not un-sign-in A.
      expect(await pool.getInstalledRunners(wsB)).toEqual([
        expect.objectContaining({ id: 'claude-code', auth: expect.objectContaining({ state: 'signed-out' }) }),
      ]);
      agentTransport();

      await expect(pool.startPlanning('sA', 'ship it', ['claude-code'], wsA)).resolves.toBeDefined();
      // The reverse too: the signed-in verdict A just recorded must not open
      // B, whose own account the list found signed out.
      await expect(pool.startPlanning('sB', 'ship it', ['claude-code'], wsB)).rejects.toBeInstanceOf(PlannerNotReadyError);
    } finally {
      pool.destroyAll();
    }
  });

  // The refusal itself offers the runner's own command as a way back in. A
  // login done that way happens in another process; the gate must ask again
  // rather than keep the verdict it recorded before.
  it('sees a login completed outside Ordewell before it refuses the next turn', async () => {
    fakeClaudeAgent();
    const account = accountDir('a', false);
    const ws = workspaceWithAccount('workspace', account);
    const pool = new OrchestratorPool({
      codexSandbox: { ensure: async () => undefined, refresh: async () => undefined },
    });
    try {
      resetRunnerAuth();
      await pool.detectInstalledPlanner();
      expect(await pool.getInstalledRunners(ws)).toEqual([
        expect.objectContaining({ id: 'claude-code', auth: expect.objectContaining({ state: 'signed-out' }) }),
      ]);

      // What `claude auth login` in the user's own terminal leaves behind.
      writeFileSync(`${account}.logged-in`, '');
      agentTransport();

      await expect(pool.startPlanning('s1', 'ship it', ['claude-code'], ws)).resolves.toBeDefined();
    } finally {
      pool.destroyAll();
    }
  });

  /**
   * A reply, a force send and a compaction are planner turns too. After a
   * mid-conversation signed-out failure the refusal offers the runner's own
   * login, which runs outside this process: every one of these paths must ask
   * the account again instead of keeping the stale verdict until a runner-list
   * refresh.
   */
  it('sees a login completed outside Ordewell before a reply, a force send and a compaction', async () => {
    fakeClaudeAgent();
    const account = accountDir('reply', true);
    const ws = workspaceWithAccount('workspace-reply', account);
    const pool = new OrchestratorPool({
      codexSandbox: { ensure: async () => undefined, refresh: async () => undefined },
    });
    try {
      resetRunnerAuth();
      await pool.detectInstalledPlanner();
      await pool.getInstalledRunners(ws);
      agentTransport();
      // The summary turn needs the tagged reply a harness planner answers with.
      vi.spyOn(CliAgentAiService.prototype, 'continueConversation').mockImplementation(async (message: string) => ({
        kind: 'message',
        text: message.includes('<conversation_summary>')
          ? '<conversation_summary>The database and its CSV export were decided.</conversation_summary>'
          : 'Noted.',
        researchLog: [],
      }));
      await pool.startPlanning('s1', 'ship it', ['claude-code'], ws);

      const signedOut = { state: 'signed-out' as const, loginCommand: ['claude', 'auth', 'login'], detail: 'not logged in' };
      // The failed turn recorded signed out; the runner's own login rewrites
      // the account file, and no runner list has been read since.
      const signInAgain = (): void => {
        recordRunnerAuth('claude-code', signedOut, ws);
        writeFileSync(`${account}.logged-in`, '');
      };
      signInAgain();
      await expect(pool.continuePlanning('s1', 'Use Postgres')).resolves.toBeDefined();

      signInAgain();
      await expect(pool.forceSendPrompt('s1', 'Use SQLite instead')).resolves.toBeDefined();

      await pool.continuePlanning('s1', 'And stream the export');
      signInAgain();
      await expect(pool.compactConversation('s1')).resolves.toMatchObject({
        summary: 'The database and its CSV export were decided.',
      });

      // A paused compaction's retry is a planner turn too, and reads the same
      // recorded verdict: it must see the login before the session gates it.
      const session = pool.session('s1');
      const retry = vi.spyOn(session, 'retryPlannerCompaction').mockImplementation(async () => {
        expect(recordedRunnerAuth('claude-code', ws)?.state).toBe('signed-in');
        return session.planState!;
      });
      signInAgain();
      await pool.retryPlannerCompaction('s1');
      expect(retry).toHaveBeenCalledTimes(1);
    } finally {
      pool.destroyAll();
    }
  });

  it('still refuses those turns when the account is genuinely signed out', async () => {
    fakeClaudeAgent();
    const account = accountDir('reply-out', false);
    const ws = workspaceWithAccount('workspace-reply-out', account);
    const pool = new OrchestratorPool({
      codexSandbox: { ensure: async () => undefined, refresh: async () => undefined },
    });
    try {
      resetRunnerAuth();
      await pool.detectInstalledPlanner();
      await pool.getInstalledRunners(ws);
      agentTransport();
      // Start while signed in, so a live conversation exists to reply in.
      writeFileSync(`${account}.logged-in`, '');
      await pool.startPlanning('s1', 'ship it', ['claude-code'], ws);
      // Logged out in another terminal: the next reads find that out.
      rmSync(`${account}.logged-in`, { force: true });
      recordRunnerAuth('claude-code', { state: 'signed-out', loginCommand: ['claude', 'auth', 'login'] }, ws);

      await expect(pool.continuePlanning('s1', 'Use Postgres')).rejects.toBeInstanceOf(PlannerNotReadyError);
      await expect(pool.forceSendPrompt('s1', 'Use SQLite instead')).rejects.toBeInstanceOf(PlannerNotReadyError);
      await expect(pool.compactConversation('s1')).rejects.toBeInstanceOf(PlannerNotReadyError);
    } finally {
      pool.destroyAll();
    }
  });

  // What the user did: Qwen Code picked as planner with no sign-in of its own,
  // a turn refused as signed out, then a key saved with `/key`. The key is
  // enough to sign Qwen in (ADR-0060 R9), so the refusal is no longer evidence.
  it('forgets a signed-out verdict once a provider key is saved, which can sign an agent in', () => {
    const pool = new OrchestratorPool({
      codexSandbox: { ensure: async () => undefined, refresh: async () => undefined },
    });
    try {
      resetRunnerAuth();
      pool.updateSettings({ env: { AI_PROVIDER: 'qwen-code' } });
      recordRunnerAuth('qwen-code', { state: 'signed-out', loginCommand: ['qwen'], detail: 'not logged in' }, workspace);
      pool.updateSettings({ env: { ORDEWELL_MAX_PARALLEL: '2' } });
      expect(recordedRunnerAuth('qwen-code', workspace)?.state).toBe('signed-out');

      pool.updateSettings({ env: { OPENROUTER_API_KEY: 'sk-or-v1-saved-by-key-command' } });

      expect(recordedRunnerAuth('qwen-code', workspace)?.state).not.toBe('signed-out');
    } finally {
      pool.destroyAll();
    }
  });
});
