import { describe, it, expect, afterEach, vi } from 'vitest';
import { CliAgentAiService, type ConversationTurn } from '@ordewell/core';
import { firstRunADaemon, type FirstRunADaemon, type FirstRunTui } from './firstRunADaemon';
import { messagesOf } from './chat';

/**
 * An opening turn the daemon admitted and whose planner then failed reaches
 * the TUI twice: as the error entry the daemon saved in the session it kept
 * (`plan_generated` on the socket) and as the call's own failed answer. The
 * person sees it once, and a later turn that fails the same way is its own
 * failure, shown once more.
 */

// What Cursor's ACP adapter throws when `session/new` answers auth-required, as the user saw it.
const CURSOR_SIGNED_OUT = 'Cursor is not signed in. Sign in with /login cursor-agent, or run cursor-agent login.';
const CODEX_EXITED = 'codex exited with code 1';

describe('first run: an admitted opening whose planner fails', () => {
  let daemon: FirstRunADaemon | undefined;

  afterEach(async () => {
    await daemon?.close();
    daemon = undefined;
  });

  /** The daemon, with each runner's planner turn failing as `failures` says; any other answers. */
  async function opened(failures: Record<string, string>): Promise<{ d: FirstRunADaemon; tui: FirstRunTui }> {
    daemon = await firstRunADaemon({
      codex: { version: 'codex-cli 0.98.0', signedIn: true },
      'cursor-agent': { version: '2025.11.25' },
    });
    const turn = async function (this: CliAgentAiService): Promise<ConversationTurn> {
      const failure = failures[(this as unknown as { runner: string }).runner];
      if (failure) throw new Error(failure);
      return { kind: 'message', text: 'Should the flag default to "world"?', researchLog: [] };
    };
    vi.spyOn(CliAgentAiService.prototype, 'startConversation').mockImplementation(turn);
    vi.spyOn(CliAgentAiService.prototype, 'continueConversation').mockImplementation(turn);
    const tui = daemon.tui();
    await tui.run({ type: 'refresh' });
    return { d: daemon, tui };
  }

  const pick = (tui: FirstRunTui, provider: string) =>
    tui.run({ type: 'setPlannerChoice', provider, modelId: '', effort: '', notice: `Planner: ${provider}` });

  const errors = (tui: FirstRunTui): string[] => messagesOf(tui.state()).filter((m) => m.role === 'error').map((m) => m.text);
  const goal = 'Add a --name flag to hello.py';

  /** Both deliveries are in: the saved session's broadcast and the call's failure. */
  async function bothDelivered(tui: FirstRunTui): Promise<void> {
    await expect.poll(() => tui.actions.some((a) => a.type === 'sessionMessage' && a.message.type === 'plan_generated')).toBe(true);
    expect(tui.actions.filter((a) => a.type === 'failed')).toHaveLength(1);
  }

  async function send(tui: FirstRunTui, text: string): Promise<void> {
    await tui.type(text);
    await tui.press('enter');
  }

  it("draws Cursor's refusal of the opening once, and keeps the session it was saved in", async () => {
    const { d, tui } = await opened({ 'cursor-agent': CURSOR_SIGNED_OUT });
    await pick(tui, 'cursor-agent');

    await send(tui, goal);
    await bothDelivered(tui);

    expect(errors(tui)).toEqual([CURSOR_SIGNED_OUT]);
    const state = tui.state();
    expect(state.editor.text).toBe('');
    expect(messagesOf(state).filter((m) => m.role === 'user').map((m) => m.text)).toEqual([goal]);
    expect(state.planner).toBe('idle');
    // Admitted, so saved: the goal and its failure are the session's to continue.
    expect(state.sessionId).toBe('first-run-1');
    expect(d.pool.hasSession('first-run-1')).toBe(true);
    expect((await d.client().getSessions(d.workspace)).map((s) => s.id)).toEqual(['first-run-1']);

    // Read back from the daemon, by this view and by another opening the saved session.
    await tui.run({ type: 'resyncConversation', sessionId: 'first-run-1' });
    expect(errors(tui)).toEqual([CURSOR_SIGNED_OUT]);
    const another = d.tui();
    await another.run({ type: 'loadSession', sessionId: 'first-run-1' });
    expect(messagesOf(another.state()).map((m) => [m.role, m.text])).toContainEqual(['user', goal]);
    expect(errors(another)).toEqual([CURSOR_SIGNED_OUT]);
  });

  it('draws any other opening failure once', async () => {
    const { tui } = await opened({ codex: CODEX_EXITED });
    await pick(tui, 'codex');

    await send(tui, goal);
    await bothDelivered(tui);

    expect(errors(tui)).toEqual([CODEX_EXITED]);
  });

  it('draws a later refusal worded the same as its own line', async () => {
    const { tui } = await opened({ 'cursor-agent': CURSOR_SIGNED_OUT });
    await pick(tui, 'cursor-agent');
    await send(tui, goal);
    await bothDelivered(tui);

    await send(tui, 'Try again');

    expect(tui.actions.filter((a) => a.type === 'failed')).toHaveLength(2);
    expect(errors(tui)).toEqual([CURSOR_SIGNED_OUT, CURSOR_SIGNED_OUT]);
    const lines = messagesOf(tui.state()).map((m) => [m.role, m.text]);
    expect(lines.slice(-4)).toEqual([
      ['user', goal], ['error', CURSOR_SIGNED_OUT], ['user', 'Try again'], ['error', CURSOR_SIGNED_OUT],
    ]);
  });
});
