import { describe, it, expect } from 'vitest';
import { initialState, reduce, type Action } from '../reducer';
import { researchLine } from '../layout';
import type { ChatMessage, TuiState } from '../state';

const send = (state: TuiState, action: Action) => reduce(state, action).state;
const drive = (state: TuiState, actions: Action[]) => actions.reduce(send, state);

const planning = (): TuiState => ({ ...initialState(), status: 'planning' });

const call = (summary: string, toolCallId?: string): Action =>
  ({ type: 'researchStep', summary, toolCallId });

const done = (
  summary: string,
  overrides: Partial<Extract<Action, { type: 'researchStepDone' }>> = {},
): Action => ({ type: 'researchStepDone', summary, outcome: 'success', result: '', ...overrides });

const research = (state: TuiState): ChatMessage[] => state.messages.filter((m) => m.role === 'research');

describe('researchStep', () => {
  it('appends one transcript entry per call instead of overwriting the spinner', () => {
    const s = drive(planning(), [call('read_file a.ts', 't1'), call('read_file b.ts', 't2')]);

    expect(research(s).map((m) => m.content)).toEqual(['read_file a.ts', 'read_file b.ts']);
  });

  it('counts the rest of a parallel round on the spinner label', () => {
    const s = drive(planning(), [call('read_file a.ts', 't1'), call('read_file b.ts', 't2'), call('grep foo', 't3')]);

    expect(s.busyLabel).toBe('grep foo (+2 more)');
  });

  it('flips the status to researching so the footer stops claiming it is planning', () => {
    expect(send(planning(), call('grep auth', 't1')).status).toBe('researching');
  });

  it('leaves an executing run alone — research steps belong to the planner', () => {
    const executing: TuiState = { ...initialState(), status: 'executing' };
    expect(send(executing, call('grep auth', 't1')).status).toBe('executing');
  });

  it('ignores steps from a session that /new has replaced', () => {
    const s = send({ ...planning(), sessionId: 's2' }, { type: 'researchStep', summary: 'grep old', sessionId: 's1' });

    expect(research(s)).toEqual([]);
  });
});

describe('researchStepDone', () => {
  it('settles the matching entry with its result and outcome', () => {
    const s = drive(planning(), [
      call('read_file a.ts', 't1'),
      done('read_file a.ts', { toolCallId: 't1', result: 'export const a = 1;' }),
    ]);

    expect(research(s)[0].research).toEqual({
      toolCallId: 't1',
      outcome: 'success',
      result: 'export const a = 1;',
    });
  });

  it('matches by tool_call id, not by arrival order, across a parallel round', () => {
    const s = drive(planning(), [
      call('read_file a.ts', 't1'),
      call('read_file b.ts', 't2'),
      done('read_file b.ts', { toolCallId: 't2', result: 'b body' }),
    ]);

    const [first, second] = research(s);
    expect(first.research?.outcome).toBeUndefined();
    expect(second.research?.result).toBe('b body');
  });

  it('falls back to the summary when the stream reports no tool_call id', () => {
    const s = drive(planning(), [call('grep auth'), done('grep auth', { result: '3 matches' })]);

    expect(research(s)[0].research?.result).toBe('3 matches');
  });

  it('clears the spinner label once every call has settled', () => {
    const s = drive(planning(), [
      call('read_file a.ts', 't1'),
      call('read_file b.ts', 't2'),
      done('read_file a.ts', { toolCallId: 't1' }),
    ]);
    expect(s.busyLabel).toBe('read_file b.ts');

    const settled = send(s, done('read_file b.ts', { toolCallId: 't2' }));
    expect(settled.busyLabel).toBe('');
  });

  it('hands the status back to planning once the round is over and the model is thinking again', () => {
    const s = drive(planning(), [
      call('read_file a.ts', 't1'),
      call('read_file b.ts', 't2'),
      done('read_file a.ts', { toolCallId: 't1' }),
    ]);
    expect(s.status).toBe('researching');

    expect(send(s, done('read_file b.ts', { toolCallId: 't2' })).status).toBe('planning');
  });

  it('leaves the transcript alone when nothing matches', () => {
    const s = drive(planning(), [call('read_file a.ts', 't1'), done('grep other', { toolCallId: 'unknown' })]);

    expect(research(s)).toHaveLength(1);
    expect(research(s)[0].research?.outcome).toBeUndefined();
  });
});

describe('researchLine', () => {
  const line = (state: TuiState) => researchLine(research(state)[0]);

  it('marks a pending call', () => {
    expect(line(send(planning(), call('bash rm -rf /', 't1')))).toBe('⋯ bash rm -rf /');
  });

  it('renders success, failure, refusal, denial and non-execution distinctly', () => {
    const outcomes = ['success', 'failure', 'refused', 'denied', 'not_executed'] as const;
    const marks = outcomes.map((outcome) =>
      line(drive(planning(), [call('bash rm -rf /', 't1'), done('bash rm -rf /', { toolCallId: 't1', outcome })])),
    );

    expect(marks).toEqual([
      '✓ bash rm -rf /',
      '✗ bash rm -rf /',
      '⊘ bash rm -rf /',
      '⊘ bash rm -rf /',
      '– bash rm -rf /',
    ]);
  });

  it('appends a one-line, truncated result preview', () => {
    const s = drive(planning(), [
      call('read_file a.ts', 't1'),
      done('read_file a.ts', { toolCallId: 't1', result: `line one\nline two${'x'.repeat(200)}` }),
    ]);

    const rendered = line(s);
    expect(rendered.startsWith('✓ read_file a.ts → line one line two')).toBe(true);
    expect(rendered).not.toContain('\n');
    expect(rendered.endsWith('…')).toBe(true);
  });
});

describe('plannerThinking', () => {
  it('accumulates reasoning deltas onto the status row, capped to a tail', () => {
    const s = drive(planning(), [
      { type: 'plannerThinking', text: 'a'.repeat(500) },
      { type: 'plannerThinking', text: 'tail end' },
    ]);

    expect(s.thinkingLine).toHaveLength(400);
    expect(s.thinkingLine.endsWith('tail end')).toBe(true);
    expect(s.messages).toEqual([]);
  });

  it('is dropped when the planner turn ends', () => {
    const thinking = send(planning(), { type: 'plannerThinking', text: 'considering auth' });
    const replied = send(thinking, { type: 'plannerMessage', content: 'Which module?' });

    expect(replied.thinkingLine).toBe('');
  });
});
