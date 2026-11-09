// Offline proof of the planner eval's pure parts: metrics, answer keys, the
// rubric's citation filter, aggregation and verdicts, redaction, the settings
// guard, the driver's reading of a turn, the command line and the TUI's
// terminal. Nothing here starts a model, a daemon or a terminal.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { aggregate, markdown, median, spread, verdict } from './lib/aggregate.mjs';
import {
  ANSWER, BASELINE_REF, CELLS, CONFIRM, NUDGES, QUOTA, VARIANTS, goalText, loadGoals, missingFor, mockCell, parseArgs,
  runEnv, runId, runSettings, selectRuns, substituteFor,
} from './lib/config.mjs';
import { guardFiles, snapshot } from './lib/guard.mjs';
import { keyChecks, keyViolations } from './lib/keys.mjs';
import {
  criticalPath, ownReadShare, planDigest, readMeter, runMetrics, sessionParts, width, wordingViolations,
} from './lib/metrics.mjs';
import { classifyTurn, newestSession } from './lib/observe.mjs';
import { REDACTED, redactJson, redactor } from './lib/redact.mjs';
import { citedOnly, questionsFor, rubricPrompt } from './lib/rubric.mjs';
import { applyPatches } from './lib/target.mjs';
import { ptyCommand, shellQuote, stripAnsi, typed } from './lib/tui.mjs';

const goals = loadGoals();
const goal = (id) => goals.find((g) => g.id === id);
const task = (id, title, extra = {}) => ({ id, title, prompt: `${title}.`, dependencies: [], ...extra });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'planner-eval-test-'));

describe('the goals', () => {
  it('are G1 to G4, each with a goal and a key whose patterns compile', () => {
    assert.deepEqual(goals.map((g) => g.id), ['g1', 'g2', 'g3', 'g4']);
    for (const g of goals) {
      assert.ok(g.goal.length > 40, g.id);
      assert.ok(g.key.taskCount.min <= g.key.taskCount.max, g.id);
      for (const d of g.key.sharedDecisions ?? []) [d.match, d.dependents].forEach((p) => new RegExp(p, 'i'));
      for (const k of g.key.keepTogether ?? []) new RegExp(k.match, 'i');
    }
  });

  it("plant G4's bug exactly once in the baseline's Handoff.ts", (t) => {
    const repo = path.resolve(import.meta.dirname, '..', '..');
    let source;
    try {
      source = execFileSync('git', ['show', `${BASELINE_REF}:packages/core/src/models/Handoff.ts`], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      t.skip(`the baseline commit ${BASELINE_REF} is not in this clone (a shallow checkout)`);
      return;
    }
    const dir = tmp();
    const file = path.join(dir, 'packages', 'core', 'src', 'models', 'Handoff.ts');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, source);
    applyPatches(dir, goal('g4').setup.patches);
    const patched = fs.readFileSync(file, 'utf8');
    assert.notEqual(patched, source);
    assert.ok(patched.includes(goal('g4').setup.patches[0].replace));
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('applyPatches', () => {
  it('refuses a patch whose text is missing or occurs twice', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'a.txt'), 'x x');
    assert.throws(() => applyPatches(dir, [{ file: 'a.txt', find: 'y', replace: 'z' }]), /0 times/);
    assert.throws(() => applyPatches(dir, [{ file: 'a.txt', find: 'x', replace: 'z' }]), /2 times/);
    applyPatches(dir, [{ file: 'a.txt', find: 'x x', replace: '$& kept literally' }]);
    assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), '$& kept literally');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('plan shape', () => {
  // a → b → d, a → c, e alone: the widest antichain is {b, c, e}, the longest chain a-b-d.
  const plan = [task('a', 'A'), task('b', 'B', { dependencies: ['a'] }), task('c', 'C', { dependencies: ['a'] }),
    task('d', 'D', { dependencies: ['b'] }), task('e', 'E')];

  it('measures width as the largest set of mutually unordered tasks', () => {
    assert.equal(width(plan), 3);
    assert.equal(width([]), 0);
    assert.equal(width(plan, ['a', 'd']), 1, 'a subset ordered through a task outside it stays ordered');
    assert.equal(width(plan, ['c', 'd']), 2);
  });

  it('measures the critical path in tasks, and gives none for a cycle', () => {
    assert.equal(criticalPath(plan), 3);
    assert.equal(criticalPath([task('x', 'X', { dependencies: ['y'] }), task('y', 'Y', { dependencies: ['x'] })]), null);
  });
});

describe('readMeter', () => {
  it("counts the planner's own reads and their bytes, not a subagent's, and agents both ways", () => {
    const log = [
      { tool: 'read_file', result: 'héllo' },
      { tool: 'grep', result: 'ab' },
      { tool: 'read_file', result: 'not mine', subagentId: 's1' },
      { tool: 'spawn_research_agent' },
      { type: 'subagent', subagentId: 's1' },
      { type: 'subagent', subagentId: 's2' },
      { tool: 'agent_tool', toolLabel: 'Agent' },
      { tool: 'submit_plan' },
      { type: 'user_prompt', content: 'goal' },
    ];
    assert.deepEqual(readMeter(log), { ownReads: 2, ownReadBytes: 8, agentsSpawned: 2 });
  });

  it('gives no own-read share for a planner that looked at nothing', () => {
    assert.equal(ownReadShare({ ownReads: 0, agentsSpawned: 0, researchTasks: 0 }), null);
    assert.equal(ownReadShare({ ownReads: 1, agentsSpawned: 1, researchTasks: 2 }), 0.25);
  });
});

describe('wordingViolations', () => {
  const say = (content) => [{ role: 'assistant', content }];

  it('flags buttons, cards, press, Execute plan and Merge all in the chat', () => {
    const found = wordingViolations(say('Press the Execute plan button. The card shows it. Then Merge all.'), { autoMerge: false });
    assert.deepEqual([...new Set(found.map((f) => f.rule))].sort(), ["names a button", "names a card", "says 'Execute plan'", "says 'Merge all'", "says 'press'"].sort());
  });

  it('ignores quoted and inline-code text a task must change, and what the user said', () => {
    const history = [{ role: 'user', content: 'press the button' }, ...say("Change `Merge all` and the 'press Enter' hint, and \"the card\".")];
    assert.deepEqual(wordingViolations(history, { autoMerge: true }), []);
  });

  it("leaves a button or card alone in a sentence about VS Code, the webview or desktop", () => {
    const found = wordingViolations(say("The VS Code task card's header shows usage. The desktop button stays. The card shows it."), { autoMerge: false });
    assert.deepEqual(found.map((f) => f.quote), ['The card shows it.']);
  });

  it('flags asking the user to merge only while automatic merging is on', () => {
    const text = 'When it finishes, you can merge the branch. Then merge it.';
    assert.equal(wordingViolations(say(text), { autoMerge: true }).length, 2);
    assert.equal(wordingViolations(say(text), { autoMerge: false }).length, 0);
    assert.equal(wordingViolations(say('Each gate merges by itself.'), { autoMerge: true }).length, 0);
  });
});

describe('runMetrics', () => {
  const session = {
    plan: {
      phase: 'planning',
      pendingTasks: [
        task('r', 'Research the usage shape', { research: true }),
        task('a', 'Core shape', { dependencies: ['r'] }),
        task('b', 'TUI render', { dependencies: ['a'], subtasks: [task('b1', 'sub')] }),
        task('c', 'Desktop render', { dependencies: ['a'], taskMode: 'plan', loop: { max: 2 } }),
      ],
    },
    conversation: {
      conversationHistory: [{ role: 'user', content: 'goal' }, { role: 'assistant', content: 'Plan ready.' }, { kind: 'plan_generated', content: 'Plan generated' }],
      researchLog: [{ tool: 'read_file', result: 'abc' }],
      plannerUsage: { lastPromptTokens: 1200, totals: { inputTokens: 5000, outputTokens: 300 } },
    },
  };

  it("reads the daemon's pending tasks and every number from them", () => {
    const m = runMetrics(session, { driver: { turns: 2, wallMs: 1000, stopped: 'plan submitted' } });
    assert.equal(m.submitted, true);
    assert.equal(m.taskCount, 5);
    assert.equal(m.topLevelTasks, 4);
    assert.equal(m.width, 2);
    assert.equal(m.criticalPath, 3);
    assert.equal(m.researchTasks, 1);
    assert.equal(m.readOnlyTasks, 2);
    assert.equal(m.loopTasks, 1);
    assert.equal(m.contextTokensAtSubmit, 1200);
    assert.equal(m.inputTokens, 5000);
    assert.equal(m.ownReads, 1);
    assert.equal(m.ownReadShare, 0.5);
    assert.equal(m.turns, 2);
  });

  it('reads a saved session file, whose tasks are `tasks`', () => {
    assert.equal(sessionParts({ plan: { tasks: [task('x', 'X')] } }).tasks.length, 1);
    assert.equal(runMetrics({}).submitted, false);
  });

  it('digests the plan for the reviewer with ids, dependencies and prompts', () => {
    const d = planDigest(session.plan.pendingTasks);
    assert.deepEqual(d[2].dependencies, ['a']);
    assert.equal(d[2].subtasks[0].id, 'b1');
    assert.equal(d[3].readOnly, true);
  });
});

describe('keyChecks', () => {
  it('passes G1 when a core task precedes every surface, and fails when a surface does not wait', () => {
    const good = [task('1', 'Shared usage formatter in core'), task('2', 'TUI task view', { dependencies: ['1'] }),
      task('3', 'VS Code task card', { dependencies: ['1'] })];
    assert.deepEqual(keyViolations(keyChecks(goal('g1'), good)), []);
    const bad = [good[0], good[1], task('3', 'VS Code task card')];
    const failed = keyViolations(keyChecks(goal('g1'), bad));
    assert.deepEqual(failed.map((c) => c.check), ['leading task: usage-shape']);
    assert.match(failed[0].detail, /unordered: 3/);
  });

  it('fails G2 when the rename is split into parallel tasks, and passes a serial chain', () => {
    const parallel = [task('1', 'Rename the field in core'), task('2', 'Migrate saved sessions')];
    assert.deepEqual(keyViolations(keyChecks(goal('g2'), parallel)).map((c) => c.check), ['kept together: rename']);
    const chain = [parallel[0], { ...parallel[1], dependencies: ['1'] }];
    assert.deepEqual(keyViolations(keyChecks(goal('g2'), chain)), []);
  });

  it('fails G3 above its single task', () => {
    const two = [task('1', 'Reword the hint'), task('2', 'Update the tests', { dependencies: ['1'] })];
    assert.deepEqual(keyViolations(keyChecks(goal('g3'), two)).map((c) => c.check), ['task count']);
  });

  it('wants G4 reproduced first and its hypotheses researched before the fix', () => {
    const fix = task('3', 'Fix the worst-severity comparison', { dependencies: ['1', '2'] });
    const good = [task('1', 'Reproduce the failing test'), task('2', 'Hypothesis: the rank comparison', { research: true }), fix];
    assert.deepEqual(keyViolations(keyChecks(goal('g4'), good)), []);
    const guessed = [task('1', 'Fix the worst-severity comparison')];
    assert.deepEqual(keyViolations(keyChecks(goal('g4'), guessed)).map((c) => c.check).sort(), ['hypotheses in research tasks', 'reproduce first', 'task count'].sort());
  });

  it("accepts the planner's own run of the failing test as the reproduction", () => {
    const plan = [task('2', 'Check the rank order', { research: true }), task('3', 'Fix the comparison', { dependencies: ['2'] })];
    const researchLog = [{ tool: 'bash', args: '{"command":"npx vitest run src/models/__tests__/Handoff.test.ts"}' }];
    const repro = keyChecks(goal('g4'), plan, { researchLog }).find((c) => c.check === 'reproduce first');
    assert.equal(repro.status, 'pass');
    const byAgent = keyChecks(goal('g4'), plan, { researchLog: [{ ...researchLog[0], subagentId: 's' }] }).find((c) => c.check === 'reproduce first');
    assert.equal(byAgent.status, 'fail');
  });
});

describe('the rubric', () => {
  const digest = planDigest([task('t1', 'Core formatter', { prompt: 'Edit packages/core/src/models/Usage.ts.' }), task('t2', 'TUI view')]);

  it('asks the reproduction question of G4 only', () => {
    assert.ok(questionsFor(goal('g4')).some((q) => q.id === 'reproduce'));
    assert.ok(!questionsFor(goal('g1')).some((q) => q.id === 'reproduce'));
    assert.match(rubricPrompt(goal('g1'), digest), /## Answer key/);
  });

  it('keeps only claims that cite a real task or quote the plan verbatim', () => {
    const raw = {
      answers: [
        { question: 'paths', verdict: 'problem', claims: [
          { text: 'cites a task', taskIds: ['t2'], quotes: [] },
          { text: 'cites nothing', taskIds: [], quotes: [] },
          { text: 'invents a task', taskIds: ['t9'], quotes: [] },
          { text: 'misquotes', taskIds: [], quotes: ['Edit packages/cli'] },
          { text: 'quotes with other spacing', taskIds: [], quotes: ['Edit   packages/core/src/models/Usage.ts.'] },
        ] },
        { question: 'count', verdict: 'problem', claims: [{ text: 'no citation', taskIds: [], quotes: [] }] },
        { question: 'not-asked', verdict: 'ok', claims: [] },
        { question: 'split', verdict: 'na', claims: [] },
      ],
      tooSmall: ['t2', 'nope'],
    };
    const r = citedOnly(raw, goal('g1'), digest);
    assert.deepEqual(r.answers.find((a) => a.question === 'paths').claims.map((c) => c.text), ['cites a task', 'quotes with other spacing']);
    assert.equal(r.answers.find((a) => a.question === 'count').verdict, 'unsupported');
    assert.equal(r.answers.find((a) => a.question === 'split').verdict, 'na');
    assert.deepEqual(r.problems.map((p) => p.question), ['paths']);
    assert.deepEqual(r.tooSmall, ['t2']);
    assert.equal(r.discardedClaims, 5);
  });
});

describe('aggregation', () => {
  const rec = (variant, n, extra = {}) => ({
    id: `g1--c--${variant}--r${n}`, cell: 'c', variant, goal: 'g1', repeat: n,
    metrics: { submitted: true, taskCount: 4, width: 2, ownReadShare: 0.5, wordingViolations: [], ...(extra.metrics ?? {}) },
    keyChecks: extra.keyChecks ?? [{ check: 'task count', status: 'pass', detail: '' }],
    ...(extra.rubric ? { rubric: extra.rubric } : {}),
  });

  it('takes medians and spread over finite numbers only', () => {
    assert.equal(median([3, 1, null, 2]), 2);
    assert.equal(median([1, 2, 3, 4]), 2.5);
    assert.equal(median([]), null);
    assert.deepEqual(spread([2, undefined, 5]), { min: 2, max: 5 });
  });

  it('passes a candidate that matches the baseline on every criterion', () => {
    const v = verdict([rec('V0', 1), rec('V1', 1)], goals, { cell: 'c', baseline: 'V0', candidate: 'V1' });
    assert.equal(v.result, 'pass');
  });

  it('fails a narrower, more self-reading, violating or silent candidate', () => {
    const narrower = verdict([rec('V0', 1), rec('V1', 1, { metrics: { width: 1 } })], goals, { cell: 'c', baseline: 'V0', candidate: 'V1' });
    assert.equal(narrower.criteria.find((c) => c.name.startsWith('width on g1')).pass, false);
    const reads = verdict([rec('V0', 1), rec('V1', 1, { metrics: { ownReadShare: 0.9 } })], goals, { cell: 'c', baseline: 'V0', candidate: 'V1' });
    assert.equal(reads.result, 'fail');
    const wording = verdict([rec('V0', 1), rec('V1', 1, { metrics: { wordingViolations: [{ rule: 'says press', quote: 'Press' }] } })], goals, { cell: 'c', baseline: 'V0', candidate: 'V1' });
    assert.equal(wording.criteria.find((c) => c.name.startsWith('wording')).pass, false);
    const silent = verdict([rec('V0', 1), rec('V1', 1, { metrics: { submitted: false } })], goals, { cell: 'c', baseline: 'V0', candidate: 'V1' });
    assert.equal(silent.criteria.find((c) => c.name.startsWith('plans submitted')).pass, false);
    const keys = verdict([rec('V0', 1), rec('V1', 1, { keyChecks: [{ check: 'task count', status: 'fail', detail: '9' }] })], goals, { cell: 'c', baseline: 'V0', candidate: 'V1' });
    assert.equal(keys.result, 'fail');
  });

  it('calls a comparison with a side missing incomplete, never a pass', () => {
    assert.equal(verdict([rec('V0', 1)], goals, { cell: 'c', baseline: 'V0', candidate: 'V1' }).result, 'incomplete');
  });

  it('compares rubric problems only where a review ran', () => {
    const reviewed = { ok: true, problems: [{ question: 'split', claims: [{ text: 'split', taskIds: ['1'], quotes: [] }] }] };
    const v = verdict([rec('V0', 1, { rubric: { ok: true, problems: [] } }), rec('V1', 1, { rubric: reviewed })], goals, { cell: 'c', baseline: 'V0', candidate: 'V1' });
    assert.equal(v.criteria.find((c) => c.name.startsWith('rubric')).pass, false);
  });

  it('lists every violation, error and substitution in the markdown', () => {
    const records = [
      rec('V0', 1, { keyChecks: [{ check: 'task count', status: 'fail', detail: '9 tasks' }] }),
      { ...rec('V1', 1), error: 'timed out | badly', substitution: { from: 'opencode-go/x', to: 'openrouter/x', reason: 'quota' } },
    ];
    const md = markdown(aggregate(records, goals), { meta: { mode: 'test' } });
    assert.match(md, /key: task count: 9 tasks/);
    assert.match(md, /error: timed out \\\| badly/);
    assert.match(md, /substituted opencode-go\/x → openrouter\/x/);
    assert.match(md, /### c: V1 vs V0/);
  });
});

describe('redaction', () => {
  it('removes every secret value from the environment, the extras and anything key-shaped', () => {
    const redact = redactor({ OPENROUTER_API_KEY: 'abcdefgh12345678', HOME: '/home/x', SHORT_TOKEN: 'abc' }, ['daemon-token-value']);
    const text = redact('key abcdefgh12345678 home /home/x token daemon-token-value other sk-or-v1-0123456789abcdef0123 abc');
    assert.equal(text, `key ${REDACTED} home /home/x token ${REDACTED} other ${REDACTED} abc`);
    assert.equal(redactJson({ k: 'abcdefgh12345678' }, redact, 0), `{"k":"${REDACTED}"}`);
  });
});

describe('the settings guard', () => {
  it('puts back a changed file and removes one that was not there', () => {
    const dir = tmp();
    const kept = path.join(dir, 'settings.json');
    const absent = path.join(dir, '.env');
    fs.writeFileSync(kept, '{"mine":true}');
    const snap = snapshot([kept, absent]);
    assert.deepEqual(snap.restore(), [], 'nothing changed, nothing restored');
    fs.writeFileSync(kept, '{"theirs":true}');
    fs.writeFileSync(absent, 'X=1');
    assert.deepEqual(snap.restore(), [kept, absent]);
    assert.equal(fs.readFileSync(kept, 'utf8'), '{"mine":true}');
    assert.equal(fs.existsSync(absent), false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('restores on an interrupt and exits as the signal would', () => {
    const dir = tmp();
    const file = path.join(dir, 'settings.json');
    fs.writeFileSync(file, 'before');
    const proc = Object.assign(new EventEmitter(), { exitCode: null, exit(code) { this.exitCode = code; } });
    const told = [];
    const guard = guardFiles([file], { proc, onRestore: (files) => told.push(...files) });
    fs.writeFileSync(file, 'after');
    proc.emit('SIGINT', 'SIGINT');
    assert.equal(fs.readFileSync(file, 'utf8'), 'before');
    assert.equal(proc.exitCode, 130);
    assert.deepEqual(told, [file]);
    guard.release();
    assert.equal(proc.listenerCount('SIGINT'), 0);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('classifyTurn', () => {
  const at = (history, extra = {}) => ({ plan: { phase: 'planning', pendingTasks: extra.tasks ?? [] }, conversation: { conversationHistory: history, pendingTurns: extra.pending ?? [] }, ...(extra.turn ? { plannerTurnId: 't' } : {}) });
  const goalMsg = { role: 'user', content: 'goal' };

  it('waits while the planner is in its turn or has not answered', () => {
    assert.equal(classifyTurn(at([goalMsg], { turn: true }), { sentAt: 0 }).state, 'busy');
    assert.equal(classifyTurn(at([goalMsg], { pending: ['x'] }), { sentAt: 0 }).state, 'busy');
    assert.equal(classifyTurn(at([goalMsg]), { sentAt: 0 }).state, 'busy');
  });

  it('answers a question, confirms an outline, and sees a plan land', () => {
    assert.deepEqual(classifyTurn(at([goalMsg, { role: 'assistant', content: 'Which file?' }]), { sentAt: 0 }).reply, ANSWER);
    assert.deepEqual(classifyTurn(at([goalMsg, { role: 'assistant', content: 'Outline: 1. core. Shall I submit?' }]), { sentAt: 0 }).reply, CONFIRM);
    assert.equal(classifyTurn(at([goalMsg, { kind: 'plan_generated', content: 'Plan generated' }]), { sentAt: 0 }).state, 'plan');
    assert.equal(classifyTurn(at([goalMsg], { tasks: [task('1', 'x')] }), { sentAt: 0 }).state, 'plan');
  });

  it('reads only what came after the last line it sent', () => {
    const history = [goalMsg, { role: 'assistant', content: 'Which file?' }, { role: 'user', content: ANSWER }];
    assert.equal(classifyTurn(at(history), { sentAt: 2 }).state, 'busy');
  });

  it('reports an error turn and a turn that ended silently', () => {
    assert.equal(classifyTurn(at([goalMsg, { role: 'assistant', kind: 'error', content: 'usage limit reached' }]), { sentAt: 0 }).state, 'error');
    assert.equal(classifyTurn(at([goalMsg]), { sentAt: 0, sawBusy: true }).state, 'stalled');
  });

  it('picks the newest session', () => {
    assert.equal(newestSession([{ id: 'a', updatedAt: '2026-01-01' }, { id: 'b', updatedAt: '2026-02-01' }]).id, 'b');
    assert.equal(newestSession(undefined), null);
  });
});

describe('the run matrix', () => {
  it('runs smoke as G1 on claude-code/haiku once per variant', () => {
    const runs = selectRuns(parseArgs(['--smoke']), { goals });
    assert.deepEqual(runs.map((r) => r.id), ['g1--claude-code_haiku--V0--r1', 'g1--claude-code_haiku--V1--r1', 'g1--claude-code_haiku--V2--r1']);
  });

  it('runs full as every goal, required cell and variant, three times', () => {
    const runs = selectRuns(parseArgs(['--full']), { goals });
    const required = CELLS.filter((c) => !c.optional).length;
    assert.equal(required, 6);
    assert.equal(runs.length, 4 * required * 3 * 3);
    assert.equal(selectRuns(parseArgs(['--full', '--with-optional']), { goals }).length, 4 * CELLS.length * 3 * 3);
  });

  it('narrows by backend, goal and variant', () => {
    const runs = selectRuns(parseArgs(['--full', '--backend', 'opencode', '--goal', 'G4', '--variant', 'V1', '--repeats', '2']), { goals });
    assert.deepEqual([...new Set(runs.map((r) => r.cell.id))], ['opencode/deepseek-v4.1-flash', 'opencode/glm-5.3-flash']);
    assert.ok(runs.every((r) => r.goal.id === 'g4' && r.variant.id === 'V1'));
    assert.equal(runs.length, 4);
    assert.equal(selectRuns(parseArgs(['--full', '--backend', 'cline']), { goals }).length, 4 * 3 * 3, 'an optional cell runs when named');
  });

  it('refuses an unknown flag and a bad number', () => {
    assert.throws(() => parseArgs(['--smoke', '--backends', 'x']), /unknown argument/);
    assert.throws(() => parseArgs(['--full', '--repeats', '0']), /whole number/);
    assert.throws(() => parseArgs(['--goal']), /needs a value/);
    assert.equal(parseArgs(['--mock']).review, false);
    assert.equal(parseArgs(['--timeout=30', '--smoke']).timeoutMs, 30_000);
  });

  it('appends the nudges to V0 alone, verbatim', () => {
    const g = goal('g3');
    assert.equal(goalText(g, VARIANTS.V0), `${g.goal}\n\n${NUDGES[0]}\n\n${NUDGES[1]}`);
    assert.equal(goalText(g, VARIANTS.V1), g.goal);
    assert.equal(goalText(g, VARIANTS.V2), g.goal);
    assert.deepEqual(VARIANTS.V2.env, { ORDEWELL_PLANNER_READ_METER: '1' });
  });

  it("hands a run's environment the planner, its own settings, and an OpenRouter key only where it plans through one", () => {
    const base = { OPENROUTER_API_KEY: 'k', ORDEWELL_PLANNER_READ_METER: '1', NODE_OPTIONS: '--x', HOME: 'h' };
    const cell = CELLS.find((c) => c.id === 'claude-code/haiku');
    const env = runEnv(base, { cell, variant: VARIANTS.V1, settingsPath: 's.json', maxParallel: 4, enabledRunners: ['claude-code'] });
    assert.equal(env.OPENROUTER_API_KEY, undefined);
    assert.equal(env.ORDEWELL_PLANNER_READ_METER, undefined);
    assert.equal(env.NODE_OPTIONS, undefined);
    assert.equal(env.AI_PROVIDER, 'claude-code');
    assert.equal(env.ORCHESTRATOR_MODEL, 'haiku');
    assert.equal(env.ORDEWELL_SETTINGS_PATH, 's.json');
    assert.equal(env.HOME, 'h');
    const or = runEnv(base, { cell: CELLS.find((c) => c.id === 'openrouter/glm-5.3-flash'), variant: VARIANTS.V2, settingsPath: 's', maxParallel: 1, enabledRunners: ['claude-code'] });
    assert.equal(or.OPENROUTER_API_KEY, 'k');
    assert.equal(or.ORDEWELL_PLANNER_READ_METER, '1');
    const mock = runEnv(base, { cell: mockCell(3799), variant: VARIANTS.V0, settingsPath: 's', maxParallel: 1, enabledRunners: [] });
    assert.equal(mock.OPENROUTER_BASE_URL, 'http://127.0.0.1:3799/v1');
  });

  it('plans with nothing running by itself and gates merging by themselves', () => {
    const s = runSettings({ cell: CELLS[0], enabledRunners: ['claude-code'] });
    assert.equal(s.autorun, false);
    assert.equal(s.mergeAtGatesAutomatically, true);
    assert.deepEqual(s.plannerModels, { 'claude-code': { model: 'haiku' } });
    assert.equal(runSettings({ cell: CELLS.find((c) => c.id === 'cline/default'), enabledRunners: [] }).plannerModels, undefined);
  });

  it('falls an OpenCode Go cell back to OpenRouter on a quota, and names what a host lacks', () => {
    const go = CELLS.find((c) => c.id === 'opencode/glm-5.3-flash');
    const sub = substituteFor(go);
    assert.equal(sub.model, 'openrouter/z-ai/glm-5.3-flash');
    assert.equal(sub.substitutedFrom, 'opencode-go/glm-5.3-flash');
    assert.equal(substituteFor(CELLS[0]), null);
    assert.deepEqual(missingFor(sub, { env: {}, onPath: () => true }), ['OPENROUTER_API_KEY is not set']);
    assert.deepEqual(missingFor(go, { env: {}, onPath: () => false }), ['opencode is not on PATH']);
    assert.ok(QUOTA.test('Error: monthly usage limit reached'));
    assert.ok(!QUOTA.test('Add a rate column'));
  });

  it('names runs so a file name can hold them', () => {
    assert.equal(runId(CELLS[2], VARIANTS.V2, goal('g2'), 3), 'g2--opencode_deepseek-v4.1-flash--V2--r3');
  });
});

describe('the terminal', () => {
  it('runs the TUI under script(1) on Linux and macOS, and refuses elsewhere', () => {
    const linux = ptyCommand(['node', 'main.js', 'tui'], { platform: 'linux' });
    assert.equal(linux.command, 'script');
    assert.deepEqual([linux.args[0], linux.args.at(-1)], ['-qfec', '/dev/null']);
    assert.match(linux.args[1], /stty cols 160 rows 50 .*exec 'node' 'main.js' 'tui'$/);
    assert.deepEqual(ptyCommand(['x'], { platform: 'darwin' }).args.slice(0, 4), ['-q', '/dev/null', 'sh', '-c']);
    assert.throws(() => ptyCommand(['x'], { platform: 'win32' }), /script\(1\)/);
  });

  it('quotes a shell word, pastes text bracketed, and strips escapes from a screen', () => {
    assert.equal(shellQuote("it's"), `'it'\\''s'`);
    assert.equal(typed('a\nb'), '\x1b[200~a\nb\x1b[201~');
    assert.equal(stripAnsi('\x1b[1;32mok\x1b[0m\x1b]0;title\x07'), 'ok');
  });
});
