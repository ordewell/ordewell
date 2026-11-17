import { useSyncExternalStore } from 'react';
import type { UpdateCheckOutcome, UpdateState } from '../../../shared/bridge';
import type { Banner, BannerAction, FrameApi, Unregister } from '../../frame/api';

/** Where an unsigned build, Linux and an AppImage get the new version (ADR-0063 H9). */
export const DOWNLOAD_PAGE = 'https://ordewell.ai/download';
/** release.yml publishes each version under its `v`-prefixed tag. */
export const releaseNotes = (version: string): string => `https://github.com/ordewell/ordewell/releases/tag/v${version}`;

const SWITCH = 'Settings → Check for new versions';

/** The version the person has not been offered yet, and the words for where it stands. */
function words(state: UpdateState, latest: string): Pick<Banner, 'body'> {
  const updater = state.updater;
  if (state.method === 'download') return {};
  switch (updater.phase) {
    case 'checking': return { body: 'Finding the download…' };
    case 'downloading': return { body: `Downloading… ${Math.round(updater.percent)}%` };
    case 'ready': return { body: 'Downloaded. Restart Ordewell to finish updating.' };
    case 'error': return { body: `The update could not be downloaded: ${updater.message}` };
    // The daily check names a release the updater has no build of yet (release.yml may skip the desktop).
    case 'up-to-date': return { body: `No desktop build of ${latest} is published yet.` };
    default: return {};
  }
}

/** One label in the status bar while a version is known: where the banner can always be had again. */
function indicatorText(state: UpdateState, latest: string): string {
  if (state.updater.phase === 'ready') return `↑ ${latest} ready`;
  if (state.updater.phase === 'downloading') return `↑ ${latest} · ${Math.round(state.updater.percent)}%`;
  return `↑ ${latest} available`;
}

/**
 * A newer Ordewell, as main knows it from the daily version check or the
 * updater (ADR-0048, ADR-0063 H9): a banner that says so with the way to get
 * it, an indicator in the status bar that stays while the version is known,
 * and Check for updates… in the ⋯ menu. Main also sends the version check's
 * one-time notice here, before the check sends anything.
 *
 * Later hides only the banner. The indicator stays until main names no newer
 * version, so neither a dismissal here nor another surface's once-a-day line
 * ever hides that one is out.
 */
export function register(api: FrameApi): Unregister {
  // A test's bridge, or an older preload, may have no update channel at all.
  const bridge = (): Window['ordewell']['update'] | undefined => window.ordewell.update;
  let state: UpdateState | undefined;
  let later: string | undefined;
  const listeners = new Set<() => void>();
  const shown = new Map<string, () => void>();

  const show = (banner: Banner): void => { shown.set(banner.id, api.showBanner(banner)); };
  const hide = (id: string): void => {
    shown.get(id)?.();
    shown.delete(id);
  };
  const open = (url: string): void => { void window.ordewell.shell.openExternal(url); };
  const dismissNotice = async (): Promise<void> => { await bridge()?.dismissNotice(); };

  const banners = (): void => {
    if (state?.notice !== undefined) {
      show({
        id: 'update.notice',
        tone: 'info',
        title: 'Ordewell checks for new versions',
        body: state.notice,
        actions: [
          { label: 'OK', run: dismissNotice },
          {
            label: 'Turn off',
            run: async () => {
              await window.ordewell.prefs.set('versionCheck', false);
              await dismissNotice();
            },
          },
        ],
      });
    } else {
      hide('update.notice');
    }

    const latest = state?.latest;
    if (state === undefined || latest === undefined || later === latest) {
      hide('update.available');
      return;
    }
    const phase = state.updater.phase;
    const actions: BannerAction[] = [];
    if (state.method === 'install') {
      if (phase === 'ready') {
        actions.push({ label: 'Restart to update', run: async () => { await bridge()?.restart(); } });
      } else if (phase === 'idle' || phase === 'available' || phase === 'error') {
        // Not awaited: the download takes minutes, and its progress comes back as state while the banner's other actions stay usable.
        actions.push({ label: 'Update', run: () => { void bridge()?.download(); } });
      }
    }
    if (state.method === 'download' || phase === 'error') actions.push({ label: 'Download', run: () => open(DOWNLOAD_PAGE) });
    actions.push(
      { label: "What's new", run: () => open(releaseNotes(latest)) },
      { label: 'Later', run: () => { later = latest; sync(); } },
    );
    show({
      id: 'update.available',
      tone: 'info',
      title: `Ordewell ${latest} is available. You have ${state.current}.`,
      ...words(state, latest),
      actions,
    });
  };

  const sync = (): void => {
    banners();
    for (const listener of listeners) listener();
  };

  const apply = (next: UpdateState): void => {
    state = next;
    sync();
  };

  const result = (banner: Omit<Banner, 'id' | 'actions'>): void => {
    show({ ...banner, id: 'update.result', actions: [{ label: 'OK', run: () => hide('update.result') }] });
  };

  const outcome = async (found: UpdateCheckOutcome): Promise<void> => {
    switch (found.kind) {
      case 'available': {
        // Asked for, so it is shown again even after Later; main's state may still be on its way.
        later = undefined;
        const fresh = await bridge()?.state();
        if (fresh) apply(fresh);
        else sync();
        return;
      }
      case 'up-to-date':
        result({ tone: 'info', title: "You're up to date", ...(state ? { body: `Ordewell ${state.current} is the latest version.` } : {}) });
        return;
      case 'off':
        result({
          tone: 'info',
          title: 'Checking for new versions is off',
          body: found.reason === 'setting'
            ? `Turn it on in ${SWITCH}.`
            : 'ORDEWELL_NO_VERSION_CHECK or DO_NOT_TRACK is set in the environment this app started in.',
        });
        return;
      case 'failed':
        result({ tone: 'error', title: "Couldn't check for updates", body: found.message });
        return;
    }
  };

  const Indicator = (): JSX.Element | null => {
    const now = useSyncExternalStore(
      (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
      () => state,
    );
    const latest = now?.latest;
    if (now === undefined || latest === undefined) return null;
    return (
      <button
        type="button"
        className="frame-status-update"
        aria-label={`Ordewell ${latest} is available`}
        title="Show the update"
        onClick={() => { later = undefined; sync(); }}
      >
        {indicatorText(now, latest)}
      </button>
    );
  };

  const offSlot = api.registerSlot({ slot: 'status.update', id: 'update', render: () => <Indicator /> });
  const offCommand = api.registerCommand({
    id: 'update.check',
    title: 'Check for updates…',
    more: true,
    run: () => {
      const update = bridge();
      if (!update) return;
      hide('update.result');
      api.announce('Checking for updates…');
      void update.check().then(outcome, (error: unknown) => outcome({ kind: 'failed', message: error instanceof Error ? error.message : String(error) }));
    },
  });

  const offChange = bridge()?.onChange(apply);
  void bridge()?.state().then((first) => { if (state === undefined) apply(first); });

  return () => {
    offChange?.();
    offSlot();
    offCommand();
    for (const id of [...shown.keys()]) hide(id);
  };
}
