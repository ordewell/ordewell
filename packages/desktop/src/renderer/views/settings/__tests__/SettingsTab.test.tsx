import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RUN_SETTINGS_DEFAULTS, type SettingsResponse } from '@ordewell/core';
import { registerFrameCommands } from '../../../frame/commands';
import { Frame } from '../../../frame/Frame';
import { FrameProvider, FrameStore } from '../../../frame/store';
import { resetDaemonHosts } from '../../../session/DaemonHost';
import { fakeDaemon, ok } from '../../../session/__tests__/fakeDaemon';
import { register } from '../SettingsTab';

vi.mock('../../../monaco', async () => (await import('../../../test/monacoMock')).fakeMonacoModule());

const WORKSPACE = '/work/acme';
const SIZES = { sidebar: 260, right: 360, bottom: 240 };

const SETTINGS: SettingsResponse = {
  orchestratorModel: 'claude-sonnet',
  aiProvider: 'claude-code',
  plannerThinkingEffort: '',
  autonomousMode: false,
  maxParallel: 3,
  modelAllowlist: { codex: ['o4-mini'] },
  plannerModels: undefined,
  run: { ...RUN_SETTINGS_DEFAULTS },
};

const RUNNERS = {
  runners: [
    { id: 'claude-code', name: 'Claude Code', enabled: true, auth: { state: 'signed-in' } },
    { id: 'codex', name: 'Codex', enabled: false, auth: { state: 'signed-out' } },
  ],
  orchestratorModel: 'claude-sonnet',
};

const MODELS = {
  models: [],
  modelsByRunner: {
    'claude-code': [{ modelId: 'claude-sonnet', modelLabel: 'Claude Sonnet', variants: [{ id: 'high', label: 'High' }] }],
  },
  modesByRunner: {},
  orchestratorModel: 'claude-sonnet',
  providers: ['openrouter'],
  orchestratorModels: [{ id: 'openai/gpt-5', label: 'GPT-5', provider: 'openai', apiProvider: 'openai' }],
  providerErrors: {},
};

let offs: Array<() => void> = [];
afterEach(() => {
  for (const off of offs) off();
  offs = [];
  resetDaemonHosts();
});

interface World {
  daemon: ReturnType<typeof fakeDaemon>;
  prefs: { get: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn> };
}

function world(theme: 'system' | 'light' | 'dark' = 'dark'): World {
  let settings = { ...SETTINGS };
  const daemon = fakeDaemon({
    'settings.get': () => ok({ ...settings }),
    'runners.list': () => ok(RUNNERS),
    'models.list': () => ok(MODELS),
    'settings.update': (_params, body) => {
      const change = body as { autonomousMode?: boolean; orchestratorModel?: string; plannerThinkingEffort?: string; run?: Record<string, unknown>; env?: Record<string, string>; modelAllowlist?: Record<string, string[] | null> };
      if (change.autonomousMode !== undefined) settings = { ...settings, autonomousMode: change.autonomousMode };
      if (change.orchestratorModel !== undefined) settings = { ...settings, orchestratorModel: change.orchestratorModel };
      if (change.plannerThinkingEffort !== undefined) settings = { ...settings, plannerThinkingEffort: change.plannerThinkingEffort };
      if (change.run) settings = { ...settings, run: { ...settings.run, ...change.run } as SettingsResponse['run'] };
      if (change.env?.ORDEWELL_MAX_PARALLEL) settings = { ...settings, maxParallel: Number(change.env.ORDEWELL_MAX_PARALLEL) };
      if (change.modelAllowlist) settings = { ...settings, modelAllowlist: { ...settings.modelAllowlist, ...change.modelAllowlist } as SettingsResponse['modelAllowlist'] };
      return ok({ ...settings });
    },
    'runners.setEnabled': () => ok({ ok: true }),
  });
  let prefs = { theme, panes: SIZES, notifications: true, keepRunningInTray: false, editorCommand: '' };
  const get = vi.fn(async () => prefs);
  const set = vi.fn(async (key: string, value: unknown) => {
    prefs = { ...prefs, [key]: value };
    return prefs;
  });
  Object.assign(window.ordewell, { prefs: { get, set } });
  return { daemon, prefs: { get, set } };
}

async function mount(theme: 'system' | 'light' | 'dark' = 'dark'): Promise<{ store: FrameStore; w: World }> {
  const w = world(theme);
  const store = new FrameStore({ workspace: WORKSPACE, platform: 'linux', sizes: SIZES });
  offs.push(registerFrameCommands(store), register(store.api));
  render(<FrameProvider value={store}><Frame daemon={{ state: 'connected', port: 3700, owned: true, daemon: { version: '0.12.3', contract: 1 } }} /></FrameProvider>);
  act(() => store.api.openTab({ kind: 'settings', id: 'settings', title: 'Settings' }));
  return { store, w };
}

describe('the Settings view', () => {
  it('draws the planner, the runners and the run rules the daemon holds', async () => {
    await mount();
    expect(await screen.findByRole('heading', { name: 'Planner' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Planner' })).toHaveValue('claude-code');
    expect(screen.getByRole('combobox', { name: 'Planner model' })).toHaveValue('claude-sonnet');
    expect(screen.getByRole('checkbox', { name: /Claude Code/ })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /Codex/ })).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'Guarded' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('spinbutton', { name: /Parallel tasks/ })).toHaveValue(3);
  });

  it('saves autonomy, a run rule, the parallel limit, a runner and a model allowlist through their routes', async () => {
    const { w } = await mount();
    await screen.findByRole('heading', { name: 'Planner' });

    fireEvent.click(screen.getByRole('button', { name: 'Full' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Full' })).toHaveAttribute('aria-pressed', 'true'));
    expect(w.daemon.calls('settings.update').at(-1)?.[1]).toMatchObject({ autonomousMode: true, workspace: WORKSPACE });

    fireEvent.click(screen.getByRole('checkbox', { name: /Merge at gates automatically/ }));
    await waitFor(() => expect(w.daemon.calls('settings.update').at(-1)?.[1]).toMatchObject({ run: { mergeAtGatesAutomatically: true } }));

    const parallel = screen.getByRole('spinbutton', { name: /Parallel tasks/ });
    fireEvent.change(parallel, { target: { value: '4' } });
    fireEvent.blur(parallel);
    await waitFor(() => expect(w.daemon.calls('settings.update').at(-1)?.[1]).toMatchObject({ env: { ORDEWELL_MAX_PARALLEL: '4' } }));

    fireEvent.click(screen.getByRole('checkbox', { name: /Codex/ }));
    await waitFor(() => expect(w.daemon.calls('runners.setEnabled')).toContainEqual([{ id: 'codex' }, { enabled: true }]));

    const allowlist = screen.getByLabelText(/Codex models/);
    fireEvent.change(allowlist, { target: { value: 'o4-mini, o3' } });
    fireEvent.blur(allowlist);
    await waitFor(() => expect(w.daemon.calls('settings.update').at(-1)?.[1]).toMatchObject({ modelAllowlist: { codex: ['o4-mini', 'o3'] } }));
  });

  it('keeps the desktop preferences in this app: theme, notifications and the tray', async () => {
    const { w } = await mount();
    await screen.findByRole('heading', { name: 'This app' });

    fireEvent.change(screen.getByRole('combobox', { name: /^Theme/ }), { target: { value: 'light' } });
    await waitFor(() => expect(w.prefs.set).toHaveBeenCalledWith('theme', 'light'));

    fireEvent.click(screen.getByRole('checkbox', { name: /Desktop notifications/ }));
    await waitFor(() => expect(w.prefs.set).toHaveBeenCalledWith('notifications', false));

    fireEvent.click(screen.getByRole('checkbox', { name: /Keep running in the tray/ }));
    await waitFor(() => expect(w.prefs.set).toHaveBeenCalledWith('keepRunningInTray', true));
  });

  it.each(['dark', 'light', 'system'] as const)('shows the theme the preference holds: %s', async (theme) => {
    await mount(theme);
    await screen.findByRole('heading', { name: 'Appearance' });
    await waitFor(() => expect(screen.getByRole('combobox', { name: /^Theme/ })).toHaveValue(theme));
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual(expect.arrayContaining(['Dark', 'Light', 'System']));
  });

  it('follows a theme chosen in the command palette', async () => {
    const { store, w } = await mount('dark');
    await screen.findByRole('heading', { name: 'Appearance' });
    await waitFor(() => expect(screen.getByRole('combobox', { name: /^Theme/ })).toHaveValue('dark'));

    await act(async () => { await store.enabledCommands().find((command) => command.id === 'theme.light')?.run(); });
    expect(w.prefs.set).toHaveBeenCalledWith('theme', 'light');
    await waitFor(() => expect(screen.getByRole('combobox', { name: /^Theme/ })).toHaveValue('light'));
  });
});
