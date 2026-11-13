import { describe, expect, it } from 'vitest';
import { TurnOutcome, type RunnerSaid, type TurnEnding, type TurnError } from '../turnOutcome';

type Step = 'open' | 'request' | 'refused';

const limit: TurnError = { message: 'Usage limit reached', usageLimit: { resetsAt: '2026-11-14T09:00:00Z' } };

describe('TurnOutcome', () => {
  it.each<[string, Step[], RunnerSaid, TurnError | undefined, TurnEnding]>([
    ['a turn nobody interrupted', [], 'completed', undefined, { type: 'turn_end' }],
    ['a turn the runner says it interrupted', [], 'interrupted', undefined, { type: 'turn_end', interrupted: true }],
    ['a requested interrupt the runner also reports', ['request'], 'interrupted', undefined, { type: 'turn_end', interrupted: true }],
    ['a natural finish that raced a requested interrupt', ['request'], 'completed', undefined, { type: 'turn_end', interrupted: true }],
    ['a finish after the runner refused the interrupt', ['request', 'refused'], 'completed', undefined, { type: 'turn_end' }],
    ['a finish in a turn opened after an earlier request', ['request', 'open'], 'completed', undefined, { type: 'turn_end' }],
    ['an error of the turn\'s own', [], 'completed', { message: 'boom' }, { type: 'error', message: 'boom' }],
    ['an error of the turn\'s own that raced a requested interrupt', ['request'], 'completed', { message: 'boom' }, { type: 'error', message: 'boom' }],
    ['a usage limit that raced a requested interrupt, kept whole', ['request'], 'interrupted', limit, { type: 'error', ...limit }],
  ])('ends %s', (_name, steps, runnerSaid, error, ending) => {
    const outcome = new TurnOutcome();
    for (const step of steps) outcome[step]();
    expect(outcome.settle(runnerSaid, error)).toEqual(ending);
  });

  it('reads whether an interrupt is requested and not refused', () => {
    const outcome = new TurnOutcome();
    expect(outcome.requested).toBe(false);
    outcome.request();
    expect(outcome.requested).toBe(true);
    outcome.refused();
    expect(outcome.requested).toBe(false);
  });

  it('lets a request go with the turn it ended, so the next turn finishes cleanly', () => {
    const outcome = new TurnOutcome();
    outcome.request();
    expect(outcome.settle('completed')).toEqual({ type: 'turn_end', interrupted: true });
    expect(outcome.requested).toBe(false);
    expect(outcome.settle('completed')).toEqual({ type: 'turn_end' });
  });

  it('lets a request go with a turn that ended in an error', () => {
    const outcome = new TurnOutcome();
    outcome.request();
    outcome.settle('completed', { message: 'boom' });
    expect(outcome.requested).toBe(false);
  });
});
