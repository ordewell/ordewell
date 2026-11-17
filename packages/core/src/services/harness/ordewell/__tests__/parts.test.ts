import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { removeDir } from '../../../../testEnv';
import { defaultModelInfo, modelInfoFromCatalog, ordewellModelId, parseModelId } from '../models';
import { taskCompletionContract } from '../../../mcp';
import { buildSystemPrompt } from '../prompt';
import { FileTranscriptStore } from '../transcript';

const made: string[] = [];
afterEach(async () => {
  await Promise.all(made.splice(0).map((dir) => removeDir(dir)));
});
function tempDir(): string {
  const dir = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'ordewell-parts-')));
  made.push(dir);
  return dir;
}

describe('model ids and info', () => {
  it('splits at the first colon and knows only real providers', () => {
    expect(parseModelId('openai_compatible:qwen3:8b')).toEqual({ provider: 'openai_compatible', model: 'qwen3:8b' });
    expect(parseModelId('openrouter:anthropic/claude-x')).toEqual({ provider: 'openrouter', model: 'anthropic/claude-x' });
    expect(parseModelId('nobody:model')).toBeUndefined();
    expect(parseModelId('openrouter:')).toBeUndefined();
    expect(parseModelId('plain-model')).toBeUndefined();
    expect(ordewellModelId('openai', 'gpt-x')).toBe('openai:gpt-x');
  });

  it('defaults what no catalog stated, and marks it so', () => {
    const info = defaultModelInfo('openai', 'gpt-x');
    expect(info).toMatchObject({ id: 'openai:gpt-x', contextWindow: 128_000, contextWindowSource: 'assumed', maxOutputTokens: 4096, supportsTools: true, supportsReasoning: false });
    expect(Object.values(info.known).every((known) => !known)).toBe(true);
  });

  it('takes what a catalog states, in USD per million tokens', () => {
    const info = modelInfoFromCatalog('openrouter', {
      id: 'vendor/model', name: 'Vendor Model', description: '', contextLength: 200_000, maxOutputTokens: 16_000,
      pricing: { prompt: '0.000003', completion: '0.000015' }, tools: true,
    });
    expect(info).toMatchObject({ label: 'Vendor Model', contextWindow: 200_000, maxOutputTokens: 16_000, supportsTools: true });
    expect(info.pricing.input).toBeCloseTo(3);
    expect(info.pricing.output).toBeCloseTo(15);
    expect(info.known).toEqual({ contextWindow: true, maxOutputTokens: true, pricing: true, supportsTools: true, supportsReasoning: false });

    const unpriced = modelInfoFromCatalog('openrouter', { id: 'm', name: '', description: '', contextLength: 0, pricing: { prompt: '?', completion: '?' } });
    expect(unpriced.known.pricing).toBe(false);
    expect(unpriced.contextWindow).toBe(128_000);
    expect(unpriced.contextWindowSource).toBe('assumed');
  });
});

describe('FileTranscriptStore', () => {
  it('appends JSON lines under its own directory and folds them back', async () => {
    const root = tempDir();
    const store = new FileTranscriptStore('s1', root);
    expect(await store.exists()).toBe(false);
    await store.append({ v: 1, kind: 'session', at: 't', model: 'openrouter:m', system: [{ text: 'sys' }] });
    await store.append({ v: 1, kind: 'message', at: 't', step: 1, message: { role: 'user', text: 'hi' } });
    await store.append({ v: 1, kind: 'usage', at: 't', step: 2, usage: { inputTokens: 3 } });
    expect(store.dir).toBe(path.join(root, 's1'));
    expect(await store.exists()).toBe(true);
    expect(readFileSync(path.join(root, 's1', 'transcript.jsonl'), 'utf8').trim().split('\n')).toHaveLength(3);
    expect(await new FileTranscriptStore('s1', root).load()).toEqual({ model: 'openrouter:m', system: [{ text: 'sys' }], messages: [{ role: 'user', text: 'hi' }], steps: 2, compactions: 0 });
  });

  it('skips a torn last line rather than failing the resume', async () => {
    const root = tempDir();
    const store = new FileTranscriptStore('s2', root);
    await store.append({ v: 1, kind: 'message', at: 't', step: 1, message: { role: 'user', text: 'kept' } });
    appendFileSync(path.join(root, 's2', 'transcript.jsonl'), '{"v":1,"kind":"mess');
    expect((await store.load()).messages).toEqual([{ role: 'user', text: 'kept' }]);
  });
});

describe('buildSystemPrompt', () => {
  const now = new Date('2026-03-04T10:00:00Z');

  it('states the task, the environment, and the commit only when the task commits', () => {
    const cwd = tempDir();
    mkdirSync(path.join(cwd, '.git'));
    const text = buildSystemPrompt({ cwd, commits: false, stepLimit: 200, platform: 'linux', now }).map((part) => part.text).join('\n');
    expect(text).toContain('task_complete');
    expect(text).toContain(`Working directory: ${cwd}`);
    expect(text).toContain('Platform: linux');
    expect(text).toContain('Date: 2026-03-04');
    expect(text).toContain('Git repository: yes');
    expect(text).not.toContain('`commit`');
    const committing = buildSystemPrompt({ cwd, commits: true, stepLimit: 200, now }).map((part) => part.text).join('\n');
    expect(committing).toContain('`commit`');
  });

  it('carries every runner\'s completion contract, the commit part only when the task commits', () => {
    const cwd = tempDir();
    const text = (commits: boolean) => buildSystemPrompt({ cwd, commits, stepLimit: 200, now }).map((part) => part.text).join('\n');
    expect(text(false)).toContain(taskCompletionContract({}));
    expect(text(false)).not.toContain(taskCompletionContract({ commits: true }));
    expect(text(true)).toContain(taskCompletionContract({ commits: true }));
  });

  it('says how a long task is worked through, with the attempt\'s own step budget', () => {
    const cwd = tempDir();
    const text = (commits: boolean) => buildSystemPrompt({ cwd, commits, stepLimit: 137, now })[0]?.text ?? '';
    const committing = text(true);
    expect(committing).toMatch(/how much (of the brief )?(work )?remains is never a reason to stop or to report `blocked`/i);
    expect(committing).toMatch(/compacted for you as it fills/);
    expect(committing).toContain('a budget of 137 model calls for this attempt');
    expect(committing).toMatch(/work through the brief in order/i);
    expect(committing).toMatch(/commit each coherent part as it works.*an attempt can end at any time.*not committed is not its result/is);
    expect(committing).toMatch(/`blocked` is for an obstacle outside your control.*missing credential.*contradiction in the brief.*environment you cannot repair.*exactly what is missing/is);
    expect(committing).toMatch(/budget is nearly spent.*commit that part.*what is done and what remains.*never report `done`.*done criterion does not hold/is);
    // One line, the limit and where the rest goes, since a refused report costs a model call.
    expect(committing).toMatch(/`summary`.{0,40}at most 1500 characters.*refused.*`findings`.*`report`/i);
    // A task that writes no commit is not told to make one.
    expect(text(false)).not.toMatch(/commit each coherent part/i);
    expect(text(false)).toContain('a budget of 137 model calls for this attempt');
  });

  it('appends AGENTS.md, else CLAUDE.md, with the cache breakpoint on the last part', () => {
    const cwd = tempDir();
    expect(buildSystemPrompt({ cwd, commits: false, stepLimit: 200, now }).at(-1)?.text).toContain('Git repository: no');
    writeFileSync(path.join(cwd, 'CLAUDE.md'), 'Claude rules here.');
    expect(buildSystemPrompt({ cwd, commits: false, stepLimit: 200, now }).at(-1)?.text).toContain('Claude rules here.');
    writeFileSync(path.join(cwd, 'AGENTS.md'), 'Agents rules here.');
    const parts = buildSystemPrompt({ cwd, commits: false, stepLimit: 200, now });
    expect(parts.at(-1)?.text).toContain('Agents rules here.');
    expect(parts.map((part) => part.text).join('\n')).not.toContain('Claude rules here.');
    expect(parts.at(-1)?.cacheBreakpoint).toBe(true);
    expect(parts.slice(0, -1).some((part) => part.cacheBreakpoint)).toBe(false);
  });
});
