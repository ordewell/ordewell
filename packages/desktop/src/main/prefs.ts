import type { Prefs, SavedLayout } from '../shared/bridge';
import { readJsonFile, writeJsonFile } from './jsonFile';

export const DEFAULT_PREFS: Prefs = {
  /** Dark until the user chooses: VS Code opens dark, and "system" is a choice they make, not a default we assume. */
  theme: 'dark',
  layouts: {},
  notifications: true,
  keepRunningInTray: false,
  editorCommand: '',
};

const THEMES: ReadonlySet<string> = new Set(['system', 'light', 'dark']);

/** Past this a pane is not a size anyone dragged to: a corrupt or hostile file. */
const MAX_PANE = 4000;

/** Past this many workspaces the oldest layout is forgotten, so the file cannot grow without end. */
export const MAX_LAYOUTS = 50;

const MAX_PATH = 4096;

function savedLayout(value: unknown): SavedLayout | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const layout: SavedLayout = {};
  for (const key of ['sidebar', 'plan', 'terminal'] as const) {
    const size = record[key];
    if (size === undefined) continue;
    if (typeof size !== 'number' || !Number.isFinite(size) || size < 0 || size > MAX_PANE) return undefined;
    layout[key] = Math.round(size);
  }
  for (const key of ['sidebarOpen', 'planOpen', 'terminalOpen'] as const) {
    const open = record[key];
    if (open === undefined) continue;
    if (typeof open !== 'boolean') return undefined;
    layout[key] = open;
  }
  // The renderer checks the name against the activities it knows; here only its shape.
  if (typeof record.activity === 'string' && /^[a-z-]{1,32}$/.test(record.activity)) layout.activity = record.activity;
  return layout;
}

/** Each workspace's layout, keeping only well-formed entries; refused if none is. */
function layouts(value: unknown): Record<string, SavedLayout> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const entries = Object.entries(value);
  const kept: Record<string, SavedLayout> = {};
  for (const [workspace, raw] of entries) {
    // `__proto__` as a key would set the record's prototype, not an entry.
    const layout = workspace.length > 0 && workspace.length <= MAX_PATH && workspace !== '__proto__' ? savedLayout(raw) : undefined;
    if (layout) kept[workspace] = layout;
  }
  return Object.keys(kept).length > 0 || entries.length === 0 ? kept : undefined;
}

/** The stored layouts with `change` laid over them, the most recently set last, the oldest dropped past the cap. */
function mergeLayouts(stored: Record<string, SavedLayout>, change: Record<string, SavedLayout>): Record<string, SavedLayout> {
  const merged: Record<string, SavedLayout> = { ...stored };
  for (const [workspace, layout] of Object.entries(change)) {
    delete merged[workspace];
    merged[workspace] = layout;
  }
  const keys = Object.keys(merged);
  for (const workspace of keys.slice(0, Math.max(0, keys.length - MAX_LAYOUTS))) delete merged[workspace];
  return merged;
}

/** `editorCommand` is deliberately not here: it is a program to run, so only the user's own file sets it. */
const FILE_ONLY: ReadonlySet<string> = new Set(['editorCommand']);

/** A key and value as a renderer sent them, checked before anything is written. */
export function validPref(key: unknown, value: unknown): Partial<Prefs> | undefined {
  if (key === 'theme' && typeof value === 'string' && THEMES.has(value)) return { theme: value as Prefs['theme'] };
  if (key === 'notifications' && typeof value === 'boolean') return { notifications: value };
  if (key === 'keepRunningInTray' && typeof value === 'boolean') return { keepRunningInTray: value };
  if (key === 'layouts') {
    const valid = layouts(value);
    return valid ? { layouts: valid } : undefined;
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
    const current = this.get();
    const next = { ...current, ...change };
    if (change.layouts) next.layouts = mergeLayouts(current.layouts, change.layouts);
    writeJsonFile(this.file, next);
    return next;
  }
}
