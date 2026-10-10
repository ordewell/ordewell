import * as path from 'path';
import { flattenTasks, isSkillName, skillNames, type Task, type TaskSkillSnapshot } from '../models/Task';
import { skillsDirOf, workspaceSkillRoots, type SkillInfo, type SkillsService } from './SkillsService';
import type { TaskOp } from './TaskOps';
import { requestedSkills } from './PlanValidator';
import { cleanEnv, execFileWithTimeout } from './gitExec';
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
   * Set when tasks get worktrees: of `skills`, the workspace ones git will not
   * carry into them, each SKILL.md path mapped to the folder to commit,
   * relative to the workspace root.
   */
  uncommitted?(skills: readonly SkillInfo[]): Promise<Map<string, string>>;
}

/** A lookup that can also list what it finds: what the planner's catalogs and `/name` read. */
export type SkillCatalogLookup = SkillLookup & Pick<SkillsService, 'listSkills'>;

/**
 * Where a workspace's skills are read, known without asking git: the repos
 * of its group in layout order (`['.']` for one repository), and whether
 * tasks will get worktrees, which only a committed skill reaches.
 */
export interface SkillLayout {
  repos: readonly string[];
  worktrees: boolean;
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

function invalidNameWarning(owner: string, name: string): string {
  return `${owner}: "${name}" is not a valid skill name (lowercase letters, digits, "-" and "_", starting with a letter or digit), so it was not attached.`;
}

interface SkillEntry {
  taskId?: string;
  owner: string;
  names: string[];
  /** What was asked for but {@link skillNames} drops: never attached, so never silently. */
  dropped?: string[];
}

/** An attached list as it is stored, and the names in it no skill could have. */
function attached(value: unknown): Pick<SkillEntry, 'names' | 'dropped'> {
  const dropped = Array.isArray(value)
    ? value.filter((v): v is string => typeof v === 'string' && v.trim() !== '' && !isSkillName(v.trim().toLowerCase())).map((v) => v.trim())
    : [];
  return { names: skillNames(value) ?? [], dropped };
}

async function check(entries: SkillEntry[], lookup: SkillLookup): Promise<SkillCheck> {
  const errors: SkillCheck['errors'] = [];
  // Task skills hold their warning's place until one git call per repo says which are uncommitted.
  const warnings: (string | { owner: string; skill: SkillInfo })[] = [];
  for (const { taskId, owner, names, dropped } of entries) {
    for (const name of dropped ?? []) warnings.push(invalidNameWarning(owner, name));
    for (const name of names) {
      const skill = lookup.findSkill(name);
      if (!skill) warnings.push(notFoundWarning(owner, name));
      else if (skill.appliesTo !== 'task') errors.push({ ...(taskId ? { taskId } : {}), message: plannerSkillMessage(owner, skill) });
      else warnings.push({ owner, skill });
    }
  }
  const attached = warnings.flatMap((w) => (typeof w === 'string' ? [] : [w.skill]));
  const folders = attached.length > 0 && lookup.uncommitted ? await lookup.uncommitted(attached) : new Map<string, string>();
  return {
    errors,
    warnings: warnings.flatMap((w) => {
      if (typeof w === 'string') return [w];
      const folder = folders.get(w.skill.path);
      return folder ? [uncommittedWarning(w.owner, w.skill.name, folder)] : [];
    }),
  };
}

const runGit = execFileWithTimeout(10_000);

/**
 * Which of `files` HEAD holds, in one git call per skills folder (one per
 * repository); a file is absent when git cannot say (no git, no repository,
 * no commit yet).
 */
async function committedInHead(files: readonly string[]): Promise<Map<string, boolean>> {
  const byDir = new Map<string, string[]>();
  for (const file of new Set(files)) {
    const dir = path.dirname(path.dirname(file));
    byDir.set(dir, [...(byDir.get(dir) ?? []), file]);
  }
  const result = new Map<string, boolean>();
  await Promise.all([...byDir].map(async ([dir, inDir]) => {
    const relative = (file: string) => path.relative(dir, file).split(path.sep).join('/');
    try {
      // ls-tree, not ls-files: a staged file is tracked, but a worktree is made from a commit.
      const { stdout } = await runGit('git', ['ls-tree', '--name-only', 'HEAD', '--', ...inDir.map(relative)], { cwd: dir, env: cleanEnv() });
      const listed = new Set(stdout.split('\n').map((line) => line.trim()).filter(Boolean));
      for (const file of inDir) result.set(file, listed.has(relative(file)));
    } catch {
      // Unknown: no warning rather than a wrong one.
    }
  }));
  return result;
}

/**
 * The workspace's skills before any task runs — what the planner is shown,
 * what `/name` loads, and what a plan's names are checked with: the folders
 * its tasks will read at spawn (ADR-0014), each repo's as checked out in the
 * workspace, and — when tasks get worktrees — which workspace skills git will
 * not carry into them. A repo group's own folder is read from the main
 * checkout at spawn too, so it never needs committing.
 */
export function plannedSkillLookup(
  skillsAt: (roots: readonly string[]) => SkillCatalogLookup,
  workspaceRoot: string,
  layout: SkillLayout,
): SkillCatalogLookup {
  const roots = workspaceSkillRoots(workspaceRoot, layout.repos);
  const lookup = skillsAt(roots);
  if (!layout.worktrees) return lookup;
  const readInPlace = roots.length > 1 ? skillsDirOf(workspaceRoot) : null;
  return {
    findSkill: (name) => lookup.findSkill(name),
    searchedDirs: () => lookup.searchedDirs(),
    listSkills: () => lookup.listSkills(),
    uncommitted: async (skills) => {
      const checked = skills.filter((skill) => skill.source === 'workspace' && !(readInPlace && path.dirname(path.dirname(skill.path)) === readInPlace));
      const committed = await committedInHead(checked.map((skill) => skill.path));
      return new Map(checked
        .filter((skill) => committed.get(skill.path) === false)
        .map((skill) => [skill.path, path.relative(workspaceRoot, path.dirname(skill.path)).split(path.sep).join('/')]));
    },
  };
}

/**
 * A submitted plan's skills, subtasks included, checked leniently: a name
 * missing now may be created by a task the attaching one depends on, so it is
 * only a warning; a planner skill is never right on a task, so it is refused.
 * A name parsing dropped is warned about as it was submitted.
 */
export function checkPlanSkills(tasks: readonly Task[], lookup: SkillLookup): Promise<SkillCheck> {
  return check(
    flattenTasks(tasks).map((t) => ({ taskId: t.id, owner: `Task "${t.title}"`, names: t.skills ?? [], dropped: attached(requestedSkills(t)).dropped })),
    lookup,
  );
}

/** A skill list set on one task by hand, as it was typed, held to the same rule. */
export function checkTaskSkillsEdit(task: Pick<Task, 'id' | 'title'>, skills: unknown, lookup: SkillLookup): Promise<SkillCheck> {
  return check([{ taskId: task.id, owner: `Task "${task.title}"`, ...attached(skills) }], lookup);
}

/**
 * The subtasks an added task brings, at every depth, each named by its path
 * under the op so an error points at the descendant, not the task it hangs on.
 */
function subtaskEntries(owner: string, spec: Partial<Task> | undefined, path: string[] = []): SkillEntry[] {
  const subtasks: unknown = spec?.subtasks;
  if (!Array.isArray(subtasks)) return [];
  return subtasks.flatMap((sub: unknown, i) => {
    if (typeof sub !== 'object' || sub === null) return [];
    const child = sub as Partial<Task>;
    const at = [...path, typeof child.title === 'string' && child.title.trim() ? `"${child.title}"` : `#${i + 1}`];
    return [{ owner: `${owner}: subtask ${at.join(' > ')}`, ...attached(child.skills) }, ...subtaskEntries(owner, child, at)];
  });
}

/** The skill names an edit batch attaches, by op, held to the same rule as a submitted plan. */
export function checkOpSkills(ops: readonly TaskOp[], lookup: SkillLookup): Promise<SkillCheck> {
  const entries: SkillEntry[] = [];
  ops.forEach((op, i) => {
    const owner = `op ${i + 1} (${op.op})`;
    const add = (spec: Partial<Task> | undefined) => entries.push({ owner, ...attached(spec?.skills) });
    switch (op.op) {
      case 'update':
      case 'rearm':
        add(op.changes);
        break;
      case 'add':
        add(op.task);
        // Only an add keeps its spec's subtasks; merge and split build theirs from named fields, and update drops the field.
        entries.push(...subtaskEntries(owner, op.task));
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
 * task skill and the directories searched. `uncommittedFolder`, set when the
 * task runs in a worktree, names the folder to commit for a missing name the
 * main checkout has.
 */
export function resolveTaskSkills(
  task: Pick<Task, 'title' | 'skills'>,
  lookup: SkillLookup,
  uncommittedFolder?: (name: string) => string | undefined,
): TaskSkillSnapshot[] {
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
    const toCommit = uncommittedFolder ? missing.flatMap((name) => uncommittedFolder(name) ?? []) : [];
    problems.push(
      `${missing.length === 1 ? 'skill' : 'skills'} ${quotedList(missing)} not found in ${lookup.searchedDirs().join(' or ')}`
      + (toCommit.length > 0
        ? ` (a workspace skill reaches a task's worktree only once committed: commit ${toCommit.join(', ')} so task worktrees receive ${toCommit.length === 1 ? 'it' : 'them'})`
        : ''),
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
