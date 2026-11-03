import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import type { RecentWorkspace } from '../shared/bridge';
import { readJsonFile, writeJsonFile } from './jsonFile';

export const MAX_RECENTS = 10;

interface Entry {
  path: string;
  openedAt: string;
}

function parseEntries(value: unknown): Entry[] {
  if (typeof value !== 'object' || value === null || !('entries' in value) || !Array.isArray(value.entries)) return [];
  const entries: Entry[] = [];
  for (const item of value.entries as unknown[]) {
    if (typeof item !== 'object' || item === null) continue;
    const { path, openedAt } = item as Partial<Record<keyof Entry, unknown>>;
    if (typeof path === 'string' && path !== '' && typeof openedAt === 'string') entries.push({ path, openedAt });
  }
  return entries.slice(0, MAX_RECENTS);
}

/**
 * The welcome window's recent workspaces, newest first, kept in the app's own
 * userData rather than the daemon's: they are this app's history, and a
 * daemon serves other clients that never opened them.
 */
export class RecentsStore {
  constructor(
    private readonly file: string,
    private readonly exists: (path: string) => boolean = existsSync,
    private readonly now: () => Date = () => new Date(),
  ) {}

  list(): RecentWorkspace[] {
    return parseEntries(readJsonFile(this.file)).map((entry) => ({
      path: entry.path,
      name: basename(entry.path) || entry.path,
      openedAt: entry.openedAt,
      missing: !this.exists(entry.path),
    }));
  }

  touch(path: string): RecentWorkspace[] {
    const rest = parseEntries(readJsonFile(this.file)).filter((entry) => entry.path !== path);
    this.write([{ path, openedAt: this.now().toISOString() }, ...rest]);
    return this.list();
  }

  forget(path: string): RecentWorkspace[] {
    this.write(parseEntries(readJsonFile(this.file)).filter((entry) => entry.path !== path));
    return this.list();
  }

  private write(entries: Entry[]): void {
    writeJsonFile(this.file, { version: 1, entries: entries.slice(0, MAX_RECENTS) });
  }
}
