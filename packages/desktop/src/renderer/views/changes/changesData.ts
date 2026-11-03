import { filesApi } from '../../files/api';
import type { ViewScope } from '../../frame/api';
import { callDaemon, messageOf } from '../../session/daemon';
import {
  changeLetter, diffSides, parsePatch, parseTaskDiffList, taskFilePatch,
  type ChangedFile, type DiffSides, type FilePatch,
} from './changesModel';

/*
 * The Changes view's reads of the daemon (ADR-0061 R5, ADR-0062): which
 * files a task or the whole run changed, and one file's two sides. Every
 * answer is checked here, so the views draw only what parsed.
 */

/** A scope the Changes view reviews: never the checkout, whose changes are the checkout group's. */
export type ReviewScope = Exclude<ViewScope, { kind: 'checkout' }>;

export type FileList =
  | { ok: true; files: ChangedFile[]; note?: string }
  | { ok: false; error: string };

interface DiffFiles {
  files: ChangedFile[];
  patch?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function count(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}

function parseGitDiff(data: unknown, repo: string): DiffFiles | undefined {
  if (!isRecord(data) || !Array.isArray(data.files)) return undefined;
  const files: ChangedFile[] = [];
  for (const raw of data.files) {
    if (!isRecord(raw) || typeof raw.path !== 'string' || typeof raw.status !== 'string') return undefined;
    const status = changeLetter(raw.status);
    files.push({ repo, path: raw.path, added: count(raw.added), removed: count(raw.removed), ...(status ? { status } : {}) });
  }
  return { files, ...(typeof data.patch === 'string' ? { patch: data.patch } : {}) };
}

function scopeParams(scope: ReviewScope): Record<string, string> {
  return scope.kind === 'task'
    ? { scope: 'task', sessionId: scope.sessionId, taskId: scope.taskId }
    : { scope: 'integration', sessionId: scope.sessionId };
}

/** `git diff` of a scope against the base it started from: for a task, its worktree as it is now. */
async function gitDiff(workspace: string, repo: string, scope: ReviewScope, path?: string): Promise<DiffFiles> {
  const data = await callDaemon('git.diff', { workspace, repo, ...scopeParams(scope), ...(path !== undefined ? { path } : {}) });
  const parsed = parseGitDiff(data, repo);
  if (!parsed) throw new Error('The daemon sent a diff this app cannot read.');
  return parsed;
}

type TaskDiffText = { available: true; text: string } | { available: false; reason: string };

function parseTaskDiff(data: unknown): TaskDiffText | undefined {
  if (!isRecord(data)) return undefined;
  if (data.available === true && typeof data.text === 'string') return { available: true, text: data.text };
  if (data.available === false && typeof data.reason === 'string') return { available: false, reason: data.reason };
  return undefined;
}

async function taskDiff(workspace: string, sessionId: string, taskId: string, file?: { repo: string; path: string }): Promise<TaskDiffText> {
  const parsed = parseTaskDiff(await callDaemon('plans.taskDiff', { sessionId, taskId, workspace, ...(file ?? {}) }));
  if (!parsed) throw new Error('The daemon sent a task diff this app cannot read.');
  return parsed;
}

/**
 * The files a task changed, read from the saved run as task_diff reads them
 * for an agent, so a merged task or one whose worktree is gone still lists
 * its work (ADR-0050). The task diff counts lines but names no kind of
 * change, so the letters come from git's own diff of the worktree where there
 * still is one: a file it does not list is one git does not track yet.
 */
export async function readTaskFiles(workspace: string, sessionId: string, taskId: string): Promise<FileList> {
  try {
    const answer = await taskDiff(workspace, sessionId, taskId);
    if (!answer.available) return { ok: false, error: answer.reason };
    const list = parseTaskDiffList(answer.text);
    if (list.savedPatch) return { ok: true, files: list.files, note: list.savedPatch };
    const letters = new Map<string, ChangedFile['status']>();
    for (const repo of new Set(list.files.map((f) => f.repo))) {
      try {
        const diff = await gitDiff(workspace, repo, { kind: 'task', sessionId, taskId });
        for (const file of list.files.filter((f) => f.repo === repo)) letters.set(`${repo}\0${file.path}`, 'A');
        for (const file of diff.files) letters.set(`${repo}\0${file.path}`, file.status);
      } catch {
        // No worktree to ask: the counts stand alone.
      }
    }
    return {
      ok: true,
      files: list.files.map((file) => {
        const status = letters.get(`${file.repo}\0${file.path}`);
        return status ? { ...file, status } : file;
      }),
    };
  } catch (error) {
    return { ok: false, error: messageOf(error) };
  }
}

/** The whole run against its base: each repository's integration branch as it stands. */
export async function readRunFiles(workspace: string, sessionId: string, repos: readonly string[]): Promise<FileList> {
  try {
    const files: ChangedFile[] = [];
    for (const repo of repos) files.push(...(await gitDiff(workspace, repo, { kind: 'integration', sessionId })).files);
    return { ok: true, files };
  } catch (error) {
    return { ok: false, error: messageOf(error) };
  }
}

export type FileDiff =
  | { kind: 'text'; sides: DiffSides; patch: FilePatch }
  | { kind: 'binary' }
  | { kind: 'unchanged' }
  | { kind: 'error'; message: string };

/**
 * One file's change in a scope, as the diff tab draws it. The patch is the
 * daemon's; the after side is the file as the scope holds it now, and the
 * before side is that with the patch undone. Where the after side cannot be
 * read (a merged task's worktree is gone) the tab draws the hunks alone.
 */
export async function readFileDiff(workspace: string, scope: ReviewScope, repo: string, path: string): Promise<FileDiff> {
  try {
    let text: string;
    if (scope.kind === 'task') {
      const answer = await taskDiff(workspace, scope.sessionId, scope.taskId, { repo, path });
      if (!answer.available) return { kind: 'error', message: answer.reason };
      text = taskFilePatch(answer.text);
    } else {
      text = (await gitDiff(workspace, repo, scope, path)).patch ?? '';
    }
    const patch = parsePatch(text);
    if (patch.binary) return { kind: 'binary' };
    if (patch.hunks.length === 0) return { kind: 'unchanged' };
    let after: string | undefined;
    if (patch.deleted) after = '';
    else {
      try {
        const content = await filesApi.content({ workspace, repo, scope }, path);
        if (content.kind === 'text') after = content.text;
      } catch {
        // The hunks alone, below.
      }
    }
    return { kind: 'text', sides: diffSides(patch, after), patch };
  } catch (error) {
    return { kind: 'error', message: messageOf(error) };
  }
}

/** Sends a line comment to a task as the person's own message (`message_task`): it reaches the agent at its next turn. */
export async function messageTask(sessionId: string, taskId: string, text: string): Promise<void> {
  await callDaemon('plans.executeCommand', { sessionId }, { command: 'message_task', task: taskId, text });
}
