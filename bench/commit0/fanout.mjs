// The fan-out properties of a one-shot plan, checked by script on a plan-only
// run's plan-saved.json (or any { tasks } plan). The graph reading is core's
// fanOutShape (packages/core/src/services/PlanFanOut.ts), restated here since
// the bench imports no core source; fanout.test.mjs pins both on the same plans.
//
//   node bench/commit0/fanout.mjs [--base-broken] <plan-saved.json> ...
//   node bench/commit0/fanout.mjs --review <written.json> <reviewed.json> [<written.json> <reviewed.json> ...]
//
// --review: one JSON line a pair, the plan as first written and the same plan
// after review: each slice's ancestors among the tasks before the slices in
// both (with their median and maximum), `newAncestry` (waits the review added
// that give a task an ancestor it did not have) and `openingCut` (slices that
// lost an ancestor every slice had as written); see reviewedWaits.
//
// --base-broken: the library's base commit does not import or collect its
// tests, so exactly one opening task is required (otherwise at most one).
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

export const FAN_OUT_MIN = 4;

const runsAsOps = (t) => (t.type === 'script' && !t.readOnly) || t.ops === true;

export function fanOutShape(plan) {
  const tasks = Array.isArray(plan?.tasks) ? plan.tasks : [];
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const anc = new Map();
  const level = new Map();
  const visiting = new Set();
  const visit = (t) => {
    if (anc.has(t.id)) return true;
    if (visiting.has(t.id)) return false;
    visiting.add(t.id);
    const mine = new Set();
    let deepest = 0;
    for (const id of t.dependencies ?? []) {
      const dep = byId.get(id);
      if (!dep) continue;
      if (!visit(dep)) return false;
      mine.add(id);
      for (const a of anc.get(id)) mine.add(a);
      deepest = Math.max(deepest, level.get(id));
    }
    visiting.delete(t.id);
    anc.set(t.id, mine);
    level.set(t.id, deepest + 1);
    return true;
  };
  // `ancestors`: each task's transitive dependencies, which the reading is built on.
  const none = { wide: false, width: 0, levels: null, gates: [], opening: null, openings: 0, slices: [], closers: [], shared: [], sliceEdges: 0, faults: [], ancestors: anc };
  for (const t of tasks) if (!visit(t)) return { ...none, cycle: true };
  const body = new Set(tasks.flatMap((t) => t.loop?.body ?? []));
  const change = tasks.filter((t) => (t.type ?? 'ai') === 'ai' && !t.readOnly && !runsAsOps(t) && !t.research && !t.loop && !body.has(t.id));
  const ordered = (a, b) => anc.get(a.id).has(b.id) || anc.get(b.id).has(a.id);
  const spine = new Set(change.filter((t) => change.every((o) => o === t || ordered(t, o))));
  let parallel = change.filter((t) => !spine.has(t));
  const levels = tasks.length ? Math.max(...level.values()) : null;
  if (parallel.length < 2) return { ...none, levels };
  const byLevel = (a, b) => level.get(a.id) - level.get(b.id);
  const edits = (t) => Boolean(t) && (t.type ?? 'ai') === 'ai' && !t.readOnly;
  const closes = (after) => (t) => !body.has(t.id) && t.type !== 'user' && !t.ops
    && (edits(t) || (t.loop?.body ?? []).some((id) => edits(byId.get(id))))
    && after.every((s) => anc.get(t.id).has(s.id));
  // As core: fewer change tasks than a fan-out after every other one are the closing check and what runs beside it.
  if (!tasks.some(closes(parallel))) {
    const ends = parallel.filter((t) => !parallel.some((o) => anc.get(o.id).has(t.id)));
    const rest = parallel.filter((t) => !ends.includes(t));
    if (ends.length < FAN_OUT_MIN && rest.length > 0 && ends.every(closes(rest))) parallel = rest;
  }
  // As core: a task every slice of the fan-out's level waits for runs before the fan-out, the level
  // counted without the tasks every deeper one waits for, and only a level of a fan-out takes any.
  // As core: those deeper must hold a fan-out's level, so a last task waiting for some slices makes none of them such a task.
  const lv = (t) => level.get(t.id);
  const holdsFanOut = (ts) => {
    const per = new Map();
    for (const s of ts) per.set(lv(s), (per.get(lv(s)) ?? 0) + 1);
    return [...per.values()].some((n) => n >= FAN_OUT_MIN);
  };
  const deeperAll = new Set(parallel.filter((t) => {
    const deeper = parallel.filter((s) => lv(s) > lv(t));
    return holdsFanOut(deeper) && deeper.every((s) => anc.get(s.id).has(t.id));
  }));
  const count = new Map();
  for (const s of parallel) if (!deeperAll.has(s)) count.set(lv(s), (count.get(lv(s)) ?? 0) + 1);
  const [fan, most] = [...count].reduce((best, c) => (c[1] > best[1] || (c[1] === best[1] && c[0] < best[0]) ? c : best), [0, 0]);
  const fanned = parallel.filter((s) => lv(s) === fan && !deeperAll.has(s));
  const before = new Set(most >= FAN_OUT_MIN ? parallel.filter((t) => lv(t) < fan && fanned.every((s) => anc.get(s.id).has(t.id))) : []);
  parallel = parallel.filter((t) => !before.has(t));
  const gates = [...[...spine].filter((t) => parallel.every((s) => anc.get(s.id).has(t.id))), ...before].sort(byLevel);
  // As core: the opening task is the first gate when every other gate waits for it.
  const opening = gates.length > 0 && gates.slice(1).every((t) => anc.get(t.id).has(gates[0].id)) ? gates[0] : null;
  const candidates = tasks.filter(closes(parallel)).sort(byLevel);
  // As core: the closing check is the candidate no other waits for, and a change task it waits for is a slice of the last level.
  const last = candidates.filter((c) => !candidates.some((o) => anc.get(o.id).has(c.id)));
  const closer = last[last.length - 1];
  const late = new Set(candidates.filter((c) => closer && c !== closer && spine.has(c) && anc.get(closer.id).has(c.id)));
  const slices = [...parallel, ...candidates.filter((c) => late.has(c))];
  const closers = candidates.filter((c) => !late.has(c)).sort((a, b) => Number(b === closer) - Number(a === closer));
  // As core: a later gate that waits for the opening task alone (an install or a manual step aside) is a shared module.
  const outside = (id) => { const d = byId.get(id); return !d || runsAsOps(d) || d.type === 'user'; };
  const sharedGates = opening ? gates.slice(1).filter((t) => (t.dependencies ?? []).every((d) => d === opening.id || outside(d))) : [];
  const perLevel = new Map();
  for (const s of slices) perLevel.set(level.get(s.id), (perLevel.get(level.get(s.id)) ?? 0) + 1);
  const width = Math.max(...perLevel.values());
  const ids = new Set(slices.map((s) => s.id));
  const sliceEdges = slices.reduce((n, s) => n + new Set((s.dependencies ?? []).filter((d) => ids.has(d))).size, 0);
  // A last-level slice waits for every other one, which makes none of them a module the others build on.
  const shared = [...sharedGates, ...parallel.filter((s) => parallel.some((o) => (o.dependencies ?? []).includes(s.id)))];
  const wide = width >= FAN_OUT_MIN;
  const faults = [];
  if (wide && opening && gates.length > 1 + sharedGates.length) faults.push('serial-opening');
  if (wide && !opening) faults.push('no-opening');
  if (wide && closers.length === 0) faults.push('no-closing');
  return { wide, width, levels, gates, opening, openings: opening ? gates.length - sharedGates.length : 0, slices, closers, shared, sliceEdges, faults, ancestors: anc };
}

export function median(values) {
  if (!values.length) return null;
  const v = [...values].sort((a, b) => a - b);
  const mid = v.length >> 1;
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

const spread = (counts) => ({ median: median(counts), max: counts.length ? Math.max(...counts) : null });

/**
 * A plan as first written and the same plan after review, read by the same
 * fan-out shape (the tasks before the slices, the slices and the closing check
 * told apart as `fanOutShape` tells them, each plan by its own). For every
 * slice of both plans, its ancestors among the tasks before the slices of each
 * plan, direct or transitive, with the median and the maximum of their counts,
 * and two questions about what the review did to the waits:
 *
 * - `newAncestry`: each wait the review added to a task (in both plans) on a
 *   task that was not already one of its ancestors as written, so it gives the
 *   task an ancestor it did not have: `{ task, waitsFor }`.
 * - `openingCut`: each slice that lost an ancestor every slice had as written,
 *   `{ slice, lost }`.
 */
export function reviewedWaits(written, reviewed) {
  const w = fanOutShape(written);
  const r = fanOutShape(reviewed);
  if (w.cycle || r.cycle) return { cycle: true };
  const before = (shape) => new Set(shape.gates.map((g) => g.id));
  const among = (shape, id) => [...shape.ancestors.get(id)].filter((a) => before(shape).has(a)).sort();
  const wrote = new Set(w.slices.map((s) => s.id));
  const slices = r.slices.filter((s) => wrote.has(s.id)).map((s) => ({ id: s.id, written: among(w, s.id), reviewed: among(r, s.id) }));
  const newAncestry = [];
  const old = new Map((written.tasks ?? []).map((t) => [t.id, t]));
  for (const t of reviewed.tasks ?? []) {
    const was = old.get(t.id);
    if (!was) continue;
    for (const d of new Set(t.dependencies ?? [])) {
      if (!(was.dependencies ?? []).includes(d) && !w.ancestors.get(t.id).has(d)) newAncestry.push({ task: t.id, waitsFor: d });
    }
  }
  const every = w.slices.length ? [...w.ancestors.get(w.slices[0].id)].filter((a) => w.slices.every((s) => w.ancestors.get(s.id).has(a))) : [];
  const openingCut = slices.map((s) => ({ slice: s.id, lost: every.filter((a) => !r.ancestors.get(s.id).has(a)).sort() })).filter((c) => c.lost.length);
  return { slices, written: spread(slices.map((s) => s.written.length)), reviewed: spread(slices.map((s) => s.reviewed.length)), newAncestry, openingCut };
}

const brief = (t) => t?.prompt ?? '';

/** Each property, true or false, with the numbers behind it. */
export function fanOutProperties(plan, { baseBroken = false } = {}) {
  const s = fanOutShape(plan);
  const gate = s.opening;
  const closer = s.closers[0];
  const tasks = plan?.tasks ?? [];
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const outside = (id) => { const d = byId.get(id); return !d || runsAsOps(d) || d.type === 'user'; };
  // As core's withShapeNotes: a check that cannot edit has its note on its loop's body.
  const closingBriefs = closer ? ((closer.type ?? 'ai') === 'ai' && !closer.readOnly ? [closer] : tasks.filter((t) => closer.loop?.body?.includes(t.id))) : [];
  const sharedOk = s.shared.length <= 3 && s.shared.every((m) => gate && (m.dependencies ?? []).every((d) => d === gate.id));
  return {
    wide: s.wide,
    numbers: { slices: s.slices.length, width: s.width, levels: s.levels, gates: s.gates.length, opening: gate?.id ?? null, closers: s.closers.length, shared: s.shared.length, sliceEdges: s.sliceEdges, faults: s.faults },
    // The opening task may wait for an install or a manual step, as core's restoring task does.
    P1_oneOpening: baseBroken ? s.openings === 1 && (gate.dependencies ?? []).every((d) => outside(d)) : s.openings <= 1,
    P2_openingFirstAndAlone: s.openings <= 1,
    P3_slicesParallel: s.levels !== null && s.levels <= 4 && sharedOk && s.width >= Math.ceil(0.6 * s.slices.length),
    P4_closingCheck: s.closers.length >= 1,
    P5_ownScopeDone: s.slices.length > 0 && s.slices.every((t) => /Plan shape: this task is one of \d+ slices/.test(brief(t)) && brief(t).includes('end with status done')),
    P6_closingToldOfUnlanded: closingBriefs.length > 0 && closingBriefs.some((t) => brief(t).includes('did not land')),
    P7_openingHandsOffMap: Boolean(gate) && brief(gate).includes('End your report with a map'),
    // Every task the slices wait for is done only when the tree the slices start from imports and collects: the opening task may edit any file for it.
    P8_beforeSlicesImport: s.gates.length > 0 && s.gates.every((t) => /Plan shape: \d+ slices wait for this task/.test(brief(t)) && brief(t).includes('collects its tests without an error'))
      && (!gate || brief(gate).includes('For that alone you may edit any file')),
  };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const args = process.argv.slice(2);
  const baseBroken = args.includes('--base-broken');
  const files = args.filter((a) => !a.startsWith('--'));
  const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
  if (args.includes('--review')) {
    // One JSON line a pair: the plan as first written, then the same plan after review.
    for (let i = 0; i + 1 < files.length; i += 2) console.log(JSON.stringify({ files: [files[i], files[i + 1]], ...reviewedWaits(read(files[i]), read(files[i + 1])) }));
  } else {
    for (const file of files) console.log(JSON.stringify({ file, ...fanOutProperties(read(file), { baseBroken }) }));
  }
}
