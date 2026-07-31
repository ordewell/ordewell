import { describe, it, expect } from 'vitest';
import { flag, hasFlag, flags, positionals } from '../args';

describe('flag', () => {
  it('returns the value after the flag', () => {
    expect(flag(['--goal', 'my task', '--other'], '--goal')).toBe('my task');
  });

  it('returns undefined for missing flag', () => {
    expect(flag(['--goal', 'my task'], '--runner')).toBeUndefined();
  });

  it('returns undefined when flag is last argument', () => {
    expect(flag(['--goal'], '--goal')).toBeUndefined();
  });

  it('returns undefined for empty args', () => {
    expect(flag([], '--goal')).toBeUndefined();
  });
});

describe('flags', () => {
  it('returns empty array when flag is not present', () => {
    expect(flags(['--goal', 'my task'], '--runner')).toEqual([]);
  });

  it('returns single value when flag appears once', () => {
    expect(flags(['--runner', 'claude-code', '--other'], '--runner')).toEqual(['claude-code']);
  });

  it('returns multiple values when flag appears multiple times', () => {
    expect(flags(['--runner', 'claude-code', '--runner', 'opencode'], '--runner')).toEqual(['claude-code', 'opencode']);
  });

  it('returns empty array for empty args', () => {
    expect(flags([], '--runner')).toEqual([]);
  });

  it('returns undefined for values that look like flags', () => {
    expect(flags(['--runner'], '--runner')).toEqual([undefined]);
  });
});

describe('hasFlag', () => {
  it('returns true when flag exists', () => {
    expect(hasFlag(['--daemon', '--port', '8080'], '--daemon')).toBe(true);
  });

  it('returns false when flag does not exist', () => {
    expect(hasFlag(['--port', '8080'], '--daemon')).toBe(false);
  });

  it('returns false for empty args', () => {
    expect(hasFlag([], '--daemon')).toBe(false);
  });
});

describe('positionals', () => {
  it('skips flags and their values', () => {
    expect(positionals(['--session-id', 's1', '3'])).toEqual(['3']);
  });

  it('keeps positionals that precede flags', () => {
    expect(positionals(['load', 'session-42', '--workspace', '/tmp'])).toEqual(['load', 'session-42']);
  });

  it('does not swallow the argument after a boolean flag', () => {
    expect(positionals(['--json', 'list'])).toEqual(['list']);
  });

  it('returns an empty array when only flags are present', () => {
    expect(positionals(['--port', '4242', '--json'])).toEqual([]);
  });
});
