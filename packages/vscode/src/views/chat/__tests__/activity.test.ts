import { describe, it, expect } from 'vitest';
import { activityIcon, applyToolResult, outcomeLabel, previewResult, type Activity, type ToolResultUpdate } from '../activity';

const pending = (id: string, tool: string, toolCallId?: string): Activity =>
  ({ id, type: 'tool_call', text: tool, tool, toolCallId });

const result = (overrides: Partial<ToolResultUpdate> & { tool: string }): ToolResultUpdate =>
  ({ summary: `${overrides.tool} done`, fallbackId: 'fallback', ...overrides });

describe('applyToolResult', () => {
  it('settles the pending call with its summary, outcome, and result body', () => {
    const [settled] = applyToolResult([pending('a', 'read_file', 't1')], result({
      tool: 'read_file', toolCallId: 't1', summary: 'read_file a.ts', resultText: 'body', outcome: 'success',
    }));

    expect(settled).toMatchObject({
      id: 'a', done: true, text: 'read_file a.ts', resultText: 'body', outcome: 'success',
    });
  });

  it('matches by tool_call id, so a parallel same-tool round does not cross its results', () => {
    const activities = [pending('a', 'read_file', 't1'), pending('b', 'read_file', 't2')];

    const next = applyToolResult(activities, result({
      tool: 'read_file', toolCallId: 't1', summary: 'read_file a.ts',
    }));

    expect(next[0]).toMatchObject({ id: 'a', done: true, text: 'read_file a.ts' });
    expect(next[1].done).toBeUndefined();
  });

  it('falls back to the newest pending call of that tool when no id is reported', () => {
    const activities = [pending('a', 'read_file'), pending('b', 'read_file')];

    const next = applyToolResult(activities, result({ tool: 'read_file', summary: 'read_file b.ts' }));

    expect(next[0].done).toBeUndefined();
    expect(next[1]).toMatchObject({ id: 'b', done: true });
  });

  it('never lets an identified result steal an unrelated identified call', () => {
    const next = applyToolResult([pending('a', 'read_file', 't1')], result({
      tool: 'read_file', toolCallId: 't9', summary: 'read_file c.ts', fallbackId: 'appended',
    }));

    expect(next).toHaveLength(2);
    expect(next[0].done).toBeUndefined();
    expect(next[1]).toMatchObject({ id: 'appended', done: true, text: 'read_file c.ts' });
  });

  it('still settles a call that announced no id when the result carries one', () => {
    const next = applyToolResult([pending('a', 'grep')], result({
      tool: 'grep', toolCallId: 't1', summary: 'grep auth',
    }));

    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({ id: 'a', done: true, text: 'grep auth' });
  });

  it('appends a completed entry when nothing is pending', () => {
    const next = applyToolResult([], result({ tool: 'glob', summary: 'glob **/*.ts', fallbackId: 'rs-1' }));

    expect(next).toEqual([
      { id: 'rs-1', type: 'tool_call', tool: 'glob', text: 'glob **/*.ts', done: true, outcome: undefined, resultText: undefined },
    ]);
  });

  it('leaves already-settled calls alone', () => {
    const settled: Activity = { id: 'a', type: 'tool_call', tool: 'grep', text: 'grep auth', done: true };

    const next = applyToolResult([settled], result({ tool: 'grep', summary: 'grep login', fallbackId: 'rs-2' }));

    expect(next[0]).toBe(settled);
    expect(next[1]).toMatchObject({ id: 'rs-2', done: true });
  });
});

describe('activityIcon', () => {
  it('separates a refused command from a successful one', () => {
    const icons = (['success', 'failure', 'refused', 'denied', 'not_executed'] as const).map((outcome) =>
      activityIcon({ id: 'a', type: 'tool_call', text: 'bash rm', done: true, outcome }),
    );

    expect(icons).toEqual(['✓', '✗', '⊘', '⊘', '–']);
  });

  it('spins while pending and ticks when an outcome was never reported', () => {
    expect(activityIcon({ id: 'a', type: 'tool_call', text: 'bash rm' })).toBe('⚙');
    expect(activityIcon({ id: 'a', type: 'tool_call', text: 'bash rm', done: true })).toBe('✓');
  });
});

describe('outcomeLabel', () => {
  it('names only the outcomes worth calling out', () => {
    expect(outcomeLabel(undefined)).toBe('');
    expect(outcomeLabel('success')).toBe('');
    expect(outcomeLabel('refused')).toBe('refused');
    expect(outcomeLabel('not_executed')).toBe('not executed');
  });
});

describe('previewResult', () => {
  it('keeps a short result whole', () => {
    expect(previewResult('two\nlines\n')).toBe('two\nlines');
  });

  it('caps a long result and says how much was dropped', () => {
    const preview = previewResult('x'.repeat(50), 10);

    expect(preview).toBe(`${'x'.repeat(10)}\n… [40 more characters]`);
  });
});
