import { describe, it, expect } from 'vitest';
import { BaseAiService, type ResearchChat, type ResearchTurn, type ToolResult, type ConversationTurnContext } from '../BaseAiService';
import type { ResearchProgress } from '../../models/Task';
import { fakeConfig, fakeFileSystem } from '../../testing';

/**
 * A reply with no tool call whose text is a call written out as markup is not
 * a finished reply: the API planner's turn (a user turn and a supervisor's
 * wake-up alike run through `runConversationTurn`) answers it once, then
 * accepts it as text and says in its record that nothing was executed.
 */

class ScriptedChat implements ResearchChat {
  sent: string[] = [];
  toolResultsSent: ToolResult[][] = [];
  // Optional on the interface: a harness planner's chat has none.
  offeredTools?: () => ReadonlySet<string>;
  constructor(private turns: ResearchTurn[], offered: string[] | null = ['message_task', 'read_file']) {
    if (offered) this.offeredTools = () => new Set(offered);
  }
  async sendMessage(text: string): Promise<ResearchTurn> {
    this.sent.push(text);
    return this.next();
  }
  async sendToolResults(results: ToolResult[]): Promise<ResearchTurn> {
    this.toolResultsSent.push(results);
    return this.next();
  }
  private next(): ResearchTurn {
    const turn = this.turns.shift();
    if (!turn) throw new Error('ScriptedChat exhausted');
    return turn;
  }
}

class TestService extends BaseAiService {
  reset(): void {}
  ensureInit(): void {}
  protected async streamPlanText(): Promise<string> { return ''; }
  runTurn(ctx: ConversationTurnContext, onProgress: (p: ResearchProgress) => void = () => {}) {
    return this.runConversationTurn(ctx, 'go', onProgress);
  }
  static oneShot(chat: ResearchChat, researchMaxSteps = 10) {
    return new TestService(fakeConfig({ researchMaxSteps })).runOneShot(chat);
  }
  runOneShot(chat: ResearchChat) {
    return this.runResearchLoop(chat, 'go', fakeFileSystem({}), () => {}, ['claude-code']);
  }
}

const proseTurn = (text: string, segmentId?: string): ResearchTurn => ({ text, toolCalls: [], hasToolCalls: false, ...(segmentId ? { segmentId } : {}) });
const toolTurn = (name: string, args: Record<string, unknown> = {}): ResearchTurn => ({ text: '', toolCalls: [{ name, args, id: 'c1' }], hasToolCalls: true });

const DSML = '<｜DSML｜ invoke name="message_task">\n<｜DSML｜ parameter name="task">task-7</｜DSML｜ parameter>\n</｜DSML｜ invoke>';
const NOTE = '[Ordewell] Your last reply wrote a tool call (message_task) as text, so it was not made. Make the call with the tool, not in your reply text.';

const SPENT = '[Ordewell] The planner wrote a message_task call as text after its tool budget was spent: the call was not executed.';

function run(chat: ResearchChat, researchMaxSteps = 10) {
  const progress: ResearchProgress[] = [];
  const calls: string[] = [];
  const fs = fakeFileSystem({ readFile: async (p) => { calls.push(p); return { success: true, output: 'body', truncated: false }; } });
  const turn = new TestService(fakeConfig({ researchMaxSteps })).runTurn({ chat, fs, runners: ['claude-code'] }, (p) => progress.push(p));
  return { turn, progress, calls };
}

const systemLines = (turn: Awaited<ReturnType<typeof run>['turn']>): string[] =>
  turn.researchLog.flatMap((entry) => ('type' in entry && entry.type === 'system' ? [entry.content] : []));

describe('a call written as text in the API planner\'s reply', () => {
  it('is answered once with a short instruction, and the turn ends on the reply made after it', async () => {
    const chat = new ScriptedChat([proseTurn(DSML, 'seg-1'), proseTurn('Told task-7.')]);
    const { turn, progress } = run(chat);
    const settled = await turn.then((t) => t);

    expect(chat.sent).toEqual(['go', NOTE]);
    expect(settled).toMatchObject({ kind: 'message', text: 'Told task-7.' });
    expect(systemLines(settled)).toEqual([]);
    // The markup is taken back from the surface, and is not kept as narration before the reply.
    expect(progress).toContainEqual({ type: 'text_retracted', segmentId: 'seg-1' });
    expect(settled.runs?.map((run) => run.text)).toEqual(['Told task-7.']);
  });

  it('never runs the written call, and a real call made after the instruction runs', async () => {
    const chat = new ScriptedChat([proseTurn('<invoke name="read_file">\n<parameter name="path">secret.ts</parameter>\n</invoke>'), toolTurn('read_file', { path: 'a.ts' }), proseTurn('Read it.')]);
    const { turn, calls } = run(chat);
    const settled = await turn;
    expect(calls).toEqual(['a.ts']);
    expect(settled).toMatchObject({ kind: 'message', text: 'Read it.' });
  });

  it('a second written call is accepted as text, and the turn\'s record says it was not executed', async () => {
    const chat = new ScriptedChat([proseTurn(DSML), proseTurn(DSML)]);
    const { turn, calls } = run(chat);
    const settled = await turn;

    expect(chat.sent).toEqual(['go', NOTE]);
    expect(calls).toEqual([]);
    expect(settled).toMatchObject({ kind: 'message', text: DSML });
    expect(systemLines(settled)).toEqual([
      '[Ordewell] The planner wrote a message_task call as text, twice, and did not make it: the call was not executed.',
    ]);
  });

  it('is answered after real tool rounds too', async () => {
    const chat = new ScriptedChat([toolTurn('read_file', { path: 'a.ts' }), proseTurn(DSML), proseTurn('Done.')]);
    const { turn } = run(chat);
    expect(await turn).toMatchObject({ text: 'Done.' });
    expect(chat.sent).toEqual(['go', NOTE]);
  });

  it('is not answered once the tool budget is spent, since the call it asks for could not run', async () => {
    const chat = new ScriptedChat([
      toolTurn('read_file', { path: 'a.ts' }), toolTurn('read_file', { path: 'b.ts' }), proseTurn(DSML),
      toolTurn('message_task'), toolTurn('message_task'),
    ]);
    const { turn, calls } = run(chat, 1);
    const settled = await turn;

    expect(chat.sent).toEqual(['go']);
    expect(calls).toEqual(['a.ts']);
    expect(settled).toMatchObject({ kind: 'message', text: DSML });
    expect(systemLines(settled)).toEqual([SPENT]);
  });

  it.each([
    ['prose naming a tool', 'I will use message_task to tell task-7.'],
    ['a code sample in an answer', 'Call it like this:\n\n```xml\n<invoke name="message_task">\n<parameter name="task">task-7</parameter>\n</invoke>\n```\n'],
    ['a quoted earlier call', '> <invoke name="message_task">\n\nThat is what I sent before.'],
    ['a call to a tool not offered', '<invoke name="launch_missiles">\n</invoke>'],
  ])('leaves %s as a finished reply', async (_label, text) => {
    const chat = new ScriptedChat([proseTurn(text)]);
    const { turn } = run(chat);
    expect(await turn).toMatchObject({ kind: 'message', text });
    expect(chat.sent).toEqual(['go']);
  });

  it('leaves a chat that names no offered tools alone (a harness planner)', async () => {
    const chat = new ScriptedChat([proseTurn(DSML)], null);
    const { turn } = run(chat);
    expect(await turn).toMatchObject({ kind: 'message', text: DSML });
    expect(chat.sent).toEqual(['go']);
  });

  it('does not answer a reply the output limit cut off', async () => {
    const chat = new ScriptedChat([{ ...proseTurn(DSML), finishReason: 'length' }]);
    const { turn } = run(chat);
    await turn;
    expect(chat.sent.filter((text) => text === NOTE)).toEqual([]);
  });

  describe('in the one-shot planner, which offers tools too', () => {
    it('is answered once, then the loop goes on with the reply', async () => {
      const chat = new ScriptedChat([proseTurn(DSML), proseTurn('Nothing more to read.')]);
      const result = await new TestService(fakeConfig()).runOneShot(chat);
      expect(chat.sent).toEqual(['go', NOTE]);
      expect(result.tasks).toBeNull();
      expect(result.researchResults).toContain('Nothing more to read.');
    });

    it('a second written call is recorded as not executed', async () => {
      const chat = new ScriptedChat([proseTurn(DSML), proseTurn(DSML)]);
      const result = await new TestService(fakeConfig()).runOneShot(chat);
      expect(chat.sent).toEqual(['go', NOTE]);
      expect(result.researchLog.flatMap((entry) => ('type' in entry && entry.type === 'system' ? [entry.content] : []))).toEqual([
        '[Ordewell] The planner wrote a message_task call as text, twice, and did not make it: the call was not executed.',
      ]);
    });

    it('is not answered on the last step, whose reply the loop would not go on with', async () => {
      const chat = new ScriptedChat([toolTurn('read_file', { path: 'a.ts' }), proseTurn(DSML), toolTurn('message_task')]);
      const result = await TestService.oneShot(chat, 2);
      expect(chat.sent).toEqual(['go']);
      expect(result.researchResults).toContain(DSML);
      expect(result.researchLog.flatMap((entry) => ('type' in entry && entry.type === 'system' ? [entry.content] : []))).toEqual([SPENT]);
    });
  });
});
