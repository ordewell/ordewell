import { describe, it, expect, vi } from 'vitest';
import type { CompactableMessage } from '../contextCompaction';
import { summaryRequest } from '../conversationSummary';
import { condense, effectLedger, renderMessages, summaryLimits, ContextSummaryError, SUMMARY_LIMITS, type SummaryCall, type SummaryCallRequest } from '../contextSummary';

const tagged = (text: string) => `<conversation_summary>${text}</conversation_summary>`;
const SUMMARY = 'The user wants the cache mapped; src/cache.ts holds the LRU, and make test passed after the eviction fix in src/cache/lru.ts:42.';

/** A summary call that records what it was sent and answers from a script. */
function scripted(...replies: Array<(req: SummaryCallRequest) => string>): SummaryCall & { requests: SummaryCallRequest[] } {
  const requests: SummaryCallRequest[] = [];
  const call: SummaryCall = async (req, onUsage) => {
    requests.push(req);
    onUsage({ source: 'test', model: req.model, inputTokens: Math.ceil((req.instructions.length + req.input.length) / 4), outputTokens: 10 });
    return { text: (replies.shift() ?? (() => tagged(SUMMARY)))(req), finishReason: 'stop' };
  };
  return Object.assign(call, { requests });
}

const said = (role: string, text: string): CompactableMessage => ({ role, content: text });

function request(messages: CompactableMessage[], limits = summaryLimits({ contextWindow: 1_000_000 }, 32_000, 4)) {
  return { model: 'm', subject: 'history' as const, messages, limits, current: () => true, onUsage: vi.fn() };
}

describe('condense', () => {
  it('refuses a summary within its room that is most of what it was given: it condensed nothing', async () => {
    const messages = [said('user', `notes: ${'note '.repeat(2_000)}`)];
    const call = scripted((req) => tagged(req.input.slice(0, Math.ceil(req.input.length * 0.7))));
    await expect(condense(call, request(messages))).rejects.toThrow(/did not condense/);
  });

  it('takes a short summary of a short conversation: what is too short, or not condensed, is judged against what it condensed', async () => {
    const messages = [said('user', 'build me a parser'), said('assistant', 'Which formats?'), said('user', 'JSON only, streaming'), said('assistant', 'Noted.')];
    await expect(condense(scripted(() => tagged('The user wants a streaming JSON parser.')), request(messages))).resolves.toBe('The user wants a streaming JSON parser.');
    await expect(condense(scripted(() => tagged('Parser.')), request(messages))).rejects.toThrow(/too short/);
  });

  it('folds what one call cannot carry part by part, each within its input, into the summary so far', async () => {
    const messages = Array.from({ length: 6 }, (_, i) => said('user', `part ${i}: ${'p'.repeat(20_000)}`));
    // A window of 12,000 tokens at 4 characters each: one call carries one part beside the summary so far.
    const limits = summaryLimits({ contextWindow: 12_000 }, 32_000, 4);
    let pass = 0;
    const call = scripted(...Array.from({ length: 6 }, () => () => tagged(`${SUMMARY} Pass ${++pass}.`)));

    const summary = await condense(call, request(messages, limits));

    expect(call.requests).toHaveLength(6);
    for (const req of call.requests) expect(req.instructions.length + req.input.length).toBeLessThanOrEqual(limits.inputChars);
    expect(call.requests[0].input).not.toContain('<summary_so_far>');
    for (const [i, req] of call.requests.slice(1).entries()) expect(req.input).toContain(`<summary_so_far>\n${SUMMARY} Pass ${i + 1}.\n</summary_so_far>`);
    expect(summary).toBe(`${SUMMARY} Pass 6.`);
    // Every part was read once, in order.
    const seen = call.requests.flatMap((r) => [...r.input.matchAll(/part (\d):/g)].map((m) => Number(m[1])));
    expect(seen).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('makes no call when what it condenses would take more passes than its bound, or the window leaves no room for a part', async () => {
    const call = scripted();
    const many = Array.from({ length: SUMMARY_LIMITS.maxPasses * 3 }, (_, i) => said('user', `part ${i}: ${'p'.repeat(20_000)}`));
    await expect(condense(call, request(many, summaryLimits({ contextWindow: 12_000 }, 32_000, 4)))).rejects.toThrow(/too long to condense/);
    await expect(condense(call, request(many, summaryLimits({ contextWindow: 1_000 }, 32_000, 4)))).rejects.toThrow(/no room/);
    expect(call.requests).toHaveLength(0);
  });

  it('refuses a reply once what it was for no longer stands, and stops on a stop', async () => {
    const stale = request([said('user', 'n'.repeat(5_000))]);
    await expect(condense(scripted(), { ...stale, current: () => false })).rejects.toBeInstanceOf(ContextSummaryError);

    const controller = new AbortController();
    const call = scripted(() => { controller.abort(); return tagged(SUMMARY); });
    await expect(condense(call, { ...request([said('user', 'n'.repeat(5_000))]), signal: controller.signal })).rejects.toThrow(/stopped/);
  });

  it('asks for no longer a summary than the provider serves, nor more than a tenth of what a call may carry', () => {
    expect(summaryLimits({ contextWindow: 1_000_000, maxOutputTokens: 2_000 }, 32_000, 4).maxOutputTokens).toBe(2_000);
    expect(summaryLimits({ contextWindow: 1_000_000 }, 32_000, 4).maxOutputTokens).toBe(SUMMARY_LIMITS.maxOutputTokens);
    // 32,768 less its 8,192-token reply leaves 24,576 a call may carry: a tenth of it.
    expect(summaryLimits({ contextWindow: 32_768 }, 32_000, 4).maxOutputTokens).toBe(2_457);
    expect(summaryLimits(undefined, 32_000, 4)).toMatchObject({ inputChars: Infinity, maxOutputTokens: SUMMARY_LIMITS.maxOutputTokens });
  });
});

describe('what a summary call is shown', () => {
  it('names each call and the result answering it, and leaves out the catalog and plan blocks the planner is sent every turn', () => {
    const rendered = renderMessages([
      said('user', '<available_models>\nclaude-code: a, b\n</available_models>\n\n<current_plan>\n#1 "Parse"\n</current_plan>\nadd streaming'),
      { role: 'assistant', content: 'Reading.', tool_calls: [{ id: 'c1', function: { name: 'read_file', arguments: '{"path":"src/a.ts"}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: 'export const a = 1;' },
    ]);
    expect(rendered).toEqual([
      '[user]\n[model catalog omitted]\n\n[plan block omitted: the current plan is given separately]\nadd streaming',
      '[planner]\nReading.\n[planner called read_file({"path":"src/a.ts"})]',
      '[read_file result]\nexport const a = 1;',
    ]);
  });
});

describe('effectLedger', () => {
  it('lists the calls that changed something or reached out, with what came back, and none of the reads that can be made again', () => {
    const ledger = effectLedger([
      { role: 'assistant', content: null, tool_calls: [
        { id: 'r', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } },
        { id: 'q', function: { name: 'task_query', arguments: '{"task":"#1"}' } },
        { id: 'b', function: { name: 'bash', arguments: '{"command":"npm test"}' } },
        { id: 't', function: { name: 'run_task', arguments: '{"task":"#2"}' } },
        { id: 'w', function: { name: 'fetch', arguments: '{"url":"https://example.com"}' } },
      ] },
      { role: 'tool', tool_call_id: 'r', content: 'file' },
      { role: 'tool', tool_call_id: 'q', content: 'task' },
      { role: 'tool', tool_call_id: 'b', content: `12 passed\n${'.'.repeat(500)}` },
      { role: 'tool', tool_call_id: 't', content: 'Started #2.' },
    ]);
    expect(ledger).toEqual([
      `- bash({"command":"npm test"}) → 12 passed ${'.'.repeat(SUMMARY_LIMITS.ledgerResultChars - 11)}…`,
      '- run_task({"task":"#2"}) → Started #2.',
      '- fetch({"url":"https://example.com"}) → no result recorded',
    ]);
  });
});

describe('what a summary is asked to keep, by an API planner or a harness one', () => {
  async function apiInstructions(subject: 'history' | 'turn'): Promise<string> {
    const call = scripted();
    await condense(call, { ...request([said('user', 'build me a parser'), said('assistant', 'Which formats? '.repeat(40))]), subject });
    return call.requests[0].instructions;
  }

  it('keeps the rule about a secret, never its value, in every summary prompt', async () => {
    for (const prompt of [summaryRequest(null), await apiInstructions('history'), await apiInstructions('turn')]) {
      expect(prompt).toMatch(/never (?:copy|write|quote)[^.]*value/i);
      expect(prompt).toContain('the key goes only into task environments');
    }
  });

  it('asks a harness planner for everything an API planner keeps of the history', async () => {
    const harness = summaryRequest(['#1 build the lexer']);
    for (const kept of [
      'every instruction, constraint and preference still standing',
      'any skill loaded into the conversation by name and what it requires',
      'Keep exactly, as the conversation has them: file paths, symbols, line references, commands and their outcomes, URLs, task references and quoted requirements.',
      'Task statuses and run state are not yours to keep: the current plan is authoritative',
      'open questions and what the planner was waiting on',
    ]) {
      expect(harness).toContain(kept);
      expect(await apiInstructions('history')).toContain(kept);
    }
    expect(harness).toContain('<current_plan>\n#1 build the lexer\n</current_plan>');
  });
});
