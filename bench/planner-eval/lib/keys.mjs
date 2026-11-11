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
import { createHash } from 'node:crypto';
import { agentCalls, ancestors, flatten, isLoop, isReadOnly, isResearch, ownReadTally, width } from './metrics.mjs';

const pattern = (source) => new RegExp(source, 'i');
const titleOf = (t) => String(t.title ?? '');
const textOf = (t) => `${titleOf(t)}\n${t.description ?? ''}\n${t.prompt ?? ''}`;

/**
 * What a key is scored with, as a short hash: a record keeps the hash it was
 * scored under, so a re-score knows which runs' rubric reviews a changed key
 * made stale. The goal text is in it because the reviewer reads that too.
 */
export const keyHash = (goal) => createHash('sha256').update(JSON.stringify({ goal: goal.goal, key: goal.key })).digest('hex').slice(0, 12);

/** A task that checks the work rather than doing it: a verify script, or one titled as a check or gate. */
const VERIFY_TITLE = /^\s*(verify|check|validate|review|confirm|re-?run|run)\b|\bgate\b/i;
const DOCS_TITLE = /\b(docs?|documentation|changelog|readme|CONTEXT\.md|ADRs?|ADR[- ]?\d+)\b/i;
const CODE_TITLE = /\b(code|src|source|tests?|types?|field|schema|migrat\w*|persist\w*|implement\w*|model|reader|writer)\b/i;

/** The ids of every task a loop runs as its body: the fix half of a verify/fix pair. */
function loopBodies(all) {
  return new Set(all.flatMap((t) => (Array.isArray(t.loop?.body) ? t.loop.body : [])));
}

const isVerify = (t) => t.type === 'script' || VERIFY_TITLE.test(titleOf(t));

/**
 * A task that changes the code a key is about. Research, read-only, verify
 * and loop tasks change nothing of their own, a loop's body fixes only what
 * its check reports, and a docs task edits prose: two of those beside the
 * change are not the change split in two.
 */
function changeTasks(top) {
  const bodies = loopBodies(flatten(top));
  return top.filter((t) => !isReadOnly(t)
    && !isVerify(t)
    && !(isLoop(t) && Array.isArray(t.loop.body) && t.loop.body.length)
    && !bodies.has(t.id)
    && !(DOCS_TITLE.test(titleOf(t)) && !CODE_TITLE.test(titleOf(t))));
}

/**
 * The tasks the count leaves out: one verify/fix loop pair, or one verify
 * task where there is no loop. Checking the work is not splitting it, and a
 * key's range is about the work.
 */
function verifyAllowance(all) {
  const loop = all.find((t) => isLoop(t) && Array.isArray(t.loop.body) && t.loop.body.length);
  if (loop) return new Set([loop.id, ...loop.loop.body.filter((id) => all.some((t) => t.id === id))]);
  const verify = all.find((t) => !isResearch(t) && isVerify(t));
  return new Set(verify ? [verify.id] : []);
}

function countCheck(key, all) {
  const { min, max } = key.taskCount;
  const left = verifyAllowance(all);
  const n = all.length - left.size;
  return {
    check: 'task count',
    status: n >= min && n <= max ? 'pass' : 'fail',
    detail: `${n} task(s)${left.size ? ` besides the verify step (${[...left].join(', ')})` : ''}; the key allows ${min === max ? min : `${min}-${max}`}`,
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
  const members = changeTasks(top).filter((t) => re.test(textOf(t)));
  const check = `kept together: ${group.id}`;
  if (members.length <= 1) return { check, status: 'pass', detail: `${members.length} change task(s) touch it` };
  const parallel = width(top, members.map((t) => t.id));
  return parallel <= 1
    ? { check, status: 'pass', detail: `${members.length} change tasks in one serial chain` }
    : { check, status: 'fail', detail: `${members.length} change tasks touch it and ${parallel} of them can run at once: ${members.map((t) => t.id).join(', ')}` };
}

/** What a test run prints once it ran: vitest's summary or a failing file, never a sealed run's "not found". */
const TEST_RESULT = /Test Files\s+\d|\bTests\s+\d+\s+(failed|passed)|\bFAIL\b\s+\S*\.test\.|AssertionError|\d+ (failed|passed)\b/;
const argsText = (args) => (typeof args === 'string' ? args : JSON.stringify(args ?? ''));

/**
 * Whether the planner ran the failing test itself: a shell step of its own
 * whose command names it and whose result is a test run's. A command that was
 * refused, or that ran sealed and found no test runner, saw nothing fail.
 */
export function plannerRanTest(researchLog, source) {
  const re = pattern(source);
  return (researchLog ?? []).some((e) => e?.tool === 'bash' && !e.subagentId && re.test(argsText(e.args)) && TEST_RESULT.test(String(e.result ?? '')));
}

const allMatch = (sources, text) => [sources].flat().every((s) => pattern(s).test(text));

/**
 * G4's checks. The fix must come after the failure is seen: the planner saw it
 * itself, a reproduction precedes every fix, or the fix's own prompt runs the
 * test before it changes code, as the planner is told to have it do when it
 * could not run the test. Research hypotheses are owed only while the cause
 * is unknown: a plan whose fix names the cause where it is and validates with
 * the failing tests has none left to test.
 */
function reproduceChecks(spec, key, top, up, researchLog) {
  const fixRe = pattern(spec.fix);
  const reproRe = pattern(spec.reproduce);
  const fixes = changeTasks(top).filter((t) => fixRe.test(titleOf(t)));
  const repros = top.filter((t) => reproRe.test(titleOf(t)) && !fixRe.test(titleOf(t)));
  const ran = plannerRanTest(researchLog, spec.plannerRanTest);
  const after = (fix) => top.filter((t) => t.id === fix.id || up.get(t.id).has(fix.id));
  const validated = (fix) => !spec.validates || after(fix).some((t) => pattern(spec.validates).test(textOf(t)));
  const runsFirst = (fix) => Boolean(spec.reproduceInFix) && pattern(spec.reproduceInFix).test(textOf(fix)) && validated(fix);
  const causeNamed = spec.causeNamed ? fixes.find((f) => allMatch(spec.causeNamed, textOf(f))) : undefined;
  const checks = [];
  if (fixes.length === 0) {
    checks.push({ check: 'reproduce first', status: 'fail', detail: 'no task titled as the fix' });
  } else {
    const ordered = fixes.every((f) => repros.some((r) => up.get(f.id).has(r.id)));
    const inFix = fixes.every(runsFirst);
    checks.push({
      check: 'reproduce first',
      status: ran || ordered || inFix ? 'pass' : 'fail',
      detail: ran
        ? 'the planner ran the failing test itself and saw its result'
        : ordered ? `every fix depends on a reproduction (${repros.map((r) => r.id).join(', ')})`
          : inFix ? 'the fix runs the failing tests before it changes code' : 'no reproduction precedes the fix, and the fix does not run the failing tests first',
    });
    if (spec.validates) {
      const ok = fixes.every(validated);
      checks.push({
        check: 'validated by the failing tests',
        status: ok ? 'pass' : 'fail',
        detail: ok ? 'the fix, or a task after it, runs the named tests' : `no task at or after ${fixes.filter((f) => !validated(f)).map((f) => f.id).join(', ')} names the failing tests`,
      });
    }
  }
  if (key.researchHypotheses) {
    const check = 'hypotheses in research tasks';
    if (causeNamed) {
      checks.push({ check, status: 'na', detail: `the planner found the cause: "${titleOf(causeNamed)}" (${causeNamed.id}) names it` });
    } else {
      const research = top.filter(isResearch);
      const fed = fixes.length > 0 && fixes.every((f) => research.some((r) => up.get(f.id).has(r.id)));
      checks.push({
        check,
        status: fed ? 'pass' : 'fail',
        detail: research.length === 0 ? 'no research task, and no fix names the cause' : fed ? `${research.length} research task(s) precede the fix` : 'the fix does not wait for a research task',
      });
    }
  }
  return checks;
}

/**
 * G5's checks: a question across packages, which the planner should hand out
 * by package before any change, reading little itself. A delegate is an agent
 * the planner spawned (which ran before the plan) or a research task every
 * change task waits for; together their briefs must name two packages or more.
 */
function breadthChecks(spec, top, up, researchLog) {
  const changes = changeTasks(top);
  const research = top.filter(isResearch).filter((r) => changes.every((c) => up.get(c.id).has(r.id)));
  const briefs = [...agentCalls(researchLog), ...research.map(textOf)];
  const packagesRe = pattern(spec.packages);
  const named = new Set(briefs.flatMap((b) => [...b.matchAll(new RegExp(packagesRe.source, 'gi'))].map((m) => m[0].toLowerCase().replace(/\s+/g, ''))));
  const delegated = briefs.length >= spec.minDelegated && named.size >= 2;
  const { ownReads, ownReadBytes } = ownReadTally(researchLog);
  const within = ownReads <= spec.maxOwnReads && ownReadBytes <= spec.maxOwnReadBytes;
  return [
    {
      check: 'delegated by package before any fix',
      status: delegated ? 'pass' : 'fail',
      detail: `${briefs.length} delegate(s) before every change (the key wants ${spec.minDelegated}), naming ${named.size ? [...named].sort().join(', ') : 'no package'}`,
    },
    {
      check: 'own reads within budget',
      status: within ? 'pass' : 'fail',
      detail: `${ownReads} own read(s), ${ownReadBytes} bytes; the key allows ${spec.maxOwnReads} and ${spec.maxOwnReadBytes}`,
    },
  ];
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
    ...(key.breadth ? breadthChecks(key.breadth, top, up, researchLog) : []),
  ];
}

export const keyViolations = (checks) => checks.filter((c) => c.status === 'fail');
