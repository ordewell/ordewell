import { describe, it, expect } from 'vitest';
import { classifyRunnerStop, stopsRunner, type AttemptEnd } from '../runnerExit';

describe('classifyRunnerStop', () => {
  it.each([
    'Claude usage limit reached. Your limit will reset at 5pm.',
    'You have hit your usage limit. The limit will reset at 5pm.',
    'ERROR: rate limit exceeded, retry later',
    'Request was rate-limited',
    'Your weekly limit will reset on Monday',
    'quota exceeded for this project',
    'HTTP 429: Too Many Requests',
  ])('reads an account limit from %j', (output) => {
    expect(classifyRunnerStop(output)).toBe('usage-limit');
  });

  it('treats an ordinary crash as stopped', () => {
    expect(classifyRunnerStop('compilation failed: unexpected token')).toBe('stopped');
    expect(classifyRunnerStop('')).toBe('stopped');
  });

  it('does not read a limit signature buried far above the tail', () => {
    const buried = 'usage limit reached\n' + 'x'.repeat(5000);
    expect(classifyRunnerStop(buried)).toBe('stopped');
    expect(classifyRunnerStop('x'.repeat(5000) + '\nusage limit reached')).toBe('usage-limit');
  });
});

describe('attempt-end disposition', () => {
  const reasons: AttemptEnd[] = ['verdict', 'cancel', 'release', 'complete', 'retry', 'spawn-failed', 'stop', 'load'];

  it('stops the runner for every reason that ends only that attempt, its verdict included', () => {
    expect(reasons.filter((r) => stopsRunner(r))).toEqual(['verdict', 'cancel', 'release', 'complete', 'retry', 'spawn-failed']);
  });

  it('leaves stop and load to the whole-run reset', () => {
    expect(stopsRunner('stop')).toBe(false);
    expect(stopsRunner('load')).toBe(false);
  });
});
