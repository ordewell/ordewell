import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DaemonStatus, UpdateCheckOutcome, UpdateState } from '../../../../shared/bridge';
import { registerFrameCommands } from '../../../frame/commands';
import { Frame } from '../../../frame/Frame';
import { FrameProvider, FrameStore } from '../../../frame/store';
import { resetDaemonHosts } from '../../../session/DaemonHost';
import { fakeDaemon, ok, surfacePlan } from '../../../session/__tests__/fakeDaemon';
import { registerViews } from '../../index';
import { resetTaskViews } from '../../task/taskView';

vi.mock('../../../monaco', async () => (await import('../../../test/monacoMock')).fakeMonacoModule());

const WORKSPACE = '/work/acme';
const CONNECTED: DaemonStatus = { state: 'connected', port: 3700, owned: true, daemon: { version: '1.2.0', contract: 1 } };
const NONE: UpdateState = { current: '1.2.0', method: 'download', updater: { phase: 'idle' } };

let offs: Array<() => void> = [];
afterEach(() => {
  for (const off of offs) off();
  offs = [];
  resetDaemonHosts();
  resetTaskViews();
});

interface Main {
  /** What main broadcasts next, as UpdateService.onChange does after core's onUpdate. */
  push(state: UpdateState): void;
  update: {
    check: ReturnType<typeof vi.fn>;
    download: ReturnType<typeof vi.fn>;
    restart: ReturnType<typeof vi.fn>;
    dismissNotice: ReturnType<typeof vi.fn>;
  };
  openExternal: ReturnType<typeof vi.fn>;
  setPref: ReturnType<typeof vi.fn>;
}

/** Main's side of the update bridge, holding the state the window reads at start and pushing each change. */
function main(initial: UpdateState, outcome: UpdateCheckOutcome = { kind: 'up-to-date' }): Main {
  fakeDaemon({ 'sessions.load': ok({ ok: true, plan: surfacePlan([]), goal: '' }) });
  let state = initial;
  const listeners = new Set<(state: UpdateState) => void>();
  const push = (next: UpdateState): void => {
    state = next;
    for (const cb of [...listeners]) cb(next);
  };
  const update = {
    state: vi.fn(async () => state),
    onChange: (cb: (state: UpdateState) => void) => { listeners.add(cb); return () => { listeners.delete(cb); }; },
    check: vi.fn(async () => outcome),
    download: vi.fn(async () => undefined),
    restart: vi.fn(async () => true),
    dismissNotice: vi.fn(async () => {
      const rest = { ...state };
      delete rest.notice;
      push(rest);
    }),
  };
  const openExternal = vi.fn(async () => ({ ok: true }));
  const prefs = { theme: 'system', layouts: {}, notifications: true, keepRunningInTray: false, editorCommand: '' };
  const setPref = vi.fn(async (key: string, value: unknown) => ({ ...prefs, [key]: value }));
  Object.assign(window.ordewell, {
    update,
    shell: { openExternal, openInEditor: vi.fn(), reveal: vi.fn() },
    prefs: { get: async () => prefs, set: setPref },
    dialog: { confirm: vi.fn(async () => true) },
    notify: { show: vi.fn(async () => ({ ok: true })), setBadge: vi.fn(async () => undefined), onClick: () => () => undefined },
  });
  return { push, update, openExternal, setPref };
}

function mount(): FrameStore {
  const store = new FrameStore({ workspace: WORKSPACE, platform: 'linux' });
  offs.push(registerFrameCommands(store), registerViews(store.api));
  render(<FrameProvider value={store}><Frame daemon={CONNECTED} /></FrameProvider>);
  return store;
}

const TITLE = 'Ordewell 1.3.0 is available. You have 1.2.0.';
const banner = (): Promise<HTMLElement> => screen.findByRole('region', { name: TITLE });
const indicator = (): Promise<HTMLElement> => screen.findByRole('button', { name: 'Ordewell 1.3.0 is available' });

describe('a new version, on a build that cannot update itself', () => {
  it('shows the version main already knows at startup, as a banner and in the status bar', async () => {
    // What a remembered `latest` in version-check.json becomes in main: no ping, no event, just the first state.
    main({ ...NONE, latest: '1.3.0' });
    mount();
    const shown = await banner();
    expect(shown).toHaveClass('frame-banner-info');
    expect(await indicator()).toHaveTextContent('↑ 1.3.0 available');
    expect(document.querySelector('[data-slot="status.update"]')).toContainElement(await indicator());
    expect(within(shown).getByRole('button', { name: 'Download' })).toBeInTheDocument();
    expect(within(shown).queryByRole('button', { name: 'Update' })).toBeNull();
  });

  it('shows a version main learns later, when the daily check names it', async () => {
    const w = main(NONE);
    mount();
    await screen.findByRole('button', { name: 'More actions' });
    expect(screen.queryByRole('region', { name: TITLE })).toBeNull();
    act(() => w.push({ ...NONE, latest: '1.3.0' }));
    await banner();
    await indicator();
    expect(screen.getByRole('status')).toHaveTextContent(TITLE);
  });

  it('opens the download page and the release notes, and Later keeps the indicator, which brings the banner back', async () => {
    const w = main({ ...NONE, latest: '1.3.0' });
    mount();
    fireEvent.click(within(await banner()).getByRole('button', { name: 'Download' }));
    await waitFor(() => expect(w.openExternal).toHaveBeenCalledWith('https://ordewell.ai/download'));
    fireEvent.click(within(await banner()).getByRole('button', { name: "What's new" }));
    await waitFor(() => expect(w.openExternal).toHaveBeenCalledWith('https://github.com/ordewell/ordewell/releases/tag/v1.3.0'));

    fireEvent.click(within(await banner()).getByRole('button', { name: 'Later' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: TITLE })).toBeNull());
    fireEvent.click(await indicator());
    await banner();
  });

  it('keeps the indicator when main pushes again after Later, and says nothing twice', async () => {
    const w = main({ ...NONE, latest: '1.3.0' });
    mount();
    fireEvent.click(within(await banner()).getByRole('button', { name: 'Later' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: TITLE })).toBeNull());
    act(() => w.push({ ...NONE, latest: '1.3.0' }));
    expect(await indicator()).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: TITLE })).toBeNull();
  });

  it('drops the banner and the indicator once main names no newer version', async () => {
    const w = main({ ...NONE, latest: '1.3.0' });
    mount();
    await indicator();
    act(() => w.push(NONE));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Ordewell 1.3.0 is available' })).toBeNull());
    expect(screen.queryByRole('region', { name: TITLE })).toBeNull();
  });
});

describe('a new version, on a signed build', () => {
  const SIGNED: UpdateState = { ...NONE, method: 'install', latest: '1.3.0' };

  it('downloads on Update with its progress in the banner, then offers Restart to update', async () => {
    const w = main(SIGNED);
    mount();
    fireEvent.click(within(await banner()).getByRole('button', { name: 'Update' }));
    await waitFor(() => expect(w.update.download).toHaveBeenCalledOnce());

    act(() => w.push({ ...SIGNED, updater: { phase: 'downloading', version: '1.3.0', percent: 42 } }));
    await waitFor(async () => expect(await banner()).toHaveTextContent('Downloading… 42%'));
    expect(within(await banner()).queryByRole('button', { name: 'Update' })).toBeNull();

    act(() => w.push({ ...SIGNED, updater: { phase: 'ready', version: '1.3.0' } }));
    fireEvent.click(await within(await banner()).findByRole('button', { name: 'Restart to update' }));
    await waitFor(() => expect(w.update.restart).toHaveBeenCalledOnce());
    expect(await indicator()).toHaveTextContent('↑ 1.3.0 ready');
  });

  it('says why when the updater fails, and offers the download page instead', async () => {
    const w = main({ ...SIGNED, updater: { phase: 'error', message: 'net::ERR_INTERNET_DISCONNECTED' } });
    mount();
    const shown = await banner();
    expect(shown).toHaveTextContent('The update could not be downloaded: net::ERR_INTERNET_DISCONNECTED');
    fireEvent.click(within(shown).getByRole('button', { name: 'Download' }));
    await waitFor(() => expect(w.openExternal).toHaveBeenCalledWith('https://ordewell.ai/download'));
    expect(within(shown).getByRole('button', { name: 'Update' })).toBeInTheDocument();
  });

  it('says so when the daily check names a version the updater has no build of yet', async () => {
    main({ ...SIGNED, updater: { phase: 'up-to-date' } });
    mount();
    const shown = await banner();
    expect(shown).toHaveTextContent('No desktop build of 1.3.0 is published yet.');
    expect(within(shown).queryByRole('button', { name: 'Update' })).toBeNull();
  });
});

describe('the one-time notice', () => {
  it('says what the check sends before any is sent, and its Turn off writes the Settings toggle', async () => {
    const w = main({ ...NONE, notice: 'Ordewell checks for a new version once a day. In this app: Settings → Check for new versions.' });
    mount();
    const notice = await screen.findByRole('region', { name: 'Ordewell checks for new versions' });
    expect(notice).toHaveTextContent('Settings → Check for new versions');
    fireEvent.click(within(notice).getByRole('button', { name: 'Turn off' }));
    await waitFor(() => expect(w.setPref).toHaveBeenCalledWith('versionCheck', false));
    await waitFor(() => expect(w.update.dismissNotice).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Ordewell checks for new versions' })).toBeNull());
  });

  it('goes on OK, leaving the check on', async () => {
    const w = main({ ...NONE, notice: 'Ordewell checks for a new version once a day.' });
    mount();
    fireEvent.click(within(await screen.findByRole('region', { name: 'Ordewell checks for new versions' })).getByRole('button', { name: 'OK' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Ordewell checks for new versions' })).toBeNull());
    expect(w.setPref).not.toHaveBeenCalled();
  });
});

describe('Check for updates…', () => {
  const run = async (store: FrameStore): Promise<void> => {
    await screen.findByRole('button', { name: 'More actions' });
    act(() => store.api.runCommand('update.check'));
  };

  it('is in the ⋯ menu', async () => {
    main(NONE);
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'More actions' }));
    expect(await screen.findByRole('menuitem', { name: 'Check for updates…' })).toBeInTheDocument();
  });

  it("ends in You're up to date", async () => {
    const w = main(NONE, { kind: 'up-to-date' });
    await run(mount());
    const shown = await screen.findByRole('region', { name: "You're up to date" });
    expect(shown).toHaveTextContent('Ordewell 1.2.0 is the latest version.');
    expect(w.update.check).toHaveBeenCalledOnce();
  });

  it('ends in the notice when it finds one', async () => {
    const w = main(NONE, { kind: 'available', latest: '1.3.0' });
    w.update.check.mockImplementation(async () => {
      w.push({ ...NONE, latest: '1.3.0' });
      return { kind: 'available', latest: '1.3.0' };
    });
    await run(mount());
    await banner();
    expect(screen.queryByRole('region', { name: "You're up to date" })).toBeNull();
  });

  it('shows the notice again after Later, when asked', async () => {
    main({ ...NONE, latest: '1.3.0' }, { kind: 'available', latest: '1.3.0' });
    const store = mount();
    fireEvent.click(within(await banner()).getByRole('button', { name: 'Later' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: TITLE })).toBeNull());
    await run(store);
    await banner();
  });

  it('says where the check is off', async () => {
    main(NONE, { kind: 'off', reason: 'setting' });
    await run(mount());
    expect(await screen.findByRole('region', { name: 'Checking for new versions is off' })).toHaveTextContent('Settings → Check for new versions');
  });

  it('names the environment variable that turned it off', async () => {
    main(NONE, { kind: 'off', reason: 'environment' });
    await run(mount());
    expect(await screen.findByRole('region', { name: 'Checking for new versions is off' })).toHaveTextContent('ORDEWELL_NO_VERSION_CHECK or DO_NOT_TRACK');
  });

  it('says why when it fails', async () => {
    main(NONE, { kind: 'failed', message: 'offline' });
    await run(mount());
    const shown = await screen.findByRole('region', { name: "Couldn't check for updates" });
    expect(shown).toHaveClass('frame-banner-error');
    expect(shown).toHaveTextContent('offline');
  });
});
