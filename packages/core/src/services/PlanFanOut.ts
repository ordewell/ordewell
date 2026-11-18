import { createTask, runsAsOps, type RunnerId, type Task } from '../models/Task';
import type { RunnerModeInfo } from './ModeResolver';
import { escapeControlCharsInStrings, extractObjectsWithKey, stripTrailingCommas } from './JsonExtractor';
import { checkPlanInvariants } from './PlannedTask';
import { applyChainReview, CHAIN_REVIEW_KEY, CHAIN_REVIEW_MIN, chainQuestion, reviewHeader, type ChainChange } from './PlanChainReview';

/**
 * A one-shot plan that fans out over code whose parts call each other (a
 * library whose bodies are stubs) pays only with three things around its
 * slices: one short task before them, a done criterion each slice can meet in
 * its own worktree, and one check after them all. The planner was told so in
 * words and still wrote three opening tasks in series, none, or no closing
 * check, and its slices ran on past their best test count against siblings
 * that were still stubs. So the shape is read from the dependencies alone, a
 * fault in it is put to the planner in the review call ADR-0072 already makes,
 * and each role's brief gets a note Ordewell writes the same way every time.
 */

/** A plan fans out when at least this many of its slices sit at one level: they run at once. */
export const FAN_OUT_MIN = 4;

export type FanOutFault = 'serial-opening' | 'no-opening' | 'no-closing';

export interface FanOutShape {
  /** Whether the plan fans out at all ({@link FAN_OUT_MIN}); with it false, every other field but `width` is empty. */
  wide: boolean;
  /** The most slices one level holds. */
  width: number;
  /** Change tasks every slice waits for, first to last: what runs before the fan-out. */
  gates: Task[];
  /** Change tasks that are not ordered against every other change task. */
  slices: Task[];
  /** Tasks that wait for every slice, a loop's check among them, nearest first. */
  closers: Task[];
  /** Dependencies from one slice on another. */
  sliceEdges: number;
  faults: FanOutFault[];
}

const NONE: FanOutShape = { wide: false, width: 0, gates: [], slices: [], closers: [], sliceEdges: 0, faults: [] };

/** Every top-level task's ancestors and level, or null for a cycle. Dependencies on no task are left out. */
function graph(tasks: readonly Task[]): { anc: Map<string, Set<string>>; level: Map<string, number> } | null {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const anc = new Map<string, Set<string>>();
  const level = new Map<string, number>();
  const visiting = new Set<string>();
  const visit = (t: Task): boolean => {
    if (anc.has(t.id)) return true;
    if (visiting.has(t.id)) return false;
    visiting.add(t.id);
    const mine = new Set<string>();
    let deepest = 0;
    for (const id of t.dependencies) {
      const dep = byId.get(id);
      if (!dep) continue;
      if (!visit(dep)) return false;
      mine.add(id);
      for (const a of anc.get(id)!) mine.add(a);
      deepest = Math.max(deepest, level.get(id)!);
    }
    visiting.delete(t.id);
    anc.set(t.id, mine);
    level.set(t.id, deepest + 1);
    return true;
  };
  for (const t of tasks) if (!visit(t)) return null;
  return { anc, level };
}

/**
 * The plan's fan-out, read from its top-level dependencies alone. A change
 * task is an AI task that edits the repository and is neither research, an
 * ops task, a loop's check nor in a loop's body. The change tasks ordered
 * against every other one are its spine: those every slice waits for are its
 * gates, the rest of the change tasks are its slices. A closer is any task but
 * an ops task or a manual one that waits for every slice; a script task counts
 * only as a loop's check or read-only, since a script after everything may be
 * a push.
 */
export function fanOutShape(tasks: readonly Task[]): FanOutShape {
  const g = graph(tasks);
  if (!g) return NONE;
  const body = new Set(tasks.flatMap((t) => t.loop?.body ?? []));
  const anc = (t: Task) => g.anc.get(t.id)!;
  const change = tasks.filter((t) => t.type === 'ai' && !t.readOnly && !runsAsOps(t) && !t.research && !t.loop && !body.has(t.id));
  const ordered = (a: Task, b: Task) => anc(a).has(b.id) || anc(b).has(a.id);
  const spine = new Set(change.filter((t) => change.every((o) => o === t || ordered(t, o))));
  const slices = change.filter((t) => !spine.has(t));
  if (slices.length < 2) return NONE;
  const byLevel = (a: Task, b: Task) => g.level.get(a.id)! - g.level.get(b.id)!;
  const gates = [...spine].filter((t) => slices.every((s) => anc(s).has(t.id))).sort(byLevel);
  const closes = (t: Task) => !body.has(t.id) && t.type !== 'user' && !t.ops
    && (t.type !== 'script' || t.loop !== undefined || t.readOnly === true)
    && slices.every((s) => anc(t).has(s.id));
  const closers = tasks.filter(closes).sort(byLevel);
  const perLevel = new Map<number, number>();
  for (const s of slices) perLevel.set(g.level.get(s.id)!, (perLevel.get(g.level.get(s.id)!) ?? 0) + 1);
  const width = Math.max(...perLevel.values());
  const sliceIds = new Set(slices.map((s) => s.id));
  const sliceEdges = slices.reduce((n, s) => n + new Set(s.dependencies.filter((d) => sliceIds.has(d))).size, 0);
  const wide = width >= FAN_OUT_MIN;
  if (!wide) return { ...NONE, width };
  const faults: FanOutFault[] = [];
  if (gates.length >= 2) faults.push('serial-opening');
  if (gates.length === 0) faults.push('no-opening');
  if (closers.length === 0) faults.push('no-closing');
  return { wide, width, gates, slices, closers, sliceEdges, faults };
}

const ref = (t: Pick<Task, 'title' | 'id'>) => `"${t.title}" (${t.id})`;

/** The questions a fault puts, each the fault's own: nothing is asked of a shape that has none. */
function faultQuestions(shape: FanOutShape): string[] {
  const lines: string[] = [`This plan fans out: up to ${shape.width} of its slices run at once.`];
  if (shape.faults.includes('serial-opening')) {
    lines.push(`Before any slice starts, ${shape.gates.length} tasks run one after another: ${shape.gates.map(ref).join(' → ')}. Every slice waits for all of them, so only one task should come first: the one that makes the project import and collect its tests, and nothing more. Make that task depend on nothing. Of the others, keep one before the slices only where it is one of a few shared modules most slices' tests build their inputs with, and make it depend on that first task alone; make every other one a slice that depends on that first task alone.`);
  }
  if (shape.faults.includes('no-opening')) {
    lines.push('No task runs before the slices. If the project does not import or collect its tests as it stands, add one task that restores just that: it may edit whichever files block it, whatever task owns them, implements nothing beyond that, and is checked by the project importing and its tests collecting. Every slice will wait for it. If the project imports and collects its tests already, add none.');
  }
  if (shape.faults.includes('no-closing')) {
    lines.push('No task runs after every slice, so nothing runs the whole test suite once they have all ended. Add one closing check that runs it and fixes what still fails; it will wait for every slice.');
  }
  return lines;
}

export const ADD_TASKS_KEY = 'addTasks';

const SHAPE_REPLY = `Reply as one JSON object and nothing else: {"${CHAIN_REVIEW_KEY}":[{"id":"<task id>","dependencies":["<task id>", ...]}],"${ADD_TASKS_KEY}":[{"id":"<new task id>","role":"restoring|closing","title":"<title>","prompt":"<its whole brief>"}]}. In "${CHAIN_REVIEW_KEY}" list only the tasks whose dependencies change, each with its complete new list, by the ids above; an empty list makes the task wait for none. In "${ADD_TASKS_KEY}" put only a task the questions above ask you to add; Ordewell sets what it waits for and what waits for it. When nothing changes, reply {"${CHAIN_REVIEW_KEY}":[],"${ADD_TASKS_KEY}":[]}.`;

/**
 * The review message for a plan whose fan-out has a fault: the chain question
 * as measured when the chain reaches {@link CHAIN_REVIEW_MIN}, then a question
 * for each fault, then a reply that may add the one task a fault asks for.
 * A plan with no fault is asked {@link chainReviewMessage}, word for word.
 */
export function shapeReviewMessage(tasks: readonly Task[], chain: readonly Task[], shape: FanOutShape, alone = false): string {
  return [
    ...reviewHeader(tasks, alone),
    ...(chain.length >= CHAIN_REVIEW_MIN ? [...chainQuestion(chain), ''] : []),
    ...faultQuestions(shape),
    SHAPE_REPLY,
  ].join('\n');
}

export type ShapeReviewResult = { ok: true; tasks: Task[]; changes: ChainChange[]; added: Task[]; ignored: string[] } | { ok: false; error: string };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * The reply applied: each task it adds, wired by Ordewell as its role says (a
 * restoring task waits for nothing and every slice waits for it; a closing
 * check waits for every slice, and so does a push or a manual step that waited
 * for every slice), then its dependency lists, held to everything
 * {@link applyChainReview} holds. A task is added only for the fault that asks
 * for it, and any fault in the reply rejects it whole.
 */
export function applyShapeReview(
  tasks: readonly Task[],
  shape: FanOutShape,
  reply: string,
  runners: readonly RunnerId[],
  runnerModes?: Record<RunnerId, RunnerModeInfo[]>,
): ShapeReviewResult {
  const { matches } = extractObjectsWithKey(reply, CHAIN_REVIEW_KEY);
  if (matches.length === 0) return { ok: false, error: `no {"${CHAIN_REVIEW_KEY}":[...]} object in the reply` };
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripTrailingCommas(escapeControlCharsInStrings(matches[matches.length - 1])));
  } catch (err) {
    return { ok: false, error: `reply was not valid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
  const entries = isRecord(parsed) ? parsed[ADD_TASKS_KEY] ?? [] : [];
  if (!Array.isArray(entries)) return { ok: false, error: `"${ADD_TASKS_KEY}" is not a list` };
  const ids = new Set(tasks.flatMap(function all(t: Task): string[] { return [t.id, ...t.subtasks.flatMap(all)]; }));
  const template = shape.slices[0];
  const top = Math.max(0, ...tasks.map((t) => t.order));
  const added: Task[] = [];
  const roles = new Set<string>();
  for (const e of entries) {
    if (!isRecord(e) || typeof e.id !== 'string' || !e.id || typeof e.title !== 'string' || !e.title.trim() || typeof e.prompt !== 'string' || !e.prompt.trim()) {
      return { ok: false, error: `malformed task to add ${JSON.stringify(e)}` };
    }
    const role = e.role;
    if (role !== 'restoring' && role !== 'closing') return { ok: false, error: `task "${e.id}" has role ${JSON.stringify(role)}, not "restoring" or "closing"` };
    if (roles.has(role)) return { ok: false, error: `more than one ${role} task to add` };
    if (!shape.faults.includes(role === 'restoring' ? 'no-opening' : 'no-closing')) return { ok: false, error: `the plan already has a ${role === 'restoring' ? 'task before its slices' : 'closing check'}, so none is added` };
    if (ids.has(e.id)) return { ok: false, error: `task "${e.id}" to add has an id the plan already has` };
    roles.add(role);
    ids.add(e.id);
    added.push(createTask({
      id: e.id,
      order: top + 1 + added.length,
      title: e.title.trim(),
      description: e.title.trim(),
      prompt: e.prompt,
      dependencies: role === 'closing' ? shape.slices.map((s) => s.id) : [],
      assignedRunner: template.assignedRunner,
      assignedModel: template.assignedModel,
      taskMode: template.taskMode,
      autonomy: template.autonomy ?? 'AFK',
      sliceType: template.sliceType ?? 'AFK',
    }));
  }
  const restoring = added.find((t) => !t.dependencies.length);
  const closing = added.find((t) => t.dependencies.length > 0);
  const sliceIds = new Set(shape.slices.map((s) => s.id));
  // A push or a manual step after every slice acts on what the closing check fixes too, so it waits for it (ADR-0072 R1).
  const anc = closing ? graph(tasks)?.anc : undefined;
  const actsAfterSlices = (t: Task) => (runsAsOps(t) || t.type === 'user') && shape.slices.every((s) => anc?.get(t.id)?.has(s.id));
  const augmented = [
    ...tasks.map((t) => {
      const deps = [
        ...t.dependencies,
        ...(restoring && sliceIds.has(t.id) ? [restoring.id] : []),
        ...(closing && actsAfterSlices(t) ? [closing.id] : []),
      ];
      return deps.length === t.dependencies.length ? t : { ...t, dependencies: deps };
    }),
    ...added,
  ];
  const applied = applyChainReview(augmented, reply, runners, runnerModes);
  if (!applied.ok) return applied;
  // A task moved from before the slices to beside them is a slice the closing check must wait for too: Ordewell adds that wait, never drops one.
  const closer = shape.closers[0] ?? closing;
  const now = fanOutShape(applied.tasks);
  if (!closer || now.closers.some((c) => c.id === closer.id)) return { ...applied, added };
  const missing = now.slices.map((s) => s.id).filter((id) => id !== closer.id);
  const closed = applied.tasks.map((t) => (t.id === closer.id ? { ...t, dependencies: [...new Set([...t.dependencies, ...missing])] } : t));
  const errors = checkPlanInvariants(closed, runners, runnerModes);
  if (errors.length) return { ok: false, error: errors[0].message };
  return { ...applied, tasks: closed, added };
}

/** Repository paths a brief names, for the slices' map of who owns what. */
const PATH = /(?<![\w/.-])(?:[\w.-]+\/)*[\w-]+\.(?:py|pyi|ts|tsx|js|jsx|mjs|cjs|go|rs|java|kt|rb|php|c|h|cc|cpp|hpp|cs|swift|scala)\b/g;
const MAX_PATHS = 6;

const NOTED = 'Plan shape:';

/** From the brief as the planner wrote it: a note already appended names every task's paths. */
function namedPaths(t: Task): string[] {
  return [...new Set((t.prompt ?? '').split(NOTED)[0].match(PATH) ?? [])].slice(0, MAX_PATHS);
}

function ownershipTable(shape: FanOutShape): string {
  return [...shape.gates, ...shape.slices].map((t) => {
    const paths = namedPaths(t);
    return `- ${ref(t)}${paths.length ? `: ${paths.join(', ')}` : ''}`;
  }).join('\n');
}

/** The first gate's note: the slices wait for it, so it is short, and its report carries the map they start from. */
export function openingNote(shape: FanOutShape): string {
  return [
    `Plan shape: ${shape.slices.length} slices wait for this task to land before any of them starts, so finish it as soon as your brief allows and leave every module a slice owns to that slice. End your report with a map the slices read before they explore: for each module the tests import, its path, its public names, and the task below that owns it. Say in your summary that the map is in your report. The tasks and the paths their briefs name:`,
    ownershipTable(shape),
  ].join('\n');
}

/** A slice's note: its own scope is its done criterion, and what needs another slice's work is the closing check's. */
export function sliceNote(shape: FanOutShape): string {
  const gate = shape.gates[0];
  const closer = shape.closers[0];
  return [
    `Plan shape: this task is one of ${shape.slices.length} slices${gate ? ` that start once ${ref(gate)} has landed` : ''}, and ${ref(closer)} runs the whole test suite once every slice has ended.${gate ? ` Read the module map at the end of ${ref(gate)}'s report (read, with include_report) before you explore.` : ''} The tasks and the paths their briefs name:`,
    ownershipTable(shape),
    `Your scope is this brief's. You are done when the code in your scope is written and its tests pass, except tests that fail only because they call code another slice owns that has not landed in your worktree, or that ask for behaviour the repository does not let you derive. Run those once, list each as a finding with the module it waits for or why it cannot be derived, and end with status done: they are ${ref(closer)}'s. Do not write, stub or shim another slice's code to make them pass, and do not keep iterating on them. End with status failed only when the code in your scope is not in place.`,
  ].join('\n');
}

/** The closing check's note: it runs once the slices have ended, and some may not have landed. */
export function closingNote(shape: FanOutShape): string {
  return `Plan shape: this check runs after the ${shape.slices.length} slices. Read each slice's handoff with read: a slice that ended done lists the tests it left to you, and a slice that did not land (it failed and was skipped) left its module unwritten here, so write that module from its brief, its handoff and the tests. Run the whole test suite, fix what fails, and report each test that still fails with its reason.`;
}

/**
 * The plan with each role's note appended to its brief, last, as a revision
 * note is: the first gate's, every slice's, and the closing check's, or the
 * AI tasks of its loop's body when the check is a script or read-only. Only a
 * plan that fans out with a closing check is noted, since the slices' note
 * leaves work to it; any other plan comes back as the same array.
 */
export function withShapeNotes(tasks: Task[], shape: FanOutShape = fanOutShape(tasks)): Task[] {
  if (!shape.wide || shape.closers.length === 0) return tasks;
  const closer = shape.closers[0];
  // A check that cannot edit leaves the fixing to its loop's body.
  const closing = new Set(closer.type === 'ai' && !closer.readOnly ? [closer.id] : closer.loop?.body ?? []);
  const notes = new Map<string, string>();
  if (shape.gates[0]) notes.set(shape.gates[0].id, openingNote(shape));
  const slice = sliceNote(shape);
  for (const s of shape.slices) notes.set(s.id, slice);
  const close = closingNote(shape);
  for (const id of closing) notes.set(id, close);
  let changed = false;
  const out = tasks.map((t) => {
    const note = notes.get(t.id);
    if (!note || t.type !== 'ai' || t.prompt === undefined || t.prompt.includes(NOTED)) return t;
    changed = true;
    return { ...t, prompt: `${t.prompt}\n\n${note}` };
  });
  return changed ? out : tasks;
}
