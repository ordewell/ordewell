import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  GlobalRunSettings, ModelsResponse, RunnersResponse, SettingsResponse, SettingsUpdateResponse,
} from '@ordewell/core';
import { RUNNER_IDS, RUNNER_LABELS } from '@ordewell/core/plan-utils';
import type { PlannerBackend } from '@ordewell/ui/protocol';
import type { Prefs } from '../../../shared/bridge';
import type { RouteParams } from '../../../shared/routes';
import type { DaemonHost } from '../../session/DaemonHost';
import { onThemePref, setThemePref, type ThemePref } from '../../frame/themePref';
import { plannerBackendsFor } from '../../session/plannerBackends';
import { callDaemon, messageOf } from '../../session/daemon';

export type RunnerSetting = RunnersResponse['runners'][number];

/** One row in Settings, whether or not this machine has the runner. */
export interface RunnerRow {
  id: string;
  name: string;
  enabled: boolean;
  /** The daemon found the binary: a missing one is listed with why, never toggleable. */
  installed: boolean;
  auth?: RunnerSetting['auth'];
  /** Why it cannot be used, as core's planner list words it; absent when it can. */
  reason?: string;
}

/** Long enough for the daemon to probe eight agents and their catalogs on a loaded machine (the Welcome's bound is 15 s, the chat's 20 s). */
export const SETTINGS_TIMEOUT_MS = 15_000;

/** A window focus often follows another within a moment; one re-read per this long is enough. */
export const FOCUS_REFRESH_MS = 5_000;

function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`the daemon did not answer with ${what} within ${Math.round(ms / 1000)} seconds`)), ms);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

/** Every runner with a row: core's eight first, then one a workspace's manifest adds. */
export function runnerRowsFor(
  runners: readonly RunnerSetting[],
  backends: readonly PlannerBackend[],
): RunnerRow[] {
  const installed = new Map(runners.map((runner) => [runner.id, runner]));
  const rows = RUNNER_IDS.map((id): RunnerRow => {
    const found = installed.get(id);
    const backend = backends.find((candidate) => candidate.runner === id || candidate.id === id);
    return {
      id,
      name: found?.name || backend?.label || RUNNER_LABELS[id] || id,
      enabled: found?.enabled ?? false,
      installed: found !== undefined,
      ...(found?.auth ? { auth: found.auth } : {}),
      ...(backend && !backend.usable ? { reason: backend.reason } : {}),
    };
  });
  for (const runner of runners) {
    if (RUNNER_IDS.includes(runner.id)) continue;
    rows.push({
      id: runner.id,
      name: runner.name || RUNNER_LABELS[runner.id] || runner.id,
      enabled: runner.enabled,
      installed: true,
      ...(runner.auth ? { auth: runner.auth } : {}),
    });
  }
  return rows;
}

export interface SettingsView {
  loading: boolean;
  error: string | undefined;
  busy: boolean;
  settings: SettingsResponse | undefined;
  runners: readonly RunnerSetting[];
  models: ModelsResponse | undefined;
  prefs: Prefs | undefined;
  /** The planner list the chat offers, from core's one list (ADR-0009). */
  backends: readonly PlannerBackend[];
}

const EMPTY_PREFS: Prefs = {
  theme: 'dark',
  layouts: {},
  notifications: true,
  keepRunningInTray: false,
  settingsAdvancedOpen: false,
  editorCommand: '',
};

/**
 * The settings the daemon's `SettingsService` exposes, over the routes that
 * already answer for them (GET/PATCH `/api/settings`, `/api/runners`), plus
 * the desktop's own preferences. Every write answers with the settings as they
 * now stand, so a refused change puts its old value back at once.
 *
 * A read is bounded, so a daemon that never answers ends in the error and
 * Retry state rather than "Loading settings…" for ever.
 */
export function useSettings(host: DaemonHost, sessionId: string): {
  view: SettingsView;
  refresh(): Promise<void>;
  rescan(): Promise<void>;
  update(body: Record<string, unknown>): Promise<void>;
  updateRun(change: Partial<GlobalRunSettings>): Promise<void>;
  setRunner(id: string, enabled: boolean): Promise<void>;
  savePref<K extends keyof Prefs>(key: K, value: Prefs[K]): Promise<void>;
  setTheme(theme: ThemePref): Promise<void>;
} {
  const [view, setView] = useState<SettingsView>({
    loading: true,
    error: undefined,
    busy: false,
    settings: undefined,
    runners: [],
    models: undefined,
    prefs: undefined,
    backends: [],
  });
  const lastFocusRefresh = useRef(0);

  const sessionParam = useCallback((): RouteParams => (sessionId ? { sessionId } : {}), [sessionId]);

  const read = useCallback(async (mode: 'load' | 'refresh' | 'quiet'): Promise<void> => {
    if (mode === 'load') setView((current) => ({ ...current, loading: true, error: undefined }));
    if (mode === 'refresh') setView((current) => ({ ...current, busy: true, error: undefined }));
    try {
      const [settings, runners, models, prefs] = await Promise.all([
        within(callDaemon('settings.get', { workspace: host.workspace, ...sessionParam() }) as Promise<SettingsResponse>, SETTINGS_TIMEOUT_MS, 'its settings'),
        within(callDaemon('runners.list', { workspace: host.workspace }) as Promise<RunnersResponse>, SETTINGS_TIMEOUT_MS, 'its coding agents'),
        within(callDaemon('models.list', { workspace: host.workspace }) as Promise<ModelsResponse>, SETTINGS_TIMEOUT_MS, 'its models'),
        within(window.ordewell.prefs?.get() ?? Promise.resolve(EMPTY_PREFS), SETTINGS_TIMEOUT_MS, 'its preferences'),
      ]);
      const list = runners.runners ?? [];
      setView({
        loading: false,
        error: undefined,
        busy: false,
        settings,
        runners: list,
        models,
        prefs,
        backends: plannerBackendsFor(list, models.providers ?? []),
      });
    } catch (error) {
      setView((current) => ({ ...current, loading: false, busy: false, error: messageOf(error) }));
    }
  }, [host.workspace, sessionParam]);

  const refresh = useCallback(() => read('load'), [read]);
  const rescan = useCallback(() => read('refresh'), [read]);

  useEffect(() => { void refresh(); }, [refresh]);
  // A sign-in or a saved key changed the daemon's catalog: re-read it without
  // blanking the page, so the row that asked shows the answer where it stands.
  useEffect(() => host.onCatalogChange(() => { void read('quiet'); }), [host, read]);
  // A window that comes back is the moment a CLI the user just installed (or
  // signed in to) should show. Throttled: alt-tabbing must not spawn eight
  // agents' status commands over and over.
  useEffect(() => {
    const onFocus = (): void => {
      const now = Date.now();
      if (now - lastFocusRefresh.current < FOCUS_REFRESH_MS) return;
      lastFocusRefresh.current = now;
      void rescan();
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [rescan]);
  // The palette can change the theme while this tab is open.
  useEffect(() => onThemePref((theme) => {
    setView((current) => (current.prefs ? { ...current, prefs: { ...current.prefs, theme } } : current));
  }), []);

  const update = useCallback(async (body: Record<string, unknown>): Promise<void> => {
    setView((current) => ({ ...current, busy: true, error: undefined }));
    try {
      const next = await callDaemon('settings.update', undefined, { ...body, workspace: host.workspace, ...sessionParam() }) as SettingsUpdateResponse;
      setView((current) => ({ ...current, busy: false, settings: next }));
    } catch (error) {
      setView((current) => ({ ...current, busy: false, error: messageOf(error) }));
    }
  }, [host.workspace, sessionParam]);

  const updateRun = useCallback(async (change: Partial<GlobalRunSettings>): Promise<void> => {
    await update({ run: change });
  }, [update]);

  const setRunner = useCallback(async (id: string, enabled: boolean): Promise<void> => {
    setView((current) => ({ ...current, busy: true, error: undefined }));
    try {
      await callDaemon('runners.setEnabled', { id }, { enabled });
      const runners = await within(callDaemon('runners.list', { workspace: host.workspace }) as Promise<RunnersResponse>, SETTINGS_TIMEOUT_MS, 'its coding agents');
      setView((current) => {
        const list = runners.runners ?? [];
        const backends = plannerBackendsFor(list, current.models?.providers ?? []);
        return { ...current, busy: false, runners: list, backends };
      });
    } catch (error) {
      setView((current) => ({ ...current, busy: false, error: messageOf(error) }));
    }
  }, [host.workspace]);

  const savePref = useCallback(async <K extends keyof Prefs>(key: K, value: Prefs[K]): Promise<void> => {
    try {
      const prefs = await window.ordewell.prefs?.set(key, value);
      if (prefs) setView((current) => ({ ...current, prefs }));
    } catch (error) {
      setView((current) => ({ ...current, error: messageOf(error) }));
    }
  }, []);

  const setTheme = useCallback(async (theme: ThemePref): Promise<void> => {
    try {
      await setThemePref(theme);
    } catch (error) {
      setView((current) => ({ ...current, error: messageOf(error) }));
    }
  }, []);

  return { view, refresh, rescan, update, updateRun, setRunner, savePref, setTheme };
}
