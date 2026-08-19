import { describe, it, expect } from 'vitest';
import { initialState } from '../reducer';
import { render } from '../render';
import type { TaskView, TuiState } from '../state';

const frame = (state: TuiState): string => render(state).join('\n');
// eslint-disable-next-line no-control-regex
const plain = (state: TuiState): string => frame(state).replace(/\x1b\[[0-9;]*m/g, '');

function task(over: Partial<TaskView> = {}): TaskView {
  return {
    id: 't1', order: 1, title: 'Refactor PlanStore', type: 'ai', status: 'in_progress',
    dependencies: [],
    ...over,
  };
}

const planState = (over: Partial<TuiState> = {}): TuiState =>
  initialState({ sessionId: 's1', rows: 20, cols: 80, focus: 'plan', ...over });

describe('plan pane — idle indicator', () => {
  it('renders a static idle glyph instead of the spinner while idleSince is set', () => {
    const idle = planState({ tasks: [task({ idleSince: '2026-08-18T00:00:00.000Z' })] });
    const busy = planState({ tasks: [task({ idleSince: null })] });

    const idleFrame = plain(idle);
    const busyFrame = plain(busy);

    // Spinner glyphs (braille dots) should not appear for the idle task.
    const spinnerGlyphs = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    expect(spinnerGlyphs.some((g) => idleFrame.includes(g))).toBe(false);
    expect(spinnerGlyphs.some((g) => busyFrame.includes(g))).toBe(true);
    // Idle indicator must be distinct from the awaiting_user '?' marker too.
    expect(idleFrame).not.toContain('?');
  });

  it('reverts to the spinner once idleSince clears', () => {
    const resumed = planState({ tasks: [task({ idleSince: null })] });
    const spinnerGlyphs = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    expect(spinnerGlyphs.some((g) => plain(resumed).includes(g))).toBe(true);
  });
});
