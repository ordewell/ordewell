import { describe, it, expect, afterEach } from 'vitest';
import { recordedInstalledPlanner } from '@ordewell/core';
import { machineA, type MachineAgents } from '../../../../core/src/services/__tests__/firstRunAMachine';
import { firstRunADaemon, type FirstRunADaemon } from '../../tui/__tests__/firstRunADaemon';

/**
 * Machine A's first run (Claude Code installed and signed out, Codex installed
 * and signed in, an old Copilot CLI, no API key): who plans when the user has
 * chosen nobody. The default is the first installed agent, in registry order,
 * that is signed in or whose sign-in cannot be checked; an agent known to be
 * signed out is the default only when every installed agent is.
 */
describe('first run, machine A: the default planner', () => {
  let daemon: FirstRunADaemon | undefined;

  afterEach(async () => {
    await daemon?.close();
    daemon = undefined;
  });

  async function start(agents: MachineAgents, env?: Record<string, string>): Promise<FirstRunADaemon> {
    daemon = await firstRunADaemon(agents, env ? { env } : {});
    return daemon;
  }

  const allSignedOut = (): MachineAgents => ({ ...machineA(), codex: { ...machineA().codex!, signedIn: false } });

  it('records Codex, the first installed agent that is signed in, and plans with it', async () => {
    const { client } = await start(machineA());

    expect(recordedInstalledPlanner()).toBe('codex');
    expect((await client().getSettings()).aiProvider).toBe('codex');
  });

  it('passes over a signed-out agent for one whose sign-in cannot be checked', async () => {
    const { client } = await start({ ...allSignedOut(), opencode: { version: '1.2.0' } });

    expect(recordedInstalledPlanner()).toBe('opencode');
    expect((await client().getSettings()).aiProvider).toBe('opencode');
  });

  it('picks Claude Code only when every installed agent is signed out', async () => {
    const { client } = await start(allSignedOut());

    expect(recordedInstalledPlanner()).toBe('claude-code');
    expect((await client().getSettings()).aiProvider).toBe('claude-code');
  });

  it('with an API key on the machine, a signed-out agent yields to the key', async () => {
    // The sign-in was recorded the way production records it: by the
    // workspace's RunnerInstallation, under that workspace.
    const { client } = await start(allSignedOut(), { OPENROUTER_API_KEY: 'sk-or-first-run' });

    expect(recordedInstalledPlanner()).toBe('claude-code');
    expect((await client().getSettings()).aiProvider).toBe('openrouter');
  });

  // ADR-0052: a new pick of a signed-out agent is refused at the write, with its way in.
  it('refuses picking signed-out Claude Code, and keeps Codex planning', async () => {
    const { client } = await start(machineA());
    // As the TUI's /planner pick writes it.
    const refused = await client().updateSettings({ env: { AI_PROVIDER: 'claude-code', ORCHESTRATOR_MODEL: '', ORDEWELL_PLANNER_EFFORT: '' } }).then(
      () => undefined,
      (err: unknown) => err,
    );

    expect(refused).toMatchObject({ status: 409, code: 'runner_not_ready' });
    expect((refused as Error).message).toMatch(/^Claude Code is not signed in\. Sign in with \/login claude-code.*Then pick it again\.$/);
    expect((await client().getSettings()).aiProvider).toBe('codex');
  });

  it('a goal sent after Claude Code, picked while signed in, signed out is refused with the way on: a signed-in agent and /planner', async () => {
    const { client, pool, workspace, machine } = await start({ ...machineA(), claude: { ...machineA().claude!, signedIn: true } });
    await client().updateSettings({ env: { AI_PROVIDER: 'claude-code', ORCHESTRATOR_MODEL: '', ORDEWELL_PLANNER_EFFORT: '' } });
    machine.set(machineA());
    await client().getRunners(workspace);

    const refused = await client().startConversation('picked-anyway', 'Add a --name flag to hello.py', undefined, workspace).then(
      () => undefined,
      (err: unknown) => err,
    );

    expect(refused).toBeInstanceOf(Error);
    const message = (refused as Error).message;
    expect(message).toContain('is not signed in');
    expect(message).toContain('Codex');
    expect(message).toContain('/planner');
    expect(pool.hasSession('picked-anyway')).toBe(false);
  });
});
