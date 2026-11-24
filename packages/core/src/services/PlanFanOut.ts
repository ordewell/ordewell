import * as path from 'path';
import type { IFileSystem } from '../interfaces/IFileSystem';
import { runsAsOps, type Task } from '../models/Task';
import { afterAllReader } from './AfterAll';

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
  /**
   * Change tasks that run before the fan-out, first to last: those ordered
   * against every other change task that every slice waits for, and those
   * every slice of the fan-out's level waits for (ADR-0072 R5).
   */
  gates: Task[];
  /** The first gate when every other gate waits for it: the task that makes the project import. A gate after it is a shared module. */
  opening?: Task;
  /** The gates each slice waits for, by slice id, first to last. */
  waits: ReadonlyMap<string, readonly Task[]>;
  /** Change tasks that are not ordered against every other change task, then a change task the closing check waits for that waits for all of those. */
  slices: Task[];
  /** Tasks that wait for every slice and can fix, a loop's check among them: the closing check, which no other waits for, first. */
  closers: Task[];
  /** Dependencies from one slice on another. */
  sliceEdges: number;
  faults: FanOutFault[];
}

const NONE: FanOutShape = { wide: false, width: 0, gates: [], waits: new Map(), slices: [], closers: [], sliceEdges: 0, faults: [] };

/** Every top-level task's ancestors and level, "*" read (ADR-0077), or null for a cycle. Dependencies on no task are left out. */
function graph(tasks: readonly Task[]): { anc: Map<string, Set<string>>; level: Map<string, number> } | null {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const depsOf = afterAllReader(tasks);
  const anc = new Map<string, Set<string>>();
  const level = new Map<string, number>();
  const visiting = new Set<string>();
  const visit = (t: Task): boolean => {
    if (anc.has(t.id)) return true;
    if (visiting.has(t.id)) return false;
    visiting.add(t.id);
    const mine = new Set<string>();
    let deepest = 0;
    for (const id of depsOf(t)) {
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
 * gates. So is a change task every slice of the fan-out's level waits for (the
 * level holding the most of the rest, the first on a tie, not counting a task
 * every deeper one waits for), though tasks beside it do not wait for it: a
 * shared module set beside ones the slices do not all need, or a core module
 * beside a few slices. The rest of the change tasks are its slices. A closer is a task that
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
  // A task every slice of the fan-out's level waits for runs before the fan-out,
  // whatever runs beside it: a slice would read it as one of them. The level is
  // the one holding the most of the rest, the first on a tie, counted without the
  // tasks every deeper one waits for, and only a level of a fan-out takes any.
  // Those deeper must hold a fan-out's level: a last task that waits for only
  // some slices would otherwise make the slices it waits for such tasks, and
  // the fan-out's level the narrower one left.
  const lv = (t: Task) => g.level.get(t.id)!;
  const holdsFanOut = (ts: readonly Task[]) => {
    const per = new Map<number, number>();
    for (const s of ts) per.set(lv(s), (per.get(lv(s)) ?? 0) + 1);
    return [...per.values()].some((n) => n >= FAN_OUT_MIN);
  };
  const deeperAll = new Set(parallel.filter((t) => {
    const deeper = parallel.filter((s) => lv(s) > lv(t));
    return holdsFanOut(deeper) && deeper.every((s) => anc(s).has(t.id));
  }));
  const count = new Map<number, number>();
  for (const s of parallel) if (!deeperAll.has(s)) count.set(lv(s), (count.get(lv(s)) ?? 0) + 1);
  const [fan, most] = [...count].reduce((best, c) => (c[1] > best[1] || (c[1] === best[1] && c[0] < best[0]) ? c : best), [0, 0]);
  const fanned = parallel.filter((s) => lv(s) === fan && !deeperAll.has(s));
  const before = new Set(most >= FAN_OUT_MIN ? parallel.filter((t) => lv(t) < fan && fanned.every((s) => anc(s).has(t.id))) : []);
  parallel = parallel.filter((t) => !before.has(t));
  const gates = [...[...spine].filter((t) => parallel.every((s) => anc(s).has(t.id))), ...before].sort(byLevel);
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
  const opening = gates.length > 0 && gates.slice(1).every((t) => anc(t).has(gates[0].id)) ? gates[0] : undefined;
  const waits = new Map(slices.map((s) => [s.id, gates.filter((t) => anc(s).has(t.id))]));
  const faults: FanOutFault[] = [];
  // A later gate that waits for the opening task alone (an install or a manual step
  // aside) is a shared module the slices build on, not a second opening task.
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const outside = (id: string) => { const d = byId.get(id); return !d || runsAsOps(d) || d.type === 'user'; };
  if (opening && gates.slice(1).some((t) => !t.dependencies.every((d) => d === opening.id || outside(d)))) faults.push('serial-opening');
  if (!opening) faults.push('no-opening');
  if (closers.length === 0) faults.push('no-closing');
  return { wide, width, gates, ...(opening ? { opening } : {}), waits, slices, closers, sliceEdges, faults };
}

const ref = (t: Pick<Task, 'title' | 'id'>) => `"${t.title}" (${t.id})`;
const refs = (ts: readonly Pick<Task, 'title' | 'id'>[]) => (ts.length < 2 ? ts.map(ref).join('') : `${ts.slice(0, -1).map(ref).join(', ')} and ${ref(ts[ts.length - 1])}`);

/** How many slices wait for a gate. */
const waitingFor = (shape: FanOutShape, gate: Task) => shape.slices.filter((s) => shape.waits.get(s.id)?.includes(gate)).length;

/** Repository paths a brief names, for the slices' map of who owns what. */
const EXTENSIONS = 'py|pyi|ts|tsx|js|jsx|mjs|cjs|go|rs|java|kt|rb|php|c|h|cc|cpp|hpp|cs|swift|scala';
const PATH = new RegExp(`(?<![\\w/.-])(?:[\\w.-]+\\/)*[\\w-]+\\.(?:${EXTENSIONS})\\b`, 'g');
/** A listed path that is one of those files, whole. */
const FILE = new RegExp(`^(?:[\\w.-]+\\/)*[\\w-]+\\.(?:${EXTENSIONS})$`);
/** The most paths a task's line in the notes' tables lists; sizing reads every path. */
const MAX_PATHS = 6;

const NOTED = 'Plan shape:';

/** Where the notes Ordewell appends begin: this module's, and the chain review's, which names tasks by title. */
const APPENDED = /Plan (?:shape|revision):/;

/**
 * A merged task's brief, as builds that merged small slices wrote it (ADR-0072
 * R7): a plan saved by one still holds them. The line each slice's brief
 * starts under, and the done criterion after the last.
 */
const SECTION = /^Slice \d+ of \d+: .*$/m;
const MERGED_DONE = 'This task is done when every slice above meets its own brief\'s done criterion.';

const pathsIn = (max: number) => (text: string) => [...new Set(text.match(PATH) ?? [])].slice(0, max);

/**
 * From the brief as the planner wrote it: a note already appended names other
 * tasks' paths. A merged task's brief is read slice by slice, as the planner
 * wrote each, so it names what its slices named and sizes as they summed.
 */
function briefTexts(t: Task): string[] {
  const own = (t.prompt ?? '').split(APPENDED)[0];
  return t.mergedSlices?.length ? own.split(MERGED_DONE)[0].split(SECTION).slice(1) : [own];
}

/** The paths a brief names, at most `max` a slice's brief. */
function namedPaths(t: Task, max = MAX_PATHS): string[] {
  return [...new Set(briefTexts(t).flatMap(pathsIn(max)))];
}

/** A word of a brief that may be a repository path, a directory's with or without its trailing slash. */
const WORD = /(?<![\w/.-])[\w.-]+(?:\/[\w.-]+)*\/?/g;
/** A test directory's own name, as {@link TEST_FILE} reads one inside a path. */
const TEST_DIR_NAME = /^(?:[\w-]*[_-])?(?:tests?|specs?|__tests__)$/;

/**
 * The test directories a brief names (`pkg/flow/tests/`, `pkg/flow/tests`):
 * a brief that points at its tests by their directory names no file of them.
 * A bare `tests` is a word of prose, so only a path with a slash counts.
 */
function namedTestDirs(t: Task): string[] {
  const dirs = briefTexts(t).flatMap((text) => (text.match(WORD) ?? []).flatMap((word) => {
    const w = word.replace(/\.+$/, '');
    if (!w.includes('/')) return [];
    const dir = path.posix.normalize(w).replace(/\/$/, '');
    return TEST_DIR_NAME.test(path.posix.basename(dir)) && !dir.startsWith('..') && !path.posix.isAbsolute(dir) ? [dir] : [];
  }));
  return [...new Set(dirs)];
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
  const gate = shape.opening;
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

/** What every task before the slices is done by, besides its brief: the slices start from the tree it lands. */
const COLLECTS = 'the test command the slices\' briefs run (the project\'s own, if they name none) collects its tests without an error, though tests may still fail';
// Two checks, named: a note that said "run both" had an opening run the whole suite as part of its own criterion.
// A fan-out with no closing check has no task to name: the slices alone run the tests.
const shown = (shape: FanOutShape) => `run two checks, building or importing the project and a collection-only run of the test runner where it has one (pytest --collect-only, for example). The full test suite is not part of this check: ${shape.closers.length > 0 ? 'the slices and the closing check run the tests' : 'the slices run their own tests'}. Put each command and the last lines of its output in your report`;

/**
 * The opening task's note: the slices wait for it, so it is short, it leaves
 * the project importing and its tests collecting, whoever owns the file in
 * the way, unless what stops them is outside the repository's code, and its
 * report carries the map they start from.
 */
export function openingNote(shape: FanOutShape): string {
  const gate = shape.opening ?? shape.gates[0];
  return [
    `Plan shape: ${gate ? waitingFor(shape, gate) : shape.slices.length} slices wait for this task to land before any of them starts, and they start from the tree you land. Besides your brief's own criterion, you are done only when the project builds or imports and ${COLLECTS}: ${shown(shape)}. For that alone you may edit any file, whichever task below owns it: add only the smallest placeholder that lets it import (a missing name, a function that raises NotImplementedError or its like), and list each placeholder in your summary with the task that owns it. Leave everything else in a module a slice owns to that slice, and finish it as soon as your brief allows. End with status failed when the project still does not import or its tests do not collect for a cause in the repository's code, saying what stops them. A cause outside that code which no placeholder fixes, such as a dependency that is not installed, is not yours to fix: report it as a finding with the command and its output, and end with status done. End your report with a map the slices read before they explore: for each module the tests import, its path, its public names, and the task below that owns it. Say in your summary that the map is in your report. The tasks and the paths their briefs name:`,
    ownershipTable(shape),
  ].join('\n');
}

/** Another task before the slices: they start from the tree it lands too, so it leaves the import and the collection no worse than it found them. */
export function gateNote(shape: FanOutShape, gate: Task): string {
  return `Plan shape: ${waitingFor(shape, gate)} slices wait for this task to land before they start, and they start from the tree you land, so finish as soon as your brief allows and leave every module a slice owns to that slice. Besides your brief's own criterion, you are done only when your change leaves the project building or importing and ${COLLECTS}, as it did when you started or better: ${shown(shape)}.`;
}

/**
 * A slice's note: its own scope is its done criterion, and what needs another
 * slice's work is the closing check's. It names the tasks before the slices
 * that this slice waits for; with no slice given, those every slice waits for.
 * With no closing check, the two clauses that would name it are left out.
 */
export function sliceNote(shape: FanOutShape, slice?: Task): string {
  const after = slice ? shape.waits.get(slice.id) ?? [] : shape.gates.filter((t) => shape.slices.every((s) => shape.waits.get(s.id)?.includes(t)));
  const map = shape.opening && after.includes(shape.opening) ? shape.opening : undefined;
  const closer = shape.closers[0] as Task | undefined;
  return [
    `Plan shape: this task is one of ${shape.slices.length} slices${after.length ? ` that start once ${refs(after)} ${after.length === 1 ? 'has' : 'have'} landed` : ''}${closer ? `, and ${ref(closer)} runs the whole test suite once every slice has ended` : ''}.${map ? ` Read the module map at the end of ${ref(map)}'s report (read, with include_report) before you explore.` : ''} The tasks and the paths their briefs name:`,
    sliceTable(shape),
    `Your scope is this brief's. You are done when the code in your scope is written and its tests pass, except tests that fail only because they call code another slice owns that has not landed yet, or that ask for behaviour the repository does not let you derive. Run those once, list each as an \`info\` finding that cites, by task reference, the slice it waits for, or says why it cannot be derived, and end with status done${closer ? `: they are ${ref(closer)}'s` : ''}. Severity \`blocker\` is for a defect in code that has landed and stops you, given with the file and the input. Take in another slice's work once it has landed. Do not write, stub or shim another slice's code to make those tests pass, and do not keep iterating on them. End with status failed only when the code in your scope is not in place.`,
  ].join('\n');
}

/**
 * The closing check's note: it runs once the slices have ended, and some may
 * not have landed. With `unnamed`, the test directories no brief names
 * anything of ({@link unnamedTests}), it is told the code they test is its own.
 */
export function closingNote(shape: FanOutShape, unnamed: readonly UnnamedTests[] = []): string {
  const base = `Plan shape: this check runs after the ${shape.slices.length} slices. Read each slice's handoff with read: a slice that ended done lists the tests it left to you, and a slice that did not land (it failed and was skipped) left its module unwritten here, so write that module from its brief, its handoff and the tests. Run the whole test suite, fix what fails, and report each test that still fails with its reason.`;
  return unnamed.length ? `${base} ${unnamedSentence(unnamed)}` : base;
}

/** A test directory no brief names anything of, and how many test files it holds. */
export interface UnnamedTests {
  dir: string;
  files: number;
}

/** The most characters the closing check's list of unnamed test directories takes. */
export const UNNAMED_MAX = 600;

/** The longest the listings that find them may take together; a larger workspace gets no list. */
export const UNNAMED_BUDGET_MS = 5000;

function unnamedSentence(unnamed: readonly UnnamedTests[]): string {
  const head = 'No task\'s brief names these tests, nor any path in the package they test, so that code is yours too: write it once the slices\' work is in, and run them with the rest:';
  const item = (u: UnnamedTests) => `${u.dir} (${u.files} test file${u.files === 1 ? '' : 's'})`;
  const cut = (kept: readonly string[], n: number) =>
    `${head} ${kept.length ? `${kept.join(', ')}, and ${n} more` : n} director${n === 1 ? 'y' : 'ies'}, which a run of the whole suite shows.`;
  const all = `${head} ${unnamed.map(item).join(', ')}.`;
  if (all.length <= UNNAMED_MAX) return all;
  const kept: string[] = [];
  for (const u of unnamed) {
    if (cut([...kept, item(u)], unnamed.length - kept.length - 1).length > UNNAMED_MAX) break;
    kept.push(item(u));
  }
  return cut(kept, unnamed.length - kept.length);
}

/** A task's part in a fan-out: the note its brief gets, and what the supervisor's wake about it says it is. */
export type FanOutRole = 'opening' | 'gate' | 'slice' | 'closing';

/**
 * Which task plays which role in a plan that fans out, none otherwise. Each
 * role stands on its own (ADR-0072 R5): a plan with no closing check still has
 * its opening task, its other tasks before the slices and its slices, since
 * what each is told is true without the others. The closing role goes to the
 * closing check, or to the AI tasks of its loop's body when the check is a
 * script or read-only, since a check that cannot edit leaves the fixing to them.
 * With no closing check, fewer last tasks than a fan-out that wait for several
 * slices get no role: such a task gathers only some slices' work, as a last
 * check does, and a slice's note would forbid it the fixing it is there for.
 * A task after one slice alone carries that slice's module on, and stays one.
 */
export function fanOutRoles(shape: FanOutShape): Map<string, FanOutRole> {
  const roles = new Map<string, FanOutRole>();
  if (!shape.wide) return roles;
  for (const g of shape.gates) roles.set(g.id, g === shape.opening ? 'opening' : 'gate');
  const ids = new Set(shape.slices.map((s) => s.id));
  const lastChecks = shape.slices.filter((s) => new Set(s.dependencies.filter((d) => ids.has(d))).size > 1 && !shape.slices.some((o) => o.dependencies.includes(s.id)));
  const unroled = new Set(shape.closers.length === 0 && lastChecks.length < FAN_OUT_MIN ? lastChecks : []);
  for (const s of shape.slices) if (!unroled.has(s)) roles.set(s.id, 'slice');
  const closer = shape.closers[0] as Task | undefined;
  if (closer) for (const id of closer.type === 'ai' && !closer.readOnly ? [closer.id] : closer.loop?.body ?? []) roles.set(id, 'closing');
  return roles;
}

/** How each role's note opens, as {@link withShapeNotes} writes it: a line of its own, after the brief. */
const NOTE_HEADS: ReadonlyArray<readonly [FanOutRole, RegExp]> = [
  ['opening', /^Plan shape: \d+ slices wait for this task to land before any of them starts\b/m],
  ['gate', /^Plan shape: \d+ slices wait for this task to land before they start\b/m],
  ['slice', /^Plan shape: this task is one of \d+ slices\b/m],
  ['closing', /^Plan shape: this check runs after the \d+ slices\b/m],
];

/**
 * The role a task's brief was told by its note, none when it holds no note.
 * Read from the note, not the plan's shape: only an API planner's one-shot plan
 * is noted, and a plan edited since may give a task another role than it was told.
 */
export function notedRole(task: Pick<Task, 'prompt'>): FanOutRole | undefined {
  const prompt = task.prompt;
  if (!prompt?.includes(NOTED)) return undefined;
  return NOTE_HEADS.find(([, head]) => head.test(prompt))?.[0];
}

/**
 * Each role in a few words, as a wake about its task names it: the supervisor
 * judges a task by its brief, and a role's note gives it more room than the
 * brief's own words do (the opening task may edit any file to make the project
 * import), so a wake that left it out had a supervisor revert what the note allowed.
 */
export const FAN_OUT_ROLE_WORDS: Readonly<Record<FanOutRole, string>> = {
  opening: 'the opening task, which may edit any file to make the project import and its tests collect',
  gate: 'a task the slices wait for, which must leave the import and the test collection no worse',
  slice: 'a slice, done once the code in its own scope is in place',
  closing: 'the closing check, which runs the whole test suite after the slices',
};

/**
 * The plan with each role's note appended to its brief, last, as a revision
 * note is (see {@link fanOutRoles}). A plan that does not fan out comes back
 * as the same array, and so does one whose every brief is noted already.
 */
export function withShapeNotes(tasks: Task[], shape: FanOutShape = fanOutShape(tasks), unnamed: readonly UnnamedTests[] = []): Task[] {
  const roles = fanOutRoles(shape);
  if (roles.size === 0) return tasks;
  // The shape's own tasks: a gate's count of the slices waiting for it is read by identity.
  const byId = new Map([...shape.gates, ...shape.slices].map((t) => [t.id, t]));
  const noteOf = (id: string, role: FanOutRole): string => {
    switch (role) {
      case 'opening': return openingNote(shape);
      case 'gate': return gateNote(shape, byId.get(id)!);
      case 'slice': return sliceNote(shape, byId.get(id));
      case 'closing': return closingNote(shape, unnamed);
    }
  };
  const notes = new Map([...roles].map(([id, role]) => [id, noteOf(id, role)]));
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
  /** How many tasks before the slices moved ahead of the slices of their level. */
  gatesFirst?: number;
}

/** A file larger than this, in KB or in lines, is skipped: generated data or a vendored bundle says nothing of a slice's work. */
const MAX_SIZED_KB = 512;
const MAX_SIZED_LINES = 20_000;
/**
 * The most files a plan's slices are sized by; a plan that names more is left
 * in the planner's order. A slice names its own test files, often a dozen or
 * more, and a library's plan holds thirty slices or more.
 */
export const MAX_SIZED_FILES = 1000;

/** A test file by its name or a directory it sits in, in the usual layouts of the languages {@link PATH} reads. */
const TEST_FILE = /(?:^|\/)(?:test[_.-][^/]*|[^/]*[_.-](?:test|spec)s?\.\w+|conftest\.py)$|(?:^|\/)(?:[\w-]*[_-])?(?:tests?|specs?|__tests__)\//;

/** A file's lines as the planner's read reports them, numbered `N|`, or undefined when it was not read whole. */
async function lineCount(fs: SizingFileSystem, path: string): Promise<number | undefined> {
  // A read that throws sizes nothing: ordering must never cost the plan.
  const r = await fs.readFile(path, { maxBytes: MAX_SIZED_KB, limit: MAX_SIZED_LINES }).catch(() => undefined);
  if (!r?.success || r.truncated || r.refused) return undefined;
  if (r.output === '') return 0;
  const last = /^\s*(\d+)\|/.exec(r.output.slice(r.output.lastIndexOf('\n') + 1));
  return last ? Number(last[1]) : undefined;
}

/** What sizing reads through: the planner's file system, and its glob, where it has one, to list a test directory a brief names. */
export type SizingFileSystem = Pick<IFileSystem, 'readFile'> & Partial<Pick<IFileSystem, 'glob'>>;

/** The most directory listings a plan's sizing makes; a plan that needs more lists none and is sized by the paths its briefs name whole. */
export const MAX_SIZED_LISTINGS = 200;

/**
 * The files under a directory whose name `pattern` matches, by the
 * workspace's paths, as the planner's glob lists them; undefined when it has
 * no glob, or the listing failed or was cut short at `most`, since part of a
 * directory would size its slice by chance. The daemon's PoolFileSystem, the
 * one the API planner's one-shot plans are shaped through, and VsCodeFileSystem
 * for a directory below the workspace, list each file relative to that directory.
 */
async function filesUnder(fs: SizingFileSystem, dir: string, pattern: string, most: number): Promise<string[] | undefined> {
  if (!fs.glob) return undefined;
  const r = await fs.glob(pattern, { path: dir, headLimit: most }).catch(() => undefined);
  if (!r?.success || r.truncated || r.refused) return undefined;
  return [...new Set(r.output.split('\n').flatMap((row) => {
    const p = row.trim().replace(/\\/g, '/');
    if (!p || path.posix.isAbsolute(p) || /^[A-Za-z]:/.test(p) || p.startsWith('..')) return [];
    // Joined, not concatenated: a row listed from `.` must read as the same file found from a deeper directory.
    const full = path.posix.join(dir, p);
    return FILE.test(full) ? [full] : [];
  }))];
}

/**
 * Where a brief's bare test-file names (`test_flow.py`) can be looked for:
 * the directories of the paths it names whole and the test directories it names.
 */
function bareTestNames(t: Task): { names: string[]; dirs: string[] } {
  const named = namedPaths(t, Infinity).filter((p) => !path.posix.normalize(p).startsWith('..'));
  const whole = named.filter((p) => p.includes('/'));
  // A bare name beside the same file's full path is that file.
  const known = new Set(whole.map((p) => path.posix.basename(p)));
  const names = named.filter((p) => !p.includes('/') && TEST_FILE.test(p) && !known.has(p));
  const dirs = [...new Set([...whole.map((p) => path.posix.dirname(path.posix.normalize(p))), ...namedTestDirs(t)])];
  return { names, dirs: names.length ? dirs : [] };
}

/**
 * Every listing sizing reads: each named test directory's test files, and for
 * each bare test-file name the one file of that name under the brief's
 * directories, where there is exactly one. None when they would be more than
 * {@link MAX_SIZED_LISTINGS}.
 */
async function listings(slices: readonly Task[], fs: SizingFileSystem) {
  const testDirs = [...new Set(slices.flatMap(namedTestDirs))];
  const bare = new Map(slices.map((s) => [s.id, bareTestNames(s)]));
  const lookups = [...new Set([...bare.values()].flatMap(({ names, dirs }) => names.flatMap((n) => dirs.map((d) => JSON.stringify([d, n])))))];
  const listed = new Map<string, string[]>();
  const found = new Map<string, string[] | undefined>();
  if (fs.glob && testDirs.length + lookups.length <= MAX_SIZED_LISTINGS) {
    for (const dir of testDirs) listed.set(dir, ((await filesUnder(fs, dir, '**/*', MAX_SIZED_FILES)) ?? []).filter((p) => TEST_FILE.test(p)));
    // Two rows are enough to know the name is not one file's.
    for (const key of lookups) {
      const [dir, name] = JSON.parse(key) as [string, string];
      found.set(key, (await filesUnder(fs, dir, `**/${name}`, 2))?.filter((p) => path.posix.basename(p) === name));
    }
  }
  /** A bare name read as the one file of that name under the brief's directories, else as it was written. */
  const resolve = (s: Task, p: string): string => {
    const { names, dirs } = bare.get(s.id)!;
    if (!names.includes(p)) return p;
    const hits = dirs.map((d) => found.get(JSON.stringify([d, p])));
    if (hits.some((h) => h === undefined)) return p;
    const all = [...new Set(hits.flatMap((h) => h!))];
    return all.length === 1 ? all[0] : p;
  };
  return { listed, resolve };
}

interface SliceSizes {
  measure: SliceMeasure;
  /** Every slice's size, nothing for a file that could not be read. */
  size: Map<string, number>;
  /** The slices with a file read: one without has no size, only nothing. */
  sized: Set<string>;
}

/**
 * Each slice's size: the lines of the test files its brief names, every one
 * of them and those under a test directory it names, or of every file it
 * names when no slice names a test file that exists; a file several briefs
 * name is shared equally among them. Undefined when no file could be read,
 * or when the slices name more than {@link MAX_SIZED_FILES}.
 */
async function sliceSizes(slices: readonly Task[], fs: SizingFileSystem): Promise<SliceSizes | undefined> {
  const lines = new Map<string, number | undefined>();
  const { listed, resolve } = await listings(slices, fs);
  // The notes' tables list a few paths a brief names; a slice's size reads them all,
  // since a brief names its module files first and its tests after them.
  const own = (s: Task, tests: boolean) => [
    // Normalized like the directory listings, so ./x and x are one file, read and shared once.
    ...namedPaths(s, Infinity).map((p) => path.posix.normalize(resolve(s, p))),
    ...(tests ? namedTestDirs(s).flatMap((d) => listed.get(d) ?? []) : []),
  ];
  const sizes = async (tests: boolean, counts: (path: string) => boolean): Promise<Omit<SliceSizes, 'measure'> | undefined> => {
    // A path out of the workspace would ask the user to approve the read (ADR-0008). The
    // workspace check reads any path whose relative form starts `..` as out, `...tests/x.py` too.
    const named = new Map(slices.map((s) => [s.id, [...new Set(own(s, tests))].filter((p) => counts(p) && !path.posix.normalize(p).startsWith('..'))]));
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
  const byTests = await sizes(true, (p) => TEST_FILE.test(p));
  if (byTests) return { measure: 'test', ...byTests };
  const byNamed = await sizes(false, () => true);
  return byNamed && { measure: 'named', ...byNamed };
}

/**
 * The plan with each level's slices started largest first: ready tasks start
 * in plan order, a few at a time, so a long slice the planner listed late set
 * when the whole fan-out ended (ADR-0072 R6). Sized by {@link sliceSizes}.
 * Only the order of slices of one level changes, each taking the place and
 * `order` of the one it displaced; ties keep the planner's order. A task
 * before the slices that sits at a level with slices beside it starts ahead
 * of them, sized or not: they wait for it, and it would wait for a slot.
 */
export async function largestSlicesFirst(tasks: Task[], fs: SizingFileSystem, shape: FanOutShape = fanOutShape(tasks)): Promise<SlicesOrdered> {
  const unchanged: SlicesOrdered = { tasks, moved: 0 };
  if (!shape.wide) return unchanged;
  const sized = await sliceSizes(shape.slices, fs);
  const size = sized?.size;
  const measure = sized?.measure;
  const level = graph(tasks)!.level;
  const gates = new Set(shape.gates.map((t) => t.id));
  const sliceIds = new Set(shape.slices.map((s) => s.id));
  const out = [...tasks];
  let moved = 0;
  let gatesFirst = 0;
  for (const l of new Set(shape.slices.map((s) => level.get(s.id)!))) {
    const places = tasks.flatMap((t, i) => ((sliceIds.has(t.id) || gates.has(t.id)) && level.get(t.id) === l ? [i] : []));
    const rank = (t: Task) => (gates.has(t.id) ? Infinity : size?.get(t.id) ?? 0);
    const sorted = places.map((i) => tasks[i]).sort((a, b) => rank(b) - rank(a) || 0);
    places.forEach((i, k) => {
      if (sorted[k] === tasks[i]) return;
      if (gates.has(sorted[k].id)) gatesFirst++;
      else moved++;
      out[i] = { ...sorted[k], order: tasks[i].order };
    });
  }
  if (!moved && !gatesFirst) return { ...unchanged, ...(measure ? { measure } : {}) };
  return { tasks: out, ...(measure ? { measure } : {}), moved, ...(gatesFirst ? { gatesFirst } : {}) };
}

export interface FanOutShaped {
  /** The plan as it runs; the same array when nothing was moved or noted. */
  tasks: Task[];
  /** The research log's lines, one a step that changed the plan, in the order the steps ran. */
  log: string[];
}

/** The test files' names listed to find the tests no brief names, by the last segment the planner's glob matches: {@link TEST_FILE}'s, but for a file named only by its directory. */
const TEST_GLOBS = ['**/test_*', '**/*_test.*', '**/*.test.*', '**/*_spec.*', '**/*.spec.*'];

/** What `work` settles to within `ms`, undefined past it. */
async function settledWithin<T>(work: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<undefined>((resolve) => { timer = setTimeout(resolve, ms, undefined); })]);
  } finally { clearTimeout(timer); }
}

/** A dotted module name in a brief (`pkg.algorithms.flow`), read as the path it is. */
const DOTTED = /(?<![\w/.-])[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+(?![\w/-])/g;
/** A recursive glob a brief names (`pkg/algorithms/**`): it covers every package below its prefix. */
const RECURSIVE = /(?<![\w/.-])((?:[\w.-]+\/)+)\*\*/g;

/**
 * The package a test file tests: the directory above its test directory, or
 * its own directory when it sits beside the code.
 */
function testedPackage(file: string): string {
  const parts = path.posix.dirname(file).split('/');
  const at = parts.findIndex((p) => TEST_DIR_NAME.test(p));
  return at < 0 ? parts.join('/') : parts.slice(0, at).join('/') || '.';
}

/** A file's name with no extension and no test marker: `tests/test_rdata.py` and `dns/rdata.py` are both `rdata`. */
const stem = (p: string): string => path.posix.basename(p).replace(/\.[^.]*$/, '').replace(/^test_|[_.](?:test|spec)s?$/g, '');

/**
 * The test files no brief of the plan names anything of, by their test
 * directory, largest first: no task names the file, its bare name, its test
 * directory, the package it tests or a path directly in it, a dotted name for one, a
 * file of the name it tests (a flat suite's `tests/test_rdata.py` tests
 * `rdata`), or a recursive glob above it. A brief is read before any appended note. A
 * named directory covers its own package only: a sweep naming `pkg/` covers
 * neither `pkg/sub/` nor its tests. Undefined when the plan's file system has
 * no glob, or a listing failed, passed {@link MAX_SIZED_FILES} or took longer
 * than {@link UNNAMED_BUDGET_MS} in all: part of the tests would name a
 * directory a brief does cover. Only listings are read, never a file, and
 * {@link filesUnder} drops a row outside the workspace.
 */
export async function unnamedTests(tasks: readonly Task[], fs: SizingFileSystem): Promise<UnnamedTests[] | undefined> {
  const files = new Set<string>();
  const deadline = Date.now() + UNNAMED_BUDGET_MS;
  for (const pattern of TEST_GLOBS) {
    const left = deadline - Date.now();
    // A listing runs to its own file system's timeout, far past the budget, so it is not waited for past what is left.
    const found = left > 0 ? await settledWithin(filesUnder(fs, '.', pattern, MAX_SIZED_FILES), left) : undefined;
    // Each listing walks the whole workspace, so a slow one makes the next as slow.
    if (!found || Date.now() > deadline) return undefined;
    for (const f of found) if (TEST_FILE.test(f)) files.add(path.posix.normalize(f));
  }
  if (files.size > MAX_SIZED_FILES) return undefined;
  const texts = tasks.flatMap((t) => [t, ...t.subtasks]).flatMap(briefTexts);
  const named = new Set<string>();
  // A bare word of prose ("flow", "tests", "mylib") is no module's name nor a directory's: only a path, a file or a dotted name says which one it is.
  const paths = new Set<string>();
  const stems = new Set<string>();
  const below: string[] = [];
  for (const text of texts) {
    for (const w of [...(text.match(WORD) ?? []), ...(text.match(DOTTED) ?? []).map((d) => d.replace(/\./g, '/'))]) {
      const written = w.replace(/\.+$/, '');
      const p = path.posix.normalize(written).replace(/\/$/, '');
      if (!p || p.startsWith('..')) continue;
      named.add(p);
      if (written.includes('/') || written.includes('.')) {
        paths.add(p);
        stems.add(stem(p));
      }
    }
    for (const m of text.matchAll(RECURSIVE)) below.push(path.posix.normalize(m[1]).replace(/\/$/, ''));
  }
  const covered = (f: string): boolean => {
    if (named.has(f) || named.has(path.posix.basename(f)) || paths.has(path.posix.dirname(f)) || stems.has(stem(f))) return true;
    const pkg = testedPackage(f);
    if (below.some((b) => pkg === b || pkg.startsWith(`${b}/`))) return true;
    // A path in the package itself, not in a package below it; every file at the root is in no package a flat suite tests.
    return pkg !== '.' && [...paths].some((n) => n === pkg || path.posix.dirname(n) === pkg);
  };
  const byDir = new Map<string, number>();
  for (const f of files) if (!covered(f)) byDir.set(path.posix.dirname(f), (byDir.get(path.posix.dirname(f)) ?? 0) + 1);
  return [...byDir].map(([dir, n]) => ({ dir, files: n })).sort((a, b) => b.files - a.files || (a.dir < b.dir ? -1 : 1));
}

const measured = (m: SliceMeasure) => `the lines of ${m === 'test' ? 'the test files' : 'every file'} their briefs name`;

/**
 * A one-shot plan shaped as it is to run, at no call (ADR-0072 R5-R7). One
 * order, each step reading the plan the step before it left, so the notes and
 * the log describe the plan that runs: the tasks before the slices start
 * ahead of the slices beside them, then the slices largest first (R6); then
 * each role's note is written (R5). No slice is merged with another, however
 * many queue past the parallel limit (R7): replayed on recorded runs, every
 * merge tried started the closing check later. With no file system, a caller
 * with no repository to read, it is only noted.
 */
export async function shapeFanOut(tasks: Task[], fs: SizingFileSystem | undefined, _parallelLimit?: number): Promise<FanOutShaped> {
  const log: string[] = [];
  const shape = fanOutShape(tasks);
  const sized: SlicesOrdered = fs ? await largestSlicesFirst(tasks, fs, shape) : { tasks, moved: 0 };
  if (sized.measure) log.push(`slice order: largest first by ${measured(sized.measure)}; ${sized.moved} of ${shape.slices.length} moved`);
  if (sized.gatesFirst) log.push(`slice order: ${sized.gatesFirst} task${sized.gatesFirst === 1 ? '' : 's'} the slices wait for moved ahead of the slices beside ${sized.gatesFirst === 1 ? 'it' : 'them'}`);
  // Only a closing check is told of them: it is the one task that runs after every slice.
  const closer = shape.closers[0] as Task | undefined;
  const unnamed = fs && closer?.type === 'ai' && closer.prompt !== undefined && !closer.prompt.includes(NOTED) ? (await unnamedTests(sized.tasks, fs)) ?? [] : [];
  const out = withShapeNotes(sized.tasks, fanOutShape(sized.tasks), unnamed);
  if (out !== sized.tasks) {
    const s = fanOutShape(out);
    log.push(`fan-out: ${s.width} at once, ${s.gates.length} before, ${s.closers.length} after${s.faults.length ? `, faults ${s.faults.join(', ')}` : ''}; role notes added`);
    const files = unnamed.reduce((n, u) => n + u.files, 0);
    if (files) log.push(`coverage: ${files} test file${files === 1 ? '' : 's'} in ${unnamed.length} director${unnamed.length === 1 ? 'y' : 'ies'} no brief names, given to the closing check`);
  }
  return { tasks: out, log };
}
