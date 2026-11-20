import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IConfig } from '../../interfaces/IConfig';
import type { ResearchLogEntry, ResearchProgress } from '../../models/Task';
import { fakeFileSystem } from '../../testing';
import { OpenAiService } from '../OpenAiService';
import { streamReply, type AbandonedReply } from '../modelPlannerChat';
import { ModelError, withStreamTimeouts, type ModelClient, type ModelEvent, type ModelRequest } from '../model';

// The API planner's answer to a model stream that stalls after it has begun
// (ADR-0070): the call is sent again with the partial reply dropped, under the
// retry policy the built-in runner's loop uses. The stall is the shipped
// `withStreamTimeouts`' own, cut at a one-second idle allowance on fake timers.

const IDLE_MS = 1000;
const STALL = /The model stream sent nothing for 1 s, so the request was abandoned\./;

/** One send of a call: the events it streams, then a stall, a failure, or its end. */
interface Send {
  events: ModelEvent[];
  stall?: boolean;
  fail?: ModelError;
}

function scripted(sends: Send[] | ((n: number) => Send)): { client: ModelClient; requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  const raw: ModelClient = {
    provider: 'openai',
    dialect: 'chat-completions',
    async *stream(request, signal) {
      requests.push(structuredClone(request));
      const send = typeof sends === 'function' ? sends(requests.length) : sends[requests.length - 1];
      if (!send) throw new Error(`no send scripted for call ${requests.length}`);
      for (const event of send.events) yield event;
      if (send.fail) throw send.fail;
      if (send.stall) {
        await new Promise((_, reject) => {
          if (signal?.aborted) reject(signal.reason);
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      }
    },
  };
  return { client: withStreamTimeouts(raw, { firstEventMs: IDLE_MS, idleMs: IDLE_MS }), requests };
}

const text = (t: string): ModelEvent => ({ type: 'text-delta', text: t });
const usage = (inputTokens: number, outputTokens: number): ModelEvent => ({ type: 'usage', usage: { inputTokens, outputTokens } });
const finish = (reason: 'stop' | 'length' = 'stop'): ModelEvent => ({ type: 'finish', reason });
const readCall = (path: string): ModelEvent => ({
  type: 'tool-call-complete',
  call: { id: `call-${path}`, name: 'read_file', arguments: { path }, rawArguments: JSON.stringify({ path }) },
});

/** Runs the fake clock until `work` settles: the stalls and the pauses between sends are all timers. */
async function settled<T>(work: Promise<T>): Promise<T> {
  let done = false;
  const tracked = work.finally(() => { done = true; });
  tracked.catch(() => {});
  for (let i = 0; i < 2000 && !done; i++) await vi.advanceTimersByTimeAsync(250);
  return tracked;
}

const task = (id: string, dependencies: string[]) => ({
  id, order: id.charCodeAt(0) - 96, title: `T ${id}`, description: `Does ${id}`, type: 'ai', dependencies, prompt: `Do ${id}.`,
  assignedModel: { modelId: 'm', modelLabel: 'M' }, assignedRunner: 'claude-code',
  taskMode: 'acceptEdits', autonomy: 'AFK', sliceType: 'AFK', userStoriesCovered: [], subtasks: [],
});
const ONE_TASK = JSON.stringify({ tasks: [task('a', [])] });
/** a > b > c > d > e: long enough for the chain review. */
const CHAIN = JSON.stringify({ tasks: [task('a', []), task('b', ['a']), task('c', ['b']), task('d', ['c']), task('e', ['d'])] });

function config(): IConfig {
  return {
    aiProvider: 'openai',
    orchestratorModel: 'openai:gpt-5',
    researchMaxSteps: 5,
    getProviderBaseUrl: () => '',
    getProviderApiKey: () => 'sk-test',
  } as unknown as IConfig;
}

const lines = (log: ResearchLogEntry[]): string[] => log.flatMap((e) => ('type' in e && e.type === 'system' ? [e.content] : []));
const resends = (log: ResearchLogEntry[]): string[] => lines(log).filter((l) => /sent again in/.test(l));
const usages = (progress: ResearchProgress[]) => progress.flatMap((p) => (p.type === 'usage' && p.record ? [p.record] : []));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('streamReply, where every planner call decides', () => {
  it('sends a call whose stream stalled part way again after a pause, and returns only the whole reply', async () => {
    const { client, requests } = scripted([
      { events: [text('{"tasks":[{"id":"stale"'), usage(10, 3)], stall: true },
      { events: [text('whole reply'), usage(10, 4), finish()] },
    ]);
    const abandoned: AbandonedReply[] = [];
    const shown: string[] = [];
    const reply = streamReply(client, { model: 'm', system: [], messages: [{ role: 'user', text: 'plan' }], tools: [] }, undefined, {
      onText: (t) => shown.push(t),
      onAbandoned: (a) => abandoned.push(a),
    });

    await vi.advanceTimersByTimeAsync(IDLE_MS);
    expect(abandoned).toHaveLength(1);
    expect(abandoned[0]).toMatchObject({ sends: 1, reply: { text: '{"tasks":[{"id":"stale"', usage: { inputTokens: 10, outputTokens: 3 } } });
    expect(abandoned[0].error.message).toMatch(STALL);
    // The runner's policy: the first gap is 2 s, give or take its 20% jitter.
    expect(abandoned[0].resendInMs).toBeGreaterThanOrEqual(1600);
    expect(abandoned[0].resendInMs).toBeLessThanOrEqual(2400);
    await vi.advanceTimersByTimeAsync(1500);
    expect(requests).toHaveLength(1);

    const whole = await settled(reply);
    expect(whole.text).toBe('whole reply');
    expect(whole.usage).toEqual({ inputTokens: 10, outputTokens: 4 });
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual(requests[0]);
    expect(shown).toEqual(['{"tasks":[{"id":"stale"', 'whole reply']);
  });

  it('fails once the policy\'s six sends are spent, naming the stall and the sends', async () => {
    const { client, requests } = scripted(() => ({ events: [text('partial'), usage(5, 1)], stall: true }));
    const abandoned: AbandonedReply[] = [];
    const reply = streamReply(client, { model: 'm', system: [], messages: [], tools: [] }, undefined, { onAbandoned: (a) => abandoned.push(a) });

    const error = await settled(reply).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ModelError);
    expect((error as ModelError).kind).toBe('transient');
    expect((error as ModelError).message).toMatch(STALL);
    expect((error as ModelError).message).toMatch(/The planner sent the call 6 times, and each reply broke off part way\./);
    expect(requests).toHaveLength(6);
    expect(abandoned.map((a) => a.sends)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(abandoned.map((a) => a.resendInMs === undefined)).toEqual([false, false, false, false, false, true]);
  });

  it.each([
    ['a usage limit', new ModelError({ kind: 'usage-limit', message: 'You exceeded your current quota.', status: 429 })],
    ['a non-transient failure', new ModelError({ kind: 'bad-request', message: 'Invalid tool schema.', status: 400 })],
  ])('throws %s after streaming began as it is, sent once', async (_name, failure) => {
    const { client, requests } = scripted([{ events: [text('partial')], fail: failure }]);
    const error = await settled(streamReply(client, { model: 'm', system: [], messages: [], tools: [] }, undefined)).catch((err: unknown) => err);
    expect(error).toBe(failure);
    expect(requests).toHaveLength(1);
  });
});

describe('the one-shot planner (researchAndPlan) after a stall', () => {
  it('runs no tool call of the abandoned reply, sends the same request again, plans, and logs and bills the re-send', async () => {
    const { client, requests } = scripted([
      { events: [readCall('abandoned.ts'), usage(100, 5)], stall: true },
      { events: [text(ONE_TASK), usage(100, 40), finish()] },
    ]);
    const readFile = vi.fn(fakeFileSystem().readFile);
    const readFiles = vi.fn(fakeFileSystem().readFiles);
    const progress: ResearchProgress[] = [];
    const service = new OpenAiService(config(), { modelClient: () => client });

    const result = await settled(service.researchAndPlan('add a widget', ['claude-code'], {}, fakeFileSystem({ readFile, readFiles }), (p) => progress.push(p)));

    expect(result.tasks.map((t) => t.title)).toEqual(['T a']);
    expect(readFile.mock.calls.flat().map(String).filter((a) => a.includes('abandoned'))).toEqual([]);
    expect(readFiles).not.toHaveBeenCalled();
    expect(progress.filter((p) => p.type === 'tool_call')).toEqual([]);
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual(requests[0]);
    expect(resends(result.researchLog)).toEqual([expect.stringMatching(/^\[Ordewell\] The model request failed part way: The model stream sent nothing for 1 s.* Its partial reply is dropped and the call is sent again in \d+\.\d s \(retry 1\)\.$/)]);
    expect(usages(progress).map((u) => [u.inputTokens, u.outputTokens])).toEqual([[100, 5], [100, 40]]);
  });

  it('fails after the bound with the stall and the sends in its message, every abandoned reply billed', async () => {
    const { client, requests } = scripted(() => ({ events: [text('Let me look'), usage(50, 2)], stall: true }));
    const progress: ResearchProgress[] = [];
    const service = new OpenAiService(config(), { modelClient: () => client });

    const error = await settled(service.researchAndPlan('add a widget', ['claude-code'], {}, fakeFileSystem(), (p) => progress.push(p))).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(STALL);
    expect((error as Error).message).toMatch(/sent the call 6 times/);
    expect(requests).toHaveLength(6);
    expect(usages(progress)).toHaveLength(6);
  });

  it('sends the plan call again when its stream stalls, and plans from the whole reply alone', async () => {
    const { client, requests } = scripted([
      // The research call ends in prose, so the plan comes from the plan call.
      { events: [text('I have looked around.'), finish()] },
      { events: [text('{"tasks":[{"id":"stale"'), usage(70, 9)], stall: true },
      { events: [text(ONE_TASK), usage(70, 40), finish()] },
    ]);
    const progress: ResearchProgress[] = [];
    const service = new OpenAiService(config(), { modelClient: () => client });

    const result = await settled(service.researchAndPlan('add a widget', ['claude-code'], {}, fakeFileSystem(), (p) => progress.push(p)));

    expect(result.tasks.map((t) => t.title)).toEqual(['T a']);
    expect(requests).toHaveLength(3);
    expect(requests[2]).toEqual(requests[1]);
    expect(resends(result.researchLog)).toHaveLength(1);
    expect(usages(progress).map((u) => [u.inputTokens, u.outputTokens, u.aggregate])).toEqual([[70, 9, true], [70, 40, true]]);
  });

  it('sends the chain review and its re-ask after a cut-off reply again when each stalls', async () => {
    const SHORTER = '{"dependencyChanges":[{"id":"c","dependencies":["a"]},{"id":"d","dependencies":["a"]}]}';
    const { client, requests } = scripted([
      { events: [text(CHAIN), finish()] },
      { events: [text('{"dependencyChanges":[{"id":"e","dependencies":[]}'), usage(80, 6)], stall: true },
      { events: [text('{"dependencyChanges":[{"id":"c","dep'), usage(80, 30), finish('length')] },
      { events: [text('{"dependencyChanges":[{"id":"b","dependencies":[]}'), usage(60, 6)], stall: true },
      { events: [text(SHORTER), usage(60, 20), finish()] },
    ]);
    const progress: ResearchProgress[] = [];
    const service = new OpenAiService(config(), { modelClient: () => client });

    const result = await settled(service.researchAndPlan('add a widget', ['claude-code'], {}, fakeFileSystem(), (p) => progress.push(p)));

    const deps = Object.fromEntries(result.tasks.map((t) => [t.id, t.dependencies]));
    // Only the whole replies took effect: the review's, not either abandoned one's.
    expect(deps).toMatchObject({ a: [], b: ['a'], c: ['a'], d: ['a'], e: ['d'] });
    expect(requests).toHaveLength(5);
    expect(requests[2]).toEqual(requests[1]);
    expect(requests[4]).toEqual(requests[3]);
    expect(lines(result.researchLog).filter((l) => l.startsWith('chain review: [Ordewell]'))).toHaveLength(2);
    expect(usages(progress).map((u) => u.outputTokens)).toEqual([6, 30, 6, 20]);
  });
});

describe('the conversation planner (callApi) after a stall', () => {
  it('takes back the text the abandoned reply streamed, sends the same request again, and replies with the whole reply', async () => {
    const { client, requests } = scripted([
      { events: [text('I will read abandoned.ts'), readCall('abandoned.ts'), usage(200, 8)], stall: true },
      { events: [text('Which cache do you mean?'), usage(200, 12), finish()] },
      { events: [text('Done.'), finish()] },
    ]);
    const readFile = vi.fn(fakeFileSystem().readFile);
    const progress: ResearchProgress[] = [];
    const service = new OpenAiService(config(), { modelClient: () => client });

    const turn = await settled(service.startConversation({
      goal: 'add a cache', runners: ['claude-code'], modelsByRunner: {}, fs: fakeFileSystem({ readFile }), onProgress: (p) => progress.push(p),
    }));

    expect(turn).toMatchObject({ kind: 'message', text: 'Which cache do you mean?' });
    expect(readFile.mock.calls.flat().map(String).filter((a) => a.includes('abandoned'))).toEqual([]);
    expect(progress.filter((p) => p.type === 'tool_call')).toEqual([]);
    const streamed = progress.filter((p) => p.type === 'text_delta' || p.type === 'text_retracted');
    expect(streamed.map((p) => [p.type, p.text])).toEqual([
      ['text_delta', 'I will read abandoned.ts'],
      ['text_retracted', undefined],
      ['text_delta', 'Which cache do you mean?'],
    ]);
    // The retraction names the abandoned segment, and the re-send streams under a new one.
    expect(streamed[1].segmentId).toBe(streamed[0].segmentId);
    expect(streamed[2].segmentId).not.toBe(streamed[0].segmentId);
    expect(requests[1]).toEqual(requests[0]);
    expect(resends(turn.researchLog)).toHaveLength(1);
    expect(usages(progress).map((u) => u.outputTokens)).toEqual([8, 12]);

    // Nothing of the abandoned reply is in the conversation the next call carries.
    await settled(service.continueConversation('the session cache', (p) => progress.push(p)));
    const carried = JSON.stringify(requests[2].messages);
    expect(carried).toContain('Which cache do you mean?');
    expect(carried).not.toContain('abandoned.ts');
  });
});
