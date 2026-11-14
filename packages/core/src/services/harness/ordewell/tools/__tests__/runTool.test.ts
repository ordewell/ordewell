import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runTool } from '../run';
import type { OrdewellTool } from '../types';
import { scratch } from './helpers';

function fake(text: string, over: Partial<OrdewellTool> = {}): OrdewellTool {
  return {
    name: 'fake',
    description: 'a fake',
    effect: 'read',
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
    execute: async () => ({ text, isError: false }),
    ...over,
  };
}

describe('runTool output cap', () => {
  it('keeps the first 2000 lines and saves the full text outside the worktree', async () => {
    const { context, worktree } = scratch();
    const lines = Array.from({ length: 5000 }, (_, i) => `line ${i + 1}`);
    const result = await runTool(fake(lines.join('\n')), {}, context);

    const shown = result.text.split('\n');
    expect(shown.slice(0, 2000)).toEqual(lines.slice(0, 2000));
    expect(result.text).not.toContain('line 2001\n');
    const saved = String(result.details?.savedTo);
    expect(result.text).toContain(saved);
    expect(readFileSync(saved, 'utf8')).toBe(lines.join('\n'));
    expect(path.relative(worktree, saved).startsWith('..')).toBe(true);
    expect(result.text).toMatch(/5000 lines/);
  });

  it('cuts at 50 KiB even when the lines are few, without splitting a character', async () => {
    const { context } = scratch();
    const result = await runTool(fake('é'.repeat(100_000)), {}, context);
    const kept = result.text.split('\n[Output')[0];
    expect(Buffer.byteLength(kept)).toBeLessThanOrEqual(50 * 1024);
    expect(kept).not.toContain('�');
    expect(existsSync(String(result.details?.savedTo))).toBe(true);
  });

  it('leaves a short result alone and saves nothing', async () => {
    const { context, outputDir } = scratch();
    const result = await runTool(fake('hello'), {}, context);
    expect(result).toEqual({ text: 'hello', isError: false });
    expect(existsSync(outputDir)).toBe(false);
  });

  it('keeps the tail for a tool that asks for it', async () => {
    const { context } = scratch();
    const lines = Array.from({ length: 3000 }, (_, i) => `line ${i + 1}`);
    const result = await runTool(fake(lines.join('\n'), { keep: 'tail' }), {}, context);
    expect(result.text).toContain('line 3000');
    expect(result.text).not.toContain('line 1\n');
  });
});

describe('runTool gate and arguments', () => {
  const tool = (executed: string[]): OrdewellTool =>
    fake('ran', {
      effect: 'write',
      parameters: { type: 'object', properties: { path: { type: 'string', description: 'p' } }, required: ['path'], additionalProperties: false },
      execute: async (args) => {
        executed.push(String(args.path));
        return { text: 'ran', isError: false };
      },
    });

  it('asks the gate before executing and reports a refusal as an error result', async () => {
    const { context } = scratch();
    const executed: string[] = [];
    const asked: string[] = [];
    const result = await runTool(tool(executed), { path: 'a' }, context, {
      gate: ({ tool: t }) => {
        asked.push(`${t.name}:${t.effect}`);
        return { allow: false, reason: 'Refused: read-only task.' };
      },
    });
    expect(asked).toEqual(['fake:write']);
    expect(executed).toEqual([]);
    expect(result).toMatchObject({ isError: true, text: 'Refused: read-only task.' });
  });

  it('runs a call the gate allows', async () => {
    const { context } = scratch();
    const executed: string[] = [];
    const result = await runTool(tool(executed), { path: 'a' }, context, { gate: async () => ({ allow: true }) });
    expect(executed).toEqual(['a']);
    expect(result.isError).toBe(false);
  });

  it('rejects arguments that break the schema before the gate or the tool see them', async () => {
    const { context } = scratch();
    const executed: string[] = [];
    let asked = 0;
    const gate = () => { asked += 1; return { allow: true as const }; };
    const missing = await runTool(tool(executed), {}, context, { gate });
    const wrong = await runTool(tool(executed), { path: 3 }, context, { gate });
    const extra = await runTool(tool(executed), { path: 'a', bogus: true }, context, { gate });
    expect(missing.text).toContain('missing required argument "path"');
    expect(wrong.text).toContain('"path" must be a string');
    expect(extra.text).toContain('unknown argument "bogus"');
    expect([asked, executed.length]).toEqual([0, 0]);
  });

  it('turns a thrown error into an error result, but lets an abort through', async () => {
    const { context } = scratch();
    const boom = fake('', { execute: async () => { throw new Error('disk on fire'); } });
    expect(await runTool(boom, {}, context)).toMatchObject({ isError: true, text: 'fake failed: disk on fire' });

    const controller = new AbortController();
    controller.abort();
    await expect(runTool(boom, {}, { ...context, signal: controller.signal })).rejects.toThrow();
  });
});
