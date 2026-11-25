import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  CliAgentAiService, ModelResolver, PlannerNotReadyError, RunnerInstallation, RunnerRegistry, getProviderMeta, PROVIDER_DETECT_PRIORITY,
  recordRunnerAuth, recordedRunnerAuth, resetInstalledPlanner, resetRunnerAuth, signedOutFromFailure, type DiscoveredModel,
} from '@ordewell/core';
import { WebConfig } from '../../adapters/WebConfig';
import { OrchestratorPool } from '../orchestratorPool';

/**
 * #46 F1/F3 at the daemon: Cursor has no status command, so a refusal its
 * turn recorded must survive the runner list every surface loads after the
 * turn, and the send recheck must ask the agent itself rather than erase it.
 * Only the user's explicit recheck returns it to an honest unknown.
 */
describe('OrchestratorPool keeps a status-less agent\'s sign-out (#46, #52)', () => {
  const saved = { ...process.env };
  let dir: string;
  let ws: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ordewell-signed-out-readiness-'));
    ws = join(dir, 'ws');
    mkdirSync(join(ws, '.git'), { recursive: true });
    process.env.ORDEWELL_SETTINGS_PATH = join(dir, 'settings.json');
    for (const provider of PROVIDER_DETECT_PRIORITY) {
      const meta = getProviderMeta(provider);
      for (const key of [...meta.detectEnvVars, meta.baseUrlEnvVar]) if (key) delete process.env[key];
    }
    process.env.AI_PROVIDER = 'cursor-agent';
    resetRunnerAuth();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetInstalledPlanner();
    resetRunnerAuth();
    process.env = { ...saved };
    rmSync(dir, { recursive: true, force: true });
  });

  /** A daemon whose only installed agent is Cursor, asked through `answers` when discovery opens a session. */
  function cursorDaemon(answers: Array<DiscoveredModel[] | 'signed-out' | null>) {
    const registry = new RunnerRegistry();
    vi.spyOn(RunnerInstallation.prototype, 'isInstalled').mockImplementation(async (runner: string) => runner === 'cursor-agent');
    const installation = new RunnerInstallation(registry, async () => ({ stdout: '2026.10.22' }), Date.now, { launch: { platform: 'linux' }, workspace: () => ws, env: async () => ({}) });
    const acpClient = vi.fn(async () => answers.shift() ?? null);
    const modelResolver = new ModelResolver(registry, new WebConfig(), { env: async () => ({}), acpClient, workspace: () => ws, execImpl: async () => ({ stdout: '' }) });
    const pool = new OrchestratorPool({ runnerInstallation: installation, modelResolver, codexSandbox: { ensure: async () => undefined, refresh: async () => undefined } });
    pool.setRunnerEnabled('cursor-agent', true);
    const started = vi.spyOn(CliAgentAiService.prototype, 'startConversation').mockResolvedValue({ kind: 'message', text: 'Which database?', researchLog: [] });
    vi.spyOn(CliAgentAiService.prototype, 'hasActiveConversation').mockReturnValue(true);
    return { pool, acpClient, started };
  }

  const refuse = () => recordRunnerAuth('cursor-agent', signedOutFromFailure(registryManifest(), 'Authentication required')!, ws);
  const registryManifest = () => new RunnerRegistry().getManifest('cursor-agent')!;
  const cursorAuth = async (pool: OrchestratorPool, options?: { recheck?: string[] }) =>
    (await pool.getInstalledRunners(ws, options)).find((r) => r.id === 'cursor-agent')?.auth?.state;

  it('keeps the refusal through the runner list the surfaces load after a turn', async () => {
    const { pool } = cursorDaemon([]);
    try {
      expect(await cursorAuth(pool)).toBe('unknown');
      refuse();
      expect(await cursorAuth(pool)).toBe('signed-out');
      expect(await cursorAuth(pool)).toBe('signed-out');
      expect(recordedRunnerAuth('cursor-agent', ws)?.state).toBe('signed-out');
    } finally {
      pool.destroyAll();
    }
  });

  it('refuses the next goal before the planner is spawned while the agent still refuses its session', async () => {
    const { pool, acpClient, started } = cursorDaemon(['signed-out']);
    try {
      refuse();
      await expect(pool.startPlanning('s1', 'ship it', ['cursor-agent'], ws)).rejects.toBeInstanceOf(PlannerNotReadyError);
      expect(acpClient).toHaveBeenCalledTimes(1);
      expect(started).not.toHaveBeenCalled();
    } finally {
      pool.destroyAll();
    }
  });

  it('sends the goal once the agent opens a session: a sign-in done in another terminal is seen', async () => {
    const { pool, started } = cursorDaemon([[]]);
    try {
      refuse();
      await expect(pool.startPlanning('s1', 'ship it', ['cursor-agent'], ws)).resolves.toBeDefined();
      expect(started).toHaveBeenCalledTimes(1);
    } finally {
      pool.destroyAll();
    }
  });

  it('an explicit recheck the agent cannot answer reads unknown, never signed in, and lets the user send again', async () => {
    const { pool, started } = cursorDaemon([null]);
    try {
      refuse();
      expect(await cursorAuth(pool, { recheck: ['cursor-agent'] })).toBe('unknown');
      await expect(pool.startPlanning('s1', 'ship it', ['cursor-agent'], ws)).resolves.toBeDefined();
      expect(started).toHaveBeenCalledTimes(1);
    } finally {
      pool.destroyAll();
    }
  });
});
