import { execFileSync } from 'child_process';
import * as path from 'path';
import { flattenTasks, skillNames, type Task, type TaskSkillSnapshot } from '../models/Task';
import { skillsDirOf, workspaceSkillRoots, type SkillInfo, type SkillsService } from './SkillsService';
import type { TaskOp } from './TaskOps';
import type { IsolatedExecution } from './plannerModes';
import { cleanEnv } from './gitExec';
import { quotedList } from '../utils/quotedList';

/**
 * Task skills end to end (ADR-0024): a skill reaches a runner only by being
 * attached to its task in the plan, and Ordewell puts its body in the task's
 * prompt — so it works the same on every runner, and nothing is written to a
 * harness's own skills directory.
 */

/** Where a task's skill names are looked up: global first, then the workspace folders it reads. */
export interface SkillLookup extends Pick<SkillsService, 'findSkill' | 'searchedDirs'> {
  /**
   * Set when tasks get worktrees: for a workspace skill git will not carry
   * into them, the folder to commit, relative to the workspace root.
   */
  uncommitted?(skill: SkillInfo): string | undefined;
}

/** What a plan's attached skills come to against the catalog its tasks will see. */
export interface SkillCheck {
  /** Names that can never be a task skill: they resolve to a planner skill. */
  errors: { taskId?: string; message: string }[];
  /** Names not found yet — an earlier task may create them in its worktree — or found only in a file no worktree will get. */
  warnings: string[];
}

function plannerSkillMessage(owner: string, skill: SkillInfo): string {
  return `${owner}: "${skill.name}" is a planner skill (applies-to: planner, ${skill.path}). Only skills with applies-to: task can be attached to a task.`;
}

function notFoundWarning(owner: string, name: string): string {
  return `${owner}: skill "${name}" not found; it must exist in the task's worktree (.ordewell/skills/${name}/SKILL.md) or in ~/.ordewell/skills/ when the task starts, or the task fails.`;
}

function uncommittedWarning(owner: string, name: string, folder: string): string {
  return `${owner}: skill "${name}" is not committed; commit ${folder} so task worktrees receive it.`;
}

function check(entries: { taskId?: string; owner: string; names: string[] }[], lookup: SkillLookup): SkillCheck {
  const result: SkillCheck = { errors: [], warnings: [] };
  for (const { taskId, owner, names } of entries) {
    for (const name of names) {
      const skill = lookup.findSkill(name);
      if (!skill) {
        result.warnings.push(notFoundWarning(owner, name));
        continue;
      }
      if (skill.appliesTo !== 'task') {
        result.errors.push({ ...(taskId ? { taskId } : {}), message: plannerSkillMessage(owner, skill) });
        continue;
      }
      const folder = lookup.uncommitted?.(skill);
      if (folder) result.warnings.push(uncommittedWarning(owner, name, folder));
    }
  }
  return result;
}

/** Whether HEAD holds the file; null when git cannot say (no git, no repository, no commit yet). */
function committedInHead(file: string): boolean | null {
  try {
    // ls-tree, not ls-files: a staged file is tracked, but a worktree is made from a commit.
    const out = execFileSync('git', ['ls-tree', '--name-only', 'HEAD', '--', path.basename(file)], {
      cwd: path.dirname(file), env: cleanEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000, windowsHide: true,
    });
    return out.trim() !== '';
  } catch {
    return null;
  }
}

/**
 * The lookup a plan's names are checked with before it runs: the folders its
 * tasks will read at spawn, under the layout the planner was told (ADR-0014),
 * and — when tasks get worktrees — which workspace skills git will not carry
 * into them. A repo group's own folder is read from the main checkout at
 * spawn too, so it never needs committing.
 */
export function plannedSkillLookup(
  skillsAt: (roots: readonly string[]) => SkillLookup,
  workspaceRoot: string,
  layout: IsolatedExecution,
): SkillLookup {
  const roots = workspaceSkillRoots(workspaceRoot, layout ? layout.repos : []);
  const lookup = skillsAt(roots);
  if (!layout) return lookup;
  const readInPlace = roots.length > 1 ? skillsDirOf(workspaceRoot) : null;
  return {
    findSkill: (name) => lookup.findSkill(name),
    searchedDirs: () => lookup.searchedDirs(),
    uncommitted: (skill) => {
      if (skill.source !== 'workspace') return undefined;
      const folder = path.dirname(skill.path);
      if (readInPlace && path.dirname(folder) === readInPlace) return undefined;
      return committedInHead(skill.path) === false ? path.relative(workspaceRoot, folder).split(path.sep).join('/') : undefined;
    },
  };
}

/**
 * A submitted plan's skills, checked leniently: a name missing now may be
 * created by a task the attaching one depends on, so it is only a warning; a
 * planner skill is never right on a task, so it is refused.
 */
export function checkPlanSkills(tasks: readonly Task[], lookup: SkillLookup): SkillCheck {
  return check(
    flattenTasks(tasks).map((t) => ({ taskId: t.id, owner: `Task "${t.title}"`, names: t.skills ?? [] })),
    lookup,
  );
}

/** The skill names an edit batch attaches, by op, held to the same rule as a submitted plan. */
export function checkOpSkills(ops: readonly TaskOp[], lookup: SkillLookup): SkillCheck {
  const entries: { owner: string; names: string[] }[] = [];
  ops.forEach((op, i) => {
    const owner = `op ${i + 1} (${op.op})`;
    const add = (spec: Partial<Task> | undefined) => {
      const names = skillNames(spec?.skills);
      if (names) entries.push({ owner, names });
    };
    switch (op.op) {
      case 'update':
      case 'rearm':
        add(op.changes);
        break;
      case 'add':
        add(op.task);
        break;
      case 'merge':
        add(op.merged);
        break;
      case 'split':
        (Array.isArray(op.parts) ? op.parts : []).forEach(add);
        break;
      default:
        break;
    }
  });
  return check(entries, lookup);
}

/** Why a task cannot start with the skills it names; the runner is never spawned without them. */
export class TaskSkillsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TaskSkillsError';
  }
}

/**
 * Resolve a task's skills where it runs — its worktree's committed
 * `.ordewell/skills/` plus global — as the snapshot its attempt is given.
 * Throws {@link TaskSkillsError} naming every name that does not resolve to a
 * task skill and the directories searched.
 */
export function resolveTaskSkills(task: Pick<Task, 'title' | 'skills'>, lookup: SkillLookup): TaskSkillSnapshot[] {
  const missing: string[] = [];
  const planner: SkillInfo[] = [];
  const resolved: TaskSkillSnapshot[] = [];
  for (const name of task.skills ?? []) {
    const skill = lookup.findSkill(name);
    if (!skill) missing.push(name);
    else if (skill.appliesTo !== 'task') planner.push(skill);
    else resolved.push({ name: skill.name, source: skill.source, path: skill.path, content: skill.content });
  }
  const problems: string[] = [];
  if (missing.length > 0) {
    problems.push(
      `${missing.length === 1 ? 'skill' : 'skills'} ${quotedList(missing)} not found in ${lookup.searchedDirs().join(' or ')}`
      + ` (a workspace skill reaches a task's worktree only once committed: commit ${missing.length === 1 ? `.ordewell/skills/${missing[0]}` : 'its .ordewell/skills/ folder'} so task worktrees receive it)`,
    );
  }
  for (const skill of planner) problems.push(`"${skill.name}" is a planner skill (applies-to: planner, ${skill.path}), not a task skill`);
  if (problems.length > 0) throw new TaskSkillsError(`Task "${task.title}" did not start: ${problems.join('; ')}.`);
  return resolved;
}

/** The skills' bodies as the task prompt carries them, each framed with its name. */
export function renderTaskSkills(skills: readonly TaskSkillSnapshot[]): string {
  if (skills.length === 0) return '';
  const blocks = skills.map((s) => `### Skill: ${s.name}\n\n${s.content.trim()}`);
  return [
    '## Task skills',
    '',
    'This task comes with the skills below. Follow them while you work on it.',
    '',
    blocks.join('\n\n'),
  ].join('\n');
}
