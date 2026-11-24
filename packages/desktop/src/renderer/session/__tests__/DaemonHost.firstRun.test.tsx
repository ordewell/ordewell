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
