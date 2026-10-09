import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IConfig } from '../../interfaces/IConfig';
import type { IFileSystem } from '../../interfaces/IFileSystem';
import type { ResearchProgress } from '../../models/Task';
import { fakeConfig, fakeFileSystem } from '../../testing';
import type { SkillInfo } from '../SkillsService';

/** The chat instance every getGenerativeModel().startChat() hands back. */
const startChat = vi.hoisted(() => vi.fn());

vi.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: class {
    getGenerativeModel = () => ({ model: 'test-model', startChat: startChat, generateContentStream: vi.fn() });
  },
  SchemaType: { STRING: 'STRING', NUMBER: 'NUMBER', ARRAY: 'ARRAY', BOOLEAN: 'BOOLEAN', OBJECT: 'OBJECT' },
}));

import { GeminiService } from '../GeminiService';

interface ChunkSpec {
  candidates?: Array<{ content?: { parts?: Array<Record<string, unknown>> }; finishReason?: string }>;
  finishReason?: string;
  usageMetadata?: Record<string, unknown>;
}

type SendMessageStreamRequest = unknown;

function streamResult(chunks: ChunkSpec[]): { stream: AsyncIterable<ChunkSpec> } {
  return {
    stream: (async function* () {
      for (const chunk of chunks) yield chunk;
    })(),
  };
}

/** Wire the mocked chat so each call pops one canned stream and records the request. */
function scriptStreams(specs: { stream: AsyncIterable<ChunkSpec> }[]): { requests: SendMessageStreamRequest[] } {
  const requests: SendMessageStreamRequest[] = [];
  startChat.mockReturnValue({
    sendMessageStream: async (request: SendMessageStreamRequest) => {
      requests.push(request);
      const spec = specs[requests.length - 1];
      if (!spec) throw new Error('scripted streams exhausted');
      return spec;
    },
  });
  return { requests };
}

function geminiConfig(): IConfig {
  return fakeConfig({ aiProvider: 'google', apiKey: 'key', planningModel: 'test-model' });
}

describe('Gemini research chat streaming', () => {
  beforeEach(() => startChat.mockReset());

  it('streams a text reply as deltas under one segment per call, with one usage record from the final chunk', async () => {
    scriptStreams([
      streamResult([
        { candidates: [{ content: { parts: [{ thought: true, text: 'Considering the layout.' }] } }] },
        { candidates: [{ content: { parts: [{ text: 'Which ' }] } }] },
        { candidates: [{ content: { parts: [{ text: 'store?' }] }, finishReason: 'STOP' }] },
        { usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 8, cachedContentTokenCount: 100, totalTokenCount: 142 } },
      ]),
    ]);
    const service = new GeminiService(geminiConfig());
    const progress: ResearchProgress[] = [];
    const turn = await service.startConversation({
      goal: 'find a place',
      runners: ['claude-code'],
      modelsByRunner: {},
      fs: fakeFileSystem() as IFileSystem,
      onProgress: (p) => progress.push(p),
    });

    const textDeltas = progress.filter((p) => p.type === 'text_delta');
    expect(textDeltas.map((p) => p.text)).toEqual(['Which ', 'store?']);
    // One call, one segment: both deltas key to the same fresh segmentId.
    expect(new Set(textDeltas.map((p) => p.segmentId))).toHaveLength(1);
    expect(textDeltas[0].segmentId).toBeTruthy();

    expect(progress.filter((p) => p.type === 'thinking').map((p) => p.text)).toEqual(['Considering the layout.']);

    // Exactly one usage record, assembled from the final chunk's counters.
    const usage = progress.filter((p) => p.type === 'usage');
    expect(usage).toHaveLength(1);
    expect(usage[0].record).toEqual({ source: 'google', inputTokens: 120, outputTokens: 8, cachedInputTokens: 100 });

    // The final text still lands on the turn the loop classifies.
    expect(turn.kind).toBe('message');
    if (turn.kind === 'message') expect(turn.text).toBe('Which store?');
  });

  it('assembles tool calls from function-call chunks, streams a tool round as a fresh segment, and still bills each call', async () => {
    const { requests } = scriptStreams([
      streamResult([
        { candidates: [{ content: { parts: [{ text: 'Let me read the file.' }] } }] },
        { candidates: [{ content: { parts: [{ functionCall: { name: 'read_file', args: { path: 'src/x.ts' } } }] }, finishReason: 'STOP' }] },
        { usageMetadata: { promptTokenCount: 40, candidatesTokenCount: 9 } },
      ]),
      streamResult([
        { candidates: [{ content: { parts: [{ text: 'The read came up ' }] } }] },
        { candidates: [{ content: { parts: [{ text: 'empty. Question: the exact path?' }] }, finishReason: 'STOP' }] },        { usageMetadata: { promptTokenCount: 55, candidatesTokenCount: 14, cachedContentTokenCount: 50 } },
      ]),
    ]);
    const service = new GeminiService(geminiConfig());
    const progress: ResearchProgress[] = [];
    const turn = await service.startConversation({
      goal: 'read a file',
      runners: ['claude-code'],
      modelsByRunner: {},
      fs: fakeFileSystem() as IFileSystem,
      onProgress: (p) => progress.push(p),
    });

    // The tool round happened against the real loop, not inside this test.
    expect(progress.filter((p) => p.type === 'tool_call').map((p) => p.tool)).toEqual(['read_file']);
    const funcResponses = (requests[1] as Array<{ functionResponse: { name: string } }>)[0];
    expect(funcResponses.functionResponse.name).toBe('read_file');

    // Preamble text streamed from the first call under one segment...
    const deltaSegments = progress.filter((p) => p.type === 'text_delta');
    expect(deltaSegments[0].text).toBe('Let me read the file.');
    const firstSegment = deltaSegments[0].segmentId;
    // ...and the post-tool-reply streamed under a NEW segment minted for the second call.
    const secondCallDeltas = deltaSegments.slice(1);
    expect(secondCallDeltas.map((p) => p.text)).toEqual(['The read came up ', 'empty. Question: the exact path?']);
    expect(secondCallDeltas[0].segmentId).toBeTruthy();
    expect(secondCallDeltas[0].segmentId).not.toBe(firstSegment);

    // Concatenation of a call's deltas IS the final text the loop classifies.
    expect(turn.kind).toBe('message');
    if (turn.kind === 'message') expect(turn.text).toBe(secondCallDeltas.map((p) => p.text).join(''));

    // One bill per call: unspecified counters stay absent rather than zeroing.
    const usage = progress.filter((p) => p.type === 'usage');
    expect(usage).toHaveLength(2);
    expect(usage[0].record).toEqual({ source: 'google', inputTokens: 40, outputTokens: 9 });
    expect(usage[1].record).toEqual({ source: 'google', inputTokens: 55, outputTokens: 14, cachedInputTokens: 50 });
  });

  it('reports no usage when the chunks carry no usageMetadata', async () => {
    scriptStreams([
      streamResult([
        { candidates: [{ content: { parts: [{ text: 'Nothing priced here. Question: proceed?' }] }, finishReason: 'STOP' }] },
      ]),
    ]);
    const service = new GeminiService(geminiConfig());
    const progress: ResearchProgress[] = [];
    const turn = await service.startConversation({
      goal: 'go',
      runners: ['claude-code'],
      modelsByRunner: {},
      fs: fakeFileSystem() as IFileSystem,
      onProgress: (p) => progress.push(p),
    });

    expect(progress.filter((p) => p.type === 'usage')).toEqual([]);
    expect(turn.kind).toBe('message');
    if (turn.kind === 'message') expect(turn.text).toBe('Nothing priced here. Question: proceed?');
  });

  it('a chat without streaming hooks (one-shot loop, a future subagent chat) streams no text, only its bill', async () => {
    const planReply = JSON.stringify({
      tasks: [{
        id: 't1', order: 1, title: 'Add widget', description: 'Adds the widget module',
        type: 'ai', dependencies: [], prompt: 'Create src/widget.ts',
        assignedModel: { modelId: 'm', modelLabel: 'M' }, assignedRunner: 'claude-code',
        taskMode: 'acceptEdits', autonomy: 'AFK', sliceType: 'AFK', userStoriesCovered: [], subtasks: [],
      }],
    });
    scriptStreams([
      streamResult([
        { candidates: [{ content: { parts: [{ thought: true, text: 'quietly considering' }] } }] },
        { candidates: [{ content: { parts: [{ text: planReply }] }, finishReason: 'STOP' }] },
        { usageMetadata: { promptTokenCount: 70, candidatesTokenCount: 60, thoughtsTokenCount: 12, totalTokenCount: 142 } },
      ]),
    ]);
    const service = new GeminiService(geminiConfig());
    const progress: ResearchProgress[] = [];
    const { tasks } = await service.researchAndPlan(
      'add a widget',
      ['claude-code'],
      {},
      fakeFileSystem() as IFileSystem,
      (p) => progress.push(p),
    );

    // Nothing streamed — the one-shot loop's thinking and reply are its own
    // business; only the per-call bill flows into the ledger.
    expect(progress.filter((p) => p.type === 'text_delta' || p.type === 'thinking')).toEqual([]);
    const usage = progress.filter((p) => p.type === 'usage');
    expect(usage).toHaveLength(1);
    // Thought tokens bill as output alongside the answer tokens.
    expect(usage[0].record).toEqual({ source: 'google', inputTokens: 70, outputTokens: 72 });
    expect(tasks).toHaveLength(1);
  });
});

describe('Gemini planner skill catalog', () => {
  beforeEach(() => startChat.mockReset());

  it('shows the task skills the planner may attach, and no planner skills, which load only through tools', async () => {
    scriptStreams([streamResult([{ candidates: [{ content: { parts: [{ text: 'Which cache?' }] }, finishReason: 'STOP' }] }])]);
    const skill = (name: string, appliesTo: SkillInfo['appliesTo']): SkillInfo => ({
      name, description: `${name} description`, metadata: { name, description: '' }, content: 'BODY',
      source: 'global', path: `/skills/${name}/SKILL.md`, appliesTo, modelInvocable: true, userInvocable: true,
    });

    await new GeminiService(geminiConfig()).startConversation({
      goal: 'add a cache', runners: ['claude-code'], modelsByRunner: {}, fs: fakeFileSystem() as IFileSystem, onProgress: () => {},
      skills: [skill('pr-style', 'task'), skill('review-plan', 'planner')],
    });

    const [{ history }] = startChat.mock.calls[0] as [{ history: { parts: { text: string }[] }[] }];
    const system = history[0].parts[0].text;
    expect(system).toContain('Task skills you may attach:\n- pr-style: pr-style description');
    expect(system).not.toMatch(/review-plan|load_skill/);
  });
});
