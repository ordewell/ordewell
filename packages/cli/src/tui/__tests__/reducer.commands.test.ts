import { describe, it, expect } from 'vitest';
import { initialState, reduce, type Effect } from '../reducer';
import type { TaskView, TuiState } from '../state';

function run(text: string, overrides: Partial<TuiState> = {}) {
  const base = initialState(overrides);
  const state = { ...base, editor: { ...base.editor, text, cursor: text.length } };
  return reduce(state, { type: 'key', key: { name: 'enter' } });
}

const task = (over: Partial<TaskView>): TaskView => ({
  id: 'task-1', order: 1, title: 'Do the thing', type: 'ai', status: 'pending', dependencies: [], ...over,
});

const planned: Partial<TuiState> = {
  sessionId: 'session-1',
  tasks: [task({ id: 'task-a', order: 1 }), task({ id: 'task-b', order: 2, title: 'Second' })],
};

describe('skills', () => {
  it.each(['grill-me', 'tdd', 'prd', 'review', 'verify', 'research-subagents'])(
    '/%s on turns the skill on through the daemon command API',
    (skill) => {
      expect(run(`/${skill} on`).effects).toEqual([{ type: 'command', name: skill, action: 'on' }]);
    },
  );

  it('/tdd off turns the skill off', () => {
    expect(run('/tdd off').effects).toEqual([{ type: 'command', name: 'tdd', action: 'off' }]);
  });

  it('a bare /grill-me toggles whatever is currently set', () => {
    const on = { skills: { ...initialState().skills, 'grill-me': true } };
    expect(run('/grill-me', on).effects).toEqual([{ type: 'command', name: 'grill-me', action: 'off' }]);
    expect(run('/grill-me').effects).toEqual([{ type: 'command', name: 'grill-me', action: 'on' }]);
  });
});

describe('models and providers', () => {
  it('/model set applies the model directly', () => {
    expect(run('/model set deepseek/deepseek-v4-flash').effects).toEqual([
      { type: 'setModel', modelId: 'deepseek/deepseek-v4-flash' },
    ]);
  });

  it('/model with no argument opens a picker and loads the catalog', () => {
    const { state, effects } = run('/model');
    expect(state.overlay).toMatchObject({ kind: 'picker', picker: { action: { kind: 'set-model' } } });
    expect(effects).toEqual([{ type: 'loadModels' }]);
  });

  it('/key set stores a provider key', () => {
    expect(run('/key set openrouter sk-or-123').effects).toEqual([
      { type: 'setApiKey', provider: 'openrouter', key: 'sk-or-123' },
    ]);
  });

  it('/key with no argument opens the provider picker', () => {
    const { state } = run('/key');
    expect(state.overlay).toMatchObject({ kind: 'picker', picker: { action: { kind: 'set-key' } } });
  });

  it('/key rejects a provider it does not know', () => {
    const { state, effects } = run('/key set notaprovider sk-1');
    expect(effects).toEqual([]);
    expect(state.messages.at(-1)?.role).toBe('error');
  });

  it('/refresh re-discovers runners and catalogs', () => {
    expect(run('/refresh').effects).toEqual([{ type: 'refresh' }]);
  });
});

describe('model allowlist', () => {
  it('/allowlist set limits a runner to the listed models', () => {
    expect(run('/allowlist set opencode a/b, c/d').effects).toEqual([
      { type: 'setAllowlist', runner: 'opencode', modelIds: ['a/b', 'c/d'] },
    ]);
  });

  it('/allowlist clear lifts the restriction', () => {
    expect(run('/allowlist clear opencode').effects).toEqual([
      { type: 'setAllowlist', runner: 'opencode', modelIds: [] },
    ]);
  });

  it('/allowlist with no argument asks which runner to limit', () => {
    const { state } = run('/allowlist', { runners: [{ id: 'opencode', name: 'OpenCode', enabled: true }] });
    expect(state.overlay).toMatchObject({
      kind: 'picker',
      picker: { action: { kind: 'choose-allowlist-runner' } },
    });
  });
});

describe('runners and autonomy', () => {
  it('/runners <id> off disables a runner', () => {
    expect(run('/runners opencode off').effects).toEqual([
      { type: 'setRunnerEnabled', runner: 'opencode', enabled: false },
    ]);
  });

  it('/runners with no argument opens a multi-select seeded with the enabled ones', () => {
    const { state } = run('/runners', {
      runners: [
        { id: 'opencode', name: 'OpenCode', enabled: true },
        { id: 'codex', name: 'Codex', enabled: false },
      ],
    });
    expect(state.overlay).toMatchObject({
      kind: 'picker',
      picker: { action: { kind: 'set-runners' }, multi: true, chosen: ['opencode'] },
    });
  });

  it('/auto off leaves autonomous mode', () => {
    expect(run('/auto off').effects).toEqual([{ type: 'setAutonomous', enabled: false }]);
  });

  it('a bare /auto flips the current setting', () => {
    expect(run('/auto', { autonomous: true }).effects).toEqual([{ type: 'setAutonomous', enabled: false }]);
  });

  it('/auto updates the state so the badge and the next toggle see the new value', () => {
    const { state } = run('/auto', { autonomous: true });
    expect(state.autonomous).toBe(false);

    const again = reduce(
      { ...state, editor: { ...state.editor, text: '/auto', cursor: 5 } },
      { type: 'key', key: { name: 'enter' } },
    );
    expect(again.effects).toEqual([{ type: 'setAutonomous', enabled: true }]);
  });

  it('/mouse on trades text selection for wheel scrolling, and says so', () => {
    const { state, effects } = run('/mouse on');
    expect(effects).toEqual([{ type: 'setMouseCapture', enabled: true }]);
    expect(state.mouseCapture).toBe(true);
    expect(state.messages.at(-1)!.content).toContain('no longer selects text');
  });

  it('a bare /mouse flips it back, so selection is one keystroke away again', () => {
    const { state, effects } = run('/mouse', { mouseCapture: true });
    expect(effects).toEqual([{ type: 'setMouseCapture', enabled: false }]);
    expect(state.mouseCapture).toBe(false);
  });

  it('/mouse rejects an argument that is neither on nor off', () => {
    const { state, effects } = run('/mouse sometimes');
    expect(effects).toEqual([]);
    expect(state.messages.at(-1)).toMatchObject({ role: 'error' });
  });
});

describe('sessions', () => {
  it('/sessions loads the session list into a picker', () => {
    const { state, effects } = run('/sessions');
    expect(effects).toEqual([{ type: 'loadSessions' }]);
    expect(state.overlay).toMatchObject({ kind: 'picker', picker: { action: { kind: 'load-session' } } });
  });

  it('/load pulls a session by id', () => {
    expect(run('/load session-9').effects).toEqual([{ type: 'loadSession', sessionId: 'session-9' }]);
  });

  it('/delete removes a session by id', () => {
    expect(run('/delete session-9').effects).toEqual([{ type: 'deleteSession', sessionId: 'session-9' }]);
  });

  it('/save persists the current session', () => {
    expect(run('/save', planned).effects).toEqual([{ type: 'saveSession', sessionId: 'session-1' }]);
  });

  it('/new asks for confirmation when there is a plan to lose', () => {
    const { state } = run('/new', { ...planned, messages: [{ role: 'user', content: 'x', timestamp: '' }] });
    expect(state.overlay).toMatchObject({ kind: 'confirm', action: { kind: 'new-session' } });
    expect(state.sessionId).toBe('session-1');
  });

  it('/new confirmed clears the plan and transcript, and stops the old session', () => {
    const { state } = run('/new', { ...planned, messages: [{ role: 'user', content: 'x', timestamp: '' }] });
    const confirmed = reduce(state, { type: 'key', key: { name: 'enter' } });
    expect(confirmed.state.overlay).toBeNull();
    expect(confirmed.state.sessionId).toBeNull();
    expect(confirmed.state.tasks).toEqual([]);
    expect(confirmed.state.messages).toEqual([]);
    expect(confirmed.effects).toEqual([{ type: 'closeSession', sessionId: 'session-1' }]);
  });

  it('/new cancelled with escape leaves the session untouched', () => {
    const { state } = run('/new', { ...planned, messages: [{ role: 'user', content: 'x', timestamp: '' }] });
    const cancelled = reduce(state, { type: 'key', key: { name: 'escape' } });
    expect(cancelled.state.overlay).toBeNull();
    expect(cancelled.state.sessionId).toBe('session-1');
    expect(cancelled.state.tasks).toEqual(planned.tasks);
  });

  it('/new resets immediately when there is nothing to lose', () => {
    const { state, effects } = run('/new');
    expect(state.sessionId).toBeNull();
    expect(effects).toEqual([]);
  });
});

describe('execution', () => {
  it('/run executes the plan', () => {
    expect(run('/run', planned).effects).toEqual([{ type: 'execute', sessionId: 'session-1' }]);
  });

  it('/run refuses when there is no plan yet', () => {
    const { state, effects } = run('/run');
    expect(effects).toEqual([]);
    expect(state.messages.at(-1)?.role).toBe('error');
  });

  it('/approve marks the plan approved and starts it', () => {
    const { state, effects } = run('/approve', planned);
    expect(state.planApproved).toBe(true);
    expect(effects).toEqual([{ type: 'execute', sessionId: 'session-1' }]);
  });

  it('/stop halts the run', () => {
    expect(run('/stop', planned).effects).toEqual([{ type: 'stopExecution', sessionId: 'session-1' }]);
  });

  it('/stop cancels the planner instead, while a planning turn is in flight', () => {
    expect(run('/stop', { ...planned, status: 'planning' }).effects).toEqual([
      { type: 'cancelPlanning', sessionId: 'session-1' },
    ]);
  });
});

describe('task control', () => {
  const cases: [string, Effect][] = [
    ['/complete task-a', { type: 'taskAction', sessionId: 'session-1', taskId: 'task-a', action: 'complete' }],
    ['/skip task-a', { type: 'taskAction', sessionId: 'session-1', taskId: 'task-a', action: 'skip' }],
    ['/retry task-a', { type: 'taskAction', sessionId: 'session-1', taskId: 'task-a', action: 'retry', watch: true }],
    ['/cancel task-a', { type: 'taskAction', sessionId: 'session-1', taskId: 'task-a', action: 'cancel' }],
    ['/force-start task-a', { type: 'taskAction', sessionId: 'session-1', taskId: 'task-a', action: 'force-start', watch: true }],
    ['/remove-task task-a', { type: 'removeTask', sessionId: 'session-1', taskId: 'task-a' }],
    ['/terminal task-a', { type: 'openTaskTerminal', sessionId: 'session-1', taskId: 'task-a' }],
  ];

  it.each(cases)('%s targets the task', (text, effect) => {
    expect(run(text, planned).effects).toEqual([effect]);
  });

  it('accepts a plan order number in place of a task id', () => {
    expect(run('/retry 2', planned).effects).toEqual([
      { type: 'taskAction', sessionId: 'session-1', taskId: 'task-b', action: 'retry', watch: true },
    ]);
  });

  it('reports a task id that is not in the plan', () => {
    const { state, effects } = run('/retry nope', planned);
    expect(effects).toEqual([]);
    expect(state.messages.at(-1)?.role).toBe('error');
  });

  it('/add-task adds a task with the given title', () => {
    expect(run('/add-task Write the docs', planned).effects).toEqual([
      { type: 'addTask', sessionId: 'session-1', title: 'Write the docs' },
    ]);
  });

  it('/add-task with no title asks for one', () => {
    const { state } = run('/add-task', planned);
    expect(state.overlay).toMatchObject({ kind: 'prompt', action: { kind: 'add-task' } });
  });

  it('/task-model assigns a model directly', () => {
    expect(run('/task-model task-a gpt-5', planned).effects).toEqual([expect.objectContaining({
      type: 'updateTask',
      taskId: 'task-a',
      changes: expect.objectContaining({
        assignedModel: expect.objectContaining({ modelId: 'gpt-5', modelLabel: 'gpt-5' }),
      }),
    })]);
  });

  it('/task-effort assigns a visible effort directly', () => {
    const configured = {
      ...planned,
      tasks: [
        task({
          id: 'task-a',
          assignedModel: { modelId: 'gpt-5', modelLabel: 'GPT-5', availableVariants: ['low', 'high'] },
        }),
      ],
    };
    expect(run('/task-effort task-a high', configured).effects).toEqual([expect.objectContaining({
      type: 'updateTask',
      changes: expect.objectContaining({ thinkingEffort: 'high' }),
    })]);
  });
});

describe('system commands', () => {
  it('/help opens the help overlay', () => {
    expect(run('/help').state.overlay).toEqual({ kind: 'help', scroll: 0 });
  });

  it('/quit asks the runtime to exit', () => {
    const { state, effects } = run('/quit');
    expect(state.exiting).toBe(true);
    expect(effects).toEqual([{ type: 'exit' }]);
  });

  it('reports an unknown command instead of sending it to the planner', () => {
    const { state, effects } = run('/nonsense');
    expect(effects).toEqual([]);
    expect(state.messages.at(-1)?.role).toBe('error');
  });

  it('never echoes a command into the transcript as a user turn', () => {
    const { state } = run('/help');
    expect(state.messages.some((m) => m.role === 'user')).toBe(false);
  });
});
