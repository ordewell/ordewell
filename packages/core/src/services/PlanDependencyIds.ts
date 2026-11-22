/**
 * Dependencies a one-shot plan writes against ids no task has. A model that
 * numbers its tasks "task-1" will sometimes write "task-01" or "#1" in a
 * dependency; the plan is right and one spelling is off, and failing the whole
 * planning run (and its spend) over it helps nobody. Works on the plan as the
 * model wrote it, before any task is built, so the validator sees real ids.
 *
 * What is resolved is what has one obvious reading: a dependency that, after a
 * normalisation, names exactly one task. Two readings is a guess, and a guess
 * would wire work to the wrong task; those are left for the validator to
 * refuse and the repair loop to put back to the model.
 */

type Json = Record<string, unknown>;

export interface UnknownDependency {
  /** The id the task that wrote it carries, as written. */
  taskId: string;
  title: string;
  dependency: string;
  /** Every id the plan has, in plan order, with its title. */
  valid: { id: string; title: string }[];
}

const isRecord = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' || typeof v === 'number' ? String(v) : undefined);

function walk(tasks: unknown, visit: (task: Json) => void): void {
  if (!Array.isArray(tasks)) return;
  for (const t of tasks) {
    if (!isRecord(t)) continue;
    visit(t);
    walk(t.subtasks, visit);
  }
}

/** Letter case, spaces, a leading "#". */
const plainKey = (s: string): string => s.trim().toLowerCase().replace(/^#\s*/, '');
/** Also a leading "task" word and the zeros that pad a number: "Task 01" and "task-1" are one key. */
const numberedKey = (s: string): string =>
  plainKey(s).replace(/^task[\s\-_:#]*/, '').replace(/\d+/g, (d) => d.replace(/^0+(?=\d)/, ''));
const titleKey = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, ' ');

const KEYS: ((candidate: { id: string; title: string }) => string)[] = [
  (c) => plainKey(c.id),
  (c) => numberedKey(c.id),
  (c) => titleKey(c.title),
];
const KEY_OF_DEPENDENCY: ((s: string) => string)[] = [plainKey, numberedKey, titleKey];

/**
 * Rewrites, in place, each dependency that names no task but has exactly one
 * obvious reading, and returns a line per rewrite. The first normalisation
 * that matches anything decides: when it matches several tasks the dependency
 * stays as written.
 */
export function resolveDependencyIds(plan: unknown): string[] {
  const tasks = isRecord(plan) ? plan.tasks : undefined;
  const candidates: { id: string; title: string }[] = [];
  walk(tasks, (t) => {
    // As written, spaces and all, as the validator keeps an id: a trimmed one would name no task.
    const id = str(t.id);
    if (id) candidates.push({ id, title: str(t.title) ?? '' });
  });
  const known = new Set(candidates.map((c) => c.id));
  const notes: string[] = [];
  walk(tasks, (t) => {
    if (!Array.isArray(t.dependencies)) return;
    const ownId = str(t.id);
    const title = str(t.title) ?? '';
    const next: unknown[] = [];
    for (const dep of t.dependencies) {
      const written = typeof dep === 'string' ? dep : undefined;
      if (written === undefined || known.has(written)) { next.push(dep); continue; }
      let target: { id: string; title: string } | undefined;
      for (const [i, keyOf] of KEY_OF_DEPENDENCY.entries()) {
        const key = keyOf(written);
        if (!key) continue;
        const hits = candidates.filter((c) => KEYS[i](c) === key);
        if (hits.length === 0) continue;
        if (hits.length === 1) target = hits[0];
        break;
      }
      // A task read as depending on itself is a different mistake, named by the validator.
      if (!target || target.id === ownId) { next.push(dep); continue; }
      notes.push(`dependency "${written}" of "${title}" read as "${target.id}" ("${target.title}")`);
      next.push(target.id);
    }
    t.dependencies = next.filter((d, i) => typeof d !== 'string' || next.indexOf(d) === i);
  });
  return notes;
}

/** The dependencies naming no task, once {@link resolveDependencyIds} has done what it can. */
export function unknownDependencies(plan: unknown): UnknownDependency[] {
  const tasks = isRecord(plan) ? plan.tasks : undefined;
  const valid: { id: string; title: string }[] = [];
  walk(tasks, (t) => {
    const id = str(t.id);
    if (id) valid.push({ id, title: str(t.title) ?? '' });
  });
  const known = new Set(valid.map((v) => v.id));
  const found: UnknownDependency[] = [];
  walk(tasks, (t) => {
    if (!Array.isArray(t.dependencies)) return;
    for (const dep of t.dependencies) {
      if (typeof dep === 'string' && !known.has(dep)) found.push({ taskId: str(t.id) ?? '', title: str(t.title) ?? '', dependency: dep, valid });
    }
  });
  return found;
}

function distance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) {
      next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    row = next;
  }
  return row[b.length];
}

/** Up to three ids closest to the one written, nearest first, plan order among equals. */
export function nearestIds(dependency: string, valid: readonly { id: string; title: string }[], count = 3): { id: string; title: string }[] {
  const key = numberedKey(dependency);
  return valid
    .map((v, order) => ({ v, order, d: distance(key, numberedKey(v.id)) }))
    .sort((x, y) => x.d - y.d || x.order - y.order)
    .slice(0, count)
    .map((x) => x.v);
}

/** Past this many ids the whole list is a wall the model skims; the nearest ones carry the point. */
const LISTED_IDS = 40;

/**
 * What the model is told when a dependency names no task: the task, the id,
 * the nearest valid ones, and the ids the plan has, so a re-sent plan can
 * write each dependency exactly as an id.
 */
export function unknownDependencyHint(u: UnknownDependency): string {
  // Its own id would be a dependency on itself, which the validator refuses too.
  const nearest = nearestIds(u.dependency, u.valid.filter((v) => v.id !== u.taskId)).map((n) => `"${n.id}" (${n.title})`).join(', ');
  // With the task's own id the only one, an empty list would read as a broken template.
  const lead = nearest ? `nearest valid ids: ${nearest}` : 'no other task to depend on';
  const ids = u.valid.slice(0, LISTED_IDS).map((v) => `"${v.id}"`).join(', ') + (u.valid.length > LISTED_IDS ? ', ...' : '');
  return `${lead}. Every dependency must be exactly the "id" of a task in the plan you write; the plan had: ${ids}`;
}
