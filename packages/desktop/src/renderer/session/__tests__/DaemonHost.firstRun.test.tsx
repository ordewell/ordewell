import { act } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HostToWebview } from '@ordewell/ui/protocol';
import { DaemonHost } from '../DaemonHost';
import { fakeDaemon, ok, surfacePlan } from './fakeDaemon';

const WORKSPACE = '/work/acme';

let hosts: DaemonHost[] = [];
afterEach(() => {
  for (const host of hosts) host.dispose();
  hosts = [];
});

function started(): { host: DaemonHost; seen: HostToWebview[] } {
  const host = new DaemonHost(WORKSPACE, async () => null, {});
  hosts.push(host);
  const seen: HostToWebview[] = [];
  host.port('conversation').subscribe((msg) => seen.push(msg));
  return { host, seen };
}

/** First-run audit F2: the desktop's part in the chat's way out of "nothing can plan". */
describe('DaemonHost on a first run with nothing that can plan', () => {
  it('marks a goal refused for want of a planner, so the error\'s Try Again detects again', async () => {
    fakeDaemon({
      'plans.converseStart': { ok: false, status: 409, error: 'refused', data: { error: 'No planner is ready.', code: 'planner_not_ready' } },
    });
    const { host, seen } = started();

    await act(() => host.handle({ type: 'sendMessage', text: 'Add a login page', typed: true }));

    expect(seen.filter((m) => m.type === 'showError')).toEqual([{ type: 'showError', error: 'No planner is ready.', code: 'planner_not_ready' }]);
  });

  it('leaves any other refusal unmarked, naming the goal its Try Again sends again', async () => {
    fakeDaemon({
      'plans.converseStart': { ok: false, status: 500, error: 'failed', data: { error: 'The planner failed.' } },
    });
    const { host, seen } = started();

    await act(() => host.handle({ type: 'sendMessage', text: 'Add a login page', typed: true }));

    expect(seen.filter((m) => m.type === 'showError')).toEqual([{ type: 'showError', error: 'The planner failed.', resend: 'Add a login page' }]);
  });

  // First-run review round 2, F3: the failed turn's message is drawn already.
  it('sends the failed first message again on Try Again without drawing it a second time', async () => {
    const daemon = fakeDaemon({
      'plans.converseStart': { ok: false, status: 500, error: 'failed', data: { error: 'The planner failed.' } },
      'sessions.get': ok({ id: 'kept' }),
      'plans.converseMessage': ok({ plan: surfacePlan([], 'draft') }),
    });
    const { host, seen } = started();
    const chat = host.port('conversation');
    chat.subscribe((msg) => seen.push(msg));
    chat.post({ type: 'ready' });
    const drawn = () => {
      const blocks = new Map<string, { role?: string; text?: string }>();
      for (const msg of seen) if (msg.type === 'conversationPatch') for (const block of msg.changed) blocks.set(block.id, block as { role?: string; text?: string });
      return [...blocks.values()].filter((b) => b.role === 'user').map((b) => b.text);
    };
    await act(() => host.handle({ type: 'sendMessage', text: 'Add a login page', typed: true }));
    await vi.waitFor(() => expect(drawn()).toEqual(['Add a login page']));

    await act(() => host.handle({ type: 'sendMessage', text: 'Add a login page', typed: true, again: true }));
    // The chat's patches go out on a short timer: let any that is due go.
    await act(() => new Promise((resolve) => setTimeout(resolve, 150)));

    expect(daemon.call).toHaveBeenCalledWith('plans.converseMessage', expect.anything(), expect.objectContaining({ message: 'Add a login page' }));
    expect(drawn()).toEqual(['Add a login page']);
  });

  /**
   * Try Again as the daemon answers it: each turn opens with its message as
   * its prompt, and a session read while the retried turn runs holds that
   * message as a pending input as well as in the transcript.
   */
  describe('Try Again draws the failed message once', () => {
    const GOAL = 'Add a login page';
    const LATER = 'Keep the form small';
    const at = (offset: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, offset)).toISOString();

    /** The chat's copy of the conversation, built from the patches as the webview builds it. */
    function mirror(seen: HostToWebview[]): () => string[] {
      return () => {
        let order: readonly string[] = [];
        const byId = new Map<string, { type?: string; role?: string; text?: string }>();
        for (const msg of seen) {
          if (msg.type !== 'conversationPatch') continue;
          for (const block of msg.changed) byId.set(block.id, block as { role?: string; text?: string });
          order = msg.order;
        }
        return order.map((id) => byId.get(id)).filter((b) => b?.type === 'message' && b.role === 'user').map((b) => b!.text!);
      };
    }

    const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 150)));

    /** A daemon whose turns open with their prompt; `fail` names the turns (by number) the planner fails. */
    function turningDaemon(fail: readonly number[], extra: Parameters<typeof fakeDaemon>[0] = {}) {
      let seq = 0;
      let turns = 0;
      let release: (() => void) | undefined;
      const turn = (params: unknown, body: unknown) => new Promise<ReturnType<typeof ok>>((resolve) => {
        const sessionId = (params as { sessionId: string }).sessionId;
        const { goal, message } = body as { goal?: string; message?: string };
        const n = ++turns;
        const turnId = `turn-${n}`;
        daemon.push(sessionId, { type: 'planner_turn_started', turnId, prompt: goal ?? message, startedAt: at(n), sessionId, stream: 'd1', seq: ++seq });
        release = () => {
          if (fail.includes(n)) {
            daemon.push(sessionId, { type: 'planner_turn_ended', turnId, outcome: 'error', sessionId, stream: 'd1', seq: ++seq });
            resolve({ ok: false, status: 500, error: 'failed', data: { error: 'The planner failed.' } });
            return;
          }
          daemon.push(sessionId, { type: 'planner_turn_ended', turnId, outcome: 'message', sessionId, stream: 'd1', seq: ++seq });
          resolve(ok({ plan: surfacePlan([], 'draft') }));
        };
      });
      const daemon = fakeDaemon({ 'plans.converseStart': turn, 'plans.converseMessage': turn, 'sessions.get': ok({ id: 'kept' }), ...extra });
      return { daemon, turns: () => turns, release: () => release?.() };
    }

    it('on a first message, while the retried turn runs and after it lands', async () => {
      const { release, turns } = turningDaemon([1]);
      const { host, seen } = started();
      const drawn = mirror(seen);

      const first = host.handle({ type: 'sendMessage', text: GOAL, typed: true });
      await vi.waitFor(() => expect(turns()).toBe(1));
      await act(async () => { release(); await first; });
      await settle();
      expect(drawn()).toEqual([GOAL]);

      const again = host.handle({ type: 'sendMessage', text: GOAL, typed: true, again: true });
      await vi.waitFor(() => expect(turns()).toBe(2));
      await settle();
      expect(drawn()).toEqual([GOAL]);

      await act(async () => { release(); await again; });
      await settle();
      expect(drawn()).toEqual([GOAL]);
    });

    it('on a later message, while the retried turn runs and after it lands', async () => {
      const { release, turns } = turningDaemon([2]);
      const { host, seen } = started();
      const drawn = mirror(seen);

      const first = host.handle({ type: 'sendMessage', text: GOAL, typed: true });
      await vi.waitFor(() => expect(turns()).toBe(1));
      await act(async () => { release(); await first; });
      const later = host.handle({ type: 'sendMessage', text: LATER, typed: true });
      await vi.waitFor(() => expect(turns()).toBe(2));
      await act(async () => { release(); await later; });
      await settle();
      expect(drawn()).toEqual([GOAL, LATER]);

      const again = host.handle({ type: 'sendMessage', text: LATER, typed: true, again: true });
      await vi.waitFor(() => expect(turns()).toBe(3));
      await settle();
      expect(drawn()).toEqual([GOAL, LATER]);

      await act(async () => { release(); await again; });
      await settle();
      expect(drawn()).toEqual([GOAL, LATER]);
    });

    it('on a session opened while its retried first message is a pending input', async () => {
      // The daemon kept the unanswered goal and its failure; the turn answering it again holds it pending.
      const plan = {
        ...surfacePlan([], 'draft'),
        conversationHistory: [
          { role: 'user', content: GOAL, timestamp: at(1) },
          { role: 'assistant', content: 'The planner failed.', kind: 'error', timestamp: at(2) },
        ],
        pendingTurns: [{ id: 'p1', source: 'user', text: GOAL, timestamp: at(3) }],
      };
      const daemon = fakeDaemon({ 'sessions.load': ok({ ok: true, plan, goal: GOAL, plannerTurnId: 'turn-2' }) });
      const { host, seen } = started();
      const drawn = mirror(seen);

      await act(() => host.open('s1'));
      await act(async () => {
        daemon.push('s1', { type: 'connected', sessionId: 's1' }, { type: 'planner_text_delta', turnId: 'turn-2', segmentId: 'g1', text: 'Planning', sessionId: 's1', stream: 'd1', seq: 1 });
      });
      await settle();

      expect(drawn()).toEqual([GOAL]);
    });
  });

  it('opens an install guide in the browser through main', async () => {
    const daemon = fakeDaemon();
    const { host } = started();

    await act(() => host.handle({ type: 'openLink', url: 'https://code.claude.com/docs/en/setup' }));

    expect(daemon.openExternal).toHaveBeenCalledWith('https://code.claude.com/docs/en/setup');
  });

  describe('the key route ends ready to plan', () => {
    const MODELS = ok({ models: [], modelsByRunner: {}, modesByRunner: {}, orchestratorModel: '', providers: [], orchestratorModels: [], providerErrors: {} });
    const saving = (answer: { aiProvider: string; orchestratorModel: string }) => {
      fakeDaemon({
        'runners.list': ok({ runners: [], orchestratorModel: '' }),
        'models.list': MODELS,
        'settings.get': ok({ plannerThinkingEffort: '', ...answer }),
        'settings.update': ok({ plannerThinkingEffort: '', ...answer }),
      });
      const host = new DaemonHost(WORKSPACE, async () => null, { askForKey: async () => ({ provider: 'openai', key: 'sk-1' }) });
      hosts.push(host);
      const seen: HostToWebview[] = [];
      host.port('conversation').subscribe((msg) => seen.push(msg));
      const navigator = { openTask: vi.fn(), openFile: vi.fn(), showPlan: vi.fn(), showSettings: vi.fn() };
      host.setNavigator(navigator);
      return { host, seen, navigator };
    };

    it('goes on to the planner model when the saved key\'s vendor now plans with none picked', async () => {
      const { host, seen, navigator } = saving({ aiProvider: 'openai', orchestratorModel: '' });

      await act(async () => { await host.enterApiKey(); });

      expect(navigator.showSettings).toHaveBeenCalledTimes(1);
      await vi.waitFor(() => expect(JSON.stringify(seen)).toContain('OpenAI now plans. Pick its planner model in Settings, under Planner, before your first goal.'));
    });

    it('stops at the key when a coding agent still plans, or the vendor has its model', async () => {
      for (const answer of [{ aiProvider: 'claude-code', orchestratorModel: '' }, { aiProvider: 'openai', orchestratorModel: 'gpt-5' }]) {
        const { host, navigator } = saving(answer);
        await act(async () => { await host.enterApiKey(); });
        expect(navigator.showSettings).not.toHaveBeenCalled();
      }
    });
  });
});
