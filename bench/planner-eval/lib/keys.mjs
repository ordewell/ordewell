/**
 * The mechanical half of an answer key: what a plan's shape alone can show.
 * Each check passes, fails or does not apply; a failure is a key violation.
 * What needs reading (is a prompt specific, do two tasks decide the same
 * interface) is the rubric reviewer's (rubric.mjs).
 *
 * Tasks are classified by title against the key's patterns, research tasks
 * aside: a title is what the planner chose to call the work, and a prompt
 * mentions every neighbour it must not touch.
 */
import { ancestors, flatten, isResearch, width } from './metrics.mjs';

const pattern = (source) => new RegExp(source, 'i');
const titleOf = (t) => String(t.title ?? '');
const textOf = (t) => `${titleOf(t)}\n${t.description ?? ''}\n${t.prompt ?? ''}`;

function countCheck(key, all) {
  const { min, max } = key.taskCount;
  const n = all.length;
  return {
    check: 'task count',
    status: n >= min && n <= max ? 'pass' : 'fail',
    detail: `${n} task(s); the key allows ${min === max ? min : `${min}-${max}`}`,
  };
}

function sharedDecisionCheck(decision, top, up) {
  const dependentsRe = pattern(decision.dependents);
  const decisionRe = pattern(decision.match);
  const work = top.filter((t) => !isResearch(t));
  const dependents = work.filter((t) => dependentsRe.test(titleOf(t)));
  const leaders = work.filter((t) => decisionRe.test(titleOf(t)) && !dependentsRe.test(titleOf(t)));
  const check = `leading task: ${decision.id}`;
  if (dependents.length === 0) return { check, status: 'na', detail: 'no task titled for a dependent surface' };
  const leader = leaders.find((d) => dependents.every((s) => up.get(s.id).has(d.id)));
  if (leader) return { check, status: 'pass', detail: `"${titleOf(leader)}" (${leader.id}) precedes all ${dependents.length} dependent task(s)` };
  const why = leaders.length === 0
    ? 'no task titled for the shared decision'
    : `no decision task precedes every dependent; unordered: ${dependents.filter((s) => !leaders.some((d) => up.get(s.id).has(d.id))).map((s) => s.id).join(', ')}`;
  return { check, status: 'fail', detail: why };
}

function keepTogetherCheck(group, top) {
  const re = pattern(group.match);
  const members = top.filter((t) => !isResearch(t) && re.test(textOf(t)));
  const check = `kept together: ${group.id}`;
  if (members.length <= 1) return { check, status: 'pass', detail: `${members.length} task(s) touch it` };
  const parallel = width(top, members.map((t) => t.id));
  return parallel <= 1
    ? { check, status: 'pass', detail: `${members.length} tasks in one serial chain` }
    : { check, status: 'fail', detail: `${members.length} tasks touch it and ${parallel} of them can run at once: ${members.map((t) => t.id).join(', ')}` };
}

/** Whether the planner ran the failing test itself: a shell step of its own whose command names it. */
function plannerRanTest(researchLog, source) {
  const re = pattern(source);
  return (researchLog ?? []).some((e) => e?.tool === 'bash' && !e.subagentId && re.test(String(e.args ?? '')));
}

function reproduceChecks(spec, key, top, up, researchLog) {
  const fixRe = pattern(spec.fix);
  const reproRe = pattern(spec.reproduce);
  const fixes = top.filter((t) => !isResearch(t) && fixRe.test(titleOf(t)));
  const repros = top.filter((t) => reproRe.test(titleOf(t)) && !fixRe.test(titleOf(t)));
  const ran = plannerRanTest(researchLog, spec.plannerRanTest);
  const checks = [];
  if (fixes.length === 0) {
    checks.push({ check: 'reproduce first', status: 'fail', detail: 'no task titled as the fix' });
  } else {
    const ordered = fixes.every((f) => repros.some((r) => up.get(f.id).has(r.id)));
    checks.push({
      check: 'reproduce first',
      status: ran || ordered ? 'pass' : 'fail',
      detail: ran
        ? 'the planner ran the failing test itself'
        : ordered ? `every fix depends on a reproduction (${repros.map((r) => r.id).join(', ')})` : 'no reproduction precedes the fix',
    });
  }
  if (key.researchHypotheses) {
    const research = top.filter(isResearch);
    const fed = fixes.length > 0 && fixes.every((f) => research.some((r) => up.get(f.id).has(r.id)));
    checks.push({
      check: 'hypotheses in research tasks',
      status: fed ? 'pass' : 'fail',
      detail: research.length === 0 ? 'no research task' : fed ? `${research.length} research task(s) precede the fix` : 'the fix does not wait for a research task',
    });
  }
  return checks;
}

/** Every mechanical check of `goal`'s key against a submitted plan's tasks. */
export function keyChecks(goal, tasks, { researchLog } = {}) {
  const key = goal.key;
  const top = tasks ?? [];
  const up = ancestors(top);
  return [
    countCheck(key, flatten(top)),
    ...(key.sharedDecisions ?? []).map((d) => sharedDecisionCheck(d, top, up)),
    ...(key.keepTogether ?? []).map((g) => keepTogetherCheck(g, top)),
    ...(key.reproduceFirst ? reproduceChecks(key.reproduceFirst, key, top, up, researchLog) : []),
  ];
}

export const keyViolations = (checks) => checks.filter((c) => c.status === 'fail');
