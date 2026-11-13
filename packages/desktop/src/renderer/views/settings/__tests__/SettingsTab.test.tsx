import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_MAX_PARALLEL, RUN_SETTINGS_DEFAULTS, type SettingsResponse } from '@ordewell/core';
import { registerFrameCommands } from '../../../frame/commands';
import { Frame } from '../../../frame/Frame';
import { FrameProvider, FrameStore } from '../../../frame/store';
import { daemonHost, resetDaemonHosts } from '../../../session/DaemonHost';
import { fakeDaemon, ok } from '../../../session/__tests__/fakeDaemon';
import { register } from '../SettingsTab';
import { SETTINGS_TIMEOUT_MS } from '../useSettings';

vi.mock('../../../monaco', async () => (await import('../../../test/monacoMock')).fakeMonacoModule());

const WORKSPACE = '/work/acme';

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
    {
      id: 'codex', name: 'Codex', enabled: false,
      auth: {
        state: 'signed-out', loginCommand: ['codex', 'login'],
        signIn: { runner: 'codex', label: 'Codex', login: ['codex', 'login'] },
      },
    },
    {
      id: 'gemini-cli', name: 'Gemini CLI', enabled: true,
      auth: { state: 'signed-out', signIn: { runner: 'gemini-cli', label: 'Gemini CLI', key: { provider: 'google', label: 'Google Gemini' } } },
    },
  ],
  orchestratorModel: 'claude-sonnet',
};

const MODELS = {
  models: [],
  modelsByRunner: {
    'claude-code': [
      { modelId: 'claude-sonnet', modelLabel: 'Claude Sonnet', variants: [{ id: 'high', label: 'High' }] },
      { modelId: 'claude-opus', modelLabel: 'Claude Opus', variants: [] },
      { modelId: 'claude-haiku', modelLabel: 'Claude Haiku', variants: [] },
    ],
    codex: [{ modelId: 'o4-mini', modelLabel: 'o4-mini', variants: [] }, { modelId: 'o3', modelLabel: 'o3', variants: [] }],
  },
  modesByRunner: {},
  orchestratorModel: 'claude-sonnet',
  providers: ['openrouter'],
  orchestratorModels: [{ id: 'openai/gpt-5', label: 'GPT-5', provider: 'openai', apiProvider: 'openai' }],
  providerErrors: {},
  runnerErrors: {},
};

let offs: Array<() => void> = [];
afterEach(() => {
  vi.useRealTimers();
  for (const off of offs) off();
  offs = [];
  vi.restoreAllMocks();
  resetDaemonHosts();
});

interface World {
  daemon: ReturnType<typeof fakeDaemon>;
  prefs: { get: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn> };
}

interface WorldOptions {
  /** What the daemon holds before the test starts. */
  settings?: Partial<SettingsResponse>;
  /** The saved open state of Advanced. */
  advancedOpen?: boolean;
  /** Refuse every settings write with this sentence. */
  refuse?: string;
  models?: Partial<typeof MODELS>;
  runners?: { runners: Array<Record<string, unknown>>; orchestratorModel?: string };
  /** A route that never answers, to prove a read is bounded. */
  hang?: 'settings' | 'runners' | 'models' | 'prefs';
}

function world(theme: 'system' | 'light' | 'dark' = 'dark', options: WorldOptions = {}): World {
  let settings = { ...SETTINGS, ...options.settings };
  const never = <T,>(): Promise<T> => new Promise<T>(() => undefined);
  const daemon = fakeDaemon({
    'settings.get': () => options.hang === 'settings' ? never() : ok({ ...settings }),
    'runners.list': () => options.hang === 'runners' ? never() : ok(options.runners ?? RUNNERS),
    'models.list': () => options.hang === 'models' ? never() : ok({ ...MODELS, ...options.models }),
    'settings.update': (_params, body) => {
      if (options.refuse) return { ok: false, status: 400, error: options.refuse, data: { error: options.refuse } };
      const change = body as { autonomousMode?: boolean; orchestratorModel?: string; plannerThinkingEffort?: string; run?: Record<string, unknown>; env?: Record<string, string>; modelAllowlist?: Record<string, string[] | null> };
      if (change.autonomousMode !== undefined) settings = { ...settings, autonomousMode: change.autonomousMode };
      if (change.orchestratorModel !== undefined) settings = { ...settings, orchestratorModel: change.orchestratorModel };
      if (change.plannerThinkingEffort !== undefined) settings = { ...settings, plannerThinkingEffort: change.plannerThinkingEffort };
      if (change.run) settings = { ...settings, run: { ...settings.run, ...change.run } as SettingsResponse['run'] };
      if (change.env?.ORDEWELL_MAX_PARALLEL) settings = { ...settings, maxParallel: Number(change.env.ORDEWELL_MAX_PARALLEL) };
      if (change.env?.AI_PROVIDER) settings = { ...settings, aiProvider: change.env.AI_PROVIDER as SettingsResponse['aiProvider'] };
      if (change.modelAllowlist) settings = { ...settings, modelAllowlist: { ...settings.modelAllowlist, ...change.modelAllowlist } as SettingsResponse['modelAllowlist'] };
      return ok({ ...settings });
    },
    'runners.setEnabled': () => ok({ ok: true }),
  });
  let prefs = { theme, layouts: {}, notifications: true, keepRunningInTray: false, settingsAdvancedOpen: options.advancedOpen ?? false, editorCommand: '' };
  const get = vi.fn(() => options.hang === 'prefs' ? never() : Promise.resolve(prefs));
  const set = vi.fn(async (key: string, value: unknown) => {
    prefs = { ...prefs, [key]: value };
    return prefs;
  });
  Object.assign(window.ordewell, { prefs: { get, set } });
  return { daemon, prefs: { get, set } };
}

async function mount(theme: 'system' | 'light' | 'dark' = 'dark', options: WorldOptions = {}): Promise<{ store: FrameStore; w: World }> {
  const w = world(theme, options);
  const store = new FrameStore({ workspace: WORKSPACE, platform: 'linux' });
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
    expect(screen.getByRole('textbox', { name: /Parallel tasks/ })).toHaveValue('3');
  });

  it('re-detects the catalog after the planner changes, so the chat follows it', async () => {
    const { w } = await mount();
    const planner = await screen.findByRole('combobox', { name: 'Planner' });
    const before = w.daemon.calls('runners.list').length;

    fireEvent.change(planner, { target: { value: 'codex' } });

    await waitFor(() => expect(w.daemon.calls('runners.list').length).toBeGreaterThan(before));
    await waitFor(() => expect(daemonHost(WORKSPACE).getSnapshot().state.planner.provider).toBe('codex'));
  });

  it('lists every planner core ships, keeping an unavailable agent with its reason', async () => {
    await mount();
    const planner = await screen.findByRole('combobox', { name: 'Planner' });
    const options = within(planner).getAllByRole('option');
    expect(options.map((option) => option.getAttribute('value'))).toEqual([
      'claude-code', 'codex', 'opencode', 'copilot-cli', 'qwen-code', 'cline', 'gemini-cli', 'cursor-agent', 'openrouter',
    ]);
    const qwen = options.find((option) => option.getAttribute('value') === 'qwen-code') as HTMLOptionElement;
    expect(qwen).toBeDisabled();
    expect(qwen).toHaveTextContent('Qwen Code — not available');
    expect(screen.getByText(/Qwen Code — not available/)).toBeInTheDocument();
  });

  it('carries each runner\'s login state and why an unavailable one cannot be used', async () => {
    await mount();
    await screen.findByRole('heading', { name: 'Runners' });
    const codex = screen.getByRole('checkbox', { name: /Codex/ }).closest('li') as HTMLElement;
    expect(codex).toHaveTextContent('Signed out');
    const qwenCheckbox = screen.getByRole('checkbox', { name: /Qwen Code/ });
    expect(qwenCheckbox).toBeDisabled();
    expect(qwenCheckbox.closest('li')).toHaveTextContent('not available');
    expect(qwenCheckbox.closest('li')).toHaveTextContent('Install Qwen Code, then Refresh.');
  });

  it('shows a runner\'s own model error in its allowlist, not "lists no models"', async () => {
    const reason = 'Qwen Code is not signed in. Run qwen and sign in there.';
    const { w } = await mount('dark', {
      runners: {
        runners: [
          { id: 'claude-code', name: 'Claude Code', enabled: true, auth: { state: 'signed-in' } },
          { id: 'qwen-code', name: 'Qwen Code', enabled: true, auth: { state: 'signed-out' } },
        ],
      },
      models: { runnerErrors: { 'qwen-code': reason } },
    });
    await screen.findByRole('heading', { name: 'Runners' });
    const row = screen.getByRole('checkbox', { name: /Qwen Code/ }).closest('li') as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: 'Edit Qwen Code models' }));
    expect(within(row).getByText(reason)).toBeInTheDocument();
    expect(within(row).queryByText('Qwen Code lists no models.')).toBeNull();
    expect(w.daemon.calls('models.list')).not.toHaveLength(0);
  });

  it('re-reads every runner and catalog from the header Refresh, and on window focus, throttled', async () => {
    const { w } = await mount();
    await screen.findByRole('heading', { name: 'Runners' });
    const before = w.daemon.calls('runners.list').length;

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(w.daemon.calls('runners.list')).toHaveLength(before + 1));
    const afterRefresh = w.daemon.calls('runners.list').length;

    act(() => { window.dispatchEvent(new Event('focus')); });
    await waitFor(() => expect(w.daemon.calls('runners.list')).toHaveLength(afterRefresh + 1));

    act(() => { window.dispatchEvent(new Event('focus')); });
    expect(w.daemon.calls('runners.list')).toHaveLength(afterRefresh + 1);
    expect(w.daemon.calls('models.list')).toHaveLength(afterRefresh + 1);
  });

  it('never stays on "Loading…": a read that does not answer times out into the error and Retry', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    await mount('dark', { hang: 'runners' });
    await act(async () => { await vi.advanceTimersByTimeAsync(SETTINGS_TIMEOUT_MS + 1_000); });
    expect(screen.getByText('Settings could not be loaded')).toBeInTheDocument();
    expect(screen.getByText(`the daemon did not answer with its coding agents within ${SETTINGS_TIMEOUT_MS / 1000} seconds`)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('saves autonomy, a run rule, the parallel limit, and a runner through their routes', async () => {    const { w } = await mount();
    await screen.findByRole('heading', { name: 'Planner' });

    fireEvent.click(screen.getByRole('button', { name: 'Full' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Full' })).toHaveAttribute('aria-pressed', 'true'));
    expect(w.daemon.calls('settings.update').at(-1)?.[1]).toMatchObject({ autonomousMode: true, workspace: WORKSPACE });

    fireEvent.click(screen.getByRole('checkbox', { name: /Merge at gates automatically/ }));
    await waitFor(() => expect(w.daemon.calls('settings.update').at(-1)?.[1]).toMatchObject({ run: { mergeAtGatesAutomatically: true } }));

    const parallel = screen.getByRole('textbox', { name: /Parallel tasks/ });
    fireEvent.change(parallel, { target: { value: '4' } });
    fireEvent.blur(parallel);
    await waitFor(() => expect(w.daemon.calls('settings.update').at(-1)?.[1]).toMatchObject({ env: { ORDEWELL_MAX_PARALLEL: '4' } }));

    fireEvent.click(screen.getByRole('checkbox', { name: /Codex/ }));
    await waitFor(() => expect(w.daemon.calls('runners.setEnabled')).toContainEqual([{ id: 'codex' }, { enabled: true }]));
  });

  it('asks before the supervisor may act or autorun turns on, as the chat\'s Run block does, and Cancel saves nothing', async () => {
    const { w } = await mount();
    const supervisor = await screen.findByRole('combobox', { name: 'Supervisor' });

    fireEvent.change(supervisor, { target: { value: 'act' } });
    expect(await screen.findByText('Let the supervisor act?')).toBeInTheDocument();
    expect(w.daemon.calls('settings.update')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByText('Let the supervisor act?')).toBeNull());
    expect(w.daemon.calls('settings.update')).toHaveLength(0);
    expect(supervisor).toHaveValue(RUN_SETTINGS_DEFAULTS.supervisorLevel);

    fireEvent.click(screen.getByRole('checkbox', { name: /Autorun/ }));
    expect(await screen.findByText('Start plans without review?')).toBeInTheDocument();
    expect(w.daemon.calls('settings.update')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Turn autorun on' }));
    await waitFor(() => expect(w.daemon.calls('settings.update').at(-1)?.[1]).toMatchObject({ run: { autorun: true }, workspace: WORKSPACE }));
    await waitFor(() => expect(screen.getByRole('checkbox', { name: /Autorun/ })).toBeChecked());
  });

  it('tells every chat the run settings it saved, so the Run block and the approval note follow', async () => {
    await mount();
    await screen.findByRole('heading', { name: 'Run' });

    fireEvent.click(screen.getByRole('button', { name: 'Full' }));
    await waitFor(() => expect(daemonHost(WORKSPACE).getSnapshot().state.runSettings?.autonomous).toBe(true));

    fireEvent.click(screen.getByRole('checkbox', { name: /Merge at gates automatically/ }));
    await waitFor(() => expect(daemonHost(WORKSPACE).getSnapshot().state.runSettings?.run.mergeAtGatesAutomatically).toBe(true));

    const parallel = screen.getByRole('textbox', { name: /Parallel tasks/ });
    fireEvent.change(parallel, { target: { value: '5' } });
    fireEvent.blur(parallel);
    await waitFor(() => expect(daemonHost(WORKSPACE).getSnapshot().state.runSettings?.maxParallel).toBe(5));
  });

  it('words each signed-out runner as core does, and its Log in asks the session host', async () => {
    await mount();
    await screen.findByRole('heading', { name: 'Planner' });
    const row = screen.getByRole('checkbox', { name: /Codex/ }).closest('li') as HTMLElement;
    expect(row).toHaveTextContent('Sign in with /login codex, or run codex login.');

    const handle = vi.spyOn(daemonHost(WORKSPACE), 'handle');
    fireEvent.click(within(row).getByRole('button', { name: 'Log in' }));
    await waitFor(() => expect(handle).toHaveBeenCalledWith({ type: 'loginPlanner', runner: 'codex' }));
  });

  it('offers Set API key on a key-based runner, through the same host', async () => {
    await mount();
    await screen.findByRole('heading', { name: 'Planner' });
    const row = screen.getByRole('checkbox', { name: /Gemini CLI/ }).closest('li') as HTMLElement;
    expect(row).toHaveTextContent('Run /key and choose Google Gemini to hand it a key.');

    const key = vi.spyOn(daemonHost(WORKSPACE), 'enterApiKey').mockResolvedValue(false);
    fireEvent.click(within(row).getByRole('button', { name: 'Set API key…' }));
    await waitFor(() => expect(key).toHaveBeenCalledWith('google', 'Gemini CLI'));
  });

  it('re-reads its runners and settings when a sign-in or a planner change says the catalog moved', async () => {
    const { w } = await mount();
    await screen.findByRole('heading', { name: 'Planner' });
    const reads = w.daemon.calls('runners.list').length;

    await act(async () => { await daemonHost(WORKSPACE).handle({ type: 'setPlanner', provider: 'codex', requestId: 'r1' }); });

    await waitFor(() => expect(w.daemon.calls('runners.list').length).toBeGreaterThan(reads));
    // The row still stands: the refresh is in place, not a blank "Loading settings…".
    expect(screen.getByRole('heading', { name: 'Planner' })).toBeInTheDocument();
  });

  it('offers the key entry in the command palette', async () => {
    const { store } = await mount();
    await screen.findByRole('heading', { name: 'Planner' });
    const key = vi.spyOn(daemonHost(WORKSPACE), 'enterApiKey').mockResolvedValue(false);
    const command = store.enabledCommands().find((candidate) => candidate.id === 'settings.apiKey');
    expect(command?.title).toBe('Set API key…');
    await act(async () => { command?.run(); });
    expect(key).toHaveBeenCalledWith();
  });

  it('summarises each runner\'s allowlist and picks models from the runner\'s full list', async () => {
    const { w } = await mount();
    await screen.findByRole('heading', { name: 'Planner' });
    expect(screen.getAllByText('All models').length).toBeGreaterThan(0);
    expect(screen.getByText('1 of 2 models: o4-mini')).toBeInTheDocument();
    // Codex is switched off: its picker is there but cannot be opened.
    expect(screen.getByRole('button', { name: 'Edit Codex models' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Edit Claude Code models' }));
    const picker = within(screen.getByRole('listbox', { name: 'Claude Code models' }));
    expect(picker.getAllByRole('option')).toHaveLength(3);
    fireEvent.click(picker.getByRole('option', { name: /Claude Opus/ }));
    fireEvent.click(picker.getByRole('option', { name: /Claude Haiku/ }));
    expect(w.daemon.calls('settings.update')).toHaveLength(0);
    await waitFor(() => expect(w.daemon.calls('settings.update')).toHaveLength(1));
    expect(w.daemon.calls('settings.update').at(-1)?.[1]).toMatchObject({ modelAllowlist: { 'claude-code': ['claude-opus', 'claude-haiku'] }, workspace: WORKSPACE });
    await waitFor(() => expect(screen.getByText('2 of 3 models: Claude Opus, Claude Haiku')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Allow all models' }));
    await waitFor(() => expect(w.daemon.calls('settings.update').at(-1)?.[1]).toMatchObject({ modelAllowlist: { 'claude-code': null } }));
    await waitFor(() => expect(screen.queryByText(/2 of 3 models/)).not.toBeInTheDocument());
  });

  it('keeps the desktop preferences in this app: theme, notifications, the tray and reopening projects', async () => {
    const { w } = await mount();
    await screen.findByRole('heading', { name: 'This app' });

    fireEvent.change(screen.getByRole('combobox', { name: /^Theme/ }), { target: { value: 'light' } });
    await waitFor(() => expect(w.prefs.set).toHaveBeenCalledWith('theme', 'light'));

    fireEvent.click(screen.getByRole('checkbox', { name: /Desktop notifications/ }));
    await waitFor(() => expect(w.prefs.set).toHaveBeenCalledWith('notifications', false));

    fireEvent.click(screen.getByRole('checkbox', { name: /Keep running in the tray/ }));
    await waitFor(() => expect(w.prefs.set).toHaveBeenCalledWith('keepRunningInTray', true));

    const reopen = screen.getByRole('checkbox', { name: /Reopen projects on launch/ });
    expect(reopen).toBeChecked();
    fireEvent.click(reopen);
    await waitFor(() => expect(w.prefs.set).toHaveBeenCalledWith('reopenProjects', false));
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

  describe('a whole-number field', () => {
    const lastRunWrite = (w: World): unknown => w.daemon.calls('settings.update').at(-1)?.[1];

    it('is a text input for digits, with no spinner', async () => {
      await mount();
      const parallel = await screen.findByRole('textbox', { name: /Parallel tasks/ });
      expect(parallel).toHaveAttribute('inputmode', 'numeric');
      expect(parallel).not.toHaveAttribute('type', 'number');
      expect(document.querySelector('input[type="number"]')).toBeNull();
    });

    it('keeps only digits as they are typed', async () => {
      await mount();
      const parallel = await screen.findByRole('textbox', { name: /Parallel tasks/ });
      fireEvent.change(parallel, { target: { value: '1a2.5-' } });
      expect(parallel).toHaveValue('125');
    });

    it('commits the minimum when left empty: 1 for parallel tasks, 0 for supervisor retries', async () => {
      const { w } = await mount();
      const parallel = await screen.findByRole('textbox', { name: /Parallel tasks/ });
      fireEvent.change(parallel, { target: { value: '' } });
      fireEvent.blur(parallel);
      await waitFor(() => expect(lastRunWrite(w)).toMatchObject({ env: { ORDEWELL_MAX_PARALLEL: '1' } }));
      await waitFor(() => expect(parallel).toHaveValue('1'));

      const retries = screen.getByRole('textbox', { name: /Supervisor retries/ });
      fireEvent.change(retries, { target: { value: '' } });
      fireEvent.keyDown(retries, { key: 'Enter' });
      await waitFor(() => expect(lastRunWrite(w)).toMatchObject({ run: { supervisorRetryLimit: 0 } }));
      await waitFor(() => expect(retries).toHaveValue('0'));
    });

    it('shows the committed minimum when the value typed is below it', async () => {
      const { w } = await mount();
      const parallel = await screen.findByRole('textbox', { name: /Parallel tasks/ });
      fireEvent.change(parallel, { target: { value: '0' } });
      fireEvent.blur(parallel);
      await waitFor(() => expect(lastRunWrite(w)).toMatchObject({ env: { ORDEWELL_MAX_PARALLEL: '1' } }));
      expect(parallel).toHaveValue('1');
    });

    it('shows the committed value even when it equals the one already held', async () => {
      const { w } = await mount();
      const retries = await screen.findByRole('textbox', { name: /Supervisor retries/ });
      const writes = w.daemon.calls('settings.update').length;
      fireEvent.change(retries, { target: { value: '' } });
      fireEvent.change(retries, { target: { value: '2' } });
      fireEvent.blur(retries);
      expect(retries).toHaveValue('2');
      expect(w.daemon.calls('settings.update')).toHaveLength(writes);
    });

    it('groups a value of ten thousand or more while unfocused, and accepts grouping when typed', async () => {
      const { w } = await mount();
      const parallel = await screen.findByRole('textbox', { name: /Parallel tasks/ });
      fireEvent.focus(parallel);
      fireEvent.change(parallel, { target: { value: '12,000' } });
      expect(parallel).toHaveValue('12000');
      fireEvent.blur(parallel);
      await waitFor(() => expect(lastRunWrite(w)).toMatchObject({ env: { ORDEWELL_MAX_PARALLEL: '12000' } }));
      await waitFor(() => expect(parallel).toHaveValue('12,000'));
      fireEvent.focus(parallel);
      expect(parallel).toHaveValue('12000');
    });

    it('leaves a number below ten thousand ungrouped', async () => {
      await mount();
      const parallel = await screen.findByRole('textbox', { name: /Parallel tasks/ });
      fireEvent.change(parallel, { target: { value: '9999' } });
      fireEvent.blur(parallel);
      expect(parallel).toHaveValue('9999');
    });

    it('clamps a value past the safe integer to it', async () => {
      const { w } = await mount();
      const parallel = await screen.findByRole('textbox', { name: /Parallel tasks/ });
      fireEvent.change(parallel, { target: { value: '99999999999999999999' } });
      fireEvent.blur(parallel);
      await waitFor(() => expect(lastRunWrite(w)).toMatchObject({ env: { ORDEWELL_MAX_PARALLEL: String(Number.MAX_SAFE_INTEGER) } }));
    });
  });

  describe('Restore defaults', () => {
    const CHANGED: Partial<SettingsResponse> = {
      autonomousMode: true,
      maxParallel: 9,
      run: { ...RUN_SETTINGS_DEFAULTS, supervisorLevel: 'act', supervisorRetryLimit: 7, mergeAtGatesAutomatically: true, autorun: true },
    };
    const runSection = (): HTMLElement => screen.getByRole('heading', { name: 'Run' }).closest('section') as HTMLElement;

    it('sits at the top right of the Run header, and is disabled while everything is at its default', async () => {
      await mount('dark', { settings: { maxParallel: DEFAULT_MAX_PARALLEL } });
      const restore = await screen.findByRole('button', { name: 'Restore defaults' });
      expect(restore).toBeDisabled();
      expect(restore.closest('.settings-section-head')).toContainElement(screen.getByRole('heading', { name: 'Run' }));
      expect(runSection()).toContainElement(restore);
    });

    it('is enabled once any Run setting differs', async () => {
      await mount('dark', { settings: { maxParallel: DEFAULT_MAX_PARALLEL, run: { ...RUN_SETTINGS_DEFAULTS, autorun: true } } });
      expect(await screen.findByRole('button', { name: 'Restore defaults' })).toBeEnabled();
    });

    it('ignores the settings that live in Advanced when judging whether anything differs', async () => {
      await mount('dark', { settings: { maxParallel: DEFAULT_MAX_PARALLEL, run: { ...RUN_SETTINGS_DEFAULTS, plannedWithTrailer: false, wakeUpReadBudget: 3 } } });
      expect(await screen.findByRole('button', { name: 'Restore defaults' })).toBeDisabled();
    });

    it('leaves Subplanners alone: they are no longer Run\'s to show or restore', async () => {
      await mount('dark', { settings: { maxParallel: DEFAULT_MAX_PARALLEL, run: { ...RUN_SETTINGS_DEFAULTS, delegationTokens: 5000, delegationBudget: 5000, delegationDepth: 3 } } });
      expect(await screen.findByRole('button', { name: 'Restore defaults' })).toBeDisabled();
      expect(within(runSection()).queryByText(/subplanner|tree budget/i)).toBeNull();
    });

    it('asks first, and Cancel leaves everything as it was', async () => {
      const { w } = await mount('dark', { settings: CHANGED });
      fireEvent.click(await screen.findByRole('button', { name: 'Restore defaults' }));
      expect(screen.getByText('Restore Run settings to their defaults?')).toBeInTheDocument();
      expect(w.daemon.calls('settings.update')).toHaveLength(0);
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(screen.queryByText('Restore Run settings to their defaults?')).toBeNull();
      expect(screen.getByRole('button', { name: 'Restore defaults' })).toBeEnabled();
      expect(w.daemon.calls('settings.update')).toHaveLength(0);
    });

    it('writes core\'s own defaults for every setting Run shows, in one write', async () => {
      const { w } = await mount('dark', { settings: CHANGED });
      fireEvent.click(await screen.findByRole('button', { name: 'Restore defaults' }));
      fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
      await waitFor(() => expect(w.daemon.calls('settings.update')).toHaveLength(1));
      const { supervisorLevel, supervisorRetryLimit, mergeAtGatesAutomatically, autorun } = RUN_SETTINGS_DEFAULTS;
      const written = w.daemon.calls('settings.update')[0]?.[1] as { run: Record<string, unknown> };
      expect(written).toMatchObject({
        autonomousMode: false,
        env: { ORDEWELL_MAX_PARALLEL: String(DEFAULT_MAX_PARALLEL) },
        run: { supervisorLevel, supervisorRetryLimit, mergeAtGatesAutomatically, autorun },
        workspace: WORKSPACE,
      });
      expect(Object.keys(written.run).sort()).toEqual(['autorun', 'mergeAtGatesAutomatically', 'supervisorLevel', 'supervisorRetryLimit']);
      await waitFor(() => expect(screen.getByRole('button', { name: 'Guarded' })).toHaveAttribute('aria-pressed', 'true'));
      expect(screen.getByRole('textbox', { name: /Parallel tasks/ })).toHaveValue(String(DEFAULT_MAX_PARALLEL));
      expect(screen.queryByText('Restore Run settings to their defaults?')).toBeNull();
      expect(screen.getByRole('button', { name: 'Restore defaults' })).toBeDisabled();
    });

    it('shows one Saving state while it writes', async () => {
      await mount('dark', { settings: CHANGED });
      fireEvent.click(await screen.findByRole('button', { name: 'Restore defaults' }));
      fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
      expect(await screen.findAllByText('Saving…')).toHaveLength(1);
      await waitFor(() => expect(screen.queryByText('Saving…')).toBeNull());
    });

    it('reports an error when the write is refused, and keeps the values', async () => {
      await mount('dark', { settings: CHANGED, refuse: 'Parallel tasks must be a whole number' });
      fireEvent.click(await screen.findByRole('button', { name: 'Restore defaults' }));
      fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
      expect(await screen.findByRole('alert')).toHaveTextContent('Parallel tasks must be a whole number');
      expect(screen.getByRole('button', { name: 'Full' })).toHaveAttribute('aria-pressed', 'true');
      expect(screen.getByRole('button', { name: 'Restore defaults' })).toBeEnabled();
    });
  });

  describe('Advanced', () => {
    const advancedHeading = (): HTMLElement => screen.getByRole('heading', { name: 'Advanced' });

    it('is closed by default, after every other section', async () => {
      await mount();
      await screen.findByRole('heading', { name: 'Planner' });
      const toggle = screen.getByRole('button', { name: 'Advanced' });
      expect(toggle).toHaveAttribute('aria-expanded', 'false');
      expect(screen.queryByRole('checkbox', { name: /Planned-with line in commits/ })).toBeNull();
      expect(screen.queryByRole('textbox', { name: /Wake-up reads/ })).toBeNull();
      const headings = screen.getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent);
      expect(headings.at(-1)).toBe('Advanced');
      expect(headings).toEqual(['Appearance', 'Planner', 'Runners', 'Run', 'This app', 'Advanced']);
    });

    it('opens on click and remembers that in the desktop prefs', async () => {
      const { w } = await mount();
      fireEvent.click(await screen.findByRole('button', { name: 'Advanced' }));
      expect(screen.getByRole('button', { name: 'Advanced' })).toHaveAttribute('aria-expanded', 'true');
      expect(screen.getByRole('checkbox', { name: /Planned-with line in commits/ })).toBeChecked();
      expect(screen.getByRole('textbox', { name: /Wake-up reads/ })).toHaveValue('12');
      await waitFor(() => expect(w.prefs.set).toHaveBeenCalledWith('settingsAdvancedOpen', true));

      fireEvent.click(screen.getByRole('button', { name: 'Advanced' }));
      expect(screen.queryByRole('checkbox', { name: /Planned-with line in commits/ })).toBeNull();
      await waitFor(() => expect(w.prefs.set).toHaveBeenLastCalledWith('settingsAdvancedOpen', false));
    });

    it('comes back open when it was left open', async () => {
      await mount('dark', { advancedOpen: true });
      expect(await screen.findByRole('checkbox', { name: /Planned-with line in commits/ })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Advanced' })).toHaveAttribute('aria-expanded', 'true');
      expect(advancedHeading()).toBeInTheDocument();
    });

    it('moves the planned-with line and wake-up reads out of Run, which keeps the rest', async () => {
      await mount('dark', { advancedOpen: true });
      await screen.findByRole('heading', { name: 'Run' });
      const run = screen.getByRole('heading', { name: 'Run' }).closest('section') as HTMLElement;
      const advanced = advancedHeading().closest('section') as HTMLElement;
      for (const name of [/Planned-with line in commits/, /Wake-up reads/]) {
        expect(within(run).queryByLabelText(name)).toBeNull();
        expect(within(advanced).getByLabelText(name)).toBeInTheDocument();
      }
      for (const name of [/Autonomy/, /Supervisor$/, /Supervisor retries/, /Merge at gates/, /Autorun/, /Parallel tasks/]) {
        expect(within(run).getAllByLabelText(name).length).toBeGreaterThan(0);
      }
    });

    it('offers wake-up reads only while the supervisor is on', async () => {
      await mount('dark', { advancedOpen: true, settings: { run: { ...RUN_SETTINGS_DEFAULTS, supervisorLevel: 'off' } } });
      await screen.findByRole('checkbox', { name: /Planned-with line in commits/ });
      expect(screen.queryByRole('textbox', { name: /Wake-up reads/ })).toBeNull();
    });

    it('saves what is changed there, through the same routes', async () => {
      const { w } = await mount('dark', { advancedOpen: true });
      fireEvent.click(await screen.findByRole('checkbox', { name: /Planned-with line in commits/ }));
      await waitFor(() => expect(w.daemon.calls('settings.update').at(-1)?.[1]).toMatchObject({ run: { plannedWithTrailer: false } }));
      const reads = screen.getByRole('textbox', { name: /Wake-up reads/ });
      fireEvent.change(reads, { target: { value: '20' } });
      fireEvent.blur(reads);
      await waitFor(() => expect(w.daemon.calls('settings.update').at(-1)?.[1]).toMatchObject({ run: { wakeUpReadBudget: 20 } }));
    });

    it('holds Subplanners in its Experimental group, no containers setting, and no Restore defaults', async () => {
      await mount('dark', { advancedOpen: true, settings: { run: { ...RUN_SETTINGS_DEFAULTS, delegationTokens: 5000, delegationBudget: 5000 } } });
      const group = (await screen.findByRole('heading', { name: 'Experimental', level: 4 })).closest('.settings-group') as HTMLElement;
      expect(within(group).getByRole('checkbox', { name: /Subplanners/ })).toBeChecked();
      expect(document.body.textContent).not.toMatch(/container/i);
      expect(within(advancedHeading().closest('section') as HTMLElement).queryByRole('button', { name: 'Restore defaults' })).toBeNull();
    });

    it('has no daily version-check toggle, because the desktop never runs that check', async () => {
      await mount('dark', { advancedOpen: true });
      await screen.findByRole('heading', { name: 'Experimental', level: 4 });
      expect(screen.queryByText(/version check|check for updates/i)).toBeNull();
    });
  });

  describe('Subplanners', () => {
    const toggle = (): HTMLElement => screen.getByRole('checkbox', { name: /Subplanners/ });
    const field = (name: RegExp): HTMLElement => screen.getByRole('textbox', { name });
    const LIMITS = [/Tree budget/, /Maximum depth/, /Delegated tasks per plan/, /Tasks per child plan/];
    const kept = (over: Partial<SettingsResponse['run']> = {}): Partial<SettingsResponse> => ({ run: { ...RUN_SETTINGS_DEFAULTS, delegationBudget: 500000, ...over } });
    const lastRun = (w: World): unknown => (w.daemon.calls('settings.update').at(-1)?.[1] as { run?: unknown } | undefined)?.run;
    const type = (name: RegExp, value: string): void => {
      const input = field(name);
      fireEvent.change(input, { target: { value } });
      fireEvent.blur(input);
    };

    it('is off unless delegation is on today, marked Experimental, and says what it does', async () => {
      await mount('dark', { advancedOpen: true });
      expect(await screen.findByRole('checkbox', { name: /Subplanners/ })).not.toBeChecked();
      const row = toggle().closest('label') as HTMLElement;
      expect(within(row).getByText('Experimental').closest('.ow-badge')).toHaveClass('ow-badge-neutral');
      expect(row).toHaveTextContent("A plan's task may be handed to a subplanner, which plans and runs a child plan of its own.");
      for (const name of LIMITS) expect(screen.queryByRole('textbox', { name })).toBeNull();
    });

    it('shows the budget and the tree\'s shape while it is on, each as the daemon holds it', async () => {
      await mount('dark', { advancedOpen: true, settings: kept({ delegationTokens: 500000, delegationDepth: 3, delegatedTasksPerPlan: 5, tasksPerChildPlan: 40 }) });
      expect(await screen.findByRole('checkbox', { name: /Subplanners/ })).toBeChecked();
      expect(field(/Tree budget/)).toHaveValue('500,000');
      expect(field(/Maximum depth/)).toHaveValue('3');
      expect(field(/Delegated tasks per plan/)).toHaveValue('5');
      expect(field(/Tasks per child plan/)).toHaveValue('40');
      expect(field(/Maximum depth/).closest('label')).toHaveTextContent('Child plans may open up to 3 levels below your plan, at most 4.');
      expect(field(/Tasks per child plan/).closest('label')).toHaveTextContent('Your own plan has no such limit.');
    });

    it('turns off to flat plans, writing only the budget, and keeps every value for next time', async () => {
      const { w } = await mount('dark', { advancedOpen: true, settings: kept({ delegationTokens: 500000, delegationDepth: 3 }) });
      fireEvent.click(await screen.findByRole('checkbox', { name: /Subplanners/ }));
      await waitFor(() => expect(lastRun(w)).toEqual({ delegationTokens: 0 }));
      await waitFor(() => expect(toggle()).not.toBeChecked());
      for (const name of LIMITS) expect(screen.queryByRole('textbox', { name })).toBeNull();

      fireEvent.click(toggle());
      const ask = screen.getByRole('group', { name: 'Turn Subplanners on' });
      expect(ask).toHaveTextContent('A tree of plans may spend up to 500,000 tokens.');
      expect(within(ask).queryByRole('textbox')).toBeNull();
      fireEvent.click(within(ask).getByRole('button', { name: 'Turn on' }));
      await waitFor(() => expect(lastRun(w)).toEqual({ delegationTokens: 500000 }));
      await waitFor(() => expect(field(/Maximum depth/)).toHaveValue('3'));
      expect(field(/Tree budget/)).toHaveValue('500,000');
    });

    it('asks before it turns on, saying that no person reads a subplanner\'s plan, and Cancel saves nothing', async () => {
      const { w } = await mount('dark', { advancedOpen: true, settings: kept() });
      fireEvent.click(await screen.findByRole('checkbox', { name: /Subplanners/ }));
      const ask = screen.getByRole('group', { name: 'Turn Subplanners on' });
      expect(ask).toHaveTextContent('Turn Subplanners on?');
      expect(ask).toHaveTextContent(/no person reads it/);
      expect(ask).toHaveTextContent(/keep the network they have in a flat run/);
      expect(ask).toHaveTextContent(/counted approximately/);
      expect(ask.textContent).not.toMatch(/container/i);
      fireEvent.click(within(ask).getByRole('button', { name: 'Cancel' }));
      expect(screen.queryByRole('group', { name: 'Turn Subplanners on' })).toBeNull();
      expect(toggle()).not.toBeChecked();
      expect(w.daemon.calls('settings.update')).toHaveLength(0);
    });

    it('takes a first budget from the user, never a default', async () => {
      const { w } = await mount('dark', { advancedOpen: true });
      fireEvent.click(await screen.findByRole('checkbox', { name: /Subplanners/ }));
      const ask = screen.getByRole('group', { name: 'Turn Subplanners on' });
      const budget = within(ask).getByRole('textbox', { name: /Tree budget/ });
      expect(budget).toHaveValue('');
      const turnOn = within(ask).getByRole('button', { name: 'Turn on' });
      expect(turnOn).toBeDisabled();
      fireEvent.change(budget, { target: { value: '0' } });
      expect(turnOn).toBeDisabled();
      fireEvent.change(budget, { target: { value: '200,000' } });
      expect(budget).toHaveValue('200000');
      fireEvent.click(turnOn);
      await waitFor(() => expect(lastRun(w)).toEqual({ delegationTokens: 200000 }));
      expect(await screen.findByRole('textbox', { name: /Tree budget/ })).toHaveValue('200,000');
    });

    it('commits each limit within its bounds: empty or below the minimum is 1, past the cap is the cap', async () => {
      const { w } = await mount('dark', { advancedOpen: true, settings: kept({ delegationTokens: 500000 }) });
      await screen.findByRole('checkbox', { name: /Subplanners/ });
      type(/Maximum depth/, '');
      await waitFor(() => expect(lastRun(w)).toEqual({ delegationDepth: 1 }));
      expect(field(/Maximum depth/)).toHaveValue('1');
      type(/Maximum depth/, '9');
      await waitFor(() => expect(lastRun(w)).toEqual({ delegationDepth: 4 }));
      expect(field(/Maximum depth/)).toHaveValue('4');
      type(/Delegated tasks per plan/, '0');
      await waitFor(() => expect(lastRun(w)).toEqual({ delegatedTasksPerPlan: 1 }));
      type(/Delegated tasks per plan/, '99');
      await waitFor(() => expect(lastRun(w)).toEqual({ delegatedTasksPerPlan: 30 }));
      type(/Tasks per child plan/, '500');
      await waitFor(() => expect(lastRun(w)).toEqual({ tasksPerChildPlan: 100 }));
      type(/Tree budget/, '');
      await waitFor(() => expect(lastRun(w)).toEqual({ delegationTokens: 1 }));
      expect(toggle()).toBeChecked();
    });
  });
});
