/**
 * From run records to the report: medians and spread per backend, variant and
 * goal, every violation listed with the run it came from, and a verdict per
 * backend for each comparison (V1 against V0, V2 against V1 where V2 ran, and
 * V1 against V3 where V3 ran, with a row per goal). Pure, so
 * `planner-eval.test.mjs` proves every verdict on hand-written records.
 *
 * A run record is what run.mjs writes per run:
 *   { id, cell, variant, goal, repeat, build, model, keyHash, metrics, keyChecks, rubric?, error?, substitution?, env? }
 *
 * A run that timed out, lost its TUI or failed is not a planner's answer: it
 * counts toward the completion rate and nowhere else.
 */

/**
 * A comparison with `when` is judged only on a backend that ran that variant,
 * as the variant runs only when named. One with `perGoal` also gets a row per
 * goal and backend (`goalRows`): V1 against V3 is a change to the planner
 * judged goal by goal, the guards among them.
 */
export const COMPARISONS = [
  { baseline: 'V0', candidate: 'V1' },
  { baseline: 'V1', candidate: 'V2', when: 'V2' },
  { baseline: 'V3', candidate: 'V1', when: 'V3', perGoal: true },
];

/** The per-run numbers the report summarises, in its column order. */
export const NUMERIC = [
  ['taskCount', 'tasks'],
  ['width', 'width'],
  ['criticalPath', 'path'],
  ['changePath', 'change path'],
  ['researchTasks', 'research'],
  ['readOnlyTasks', 'read-only'],
  ['loopTasks', 'loops'],
  ['contextTokensAtSubmit', 'ctx@submit'],
  ['inputTokens', 'in'],
  ['outputTokens', 'out'],
  ['ownReads', 'own reads'],
  ['ownReadBytes', 'own read bytes'],
  ['ownReadBytesBeforeDelegation', 'bytes before delegating'],
  ['ownReadBytesAfterDelegation', 'bytes after delegating'],
  ['agentsSpawned', 'agents'],
  ['ownReadShare', 'own-read share'],
  ['keyViolations', 'key viol.'],
  ['rubricProblems', 'rubric problems'],
  ['wordingViolations', 'wording viol.'],
  ['turns', 'turns'],
  ['wallMs', 'wall ms'],
];

const finite = (v) => typeof v === 'number' && Number.isFinite(v);

export function median(values) {
  const xs = values.filter(finite).sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

export function spread(values) {
  const xs = values.filter(finite);
  return xs.length === 0 ? null : { min: Math.min(...xs), max: Math.max(...xs) };
}

const isTimeout = (r) => /^timeout\b/.test(String(r.metrics?.stopped ?? '')) || /^timeout\b/.test(String(r.error ?? ''));

/** Whether a run reached an answer: a plan, or the planner's last word before the turn limit. */
export function isComplete(record) {
  return !record.error && Boolean(record.metrics) && !['timeout', 'timeout with a pending approval', 'tui exited', 'error', null, undefined].includes(record.metrics.stopped);
}

/**
 * The numbers of one run as the report counts them: violations as counts. A
 * complete run that submitted no plan answered nothing a key can check, so it
 * counts as one key violation, and a variant cannot pass by planning nothing.
 */
export function runNumbers(record) {
  const m = record.metrics ?? {};
  return {
    ...Object.fromEntries(NUMERIC.map(([k]) => [k, m[k] ?? null])),
    keyViolations: m.submitted ? (record.keyChecks ?? []).filter((c) => c.status === 'fail').length : 1,
    rubricProblems: record.rubric?.ok ? record.rubric.problems.length : null,
    wordingViolations: Array.isArray(m.wordingViolations) ? m.wordingViolations.length : null,
  };
}

/** Whether a run's width falls in the slices its goal expects, tolerance included; null where the goal names none. */
export function widthInRange(record, goal) {
  const e = goal?.expectedSlices;
  if (!e || !record.metrics?.submitted || !finite(record.metrics.width)) return null;
  const tol = e.tolerance ?? 0;
  return record.metrics.width >= e.min - tol && record.metrics.width <= e.max + tol;
}

const groupKey = (r) => `${r.cell}\u0000${r.variant}\u0000${r.goal}`;

/** One summary per (cell, variant, goal): completion, then medians, spread and violations over the complete runs. */
export function summarize(records, goals = []) {
  const groups = new Map();
  for (const r of records) {
    if (!groups.has(groupKey(r))) groups.set(groupKey(r), []);
    groups.get(groupKey(r)).push(r);
  }
  return [...groups.values()].map((runs) => {
    const { cell, variant, goal } = runs[0];
    const complete = runs.filter(isComplete);
    const numbers = complete.map(runNumbers);
    const stats = Object.fromEntries(NUMERIC.map(([k]) => {
      const vs = numbers.map((n) => n[k]);
      return [k, { median: median(vs), spread: spread(vs) }];
    }));
    const violations = [];
    for (const r of complete) {
      if (!r.metrics.submitted) violations.push({ run: r.id, kind: 'key', what: `no plan submitted (${r.metrics.stopped})` });
      for (const c of r.keyChecks ?? []) if (c.status === 'fail') violations.push({ run: r.id, kind: 'key', what: `${c.check}: ${c.detail}` });
      for (const p of r.rubric?.ok ? r.rubric.problems : []) {
        violations.push({ run: r.id, kind: 'rubric', what: `${p.question}: ${p.claims.map((c) => c.text).join(' | ')}` });
      }
      for (const w of r.metrics.wordingViolations ?? []) violations.push({ run: r.id, kind: 'wording', what: `${w.rule}: "${w.quote}"` });
    }
    const inRange = complete.map((r) => widthInRange(r, goals.find((g) => g.id === goal))).filter((v) => v !== null);
    return {
      cell,
      variant,
      goal,
      runs: runs.length,
      complete: complete.length,
      timeouts: runs.filter(isTimeout).length,
      pendingApprovalTimeouts: runs.filter((r) => isTimeout(r) && /pending approval/.test(`${r.metrics?.stopped} ${r.error ?? ''}`)).length,
      submitted: complete.filter((r) => r.metrics.submitted).length,
      widthInRange: inRange.length ? { inRange: inRange.filter(Boolean).length, of: inRange.length } : null,
      errors: runs.filter((r) => r.error).map((r) => ({ run: r.id, error: r.error })),
      substitutions: runs.filter((r) => r.substitution).map((r) => ({ run: r.id, ...r.substitution })),
      stats,
      violations,
    };
  });
}

const mean = (xs) => (xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length);

/**
 * One side's runs of a per-run number: the mean over every run, and the range
 * of the per-repeat means, which is how far two passes of the same build
 * already differ.
 */
function perRepeat(records, pick) {
  const values = records.map((r) => ({ repeat: r.repeat, v: pick(runNumbers(r)) })).filter((x) => finite(x.v));
  if (values.length === 0) return null;
  const byRepeat = new Map();
  for (const { repeat, v } of values) byRepeat.set(repeat, [...(byRepeat.get(repeat) ?? []), v]);
  const means = [...byRepeat.values()].map(mean);
  return { mean: mean(values.map((x) => x.v)), range: Math.max(...means) - Math.min(...means), runs: values.length };
}

/**
 * Candidate against baseline for one backend, over the goals both sides have
 * complete runs of. The verdict rests on two criteria, each judged against
 * run-to-run spread: the candidate holds when its mean is no more than the
 * baseline's plus half the wider of the two sides' per-repeat ranges.
 *   - key violations per run (a complete run with no plan counts one)
 *   - true wording violations per run; zero always holds
 * Completion, width against the goal's expected slices, own-read share and
 * bytes, and rubric problems are reported beside it and judge nothing: width
 * and share describe a plan's shape, which a key already judges where it matters.
 */
export function verdict(records, goals, { cell, baseline, candidate }) {
  const all = (variant) => records.filter((r) => r.cell === cell && r.variant === variant);
  const completeGoals = (rs) => new Set(rs.filter(isComplete).map((r) => r.goal));
  const shared = [...completeGoals(all(baseline))].filter((g) => completeGoals(all(candidate)).has(g));
  const side = (variant) => all(variant).filter((r) => isComplete(r) && shared.includes(r.goal));
  const completion = (variant) => {
    const rs = all(variant);
    return rs.length ? rs.filter(isComplete).length / rs.length : null;
  };
  if (all(baseline).length === 0 || all(candidate).length === 0) {
    return { cell, baseline, candidate, result: 'incomplete', criteria: [], reported: [], note: 'one side has no runs' };
  }
  const base = side(baseline);
  const cand = side(candidate);
  const criteria = [];
  const judge = (name, pick, { zeroHolds = false } = {}) => {
    const b = perRepeat(base, pick);
    const c = perRepeat(cand, pick);
    const allowance = b && c ? Math.max(b.range, c.range) / 2 : null;
    const pass = !b || !c ? null : (zeroHolds && c.mean === 0) || c.mean <= b.mean + allowance;
    criteria.push({ name, baseline: b?.mean ?? null, candidate: c?.mean ?? null, allowance, pass });
  };
  judge('key violations per run', (n) => n.keyViolations);
  judge('true wording violations per run', (n) => n.wordingViolations, { zeroHolds: true });

  const reported = [];
  const report = (name, b, c) => reported.push({ name, baseline: b, candidate: c });
  report('completion rate', completion(baseline), completion(candidate));
  for (const goal of goals.filter((g) => g.expectedSlices && shared.includes(g.id))) {
    const share = (rs) => {
      const xs = rs.filter((r) => r.goal === goal.id).map((r) => widthInRange(r, goal)).filter((v) => v !== null);
      return xs.length ? `${xs.filter(Boolean).length}/${xs.length}` : null;
    };
    const { min, max, tolerance = 0 } = goal.expectedSlices;
    report(`width on ${goal.id} in ${min}-${max} ±${tolerance}`, share(base), share(cand));
  }
  const med = (rs, k) => median(rs.map(runNumbers).map((n) => n[k]));
  report('own-read share, median', med(base, 'ownReadShare'), med(cand, 'ownReadShare'));
  report('own read bytes, median', med(base, 'ownReadBytes'), med(cand, 'ownReadBytes'));
  const reviewed = (rs) => perRepeat(rs.filter((r) => r.rubric?.ok), (n) => n.rubricProblems)?.mean ?? null;
  report('rubric problems per run', reviewed(base), reviewed(cand));

  const result = criteria.some((c) => c.pass === false) ? 'fail' : shared.length === 0 || criteria.some((c) => c.pass === null) ? 'incomplete' : 'pass';
  return {
    cell, baseline, candidate, result, goals: shared, criteria, reported,
    ...(shared.length === 0 ? { note: 'no goal has complete runs on both sides' } : {}),
  };
}

/**
 * One row per goal for a backend: each side's key violations, width, critical
 * path, change path and task count (median and spread over its complete
 * runs), how many of its plans end in an integration check, and whether the
 * candidate's key violations on this goal hold by the verdict's rule. A guard
 * goal (`guards`) is one a flatter plan can break, so a change that widens
 * plans must hold there.
 */
export function goalRows(records, goals, { cell, baseline, candidate }) {
  const ids = [...new Set(records.filter((r) => r.cell === cell && [baseline, candidate].includes(r.variant)).map((r) => r.goal))].sort();
  return ids.map((id) => {
    const runs = (variant) => records.filter((r) => r.cell === cell && r.goal === id && r.variant === variant);
    const side = (variant) => {
      const all = runs(variant);
      const complete = all.filter(isComplete);
      const numbers = complete.map(runNumbers);
      const stat = (k) => ({ median: median(numbers.map((n) => n[k])), spread: spread(numbers.map((n) => n[k])) });
      const plans = complete.filter((r) => r.metrics.submitted && typeof r.metrics.endsInCheck === 'boolean');
      return {
        runs: all.length,
        complete: complete.length,
        keyViolations: stat('keyViolations'),
        width: stat('width'),
        criticalPath: stat('criticalPath'),
        changePath: stat('changePath'),
        taskCount: stat('taskCount'),
        endsInCheck: plans.length ? { yes: plans.filter((r) => r.metrics.endsInCheck).length, of: plans.length } : null,
      };
    };
    const b = perRepeat(runs(baseline).filter(isComplete), (n) => n.keyViolations);
    const c = perRepeat(runs(candidate).filter(isComplete), (n) => n.keyViolations);
    const allowance = b && c ? Math.max(b.range, c.range) / 2 : null;
    const g = goals.find((x) => x.id === id);
    return {
      cell, goal: id, baseline, candidate,
      guard: g?.guards ?? null,
      sides: { [baseline]: side(baseline), [candidate]: side(candidate) },
      keyViolationsHold: !b || !c ? null : c.mean <= b.mean + allowance,
      allowance,
    };
  });
}

export function aggregate(records, goals) {
  const cells = [...new Set(records.map((r) => r.cell))];
  const judged = (cell) => COMPARISONS.filter((c) => !c.when || records.some((r) => r.cell === cell && r.variant === c.when));
  return {
    summaries: summarize(records, goals),
    verdicts: cells.flatMap((cell) => judged(cell).map(({ baseline, candidate }) => verdict(records, goals, { cell, baseline, candidate }))),
    goalRows: cells.flatMap((cell) => judged(cell).filter((c) => c.perGoal).flatMap(({ baseline, candidate }) => goalRows(records, goals, { cell, baseline, candidate }))),
  };
}

function fmt(v) {
  if (v === null || v === undefined) return '–';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(2);
  return String(v);
}

function stat(s) {
  if (!s || s.median === null) return '–';
  return s.spread && s.spread.min !== s.spread.max ? `${fmt(s.median)} [${fmt(s.spread.min)}–${fmt(s.spread.max)}]` : fmt(s.median);
}

const cellText = (s) => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');

export function markdown({ summaries, verdicts, goalRows: rows = [] }, { title = 'Planner eval', meta = {} } = {}) {
  const out = [`# ${title}`, ''];
  for (const [k, v] of Object.entries(meta)) out.push(`- ${k}: ${cellText(v)}`);
  if (Object.keys(meta).length) out.push('');
  out.push('Each number is the median over the complete runs, with [min–max] when they differ. A run that timed out, lost its TUI or failed counts only toward completion.', '');
  out.push('## Completion', '', '| backend | variant | runs | complete | rate | timeouts | of them with a pending approval |', '| --- | --- | --- | --- | --- | --- | --- |');
  const byCell = new Map();
  for (const s of summaries) {
    const key = `${s.cell}\u0000${s.variant}`;
    const row = byCell.get(key) ?? { cell: s.cell, variant: s.variant, runs: 0, complete: 0, timeouts: 0, pendingApprovalTimeouts: 0 };
    row.runs += s.runs;
    row.complete += s.complete;
    row.timeouts += s.timeouts;
    row.pendingApprovalTimeouts += s.pendingApprovalTimeouts;
    byCell.set(key, row);
  }
  for (const r of [...byCell.values()].sort((a, b) => `${a.cell}${a.variant}`.localeCompare(`${b.cell}${b.variant}`))) {
    out.push(`| ${cellText(r.cell)} | ${r.variant} | ${r.runs} | ${r.complete} | ${fmt(r.runs ? r.complete / r.runs : null)} | ${r.timeouts} | ${r.pendingApprovalTimeouts} |`);
  }
  out.push('');
  for (const goal of [...new Set(summaries.map((s) => s.goal))].sort()) {
    out.push(`## ${goal}`, '');
    out.push(`| backend | variant | runs | complete | plans | width in range | ${NUMERIC.map(([, label]) => label).join(' | ')} |`);
    out.push(`|${' --- |'.repeat(NUMERIC.length + 6)}`);
    for (const s of summaries.filter((x) => x.goal === goal).sort((a, b) => `${a.cell}${a.variant}`.localeCompare(`${b.cell}${b.variant}`))) {
      const range = s.widthInRange ? `${s.widthInRange.inRange}/${s.widthInRange.of}` : '–';
      out.push(`| ${cellText(s.cell)} | ${s.variant} | ${s.runs} | ${s.complete} | ${s.submitted} | ${range} | ${NUMERIC.map(([k]) => stat(s.stats[k])).join(' | ')} |`);
    }
    out.push('');
  }
  const comparisons = [...new Map(rows.map((r) => [`${r.baseline}\u0000${r.candidate}`, r])).values()];
  for (const { baseline, candidate } of comparisons) {
    out.push(`## ${candidate} against ${baseline}, per goal`, '');
    out.push(`Each pair of columns is ${baseline} then ${candidate}. Holds: ${candidate}'s key violations on the goal are no more than ${baseline}'s plus the allowance, as in the verdicts. A guard goal is one a flatter plan breaks: a change must hold there.`, '');
    const columns = ['key viol.', 'width', 'path', 'change path', 'tasks', 'ends in a check'];
    out.push(`| goal | backend | guard | complete | ${columns.map((p) => `${p} ${baseline} | ${p} ${candidate}`).join(' | ')} | key viol. holds |`);
    out.push(`|${' --- |'.repeat(columns.length * 2 + 5)}`);
    for (const r of rows.filter((x) => x.baseline === baseline && x.candidate === candidate).sort((a, b) => `${a.goal}${a.cell}`.localeCompare(`${b.goal}${b.cell}`))) {
      const [b, c] = [r.sides[baseline], r.sides[candidate]];
      const check = (s) => (s.endsInCheck ? `${s.endsInCheck.yes}/${s.endsInCheck.of}` : '–');
      const cols = [
        stat(b.keyViolations), stat(c.keyViolations), stat(b.width), stat(c.width), stat(b.criticalPath), stat(c.criticalPath),
        stat(b.changePath), stat(c.changePath), stat(b.taskCount), stat(c.taskCount), check(b), check(c),
      ];
      const holds = r.keyViolationsHold === null ? 'no data' : r.keyViolationsHold ? 'yes' : 'no';
      out.push(`| ${r.goal} | ${cellText(r.cell)} | ${r.guard ? 'yes' : ''} | ${b.complete}/${b.runs}, ${c.complete}/${c.runs} | ${cols.join(' | ')} | ${holds} |`);
    }
    out.push('');
  }
  out.push('## Verdicts', '');
  out.push('Judged: the candidate holds when its mean is no more than the baseline\'s plus the allowance, half the wider per-repeat range of the two sides. Reported rows judge nothing.', '');
  for (const v of verdicts) {
    out.push(`### ${cellText(v.cell)}: ${v.candidate} vs ${v.baseline} — ${v.result}`, '');
    if (v.note) out.push(v.note, '');
    if (v.goals?.length) out.push(`Goals both sides completed: ${v.goals.join(', ')}.`, '');
    if (v.criteria.length || v.reported?.length) {
      out.push('| criterion | baseline | candidate | allowance | holds |', '| --- | --- | --- | --- | --- |');
      for (const c of v.criteria) out.push(`| ${c.name} | ${fmt(c.baseline)} | ${fmt(c.candidate)} | ${fmt(c.allowance)} | ${c.pass === null ? 'no data' : c.pass ? 'yes' : 'no'} |`);
      for (const c of v.reported ?? []) out.push(`| ${c.name} | ${fmt(c.baseline)} | ${fmt(c.candidate)} | | reported |`);
      out.push('');
    }
  }
  out.push('## Violations', '');
  const listed = summaries.flatMap((s) => s.violations.map((v) => ({ ...v, cell: s.cell, variant: s.variant, goal: s.goal })));
  if (listed.length === 0) out.push('None.', '');
  for (const v of listed) out.push(`- ${cellText(v.cell)} ${v.variant} ${v.goal} (${v.run}) ${v.kind}: ${cellText(v.what)}`);
  const problems = summaries.flatMap((s) => [
    ...s.errors.map((e) => `- ${cellText(s.cell)} ${s.variant} ${s.goal} (${e.run}) error: ${cellText(e.error)}`),
    ...s.substitutions.map((x) => `- ${cellText(s.cell)} ${s.variant} ${s.goal} (${x.run}) substituted ${x.from} → ${x.to}: ${cellText(x.reason)}`),
  ]);
  if (problems.length) out.push('', '## Errors and substitutions', '', ...problems);
  return `${out.join('\n')}\n`;
}
