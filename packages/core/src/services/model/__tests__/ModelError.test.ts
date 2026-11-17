import { describe, expect, it } from 'vitest';
import { classifyHttpFailure, headerReader, isModelError, ModelError, retryAfterFromHeaders } from '../ModelError';

const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);
const read = (headers: Record<string, string>) => retryAfterFromHeaders(headerReader(headers), NOW);

describe('retryAfterFromHeaders', () => {
  it('prefers retry-after-ms, then retry-after in seconds or as a date', () => {
    expect(read({ 'retry-after-ms': '1500', 'retry-after': '9' })).toBe(1500);
    expect(read({ 'Retry-After': '9' })).toBe(9000);
    expect(read({ 'retry-after': new Date(NOW + 42_000).toUTCString() })).toBe(42_000);
    expect(read({ 'retry-after': new Date(NOW - 42_000).toUTCString() })).toBe(0);
  });

  it('reads OpenAI\'s reset durations, the exhausted limit first', () => {
    expect(read({ 'x-ratelimit-reset-requests': '6m0s', 'x-ratelimit-reset-tokens': '1.5s' })).toBe(360_000);
    expect(read({
      'x-ratelimit-reset-requests': '6m0s', 'x-ratelimit-remaining-requests': '12',
      'x-ratelimit-reset-tokens': '250ms', 'x-ratelimit-remaining-tokens': '0',
    })).toBe(250);
    expect(read({ 'x-ratelimit-reset-tokens': '1h2m' })).toBe(3_720_000);
  });

  it('reads Anthropic\'s reset instants', () => {
    expect(read({
      'anthropic-ratelimit-tokens-reset': new Date(NOW + 20_000).toISOString(),
      'anthropic-ratelimit-tokens-remaining': '0',
    })).toBe(20_000);
  });

  it('reads x-ratelimit-reset as epoch ms, epoch seconds or a delay', () => {
    expect(read({ 'x-ratelimit-reset': String(NOW + 5000) })).toBe(5000);
    expect(read({ 'x-ratelimit-reset': String(NOW / 1000 + 5) })).toBe(5000);
    expect(read({ 'x-ratelimit-reset': '5' })).toBe(5000);
  });

  it('says nothing for headers it cannot read', () => {
    expect(read({})).toBeUndefined();
    expect(read({ 'retry-after': 'soon', 'x-ratelimit-reset-requests': 'later' })).toBeUndefined();
    expect(retryAfterFromHeaders(headerReader(undefined))).toBeUndefined();
  });

  it('reads a Headers object as well as a record', () => {
    expect(retryAfterFromHeaders(headerReader(new Headers({ 'Retry-After': '3' })), NOW)).toBe(3000);
  });
});

describe('classifyHttpFailure', () => {
  it('reads a quota from the code or the type, whatever the status', () => {
    expect(classifyHttpFailure({ message: 'q', status: 429, type: 'insufficient_quota' }, NOW).kind).toBe('usage-limit');
    expect(classifyHttpFailure({ message: 'arrears', status: 429, code: 1113 }, NOW)).toMatchObject({ kind: 'usage-limit', code: '1113' });
  });

  it('dates a usage limit from the headers', () => {
    const err = classifyHttpFailure({ message: 'q', status: 402, headers: { 'retry-after': '60' } }, NOW);
    expect(err.resetsAt).toBe(NOW + 60_000);
  });

  it('lets a delay from the body win over the headers', () => {
    const err = classifyHttpFailure({ message: 'slow', status: 429, headers: { 'retry-after': '60' }, retryAfterMs: 12_000 }, NOW);
    expect(err).toMatchObject({ kind: 'rate-limited', retryAfterMs: 12_000 });
  });

  it('reads the wording of a 400 only when it has no code', () => {
    expect(classifyHttpFailure({ message: 'prompt is too long', status: 400 }).kind).toBe('context-overflow');
    expect(classifyHttpFailure({ message: 'prompt is too long', status: 400, code: 'invalid_value' }).kind).toBe('bad-request');
  });

  it.each([
    ['xAI', "This model's maximum prompt length is 131072 but the request contains 140000 tokens."],
    ['LM Studio', 'The number of tokens to keep from the initial prompt is greater than the context length.'],
    ['llama.cpp', 'the request exceeds the available context size, try increasing it'],
  ])('reads %s\'s overflow wording on a bare 400 as an overflow', (_server, message) => {
    expect(classifyHttpFailure({ message, status: 400 }).kind).toBe('context-overflow');
  });

  it('classifies a failure with no status by what the SDK saw', () => {
    expect(classifyHttpFailure({ message: 'reset', network: true })).toMatchObject({ kind: 'transient', network: true });
    expect(classifyHttpFailure({ message: 'timed out', timeout: true })).toMatchObject({ kind: 'transient' });
    expect(classifyHttpFailure({ message: 'boom', type: 'server_error' }).kind).toBe('transient');
    expect(classifyHttpFailure({ message: 'odd' }).kind).toBe('fatal');
    expect(classifyHttpFailure({ message: 'mid-stream', code: 429 })).toMatchObject({ kind: 'rate-limited', status: 429 });
  });

  it('is a ModelError that keeps its cause', () => {
    const cause = new Error('sdk');
    const err = classifyHttpFailure({ message: 'x', status: 409, cause });
    expect(isModelError(err)).toBe(true);
    expect(err).toBeInstanceOf(ModelError);
    expect(err).toMatchObject({ kind: 'transient', name: 'ModelError', cause });
    expect(isModelError(cause)).toBe(false);
  });
});
