/**
 * From run records to the report: medians and spread per backend, variant and
 * goal, every violation listed with the run it came from, and a verdict per
 * backend for each comparison (V1 against V0, V2 against V1). Pure, so
 * `planner-eval.test.mjs` proves every verdict on hand-written records.
 *
 * A run record is what run.mjs writes per run:
 *   { id, cell, variant, goal, repeat, metrics, keyChecks, rubric?, error?, substitution? }
 */

export const COMPARISONS = [
  { baseline: 'V0', candidate: 'V1' },
  { baseline: 'V1', candidate: 'V2' },
];

/** The per-run numbers the report summarises, in its column order. */
export const NUMERIC = [
  ['taskCount', 'tasks'],
  ['width', 'width'],
  ['criticalPath', 'path'],
  ['researchTasks', 'research'],
  ['readOnlyTasks', 'read-only'],
  ['loopTasks', 'loops'],
  ['contextTokensAtSubmit', 'ctx@submit'],
  ['inputTokens', 'in'],
  ['outputTokens', 'out'],
  ['ownReads', 'own reads'],
  ['ownReadBytes', 'own read bytes'],
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

/** The numbers of one run as the report counts them: violations as counts, a failed run as nothing. */
export function runNumbers(record) {
  const m = record.metrics ?? {};
  return {
    ...Object.fromEntries(NUMERIC.map(([k]) => [k, m[k] ?? null])),
    keyViolations: (record.keyChecks ?? []).filter((c) => c.status === 'fail').length,
    rubricProblems: record.rubric?.ok ? record.rubric.problems.length : null,
    wordingViolations: Array.isArray(m.wordingViolations) ? m.wordingViolations.length : null,
  };
}

const groupKey = (r) => `${r.cell}\u0000${r.variant}\u0000${r.goal}`;

/** One summary per (cell, variant, goal): medians, spread, submissions, and every violation by run. */
export function summarize(records) {
  const groups = new Map();
  for (const r of records) {
    if (!groups.has(groupKey(r))) groups.set(groupKey(r), []);
    groups.get(groupKey(r)).push(r);
  }
  return [...groups.values()].map((runs) => {
    const { cell, variant, goal } = runs[0];
    const numbers = runs.map(runNumbers);
    const stats = Object.fromEntries(NUMERIC.map(([k]) => {
      const vs = numbers.map((n) => n[k]);
      return [k, { median: median(vs), spread: spread(vs) }];
    }));
    const violations = [];
    for (const r of runs) {
      for (const c of r.keyChecks ?? []) if (c.status === 'fail') violations.push({ run: r.id, kind: 'key', what: `${c.check}: ${c.detail}` });
      for (const p of r.rubric?.ok ? r.rubric.problems : []) {
        violations.push({ run: r.id, kind: 'rubric', what: `${p.question}: ${p.claims.map((c) => c.text).join(' | ')}` });
      }
      for (const w of r.metrics?.wordingViolations ?? []) violations.push({ run: r.id, kind: 'wording', what: `${w.rule}: "${w.quote}"` });
    }
    return {
      cell,
      variant,
      goal,
      runs: runs.length,
      submitted: runs.filter((r) => r.metrics?.submitted).length,
      errors: runs.filter((r) => r.error).map((r) => ({ run: r.id, error: r.error })),
      substitutions: runs.filter((r) => r.substitution).map((r) => ({ run: r.id, ...r.substitution })),
      stats,
      violations,
    };
  });
}

const sum = (xs) => xs.filter(finite).reduce((a, b) => a + b, 0);
const perRun = (records, pick) => {
  const xs = records.map(pick).filter(finite);
  return xs.length === 0 ? null : sum(xs) / xs.length;
};

/**
 * Candidate against baseline for one backend, over every goal both ran:
 *   - key violations per run no more (and rubric problems per run no more, where reviewed)
 *   - own-read share (median) no higher
 *   - width (median) no lower, on each goal whose key allows parallel work
 *   - zero wording violations
 *   - plans submitted no fewer, so a variant cannot pass by planning nothing
 * A criterion with no data on either side is null and makes the verdict incomplete.
 */
export function verdict(records, goals, { cell, baseline, candidate }) {
  const side = (variant) => records.filter((r) => r.cell === cell && r.variant === variant);
  const base = side(baseline);
  const cand = side(candidate);
  if (base.length === 0 || cand.length === 0) return { cell, baseline, candidate, result: 'incomplete', criteria: [], note: 'one side has no runs' };
  const nums = (rs) => rs.map(runNumbers);
  const criteria = [];
  const add = (name, b, c, pass) => criteria.push({ name, baseline: b, candidate: c, pass: b === null || c === null ? null : pass(b, c) });

  add('key violations per run (no more)', perRun(nums(base), (n) => n.keyViolations), perRun(nums(cand), (n) => n.keyViolations), (b, c) => c <= b);
  const reviewed = (rs) => (rs.some((r) => r.rubric?.ok) ? perRun(nums(rs.filter((r) => r.rubric?.ok)), (n) => n.rubricProblems) : null);
  const rb = reviewed(base);
  const rc = reviewed(cand);
  if (rb !== null || rc !== null) add('rubric problems per run (no more)', rb, rc, (b, c) => c <= b);
  add('own-read share, median (no higher)', median(nums(base).map((n) => n.ownReadShare)), median(nums(cand).map((n) => n.ownReadShare)), (b, c) => c <= b);
  for (const goal of goals.filter((g) => g.key.parallelAllowed)) {
    const w = (rs) => median(nums(rs.filter((r) => r.goal === goal.id && r.metrics?.submitted)).map((n) => n.width));
    const b = w(base);
    const c = w(cand);
    if (b !== null || c !== null) add(`width on ${goal.id}, median (no lower)`, b, c, (x, y) => y >= x);
  }
  add('wording violations (zero)', sum(nums(base).map((n) => n.wordingViolations)), sum(nums(cand).map((n) => n.wordingViolations)), (_b, c) => c === 0);
  add('plans submitted (no fewer)', base.filter((r) => r.metrics?.submitted).length, cand.filter((r) => r.metrics?.submitted).length, (b, c) => c >= b);

  const result = criteria.some((c) => c.pass === false) ? 'fail' : criteria.some((c) => c.pass === null) ? 'incomplete' : 'pass';
  return { cell, baseline, candidate, result, criteria };
}

export function aggregate(records, goals) {
  const cells = [...new Set(records.map((r) => r.cell))];
  return {
    summaries: summarize(records),
    verdicts: cells.flatMap((cell) => COMPARISONS.map((c) => verdict(records, goals, { cell, ...c }))),
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

export function markdown({ summaries, verdicts }, { title = 'Planner eval', meta = {} } = {}) {
  const out = [`# ${title}`, ''];
  for (const [k, v] of Object.entries(meta)) out.push(`- ${k}: ${cellText(v)}`);
  if (Object.keys(meta).length) out.push('');
  out.push('Each number is the median over repeats, with [min–max] when the repeats differ.', '');
  for (const goal of [...new Set(summaries.map((s) => s.goal))].sort()) {
    out.push(`## ${goal}`, '');
    out.push(`| backend | variant | runs | plans | ${NUMERIC.map(([, label]) => label).join(' | ')} |`);
    out.push(`|${' --- |'.repeat(NUMERIC.length + 4)}`);
    for (const s of summaries.filter((x) => x.goal === goal).sort((a, b) => `${a.cell}${a.variant}`.localeCompare(`${b.cell}${b.variant}`))) {
      out.push(`| ${cellText(s.cell)} | ${s.variant} | ${s.runs} | ${s.submitted} | ${NUMERIC.map(([k]) => stat(s.stats[k])).join(' | ')} |`);
    }
    out.push('');
  }
  out.push('## Verdicts', '');
  for (const v of verdicts) {
    out.push(`### ${cellText(v.cell)}: ${v.candidate} vs ${v.baseline} — ${v.result}`, '');
    if (v.note) out.push(v.note, '');
    if (v.criteria.length) {
      out.push('| criterion | baseline | candidate | holds |', '| --- | --- | --- | --- |');
      for (const c of v.criteria) out.push(`| ${c.name} | ${fmt(c.baseline)} | ${fmt(c.candidate)} | ${c.pass === null ? 'no data' : c.pass ? 'yes' : 'no'} |`);
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
