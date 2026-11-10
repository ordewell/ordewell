// Offline proof of the planner eval's pure parts: metrics, answer keys, the
// rubric's citation filter, aggregation and verdicts, redaction, the settings
// guard, the driver's reading of a turn, the command line, the TUI's terminal,
// and re-scoring. Nothing here starts a model, a daemon or
// a terminal.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  aggregate, isComplete, markdown, median, spread, verdict, widthInRange,
} from './lib/aggregate.mjs';
import {
  ANSWER, BASELINE_REF, CELLS, CONFIRM, NUDGES, QUOTA, quotaOf, TEST_COMMANDS, VARIANTS, goalText, loadGoals, missingFor, mockCell,
  approvalPolicy, parseArgs, runEnv, runId, runSettings, selectRuns, substituteFor, timeoutFor, withModel,
} from './lib/config.mjs';
import { guardFiles, snapshot } from './lib/guard.mjs';
import { keyChecks, keyHash, keyViolations, plannerRanTest } from './lib/keys.mjs';
import {
  criticalPath, ownReadShare, planDigest, ownReadTally, agentCalls, resultBytes, runMetrics, sessionParts, width, wordingViolations,
} from './lib/metrics.mjs';
import { classifyTurn, newestSession, plannerApprovals, replyLanded } from './lib/observe.mjs';
import { REDACTED, redactJson, redactor } from './lib/redact.mjs';
import { citedOnly, questionsFor, rubricPrompt } from './lib/rubric.mjs';
import { applyPatches, linkTree, workParent } from './lib/target.mjs';
import { ptyCommand, shellQuote, stripAnsi, typed } from './lib/tui.mjs';

const goals = loadGoals();
const goal = (id) => goals.find((g) => g.id === id);
const task = (id, title, extra = {}) => ({ id, title, prompt: `${title}.`, dependencies: [], ...extra });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'planner-eval-test-'));
const repo = path.resolve(import.meta.dirname, '..', '..');
const atBaseline = (args) => {
  try {
    return execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
};

describe('the goals', () => {
  it('are G1 to G5, each with a goal and a key whose patterns compile', () => {
    assert.deepEqual(goals.map((g) => g.id), ['g1', 'g2', 'g3', 'g4', 'g5']);
    for (const g of goals) {
      assert.ok(g.goal.length > 40, g.id);
      assert.ok(g.key.taskCount.min <= g.key.taskCount.max, g.id);
      for (const d of g.key.sharedDecisions ?? []) [d.match, d.dependents].forEach((p) => new RegExp(p, 'i'));
      for (const k of g.key.keepTogether ?? []) new RegExp(k.match, 'i');
      const r = g.key.reproduceFirst;
      if (r) [r.reproduce, r.fix, r.plannerRanTest, r.validates, r.reproduceInFix, ...[r.causeNamed ?? []].flat()].forEach((p) => new RegExp(p, 'i'));
      if (g.key.breadth) new RegExp(g.key.breadth.packages, 'i');
      if (g.expectedSlices) assert.ok(g.expectedSlices.min <= g.expectedSlices.max, g.id);
    }
    assert.deepEqual(goal('g1').expectedSlices, { min: 4, max: 6, tolerance: 1 });
  });

  it('hash a key with the goal text, so a changed key or goal is a changed hash', () => {
    const g = goal('g4');
    assert.equal(keyHash(g), keyHash(structuredClone(g)));
    assert.notEqual(keyHash(g), keyHash({ ...g, key: { ...g.key, taskCount: { min: 1, max: 9 } } }));
    assert.equal(keyHash(g), keyHash({ ...g, expectedSlices: { min: 1, max: 2 } }), 'what is only reported is not in the hash');
  });

  it("hold G5's ground truth: every source file importing a child-process API at the baseline", (t) => {
    const { command, files } = goal('g5').groundTruth;
    const pattern = /git grep -lE "([^"]+)"/.exec(command)[1];
    const listed = atBaseline(['grep', '-lE', pattern, BASELINE_REF, '--', ...['core', 'cli', 'desktop', 'vscode', 'web'].map((p) => `packages/${p}/src`)]);
    if (listed === null) {
      t.skip(`the baseline commit ${BASELINE_REF} is not in this clone (a shallow checkout)`);
      return;
    }
    const found = listed.split('\n').filter(Boolean).map((l) => l.slice(BASELINE_REF.length + 1))
      .filter((f) => !/__tests__|\.test\.|\/test\/|\/testing\//.test(f)).sort();
    assert.deepEqual(found, [...files].sort());
  });

  it("plant G4's bug exactly once in the baseline's Handoff.ts", (t) => {
    const source = atBaseline(['show', `${BASELINE_REF}:packages/core/src/models/Handoff.ts`]);
    if (source === null) {
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

describe('ownReadTally', () => {
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
    assert.deepEqual(ownReadTally(log), {
      ownReads: 2, ownReadBytes: 8, ownReadsBeforeDelegation: 2, ownReadBytesBeforeDelegation: 8,
      ownReadsAfterDelegation: 0, ownReadBytesAfterDelegation: 0, agentsSpawned: 2,
    });
  });

  it("counts Ordewell's research agent under an MCP server prefix, as OpenCode logs it", () => {
    const log = [
      { tool: 'agent_tool', toolLabel: 'ordewell_spawn_research_agent', args: { prompt: 'List spawn sites in packages/core.' } },
      { tool: 'agent_tool', toolLabel: 'ordewell__spawn_research_agent' },
      { tool: 'mcp__ordewell__spawn_research_agent' },
      { tool: 'agent_tool', toolLabel: 'other_spawn_research_agent' },
      { tool: 'read_file', result: 'ab' },
    ];
    assert.equal(ownReadTally(log).agentsSpawned, 3);
    assert.equal(agentCalls(log).length, 3);
    assert.equal(ownReadTally(log).ownReads, 1);
  });

  it("counts an ACP planner's commands and file requests, at their true size, split at the first delegation", () => {
    const clipped = `${'x'.repeat(10_000)}\n[... truncated, total 250000 chars]`;
    const log = [
      { tool: 'agent_tool', toolLabel: 'run_command', result: clipped },
      { tool: 'agent_tool', toolLabel: 'ordewell_run_command', result: 'ab' },
      { tool: 'agent_tool', toolLabel: 'fs/read_text_file', result: 'abc' },
      { tool: 'agent_tool', toolLabel: 'TodoWrite', result: 'not a read' },
      { tool: 'submit_plan', args: '{"tasks":[{"research":true}]}' },
      { tool: 'agent_tool', toolLabel: 'run_command', result: 'abcd' },
    ];
    const tally = ownReadTally(log);
    assert.deepEqual([tally.ownReads, tally.ownReadBytes], [4, 250_009]);
    assert.deepEqual([tally.ownReadsBeforeDelegation, tally.ownReadBytesBeforeDelegation], [3, 250_005]);
    assert.deepEqual([tally.ownReadsAfterDelegation, tally.ownReadBytesAfterDelegation], [1, 4]);
    const byAgent = ownReadTally([{ tool: 'read_file', result: 'a' }, { tool: 'spawn_research_agent' }, { tool: 'grep', result: 'bb' }]);
    assert.deepEqual([byAgent.ownReadsBeforeDelegation, byAgent.ownReadsAfterDelegation], [1, 1]);
  });

  it('measures a clipped result by the total its suffix names, and an unclipped one as it is', () => {
    assert.equal(resultBytes(`${'é'.repeat(10)}\n[... truncated, total 500 chars]`), 510);
    assert.equal(resultBytes('héllo'), 6);
    assert.equal(resultBytes(undefined), 0);
  });

  it('gives no own-read share for a planner that looked at nothing', () => {
    assert.equal(ownReadShare({ ownReads: 0, agentsSpawned: 0, researchTasks: 0 }), null);
    assert.equal(ownReadShare({ ownReads: 1, agentsSpawned: 1, researchTasks: 2 }), 0.25);
  });
});

describe('wordingViolations', () => {
  const PLANNED = [{ role: 'user', content: 'goal' }, { role: 'assistant', content: 'Click the card. Press go.' }, { kind: 'plan_generated', content: 'Plan generated' }];
  const say = (content) => [...PLANNED, { role: 'assistant', content }];
  const rules = (found) => [...new Set(found.map((f) => f.rule))].sort();

  it('flags an instruction to operate a control the terminal lacks, in the hand-back only', () => {
    const found = wordingViolations(say('Click the Execute plan button to start. You can open the task card. Press go when ready. Then choose Merge all.'), { autoMerge: false });
    assert.deepEqual(rules(found), ["names a button", "names a card", "says 'Execute plan'", "says 'Merge all'", "says 'click'", "says 'press' without a key"].sort());
    assert.deepEqual(wordingViolations(PLANNED, { autoMerge: true }), [], 'what came before the plan was handed back is not scanned');
  });

  it('leaves a description, a quote, a code identifier and a key press alone', () => {
    const text = [
      'The plan adds a usage line to the task card.',
      "Change `Merge all` and the 'press Enter' hint, and \"the card\".",
      'Task 2 edits renderTaskCard in packages/cli/src/tui/card.ts.',
      'Press Enter to start the plan. Press `a` to approve.',
    ].join(' ');
    assert.deepEqual(wordingViolations([{ role: 'user', content: 'press the button' }, ...say(text)], { autoMerge: true }), []);
  });

  it("does not take a goal's quoted hint text for an instruction to merge (G3)", () => {
    const hint = 'merging paused: /handoff merge';
    const text = [
      `- **#1 Change the merge-pause hint and its tests** (change task) — rewrites the longest \`runHints\` entry to \`${hint}\` in \`packages/cli/src/tui/layout.ts\`.`,
      `It changes the longest run hint in \`packages/cli/src/tui/layout.ts\` to \`${hint}\` and leaves the two shorter forms alone.`,
      `- \`packages/cli/src/tui/layout.ts:433\`: the longest hint becomes \`${hint}\`.`,
      `**Change the hint** in \`packages/cli/src/tui/layout.ts\`: the longest form becomes \`'${hint}'\`.`,
    ].join('\n');
    assert.deepEqual(wordingViolations(say(text), { autoMerge: true }), []);
  });

  it('still flags an instruction to merge, quoted command or not', () => {
    for (const text of ['Note the verify task is a merge gate: it waits until you merge the change tasks.', 'Type `/handoff merge` when the tasks finish.', 'Run /handoff merge to land it.', 'You can merge them yourself.']) {
      assert.deepEqual(rules(wordingViolations(say(text), { autoMerge: true })), ['asks the user to merge while automatic merging is on'], text);
    }
  });

  it("leaves a button or card alone in a sentence about VS Code, the webview or desktop", () => {
    const found = wordingViolations(say('You will see a VS Code task card. Open the desktop button. You can click the card.'), { autoMerge: false });
    assert.deepEqual(found.map((f) => f.quote), ['You can click the card.', 'You can click the card.']);
  });

  it('exempts a term the goal itself uses', () => {
    const found = wordingViolations(say('You can open the task card to see the usage.'), { autoMerge: false, goalText: 'Show token usage on the task card.' });
    assert.deepEqual(found, []);
  });

  it('flags asking the user to merge only while automatic merging is on, and not where it merges by itself', () => {
    const text = "When it finishes, you'll need to merge the branch. Then merge it. Type /merge after.";
    assert.equal(wordingViolations(say(text), { autoMerge: true }).length, 3);
    assert.equal(wordingViolations(say(text), { autoMerge: false }).length, 0);
    for (const fine of ['Each gate merges by itself.', 'You can merge nothing: the run merges automatically.', 'You will see the run merge each gate.']) {
      assert.deepEqual(wordingViolations(say(fine), { autoMerge: true }), [], fine);
    }
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

  it('wants G4 reproduced first, validated by the named tests, and its hypotheses researched while the cause is unknown', () => {
    const fix = task('3', 'Fix the worst-severity comparison', { dependencies: ['1', '2'], prompt: 'Fix it, then run Handoff.test.ts and taskRow.test.ts.' });
    const good = [task('1', 'Reproduce the failing test'), task('2', 'Hypothesis: the rank comparison', { research: true }), fix];
    assert.deepEqual(keyViolations(keyChecks(goal('g4'), good)), []);
    const guessed = [task('1', 'Fix the worst-severity comparison')];
    assert.deepEqual(keyViolations(keyChecks(goal('g4'), guessed)).map((c) => c.check).sort(),
      ['hypotheses in research tasks', 'reproduce first', 'validated by the failing tests'].sort());
  });

  it('accepts one G4 task that names the cause and runs the failing tests before and after its change', () => {
    const one = [task('1', 'Fix worstSeverity in Handoff.ts', {
      prompt: 'The comparison at Handoff.ts:42 reads SEVERITY_RANK backwards. Run Handoff.test.ts first and record the failure before changing code, '
        + 'then fix worstSeverity and run Handoff.test.ts and taskRow.test.ts.',
    })];
    const checks = keyChecks(goal('g4'), one);
    assert.deepEqual(keyViolations(checks), []);
    assert.equal(checks.find((c) => c.check === 'hypotheses in research tasks').status, 'na');
    const unvalidated = [task('1', 'Fix worstSeverity in Handoff.ts', { prompt: 'SEVERITY_RANK is read backwards at line 42; run the tests first, before you change it.' })];
    // Running "the tests" without naming them neither reproduces nor validates anything the goal named.
    assert.deepEqual(keyViolations(keyChecks(goal('g4'), unvalidated)).map((c) => c.check), ['reproduce first', 'validated by the failing tests']);
  });

  it("accepts the planner's own run of the failing test only where it saw a test result", () => {
    const plan = [task('2', 'Check the rank order', { research: true }), task('3', 'Fix the comparison', { dependencies: ['2'], prompt: 'Then run Handoff.test.ts.' })];
    const ran = { tool: 'bash', args: '{"command":"npx vitest run src/models/__tests__/Handoff.test.ts"}', result: ' FAIL  src/models/__tests__/Handoff.test.ts\n Test Files  1 failed (1)' };
    const status = (researchLog) => keyChecks(goal('g4'), plan, { researchLog }).find((c) => c.check === 'reproduce first').status;
    assert.equal(status([ran]), 'pass');
    assert.equal(status([{ ...ran, subagentId: 's' }]), 'fail', "an agent's run is not the planner's");
    assert.equal(status([{ ...ran, result: 'sh: 1: vitest: not found' }]), 'fail', 'a sealed run that found no test runner saw nothing fail');
    assert.equal(status([{ ...ran, result: undefined }]), 'fail');
    assert.equal(plannerRanTest([ran], 'taskRow\\.test'), false, 'the command must name the test');
  });

  it('counts change tasks only: one verify/fix loop pair and a docs task are not the work split', () => {
    const work = task('1', 'Reword the hint');
    const loop = [work, task('v', 'Check the hint wording', { type: 'script', loop: { max: 2, body: ['f'] }, dependencies: ['1'] }), task('f', 'Fix what the check found', { dependencies: ['v'] })];
    assert.deepEqual(keyViolations(keyChecks(goal('g3'), loop)), []);
    const rename = [task('1', 'Rename the field in core'), task('2', 'Verify the rename'), task('3', 'Update the docs for the rename')];
    assert.equal(keyChecks(goal('g2'), rename).find((c) => c.check === 'kept together: rename').status, 'pass');
  });

  it('wants G5 handed out by package before any change, with the planner reading little itself', () => {
    const plan = [
      task('r1', 'Survey spawn sites in packages/core', { research: true }),
      task('r2', 'Survey spawn sites in cli, web and vscode', { research: true }),
      task('h', 'Add a child environment helper in core', { dependencies: ['r1', 'r2'] }),
      task('c', 'Route the cli spawn sites through the helper', { dependencies: ['h'] }),
      task('w', 'Route the web spawn sites through the helper', { dependencies: ['h'] }),
    ];
    const reads = (n, bytes = 10) => Array.from({ length: n }, () => ({ tool: 'grep', result: 'x'.repeat(bytes) }));
    assert.deepEqual(keyViolations(keyChecks(goal('g5'), plan, { researchLog: reads(3) })), []);
    assert.deepEqual(keyViolations(keyChecks(goal('g5'), plan, { researchLog: reads(11) })).map((c) => c.check), ['own reads within budget']);
    assert.deepEqual(keyViolations(keyChecks(goal('g5'), plan, { researchLog: reads(2, 40_000) })).map((c) => c.check), ['own reads within budget']);
    const oneSurvey = [task('r', 'Survey every package', { research: true }), ...plan.slice(2).map((t) => ({ ...t, dependencies: t.id === 'h' ? ['r'] : t.dependencies }))];
    assert.deepEqual(keyViolations(keyChecks(goal('g5'), oneSurvey)).map((c) => c.check), ['delegated by package before any fix']);
    const agents = [
      { tool: 'spawn_research_agent', args: { prompt: 'List the spawn sites in packages/core.' } },
      { tool: 'agent_tool', toolLabel: 'Agent', args: { prompt: 'List the spawn sites in packages/cli and packages/web.' } },
    ];
    assert.equal(keyChecks(goal('g5'), plan.slice(2).map((t) => ({ ...t, dependencies: t.id === 'h' ? [] : t.dependencies })), { researchLog: agents })
      .find((c) => c.check === 'delegated by package before any fix').status, 'pass');
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
    id: `${extra.goal ?? 'g1'}--c--${variant}--r${n}${extra.suffix ?? ''}`, cell: 'c', variant, goal: extra.goal ?? 'g1', repeat: n,
    metrics: { submitted: true, stopped: 'plan submitted', taskCount: 4, width: 5, ownReadShare: 0.5, wordingViolations: [], ...(extra.metrics ?? {}) },
    keyChecks: extra.keyChecks ?? [{ check: 'task count', status: 'pass', detail: '' }],
    ...(extra.rubric ? { rubric: extra.rubric } : {}),
    ...(extra.error ? { error: extra.error } : {}),
  });
  const failing = (n) => Array.from({ length: n }, () => ({ check: 'task count', status: 'fail', detail: '9' }));
  const compare = (records) => verdict(records, goals, { cell: 'c', baseline: 'V0', candidate: 'V1' });
  const criterion = (v, name) => v.criteria.find((c) => c.name.startsWith(name));
  const reported = (v, name) => v.reported.find((c) => c.name.startsWith(name));

  it('takes medians and spread over finite numbers only', () => {
    assert.equal(median([3, 1, null, 2]), 2);
    assert.equal(median([1, 2, 3, 4]), 2.5);
    assert.equal(median([]), null);
    assert.deepEqual(spread([2, undefined, 5]), { min: 2, max: 5 });
  });

  it('passes a candidate that matches the baseline, and judges on key and true wording violations alone', () => {
    const v = compare([rec('V0', 1), rec('V1', 1)]);
    assert.equal(v.result, 'pass');
    assert.deepEqual(v.criteria.map((c) => c.name), ['key violations per run', 'true wording violations per run']);
  });

  it('reports width, own reads and rubric problems without judging on them', () => {
    const reviewed = { ok: true, problems: [{ question: 'split', claims: [{ text: 'split', taskIds: ['1'], quotes: [] }] }] };
    const v = compare([rec('V0', 1, { rubric: { ok: true, problems: [] } }), rec('V1', 1, { metrics: { width: 1, ownReadShare: 0.9 }, rubric: reviewed })]);
    assert.equal(v.result, 'pass');
    assert.deepEqual(reported(v, 'width on g1 in 4-6 ±1'), { name: 'width on g1 in 4-6 ±1', baseline: '1/1', candidate: '0/1' });
    assert.equal(reported(v, 'own-read share').candidate, 0.9);
    assert.equal(reported(v, 'rubric problems').candidate, 1);
  });

  it('fails more key violations than run-to-run spread allows, and a run with no plan counts one', () => {
    // The baseline's repeats differ by 2 violations a run, so a candidate within 1 of its mean holds.
    const base = [rec('V0', 1, { keyChecks: failing(2) }), rec('V0', 2)];
    assert.equal(compare([...base, rec('V1', 1, { keyChecks: failing(2) })]).result, 'pass');
    const worse = compare([...base, rec('V1', 1, { keyChecks: failing(3) })]);
    assert.equal(worse.result, 'fail');
    assert.equal(criterion(worse, 'key violations').allowance, 1);
    const silent = compare([rec('V0', 1), rec('V1', 1, { metrics: { submitted: false, stopped: 'turn limit' } })]);
    assert.equal(criterion(silent, 'key violations').candidate, 1);
    assert.equal(silent.result, 'fail');
  });

  it('holds at zero true wording violations, and fails them above the baseline', () => {
    const said = { metrics: { wordingViolations: [{ rule: "says 'click'", quote: 'Click it.' }] } };
    assert.equal(criterion(compare([rec('V0', 1, said), rec('V1', 1)]), 'true wording').pass, true);
    assert.equal(criterion(compare([rec('V0', 1), rec('V1', 1, said)]), 'true wording').pass, false);
  });

  it('counts a timed-out run toward completion only, never as a clean plan', () => {
    const timedOut = rec('V1', 1, { suffix: 't', error: 'timeout after 900s', metrics: { stopped: 'timeout', submitted: false } });
    assert.equal(isComplete(timedOut), false);
    assert.equal(isComplete(rec('V1', 1, { metrics: { stopped: 'tui exited' } })), false);
    assert.equal(isComplete(rec('V1', 1, { metrics: { stopped: 'turn limit', submitted: false } })), true);
    const v = compare([rec('V0', 1), rec('V1', 1, { keyChecks: failing(1) }), timedOut]);
    assert.equal(criterion(v, 'key violations').candidate, 1, 'the timeout neither adds a violation nor dilutes one');
    assert.equal(reported(v, 'completion rate').candidate, 0.5);
    assert.equal(compare([rec('V0', 1), timedOut]).result, 'incomplete', 'a side that only timed out has nothing to judge');
    const [summary] = aggregate([timedOut], goals).summaries;
    assert.deepEqual([summary.runs, summary.complete, summary.timeouts, summary.violations.length], [1, 0, 1, 0]);
  });

  it('calls a comparison with a side missing incomplete, never a pass', () => {
    assert.equal(compare([rec('V0', 1)]).result, 'incomplete');
  });

  it("measures width against the goal's expected slices, where it names them", () => {
    assert.equal(widthInRange(rec('V0', 1, { metrics: { width: 3 } }), goal('g1')), true);
    assert.equal(widthInRange(rec('V0', 1, { metrics: { width: 8 } }), goal('g1')), false);
    assert.equal(widthInRange(rec('V0', 1), goal('g3')), null);
    assert.equal(widthInRange(rec('V0', 1, { metrics: { submitted: false } }), goal('g1')), null);
  });

  it('lists every violation, error and substitution in the markdown', () => {
    const records = [
      rec('V0', 1, { keyChecks: [{ check: 'task count', status: 'fail', detail: '9 tasks' }] }),
      { ...rec('V1', 1), error: 'timed out | badly', substitution: { from: 'opencode-go/x', to: 'openrouter/x', reason: 'quota' } },
      rec('V1', 2),
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

  it('knows whether the line it sent landed, and which approval cards are the planner\'s', () => {
    assert.equal(replyLanded(at([goalMsg]), { sentAt: 1 }), false);
    assert.equal(replyLanded(at([goalMsg, { role: 'user', content: 'x' }]), { sentAt: 1 }), true);
    assert.equal(replyLanded(at([goalMsg], { turn: true }), { sentAt: 1 }), true);
    assert.equal(replyLanded(at([goalMsg]), { sentAt: 1, sawBusy: true }), true);
    const body = { pending: [{ id: 'a', request: { kind: 'research_command' } }, { id: 'b', request: { kind: 'runner_tool' } }, {}] };
    assert.deepEqual(plannerApprovals(body).map((p) => p.id), ['a']);
    assert.deepEqual(plannerApprovals(undefined), []);
  });

  it('picks the newest session', () => {
    assert.equal(newestSession([{ id: 'a', updatedAt: '2026-01-01' }, { id: 'b', updatedAt: '2026-02-01' }]).id, 'b');
    assert.equal(newestSession(undefined), null);
  });
});

describe('the run matrix', () => {
  it('runs smoke as G1 on claude-code/haiku once per variant', () => {
    const runs = selectRuns(parseArgs(['--smoke']), { goals });
    assert.deepEqual(runs.map((r) => r.id), ['g1--claude-code_haiku--V0--r1', 'g1--claude-code_haiku--V1--r1']);
  });

  it('runs full as every goal, required cell and variant, three times', () => {
    const runs = selectRuns(parseArgs(['--full']), { goals });
    const required = CELLS.filter((c) => !c.optional).length;
    assert.equal(required, 6);
    assert.equal(runs.length, goals.length * required * 2 * 3);
    assert.equal(selectRuns(parseArgs(['--full', '--with-optional']), { goals }).length, goals.length * CELLS.length * 2 * 3);
  });

  it('narrows by backend, goal and variant', () => {
    const runs = selectRuns(parseArgs(['--full', '--backend', 'opencode', '--goal', 'G4', '--variant', 'V1', '--repeats', '2']), { goals });
    assert.deepEqual([...new Set(runs.map((r) => r.cell.id))], ['opencode/deepseek-v4.1-flash', 'opencode/glm-5.3-flash']);
    assert.ok(runs.every((r) => r.goal.id === 'g4' && r.variant.id === 'V1'));
    assert.equal(runs.length, 4);
    assert.equal(selectRuns(parseArgs(['--full', '--backend', 'cline']), { goals }).length, goals.length * 2 * 3, 'an optional cell runs when named');
  });

  it('names an ACP planner\'s model through its own variable, under an id that says so', () => {
    const opts = parseArgs(['--full', '--backend', 'cline,qwen-code', '--model', 'cline=deepseek/deepseek-v4.1-flash,qwen-code=glm-5.3']);
    assert.deepEqual(opts.models, { cline: 'deepseek/deepseek-v4.1-flash', 'qwen-code': 'glm-5.3' });
    const cells = [...new Set(selectRuns(opts, { goals }).map((r) => r.cell))];
    assert.deepEqual(cells.map((c) => [c.id, c.model]), [['cline/deepseek_deepseek-v4.1-flash', 'deepseek/deepseek-v4.1-flash'], ['qwen-code/glm-5.3', 'glm-5.3']]);
    assert.equal(cells[0].env.CLINE_MODEL, 'deepseek/deepseek-v4.1-flash');
    assert.equal(cells[1].env.OPENAI_MODEL, 'glm-5.3');
    const env = runEnv({}, { cell: cells[0], variant: VARIANTS.V1, settingsPath: 's', maxParallel: 4, enabledRunners: ['cline'] });
    assert.deepEqual([env.ORCHESTRATOR_MODEL, env.CLINE_MODEL], ['deepseek/deepseek-v4.1-flash', 'deepseek/deepseek-v4.1-flash']);
    assert.equal(withModel(CELLS[0], { cline: 'x' }), CELLS[0], 'a cell of another harness is left alone');
    assert.throws(() => parseArgs(['--model', 'gemini-cli=x']), /cannot name a model/);
    assert.throws(() => parseArgs(['--model', 'cline']), /<harness>=<model>/);
  });

  it('answers a planner approval card unless the goal says deny', () => {
    assert.equal(approvalPolicy({ id: 'g1' }), 'allow');
    assert.equal(approvalPolicy({ id: 'g1', approvals: 'deny' }), 'deny');
  });

  it('refuses an unknown flag and a bad number', () => {
    assert.throws(() => parseArgs(['--smoke', '--backends', 'x']), /unknown argument/);
    assert.throws(() => parseArgs(['--full', '--repeats', '0']), /whole number/);
    assert.throws(() => parseArgs(['--goal']), /needs a value/);
    assert.equal(parseArgs(['--mock']).review, false);
    assert.equal(parseArgs(['--timeout=30', '--smoke']).timeoutMs, 30_000);
  });

  it('gives an API planner a longer limit, and reads the re-score and baseline flags', () => {
    const opts = parseArgs(['--full', '--timeout', '600']);
    assert.equal(opts.apiTimeoutMs, 1_200_000);
    assert.equal(timeoutFor(CELLS.find((c) => c.id === 'openrouter/glm-5.3-flash'), opts), 1_200_000);
    assert.equal(timeoutFor(CELLS.find((c) => c.id === 'claude-code/haiku'), opts), 600_000);
    assert.equal(timeoutFor(mockCell(3799), opts), 600_000);
    assert.equal(parseArgs(['--full', '--api-timeout', '90']).apiTimeoutMs, 90_000);
    const rescore = parseArgs(['--rescore', 'a', '--out', 'b', '--no-review']);
    assert.deepEqual([rescore.mode, rescore.rescore, rescore.out, rescore.review], ['rescore', 'a', 'b', false]);
    assert.equal(parseArgs(['--rescore', 'a']).review, true);
    assert.equal(parseArgs(['--full', '--baseline-from', 'stored']).baselineFrom, 'stored');
  });

  it('appends the nudges to V0 alone, verbatim', () => {
    const g = goal('g3');
    assert.equal(goalText(g, VARIANTS.V0), `${g.goal}\n\n${NUDGES[0]}\n\n${NUDGES[1]}`);
    assert.equal(goalText(g, VARIANTS.V1), g.goal);
  });

  it("hands a run's environment the planner, its own settings, and an OpenRouter key only where it plans through one", () => {
    const base = { OPENROUTER_API_KEY: 'k', NODE_OPTIONS: '--x', HOME: 'h' };
    const cell = CELLS.find((c) => c.id === 'claude-code/haiku');
    const env = runEnv(base, { cell, variant: VARIANTS.V1, settingsPath: 's.json', maxParallel: 4, enabledRunners: ['claude-code'] });
    assert.equal(env.OPENROUTER_API_KEY, undefined);
    assert.equal(env.NODE_OPTIONS, undefined);
    assert.equal(env.AI_PROVIDER, 'claude-code');
    assert.equal(env.ORCHESTRATOR_MODEL, 'haiku');
    assert.equal(env.ORDEWELL_SETTINGS_PATH, 's.json');
    assert.equal(env.HOME, 'h');
    assert.deepEqual(env.ORDEWELL_APPROVAL_ALLOW.split(','), TEST_COMMANDS);
    assert.ok(TEST_COMMANDS.includes('npx vitest run'));
    const or = runEnv(base, { cell: CELLS.find((c) => c.id === 'openrouter/glm-5.3-flash'), variant: VARIANTS.V1, settingsPath: 's', maxParallel: 1, enabledRunners: ['claude-code'] });
    assert.equal(or.OPENROUTER_API_KEY, 'k');
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

  it("detects a quota only from the runner's error event or a failed exit, never the planner's prose", () => {
    const prose = "Task 2 adds a usage limit line to the card, so the user sees the token usage limit reached by a task.";
    assert.equal(quotaOf({ stopped: 'timeout', lastText: prose, screen: prose }), null);
    assert.equal(quotaOf({ stopped: 'tui exited', lastText: prose, exitCode: 0, screen: prose }), null);
    assert.equal(quotaOf({ stopped: 'plan submitted', lastText: 'usage limit', screen: '' }), null);
    assert.match(quotaOf({ stopped: 'error', lastText: 'Error: monthly usage limit reached' }), /usage limit/);
    assert.match(quotaOf({ stopped: 'tui exited', exitCode: 1, screen: 'fatal: 429 Too Many Requests' }), /429/);
  });

  it('names runs so a file name can hold them', () => {
    assert.equal(runId(CELLS[2], VARIANTS.V1, goal('g2'), 3), 'g2--opencode_deepseek-v4.1-flash--V1--r3');
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

describe("a run's clone", () => {
  it("copies a build's node_modules in as real files and recreates its links verbatim", () => {
    const dir = tmp();
    const from = path.join(dir, 'build', 'node_modules');
    fs.mkdirSync(path.join(from, 'pkg', 'lib'), { recursive: true });
    fs.writeFileSync(path.join(from, 'pkg', 'lib', 'index.js'), 'ok');
    const linked = process.platform !== 'win32';
    if (linked) fs.symlinkSync(path.join('..', '..', 'packages', 'core'), path.join(from, 'core'), 'dir');
    const to = path.join(dir, 'clone', 'node_modules');
    linkTree(from, to);
    assert.equal(fs.readFileSync(path.join(to, 'pkg', 'lib', 'index.js'), 'utf8'), 'ok');
    assert.ok(!fs.lstatSync(path.join(to, 'pkg')).isSymbolicLink(), 'a directory is a directory of the clone, not a link out of it');
    if (linked) assert.equal(fs.readlinkSync(path.join(to, 'core')), path.join('..', '..', 'packages', 'core'));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("puts the clones where the builds' file system is, falling back to the first candidate", () => {
    const dir = tmp();
    assert.equal(workParent(dir, [path.join(dir, 'missing'), os.tmpdir()]), os.tmpdir());
    assert.equal(workParent(path.join(dir, 'missing'), ['a', 'b']), 'a');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('re-scoring stored runs', () => {
  const runBench = (args) => spawnSync(process.execPath, [path.join(import.meta.dirname, 'run.mjs'), ...args], {
    encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' }, timeout: 60_000,
  });
  const session = (tasks) => ({
    plan: { tasks },
    conversation: { conversationHistory: [{ role: 'user', content: 'goal' }, { kind: 'plan_generated', content: 'Plan generated' }], researchLog: [] },
  });
  const store = (dir, id, record, tasks) => {
    fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ id, cell: 'c', repeat: 1, ...record }));
    if (tasks) fs.writeFileSync(path.join(dir, `${id}.session.json`), JSON.stringify(session(tasks)));
  };

  it('scores each run with the current key, drops a review the changed key made stale, and fails a stored timeout', () => {
    const dir = tmp();
    const from = path.join(dir, 'stored');
    fs.mkdirSync(from);
    fs.writeFileSync(path.join(from, 'meta.json'), JSON.stringify({ mode: 'full', started: 'then' }));
    const fix = [task('1', 'Fix worstSeverity in Handoff.ts', { prompt: 'Handoff.ts:42 reads SEVERITY_RANK backwards; run Handoff.test.ts first, before you change it, then run taskRow.test.ts.' })];
    const rubric = { ok: true, problems: [] };
    store(from, 'g4--c--V0--r1', { goal: 'g4', variant: 'V0', keyHash: 'old', rubric, metrics: { submitted: true, stopped: 'plan submitted', turns: 2 } }, fix);
    store(from, 'g1--c--V0--r1', { goal: 'g1', variant: 'V0', keyHash: keyHash(goal('g1')), rubric, metrics: { submitted: true, stopped: 'plan submitted' } }, [task('1', 'Core')]);
    store(from, 'g3--c--V1--r1', { goal: 'g3', variant: 'V1', metrics: { submitted: false, stopped: 'timeout', wallMs: 900_000 } }, []);
    const to = path.join(dir, 'rescored');
    const out = runBench(['--rescore', from, '--out', to, '--no-review']);
    assert.equal(out.status, 0, out.stdout + out.stderr);
    const read = (id) => JSON.parse(fs.readFileSync(path.join(to, `${id}.json`), 'utf8'));
    const g4 = read('g4--c--V0--r1');
    assert.equal(g4.keyHash, keyHash(goal('g4')));
    assert.deepEqual(keyViolations(g4.keyChecks), []);
    assert.equal(g4.rubric, undefined);
    assert.equal(g4.rubricStale, true);
    assert.deepEqual(read('g1--c--V0--r1').rubric, rubric, 'an unchanged key keeps its review');
    assert.equal(read('g3--c--V1--r1').error, 'timeout after 900s');
    assert.ok(fs.existsSync(path.join(to, 'g4--c--V0--r1.session.json')));
    const { passes } = JSON.parse(fs.readFileSync(path.join(to, 'meta.json'), 'utf8'));
    assert.equal(passes[0].mode, 'rescore');
    assert.deepEqual(passes[0].fromPasses, [{ mode: 'full', started: 'then' }]);
    assert.equal(JSON.parse(fs.readFileSync(path.join(from, 'g4--c--V0--r1.json'), 'utf8')).keyHash, 'old', 'the stored run is left as it was');
    assert.equal(runBench(['--rescore', from, '--out', from, '--no-review']).status, 1);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("compares a new candidate with a stored directory's V0, where the new directory ran none of its own", () => {
    const dir = tmp();
    const [stored, fresh] = [path.join(dir, 'stored'), path.join(dir, 'fresh')];
    fs.mkdirSync(stored);
    fs.mkdirSync(fresh);
    const metrics = { submitted: true, stopped: 'plan submitted', wordingViolations: [] };
    store(stored, 'g3--c--V0--r1', { goal: 'g3', variant: 'V0', metrics, keyChecks: [] });
    store(stored, 'g4--c--V0--r1', { goal: 'g4', variant: 'V0', metrics, keyChecks: [] });
    store(fresh, 'g3--c--V1--r1', { goal: 'g3', variant: 'V1', metrics, keyChecks: [] });
    store(fresh, 'g4--c--V0--r1', { goal: 'g4', variant: 'V0', metrics, keyChecks: [{ check: 'x', status: 'fail', detail: 'fresh' }] });
    const out = runBench(['--report', fresh, '--baseline-from', stored]);
    assert.equal(out.status, 0, out.stdout + out.stderr);
    const { records, verdicts } = JSON.parse(fs.readFileSync(path.join(fresh, 'report.json'), 'utf8'));
    const v0 = records.filter((r) => r.variant === 'V0');
    assert.deepEqual(v0.map((r) => [r.goal, r.source ?? 'own']).sort(), [['g3', stored], ['g4', 'own']]);
    assert.equal(verdicts.find((v) => v.candidate === 'V1').result, 'pass');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
