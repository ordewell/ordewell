import { describe, it, expect } from 'vitest';
import { BaseAiService, type ResearchChat, type ResearchTurn, type ToolResult, type ConversationTurnContext } from '../BaseAiService';
import type { IConfig } from '../../interfaces/IConfig';
import type { IFileSystem } from '../../interfaces/IFileSystem';
import { fakeConfig as makeFakeConfig } from '../../testing';

const PLAN_JSON = JSON.stringify({
  tasks: [{
    id: 't1', order: 1, title: 'Add widget', description: 'Adds the widget module',
    type: 'ai', dependencies: [], prompt: 'Create src/widget.ts',
    assignedModel: { modelId: 'm', modelLabel: 'M' }, assignedRunner: 'claude-code',
    taskMode: 'acceptEdits', autonomy: 'AFK', sliceType: 'AFK', userStoriesCovered: [], subtasks: [],
  }],
});

const PRD_BLOCK = [
  '<!-- ORDEWELL_PRD_START slug="widget" -->',
  '# Problem',
  'We need a widget.',
  '<!-- ORDEWELL_PRD_END -->',
].join('\n');

const fakeConfig = (): IConfig => makeFakeConfig({ maxParallelSessions: 1, openAiBaseUrl: '' });

/** Scripted chat: pops one canned turn per send; records what it was sent. */
class ScriptedChat implements ResearchChat {
  sent: string[] = [];
  toolResultsSent: ToolResult[][] = [];
  compactHistory?: () => number;
  constructor(private turns: ResearchTurn[]) {}
  async sendMessage(text: string): Promise<ResearchTurn> {
    this.sent.push(text);
    const next = this.turns.shift();
    if (!next) throw new Error('ScriptedChat exhausted');
    return next;
  }
  async sendToolResults(results: ToolResult[]): Promise<ResearchTurn> {
    this.toolResultsSent.push(results);
    const next = this.turns.shift();
    if (!next) throw new Error('ScriptedChat exhausted');
    return next;
  }
}

class TestService extends BaseAiService {
  reset(): void {}
  ensureInit(): void {}
  protected async streamPlanText(): Promise<string> { return ''; }
  runTurn(
    ctx: ConversationTurnContext,
    message: string,
    onProgress: (p: import('../../models/Task').ResearchProgress) => void = () => {},
    signal?: AbortSignal,
  ) {
    return this.runConversationTurn(ctx, message, onProgress, signal);
  }
}

function makeCtx(chat: ResearchChat, prdEnabled = false): ConversationTurnContext {
  const fs = { readFile: async () => ({ success: true, output: '', truncated: false }) } as unknown as IFileSystem;
  return { chat, fs, runners: ['claude-code'], prdEnabled };
}

const proseTurn = (text: string): ResearchTurn => ({ text, toolCalls: [], hasToolCalls: false });

describe('runConversationTurn PRD guard', () => {
  it('carries the raw text on committed plan turns', async () => {
    const chat = new ScriptedChat([proseTurn(`Here is the plan:\n${PLAN_JSON}`)]);
    const svc = new TestService(fakeConfig());
    const turn = await svc.runTurn(makeCtx(chat), 'go');
    expect(turn.kind).toBe('plan');
    if (turn.kind === 'plan') expect(turn.text).toContain('"tasks"');
  });

  it('bounces a PRD-less plan once in PRD mode, then commits the corrected turn', async () => {
    const chat = new ScriptedChat([
      proseTurn(PLAN_JSON),
      proseTurn(`${PRD_BLOCK}\n${PLAN_JSON}`),
    ]);
    const svc = new TestService(fakeConfig());
    const turn = await svc.runTurn(makeCtx(chat, true), 'confirm, generate the plan');
    expect(turn.kind).toBe('plan');
    if (turn.kind === 'plan') expect(turn.text).toContain('ORDEWELL_PRD_START');
    expect(chat.sent).toHaveLength(2);
    expect(chat.sent[1]).toContain('no PRD has been produced');
  });

  it('accepts the plan after one failed nudge instead of looping', async () => {
    const chat = new ScriptedChat([proseTurn(PLAN_JSON), proseTurn(PLAN_JSON)]);
    const svc = new TestService(fakeConfig());
    const turn = await svc.runTurn(makeCtx(chat, true), 'go');
    expect(turn.kind).toBe('plan');
    expect(chat.sent).toHaveLength(2);
  });

  it('does not nudge when the PRD was already produced in an earlier turn', async () => {
    const chat = new ScriptedChat([proseTurn(PRD_BLOCK), proseTurn(PLAN_JSON)]);
    const svc = new TestService(fakeConfig());
    const ctx = makeCtx(chat, true);
    const first = await svc.runTurn(ctx, 'add a widget');
    expect(first.kind).toBe('message');
    const second = await svc.runTurn(ctx, 'confirm');
    expect(second.kind).toBe('plan');
    expect(chat.sent).toHaveLength(2);
  });

  it('never nudges when PRD mode is off', async () => {
    const chat = new ScriptedChat([proseTurn(PLAN_JSON)]);
    const svc = new TestService(fakeConfig());
    const turn = await svc.runTurn(makeCtx(chat), 'go');
    expect(turn.kind).toBe('plan');
    expect(chat.sent).toHaveLength(1);
  });
});

describe('runConversationTurn abort handling', () => {
  it('does not classify a plain-reply turn as a plan once the signal is aborted mid-flight', async () => {
    // Simulates Session.destroy() aborting a conversation whose LLM response
    // already arrived — without a post-loop abort check, this would still
    // return { kind: 'plan' } and land as a stray plan update on whatever
    // session is now current.
    const controller = new AbortController();
    const chat = new ScriptedChat([proseTurn(PLAN_JSON)]);
    const originalSend = chat.sendMessage.bind(chat);
    chat.sendMessage = async (text: string) => {
      const turn = await originalSend(text);
      controller.abort();
      return turn;
    };
    const svc = new TestService(fakeConfig());
    const turn = await svc.runTurn(makeCtx(chat), 'go', () => {}, controller.signal);
    expect(turn.kind).toBe('message');
  });

  it('classifies normally when the signal was never aborted', async () => {
    const controller = new AbortController();
    const chat = new ScriptedChat([proseTurn(PLAN_JSON)]);
    const svc = new TestService(fakeConfig());
    const turn = await svc.runTurn(makeCtx(chat), 'go', () => {}, controller.signal);
    expect(turn.kind).toBe('plan');
  });
});

describe('runConversationTurn task-query reads', () => {
  it('hands a read up as its own turn kind for the Session to answer', async () => {
    const chat = new ScriptedChat([proseTurn('{"taskQuery":{"tasks":["#3"],"catalog":true}}')]);
    const svc = new TestService(fakeConfig());
    const turn = await svc.runTurn(makeCtx(chat), 'go');
    expect(turn.kind).toBe('task_query');
    if (turn.kind !== 'task_query') return;
    expect(turn.query.tasks).toEqual(['#3']);
    expect(turn.query.catalog).toBe(true);
    // The read is settled by the Session, not by a second round here.
    expect(chat.sent).toHaveLength(1);
  });

  it('retries a malformed read once, then hands up the corrected one', async () => {
    const chat = new ScriptedChat([
      proseTurn('{"taskQuery":{"fields":["nonesuch"]}}'),
      proseTurn('{"taskQuery":{"tasks":["#1"]}}'),
    ]);
    const svc = new TestService(fakeConfig());
    const turn = await svc.runTurn(makeCtx(chat), 'go');
    expect(turn.kind).toBe('task_query');
    expect(chat.sent).toHaveLength(2);
    expect(chat.sent[1]).toContain('taskQuery');
  });
});

describe('runConversationTurn JSON repair', () => {
  it('retries a malformed plan attempt and commits the corrected re-emit', async () => {
    // Balanced tasks-keyed JSON that fails validation (missing sliceType).
    const broken = '{"tasks":[{"id":"t1","order":1,"title":"A","description":"d","type":"ai","dependencies":[],"subtasks":[]}]}';
    const chat = new ScriptedChat([proseTurn(broken), proseTurn(PLAN_JSON)]);
    const svc = new TestService(fakeConfig());
    const turn = await svc.runTurn(makeCtx(chat), 'go');
    expect(turn.kind).toBe('plan');
    expect(chat.sent).toHaveLength(2);
    expect(chat.sent[1]).toContain('could not be committed');
  });

  it('retries a truncated plan emission with the output-limit corrective, not the generic one', async () => {
    const chat = new ScriptedChat([
      proseTurn(PLAN_JSON.slice(0, PLAN_JSON.length - 20)),
      proseTurn(PLAN_JSON),
    ]);
    const svc = new TestService(fakeConfig());
    const turn = await svc.runTurn(makeCtx(chat), 'go');
    expect(turn.kind).toBe('plan');
    expect(chat.sent).toHaveLength(2);
    expect(chat.sent[1]).toContain('output length limit');
    expect(chat.sent[1]).toContain('brief');
  });

  it('compacts the chat history before a truncated-plan retry and says so in the corrective', async () => {
    const chat = new ScriptedChat([
      proseTurn(PLAN_JSON.slice(0, PLAN_JSON.length - 20)),
      proseTurn(PLAN_JSON),
    ]);
    let compactions = 0;
    chat.compactHistory = () => { compactions++; return 12345; };
    const svc = new TestService(fakeConfig());
    const turn = await svc.runTurn(makeCtx(chat), 'go');
    expect(turn.kind).toBe('plan');
    expect(compactions).toBe(1);
    expect(chat.sent[1]).toContain('trimmed');
  });

  it('treats a finish_reason=length turn whose JSON broke as truncation even without an unbalanced object', async () => {
    // Balanced but invalid plan JSON + finishReason 'length': the provider
    // says the reply was cut; trust it over the balance heuristic.
    const broken = '{"tasks":[{"title":"cut off mid-plan"}]}';
    const chat = new ScriptedChat([
      { text: broken, toolCalls: [], hasToolCalls: false, finishReason: 'length' },
      proseTurn(PLAN_JSON),
    ]);
    let compactions = 0;
    chat.compactHistory = () => { compactions++; return 1; };
    const svc = new TestService(fakeConfig());
    const turn = await svc.runTurn(makeCtx(chat), 'go');
    expect(turn.kind).toBe('plan');
    expect(compactions).toBe(1);
    expect(chat.sent[1]).toContain('output length limit');
  });

  it('a chat without compactHistory still gets the truncation corrective, without claiming a trim', async () => {
    const chat = new ScriptedChat([
      proseTurn(PLAN_JSON.slice(0, PLAN_JSON.length - 20)),
      proseTurn(PLAN_JSON),
    ]);
    const svc = new TestService(fakeConfig());
    const turn = await svc.runTurn(makeCtx(chat), 'go');
    expect(turn.kind).toBe('plan');
    expect(chat.sent[1]).toContain('output length limit');
    expect(chat.sent[1]).not.toContain('trimmed');
  });

  it('gives up after two repair nudges and surfaces the reply as prose', async () => {
    const broken = '{"tasks":[{"title":"still broken"}]}';
    const chat = new ScriptedChat([proseTurn(broken), proseTurn(broken), proseTurn(broken)]);
    const svc = new TestService(fakeConfig());
    const turn = await svc.runTurn(makeCtx(chat), 'go');
    expect(turn.kind).toBe('message');
    expect(chat.sent).toHaveLength(3);
  });

  it('does not nudge for prose that merely mentions "tasks"', async () => {
    const chat = new ScriptedChat([proseTurn('The plan will list its "tasks" once you confirm the outline.')]);
    const svc = new TestService(fakeConfig());
    const turn = await svc.runTurn(makeCtx(chat), 'go');
    expect(turn.kind).toBe('message');
    expect(chat.sent).toHaveLength(1);
  });

  it('retries a malformed taskOps attempt and returns the corrected ops', async () => {
    const chat = new ScriptedChat([
      proseTurn('{"taskOps":[{"update":"missing op field"}]}'),
      proseTurn('{"taskOps":[{"op":"remove","taskId":"#2"}]}'),
    ]);
    const svc = new TestService(fakeConfig());
    const turn = await svc.runTurn(makeCtx(chat), 'drop task 2');
    expect(turn.kind).toBe('task_ops');
    if (turn.kind === 'task_ops') expect(turn.ops).toEqual([{ op: 'remove', taskId: '#2' }]);
    expect(chat.sent).toHaveLength(2);
    expect(chat.sent[1]).toContain('task edits could not be applied');
  });

  it('leaves prose mentioning taskOps (without a JSON attempt) alone', async () => {
    const chat = new ScriptedChat([proseTurn('I can edit tasks via "taskOps" whenever you like.')]);
    const svc = new TestService(fakeConfig());
    const turn = await svc.runTurn(makeCtx(chat), 'ok');
    expect(turn.kind).toBe('message');
    expect(chat.sent).toHaveLength(1);
  });
});

describe('runConversationTurn proactive compaction', () => {
  it('compacts once a research turn reports prompt-token pressure, before the plan emission', async () => {
    const chat = new ScriptedChat([
      { text: '', toolCalls: [{ name: 'read_file', args: { path: 'x.ts' }, id: 'c1' }], hasToolCalls: true, promptTokens: 150_000 },
      { ...proseTurn(PLAN_JSON), promptTokens: 90_000 },
    ]);
    let compactions = 0;
    chat.compactHistory = () => { compactions++; return 500; };
    const svc = new TestService(fakeConfig());
    const turn = await svc.runTurn(makeCtx(chat), 'go');
    expect(turn.kind).toBe('plan');
    expect(compactions).toBe(1);
  });

  it('never compacts while usage stays under the threshold', async () => {
    const chat = new ScriptedChat([
      { text: '', toolCalls: [{ name: 'read_file', args: { path: 'x.ts' }, id: 'c1' }], hasToolCalls: true, promptTokens: 20_000 },
      { ...proseTurn(PLAN_JSON), promptTokens: 25_000 },
    ]);
    let compactions = 0;
    chat.compactHistory = () => { compactions++; return 0; };
    const svc = new TestService(fakeConfig());
    const turn = await svc.runTurn(makeCtx(chat), 'go');
    expect(turn.kind).toBe('plan');
    expect(compactions).toBe(0);
  });
});

describe('runConversationTurn tool budget exhaustion', () => {
  const toolTurn = (text: string, ids: string[]): ResearchTurn => ({
    text,
    toolCalls: ids.map((id) => ({ name: 'read_file', args: { path: 'x.ts' }, id })),
    hasToolCalls: true,
  });
  const cfg = (): IConfig => ({ ...fakeConfig(), researchMaxSteps: 1 });

  it('answers over-budget tool calls synthetically and returns the wrap-up prose, not the preamble', async () => {
    const chat = new ScriptedChat([
      toolTurn('', ['c1']),
      toolTurn('Let me read the full file using a different approach:', ['c2']),
      proseTurn('Summary of what I found so far. How should we proceed?'),
    ]);
    const svc = new TestService(cfg());
    const turn = await svc.runTurn(makeCtx(chat), 'build a new feature');
    expect(turn.kind).toBe('message');
    if (turn.kind === 'message') {
      expect(turn.text).toContain('Summary of what I found');
      expect(turn.text).not.toContain('different approach');
    }
    // One executed round, then one synthetic wrap-up round answering c2.
    expect(chat.toolResultsSent).toHaveLength(2);
    expect(chat.toolResultsSent[1]).toHaveLength(1);
    expect(chat.toolResultsSent[1][0].id).toBe('c2');
    expect(chat.toolResultsSent[1][0].output).toContain('exhausted');
  });

  it('gives up visibly when the model keeps demanding tools through both wrap-up nudges', async () => {
    const chat = new ScriptedChat([
      toolTurn('', ['c1']),
      toolTurn('', ['c2']),
      toolTurn('', ['c3']),
      toolTurn('', ['c4']),
    ]);
    const svc = new TestService(cfg());
    const turn = await svc.runTurn(makeCtx(chat), 'go');
    expect(turn.kind).toBe('message');
    if (turn.kind === 'message') expect(turn.text).toContain('budget');
    // One executed round + exactly two synthetic wrap-up rounds — bounded.
    expect(chat.toolResultsSent).toHaveLength(3);
  });

  it('warns the model in the last few rounds so it can land the turn, not before', async () => {
    const chat = new ScriptedChat([
      toolTurn('', ['c1']),
      toolTurn('', ['c2']),
      proseTurn('Wrapping up. Question: scope?'),
    ]);
    const svc = new TestService({ ...fakeConfig(), researchMaxSteps: 5 });
    const turn = await svc.runTurn(makeCtx(chat), 'go');
    expect(turn.kind).toBe('message');
    expect(chat.toolResultsSent).toHaveLength(2);
    // Round 0: 4 rounds left — no countdown yet.
    expect(chat.toolResultsSent[0][0].output).not.toContain('research budget');
    // Round 1: 3 rounds left — countdown starts.
    expect(chat.toolResultsSent[1][0].output).toContain('only 3 tool rounds left');
  });

  it('nudges once on an empty turn and returns the recovered reply', async () => {
    const chat = new ScriptedChat([
      proseTurn('   \n '),
      proseTurn('Sorry — Question: what is in scope?'),
    ]);
    const svc = new TestService(fakeConfig());
    const turn = await svc.runTurn(makeCtx(chat), 'do something');
    expect(turn.kind).toBe('message');
    if (turn.kind === 'message') expect(turn.text).toContain('Question');
    expect(chat.sent).toHaveLength(2);
    expect(chat.sent[1]).toContain('empty');
  });

  it('degrades to a visible failure when the model stays empty after the nudge', async () => {
    const chat = new ScriptedChat([proseTurn(''), proseTurn('')]);
    const svc = new TestService(fakeConfig());
    const turn = await svc.runTurn(makeCtx(chat), 'do something');
    expect(turn.kind).toBe('message');
    if (turn.kind === 'message') expect(turn.text).toContain('empty reply twice');
    expect(chat.sent).toHaveLength(2);
  });

  it('reports over-budget calls as not-executed steps rather than swallowing the round', async () => {
    const chat = new ScriptedChat([
      toolTurn('', ['c1']),
      toolTurn('', ['c2', 'c3']),
      proseTurn('Done researching. Question: scope?'),
    ]);
    const progress: import('../../models/Task').ResearchProgress[] = [];
    const svc = new TestService(cfg());
    const turn = await svc.runTurn(makeCtx(chat), 'go', (p) => progress.push(p));

    const results = progress.filter((p) => p.type === 'tool_result');
    expect(results.map((p) => p.step?.outcome)).toEqual(['success', 'not_executed', 'not_executed']);
    expect(results.map((p) => p.toolCallId)).toEqual(['c1', 'c2', 'c3']);
    expect(results[1].step?.result).toContain('NOT executed');
    expect(results[1].step?.success).toBe(false);
    // Each announced call still got its own tool_call event, so no surface has
    // a result with nothing to fold into.
    expect(progress.filter((p) => p.type === 'tool_call').map((p) => p.toolCallId)).toEqual(['c1', 'c2', 'c3']);

    expect(turn.kind).toBe('message');
    if (turn.kind === 'message') {
      expect(turn.researchLog.map((entry) => (entry as { outcome?: string }).outcome))
        .toEqual(['success', 'not_executed', 'not_executed']);
    }
  });

  it('executes nothing once the budget is exhausted', async () => {
    let reads = 0;
    const chat = new ScriptedChat([
      toolTurn('', ['c1']),
      toolTurn('', ['c2']),
      proseTurn('Done researching. Question: scope?'),
    ]);
    const svc = new TestService(cfg());
    const ctx = makeCtx(chat);
    ctx.fs = { readFile: async () => { reads++; return { success: true, output: '', truncated: false }; } } as unknown as IFileSystem;
    const turn = await svc.runTurn(ctx, 'go');
    expect(turn.kind).toBe('message');
    expect(reads).toBe(1);
  });
});

describe('spawn_research_agent interception', () => {
  const spawnCalls = (prompts: string[]): ResearchTurn => ({
    text: '',
    toolCalls: prompts.map((prompt, i) => ({ name: 'spawn_research_agent', args: { prompt }, id: `spawn${i + 1}` })),
    hasToolCalls: true,
  });

  /** Subagent chat that resolves after a real async gap and records overlap. */
  class SlowSubagentChat implements ResearchChat {
    constructor(private digest: string, private tracker: { inFlight: number; maxInFlight: number }) {}
    async sendMessage(): Promise<ResearchTurn> {
      this.tracker.inFlight++;
      this.tracker.maxInFlight = Math.max(this.tracker.maxInFlight, this.tracker.inFlight);
      await new Promise((r) => setTimeout(r, 5));
      this.tracker.inFlight--;
      return proseTurn(this.digest);
    }
    async sendToolResults(): Promise<ResearchTurn> { return proseTurn(this.digest); }
  }

  class SubagentTestService extends TestService {
    subagentChatsCreated = 0;
    tracker = { inFlight: 0, maxInFlight: 0 };
    reasoningCallbacks: Array<(delta: string) => void> = [];
    constructor(cfg: IConfig, private supported = true) { super(cfg); }
    setSubagentsEnabled(on: boolean) { this.researchSubagentsEnabled = on; }
    protected createSubagentChat(onReasoning?: (delta: string) => void): ResearchChat | null {
      if (!this.supported) return null;
      this.subagentChatsCreated++;
      if (onReasoning) this.reasoningCallbacks.push(onReasoning);
      return new SlowSubagentChat(`digest #${this.subagentChatsCreated}`, this.tracker);
    }
  }

  it('runs parallel spawn calls concurrently and keys each digest to its call id', async () => {
    const chat = new ScriptedChat([
      spawnCalls(['explore core', 'explore web', 'explore cli']),
      proseTurn('Synthesis. Question: proceed?'),
    ]);
    const svc = new SubagentTestService(fakeConfig());
    svc.setSubagentsEnabled(true);
    const turn = await svc.runTurn(makeCtx(chat), 'go');

    expect(turn.kind).toBe('message');
    expect(svc.subagentChatsCreated).toBe(3);
    expect(svc.tracker.maxInFlight).toBe(3);
    const results = chat.toolResultsSent[0];
    expect(results.map((r) => r.id)).toEqual(['spawn1', 'spawn2', 'spawn3']);
    for (const r of results) expect(r.output).toMatch(/digest #\d/);
  });

  it('bounds concurrency at 3 without refusing extra spawn calls', async () => {
    const chat = new ScriptedChat([
      spawnCalls(['a', 'b', 'c', 'd', 'e']),
      proseTurn('Synthesis.'),
    ]);
    const svc = new SubagentTestService(fakeConfig());
    svc.setSubagentsEnabled(true);
    await svc.runTurn(makeCtx(chat), 'go');

    expect(svc.subagentChatsCreated).toBe(5); // all executed…
    expect(svc.tracker.maxInFlight).toBeLessThanOrEqual(3); // …but never more than 3 at once
    expect(chat.toolResultsSent[0]).toHaveLength(5);
  });

  it('lets the planner follow an emerging thread: spawn works again on a later research round', async () => {
    const chat = new ScriptedChat([
      spawnCalls(['first thread']),
      spawnCalls(['second thread, discovered from the first digest']),
      proseTurn('Done.'),
    ]);
    const svc = new SubagentTestService(fakeConfig());
    svc.setSubagentsEnabled(true);
    const turn = await svc.runTurn(makeCtx(chat), 'go');

    expect(turn.kind).toBe('message');
    expect(svc.subagentChatsCreated).toBe(2);
    expect(chat.toolResultsSent).toHaveLength(2);
  });

  it('flag off: steers the model back to sequential research and never spawns', async () => {
    const chat = new ScriptedChat([
      spawnCalls(['explore core']),
      proseTurn('Understood, continuing sequentially.'),
    ]);
    const svc = new SubagentTestService(fakeConfig());
    // enabled defaults to false
    const turn = await svc.runTurn(makeCtx(chat), 'go');

    expect(turn.kind).toBe('message');
    expect(svc.subagentChatsCreated).toBe(0);
    expect(chat.toolResultsSent[0][0].output).toMatch(/not available/i);
  });

  it('provider without subagent support degrades to sequential even when enabled', async () => {
    const chat = new ScriptedChat([
      spawnCalls(['explore core']),
      proseTurn('Continuing sequentially.'),
    ]);
    const svc = new SubagentTestService(fakeConfig(), false); // createSubagentChat → null
    svc.setSubagentsEnabled(true);
    const turn = await svc.runTurn(makeCtx(chat), 'go');

    expect(turn.kind).toBe('message');
    expect(chat.toolResultsSent[0][0].output).toMatch(/not available/i);
  });

  it('a spawn crash becomes a failed tool result, never a failed turn', async () => {
    const chat = new ScriptedChat([
      spawnCalls(['explore core']),
      proseTurn('Continuing without subagents.'),
    ]);
    class ThrowingService extends SubagentTestService {
      protected createSubagentChat(): ResearchChat | null { throw new Error('factory blew up'); }
    }
    const svc = new ThrowingService(fakeConfig());
    svc.setSubagentsEnabled(true);
    const turn = await svc.runTurn(makeCtx(chat), 'go');

    expect(turn.kind).toBe('message');
    expect(chat.toolResultsSent[0][0].output).toContain('factory blew up');
    expect(chat.toolResultsSent[0][0].output).toMatch(/continue researching/i);
  });

  it('tags each spawn call with a distinct subagentId on both the initiating and final progress events', async () => {
    const chat = new ScriptedChat([
      spawnCalls(['explore core', 'explore web']),
      proseTurn('Synthesis.'),
    ]);
    const svc = new SubagentTestService(fakeConfig());
    svc.setSubagentsEnabled(true);
    const events: import('../../models/Task').ResearchProgress[] = [];
    await svc.runTurn(makeCtx(chat), 'go', (p) => events.push(p));

    const calls = events.filter((e) => e.type === 'tool_call' && e.tool === 'spawn_research_agent');
    const results = events.filter((e) => e.type === 'tool_result' && e.step?.tool === 'spawn_research_agent');
    expect(calls).toHaveLength(2);
    expect(results).toHaveLength(2);
    const callIds = calls.map((e) => e.subagentId);
    const resultIds = results.map((e) => e.subagentId);
    expect(callIds.every((id) => typeof id === 'string' && id.length > 0)).toBe(true);
    expect(new Set(callIds).size).toBe(2); // distinct per spawn call
    expect(new Set(resultIds)).toEqual(new Set(callIds)); // each result tagged with its own call's id
  });

  it('wires a reasoning callback into createSubagentChat, tagged with the same subagentId as its tool calls', async () => {
    const chat = new ScriptedChat([
      spawnCalls(['explore core']),
      proseTurn('Synthesis.'),
    ]);
    const svc = new SubagentTestService(fakeConfig());
    svc.setSubagentsEnabled(true);
    const events: import('../../models/Task').ResearchProgress[] = [];
    await svc.runTurn(makeCtx(chat), 'go', (p) => events.push(p));

    expect(svc.reasoningCallbacks).toHaveLength(1);
    svc.reasoningCallbacks[0]('Considering the auth flow…');

    const spawnId = events.find((e) => e.type === 'tool_call' && e.tool === 'spawn_research_agent')?.subagentId;
    const reasoningEvent = events.find((e) => e.type === 'thinking' && e.text === 'Considering the auth flow…');
    expect(spawnId).toBeTruthy();
    expect(reasoningEvent?.subagentId).toBe(spawnId);
  });

  it('rejects a spawn call with no usable prompt', async () => {
    const chat = new ScriptedChat([
      { text: '', toolCalls: [{ name: 'spawn_research_agent', args: {}, id: 'spawn1' }], hasToolCalls: true },
      proseTurn('Okay.'),
    ]);
    const svc = new SubagentTestService(fakeConfig());
    svc.setSubagentsEnabled(true);
    const turn = await svc.runTurn(makeCtx(chat), 'go');

    expect(turn.kind).toBe('message');
    expect(svc.subagentChatsCreated).toBe(0);
    expect(chat.toolResultsSent[0][0].output).toContain('prompt');
  });
});
