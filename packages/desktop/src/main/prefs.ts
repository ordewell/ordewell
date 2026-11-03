import type { PaneSizes, Prefs } from '../shared/bridge';
import { readJsonFile, writeJsonFile } from './jsonFile';

export const DEFAULT_PREFS: Prefs = {
  theme: 'system',
  panes: { sidebar: 260, right: 360, bottom: 240 },
  notifications: true,
  keepRunningInTray: false,
  editorCommand: '',
};

const THEMES: ReadonlySet<string> = new Set(['system', 'light', 'dark']);

/** Past this a pane is not a size anyone dragged to: a corrupt or hostile file. */
const MAX_PANE = 4000;

function paneSizes(value: unknown): PaneSizes | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const sizes: Partial<PaneSizes> = {};
  for (const key of ['sidebar', 'right', 'bottom'] as const) {
    const size: unknown = (value as Record<string, unknown>)[key];
    if (typeof size !== 'number' || !Number.isFinite(size) || size < 0 || size > MAX_PANE) return undefined;
    sizes[key] = Math.round(size);
  }
  return sizes as PaneSizes;
}

/** `editorCommand` is deliberately not here: it is a program to run, so only the user's own file sets it. */
const FILE_ONLY: ReadonlySet<string> = new Set(['editorCommand']);

/** A key and value as a renderer sent them, checked before anything is written. */
export function validPref(key: unknown, value: unknown): Partial<Prefs> | undefined {
  if (key === 'theme' && typeof value === 'string' && THEMES.has(value)) return { theme: value as Prefs['theme'] };
  if (key === 'notifications' && typeof value === 'boolean') return { notifications: value };
  if (key === 'keepRunningInTray' && typeof value === 'boolean') return { keepRunningInTray: value };
  if (key === 'panes') {
    const panes = paneSizes(value);
    return panes ? { panes } : undefined;
  }
  return undefined;
}

/** The app's own preferences. Settings that change how a run behaves are the daemon's, never kept here. */
export class PrefsStore {
  constructor(private readonly file: string) {}

  get(): Prefs {
    const stored = readJsonFile(this.file);
    const prefs: Prefs = { ...DEFAULT_PREFS };
    if (typeof stored === 'object' && stored !== null) {
      for (const [key, value] of Object.entries(stored)) {
        Object.assign(prefs, validPref(key, value));
        if (FILE_ONLY.has(key) && typeof value === 'string' && value.length <= 500) Object.assign(prefs, { [key]: value });
      }
    }
    return prefs;
  }

  set(change: Partial<Prefs>): Prefs {
    const next = { ...this.get(), ...change };
    writeJsonFile(this.file, next);
    return next;
  }
}
