import { describe, it, expect } from 'vitest';
import { compactToolMessages, compactResearchResults, withProactiveCompaction, COMPACTION_LIMITS, type CompactableMessage } from '../contextCompaction';
import type { ResearchChat, ResearchTurn } from '../BaseAiService';

const big = (label: string, chars = 5000) => `${label}: ${'x'.repeat(chars)}`;

function history(): CompactableMessage[] {
  return [
    { role: 'system', content: 'You are a planner.' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 'c1', function: { name: 'read_file' } },
        { id: 'c2', function: { name: 'spawn_research_agent' } },
        { id: 'c3', function: { name: 'grep' } },
      ],
    },
    { role: 'tool', tool_call_id: 'c1', content: big('raw file') },
    { role: 'tool', tool_call_id: 'c2', content: big('digest') },
    { role: 'tool', tool_call_id: 'c3', content: 'short grep hit' },
    { role: 'assistant', content: 'Findings so far…' },
  ];
}

describe('compactToolMessages', () => {
  it('prunes bulky raw tool outputs but keeps subagent digests whole', () => {
    const messages = history();
    const removed = compactToolMessages(messages);

    expect(removed).toBeGreaterThan(0);
    expect((messages[2].content as string).length).toBeLessThan(1000);
    expect(messages[2].content).toContain('read_file output pruned');
    expect(messages[3].content).toBe(big('digest'));
  });

  it('leaves small outputs and non-tool messages untouched', () => {
    const messages = history();
    compactToolMessages(messages);

    expect(messages[0].content).toBe('You are a planner.');
    expect(messages[4].content).toBe('short grep hit');
    expect(messages[5].content).toBe('Findings so far…');
  });

  it('keeps the head of a pruned output so the model retains a scent of it', () => {
    const messages = history();
    compactToolMessages(messages);
    expect((messages[2].content as string).startsWith('raw file: ')).toBe(true);
  });

  it('is idempotent: a second pass removes nothing more', () => {
    const messages = history();
    compactToolMessages(messages);
    expect(compactToolMessages(messages)).toBe(0);
  });
});

describe('withProactiveCompaction', () => {
  const turn = (promptTokens?: number): ResearchTurn => ({ text: 'ok', toolCalls: [], hasToolCalls: false, promptTokens });

  class FakeChat implements ResearchChat {
    compactions = 0;
    constructor(private turns: ResearchTurn[]) {}
    async sendMessage(): Promise<ResearchTurn> { return this.turns.shift()!; }
    async sendToolResults(): Promise<ResearchTurn> { return this.turns.shift()!; }
    compactHistory(): number { this.compactions++; return 1; }
  }

  it('compacts as soon as a turn reports prompt tokens at or past the threshold', async () => {
    const inner = new FakeChat([turn(COMPACTION_LIMITS.proactivePromptTokens), turn(50)]);
    const chat = withProactiveCompaction(inner);
    await chat.sendMessage('go');
    expect(inner.compactions).toBe(1);
    await chat.sendToolResults([]);
    expect(inner.compactions).toBe(1);
  });

  it('does not compact below the threshold or when usage is unreported', async () => {
    const inner = new FakeChat([turn(COMPACTION_LIMITS.proactivePromptTokens - 1), turn(undefined)]);
    const chat = withProactiveCompaction(inner);
    await chat.sendMessage('go');
    await chat.sendToolResults([]);
    expect(inner.compactions).toBe(0);
  });

  it('passes the turn through unchanged and keeps compactHistory delegating', () => {
    const inner = new FakeChat([turn(1)]);
    const chat = withProactiveCompaction(inner);
    expect(chat.compactHistory!()).toBe(1);
    expect(inner.compactions).toBe(1);
  });

  it('tolerates a chat without compactHistory', async () => {
    const bare: ResearchChat = {
      sendMessage: async () => turn(COMPACTION_LIMITS.proactivePromptTokens + 1),
      sendToolResults: async () => turn(),
    };
    const chat = withProactiveCompaction(bare);
    const t = await chat.sendMessage('go');
    expect(t.promptTokens).toBe(COMPACTION_LIMITS.proactivePromptTokens + 1);
    expect(chat.compactHistory).toBeUndefined();
  });
});

describe('compactResearchResults', () => {
  const block = (tool: string, args: string, output: string) => `\n[${tool}(${args})]\n${output}\n`;

  it('returns text under budget unchanged', () => {
    const text = block('grep', '{"pattern":"x"}', 'one hit');
    expect(compactResearchResults(text, 1000)).toBe(text);
  });

  it('prunes raw tool blocks before subagent digests', () => {
    const text =
      block('read_file', '{"path":"a.ts"}', big('file a')) +
      block('spawn_research_agent', '{"prompt":"map core"}', big('digest', 3000)) +
      block('grep', '{"pattern":"y"}', big('grep out'));
    const out = compactResearchResults(text, 6000);

    expect(out.length).toBeLessThanOrEqual(6000 + 200);
    expect(out).toContain(big('digest', 3000));
    expect(out).toContain('pruned');
    expect(out).toContain('[read_file({"path":"a.ts"})]');
  });

  it('only shrinks digests when raw blocks alone cannot meet the budget', () => {
    const text =
      block('spawn_research_agent', '{"prompt":"a"}', big('digest one')) +
      block('spawn_research_agent', '{"prompt":"b"}', big('digest two'));
    const out = compactResearchResults(text, 4000);

    expect(out.length).toBeLessThan(text.length);
    expect(out).toContain('digest one: ');
  });

  it('preserves the trailing [LLM response] synthesis over raw transcripts', () => {
    const text =
      block('bash', '{"command":"ls"}', big('listing')) +
      `\n[LLM response]\nFinal synthesis of the research.\n`;
    const out = compactResearchResults(text, 3000);

    expect(out).toContain('Final synthesis of the research.');
    expect(out).toContain('pruned');
  });

  it('does not treat output lines that mention tool names mid-line as headers', () => {
    // '[grep(' only opens a block at line start; mid-line mentions stay part
    // of the enclosing output and get pruned with it.
    const sneaky = 'the call [grep(pattern)] appears here\n' + 'y'.repeat(3000);
    const text = block('read_file', '{"path":"b.ts"}', sneaky) + block('grep', '{"pattern":"z"}', big('real grep'));
    const out = compactResearchResults(text, 4000);

    expect(out).not.toContain('y'.repeat(3000));
    expect(compactResearchResults(text, text.length)).toBe(text);
  });

  it('respects keepHeadChars on pruned blocks', () => {
    const text = block('bash', '{"command":"find"}', big('find out')) + block('grep', '{"p":"q"}', big('grep out'));
    const out = compactResearchResults(text, 1000);
    for (const piece of out.split('[... pruned')) {
      expect(piece.length).toBeLessThanOrEqual(COMPACTION_LIMITS.keepHeadChars + 100);
    }
  });
});
