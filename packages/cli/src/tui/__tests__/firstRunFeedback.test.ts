import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { claimFirstRunFeedback, type ChildPlanEntry, type ExecutionSummary } from '@ordewell/core';
import type { WsEvent } from '../../apiClient';
import { runEffect, type EffectDeps, type OrdewellApi } from '../effects';
import { createInbound } from '../inbound';
import { initialState, reduce, type Action, type Effect } from '../reducer';
import type { TuiState } from '../state';
import { messagesOf } from './chat';

const NOTICE = 'How did it go? Ordewell is open source and built in the open, and feedback from a first run is what it needs most. '
  + 'Tell us how it went: /feedback · Star on GitHub: /star';

const PASSED: ExecutionSummary = { total: 2, completed: 2, failed: 0, blocked: 0, skipped: 0 };

/**
 * One TUI as the daemon's stream drives it: a frame through the inbound
 * router, the reducer, and every effect it asks for run against the deps a
 * test hands it, as the runtime runs them.
 */
function terminalUi(over: Partial<EffectDeps>) {
  let state: TuiState = initialState({ sessionId: 's1' });
  const effects: Effect[] = [];
  const dispatch = (action: Action): void => {
    const step = reduce(state, action);
    state = step.state;
    effects.push(...step.effects);
  };
  const deps: EffectDeps = {
    api: {} as OrdewellApi,
    workspace: '/ws',
    port: 3742,
    dispatch,
    newSessionId: () => 'session-new',
    setEnvVar: () => {},
    saveAutonomy: () => ({ overridden: false }),
    setMouseCapture: () => {},
    login: async () => ({ ok: true }),
    writeTerminal: () => {},
    reviveDaemon: async () => true,
    exit: () => {},
    ...over,
  };
  const { receive } = createInbound(dispatch, 's1');
  let seq = 0;
  return {
    get state() { return state; },
    effects,
    /** A frame from the daemon, then every effect it led to, run to the end. */
    async hear(event: Record<string, unknown>): Promise<void> {
      receive({ ...event, stream: 'd1', seq: ++seq } as unknown as WsEvent);
      await settle();
    },
    async type(command: string): Promise<void> {
      for (const char of command) dispatch({ type: 'key', key: { name: 'char', char } });
      dispatch({ type: 'key', key: { name: 'enter' } });
      await settle();
    },
    lines: (): string[] => messagesOf(state).map((m) => m.text),
  };

  async function settle(): Promise<void> {
    while (effects.length > 0) await runEffect(effects.shift()!, deps);
  }
}

describe('the first-run feedback notice in the terminal UI (ADR-0075)', () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-tui-feedback-'));
  });

  afterEach(() => {
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  /** The machine's real record, in a directory of the test's own. */
  const machine = (summary: ExecutionSummary): boolean => claimFirstRunFeedback(summary, { interactive: true, env: {}, stateDir });

  it('is a line in the conversation once a run ends with every task passed', async () => {
    const tui = terminalUi({ claimFirstRunFeedback: machine });
    await tui.hear({ type: 'run_concluded', summary: PASSED });
    expect(tui.lines()).toContain(NOTICE);
  });

  it.each<[string, ExecutionSummary]>([
    ['a task failed', { total: 2, completed: 1, failed: 1, blocked: 0, skipped: 0 }],
    ['a task was skipped', { total: 2, completed: 1, failed: 0, blocked: 0, skipped: 1 }],
  ])('says nothing, and asks nothing of the machine, when %s', async (_, summary) => {
    const claim = vi.fn(machine);
    const tui = terminalUi({ claimFirstRunFeedback: claim });
    await tui.hear({ type: 'run_concluded', summary });
    expect(claim).not.toHaveBeenCalled();
    expect(tui.lines().join('\n')).not.toContain('/feedback');
  });

  it('says nothing at the run\'s first end, which a closing turn may still continue, only once that end stands', async () => {
    const tui = terminalUi({ claimFirstRunFeedback: machine });
    await tui.hear({ type: 'execution_complete', summary: PASSED });
    expect(tui.lines().join('\n')).not.toContain('/feedback');
    await tui.hear({ type: 'run_concluded', summary: PASSED });
    expect(tui.lines()).toContain(NOTICE);
  });

  it('is shown once on the machine: not at the next passed run, nor in another TUI', async () => {
    const first = terminalUi({ claimFirstRunFeedback: machine });
    await first.hear({ type: 'run_concluded', summary: PASSED });
    await first.hear({ type: 'run_concluded', summary: PASSED });
    expect(first.lines().filter((line) => line === NOTICE)).toHaveLength(1);

    const another = terminalUi({ claimFirstRunFeedback: machine });
    await another.hear({ type: 'run_concluded', summary: PASSED });
    expect(another.lines()).not.toContain(NOTICE);
  });

  it('opens a browser only when an action is picked: /feedback the discussion, /star the repository', async () => {
    const openLink = vi.fn(async () => true);
    const tui = terminalUi({ claimFirstRunFeedback: machine, openLink });
    await tui.hear({ type: 'run_concluded', summary: PASSED });
    expect(openLink).not.toHaveBeenCalled();

    await tui.type('/feedback');
    expect(openLink).toHaveBeenLastCalledWith('https://github.com/ordewell/ordewell/discussions/115');
    expect(tui.lines().at(-1)).toBe('Opened https://github.com/ordewell/ordewell/discussions/115 in your browser.');

    await tui.type('/star');
    expect(openLink).toHaveBeenLastCalledWith('https://github.com/ordewell/ordewell');
    expect(openLink).toHaveBeenCalledTimes(2);
  });

  it('names the page to open by hand when no browser can be opened from this terminal', async () => {
    const tui = terminalUi({ openLink: async () => false });
    await tui.type('/star');
    expect(tui.lines().at(-1)).toBe('Could not open a browser from this terminal: open https://github.com/ordewell/ordewell yourself.');
  });

  it('waits for the run at the top: a child plan ending passed, on screen while its parent runs on, says nothing', () => {
    const root = initialState({ sessionId: 's1' });
    const inChild: TuiState = {
      ...initialState({ sessionId: 'c1' }),
      child: { entry: { id: 'c1', parentId: 's1' } as unknown as ChildPlanEntry, parent: root, reading: false, lost: false },
    };
    expect(reduce(inChild, { type: 'runConcluded', summary: PASSED, sessionId: 'c1' }).effects).toEqual([]);
    // The root's own end, heard while the child is on screen, is the run's.
    expect(reduce(inChild, { type: 'runConcluded', summary: PASSED, sessionId: 's1' }).effects).toEqual([{ type: 'firstRunFeedback', summary: PASSED }]);
  });

  it('is not shown where another surface on the machine already showed it', async () => {
    // What the desktop app or VS Code leaves when it shows the notice first.
    expect(claimFirstRunFeedback(PASSED, { interactive: true, env: {}, stateDir })).toBe(true);
    const tui = terminalUi({ claimFirstRunFeedback: machine });
    await tui.hear({ type: 'run_concluded', summary: PASSED });
    expect(tui.lines()).not.toContain(NOTICE);
  });
});
