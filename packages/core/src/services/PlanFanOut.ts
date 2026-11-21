import * as path from 'path';
import type { IFileSystem } from '../interfaces/IFileSystem';
import { flattenTasks, runsAsOps, type Task } from '../models/Task';
import { replace } from './PlanGraph';

/**
 * A one-shot plan that fans out over code whose parts call each other (a
 * library whose bodies are stubs) pays only with three things around its
 * slices: one short task before them, a done criterion each slice can meet in
 * its own worktree, and one check after them all. The planner was told so in
 * words and still wrote three opening tasks in series, none, or no closing
 * check, and its slices ran on past their best test count against siblings
 * that were still stubs. So the shape is read from the dependencies alone and
 * each role's brief gets a note Ordewell writes the same way every time. Its
 * faults are data for the log and the bench: asked about them in the review
 * call, the planner made its plans worse, so nothing asks it (ADR-0072 R5).
 */

/** A plan fans out when at least this many of its slices sit at one level: they run at once. */
export const FAN_OUT_MIN = 4;

/** Data for the research log and the bench: nothing asks the planner about a fault (ADR-0072 R5). */
export type FanOutFault = 'serial-opening' | 'no-opening' | 'no-closing';

export interface FanOutShape {
  /** Whether the plan fans out at all ({@link FAN_OUT_MIN}); with it false, every other field but `width` is empty. */
  wide: boolean;
  /** The most slices one level holds. */
  width: number;
  /** Change tasks every slice waits for, first to last: what runs before the fan-out. The first is the opening task; one after it is a shared module. */
  gates: Task[];
  /** Change tasks that are not ordered against every other change task, then a change task the closing check waits for that waits for all of those. */
  slices: Task[];
  /** Tasks that wait for every slice and can fix, a loop's check among them: the closing check, which no other waits for, first. */
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
 * gates, the rest of the change tasks are its slices. A closer is a task that
 * waits for every slice and can fix what still fails: an AI task that edits,
 * or a loop's check whose body holds one. An ops task, a manual one and a
 * script that is not a loop's check never count, since a script after
 * everything may be a push. The closing check is the closer no other waits
 * for; a change task it waits for is a slice too, unless it is the only one.
 * With no task after every slice, fewer change tasks than a fan-out that wait
 * for every other one are the closing check and the tasks beside it.
 */
export function fanOutShape(tasks: readonly Task[]): FanOutShape {
  const g = graph(tasks);
  if (!g) return NONE;
  const body = new Set(tasks.flatMap((t) => t.loop?.body ?? []));
  const anc = (t: Task) => g.anc.get(t.id)!;
  const change = tasks.filter((t) => t.type === 'ai' && !t.readOnly && !runsAsOps(t) && !t.research && !t.loop && !body.has(t.id));
  const ordered = (a: Task, b: Task) => anc(a).has(b.id) || anc(b).has(a.id);
  const spine = new Set(change.filter((t) => change.every((o) => o === t || ordered(t, o))));
  let parallel = change.filter((t) => !spine.has(t));
  if (parallel.length < 2) return NONE;
  const byLevel = (a: Task, b: Task) => g.level.get(a.id)! - g.level.get(b.id)!;
  const fixer = new Set(tasks.filter((t) => t.type === 'ai' && !t.readOnly).map((t) => t.id));
  const closes = (after: readonly Task[]) => (t: Task) => !body.has(t.id) && t.type !== 'user' && !t.ops
    && (fixer.has(t.id) || (t.loop?.body ?? []).some((id) => fixer.has(id)))
    && after.every((s) => anc(t).has(s.id));
  // A closing check with a change task beside it (its docs, say) is not ordered
  // against that task, so both read as slices and nothing waits for every slice.
  // Fewer tasks than a fan-out that wait for every other one are the closing check
  // and what runs beside it; as many are the plan's last level of slices.
  if (!tasks.some(closes(parallel))) {
    const ends = parallel.filter((t) => !parallel.some((o) => anc(o).has(t.id)));
    const rest = parallel.filter((t) => !ends.includes(t));
    if (ends.length < FAN_OUT_MIN && rest.length > 0 && ends.every(closes(rest))) parallel = rest;
  }
  const gates = [...spine].filter((t) => parallel.every((s) => anc(s).has(t.id))).sort(byLevel);
  const candidates = tasks.filter(closes(parallel)).sort(byLevel);
  // The closing check is the candidate nothing else after the slices waits for, the
  // deepest if several. A change task it waits for only implements one more module
  // after them, so it is a slice of the last level, told as the others are.
  const last = candidates.filter((c) => !candidates.some((o) => anc(o).has(c.id)));
  const closer = last[last.length - 1];
  const late = new Set(candidates.filter((c) => closer && c !== closer && spine.has(c) && anc(closer).has(c.id)));
  const slices = [...parallel, ...candidates.filter((c) => late.has(c))];
  const closers = candidates.filter((c) => !late.has(c)).sort((a, b) => Number(b === closer) - Number(a === closer));
  const perLevel = new Map<number, number>();
  for (const s of slices) perLevel.set(g.level.get(s.id)!, (perLevel.get(g.level.get(s.id)!) ?? 0) + 1);
  const width = Math.max(...perLevel.values());
  const sliceIds = new Set(slices.map((s) => s.id));
  const sliceEdges = slices.reduce((n, s) => n + new Set(s.dependencies.filter((d) => sliceIds.has(d))).size, 0);
  const wide = width >= FAN_OUT_MIN;
  if (!wide) return { ...NONE, width };
  const faults: FanOutFault[] = [];
  // A later gate that waits for the opening task alone (an install or a manual step
  // aside) is a shared module the slices build on, not a second opening task.
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const outside = (id: string) => { const d = byId.get(id); return !d || runsAsOps(d) || d.type === 'user'; };
  if (gates.slice(1).some((t) => !t.dependencies.every((d) => d === gates[0].id || outside(d)))) faults.push('serial-opening');
  if (gates.length === 0) faults.push('no-opening');
  if (closers.length === 0) faults.push('no-closing');
  return { wide, width, gates, slices, closers, sliceEdges, faults };
}

const ref = (t: Pick<Task, 'title' | 'id'>) => `"${t.title}" (${t.id})`;

/** Repository paths a brief names, for the slices' map of who owns what. */
const PATH = /(?<![\w/.-])(?:[\w.-]+\/)*[\w-]+\.(?:py|pyi|ts|tsx|js|jsx|mjs|cjs|go|rs|java|kt|rb|php|c|h|cc|cpp|hpp|cs|swift|scala)\b/g;
const MAX_PATHS = 6;

const NOTED = 'Plan shape:';

/** Where the notes Ordewell appends begin: this module's, and the chain review's, which names tasks by title. */
const APPENDED = /Plan (?:shape|revision):/;

/** A merged task's brief: the line each slice's brief starts under, and the done criterion after the last. */
const SECTION = /^Slice \d+ of \d+: .*$/m;
const MERGED_DONE = 'This task is done when every slice above meets its own brief\'s done criterion.';

const pathsIn = (text: string) => [...new Set(text.match(PATH) ?? [])].slice(0, MAX_PATHS);

/**
 * From the brief as the planner wrote it: a note already appended names other
 * tasks' paths. A merged task's brief is read slice by slice, as the planner
 * wrote each, so it names what its slices named and sizes as they summed.
 */
function namedPaths(t: Task): string[] {
  const own = (t.prompt ?? '').split(APPENDED)[0];
  if (!t.mergedSlices?.length) return pathsIn(own);
  return [...new Set(own.split(MERGED_DONE)[0].split(SECTION).slice(1).flatMap(pathsIn))];
}

function ownershipTable(shape: FanOutShape): string {
  return [...shape.gates, ...shape.slices].map((t) => {
    const paths = namedPaths(t);
    return `- ${ref(t)}${paths.length ? `: ${paths.join(', ')}` : ''}`;
  }).join('\n');
}

/** The most a slice's table holds: every slice carries it, so a plan of forty slices would put kilobytes in each brief. */
export const SLICE_TABLE_MAX = 2000;

/**
 * A slice's table: one line a task, with the first path its brief names, cut
 * at {@link SLICE_TABLE_MAX} with a line saying how many more there are and
 * where the rest is: the opening task's module map, which its own note's
 * whole table lets it write.
 */
function sliceTable(shape: FanOutShape): string {
  const lines = [...shape.gates, ...shape.slices].map((t) => {
    const [first] = namedPaths(t);
    return `- ${ref(t)}${first ? `: ${first}` : ''}`;
  });
  const gate = shape.gates[0];
  const more = (n: number) => (gate
    ? `- … and ${n} more, each with the paths it owns in the module map at the end of ${ref(gate)}'s report.`
    : `- … and ${n} more, not listed here: a module your brief does not name is another task's.`);
  if (lines.join('\n').length <= SLICE_TABLE_MAX) return lines.join('\n');
  const kept: string[] = [];
  for (const line of lines) {
    if ([...kept, line, more(lines.length - kept.length - 1)].join('\n').length > SLICE_TABLE_MAX) break;
    kept.push(line);
  }
  return [...kept, more(lines.length - kept.length)].join('\n');
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
    sliceTable(shape),
    `Your scope is this brief's. You are done when the code in your scope is written and its tests pass, except tests that fail only because they call code another slice owns that has not landed yet, or that ask for behaviour the repository does not let you derive. Run those once, list each as a finding with the module it waits for or why it cannot be derived, and end with status done: they are ${ref(closer)}'s. Take in another slice's work once it has landed. Do not write, stub or shim another slice's code to make those tests pass, and do not keep iterating on them. End with status failed only when the code in your scope is not in place.`,
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

/** What a slice's size was read from: the lines of the test files its brief names, or of every file it names. */
export type SliceMeasure = 'test' | 'named';

export interface SlicesOrdered {
  /** The plan, its slices of each level largest first; the same array when nothing was sized. */
  tasks: Task[];
  /** Undefined when no file a slice's brief names could be read: nothing was reordered. */
  measure?: SliceMeasure;
  /** How many slices changed place. */
  moved: number;
}

/** A file larger than this, in KB or in lines, is skipped: generated data or a vendored bundle says nothing of a slice's work. */
const MAX_SIZED_KB = 512;
const MAX_SIZED_LINES = 20_000;
/** The most files a plan's slices are sized by; a plan that names more is left in the planner's order. */
export const MAX_SIZED_FILES = 200;

/** A test file by its name or a directory it sits in, in the usual layouts of the languages {@link PATH} reads. */
const TEST_FILE = /(?:^|\/)(?:test[_.-][^/]*|[^/]*[_.-](?:test|spec)s?\.\w+|conftest\.py)$|(?:^|\/)(?:[\w-]*[_-])?(?:tests?|specs?|__tests__)\//;

/** A file's lines as the planner's read reports them, numbered `N|`, or undefined when it was not read whole. */
async function lineCount(fs: Pick<IFileSystem, 'readFile'>, path: string): Promise<number | undefined> {
  // A read that throws sizes nothing: ordering must never cost the plan.
  const r = await fs.readFile(path, { maxBytes: MAX_SIZED_KB, limit: MAX_SIZED_LINES }).catch(() => undefined);
  if (!r?.success || r.truncated || r.refused) return undefined;
  if (r.output === '') return 0;
  const last = /^\s*(\d+)\|/.exec(r.output.slice(r.output.lastIndexOf('\n') + 1));
  return last ? Number(last[1]) : undefined;
}

interface SliceSizes {
  measure: SliceMeasure;
  /** Every slice's size, nothing for a file that could not be read. */
  size: Map<string, number>;
  /** The slices with a file read: one without has no size, only nothing. */
  sized: Set<string>;
}

/**
 * Each slice's size: the lines of the test files its brief names, or of
 * every file it names when no slice names a test file that exists; a file
 * several briefs name is shared equally among them. Undefined when no file
 * could be read, or when the slices name more than {@link MAX_SIZED_FILES}.
 */
async function sliceSizes(slices: readonly Task[], fs: Pick<IFileSystem, 'readFile'>): Promise<SliceSizes | undefined> {
  const lines = new Map<string, number | undefined>();
  const sizes = async (counts: (path: string) => boolean): Promise<Omit<SliceSizes, 'measure'> | undefined> => {
    // A path out of the workspace would ask the user to approve the read (ADR-0008). The
    // workspace check reads any path whose relative form starts `..` as out, `...tests/x.py` too.
    const named = new Map(slices.map((s) => [s.id, namedPaths(s).filter((p) => counts(p) && !path.posix.normalize(p).startsWith('..'))]));
    const owners = new Map<string, number>();
    for (const paths of named.values()) for (const p of paths) owners.set(p, (owners.get(p) ?? 0) + 1);
    const unread = [...owners.keys()].filter((p) => !lines.has(p));
    // Part of a plan's files would size the slices listed first and leave the rest at nothing.
    if (lines.size + unread.length > MAX_SIZED_FILES) return undefined;
    for (const p of unread) lines.set(p, await lineCount(fs, p));
    if (![...owners.keys()].some((p) => lines.get(p) !== undefined)) return undefined;
    return {
      size: new Map([...named].map(([id, paths]) => [id, paths.reduce((sum, p) => sum + (lines.get(p) ?? 0) / owners.get(p)!, 0)])),
      sized: new Set([...named].filter(([, paths]) => paths.some((p) => lines.get(p) !== undefined)).map(([id]) => id)),
    };
  };
  // On recorded runs the lines of a slice's test files predicted its time best;
  // with no test file to read, the files its brief names come next.
  const byTests = await sizes((p) => TEST_FILE.test(p));
  if (byTests) return { measure: 'test', ...byTests };
  const byNamed = await sizes(() => true);
  return byNamed && { measure: 'named', ...byNamed };
}

/**
 * The plan with each level's slices started largest first: ready tasks start
 * in plan order, a few at a time, so a long slice the planner listed late set
 * when the whole fan-out ended (ADR-0072 R6). Sized by {@link sliceSizes}.
 * Only the order of slices of one level changes, each taking the place and
 * `order` of the one it displaced; ties keep the planner's order.
 */
export async function largestSlicesFirst(tasks: Task[], fs: Pick<IFileSystem, 'readFile'>, shape: FanOutShape = fanOutShape(tasks)): Promise<SlicesOrdered> {
  const unchanged: SlicesOrdered = { tasks, moved: 0 };
  if (!shape.wide) return unchanged;
  const sized = await sliceSizes(shape.slices, fs);
  if (!sized) return unchanged;
  const { size, measure } = sized;
  const level = graph(tasks)!.level;
  const out = [...tasks];
  let moved = 0;
  for (const l of new Set(shape.slices.map((s) => level.get(s.id)!))) {
    const places = tasks.flatMap((t, i) => (size.has(t.id) && level.get(t.id) === l ? [i] : []));
    const sorted = places.map((i) => tasks[i]).sort((a, b) => size.get(b.id)! - size.get(a.id)!);
    places.forEach((i, k) => {
      if (sorted[k] === tasks[i]) return;
      moved++;
      out[i] = { ...sorted[k], order: tasks[i].order };
    });
  }
  return { tasks: moved ? out : tasks, measure, moved };
}

export interface SlicesMerged {
  /** The plan with small sibling slices merged; the same array when nothing was. */
  tasks: Task[];
  /** How many slices of the levels merged became how many tasks; absent when nothing was merged. */
  merged?: { from: number; to: number; measure: SliceMeasure };
}

/** A note splits a brief into what the planner wrote and what Ordewell appended after it. */
function ownAndNotes(prompt: string): [string, string | undefined] {
  const at = prompt.search(APPENDED);
  return at < 0 ? [prompt, undefined] : [prompt.slice(0, at).trimEnd(), prompt.slice(at)];
}

/**
 * One task for slices that share their dependencies, dependents, runner,
 * model, mode and skills: the first one's id and fields, each brief whole
 * under its own title in plan order, one done criterion over them all, and
 * the notes appended to any of them last, as they were.
 */
function mergedTask(members: readonly Task[]): Task {
  const [first, ...rest] = members;
  const split = members.map((m) => ownAndNotes(m.prompt ?? ''));
  const notes = [...new Set(split.flatMap(([, n]) => (n ? [n] : [])))];
  const stories = [...new Set(members.flatMap((m) => m.userStoriesCovered ?? []))];
  return {
    ...first,
    title: members.map((m) => m.title).join('; '),
    description: members.map((m) => m.description).filter(Boolean).join('\n\n'),
    prompt: [
      `This task covers ${members.length} slices the planner wrote separately, each brief below whole and in order under its own title. Do every one of them in this task.`,
      ...members.map((m, i) => `Slice ${i + 1} of ${members.length}: ${m.title}\n${split[i][0]}`),
      MERGED_DONE,
      ...notes,
    ].join('\n\n'),
    mergedSlices: rest.map((m) => m.id),
    userStoriesCovered: stories.length ? stories : undefined,
  };
}

/**
 * Bins of one level's slices: the smallest bin is merged with the smallest
 * other of its kind, two at a time, while the pair is no larger than `cap`.
 * It stops at twice `limit`; where the cap stops it short of that, at the
 * multiple of `limit` nearest above the fewest bins the cap allows, so the
 * last wave of slots is full, unless that is no fewer than the level held.
 */
function pack(level: readonly Task[], size: (t: Task) => number, kind: (t: Task) => string | undefined, cap: number, limit: number): Task[][] {
  const run = (stopAt: number) => {
    const bins = level.map((t, at) => ({ members: [t], size: size(t), at, kind: kind(t) }));
    while (bins.length > stopAt) {
      const open = bins.filter((b) => b.kind !== undefined).sort((a, b) => a.size - b.size || a.at - b.at);
      let pair: [typeof bins[number], typeof bins[number]] | undefined;
      for (const u of open) {
        const v = open.find((o) => o !== u && o.kind === u.kind);
        if (v && u.size + v.size <= cap) { pair = [u, v]; break; }
      }
      if (!pair) break;
      const [u, v] = pair;
      bins.splice(bins.indexOf(v), 1);
      u.members = [...u.members, ...v.members].sort((a, b) => level.indexOf(a) - level.indexOf(b));
      u.size += v.size;
      u.at = Math.min(u.at, v.at);
    }
    return bins.map((b) => b.members);
  };
  const fewest = run(2 * limit).length;
  const full = Math.ceil(fewest / limit) * limit;
  return run(fewest <= 2 * limit ? 2 * limit : full < level.length ? full : fewest);
}

/**
 * The plan with each crowded level's small slices merged (ADR-0072 R7). A
 * slice costs a fixed run of calls before it does any work, and slices past
 * the run's parallel limit only queue, so on a level of more than twice
 * `parallelLimit` slices, sized as {@link largestSlicesFirst} sizes them, the
 * smallest are merged until the level has about twice the limit. No bin grows
 * past the level's largest slice, which the planner judged one task, and a
 * slice at that size stays alone, as does one with no size. Only slices of one
 * kind merge: the same dependencies and dependents, runner, model, mode,
 * skills, autonomy and type. Every dependency on a merged slice now names the
 * task that covers it.
 */
export async function mergeSmallSlices(tasks: Task[], fs: Pick<IFileSystem, 'readFile'>, parallelLimit: number | undefined, shape: FanOutShape = fanOutShape(tasks)): Promise<SlicesMerged> {
  const unchanged: SlicesMerged = { tasks };
  if (!shape.wide || !parallelLimit || parallelLimit < 1) return unchanged;
  // A brief already noted was shaped: its notes count the slices as they were.
  if (tasks.some((t) => t.prompt?.includes(NOTED))) return unchanged;
  const level = graph(tasks)!.level;
  const levels = new Map<number, Task[]>();
  for (const s of shape.slices) levels.set(level.get(s.id)!, [...(levels.get(level.get(s.id)!) ?? []), s]);
  const crowded = [...levels.entries()].sort(([a], [b]) => a - b).map(([, l]) => l).filter((l) => l.length > 2 * parallelLimit);
  if (crowded.length === 0) return unchanged;
  const sized = await sliceSizes(shape.slices, fs);
  if (!sized) return unchanged;
  let out = tasks;
  let from = 0;
  let to = 0;
  for (const planned of crowded) {
    // Read from the plan as merged so far: an earlier level's merge rewrote this one's dependencies.
    const dependents = new Map<string, string[]>();
    for (const t of flattenTasks(out)) for (const d of new Set(t.dependencies)) dependents.set(d, [...(dependents.get(d) ?? []), t.id]);
    const slices = out.filter((t) => planned.some((p) => p.id === t.id));
    const size = (t: Task) => sized.size.get(t.id) ?? 0;
    const cap = Math.max(...slices.map(size));
    const kind = (t: Task) => (t.prompt === undefined || t.subtasks.length > 0 || t.mergedSlices || !sized.sized.has(t.id) || size(t) >= cap
      ? undefined
      : JSON.stringify([[...new Set(t.dependencies)].sort(), (dependents.get(t.id) ?? []).sort(), t.type, t.assignedRunner, t.assignedModel ?? null,
        t.taskMode ?? null, [...(t.skills ?? [])].sort(), t.autonomy ?? null, t.sliceType ?? null]));
    const bins = pack(slices, size, kind, cap, parallelLimit);
    if (bins.length === slices.length) continue;
    from += slices.length;
    to += bins.length;
    for (const bin of bins) if (bin.length > 1) out = replace(out, bin.map((t) => t.id), [mergedTask(bin)], bin[0].id);
  }
  return from ? { tasks: out, merged: { from, to, measure: sized.measure } } : unchanged;
}
