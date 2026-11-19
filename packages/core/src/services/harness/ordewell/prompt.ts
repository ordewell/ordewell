import { existsSync } from 'fs';
import * as path from 'path';
import { taskCompletionContract } from '../../mcp';
import { HANDOFF_LIMITS } from '../../../models/Handoff';
import type { SystemPart } from '../../model';
import { instructionsBlock } from '../repoConfig';
import { ORDEWELL_REPO_CONFIG } from './repoConfig';

export interface PromptContext {
  cwd: string;
  /** The task lands as a commit, so its handoff carries the message (ADR-0047). */
  commits: boolean;
  /** Model calls the attempt may make: a fixed number, so the prompt stays one cached prefix. */
  stepLimit: number;
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
  const text = [ROLE, working(context), completion(context.commits)].join('\n\n');
  const parts: SystemPart[] = [{ text }, { text: environmentBlock(context) }];
  const instructions = instructionsBlock(ORDEWELL_REPO_CONFIG.instructions(context.cwd), 'as this task');
  if (instructions) parts.push({ text: instructions });
  // The breakpoint sits on the last fixed part: everything up to it is the same on every step.
  parts[parts.length - 1] = { ...parts[parts.length - 1], cacheBreakpoint: true };
  return parts;
}

const ROLE = [
  'You are Ordewell\'s coding agent. You work on one task of a larger plan, in its own git worktree, which is your working directory. Other tasks run in their own worktrees; only your worktree is yours to change.',
  'Work with the tools you are given: read and search before you change, keep edits to what the task asks, and run the project\'s checks on what you changed. Paths are relative to the worktree.',
  'Earlier tasks\' handoffs are in the task message. Where it or these instructions say to pull more with `read`, use `read_task`: here `read` reads files.',
].join('\n');

/**
 * How a long task is carried through. A model that reads its brief as too large
 * for one session reports `blocked` with the work half done and nothing
 * committed, though nothing outside it stopped it: each rule says why it holds.
 */
function working(context: PromptContext): string {
  const lines = [
    'How to work through the brief:',
    '- Work through the brief in order. How much work remains is never a reason to stop or to report `blocked`: a large brief is done one part at a time.',
    `- Your context is compacted for you as it fills, so a long task does not run out of room. You have a budget of ${context.stepLimit} model calls for this attempt; the runner counts them and tells you the exact count at fixed points. Until told otherwise you have calls left: never estimate the count yourself. The last call is kept for \`task_complete\`.`,
  ];
  if (context.commits) lines.push('- Commit each coherent part as it works: an attempt can end at any time, and work that is not committed is not its result.');
  lines.push(
    '- `blocked` is for an obstacle outside your control that you cannot work around: a missing credential, a contradiction in the brief, an environment you cannot repair. Then say exactly what is missing, so someone can supply it.',
    `- When you are told the budget is nearly spent with part of the brief working, ${context.commits ? 'commit that part and ' : ''}report honestly what is done and what remains. Never report \`done\` for a brief whose done criterion does not hold: the tasks after yours build on a \`done\` task as finished.`,
  );
  return lines.join('\n');
}

/**
 * Every runner's completion contract (ADR-0047), the one text the other
 * adapters append to their runner's instructions, then what is the built-in
 * runner's own: the summary limit on one line, since a refused report costs a
 * model call, and that a reply alone ends nothing.
 */
function completion(commits: boolean): string {
  return [
    taskCompletionContract(commits ? { commits: true } : {}),
    `Keep \`summary\` to at most ${HANDOFF_LIMITS.summary} characters, or the call is refused and costs a model call: what the next reader must act on goes in \`findings\`, the long form in \`report\`.`,
    'Ending your reply without calling `task_complete` leaves the task unfinished.',
  ].join('\n\n');
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
