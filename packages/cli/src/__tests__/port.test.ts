import { describe, it, expect, afterEach } from 'vitest';
import { resolvePort, DEFAULT_PORT, isConnectionRefused, describeConnectionRefused } from '../daemon';

afterEach(() => { delete process.env.ORDEWELL_PORT; });

describe('resolvePort', () => {
  it('defaults to DEFAULT_PORT', () => {
    expect(resolvePort([])).toBe(DEFAULT_PORT);
  });

  it('reads ORDEWELL_PORT', () => {
    process.env.ORDEWELL_PORT = '9001';
    expect(resolvePort([])).toBe(9001);
  });

  it('prefers --port over ORDEWELL_PORT', () => {
    process.env.ORDEWELL_PORT = '9001';
    expect(resolvePort(['--port', '4242'])).toBe(4242);
  });

  it('ignores a non-numeric --port and falls through', () => {
    expect(resolvePort(['--port', 'nope'])).toBe(DEFAULT_PORT);
  });

  it('ignores a non-numeric ORDEWELL_PORT', () => {
    process.env.ORDEWELL_PORT = 'nope';
    expect(resolvePort([])).toBe(DEFAULT_PORT);
  });
});

/**
 * The predicate that decides whether an action may be replayed. Getting it too
 * wide is worse than getting it too narrow: a retried `execute` is a second
 * run of the plan.
 */
describe('isConnectionRefused', () => {
  it('recognises the errno Node attaches', () => {
    expect(isConnectionRefused(Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:3742'), { code: 'ECONNREFUSED' }))).toBe(true);
  });

  it('recognises it from the message alone, for layers that drop the code', () => {
    expect(isConnectionRefused(new Error('connect ECONNREFUSED 127.0.0.1:3742'))).toBe(true);
    expect(isConnectionRefused('connect ECONNREFUSED 127.0.0.1:3742')).toBe(true);
  });

  // These can arrive after the server has read the request, so the work may
  // already have happened — replaying them would do it twice.
  it.each(['ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ENOTFOUND'])('does not claim %s', (code) => {
    expect(isConnectionRefused(Object.assign(new Error('socket hang up'), { code }))).toBe(false);
  });

  it('survives a null or undefined error without throwing', () => {
    expect(isConnectionRefused(null)).toBe(false);
    expect(isConnectionRefused(undefined)).toBe(false);
  });
});

describe('describeConnectionRefused', () => {
  it('names the port, the log, and the command that fixes it', () => {
    const message = describeConnectionRefused(4242);
    expect(message).toContain('4242');
    expect(message).toContain('server.log');
    expect(message).toContain('ordewell web --daemon');
  });

  // The whole point: Node's wording names a socket, not an action.
  it('does not leak the errno it replaces', () => {
    expect(describeConnectionRefused(3742)).not.toContain('ECONNREFUSED');
  });
});
