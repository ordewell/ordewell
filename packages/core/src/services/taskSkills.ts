import * as path from 'path';
import { flattenTasks, isSkillName, skillNames, type Task, type TaskSkillSnapshot } from '../models/Task';
import { skillsDirOf, skillTooLarge, workspaceSkillRoots, type SkillInfo, type SkillsService } from './SkillsService';
import { opLabel, type OpRef, type TaskOp } from './TaskOps';
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
  /** Names that can never be a task skill: they resolve to a planner skill. An edit's name its op beside the message, not in it. */
  errors: { taskId?: string; op?: OpRef; message: string }[];
  /** Names not found yet — an earlier task may create them in its worktree — or found only in a file no worktree will get. */
  warnings: string[];
}

function plannerSkillMessage(owner: string | undefined, skill: SkillInfo): string {
  return `${owner ? `${owner}: ` : ''}"${skill.name}" is a planner skill (applies-to: planner, ${skill.path}). Only skills with applies-to: task can be attached to a task.`;
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
  /** The edit op that attaches the names; `owner` then says where under it, if anywhere but the op's own task. */
  op?: OpRef;
  owner?: string;
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
  for (const { taskId, op, owner, names, dropped } of entries) {
    const named = [op ? opLabel(op) : undefined, owner].filter(Boolean).join(': ');
    for (const name of dropped ?? []) warnings.push(invalidNameWarning(named, name));
    for (const name of names) {
      const skill = lookup.findSkill(name);
      if (!skill) warnings.push(notFoundWarning(named, name));
      else if (skill.appliesTo !== 'task') errors.push({ ...(taskId ? { taskId } : {}), ...(op ? { op } : {}), message: plannerSkillMessage(owner, skill) });
      else if (skillTooLarge(skill)) errors.push({ ...(taskId ? { taskId } : {}), ...(op ? { op } : {}), message: `${owner ? `${owner}: ` : ''}${skillTooLarge(skill)}.` });
      else warnings.push({ owner: named, skill });
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
 * A submitted plan's skills, subtasks included: a name missing now is a
 * warning, since a task the attaching one depends on may create it (whether
 * one does is {@link unprovidedSkills}' rule); a planner skill is never right
 * on a task, so it is refused.
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
function subtaskEntries(op: OpRef, spec: Partial<Task> | undefined, path: string[] = []): SkillEntry[] {
  const subtasks: unknown = spec?.subtasks;
  if (!Array.isArray(subtasks)) return [];
  return subtasks.flatMap((sub: unknown, i) => {
    if (typeof sub !== 'object' || sub === null) return [];
    const child = sub as Partial<Task>;
    const at = [...path, typeof child.title === 'string' && child.title.trim() ? `"${child.title}"` : `#${i + 1}`];
    return [{ op, owner: `subtask ${at.join(' > ')}`, ...attached(child.skills) }, ...subtaskEntries(op, child, at)];
  });
}

/** The skill names an edit batch attaches, by op, held to the same rule as a submitted plan. */
export function checkOpSkills(ops: readonly TaskOp[], lookup: SkillLookup): Promise<SkillCheck> {
  const entries: SkillEntry[] = [];
  ops.forEach((op, i) => {
    const ref: OpRef = { number: i + 1, kind: op.op };
    const add = (spec: Partial<Task> | undefined) => entries.push({ op: ref, ...attached(spec?.skills) });
    switch (op.op) {
      case 'update':
      case 'rearm':
        add(op.changes);
        break;
      case 'add':
        add(op.task);
        // Only an add keeps its spec's subtasks; merge and split build theirs from named fields, and update drops the field.
        entries.push(...subtaskEntries(ref, op.task));
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

/**
 * A name no installed task skill answers to stands on a task only when a task
 * it depends on, directly or not, creates it: one whose prompt names
 * `.ordewell/skills/<name>` (ADR-0024). Otherwise nothing will have written
 * it by the time the task starts, and the task would fail there with its
 * dependents behind it. A subtask is also held behind what its parents wait on.
 */
function unprovided(tasks: readonly Task[], lookup: Pick<SkillLookup, 'findSkill'>): { task: Task; name: string }[] {
  const byId = new Map<string, Task>();
  const parentOf = new Map<string, Task>();
  const visit = (list: readonly Task[], parent?: Task) => {
    for (const task of list) {
      byId.set(task.id, task);
      if (parent) parentOf.set(task.id, parent);
      visit(task.subtasks ?? [], task);
    }
  };
  visit(tasks);
  const upstream = (task: Task): Task[] => {
    const seen = new Set<string>();
    const queue = [task];
    for (let p = parentOf.get(task.id); p; p = parentOf.get(p.id)) queue.push(p);
    const found: Task[] = [];
    for (let at = queue.shift(); at; at = queue.shift()) {
      for (const id of at.dependencies ?? []) {
        const dep = byId.get(id);
        if (!dep || seen.has(id)) continue;
        seen.add(id);
        found.push(dep);
        queue.push(dep);
        for (let p = parentOf.get(dep.id); p; p = parentOf.get(p.id)) queue.push(p);
      }
    }
    return found;
  };
  const out: { task: Task; name: string }[] = [];
  for (const task of byId.values()) {
    const missing = (task.skills ?? []).filter((name) => !lookup.findSkill(name));
    if (missing.length === 0) continue;
    const prompts = upstream(task).map((dep) => dep.prompt ?? '');
    for (const name of missing) {
      // The name must end where the path's segment does, so `house-style-v2` does not create `house-style`.
      const creates = new RegExp(`\\.ordewell[\\\\/]skills[\\\\/]${name}(?![a-z0-9_-])`, 'i');
      if (!prompts.some((prompt) => creates.test(prompt))) out.push({ task, name });
    }
  }
  return out;
}

function unprovidedMessage(task: Pick<Task, 'title'>, name: string): string {
  return `Task "${task.title}": skill "${name}" is not an installed task skill, and no task it depends on creates it.`
    + ` Remove "${name}" from its skills, or add a task whose prompt says to write .ordewell/skills/${name}/SKILL.md and make Task "${task.title}" depend on it.`;
}

/**
 * The skills a change leaves on a task that nothing installed or upstream
 * provides, less those the plan already held before it: a saved plan from
 * before this rule still loads and can still be edited, and an edit answers
 * only for what it brought. A task a merge or split built holds what stood on
 * a task it was built from, as `builtFrom` maps it.
 */
export function unprovidedSkills(
  before: readonly Task[],
  after: readonly Task[],
  lookup: Pick<SkillLookup, 'findSkill'>,
  builtFrom: ReadonlyMap<string, readonly string[]> = new Map(),
): { taskId: string; message: string }[] {
  const key = (id: string, name: string) => `${id}\u0000${name}`;
  const standing = new Set(unprovided(before, lookup).map(({ task, name }) => key(task.id, name)));
  return unprovided(after, lookup)
    .filter(({ task, name }) => !(builtFrom.get(task.id) ?? [task.id]).some((id) => standing.has(key(id, name))))
    .map(({ task, name }) => ({ taskId: task.id, message: unprovidedMessage(task, name) }));
}

/**
 * A one-shot plan with the names {@link unprovidedSkills} would refuse taken
 * off its tasks, subtasks included, each said in a warning. A one-shot planner
 * has no conversation to send a refusal back through, and one invented name
 * must not cost the whole plan; the name is not accepted, only dropped.
 */
export function withoutUnprovidedSkills(tasks: readonly Task[], lookup: Pick<SkillLookup, 'findSkill'>): { tasks: Task[]; warnings: string[] } {
  const found = unprovided(tasks, lookup);
  if (found.length === 0) return { tasks: [...tasks], warnings: [] };
  const drop = new Map<Task, Set<string>>();
  for (const { task, name } of found) drop.set(task, new Set([...(drop.get(task) ?? []), name]));
  const strip = (list: readonly Task[]): Task[] => list.map((task) => {
    const names = drop.get(task);
    return {
      ...task,
      ...(names ? { skills: (task.skills ?? []).filter((name) => !names.has(name)) } : {}),
      ...(task.subtasks ? { subtasks: strip(task.subtasks) } : {}),
    };
  });
  return {
    tasks: strip(tasks),
    warnings: found.map(({ task, name }) => `Task "${task.title}": skill "${name}" is not an installed task skill, and no task it depends on creates it, so it was removed from the task's skills.`),
  };
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
  const oversize: string[] = [];
  const resolved: TaskSkillSnapshot[] = [];
  for (const name of task.skills ?? []) {
    const skill = lookup.findSkill(name);
    if (!skill) missing.push(name);
    else if (skill.appliesTo !== 'task') planner.push(skill);
    else if (skillTooLarge(skill)) oversize.push(skillTooLarge(skill)!);
    else resolved.push({ name: skill.name, source: skill.source, path: skill.path, content: skill.content });
  }
  const problems: string[] = [];
  if (missing.length > 0) {
    const toCommit = uncommittedFolder ? missing.flatMap((name) => uncommittedFolder(name) ?? []) : [];
    // The way out comes first: a supervisor's wake cuts a failure's detail short, and the paths searched are the long part.
    const fix = missing.length === 1
      ? `skill "${missing[0]}" not found: create .ordewell/skills/${missing[0]}/SKILL.md, or remove "${missing[0]}" from the task's skills with edit_plan, then retry the task`
      : `skills ${quotedList(missing)} not found: create each at .ordewell/skills/<name>/SKILL.md, or remove them from the task's skills with edit_plan, then retry the task`;
    problems.push(
      `${fix} (searched ${lookup.searchedDirs().join(' or ')}`
      + (toCommit.length > 0
        ? `; a workspace skill reaches a task's worktree only once committed: commit ${toCommit.join(', ')} so task worktrees receive ${toCommit.length === 1 ? 'it' : 'them'}`
        : '')
      + ')',
    );
  }
  for (const skill of planner) problems.push(`"${skill.name}" is a planner skill (applies-to: planner, ${skill.path}), not a task skill`);
  problems.push(...oversize);
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
