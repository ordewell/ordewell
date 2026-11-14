import { existsSync } from 'fs';
import * as path from 'path';
import type { SystemPart } from '../../model';
import { instructionsBlock } from '../repoConfig';
import { ORDEWELL_REPO_CONFIG } from './repoConfig';

export interface PromptContext {
  cwd: string;
  /** The task lands as a commit, so its handoff carries the message (ADR-0047). */
  commits: boolean;
  platform?: NodeJS.Platform;
  now?: Date;
}

/**
 * The attempt's system prompt: short and provider-neutral, since one prompt
 * serves every model the runner offers. It is built once per attempt and kept
 * in the transcript, so every step, and a resume, sends the same prefix and a
 * provider's prompt cache holds. The task's own brief and the earlier tasks'
 * handoffs are the first user message, which StructuredSession writes.
 */
export function buildSystemPrompt(context: PromptContext): SystemPart[] {
  const parts: SystemPart[] = [{ text: [ROLE, completion(context.commits)].join('\n\n') }, { text: environmentBlock(context) }];
  const instructions = instructionsBlock(ORDEWELL_REPO_CONFIG.instructions(context.cwd), 'as this task');
  if (instructions) parts.push({ text: instructions });
  // The breakpoint sits on the last fixed part: everything up to it is the same on every step.
  parts[parts.length - 1] = { ...parts[parts.length - 1], cacheBreakpoint: true };
  return parts;
}

const ROLE = [
  'You are Ordewell\'s coding agent. You work on one task of a larger plan, in its own git worktree, which is your working directory. Other tasks run in their own worktrees; only your worktree is yours to change.',
  'Work with the tools you are given: read and search before you change, keep edits to what the task asks, and run the project\'s checks on what you changed. Paths are relative to the worktree.',
  'Earlier tasks\' handoffs are in the task message. Where it says to pull more with `read`, use `read_task`: here `read` reads files.',
].join('\n');

function completion(commits: boolean): string {
  const lines = [
    'The task ends only when you call `task_complete`, once, as your last action:',
    '- `status` is `done` when the task is fully complete, otherwise `blocked` or `failed` with a `reason`;',
    '- `summary` is the handoff the next task reads first: what changed, the interfaces and paths it relies on, and what is left;',
    '- `findings` lists what the next reader must act on, most important first.',
  ];
  if (commits) lines.push('This task lands as a commit: with `done`, also give `commit`, a one-line imperative `subject` and a short `body` on why, as the task message says.');
  lines.push('Ending your reply without calling `task_complete` leaves the task unfinished.');
  return lines.join('\n');
}

function environmentBlock(context: PromptContext): string {
  const now = context.now ?? new Date();
  return [
    '<environment>',
    `Working directory: ${context.cwd}`,
    `Platform: ${context.platform ?? process.platform}`,
    `Date: ${now.toISOString().slice(0, 10)}`,
    // A worktree's `.git` is a file, a checkout's a directory: either is a repository.
    `Git repository: ${existsSync(path.join(context.cwd, '.git')) ? 'yes' : 'no'}`,
    '</environment>',
  ].join('\n');
}
