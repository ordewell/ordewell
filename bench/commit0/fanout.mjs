// The fan-out properties of a one-shot plan, checked by script on a plan-only
// run's plan-saved.json (or any { tasks } plan). The graph reading is core's
// fanOutShape (packages/core/src/services/PlanFanOut.ts), restated here since
// the bench imports no core source; fanout.test.mjs pins both on the same plans.
//
//   node bench/commit0/fanout.mjs [--base-broken] <plan-saved.json> ...
//
// --base-broken: the library's base commit does not import or collect its
// tests, so exactly one opening task is required (otherwise at most one).
import fs from 'node:fs';

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
  const none = { wide: false, width: 0, levels: null, gates: [], slices: [], closers: [], shared: [], sliceEdges: 0, faults: [] };
  for (const t of tasks) if (!visit(t)) return { ...none, cycle: true };
  const body = new Set(tasks.flatMap((t) => t.loop?.body ?? []));
  const change = tasks.filter((t) => (t.type ?? 'ai') === 'ai' && !t.readOnly && !runsAsOps(t) && !t.research && !t.loop && !body.has(t.id));
  const ordered = (a, b) => anc.get(a.id).has(b.id) || anc.get(b.id).has(a.id);
  const spine = new Set(change.filter((t) => change.every((o) => o === t || ordered(t, o))));
  const slices = change.filter((t) => !spine.has(t));
  const levels = tasks.length ? Math.max(...level.values()) : null;
  if (slices.length < 2) return { ...none, levels };
  const byLevel = (a, b) => level.get(a.id) - level.get(b.id);
  const gates = [...spine].filter((t) => slices.every((s) => anc.get(s.id).has(t.id))).sort(byLevel);
  const closers = tasks.filter((t) => !body.has(t.id) && t.type !== 'user' && !t.ops
    && (t.type !== 'script' || t.loop !== undefined || t.readOnly === true)
    && slices.every((s) => anc.get(t.id).has(s.id))).sort(byLevel);
  const perLevel = new Map();
  for (const s of slices) perLevel.set(level.get(s.id), (perLevel.get(level.get(s.id)) ?? 0) + 1);
  const width = Math.max(...perLevel.values());
  const ids = new Set(slices.map((s) => s.id));
  const sliceEdges = slices.reduce((n, s) => n + new Set((s.dependencies ?? []).filter((d) => ids.has(d))).size, 0);
  const shared = slices.filter((s) => slices.some((o) => (o.dependencies ?? []).includes(s.id)));
  const wide = width >= FAN_OUT_MIN;
  const faults = [];
  if (wide && gates.length >= 2) faults.push('serial-opening');
  if (wide && gates.length === 0) faults.push('no-opening');
  if (wide && closers.length === 0) faults.push('no-closing');
  return { wide, width, levels, gates, slices, closers, shared, sliceEdges, faults };
}

const brief = (t) => t?.prompt ?? '';

/** Each property, true or false, with the numbers behind it. */
export function fanOutProperties(plan, { baseBroken = false } = {}) {
  const s = fanOutShape(plan);
  const gate = s.gates[0];
  const closer = s.closers[0];
  const tasks = plan?.tasks ?? [];
  const closingBriefs = closer ? (closer.type === 'script' ? tasks.filter((t) => closer.loop?.body?.includes(t.id)) : [closer]) : [];
  const sharedOk = s.shared.length <= 3 && s.shared.every((m) => gate && (m.dependencies ?? []).every((d) => d === gate.id));
  return {
    wide: s.wide,
    numbers: { slices: s.slices.length, width: s.width, levels: s.levels, gates: s.gates.length, closers: s.closers.length, shared: s.shared.length, sliceEdges: s.sliceEdges, faults: s.faults },
    P1_oneOpening: baseBroken ? s.gates.length === 1 && (gate.dependencies ?? []).length === 0 : s.gates.length <= 1,
    P2_openingFirstAndAlone: s.gates.length <= 1,
    P3_slicesParallel: s.levels !== null && s.levels <= 4 && sharedOk && s.width >= Math.ceil(0.6 * s.slices.length),
    P4_closingCheck: s.closers.length >= 1,
    P5_ownScopeDone: s.slices.length > 0 && s.slices.every((t) => /Plan shape: this task is one of \d+ slices/.test(brief(t)) && brief(t).includes('end with status done')),
    P6_closingToldOfUnlanded: closingBriefs.length > 0 && closingBriefs.some((t) => brief(t).includes('did not land')),
    P7_openingHandsOffMap: Boolean(gate) && brief(gate).includes('End your report with a map'),
  };
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const args = process.argv.slice(2);
  const baseBroken = args.includes('--base-broken');
  for (const file of args.filter((a) => !a.startsWith('--'))) {
    const plan = JSON.parse(fs.readFileSync(file, 'utf8'));
    console.log(JSON.stringify({ file, ...fanOutProperties(plan, { baseBroken }) }));
  }
}
