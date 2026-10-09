import { describe, it, expect } from 'vitest';
import { reduceConversation, type ConversationInput } from '../reduce';
import { play, unkeyed } from './helpers';
import {
  approvals, compaction, harnessSubagent, interleavedSubagents, legacyProse, parallelRound, planSnapshot, planTurn, preambledPlan, retractedAttempt, stoppedTurn,
  streamedReply, taskOpsTurn, usageUpdates,
} from './fixtures/turns';

describe('reduceConversation', () => {
  describe('streamed replies', () => {
    it('shows reply text as it streams, then the settled message in its place', () => {
      const midway = play(streamedReply.slice(0, 5));
      expect(unkeyed(midway.blocks)).toEqual([
        { type: 'message', role: 'user', text: 'add persistence', streaming: false, turnId: 't1' },
        { type: 'message', role: 'planner', text: 'Which store — SQLite or Postgres?', streaming: true, turnId: 't1', segmentId: 's1' },
      ]);

      const settled = play(streamedReply);
      expect(unkeyed(settled.blocks)).toEqual([
        { type: 'message', role: 'user', text: 'add persistence', streaming: false, turnId: 't1' },
        { type: 'message', role: 'planner', text: 'Which store: SQLite or Postgres?', streaming: false, turnId: 't1' },
      ]);
      expect(settled.blocks[1].id).toBe(midway.blocks[1].id);
    });

    // The TUI memoizes its chat body on array identity (layout.ts chatBodyLines),
    // and deltas arrive many times a second.
    it('shares every block a delta does not touch, and returns the view itself for an input it ignores', () => {
      const before = play(streamedReply.slice(0, 3));
      const after = reduceConversation(before, streamedReply[3]);

      expect(after.blocks[0]).toBe(before.blocks[0]);
      expect(after.blocks[1]).not.toBe(before.blocks[1]);
      expect(reduceConversation(after, { type: 'status_update', tasks: [] })).toBe(after);
      expect(reduceConversation(after, { type: 'planner_liveness' })).toBe(after);
    });

    it('takes back a retracted segment, or all of the turn\'s unsettled text, and keeps what settled', () => {
      const earlier = play(streamedReply);

      const oneSegment = play(retractedAttempt.slice(0, 6), earlier);
      expect(unkeyed(oneSegment.blocks).map((b) => (b.type === 'message' ? b.text : b.type))).toEqual([
        'add persistence', 'Which store: SQLite or Postgres?', 'split task 3', 'Checking the task first.', 'tool',
      ]);

      const wholeAttempt = play(retractedAttempt.slice(0, 8), earlier);
      expect(unkeyed(wholeAttempt.blocks).map((b) => (b.type === 'message' ? b.text : b.type))).toEqual([
        'add persistence', 'Which store: SQLite or Postgres?', 'split task 3', 'tool',
      ]);

      const settled = play(retractedAttempt, earlier);
      expect(unkeyed(settled.blocks).slice(2).map((b) => (b.type === 'message' ? [b.role, b.text, b.streaming] : b.type))).toEqual([
        ['user', 'split task 3', false], 'tool', ['planner', 'Task 3 splits cleanly into 3a and 3b.', false],
      ]);
    });
  });

  describe('thinking', () => {
    // Harness planners never segment their thinking; the API loops do.
    it('folds thinking deltas into one block per run, with a segment or without', () => {
      const view = play([
        { type: 'planner_turn_started', turnId: 't1', prompt: 'why?' },
        { type: 'planner_thinking_delta', turnId: 't1', text: 'Grep for ' },
        { type: 'planner_thinking_delta', turnId: 't1', text: 'the cache.' },
        { type: 'research_step', tool: 'grep', args: '{"pattern":"cache"}', toolCallId: 'c1', turnId: 't1' },
        { type: 'planner_thinking_delta', turnId: 't1', segmentId: 'r1', text: 'Found ' },
        { type: 'planner_thinking_delta', turnId: 't1', segmentId: 'r1', text: 'it.' },
        { type: 'planner_thinking_delta', turnId: 't1', segmentId: 'r2', text: 'Now the store.' },
      ]);

      expect(unkeyed(view.blocks).filter((b) => b.type === 'thinking')).toEqual([
        { type: 'thinking', text: 'Grep for the cache.', streaming: false, turnId: 't1' },
        { type: 'thinking', text: 'Found it.', streaming: false, turnId: 't1', segmentId: 'r1' },
        { type: 'thinking', text: 'Now the store.', streaming: true, turnId: 't1', segmentId: 'r2' },
      ]);
    });
  });

  describe('tool calls', () => {
    it('matches each result of a parallel round to its own call by id, whatever order they return in', () => {
      const view = play(parallelRound);

      expect(unkeyed(view.blocks).filter((b) => b.type === 'tool')).toEqual([
        {
          type: 'tool', toolCallId: 'call_a', tool: 'read_file', headline: { name: 'Read', keyArg: 'src/a.ts' }, args: '{"path":"src/a.ts"}',
          status: 'ok', outcome: 'success', output: 'export const a = 1;\nexport const aa = 11;\n', outputLineCount: 2, turnId: 't3',
        },
        {
          type: 'tool', toolCallId: 'call_b', tool: 'read_file', headline: { name: 'Read', keyArg: 'src/b.ts' }, args: '{"path":"src/b.ts"}',
          status: 'error', outcome: 'failure', output: 'ENOENT: src/b.ts', outputLineCount: 1, turnId: 't3',
        },
        {
          type: 'tool', toolCallId: 'call_c', tool: 'read_file', headline: { name: 'Read', keyArg: 'src/c.ts' }, args: '{"path":"src/c.ts"}',
          status: 'ok', outcome: 'success', output: 'export const c = 3;', outputLineCount: 1, turnId: 't3',
        },
        {
          type: 'tool', toolCallId: 'call_d', tool: 'bash', headline: { name: 'Bash', keyArg: 'rm -rf dist' }, args: '{"command":"rm -rf dist"}',
          status: 'denied', outcome: 'refused', output: 'Command refused: rm is destructive', outputLineCount: 1, turnId: 't3',
        },
      ]);
    });

    it('shows a call as pending until its result arrives', () => {
      const view = play(parallelRound.slice(0, 5));

      expect(unkeyed(view.blocks).flatMap((b) => (b.type === 'tool' ? [[b.toolCallId, b.status]] : []))).toEqual([
        ['call_a', 'pending'], ['call_b', 'pending'], ['call_c', 'ok'],
      ]);
    });

    it('falls back to the tool name for calls announced without an id', () => {
      const view = play([
        { type: 'research_step', tool: 'grep', args: '{"pattern":"a"}' },
        { type: 'research_step', tool: 'glob', args: '{"pattern":"*.ts"}' },
        { type: 'research_step_done', step: { id: 'rs-1', tool: 'grep', args: '{"pattern":"a"}', result: 'x.ts:1:a', success: true, outcome: 'success', timestamp: '2026-09-27T10:00:00.000Z' } },
      ]);

      expect(unkeyed(view.blocks).map((b) => (b.type === 'tool' ? [b.tool, b.status, b.output] : b.type))).toEqual([
        ['grep', 'ok', 'x.ts:1:a'], ['glob', 'pending', ''],
      ]);
    });
  });

  describe('subagents', () => {
    it('nests each subagent\'s reasoning and calls under it however their activity interleaves', () => {
      const view = play(interleavedSubagents);

      expect(unkeyed(view.blocks).slice(1)).toEqual([
        {
          type: 'subagent', subagentId: 'sa-1', toolCallId: 'call_s1', brief: 'Survey auth', model: 'gpt-5-mini', status: 'failed', turnId: 't4',
          digest: '[research agent failed: timeout]',
          children: [
            { type: 'thinking', text: 'Auth lives under src/auth.', streaming: false, turnId: 't4', subagentId: 'sa-1' },
            {
              type: 'tool', toolCallId: 'call_0', tool: 'grep', headline: { name: 'Grep', keyArg: 'login' }, args: '{"pattern":"login"}',
              status: 'ok', outcome: 'success', output: 'src/auth/login.ts:9', outputLineCount: 1, turnId: 't4',
            },
          ],
        },
        {
          type: 'subagent', subagentId: 'sa-2', toolCallId: 'call_s2', brief: 'Survey billing', model: 'gpt-5-mini', status: 'done', turnId: 't4',
          digest: 'Billing: src/billing', usage: { inputTokens: 900, outputTokens: 80 },
          children: [
            { type: 'thinking', text: 'Billing is', streaming: false, turnId: 't4', subagentId: 'sa-2' },
            {
              type: 'tool', toolCallId: 'call_0', tool: 'grep', headline: { name: 'Grep', keyArg: 'invoice' }, args: '{"pattern":"invoice"}',
              status: 'ok', outcome: 'success', output: 'src/billing/invoice.ts:4', outputLineCount: 1, turnId: 't4',
            },
          ],
        },
      ]);
    });

    it('turns the call that spawned a subagent into the subagent\'s block, under the same id', () => {
      const spawned = play(interleavedSubagents.slice(0, 2));
      const started = play(interleavedSubagents.slice(0, 3));

      expect(spawned.blocks[1]).toMatchObject({ type: 'tool', tool: 'spawn_research_agent', status: 'pending', spawns: 'sa-1' });
      expect(started.blocks[1]).toMatchObject({ type: 'subagent', subagentId: 'sa-1', status: 'running', children: [] });
      expect(started.blocks[1].id).toBe(spawned.blocks[1].id);
    });

    it('does the same for a harness planner\'s subagent, whose id is its call\'s', () => {
      const view = play(harnessSubagent);

      expect(unkeyed(view.blocks).slice(1)).toEqual([
        {
          type: 'subagent', subagentId: 'toolu_1', toolCallId: 'toolu_1', brief: 'Map the TUI', status: 'done', turnId: 't5',
          digest: 'TUI state lives in tui/state.ts', usage: { inputTokens: 1200 },
          children: [
            { type: 'thinking', text: 'Start with state.ts', streaming: false, turnId: 't5', subagentId: 'toolu_1' },
            {
              type: 'tool', toolCallId: 'toolu_2', tool: 'read_file', toolLabel: 'Read', headline: { name: 'Read', keyArg: 'tui/state.ts' },
              args: '{"file_path":"tui/state.ts","path":"tui/state.ts"}', status: 'ok', outcome: 'success', output: 'export interface TuiState {}', outputLineCount: 1, turnId: 't5',
            },
          ],
        },
      ]);
    });

    it('keeps a subagent running when its call returns before it finishes', () => {
      const launched = play([
        ...harnessSubagent.slice(0, 3),
        { type: 'research_step_done', step: { id: 'rs-1', tool: 'agent_tool', toolLabel: 'Agent', args: '{}', result: 'Async agent launched', success: true, outcome: 'success', toolCallId: 'toolu_1', timestamp: '2026-09-27T10:00:00.000Z' }, turnId: 't5' },
      ]);

      expect(unkeyed(launched.blocks).slice(1)).toMatchObject([{ type: 'subagent', subagentId: 'toolu_1', status: 'running', digest: '' }]);
    });

    it('gives a subagent seen first through its activity a block of its own', () => {
      const view = play([
        { type: 'research_step', tool: 'glob', args: '{"pattern":"*.go"}', subagentId: 'child-1', toolCallId: 'c1' },
        { type: 'subagent_started', subagentId: 'child-1', brief: 'Find the Go entry point' },
      ]);

      expect(unkeyed(view.blocks)).toMatchObject([
        { type: 'subagent', subagentId: 'child-1', brief: 'Find the Go entry point', status: 'running', children: [{ type: 'tool', tool: 'glob', status: 'pending' }] },
      ]);
    });
  });

  describe('plan markers', () => {
    it('shows a plan reply as a plan block, building while its JSON streams, and never as a message', () => {
      const building = play(planTurn.slice(0, 6));
      expect(unkeyed(building.blocks).at(-1)).toEqual({
        type: 'plan', status: 'building', text: '```json\n{"tasks": [{"title": "Add the SQLite store"}, {"title": "Migrate"}]}\n```', turnId: 't6', segmentId: 's1',
      });

      const settled = play(planTurn);
      expect(unkeyed(settled.blocks).map((b) => b.type)).toEqual(['message', 'tool', 'plan']);
      expect(unkeyed(settled.blocks).at(-1)).toEqual({ type: 'plan', status: 'generated', text: '', taskCount: 2, turnId: 't6' });
      expect(settled.blocks.at(-1)?.id).toBe(building.blocks.at(-1)?.id);
    });

    it('builds one envelope at a time, and a retracted envelope takes its building plan with it', () => {
      const turn: ConversationInput[] = [
        { type: 'planner_turn_started', turnId: 't9', prompt: 'split task 1' },
        { type: 'plan_token', token: '{"taskQuery":{"tasks":["#1"]}}', turnId: 't9', segmentId: 's1' },
        { type: 'plan_token', token: '{"tasks": [{"title": "Spl', turnId: 't9', segmentId: 's2' },
        { type: 'planner_text_retracted', turnId: 't9', segmentId: 's2' },
        { type: 'plan_token', token: '{"tasks": [{"title": "Split 1a"}]}', turnId: 't9', segmentId: 's3' },
      ];
      const plans = (n: number) => unkeyed(play(turn.slice(0, n)).blocks).filter((b) => b.type === 'plan');

      expect(plans(3)).toEqual([{ type: 'plan', status: 'building', text: '{"tasks": [{"title": "Spl', turnId: 't9', segmentId: 's2' }]);
      expect(plans(4)).toEqual([]);
      expect(plans(5)).toEqual([{ type: 'plan', status: 'building', text: '{"tasks": [{"title": "Split 1a"}]}', turnId: 't9', segmentId: 's3' }]);
    });

    it('leaves a turn\'s building plan alone when a plan it did not commit lands', () => {
      const building = play(planTurn.slice(0, 6));
      const history = (planTurn[6] as Extract<ConversationInput, { type: 'plan_generated' }>).plan.conversationHistory ?? [];

      const oneShot = reduceConversation(building, planSnapshot([
        ...history.slice(0, 3),
        { role: 'assistant', content: 'Plan updated — now 1 task.', timestamp: '2026-09-27T10:03:10.000Z', kind: 'plan_generated' },
      ], 1));

      expect(unkeyed(oneShot.blocks).filter((b) => b.type === 'plan').map((b) => b.type === 'plan' && b.status)).toEqual(['building', 'updated']);
    });

    it('drops a streamed envelope that settled as a message rather than a plan', () => {
      expect(unkeyed(play(taskOpsTurn.slice(0, 3)).blocks).map((b) => b.type)).toEqual(['message', 'plan']);
      expect(unkeyed(play(taskOpsTurn).blocks)).toEqual([
        { type: 'message', role: 'user', text: 'drop task 2', streaming: false, turnId: 't7' },
        { type: 'message', role: 'planner', text: 'Tasks updated:\n- Removed #2', streaming: false, turnId: 't7' },
      ]);
    });

    it('drops the prose an older daemon streamed as plan tokens once its message settles', () => {
      expect(unkeyed(play(legacyProse).blocks)).toEqual([
        { type: 'message', role: 'planner', text: 'Which store?', streaming: false },
      ]);
    });

    it('takes each marker and note from the transcript once, however often the plan is rebroadcast', () => {
      const planned = play(planTurn);
      const history = (planTurn[6] as Extract<ConversationInput, { type: 'plan_generated' }>).plan.conversationHistory ?? [];

      expect(reduceConversation(planned, planSnapshot(history, 2))).toBe(planned);

      const later = play([
        { type: 'local_entry', role: 'user', text: 'merge 1 and 2' },
        planSnapshot([
          ...history,
          { role: 'user', content: 'merge 1 and 2', timestamp: '2026-09-27T10:05:00.000Z' },
          { role: 'assistant', content: 'Plan updated — now 1 task.', timestamp: '2026-09-27T10:05:04.000Z', kind: 'plan_generated' },
          { role: 'assistant', content: 'Queued change applied between task batches:\n- merge 1 and 2\nThe plan now has 1 task.', timestamp: '2026-09-27T10:06:00.000Z', kind: 'system' },
        ], 1),
      ], planned);
      expect(unkeyed(later.blocks).slice(3)).toEqual([
        { type: 'message', role: 'user', text: 'merge 1 and 2', streaming: false },
        { type: 'plan', status: 'updated', text: '', taskCount: 1 },
        { type: 'message', role: 'system', text: 'Queued change applied between task batches:\n- merge 1 and 2\nThe plan now has 1 task.', streaming: false },
      ]);
    });
  });

  describe('compaction', () => {
    it('shows the summary a compaction announced as a system note, as the transcript records it', () => {
      const before = play(preambledPlan);

      expect(unkeyed(play(compaction, before).blocks).slice(2)).toEqual([
        { type: 'message', role: 'system', text: 'Conversation condensed.\n\nGoal: add persistence with SQLite.', streaming: false },
      ]);
    });
  });

  describe('turn end', () => {
    it('replaces a plan reply that streamed as text with its plan block', () => {
      expect(unkeyed(play(preambledPlan).blocks)).toEqual([
        { type: 'message', role: 'user', text: 'go ahead', streaming: false, turnId: 't8' },
        { type: 'plan', status: 'generated', text: '', taskCount: 1 },
      ]);
    });

    it('settles what a stopped turn left open: nothing streams, calls are interrupted, subagents stopped', () => {
      expect(unkeyed(play(stoppedTurn).blocks)).toEqual([
        { type: 'message', role: 'user', text: 'dig deeper', streaming: false, turnId: 't9' },
        { type: 'thinking', text: 'Looking at CI', streaming: false, turnId: 't9', segmentId: 'r1' },
        { type: 'message', role: 'planner', text: 'Let me check CI.', streaming: false, turnId: 't9', segmentId: 's1' },
        {
          type: 'tool', toolCallId: 'call_t', tool: 'bash', headline: { name: 'Bash', keyArg: 'npm test' }, args: '{"command":"npm test"}',
          status: 'interrupted', output: '', outputLineCount: 0, turnId: 't9',
        },
        {
          type: 'subagent', subagentId: 'sa-9', toolCallId: 'call_sp', brief: 'Check CI', status: 'stopped', digest: '', turnId: 't9',
          children: [{
            type: 'tool', toolCallId: 'call_r', tool: 'read_file', headline: { name: 'Read', keyArg: '.github/ci.yml' }, args: '{"path":".github/ci.yml"}',
            status: 'interrupted', output: '', outputLineCount: 0, turnId: 't9',
          }],
        },
      ]);
    });

    it('marks a subagent of a failed turn as failed', () => {
      const failed = play([...stoppedTurn.slice(0, -1), { type: 'planner_turn_ended', turnId: 't9', outcome: 'error' }]);

      expect(failed.blocks.find((b) => b.type === 'subagent')).toMatchObject({ status: 'failed' });
    });
  });

  describe('approvals', () => {
    it('shows a request as pending until it is answered, and says who decided', () => {
      expect(unkeyed(play(approvals.slice(0, 2)).blocks).at(-1)).toEqual({
        type: 'approval', approvalId: 'ap-1', kind: 'shell_command', subject: 'npm test', scope: 'npm test', detail: 'Runs the project\'s tests',
        status: 'pending', turnId: 't10',
      });

      expect(unkeyed(play(approvals).blocks).filter((b) => b.type === 'approval')).toEqual([
        {
          type: 'approval', approvalId: 'ap-1', kind: 'shell_command', subject: 'npm test', scope: 'npm test', detail: 'Runs the project\'s tests',
          status: 'granted', decidedBy: 'asked', turnId: 't10',
        },
        { type: 'approval', kind: 'external_path', subject: '/etc/hosts', scope: '/etc', status: 'denied', decidedBy: 'mode' },
        { type: 'approval', approvalId: 'ap-2', kind: 'url_fetch', subject: 'https://example.com/api', scope: 'example.com', status: 'denied', decidedBy: 'asked', turnId: 't10' },
      ]);
    });

    it('ignores an answer to a request it never saw', () => {
      const view = play(approvals.slice(0, 1));

      expect(reduceConversation(view, { type: 'approval_settled', id: 'elsewhere', granted: true })).toBe(view);
    });
  });

  describe('usage', () => {
    it('keeps one token line, last, updated in place once something has been measured', () => {
      expect(play(usageUpdates.slice(0, 1)).blocks).toEqual([]);

      const first = play(usageUpdates.slice(0, 2));
      const view = play(usageUpdates);

      expect(unkeyed(view.blocks)).toEqual([
        { type: 'message', role: 'system', text: 'Planner model: gpt-5', streaming: false },
        {
          type: 'usage',
          totals: { inputTokens: 2500, outputTokens: 120, reportedCost: { USD: 0.01 } },
          bySubagent: { 'sa-1': { inputTokens: 900, outputTokens: 30 } },
          contextFill: { usedTokens: 1600, windowTokens: 200000 },
        },
      ]);
      expect(view.blocks[1].id).toBe(first.blocks[0].id);
    });
  });
  describe('skill loads', () => {
    const grilling = { invokedBy: 'user', name: 'grilling', source: 'global', path: '~/.ordewell/skills/grilling/SKILL.md' } as const;

    it('adopts the sent line as typed, marks its skill tokens and puts each load right under it', () => {
      const view = play([
        { type: 'local_entry', role: 'user', text: '/grilling the cache' },
        { type: 'planner_turn_started', turnId: 't1', prompt: '/grilling the cache', skills: [grilling] },
      ]);
      expect(unkeyed(view.blocks)).toEqual([
        { type: 'message', role: 'user', text: '/grilling the cache', streaming: false, turnId: 't1', skills: ['grilling'] },
        { type: 'skill_load', invokedBy: 'user', name: 'grilling', source: 'global', path: '~/.ordewell/skills/grilling/SKILL.md', turnId: 't1' },
      ]);
      expect(new Set(view.blocks.map((b) => b.id)).size).toBe(2);
    });

    it('places the loads under the adopted line even when a notice landed after it', () => {
      const view = play([
        { type: 'local_entry', role: 'user', text: '/grilling it' },
        { type: 'local_entry', role: 'system', text: 'a notice' },
        { type: 'planner_turn_started', turnId: 't1', prompt: '/grilling it', skills: [grilling] },
      ]);
      expect(view.blocks.map((b) => b.type === 'message' ? b.role : b.type)).toEqual(['user', 'skill_load', 'system']);
    });

    it('shows a turn with no loads as before', () => {
      const view = play([{ type: 'planner_turn_started', turnId: 't1', prompt: '/nope' }]);
      expect(unkeyed(view.blocks)).toEqual([{ type: 'message', role: 'user', text: '/nope', streaming: false, turnId: 't1' }]);
    });

    it('takes nothing from a rebroadcast transcript\'s skill-load entries', () => {
      const view = play([{ type: 'planner_turn_started', turnId: 't1', prompt: '/grilling it', skills: [grilling] }]);
      const next = reduceConversation(view, planSnapshot([
        { role: 'user', content: '/grilling it', timestamp: '2026-09-27T10:00:00.000Z' },
        { role: 'user', content: '/grilling skill loaded', timestamp: '2026-09-27T10:00:00.000Z', kind: 'skill_load', skill: grilling },
      ]));
      expect(next.blocks).toEqual(view.blocks);
    });
  });
});
