import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, sep } from 'node:path';
import type { RecentGit, RecentSession, RecentWorkspace } from '../shared/bridge';
import { readJsonFile, writeJsonFile } from './jsonFile';

export const MAX_RECENTS = 10;

/** What a page may store about a workspace: bounded, so a compromised one cannot bloat the file. */
const MAX_ID = 200;
const MAX_GOAL = 500;
const MAX_STATUS = 32;
const MAX_TIME = 64;
const MAX_BRANCH = 255;

interface Entry {
  path: string;
  openedAt: string;
  git?: RecentGit;
  lastSession?: RecentSession;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max;
}

export function parseGit(value: unknown): RecentGit | undefined {
  if (!isRecord(value)) return undefined;
  if (value.kind === 'branch' && boundedString(value.name, MAX_BRANCH) && value.name !== '') return { kind: 'branch', name: value.name };
  if (value.kind === 'detached') return { kind: 'detached' };
  if (value.kind === 'repos' && typeof value.count === 'number' && Number.isInteger(value.count) && value.count >= 0 && value.count <= 10_000) {
    return { kind: 'repos', count: value.count };
  }
  if (value.kind === 'none') return { kind: 'none' };
  return undefined;
}

export function parseSession(value: unknown): RecentSession | undefined {
  if (!isRecord(value)) return undefined;
  const { id, goal, status, updatedAt } = value;
  if (!boundedString(id, MAX_ID) || id === '' || !boundedString(goal, MAX_GOAL)) return undefined;
  if (!boundedString(status, MAX_STATUS) || !boundedString(updatedAt, MAX_TIME)) return undefined;
  return { id, goal, status, updatedAt };
}

function parseEntries(value: unknown): Entry[] {
  if (!isRecord(value) || !Array.isArray(value.entries)) return [];
  const entries: Entry[] = [];
  for (const item of value.entries as unknown[]) {
    if (!isRecord(item)) continue;
    const { path, openedAt } = item;
    if (typeof path !== 'string' || path === '' || typeof openedAt !== 'string') continue;
    const git = parseGit(item.git);
    const lastSession = parseSession(item.lastSession);
    entries.push({ path, openedAt, ...(git ? { git } : {}), ...(lastSession ? { lastSession } : {}) });
  }
  return entries.slice(0, MAX_RECENTS);
}

/** The path as a person reads it: home as `~`. The renderer does not know home, so main says it. */
export function displayPath(path: string, home: string): string {
  if (home === '' || home === sep) return path;
  if (path === home) return '~';
  return path.startsWith(home + sep) ? `~${path.slice(home.length)}` : path;
}

/**
 * The welcome window's recent workspaces, newest first, kept in the app's own
 * userData rather than the daemon's: they are this app's history, and a
 * daemon serves other clients that never opened them. Each entry also keeps
 * the last branch and session the welcome window saw, so its card draws them
 * before the daemon answers (design W1, Loading).
 */
export class RecentsStore {
  constructor(
    private readonly file: string,
    private readonly exists: (path: string) => boolean = existsSync,
    private readonly now: () => Date = () => new Date(),
    private readonly home: string = homedir(),
  ) {}

  private readonly forgotten = new Map<string, { entry: Entry; index: number }>();

  list(): RecentWorkspace[] {
    return parseEntries(readJsonFile(this.file)).map((entry) => ({
      path: entry.path,
      name: basename(entry.path) || entry.path,
      displayPath: displayPath(entry.path, this.home),
      openedAt: entry.openedAt,
      missing: !this.exists(entry.path),
      ...(entry.git ? { git: entry.git } : {}),
      ...(entry.lastSession ? { lastSession: entry.lastSession } : {}),
    }));
  }

  touch(path: string): RecentWorkspace[] {
    const entries = parseEntries(readJsonFile(this.file));
    const previous = entries.find((entry) => entry.path === path);
    const rest = entries.filter((entry) => entry.path !== path);
    this.write([{ ...previous, path, openedAt: this.now().toISOString() }, ...rest]);
    return this.list();
  }

  forget(path: string): RecentWorkspace[] {
    const entries = parseEntries(readJsonFile(this.file));
    const index = entries.findIndex((entry) => entry.path === path);
    if (index >= 0) this.forgotten.set(path, { entry: entries[index], index });
    this.write(entries.filter((entry) => entry.path !== path));
    return this.list();
  }

  /**
   * Forget's Undo: the entry comes back in its old place with its old time, so
   * undoing does not reorder the list the way reopening would. Only what this
   * store forgot can come back, so Undo cannot add a folder the user never
   * chose.
   */
  unforget(path: string): RecentWorkspace[] {
    const forgotten = this.forgotten.get(path);
    if (!forgotten) return this.list();
    this.forgotten.delete(path);
    const entries = parseEntries(readJsonFile(this.file)).filter((entry) => entry.path !== path);
    entries.splice(Math.min(forgotten.index, entries.length), 0, forgotten.entry);
    this.write(entries);
    return this.list();
  }

  /**
   * What the welcome window learned from the daemon about a workspace already
   * in the list. A path that is not in it changes nothing: a page records
   * facts about what the user opened, never adds a folder.
   */
  remember(path: unknown, facts: unknown): boolean {
    if (typeof path !== 'string' || !isRecord(facts)) return false;
    const entries = parseEntries(readJsonFile(this.file));
    const entry = entries.find((item) => item.path === path);
    if (!entry) return false;
    const git = 'git' in facts ? parseGit(facts.git) : undefined;
    const lastSession = 'lastSession' in facts ? parseSession(facts.lastSession) : undefined;
    if (!git && !lastSession) return false;
    if (git) entry.git = git;
    if (lastSession) entry.lastSession = lastSession;
    this.write(entries);
    return true;
  }

  private write(entries: Entry[]): void {
    writeJsonFile(this.file, { version: 1, entries: entries.slice(0, MAX_RECENTS) });
  }
}
