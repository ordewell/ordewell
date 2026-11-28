import { describe, it, expect, afterEach, vi } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { machineBSignIns, type MachineAgents } from '../../../../core/src/services/__tests__/firstRunAMachine';
import { firstRunADaemon, toolContext, type FirstRunADaemon, type OpenedTurn } from '../../tui/__tests__/firstRunADaemon';

/**
 * What the planner is offered on a first run whose Codex is signed out (and
 * Claude Code signed in, as on machine B): the session catalog behind
 * `list_runners` and `list_models`, and the runners the planner's prompt is
 * built from, leave a signed-out agent out and say why, while the user's
 * settings keep it enabled. An agent whose sign-in cannot be checked is still
 * offered, and a signed-out agent that signs in again is offered again.
 */
describe('first run: a signed-out agent is not offered to the planner', () => {
  let daemon: FirstRunADaemon | undefined;

  afterEach(async () => {
    await daemon?.close();
    daemon = undefined;
  });

  const agents = (): MachineAgents => ({
    ...machineBSignIns(),
    // Neither has a status command: their sign-in cannot be checked.
    opencode: { version: '1.2.0' },
    copilot: { version: 'GitHub Copilot CLI 1.0.120' },
  });

  async function opened(d: FirstRunADaemon, sessionId: string, goal: string): Promise<OpenedTurn> {
    const before = d.turns.length;
    void d.client().startConversation(sessionId, goal, undefined, d.workspace).catch(() => undefined);
    // The turn opens after the agents' real probes, which on Windows each start
    // a supervisor (ADR-0078): vi.waitFor's patient default, not expect.poll's
    // one second, which a loaded machine overruns.
    return vi.waitFor(() => {
      const turn = d.turns[before];
      expect(turn).toBeDefined();
      return turn!;
    });
  }

  async function listRunners(turn: OpenedTurn): Promise<{ text: string; ids: string[] }> {
    const reply = await turn.tools.listRunners!({}, toolContext);
    const parsed = JSON.parse(reply.text) as { runners?: { id: string }[] };
    return { text: reply.text, ids: (parsed.runners ?? []).map((runner) => runner.id) };
  }

  function savedEnabledRunners(): unknown {
    const file = process.env.ORDEWELL_SETTINGS_PATH ?? '';
    return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as { enabledRunners?: unknown }).enabledRunners : undefined;
  }

  it('leaves signed-out Codex out of list_runners, list_models and the prompt\'s runners, and says why', async () => {
    daemon = await firstRunADaemon(agents());
    const turn = await opened(daemon, 'offered', 'Add a --name flag to hello.py');
    expect(turn.transport).toBe('agent');

    const runners = await listRunners(turn);
    expect(runners.ids).toContain('claude-code');
    expect(runners.ids).not.toContain('codex');
    // The planner is told why Codex is missing, so it neither assigns it nor asks the user to enable it.
    expect(runners.text).toMatch(/codex/i);
    expect(runners.text).toContain('signed out');

    const models = await turn.tools.listModels!({ runner: 'codex' }, toolContext);
    expect(models.isError).toBe(true);
    expect(models.text).toContain('signed out');

    // What the runner block of the planner's prompt is written from.
    expect(turn.request.runners).toContain('claude-code');
    expect(turn.request.runners).not.toContain('codex');
    expect(Object.keys(turn.request.modelsByRunner)).not.toContain('codex');
  });

  it('keeps Codex enabled in the user\'s settings', async () => {
    daemon = await firstRunADaemon(agents());
    await opened(daemon, 'settings', 'Add a --name flag to hello.py');

    const listed = (await daemon.client().getRunners()).runners;
    expect(listed.find((runner) => runner.id === 'codex')).toMatchObject({ enabled: true });
    expect(savedEnabledRunners()).toBeUndefined();
  });

  it('still offers an agent whose sign-in cannot be checked', async () => {
    daemon = await firstRunADaemon(agents());
    const turn = await opened(daemon, 'unchecked', 'Add a --name flag to hello.py');

    const runners = await listRunners(turn);
    expect(runners.ids).toEqual(expect.arrayContaining(['claude-code', 'opencode', 'copilot-cli']));
    expect(turn.request.runners).toEqual(expect.arrayContaining(['claude-code', 'opencode', 'copilot-cli']));
  });

  it('offers Codex again once its check reads signed in, with no settings change', async () => {
    daemon = await firstRunADaemon(agents());
    const first = await opened(daemon, 'before-login', 'Add a --name flag to hello.py');
    expect((await listRunners(first)).ids).not.toContain('codex');

    // The user runs `codex login` in another terminal, and the runner list is looked at again.
    daemon.machine.set({ ...agents(), codex: { ...agents().codex!, signedIn: true } });
    await daemon.client().getRunners();

    expect((await listRunners(first)).ids).toContain('codex');
    const next = await opened(daemon, 'after-login', 'Add a README section');
    expect((await listRunners(next)).ids).toContain('codex');
    expect(next.request.runners).toContain('codex');
    expect(savedEnabledRunners()).toBeUndefined();
  });
});
