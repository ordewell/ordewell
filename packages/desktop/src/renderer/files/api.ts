import type { DaemonCallResult } from '../../shared/bridge';
import type { RouteId, RouteParams } from '../../shared/routes';
import type { ViewScope } from '../frame/layout';

/**
 * The renderer's client for the daemon's file and repository reads and the one
 * save (ADR-0061, ADR-0062 G10). Every call goes through the preload's
 * fixed-route `daemon.call`; this file only shapes the arguments and checks the
 * answers, since a page trusts nothing it did not parse.
 */

export type FileStatus = 'M' | 'A' | 'D' | '?' | 'U';

export interface TreeEntry {
  name: string;
  path: string;
  kind: 'file' | 'directory' | 'symlink' | 'repository';
  ignored: boolean;
  status?: FileStatus;
  taskId?: string;
}

export type FileContent =
  | { kind: 'text'; text: string; hash: string; size: number }
  | { kind: 'binary'; size: number }
  | { kind: 'too-large'; size: number; limit: number };

export interface FindMatch {
  path: string;
  line?: number;
  preview?: string;
}

export interface FindResult {
  matches: FindMatch[];
  truncated: boolean;
}

export interface RepoInfo {
  repo: string;
  branch: string | null;
  detached: boolean;
}

/** The refusals the Explorer words for the user (ADR-0061 R2, R3; ADR-0062 G10). */
export type FilesErrorCode = 'gone' | 'path_refused' | 'path_not_found' | 'stale' | 'not_checkout' | 'unreadable';

export class FilesError extends Error {
  constructor(message: string, readonly code?: FilesErrorCode, readonly status?: number) {
    super(message);
    this.name = 'FilesError';
  }
}

const KNOWN: ReadonlySet<string> = new Set(['gone', 'path_refused', 'path_not_found', 'stale', 'not_checkout']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A failed call as a FilesError: the daemon's own code and message when it sent them. */
function failure(result: Extract<DaemonCallResult, { ok: false }>): FilesError {
  const body = isRecord(result.data) ? result.data : {};
  const code = typeof body.code === 'string' && KNOWN.has(body.code) ? (body.code as FilesErrorCode) : undefined;
  const message = typeof body.error === 'string' ? body.error : result.error;
  return new FilesError(message, code, result.status);
}

async function call(route: RouteId, params: RouteParams, body?: unknown): Promise<unknown> {
  const result = await window.ordewell.daemon.call(route, params, body);
  if (!result.ok) throw failure(result);
  return result.data;
}

function unreadable(what: string): FilesError {
  return new FilesError(`The daemon sent ${what} this app cannot read.`, 'unreadable');
}

/** What a read names: the workspace, a repo of it, and a view scope. */
export interface ReadTarget {
  workspace: string;
  repo: string;
  scope: ViewScope;
}

function readParams(target: ReadTarget): Record<string, string> {
  const params: Record<string, string> = { workspace: target.workspace, repo: target.repo, scope: target.scope.kind };
  if (target.scope.kind !== 'checkout') params.sessionId = target.scope.sessionId;
  if (target.scope.kind === 'task') params.taskId = target.scope.taskId;
  return params;
}

const KINDS: ReadonlySet<string> = new Set(['file', 'directory', 'symlink', 'repository']);
const STATUSES: ReadonlySet<string> = new Set(['M', 'A', 'D', '?', 'U']);

export function parseTree(data: unknown): TreeEntry[] | undefined {
  if (!isRecord(data) || !Array.isArray(data.entries)) return undefined;
  const entries: TreeEntry[] = [];
  for (const raw of data.entries) {
    if (!isRecord(raw) || typeof raw.name !== 'string' || typeof raw.path !== 'string' || typeof raw.kind !== 'string' || !KINDS.has(raw.kind)) return undefined;
    entries.push({
      name: raw.name,
      path: raw.path,
      kind: raw.kind as TreeEntry['kind'],
      ignored: raw.ignored === true,
      ...(typeof raw.status === 'string' && STATUSES.has(raw.status) ? { status: raw.status as FileStatus } : {}),
      ...(typeof raw.taskId === 'string' ? { taskId: raw.taskId } : {}),
    });
  }
  return entries;
}

export function parseContent(data: unknown): FileContent | undefined {
  if (!isRecord(data) || typeof data.size !== 'number') return undefined;
  if (data.kind === 'text' && typeof data.text === 'string' && typeof data.hash === 'string') return { kind: 'text', text: data.text, hash: data.hash, size: data.size };
  if (data.kind === 'binary') return { kind: 'binary', size: data.size };
  if (data.kind === 'too-large' && typeof data.limit === 'number') return { kind: 'too-large', size: data.size, limit: data.limit };
  return undefined;
}

export function parseFind(data: unknown): FindResult | undefined {
  if (!isRecord(data) || !Array.isArray(data.matches)) return undefined;
  const matches: FindMatch[] = [];
  for (const raw of data.matches) {
    if (!isRecord(raw) || typeof raw.path !== 'string') return undefined;
    matches.push({
      path: raw.path,
      ...(typeof raw.line === 'number' ? { line: raw.line } : {}),
      ...(typeof raw.preview === 'string' ? { preview: raw.preview } : {}),
    });
  }
  return { matches, truncated: data.truncated === true };
}

export function parseRepos(data: unknown): RepoInfo[] | undefined {
  if (!isRecord(data) || !Array.isArray(data.repos)) return undefined;
  const repos: RepoInfo[] = [];
  for (const raw of data.repos) {
    if (!isRecord(raw) || typeof raw.repo !== 'string') return undefined;
    repos.push({ repo: raw.repo, branch: typeof raw.branch === 'string' ? raw.branch : null, detached: raw.detached === true });
  }
  return repos;
}

export const filesApi = {
  /** One directory's entries; `dir` `''` is the repo's root. */
  async tree(target: ReadTarget, dir: string): Promise<TreeEntry[]> {
    return parseTree(await call('files.tree', { ...readParams(target), dir })) ?? fail('a folder');
  },
  async content(target: ReadTarget, path: string): Promise<FileContent> {
    return parseContent(await call('files.content', { ...readParams(target), path })) ?? fail('a file');
  },
  /** Paths whose name holds `query`, or with `text` the lines that do. */
  async find(target: ReadTarget, query: string, options: { text?: boolean; limit?: number } = {}): Promise<FindResult> {
    const params: Record<string, string> = { ...readParams(target), query };
    if (options.text) params.text = '1';
    if (options.limit !== undefined) params.limit = String(options.limit);
    return parseFind(await call('files.find', params)) ?? fail('search results');
  },
  async repos(workspace: string): Promise<RepoInfo[]> {
    return parseRepos(await call('git.repos', { workspace })) ?? fail('the repositories');
  },
  /** Saves in the checkout only. `baseHash` is what the editor read, null for a file it created; a changed file answers `stale`. */
  async save(workspace: string, repo: string, path: string, text: string, baseHash: string | null): Promise<void> {
    await call('files.save', {}, { workspace, repo, path, text, baseHash });
  },
};

function fail(what: string): never {
  throw unreadable(what);
}

/** How the Explorer words a refusal, naming the code where the user can act on it. */
export function describeError(error: unknown): string {
  if (error instanceof FilesError) {
    switch (error.code) {
      case 'gone': return `${error.message} Showing your checkout instead.`;
      case 'path_refused': return 'Ordewell does not show that path.';
      case 'path_not_found': return 'That path is not in this scope.';
      case 'stale': return 'The file changed on disk since you opened it.';
      case 'not_checkout': return 'Only your checkout can be edited.';
      default: return error.message;
    }
  }
  return error instanceof Error ? error.message : String(error);
}
