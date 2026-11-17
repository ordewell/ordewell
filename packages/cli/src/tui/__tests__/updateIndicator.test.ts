import { beforeAll, describe, expect, it } from 'vitest';
import { render } from '../render';
import { stripAnsi, style, width } from '../ansi';
import { initialState, type TuiState } from '../state';
import { reduce, type Action } from '../reducer';
import { chatOf } from './chat';

beforeAll(() => {
  style.enabled = false;
});

const LINE = 'Ordewell 0.14.0 is out (you have 0.12.6) — type /update';
const known: Partial<TuiState> = { knownUpdate: { latest: '0.14.0', line: LINE } };

const screen = (over: Partial<TuiState> = {}): string[] => render(initialState({ rows: 24, cols: 80, ...over })).map(stripAnsi);

/** A plan on screen, so the welcome's own line is out of the way and the status row is the only place the update shows. */
const inChat = {
  conversation: chatOf(['user', 'build a thing']),
  tasks: [{ id: 'a', order: 1, title: 'Add the login route', type: 'ai', status: 'pending', dependencies: [] }],
} satisfies Partial<TuiState>;

const marked = (rows: string[]): string => rows.find((row) => row.includes('↑')) ?? '';

const reduced = (state: TuiState, action: Action): TuiState => reduce(state, action).state;

describe('the TUI’s persistent update indicator', () => {
  it('shows nothing while no newer version is known', () => {
    expect(screen().join('\n')).not.toContain('available');
  });

  it('names the version and /update in the status row at 80 columns', () => {
    expect(marked(screen({ ...known, ...inChat }))).toContain('↑ 0.14.0 available · /update');
  });

  it('stays during a live planner turn, beside the activity label', () => {
    const rows = screen({
      ...known,
      ...inChat,
      planner: 'planning',
    });
    expect(rows.some((row) => row.includes('Planning…') && row.includes('↑ 0.14.0 available · /update'))).toBe(true);
  });

  it('takes its place from a status that fills the row, and stays while a run is live', () => {
    const rows = screen({ ...known, ...inChat, status: 'executing', toast: 'x'.repeat(200) });
    for (const row of rows) expect(width(row)).toBeLessThanOrEqual(80);
    expect(marked(rows).trimEnd().endsWith('↑ 0.14.0 available · /update')).toBe(true);
    expect(marked(rows)).toContain('xxxx');
  });

  it('shortens, then gives up the settings badge, then drops, and never overflows a row', () => {
    const at = (cols: number): string => {
      const rows = screen({ ...known, ...inChat, cols });
      for (const row of rows) expect(width(row)).toBeLessThanOrEqual(cols);
      return marked(rows).trim();
    };
    expect(at(60)).toBe('↑ 0.14.0 available · /update · ● Guarded · run settings …');
    expect(at(50)).toBe('↑ 0.14.0 · /update · ● Guarded · run settings …');
    expect(at(40)).toBe('↑ /update · ● Guarded · run settings …');
    expect(at(30)).toBe('↑ 0.14.0 available · /update');
    expect(at(24)).toBe('↑ 0.14.0 · /update');
    expect(at(16)).toBe('↑ /update');
    expect(at(10)).toBe('');
  });

  it('is told on the welcome in full', () => {
    expect(screen(known).join('\n')).toContain(LINE);
  });
});

describe('a known update in the reducer', () => {
  it('is set by updateKnown and survives a new session', () => {
    let state = reduced(initialState({ rows: 24, cols: 80 }), { type: 'updateKnown', latest: '0.14.0', line: LINE });
    expect(state.knownUpdate).toEqual({ latest: '0.14.0', line: LINE });
    state = reduced(state, { type: 'sessionStarted', sessionId: 's-1', goal: 'a goal' });
    expect(state.knownUpdate).toEqual({ latest: '0.14.0', line: LINE });
  });
});
