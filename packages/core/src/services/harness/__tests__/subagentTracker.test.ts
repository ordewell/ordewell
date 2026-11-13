import { describe, expect, it } from 'vitest';
import type { SubagentOutcome } from '../../../models/Task';
import type { AgentEvent } from '../AgentAdapter';
import { SubagentTracker, subagentBrief, type SubagentSaid } from '../subagentTracker';
import { TurnOutcome } from '../turnOutcome';

type Step = 'request' | 'refused' | 'open';

/** A tracker beside the turn latch it reads, and every event it reported. */
function tracked(steps: Step[] = []) {
  const turn = new TurnOutcome();
  for (const step of steps) turn[step]();
  const events: AgentEvent[] = [];
  const emit = (event: AgentEvent) => events.push(event);
  return { tracker: new SubagentTracker(turn), turn, events, emit };
}

describe('subagentBrief', () => {
  it.each<[string, Record<string, unknown> | undefined, string]>([
    ['a description', { description: 'Read the README', prompt: 'Read the first line of README.md' }, 'Read the README'],
    ['a prompt when there is no description', { prompt: 'Read the first line of README.md' }, 'Read the first line of README.md'],
    ['an empty description, which is still the description', { description: '', prompt: 'Read it' }, ''],
    ['a prompt when the description is not text', { description: 4, prompt: 'Read it' }, 'Read it'],
    ['nothing when neither is text', { description: 4, prompt: { text: 'Read it' } }, ''],
    ['nothing when the call has no input', undefined, ''],
  ])('reads %s', (_name, input, brief) => {
    expect(subagentBrief(input)).toBe(brief);
  });
});

describe('SubagentTracker — start and finish', () => {
  it('reports a start with its brief, and its model when the runner names one', () => {
    const { tracker, events, emit } = tracked();
    expect(tracker.start({ id: 'sa1', brief: 'Look around', model: 'opencode-go/deepseek-v4-flash' }, emit)).toBe(true);
    expect(tracker.start({ id: 'sa2', brief: 'Read it' }, emit)).toBe(true);

    expect(events).toStrictEqual([
      { type: 'subagent_started', subagentId: 'sa1', brief: 'Look around', model: 'opencode-go/deepseek-v4-flash' },
      { type: 'subagent_started', subagentId: 'sa2', brief: 'Read it' },
    ]);
  });

  it('reports a finish with its digest after the start', () => {
    const { tracker, events, emit } = tracked();
    tracker.start({ id: 'sa1', brief: 'Look around' }, emit);
    expect(tracker.finish('sa1', { success: true }, 'found it', emit)).toBe(true);

    expect(events.at(-1)).toStrictEqual({ type: 'subagent_finished', subagentId: 'sa1', outcome: 'done', digest: 'found it' });
  });

  it('reports a start once, however often the runner restates it', () => {
    const { tracker, events, emit } = tracked();
    expect(tracker.start({ id: 'sa1', brief: 'Look around' }, emit)).toBe(true);
    expect(tracker.start({ id: 'sa1', brief: 'Look around' }, emit)).toBe(false);
    tracker.finish('sa1', { success: true }, 'found it', emit);
    expect(tracker.start({ id: 'sa1', brief: 'Look around' }, emit)).toBe(false);

    expect(events.map((e) => e.type)).toEqual(['subagent_started', 'subagent_finished']);
  });

  it('reports a finish once, whichever way the runner restates it', () => {
    const { tracker, events, emit } = tracked();
    tracker.start({ id: 'sa1', brief: 'Look around' }, emit);
    expect(tracker.finish('sa1', { success: true }, 'found it', emit)).toBe(true);
    expect(tracker.finish('sa1', { success: true }, 'found it', emit)).toBe(false);
    expect(tracker.finish('sa1', { status: 'failed' }, 'again', emit)).toBe(false);

    expect(events.filter((e) => e.type === 'subagent_finished')).toHaveLength(1);
  });

  it('drops a finish for a subagent that never started, and one that came before its start', () => {
    const { tracker, events, emit } = tracked();
    expect(tracker.finish('ghost', { success: false }, '', emit)).toBe(false);
    expect(tracker.finish('sa1', { success: true }, 'early', emit)).toBe(false);
    tracker.start({ id: 'sa1', brief: 'Look around' }, emit);
    tracker.finish('sa1', { success: true }, 'found it', emit);

    expect(events.map((e) => [e.type, 'subagentId' in e ? e.subagentId : null, 'digest' in e ? e.digest : null])).toEqual([
      ['subagent_started', 'sa1', null],
      ['subagent_finished', 'sa1', 'found it'],
    ]);
  });

  it('keeps each subagent\'s lifecycle apart, and reads whether one is open', () => {
    const { tracker, emit } = tracked();
    expect(tracker.isOpen('sa1')).toBe(false);
    tracker.start({ id: 'sa1', brief: 'one' }, emit);
    tracker.start({ id: 'sa2', brief: 'two' }, emit);
    expect(tracker.isOpen('sa1')).toBe(true);

    tracker.finish('sa1', { success: true }, '', emit);
    expect(tracker.isOpen('sa1')).toBe(false);
    expect(tracker.isOpen('sa2')).toBe(true);
  });

  it('is not reset by a turn, so a subagent that outlives the one that launched it finishes in a later one', () => {
    const { tracker, turn, events, emit } = tracked();
    tracker.start({ id: 'sa1', brief: 'Look around' }, emit);
    turn.settle('completed');
    turn.open();
    tracker.finish('sa1', { status: 'done' }, 'found it', emit);

    expect(events.at(-1)).toMatchObject({ type: 'subagent_finished', outcome: 'done' });
  });
});

describe('SubagentTracker — the outcome', () => {
  // The runner's word, the interrupt latch, and the outcome they come to.
  it.each<[string, SubagentSaid, Step[], SubagentOutcome]>([
    ['a call that succeeded', { success: true }, [], 'done'],
    ['a call that succeeded as an interrupt landed', { success: true }, ['request'], 'done'],
    ['a call that failed', { success: false }, [], 'failed'],
    ['a call an interrupt cut short', { success: false }, ['request'], 'stopped'],
    ['a call that failed after the runner refused the interrupt', { success: false }, ['request', 'refused'], 'failed'],
    ['a call that failed in a turn opened after an earlier interrupt', { success: false }, ['request', 'open'], 'failed'],
    ['a status of done', { status: 'done' }, [], 'done'],
    ['a status of done as an interrupt landed', { status: 'done' }, ['request'], 'done'],
    ['a status of failed', { status: 'failed' }, [], 'failed'],
    ['a status of failed that an interrupt caused', { status: 'failed' }, ['request'], 'stopped'],
    ['a status of stopped', { status: 'stopped' }, [], 'stopped'],
    ['a status of stopped under an interrupt', { status: 'stopped' }, ['request'], 'stopped'],
  ])('finishes %s as %s', (_name, said, steps, outcome) => {
    const { tracker, events, emit } = tracked(steps);
    tracker.start({ id: 'sa1', brief: 'Look around' }, emit);
    tracker.finish('sa1', said, '', emit);

    expect(events.at(-1)).toMatchObject({ type: 'subagent_finished', outcome });
  });

  it('reads the latch when the subagent finishes, not when it started', () => {
    const { tracker, turn, events, emit } = tracked();
    tracker.start({ id: 'sa1', brief: 'Look around' }, emit);
    turn.request();
    tracker.finish('sa1', { success: false }, 'Interrupted', emit);

    expect(events.at(-1)).toMatchObject({ outcome: 'stopped' });
  });
});
