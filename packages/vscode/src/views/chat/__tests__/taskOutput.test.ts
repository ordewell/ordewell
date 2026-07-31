import { describe, it, expect } from 'vitest';
import { appendTaskOutput, lastLine, TASK_OUTPUT_TAIL_CHARS } from '../taskOutput';

describe('appendTaskOutput', () => {
  it('accumulates chunks per task without mixing them', () => {
    const map = appendTaskOutput(appendTaskOutput(appendTaskOutput({}, 'a', 'one '), 'b', 'other'), 'a', 'two');

    expect(map).toEqual({ a: 'one two', b: 'other' });
  });

  it('keeps only the tail, because the interesting part of a failure is at the end', () => {
    const map = appendTaskOutput({}, 'a', `${'x'.repeat(TASK_OUTPUT_TAIL_CHARS)}FAILED`);

    expect(map.a).toHaveLength(TASK_OUTPUT_TAIL_CHARS);
    expect(map.a.endsWith('FAILED')).toBe(true);
  });

  it('caps across appends, not just within one chunk', () => {
    let map = {};
    for (let i = 0; i < 20; i++) map = appendTaskOutput(map, 'a', 'y'.repeat(1000), 100);

    expect((map as Record<string, string>).a).toHaveLength(100);
  });

  it('returns the same map for an empty chunk or a missing task id', () => {
    const map = { a: 'kept' };

    expect(appendTaskOutput(map, 'a', '')).toBe(map);
    expect(appendTaskOutput(map, '', 'text')).toBe(map);
  });
});

describe('lastLine', () => {
  it('reports the last line with content, skipping trailing blanks', () => {
    expect(lastLine('build ok\nError: boom\n\n  \n')).toBe('Error: boom');
    expect(lastLine('   \n\n')).toBe('');
  });
});
