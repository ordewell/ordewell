import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { FrameApi, SlotView } from '../../../frame/api';
import { daemonHost, resetDaemonHosts } from '../../../session/DaemonHost';
import { fakeDaemon, ok } from '../../../session/__tests__/fakeDaemon';
import { register } from '../StatusSlots';

afterEach(() => resetDaemonHosts());

function slots(): Map<string, SlotView> {
  const registered = new Map<string, SlotView>();
  const api = {
    workspace: '/work/acme',
    registerSlot: (slot: SlotView) => { registered.set(slot.slot, slot); return () => registered.delete(slot.slot); },
  } as unknown as FrameApi;
  register(api);
  return registered;
}

describe('the status bar\'s runners', () => {
  it('names each runner that is on, and says whether its login is signed in', async () => {
    fakeDaemon({
      'runners.list': ok({ runners: [
        { id: 'claude-code', name: 'Claude Code', enabled: true, auth: { state: 'signed-in' } },
        { id: 'codex', name: 'Codex', enabled: true, auth: { state: 'signed-out', loginCommand: 'codex login' } },
        { id: 'opencode', name: 'OpenCode', enabled: true, auth: { state: 'unknown' } },
        { id: 'gemini', name: 'Gemini', enabled: false },
      ] }),
      'models.list': ok({ models: [], providers: [], modelsByRunner: {}, modesByRunner: {}, orchestratorModel: '' }),
      'settings.get': ok({}),
    });
    const runners = slots().get('status.runners');
    render(<>{runners?.render()}</>);
    await act(() => daemonHost('/work/acme').handle({ type: 'ready' }));

    expect(await screen.findByLabelText('Claude Code, signed in')).toHaveTextContent('Claude Code ✓');
    expect(screen.getByLabelText('Codex, signed out')).toHaveTextContent('Codex · signed out');
    // A runner that cannot say is not flagged (ADR-0009).
    expect(screen.getByLabelText('OpenCode, sign-in not known')).toHaveTextContent(/^OpenCode$/);
    expect(screen.queryByText(/Gemini|claude-code/)).toBeNull();
  });
});
