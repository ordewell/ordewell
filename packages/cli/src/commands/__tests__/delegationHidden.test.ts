import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DELEGATION_OFFERED, RUN_SETTINGS_DEFAULTS } from '@ordewell/core';
import { COMMANDS } from '../registry';
import { printHelp } from '../../help';
import { SLASH_COMMANDS } from '../../tui/slash';
import { initialState, reduce, type Action } from '../../tui/reducer';
import { render } from '../../tui/render';
import { style } from '../../tui/ansi';
import type { TaskView, TuiState } from '../../tui/state';
import type { StepperState } from '../../tui/reducers/stepper';

/**
 * Delegation is a setting in core with no delegated task behind it yet
 * (ADR-0055 D21), so no surface shows or accepts it. These tests run with the
 * switch as shipped; the rows that cover the control itself mock it on.
 */
beforeAll(() => { style.enabled = false; });
afterAll(() => { style.enabled = true; });

// Not followed by a hyphen, so a workspace path like .../hide-the-delegation-setting is no match.
const DELEGATION = /delegation(?!-)/i;

const key = (name: string, char?: string) => ({ type: 'key' as const, key: { name, char } });
const task: TaskView = { id: 't1', order: 1, title: 'Build', type: 'ai', status: 'in_progress', dependencies: [] };
const withDelegation = (over: Partial<TuiState> = {}): TuiState => {
  const state = initialState({ sessionId: 's1', rows: 40, cols: 120, focus: 'plan', tasks: [task], runSettingsKnown: true, ...over });
  const action: Action = { type: 'settingsLoaded', settings: { run: { ...RUN_SETTINGS_DEFAULTS, delegationTokens: 5_000_000 } } };
  return reduce(state, action).state;
};

describe('delegation, until a delegated task exists (ADR-0055 D21)', () => {
  it('is switched off', () => {
    expect(DELEGATION_OFFERED).toBe(false);
  });

  it('is not an `ordewell` command: not runnable and not in --help', () => {
    expect(Object.keys(COMMANDS)).not.toContain('delegation');
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    printHelp();
    const help = log.mock.calls.flat().join('\n');
    log.mockRestore();
    expect(help).not.toMatch(DELEGATION);
  });

  it('is not named by /settings in the TUI or in the help', () => {
    const settings = SLASH_COMMANDS.find((c) => c.name === 'settings');
    expect(settings?.description).not.toMatch(DELEGATION);
    expect(SLASH_COMMANDS.map((c) => c.name)).not.toContain('delegation');
  });

  it('has no Delegation step in the /settings panel, and its hint does not name it', () => {
    const typed = { ...initialState({ sessionId: 's1', rows: 40, cols: 120, autonomous: true }), focus: 'chat' as const };
    const opened = reduce({ ...typed, editor: { ...typed.editor, text: '/settings', cursor: 9 } }, key('enter')).state;
    const stepper = (opened.overlay as { stepper: StepperState }).stepper;
    expect(stepper.trail.map((t) => t.label)).not.toContain('Delegation');
    expect(JSON.stringify(stepper)).not.toMatch(DELEGATION);
  });

  it('is not shown on the status line or the welcome screen, whatever is stored', () => {
    const state = withDelegation();
    expect(render(state).join('\n')).not.toMatch(DELEGATION);
    expect(render({ ...state, tasks: [], focus: 'chat' }).join('\n')).not.toMatch(DELEGATION);
  });
});
