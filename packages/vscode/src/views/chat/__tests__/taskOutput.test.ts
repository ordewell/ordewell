import { describe, it, expect } from 'vitest';
import { appendTaskOutput, lastLine, sanitizeRunnerOutput, TASK_OUTPUT_TAIL_CHARS } from '../taskOutput';

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

describe('sanitizeRunnerOutput', () => {
  it('strips ANSI colour and style escapes', () => {
    expect(sanitizeRunnerOutput('\x1b[32mok\x1b[0m \x1b[1;31mFAILED\x1b[0m')).toBe('ok FAILED');
  });

  it('strips cursor movement and clear-screen sequences', () => {
    expect(sanitizeRunnerOutput('line one\x1b[2K\r\nline two\x1b[H\x1b[2J')).toBe('line one\nline two');
  });

  it('strips private-mode and OSC sequences', () => {
    expect(sanitizeRunnerOutput('\x1b[?25lhidden\x1b]0;title\x07\x1b[?25h')).toBe('hidden');
  });

  it('drops leftover control bytes but keeps tabs and newlines', () => {
    expect(sanitizeRunnerOutput('\u0007bell\t\u000fnone')).toBe('bell\tnone');
  });

  it('splits CR-only redraws instead of jamming them onto one line', () => {
    expect(sanitizeRunnerOutput('build\rbuild.\rbuild..')).toBe('build\nbuild.\nbuild..');
  });

  it('never stores escape or control bytes, however a sequence falls across chunks', () => {
    const stream = 'ok\x1b[31mred\x1b[0m \x1b[1Gdone';
    for (const cut of [2, 6, 9, 14, 18]) {
      const map = appendTaskOutput(appendTaskOutput({}, 'a', stream.slice(0, cut)), 'a', stream.slice(cut));

      // A sequence split across a chunk boundary cannot be reassembled (the
      // escape introducer is already gone), but no raw escape or control byte
      // may survive into what the webview renders.
      // eslint-disable-next-line no-control-regex
      expect(map.a).not.toMatch(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/);
    }
  });
});

describe('lastLine', () => {
  it('reports the last line with content, skipping trailing blanks', () => {
    expect(lastLine('build ok\nError: boom\n\n  \n')).toBe('Error: boom');
    expect(lastLine('   \n\n')).toBe('');
  });
});
