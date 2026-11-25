import { describe, it, expect, afterEach } from 'vitest';
import type { TuiState } from '../state';
import { machineA } from '../../../../core/src/services/__tests__/firstRunAMachine';
import { firstRunADaemon, type FirstRunADaemon, type FirstRunTui } from './firstRunADaemon';
import { messagesOf } from './chat';

/**
 * A goal the daemon refuses because the planner is not ready (409
 * planner_not_ready, before any turn starts) was never sent: on machine A,
 * with Claude Code picked as the planner and signed out since, the text is back in the
 * composer as it was typed, the transcript holds no sent message for it, and
 * no session exists for it. A later message refused the same way in a session
 * that is already open leaves that session, and returns its text.
 */
describe('first run, machine A: a goal refused because the planner is not ready', () => {
  let daemon: FirstRunADaemon | undefined;

  afterEach(async () => {
    await daemon?.close();
    daemon = undefined;
  });

  async function opened(): Promise<{ d: FirstRunADaemon; tui: FirstRunTui }> {
    daemon = await firstRunADaemon(machineA());
    const tui = daemon.tui();
    await tui.run({ type: 'refresh' });
    return { d: daemon, tui };
  }

  /** The planner, picked as `/planner` saves the pick. */
  const pick = (tui: FirstRunTui, provider: string) =>
    tui.run({ type: 'setPlannerChoice', provider, modelId: '', effort: '', notice: `Planner: ${provider}` });

  const sentAsUser = (state: TuiState, text: string): boolean =>
    messagesOf(state).some((message) => message.role === 'user' && message.text.includes(text));

  /** What the daemon answered, as the TUI was told it: a refusal says the planner is not ready. */
  const refusals = (tui: FirstRunTui): string[] =>
    tui.actions.flatMap((action) => (action.type === 'failed' ? [action.message] : []));

  it('refuses picking signed-out Claude Code as the planner, and keeps the planner it had (ADR-0052)', async () => {
    const { tui } = await opened();
    const before = tui.state().plannerProvider;
    await pick(tui, 'claude-code');

    expect(refusals(tui).some((message) => /^Claude Code is not signed in\..*Then pick it again\.$/.test(message))).toBe(true);
    expect(tui.state().plannerProvider).toBe(before);
  });

  it('a first goal goes back into the composer, is not in the transcript, and opens no session', async () => {
    const { d, tui } = await opened();
    // Picked while signed in; a planner chosen before its sign-out is kept (ADR-0052).
    d.machine.set({ ...machineA(), claude: { ...machineA().claude!, signedIn: true } });
    await tui.run({ type: 'refresh' });
    await pick(tui, 'claude-code');
    d.machine.set(machineA());
    await tui.run({ type: 'refresh' });
    const goal = 'Add a --name flag to hello.py';

    await tui.type(goal);
    await tui.press('enter');

    // Refused by the planner gate, before any planner turn.
    expect(refusals(tui).some((message) => message.includes('is not signed in'))).toBe(true);
    expect(d.turns).toHaveLength(0);

    const state = tui.state();
    expect(state.editor.text).toBe(goal);
    expect(sentAsUser(state, goal)).toBe(false);
    expect(state.sessionId ?? null).toBeNull();
    expect(d.pool.hasSession('first-run-1')).toBe(false);
    expect(await d.client().getSessions(d.workspace)).toEqual([]);
  });

  it('a later message in an open session goes back into the composer, and the session stays', async () => {
    const { d, tui } = await opened();
    await pick(tui, 'codex');
    const goal = 'Add a --name flag to hello.py';

    await tui.type(goal);
    const sent = tui.press('enter');
    await expect.poll(() => d.turns.length).toBe(1);
    d.answer('Should the flag default to "world"?');
    await sent;
    const sessionId = tui.state().sessionId;
    expect(sessionId).toBeTruthy();
    expect(d.pool.hasSession(sessionId!)).toBe(true);

    // Codex signs out in another terminal, and the TUI looks at the runners again.
    d.machine.set({ ...machineA(), codex: { ...machineA().codex!, signedIn: false } });
    await tui.run({ type: 'refresh' });
    const message = 'Yes, default to world';
    await tui.type(message);
    await tui.press('enter');

    expect(refusals(tui).some((refusal) => refusal.includes('is not signed in'))).toBe(true);
    expect(d.turns).toHaveLength(1);

    const state = tui.state();
    expect(state.sessionId).toBe(sessionId);
    expect(d.pool.hasSession(sessionId!)).toBe(true);
    expect(state.editor.text).toBe(message);
    expect(sentAsUser(state, message)).toBe(false);
    // The goal that was answered is still the conversation's.
    expect(sentAsUser(state, goal)).toBe(true);
  });
});
