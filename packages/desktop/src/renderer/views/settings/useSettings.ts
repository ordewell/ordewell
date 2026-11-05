import { useCallback, useEffect, useState } from 'react';
import type { GlobalRunSettings, ModelsResponse, RunnersResponse, SettingsResponse, SettingsUpdateResponse } from '@ordewell/core';
import type { Prefs } from '../../../shared/bridge';
import type { RouteParams } from '../../../shared/routes';
import type { DaemonHost } from '../../session/DaemonHost';
import { onThemePref, setThemePref, type ThemePref } from '../../frame/themePref';
import { callDaemon, messageOf } from '../../session/daemon';

export type RunnerSetting = RunnersResponse['runners'][number];

export interface SettingsView {
  loading: boolean;
  error: string | undefined;
  busy: boolean;
  settings: SettingsResponse | undefined;
  runners: readonly RunnerSetting[];
  models: ModelsResponse | undefined;
  prefs: Prefs | undefined;
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
 */
export function useSettings(host: DaemonHost, sessionId: string): {
  view: SettingsView;
  refresh(): Promise<void>;
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
  });

  const sessionParam = useCallback((): RouteParams => (sessionId ? { sessionId } : {}), [sessionId]);

  const refresh = useCallback(async (): Promise<void> => {
    setView((current) => ({ ...current, loading: true, error: undefined }));
    try {
      const settings = await callDaemon('settings.get', { workspace: host.workspace, ...sessionParam() }) as SettingsResponse;
      const runners = await callDaemon('runners.list', { workspace: host.workspace }) as RunnersResponse;
      const models = await callDaemon('models.list', { workspace: host.workspace }) as ModelsResponse;
      const prefs = await window.ordewell.prefs?.get() ?? EMPTY_PREFS;
      setView({ loading: false, error: undefined, busy: false, settings, runners: runners.runners ?? [], models, prefs });
    } catch (error) {
      setView((current) => ({ ...current, loading: false, error: messageOf(error) }));
    }
  }, [host.workspace, sessionParam]);

  useEffect(() => { void refresh(); }, [refresh]);
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
      const runners = await callDaemon('runners.list', { workspace: host.workspace }) as RunnersResponse;
      setView((current) => ({ ...current, busy: false, runners: runners.runners ?? [] }));
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

  return { view, refresh, update, updateRun, setRunner, savePref, setTheme };
}
