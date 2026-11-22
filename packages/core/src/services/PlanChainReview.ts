import { runsAsOps, type Task, type RunnerId } from '../models/Task';
import type { RunnerModeInfo } from './ModeResolver';
import { extractObjectsWithKey, stripTrailingCommas, escapeControlCharsInStrings } from './JsonExtractor';
import { checkPlanInvariants } from './PlannedTask';
import { planAncestors } from './readiness';
import { fanOutShape } from './PlanFanOut';

/**
 * A planner filling in code whose interfaces exist still orders slices by what
 * their tests exercise, so the plan runs almost serially, and wording alone did
 * not stop it. Its longest chain is named back to it and it is asked, edge by
 * edge, whether the dependent needs something that does not exist yet. Only
 * the planner can tell an edge that consumes something from one that only
 * orders work, so it is the planner that revises, never Ordewell
 * (ADR-0072).
 *
 * A one-shot plan is taken as the planner first writes it, so one more call
 * asks before the plan is returned; the caller keeps the revision only when it
 * is valid and its chain shorter. Its reply names only the tasks whose
 * dependencies change, never the whole plan: a whole plan written back can be
 * cut off at the output limit, and costs as much as the plan did.
 */
export const CHAIN_REVIEW_MIN = 5;

/** The key of the review's reply object. */
export const CHAIN_REVIEW_KEY = 'dependencyChanges';

/** The longest dependency chain among top-level tasks, first task to last; empty for a graph that is not one. */
export function longestChain(tasks: readonly Task[]): Task[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const memo = new Map<string, Task[]>();
  const visiting = new Set<string>();
  const chainTo = (t: Task): Task[] | null => {
    const known = memo.get(t.id);
    if (known) return known;
    if (visiting.has(t.id)) return null;
    visiting.add(t.id);
    let best: Task[] = [];
    for (const id of t.dependencies) {
      const dep = byId.get(id);
      if (!dep) continue;
      const c = chainTo(dep);
      if (c === null) return null;
      if (c.length > best.length) best = c;
    }
    visiting.delete(t.id);
    const chain = [...best, t];
    memo.set(t.id, chain);
    return chain;
  };
  let longest: Task[] = [];
  for (const t of tasks) {
    const c = chainTo(t);
    if (c === null) return [];
    if (c.length > longest.length) longest = c;
  }
  return longest;
}

/** The plan as the review reads it: what each task does and what it waits for. */
function asPlanJson(tasks: readonly Task[]): string {
  const strip = (t: Task): Record<string, unknown> => ({
    id: t.id,
    title: t.title,
    description: t.description,
    type: t.type,
    dependencies: t.dependencies,
    ...(t.prompt !== undefined ? { prompt: t.prompt } : {}),
    ...(t.prompt === undefined && t.goal ? { goal: t.goal } : {}),
    ...(t.readOnly ? { readOnly: true } : {}),
    ...(t.ops ? { ops: true } : {}),
    ...(t.loop ? { loop: t.loop } : {}),
    ...(t.subtasks.length ? { subtasks: t.subtasks.map(strip) } : {}),
  });
  return JSON.stringify({ tasks: tasks.map(strip) });
}

/**
 * The review's message: the plan as written, its longest chain by title, the
 * question for each edge, and the reply's shape. `alone` is the message sent
 * with no planner prompt before it, so it does not claim the reader wrote the
 * plan.
 */
export function chainReviewMessage(tasks: readonly Task[], chain: readonly Task[], alone = false): string {
  const edges = chain.slice(1).map((t, i) => `- "${t.title}" (${t.id}) depends on "${chain[i].title}" (${chain[i].id})`);
  return [
    alone ? 'This is a plan of tasks that coding agents will run, each task once its dependencies are done:' : 'This is the plan you wrote:',
    asPlanJson(tasks),
    '',
    `Its longest chain of dependencies is ${chain.length} tasks, which run one after another:`,
    ...edges,
    '',
    'Review the plan edge by edge, every dependency, not only these. For each, ask: does the dependent need a file, name, signature or schema that does not exist in the repository until the other task writes it? Filling in a stub or an interface that already exists creates nothing to consume, and a slice whose tests also run code another slice writes does not need it either: it runs them, reports which fail only for that reason, and leaves those to the closing check.',
    'Keep an edge all the same when the dependent needs the other task\'s finding (research before the build it informs, a reproduction before its fix), or when another rule orders them: an ops task after the changes it acts on, a loop\'s body after its check, two tasks that would collide in one checkout, the steps of an expand-contract change. Keep a leading task that makes the project build, import or collect its tests, and a closing check that depends on every task.',
    `Reply with only the tasks whose dependencies change, each with its complete new list, as one JSON object and nothing else: {"${CHAIN_REVIEW_KEY}":[{"id":"<task id>","dependencies":["<task id>", ...]}]}. Use the ids above. An empty list makes the task wait for none; when nothing changes, reply {"${CHAIN_REVIEW_KEY}":[]}.`,
  ].join('\n');
}

/** One task whose dependencies the review changed, by title, for the brief's note and the research log. */
export interface ChainChange {
  id: string;
  removed: string[];
  added: string[];
  /** The tasks the reply cut the closing check off from, each waited for in the first plan, given back as its direct dependencies. */
  restored?: string[];
}

/** `ignored`: the subtask ids the reply answered for, which the review does not revise. */
export type ChainReviewResult = { ok: true; tasks: Task[]; changes: ChainChange[]; ignored: string[] } | { ok: false; error: string };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * A task that acts on the user's checkout, an ops or script task or a user
 * task, is gated on every ancestor's work being merged, and a loop's check
 * checks the work it waits for (readiness.ts mergeGate, ADR-0020, ADR-0045).
 * Dropping one of its ancestors lets it act before that work exists, and no
 * edge test the planner applies can tell that it is needed. A subtask is one
 * too when it is a user task or its top-level task runs as ops, as the gate
 * judges it (PlanStore.isOps).
 */
const actsAfterItsAncestors = (t: Task, root: Task): boolean => runsAsOps(root) || t.loop !== undefined || t.type === 'user';
/** Every task of the tree with its top-level task, subtasks included. */
const withRoots = (tasks: readonly Task[]): [Task, Task][] => {
  const under = (t: Task, root: Task): [Task, Task][] => [[t, root], ...t.subtasks.flatMap((s) => under(s, root))];
  return tasks.flatMap((t) => under(t, t));
};
const subtaskIds = (t: Task): string[] => t.subtasks.flatMap((s) => [s.id, ...subtaskIds(s)]);

/**
 * The first plan's closing check, as R5 reads it: the AI task that edits, waits
 * for every slice and that no other such task waits for. A loop's check is
 * held by {@link actsAfterItsAncestors}, which refuses the reply instead.
 */
function closingCheck(tasks: readonly Task[]): Task | undefined {
  const closer = fanOutShape(tasks).closers[0] as Task | undefined;
  return closer && closer.type === 'ai' && !closer.readOnly && !closer.loop ? closer : undefined;
}

/**
 * The review's message asks to keep a closing check that depends on every
 * task, and a reply that cut another task's dependencies could leave it
 * waiting for none of the slices through that task. So each top-level task it
 * waited for in the first plan and no longer reaches becomes its own
 * dependency again, the fewest such: those none of the others reaches. The
 * check runs after what it ran after, and every other change the reply made
 * stands (ADR-0072 R1).
 */
function restoredWaits(tasks: readonly Task[], rewired: readonly Task[], closer: Task): string[] {
  const top = new Set(tasks.map((t) => t.id));
  const before = planAncestors(tasks)(closer).filter((id) => top.has(id));
  const after = planAncestors(rewired);
  const byId = new Map(rewired.map((t) => [t.id, t]));
  const kept = new Set(after(byId.get(closer.id)!));
  const lost = before.filter((id) => !kept.has(id));
  const reaches = new Map(lost.map((id) => [id, new Set(after(byId.get(id)!))]));
  return lost.filter((id) => !lost.some((o) => o !== id && reaches.get(o)!.has(id)));
}

/**
 * The review's reply applied to the plan as written. Any fault, an unknown id,
 * a malformed entry, a graph the plan's own invariants refuse, a task acting
 * on the checkout that no longer waits for all it did, rejects the whole
 * reply, so the first plan stands rather than half a revision. Ordewell
 * holds these whatever the reply says: the question asks to keep such edges,
 * but only this check ensures it (ADR-0072 R1). An entry for a subtask, which
 * the plan shows but the review does not revise, is ignored alone.
 */
export function applyChainReview(
  tasks: readonly Task[],
  reply: string,
  runners: readonly RunnerId[],
  runnerModes?: Record<RunnerId, RunnerModeInfo[]>,
): ChainReviewResult {
  const { matches } = extractObjectsWithKey(reply, CHAIN_REVIEW_KEY);
  if (matches.length === 0) return { ok: false, error: `no {"${CHAIN_REVIEW_KEY}":[...]} object in the reply` };
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripTrailingCommas(escapeControlCharsInStrings(matches[matches.length - 1])));
  } catch (err) {
    return { ok: false, error: `reply was not valid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
  const entries = isRecord(parsed) ? parsed[CHAIN_REVIEW_KEY] : undefined;
  if (!Array.isArray(entries)) return { ok: false, error: `"${CHAIN_REVIEW_KEY}" is not a list` };
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const subtasks = new Set(tasks.flatMap(subtaskIds));
  const next = new Map<string, string[]>();
  const ignored: string[] = [];
  for (const e of entries) {
    if (!isRecord(e) || typeof e.id !== 'string' || !Array.isArray(e.dependencies) || !e.dependencies.every((d) => typeof d === 'string')) {
      return { ok: false, error: `malformed entry ${JSON.stringify(e)}` };
    }
    if (!byId.has(e.id) && subtasks.has(e.id)) {
      ignored.push(e.id);
      continue;
    }
    if (!byId.has(e.id)) return { ok: false, error: `unknown task "${e.id}"` };
    const deps = [...new Set(e.dependencies as string[])];
    const unknown = deps.find((d) => !byId.has(d));
    if (unknown) return { ok: false, error: `task "${e.id}" names unknown dependency "${unknown}"` };
    next.set(e.id, deps);
  }
  // Subtasks kept: the merge gate walks through them and their parents' edges.
  const wired = () => tasks.map((t) => ({ ...t, dependencies: next.get(t.id) ?? t.dependencies }));
  const closer = closingCheck(tasks);
  const restored = closer ? restoredWaits(tasks, wired(), closer) : [];
  if (closer && restored.length) next.set(closer.id, [...(next.get(closer.id) ?? closer.dependencies), ...restored]);
  const rewired = wired();
  const before = planAncestors(tasks);
  const after = planAncestors(rewired);
  const rewiredById = new Map(withRoots(rewired).map(([t]) => [t.id, t]));
  const afterOf = (id: string): Set<string> => new Set(after(rewiredById.get(id)!));
  // By title and id: a brief may name the other task either way.
  const title = (id: string) => `"${rewiredById.get(id)?.title ?? id}" (${id})`;
  for (const [t, root] of withRoots(tasks)) {
    if (!actsAfterItsAncestors(t, root)) continue;
    const kept = afterOf(t.id);
    const lost = before(t).find((a) => !kept.has(a));
    if (lost) return { ok: false, error: `task "${t.id}" would no longer run after ${title(lost)}, which it waits for` };
  }
  // A task given back that the reply set after the check cannot run before it too.
  const behind = closer && restored.find((id) => afterOf(id).has(closer.id));
  if (closer && behind) return { ok: false, error: `the closing check "${closer.id}" would no longer run after ${title(behind)}, which it waits for` };
  const changes: ChainChange[] = [];
  const revised = tasks.map((t) => {
    const deps = next.get(t.id);
    if (!deps) return t;
    const removed = t.dependencies.filter((d) => !deps.includes(d));
    // A dependency given back was waited for before, so the brief is told nothing of it; the log names each.
    const back = t.id === closer?.id ? restored : [];
    const added = deps.filter((d) => !t.dependencies.includes(d) && !back.includes(d));
    if (!removed.length && !added.length && !back.length) return t;
    changes.push({ id: t.id, removed, added, ...(back.length ? { restored: back } : {}) });
    // A removed dependency still reached through another runs before this task, not beside it.
    const kept = afterOf(t.id);
    const parallel = removed.filter((d) => !kept.has(d));
    if (!parallel.length && !added.length) return { ...t, dependencies: deps };
    const note = revisionNote(parallel.map(title), added.map(title));
    // A delegated task has no prompt: its goal is its brief.
    if (t.prompt !== undefined) return { ...t, dependencies: deps, prompt: `${t.prompt}\n\n${note}` };
    if (t.goal) return { ...t, dependencies: deps, goal: `${t.goal}\n\n${note}` };
    return { ...t, dependencies: deps };
  });
  const errors = checkPlanInvariants(revised, runners, runnerModes);
  if (errors.length) return { ok: false, error: errors[0].message };
  return { ok: true, tasks: revised, changes, ignored };
}

/**
 * Appended to a changed brief, whose own words may still say to wait for a
 * task it no longer depends on: the note comes last and overrides them, so
 * the brief stays true without the model rewriting it.
 */
export function revisionNote(removed: readonly string[], added: readonly string[]): string {
  const list = (names: readonly string[]) => names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0];
  const parts: string[] = ['Plan revision:'];
  if (removed.length) {
    parts.push(`this task no longer waits for ${list(removed)}, which ${removed.length > 1 ? 'run' : 'runs'} in parallel with it. Where this brief says to wait for ${removed.length > 1 ? 'them' : 'it'}, do not: take in ${removed.length > 1 ? 'their' : 'its'} work once it has landed, and until then run this slice's tests, name each that fails only because that work has not landed in a finding, and leave those to the closing check.`);
  }
  if (added.length) parts.push(`${removed.length ? 'It' : 'This task'} now also runs after ${list(added)}.`);
  return parts.join(' ');
}

const EDGE_TEST = 'does the dependent need a file, name, signature or schema that does not exist in the repository until the other task writes it? Filling in a stub or an interface that already exists creates nothing to consume, and a slice whose tests also run code another slice writes does not need it either: its brief runs them, reports which fail only for that reason, and leaves those to the closing check.';

/**
 * A plan through submit_plan whose chain is this long, counted in top-level
 * tasks with a closing check included, is offered the review in the answer.
 * At 3 most plans that were already right were reviewed too, for no gain.
 */
export const TOOL_CHAIN_REVIEW_MIN = 4;

/** The planner told users of the review it was given; the review is the planner's own step. */
export const CHAIN_REVIEW_UNSAID = 'Do not mention this review to the user.';

/**
 * The review submit_plan's answer carries: never a refusal, and kept out of
 * what the user is told, since the planner may rightly keep every edge. The
 * plan stands as committed until the planner itself submits another. The
 * edges other rules require are named, so the question never asks to drop
 * them.
 */
export function chainReviewNote(chain: readonly Task[]): string {
  const path = chain.map((t) => `"${t.title}" (${t.id})`).join(' → ');
  return [
    `Its longest chain of dependencies is ${chain.length} tasks, which run one after another: ${path}.`,
    `Before you end your turn, review the plan edge by edge, every dependency, not only these. For each, ask: ${EDGE_TEST}`,
    'Keep every dependency another rule requires: research before the work it informs, a reproduction before its fix, an ops task after the changes it acts on, two tasks that would collide in one checkout, a loop\'s check and its body, the steps of an expand-contract change, a leading task that makes the project build, import or collect its tests, and a closing check that depends on every task.',
    'If any dependency fails the test, call submit_plan once more with the whole plan, each such dependency removed and each brief that named it as a task it waits for reworded to say it runs in parallel; that plan replaces this one. If every dependency passes, keep the plan as it is.',
    CHAIN_REVIEW_UNSAID,
  ].join(' ');
}
