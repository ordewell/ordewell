import type { Prefs } from '../shared/bridge';
import { readJsonFile, writeJsonFile } from './jsonFile';

export const DEFAULT_PREFS: Prefs = { theme: 'system' };

const THEMES: ReadonlySet<string> = new Set(['system', 'light', 'dark']);

/** A key and value as a renderer sent them, checked before anything is written. */
export function validPref(key: unknown, value: unknown): Partial<Prefs> | undefined {
  if (key === 'theme' && typeof value === 'string' && THEMES.has(value)) return { theme: value as Prefs['theme'] };
  return undefined;
}

/** The app's own preferences. Settings that change how a run behaves are the daemon's, never kept here. */
export class PrefsStore {
  constructor(private readonly file: string) {}

  get(): Prefs {
    const stored = readJsonFile(this.file);
    const prefs: Prefs = { ...DEFAULT_PREFS };
    if (typeof stored === 'object' && stored !== null) {
      for (const [key, value] of Object.entries(stored)) Object.assign(prefs, validPref(key, value));
    }
    return prefs;
  }

  set(change: Partial<Prefs>): Prefs {
    const next = { ...this.get(), ...change };
    writeJsonFile(this.file, next);
    return next;
  }
}
