import { describe, it, expect } from 'vitest';
import { initialState, reduce, type Step } from '../reducer';
import type { PickerState, TaskView, TuiState } from '../state';

const key = (name: string, char?: string) => ({ type: 'key' as const, key: { name, char } });
const press = (state: TuiState, name: string, char?: string): Step => reduce(state, key(name, char));

function withPicker(over: Partial<PickerState>, state: Partial<TuiState> = {}): TuiState {
  return initialState({
    ...state,
    overlay: {
      kind: 'picker',
      picker: {
        title: 'Pick',
        items: [
          { id: 'a/1', label: 'Alpha' },
          { id: 'b/2', label: 'Beta' },
          { id: 'c/3', label: 'Gamma' },
        ],
        filter: '',
        index: 0,
        multi: false,
        chosen: [],
        action: { kind: 'set-model' },
        ...over,
      },
    },
  });
}

const pickerOf = (state: TuiState): PickerState => {
  if (state.overlay?.kind !== 'picker') throw new Error('no picker open');
  return state.overlay.picker;
};

describe('picker navigation', () => {
  it('moves the highlight down and stops at the last item', () => {
    let s = withPicker({});
    s = press(s, 'down').state;
    expect(pickerOf(s).index).toBe(1);
    s = press(press(press(s, 'down').state, 'down').state, 'down').state;
    expect(pickerOf(s).index).toBe(2);
  });

  it('moves up and stops at the first item', () => {
    const s = press(withPicker({ index: 0 }), 'up').state;
    expect(pickerOf(s).index).toBe(0);
  });

  it('filters as you type and resets the highlight', () => {
    const s = press(withPicker({ index: 2 }), 'char', 'b').state;
    expect(pickerOf(s).filter).toBe('b');
    expect(pickerOf(s).index).toBe(0);
  });

  it('backspace edits the filter', () => {
    const s = press(withPicker({ filter: 'be' }), 'backspace').state;
    expect(pickerOf(s).filter).toBe('b');
  });

  it('escape closes without choosing anything', () => {
    const { state, effects } = press(withPicker({}), 'escape');
    expect(state.overlay).toBeNull();
    expect(effects).toEqual([]);
  });

  it('does not type into the chat input while it is open', () => {
    const s = press(withPicker({}), 'char', 'b').state;
    expect(s.editor.text).toBe('');
  });
});

describe('picker selection', () => {
  it('choosing a model applies it and closes', () => {
    const { state, effects } = press(withPicker({ index: 1 }), 'enter');
    expect(effects).toEqual([{ type: 'setModel', modelId: 'b/2' }]);
    expect(state.overlay).toBeNull();
  });

  it('chooses from the filtered list, not the original one', () => {
    const { effects } = press(withPicker({ filter: 'gam', index: 0 }), 'enter');
    expect(effects).toEqual([{ type: 'setModel', modelId: 'c/3' }]);
  });

  it('does nothing when the filter matches no items', () => {
    const { state, effects } = press(withPicker({ filter: 'zzz' }), 'enter');
    expect(effects).toEqual([]);
    expect(state.overlay).not.toBeNull();
  });

  it('choosing a session loads it', () => {
    const { effects } = press(withPicker({ action: { kind: 'load-session' } }), 'enter');
    expect(effects).toEqual([{ type: 'loadSession', sessionId: 'a/1' }]);
  });

  it('choosing a provider asks for its key instead of closing', () => {
    const s = press(
      withPicker({ action: { kind: 'set-key' }, items: [{ id: 'openrouter', label: 'OpenRouter' }] }),
      'enter',
    ).state;
    expect(s.overlay).toMatchObject({
      kind: 'prompt',
      action: { kind: 'api-key', provider: 'openrouter', envVar: 'OPENROUTER_API_KEY' },
    });
  });

  describe('runner multi-select', () => {
    const runnerPicker = (over: Partial<PickerState> = {}) =>
      withPicker(
        {
          action: { kind: 'set-runners' },
          multi: true,
          items: [
            { id: 'claude-code', label: 'Claude Code' },
            { id: 'opencode', label: 'OpenCode' },
          ],
          chosen: ['claude-code'],
          ...over,
        },
        {
          runners: [
            { id: 'claude-code', name: 'Claude Code', enabled: true },
            { id: 'opencode', name: 'OpenCode', enabled: false },
          ],
        },
      );

    it('space toggles membership without applying anything', () => {
      const { state, effects } = press(runnerPicker({ index: 1 }), 'char', ' ');
      expect(effects).toEqual([]);
      expect(pickerOf(state).chosen).toEqual(['claude-code', 'opencode']);
    });

    it('enter applies only the runners whose state changed, then closes', () => {
      const { state, effects } = press(runnerPicker({ chosen: ['opencode'] }), 'enter');
      expect(effects).toEqual([{
        type: 'setRunners',
        changes: [
          { runner: 'claude-code', enabled: false },
          { runner: 'opencode', enabled: true },
        ],
        message: 'Runners enabled: OpenCode.',
      }]);
      expect(state.overlay).toBeNull();
    });

    it('enter with nothing changed applies nothing', () => {
      expect(press(runnerPicker(), 'enter').effects).toEqual([]);
    });

    it('enter can disable every runner', () => {
      const { effects } = press(runnerPicker({ chosen: [] }), 'enter');
      expect(effects).toMatchObject([{
        type: 'setRunners',
        changes: [{ runner: 'claude-code', enabled: false }],
      }]);
    });

    it('escape discards the toggles', () => {
      const toggled = press(runnerPicker({ index: 1 }), 'char', ' ').state;
      const { state, effects } = press(toggled, 'escape');
      expect(effects).toEqual([]);
      expect(state.overlay).toBeNull();
    });
  });
});

describe('allowlist picker chain', () => {
  const chooser = (over: Partial<TuiState> = {}) =>
    withPicker(
      { action: { kind: 'choose-allowlist-runner' }, items: [{ id: 'opencode', label: 'OpenCode' }] },
      {
        models: [
          { id: 'a/1', label: 'Alpha', provider: 'openrouter', runners: ['opencode'] },
          { id: 'b/2', label: 'Beta', provider: 'openrouter', runners: ['opencode'] },
        ],
        allowlist: { opencode: ['b/2'] },
        ...over,
      },
    );

  it('picking a runner opens a multi-select of models for it', () => {
    const s = press(chooser(), 'enter').state;
    expect(s.overlay).toMatchObject({
      kind: 'picker',
      picker: { multi: true, action: { kind: 'set-allowlist', runner: 'opencode' } },
    });
  });

  it('offers only the models that runner was discovered with', () => {
    const s = press(chooser({
      models: [
        { id: 'a/1', label: 'Alpha', provider: 'openrouter', runners: ['opencode'] },
        { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', provider: 'openai', runners: ['codex'] },
        { id: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5', provider: 'anthropic', runners: ['claude-code', 'opencode'] },
      ],
    }), 'enter').state;
    expect(pickerOf(s).items.map((i) => i.id)).toEqual(['a/1', 'claude-sonnet-4-5']);
  });

  it('drops stored ids the runner cannot serve, so confirming repairs the allowlist', () => {
    const s = press(chooser({
      models: [{ id: 'a/1', label: 'Alpha', provider: 'openrouter', runners: ['opencode'] }],
      allowlist: { opencode: ['a/1', 'gpt-5.6-sol'] },
    }), 'enter').state;
    expect(pickerOf(s).chosen).toEqual(['a/1']);
  });

  it('refuses to open for a runner with no discovered models rather than storing an empty allowlist', () => {
    const { state, effects } = press(chooser({ models: [] }), 'enter');
    expect(state.overlay).toMatchObject({ kind: 'picker', picker: { action: { kind: 'choose-allowlist-runner' } } });
    expect(effects).toEqual([]);
  });

  it('pre-selects the models already on that runner allowlist', () => {
    const s = press(chooser(), 'enter').state;
    expect(pickerOf(s).chosen).toEqual(['b/2']);
  });

  it('space toggles a model in the multi-select', () => {
    let s = press(chooser(), 'enter').state;
    s = press(s, 'char', ' ').state;
    expect(pickerOf(s).chosen).toEqual(['b/2', 'a/1']);
    s = press(s, 'char', ' ').state;
    expect(pickerOf(s).chosen).toEqual(['b/2']);
  });

  it('enter confirms the whole selection', () => {
    const chosen = press(chooser(), 'enter').state;
    const { state, effects } = press(chosen, 'enter');
    expect(effects).toEqual([{ type: 'setAllowlist', runner: 'opencode', modelIds: ['b/2'] }]);
    expect(state.overlay).toBeNull();
  });
});

describe('prompt overlay', () => {
  const prompt = (action: any, value = ''): TuiState =>
    initialState({ overlay: { kind: 'prompt', title: 'T', value, action }, sessionId: 's1' });

  it('types into the prompt rather than the chat input', () => {
    const s = press(prompt({ kind: 'add-task' }), 'char', 'x').state;
    expect(s.overlay).toMatchObject({ kind: 'prompt', value: 'x' });
    expect(s.editor.text).toBe('');
  });

  it('backspace edits the prompt', () => {
    const s = press(prompt({ kind: 'add-task' }, 'ab'), 'backspace').state;
    expect(s.overlay).toMatchObject({ value: 'a' });
  });

  it('a pasted api key lands in the prompt with any stray newline flattened', () => {
    const state = prompt({ kind: 'api-key', provider: 'openrouter', envVar: 'OPENROUTER_API_KEY' });
    const s = reduce(state, { type: 'key', key: { name: 'paste', text: 'sk-abc\n' } }).state;
    expect(s.overlay).toMatchObject({ kind: 'prompt', value: 'sk-abc ' });
  });

  it('submitting an api key stores it for that provider', () => {
    const state = prompt({ kind: 'api-key', provider: 'openrouter', envVar: 'OPENROUTER_API_KEY' }, 'sk-1');
    const { state: next, effects } = press(state, 'enter');
    expect(effects).toEqual([{ type: 'setApiKey', provider: 'openrouter', key: 'sk-1' }]);
    expect(next.overlay).toBeNull();
  });

  it('submitting a task title adds it to the plan', () => {
    const { effects } = press(prompt({ kind: 'add-task' }, 'Write docs'), 'enter');
    expect(effects).toEqual([{ type: 'addTask', sessionId: 's1', title: 'Write docs' }]);
  });

  it('submitting an empty prompt just closes it', () => {
    const { state, effects } = press(prompt({ kind: 'add-task' }, '  '), 'enter');
    expect(effects).toEqual([]);
    expect(state.overlay).toBeNull();
  });

  it('escape cancels', () => {
    expect(press(prompt({ kind: 'add-task' }, 'x'), 'escape').state.overlay).toBeNull();
  });
});

describe('help overlay', () => {
  const help = (scroll = 0) => initialState({ overlay: { kind: 'help', scroll } });

  it.each(['escape', 'enter'])('closes on %s', (name) => {
    expect(press(help(), name).state.overlay).toBeNull();
  });

  it('closes on q', () => {
    expect(press(help(), 'char', 'q').state.overlay).toBeNull();
  });

  it('scrolls down so the commands below the fold can be read', () => {
    const s = press(help(), 'down').state;
    expect(s.overlay).toEqual({ kind: 'help', scroll: 1 });
  });

  it('scrolls back up and stops at the top', () => {
    expect(press(help(3), 'up').state.overlay).toEqual({ kind: 'help', scroll: 2 });
    expect(press(help(0), 'up').state.overlay).toEqual({ kind: 'help', scroll: 0 });
  });

  it('pages through the sheet', () => {
    const s = press(help(), 'pagedown').state;
    expect((s.overlay as any).scroll).toBeGreaterThan(1);
  });
});

describe('plan pane', () => {
  const tasks: TaskView[] = [
    { id: 'a', order: 1, title: 'First', type: 'ai', status: 'pending', dependencies: [] },
    { id: 'b', order: 2, title: 'Second', type: 'ai', status: 'running', dependencies: [] },
  ];
  const planned = initialState({ sessionId: 's1', tasks, focus: 'plan' });

  /**
   * A plan taller than the pane. Scrolling is clamped to the lines that
   * actually exist, so a two-task plan in a full-height terminal has nothing to
   * scroll and every notch is correctly a no-op.
   */
  const tallPlan = (over: Partial<TuiState> = {}): TuiState => initialState({
    sessionId: 's1',
    focus: 'plan',
    rows: 24,
    cols: 80,
    tasks: Array.from({ length: 30 }, (_, i) => ({
      id: `t${i}`, order: i + 1, title: `Task ${i + 1}`, type: 'ai' as const, status: 'pending', dependencies: [],
    })),
    ...over,
  });

  it('tab moves focus between the chat and the plan', () => {
    const toPlan = press(initialState({ tasks }), 'tab').state;
    expect(toPlan.focus).toBe('plan');
    expect(press(toPlan, 'tab').state.focus).toBe('chat');
  });

  it('up and down move the task cursor', () => {
    const s = press(planned, 'down').state;
    expect(s.selectedTask).toBe(1);
    expect(press(s, 'up').state.selectedTask).toBe(0);
  });

  it('enter expands the selected task, seeding an editable prompt draft', () => {
    const expanded = press(planned, 'enter').state;
    expect(expanded.expandedTaskId).toBe('a');
    expect(expanded.taskEditor?.text).toBe('First');
  });

  it('escape collapses the expanded task without saving', () => {
    const expanded = press(planned, 'enter').state;
    const collapsed = press(expanded, 'escape').state;
    expect(collapsed.expandedTaskId).toBeNull();
    expect(collapsed.taskEditor).toBeNull();
  });

  it('enter again saves the edited prompt and collapses', () => {
    const expanded = press(planned, 'enter').state;
    const typed = press(expanded, 'char', '!').state;
    expect(typed.taskEditor?.text).toBe('First!');
    const saved = press(typed, 'enter');
    expect(saved.state.expandedTaskId).toBeNull();
    expect(saved.state.taskEditor).toBeNull();
    expect(saved.effects).toContainEqual(
      expect.objectContaining({ type: 'updateTask', taskId: 'a', changes: { prompt: 'First!' } }),
    );
  });

  it('up/down while a task is expanded neither collapses it nor moves the list cursor (mouse wheel arrives as arrow keys)', () => {
    const expanded = press(planned, 'enter').state;
    const scrolledDown = press(expanded, 'down').state;
    expect(scrolledDown.expandedTaskId).toBe('a');
    expect(scrolledDown.selectedTask).toBe(0);
    const scrolledUp = press(expanded, 'up').state;
    expect(scrolledUp.expandedTaskId).toBe('a');
    expect(scrolledUp.selectedTask).toBe(0);
  });

  it('scrollup in plan pane does NOT collapse the expanded task', () => {
    const expanded = press(tallPlan(), 'enter').state;
    expect(expanded.expandedTaskId).toBe('t0');
    const scrolledDown = press(expanded, 'scrolldown').state;
    const scrolled = press(scrolledDown, 'scrollup').state;
    expect(scrolled.expandedTaskId).toBe('t0');
    expect(scrolled.planScroll!).toBeLessThan(scrolledDown.planScroll!);
  });

  it('shift-enter in the task editor inserts a newline without committing', () => {
    const expanded = press(planned, 'enter').state;
    const result = press(expanded, 'shift-enter');
    expect(result.state.taskEditor?.text).toBe('First\n');
    expect(result.state.expandedTaskId).toBe('a');
    expect(result.effects).toEqual([]);
  });

  it('shift-enter at cursor in middle of text in task editor inserts newline at cursor', () => {
    const expanded = press(planned, 'enter').state;
    const moved = { ...expanded, taskEditor: { ...expanded.taskEditor!, cursor: 2 } };
    const result = press(moved, 'shift-enter');
    expect(result.state.taskEditor?.text).toBe('Fi\nrst');
    expect(result.state.taskEditor?.cursor).toBe(3);
    expect(result.state.expandedTaskId).toBe('a');
  });

  it('alt-enter in the task editor also inserts a newline without committing', () => {
    const expanded = press(planned, 'enter').state;
    const result = press(expanded, 'alt-enter');
    expect(result.state.taskEditor?.text).toBe('First\n');
    expect(result.state.expandedTaskId).toBe('a');
    expect(result.effects).toEqual([]);
  });

  it('up/down move the cursor through a long wrapped prompt when editing a task (no literal newline)', () => {
    const longTasks: TaskView[] = [
      {
        id: 'a',
        order: 1,
        title: 'Long',
        type: 'ai',
        status: 'pending',
        dependencies: [],
        prompt: 'one two three four five six seven eight nine ten',
      },
    ];
    // Wide enough that the plan pane is actually rendered — at cols: 20 it is
    // suppressed entirely, so the wrap width under test would be degenerate.
    const state = initialState({ sessionId: 's1', tasks: longTasks, focus: 'plan', cols: 80 });
    const expanded = press(state, 'enter').state;
    const startCursor = expanded.taskEditor!.cursor;
    expect(startCursor).toBe(expanded.taskEditor!.text.length);

    const up = press(expanded, 'up').state;
    expect(up.taskEditor!.cursor).toBeLessThan(startCursor);
    expect(up.expandedTaskId).toBe('a');

    const down = press(up, 'down').state;
    expect(down.taskEditor!.cursor).toBe(startCursor);
  });

  it('pageup/pagedown scroll the plan pane while a task is expanded', () => {
    const expanded = press(tallPlan(), 'enter').state;
    const paged = press(expanded, 'pagedown').state;
    expect(paged.expandedTaskId).toBe('t0');
    expect(paged.planScroll!).toBeGreaterThan(0);
    const back = press(paged, 'pageup').state;
    expect(back.planScroll!).toBeLessThan(paged.planScroll!);
  });

  it('scrolldown in plan pane increments planScroll', () => {
    const scrolled = press(tallPlan({ planScroll: 3 }), 'scrolldown').state;
    expect(scrolled.planScroll).toBe(6);
  });

  it('scrollup in plan pane decrements planScroll', () => {
    const scrolled = press(tallPlan({ planScroll: 6 }), 'scrollup').state;
    expect(scrolled.planScroll).toBe(3);
  });

  it('scrollup in plan pane stops at 0', () => {
    const scrolled = press(tallPlan({ planScroll: 2 }), 'scrollup').state;
    expect(scrolled.planScroll).toBe(0);
  });

  it('pageup/pagedown scroll the collapsed plan pane, the keyboard route now that the wheel is opt-in', () => {
    const down = press(tallPlan({ planScroll: 0 }), 'pagedown').state;
    expect(down.planScroll!).toBeGreaterThan(0);
    expect(down.selectedTask).toBe(0);
    const up = press(down, 'pageup').state;
    expect(up.planScroll).toBe(0);
  });

  it('a plan shorter than the pane has nothing to scroll, so every notch is a no-op', () => {
    const short = initialState({ sessionId: 's1', tasks, focus: 'plan', rows: 24, cols: 80 });
    expect(press(short, 'pagedown').state.planScroll).toBe(0);
    expect(press(short, 'scrolldown').state.planScroll).toBe(0);
  });

  it('arrow key up hands the pane back to follow mode', () => {
    const moved = press(tallPlan({ planScroll: 9, selectedTask: 5 }), 'up').state;
    expect(moved.planScroll).toBeNull();
  });

  it('o opens a runner-compatible model picker for the selected task', () => {
    const state = initialState({
      sessionId: 's1',
      focus: 'plan',
      tasks: [{ ...tasks[0], assignedRunner: 'codex' }],
      models: [
        { id: 'gpt-5', label: 'GPT-5', provider: 'OpenAI', runners: ['codex'], variants: [{ id: 'high', label: 'High' }] },
        { id: 'claude', label: 'Claude', provider: 'Anthropic', runners: ['claude-code'] },
      ],
    });
    const opened = press(state, 'char', 'o');
    expect(opened.state.overlay).toMatchObject({
      kind: 'picker',
      picker: { action: { kind: 'set-task-model', taskId: 'a' }, items: [{ id: 'gpt-5' }] },
    });
    expect(opened.effects).toEqual([{ type: 'loadModels' }]);
  });

  it('choosing a task model persists the assignment and supported efforts', () => {
    const task = { ...tasks[0], assignedRunner: 'codex' };
    const state = withPicker(
      {
        items: [{ id: 'gpt-5', label: 'GPT-5' }],
        action: { kind: 'set-task-model', taskId: 'a' },
      },
      {
        sessionId: 's1',
        tasks: [task],
        models: [{
          id: 'gpt-5',
          label: 'GPT-5',
          provider: 'OpenAI',
          runners: ['codex'],
          variants: [{ id: 'low', label: 'Low' }, { id: 'high', label: 'High' }],
        }],
      },
    );
    expect(press(state, 'enter').effects).toEqual([expect.objectContaining({
      type: 'updateTask',
      sessionId: 's1',
      taskId: 'a',
      changes: {
        assignedModel: {
          modelId: 'gpt-5',
          modelLabel: 'GPT-5',
          thinkingEffort: undefined,
          availableVariants: ['low', 'high'],
        },
        thinkingEffort: null,
      },
    })]);
  });

  it('e opens an effort picker and choosing a level persists it', () => {
    const task: TaskView = {
      ...tasks[0],
      assignedRunner: 'codex',
      assignedModel: {
        modelId: 'gpt-5',
        modelLabel: 'GPT-5',
        thinkingEffort: 'low',
        availableVariants: ['low', 'high'],
      },
    };
    const opened = press(initialState({ sessionId: 's1', focus: 'plan', tasks: [task] }), 'char', 'e').state;
    expect(opened.overlay).toMatchObject({
      kind: 'picker',
      picker: {
        action: { kind: 'set-task-effort', taskId: 'a' },
        items: [{ id: '__runner_default__' }, { id: 'low' }, { id: 'high' }],
      },
    });
    const selectedHigh = {
      ...opened,
      overlay: {
        ...(opened.overlay as any),
        picker: { ...(opened.overlay as any).picker, index: 2 },
      },
    };
    expect(press(selectedHigh, 'enter').effects).toEqual([expect.objectContaining({
      type: 'updateTask',
      changes: expect.objectContaining({
        assignedModel: expect.objectContaining({ thinkingEffort: 'high' }),
        thinkingEffort: 'high',
      }),
    })]);
  });

  it.each([
    ['c', 'cancel'],
    ['m', 'complete'],
    ['s', 'skip'],
  ])('%s acts on the selected task', (char, action) => {
    const s = { ...planned, selectedTask: 1 };
    expect(press(s, 'char', char).effects).toEqual([
      { type: 'taskAction', sessionId: 's1', taskId: 'b', action },
    ]);
  });

  it('f starts the selected task and watches the execution stream for it', () => {
    const s = { ...planned, selectedTask: 1 };
    expect(press(s, 'char', 'f').effects).toEqual([
      { type: 'taskAction', sessionId: 's1', taskId: 'b', action: 'force-start', watch: true },
    ]);
  });

  it('does not ask for a second stream while a run is already streaming', () => {
    const s: TuiState = { ...planned, selectedTask: 1, status: 'executing' };
    expect(press(s, 'char', 'f').effects).toEqual([
      { type: 'taskAction', sessionId: 's1', taskId: 'b', action: 'force-start' },
    ]);
  });

  it('E runs the whole plan, the same as /run', () => {
    expect(press(planned, 'char', 'E').effects).toEqual([{ type: 'execute', sessionId: 's1' }]);
  });

  it('r is not bound — f is the one way to start a task', () => {
    expect(press(planned, 'char', 'r').effects).toEqual([]);
  });

  it('d asks before removing the selected task', () => {
    const asked = press(planned, 'char', 'd');

    expect(asked.effects).toEqual([]);
    expect(asked.state.overlay).toMatchObject({ kind: 'confirm', action: { kind: 'remove-task', taskId: 'a' } });
  });

  it('t opens a terminal on the selected task', () => {
    const s = { ...planned, selectedTask: 1 };
    expect(press(s, 'char', 't').effects).toEqual([
      { type: 'openTaskTerminal', sessionId: 's1', taskId: 'b' },
    ]);
  });

  it('escape returns focus to the chat', () => {
    expect(press(planned, 'escape').state.focus).toBe('chat');
  });

  it('does not type plan shortcuts into the chat input', () => {
    expect(press(planned, 'char', 'c').state.editor.text).toBe('');
  });
});

describe('global keys', () => {
  it('ctrl-c exits', () => {
    const { state, effects } = press(initialState(), 'ctrl-c');
    expect(state.exiting).toBe(true);
    expect(effects).toEqual([{ type: 'exit' }]);
  });

  it('ctrl-c closes an overlay first instead of quitting', () => {
    const { state, effects } = press(withPicker({}), 'ctrl-c');
    expect(state.overlay).toBeNull();
    expect(state.exiting).toBe(false);
    expect(effects).toEqual([]);
  });

  it('ctrl-c clears a half-typed line instead of quitting', () => {
    const typing = initialState();
    const { state, effects } = press({ ...typing, editor: { ...typing.editor, text: 'oops', cursor: 4 } }, 'ctrl-c');
    expect(state.editor.text).toBe('');
    expect(state.exiting).toBe(false);
    expect(effects).toEqual([]);
  });

  it('ctrl-d exits from an empty prompt', () => {
    expect(press(initialState(), 'ctrl-d').effects).toEqual([{ type: 'exit' }]);
  });

  it('ctrl-l clears the transcript', () => {
    const s = initialState({ messages: [{ role: 'user', content: 'x', timestamp: '' }] });
    expect(press(s, 'ctrl-l').state.messages).toEqual([]);
  });

  it('escape clears the chat input', () => {
    const typing = initialState();
    const s = press({ ...typing, editor: { ...typing.editor, text: 'abc', cursor: 3 } }, 'escape').state;
    expect(s.editor.text).toBe('');
  });
});
