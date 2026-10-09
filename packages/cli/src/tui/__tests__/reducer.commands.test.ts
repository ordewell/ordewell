import { describe, it, expect, afterEach } from 'vitest';
import { initialState, reduce, type Effect } from '../reducer';
import { registerSkillCommands } from '../slash';
import type { TaskView, TuiState } from '../state';
import { chatOf, lastMessage, messagesOf } from './chat';

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

describe('retired mode toggles', () => {
  it.each(['/tdd on', '/verify on', '/transport terminal'])('%s is no longer a command and sends nothing', (line) => {
    expect(run(line).effects).toEqual([]);
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
    expect(lastMessage(state)?.role).toBe('error');
  });

  it('/refresh re-discovers runners and catalogs', () => {
    expect(run('/refresh').effects).toEqual([{ type: 'refresh', announce: true }]);
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
  it('/parallel <n> sets how many tasks run at once; bare /parallel says what it is', () => {
    expect(run('/parallel 8').effects).toEqual([{ type: 'setMaxParallel', limit: 8 }]);
    expect(run('/parallel 8').state.maxParallel).toBe(8);
    expect(lastMessage(run('/parallel', { maxParallel: 2 }).state)?.text).toBe('Up to 2 AI tasks run at once — /parallel <n> changes it.');
    expect(run('/parallel 0').effects).toEqual([]);
    expect(run('/parallel many').effects).toEqual([]);
  });

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

  it('/auto full and /auto guarded select the two levels', () => {
    expect(run('/auto full', { autonomous: false }).effects).toEqual([{ type: 'setAutonomous', enabled: true }]);
    expect(run('/auto guarded', { autonomous: true }).effects).toEqual([{ type: 'setAutonomous', enabled: false }]);
  });

  it('on, off and auto are aliases of Full and Guarded', () => {
    expect(run('/auto on', { autonomous: false }).effects).toEqual([{ type: 'setAutonomous', enabled: true }]);
    expect(run('/auto off', { autonomous: true }).effects).toEqual([{ type: 'setAutonomous', enabled: false }]);
    expect(run('/auto auto', { autonomous: true }).effects).toEqual([{ type: 'setAutonomous', enabled: false }]);
  });

  it('a bare /auto prints the current level and changes nothing', () => {
    const full = run('/auto', { autonomous: true });
    expect(full.effects).toEqual([]);
    expect(full.state.autonomous).toBe(true);
    expect(lastMessage(full.state)?.text).toContain('Full');
    expect(lastMessage(run('/auto', { autonomous: false }).state)?.text).toContain('Guarded');
  });

  it('/auto updates the state so the badge sees the new level', () => {
    expect(run('/auto guarded', { autonomous: true }).state.autonomous).toBe(false);
    expect(run('/auto full', { autonomous: false }).state.autonomous).toBe(true);
  });

  it('/auto with anything else shows the usage with both level names', () => {
    const { effects, state } = run('/auto maybe');
    expect(effects).toEqual([]);
    expect(lastMessage(state)?.text).toBe('Usage: /auto [full|guarded]');
  });

  // Capture used to cost the user drag-select outright; now the app does the
  // selecting itself, one pane at a time, so the notice must not still say the
  // trade is text selection.
  it('/mouse on takes the wheel and the selection, and says both', () => {
    const { state, effects } = run('/mouse on');
    expect(effects).toEqual([{ type: 'setMouseCapture', enabled: true }]);
    expect(state.mouseCapture).toBe(true);
    const said = lastMessage(state)!.text;
    expect(said).toContain('wheel');
    expect(said).toMatch(/selects?/);
    expect(said).not.toContain('no longer selects text');
  });

  it('a bare /mouse hands the mouse back to the terminal', () => {
    const { state, effects } = run('/mouse', { mouseCapture: true });
    expect(effects).toEqual([{ type: 'setMouseCapture', enabled: false }]);
    expect(state.mouseCapture).toBe(false);
    expect(lastMessage(state)!.text).toContain("terminal's own");
  });

  it('/mouse rejects an argument that is neither on nor off', () => {
    const { state, effects } = run('/mouse sometimes');
    expect(effects).toEqual([]);
    expect(lastMessage(state)).toMatchObject({ role: 'error' });
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
    const { state } = run('/new', { ...planned, conversation: chatOf(['user', 'x']) });
    expect(state.overlay).toMatchObject({ kind: 'confirm', action: { kind: 'new-session' } });
    expect(state.sessionId).toBe('session-1');
  });

  it('/new confirmed clears the plan and transcript, and stops the old session', () => {
    const { state } = run('/new', { ...planned, conversation: chatOf(['user', 'x']) });
    const confirmed = reduce(state, { type: 'key', key: { name: 'enter' } });
    expect(confirmed.state.overlay).toBeNull();
    expect(confirmed.state.sessionId).toBeNull();
    expect(confirmed.state.tasks).toEqual([]);
    expect(messagesOf(confirmed.state)).toEqual([]);
    expect(confirmed.effects).toEqual([{ type: 'closeSession', sessionId: 'session-1' }]);
  });

  it('/new cancelled with escape leaves the session untouched', () => {
    const { state } = run('/new', { ...planned, conversation: chatOf(['user', 'x']) });
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
    expect(lastMessage(state)?.role).toBe('error');
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
    expect(lastMessage(state)?.role).toBe('error');
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

describe('skill commands', () => {
  afterEach(() => registerSkillCommands([]));

  it('Tab completes a registered skill prefix', () => {
    registerSkillCommands([{ name: 'grilling', description: 'Grill the plan' }]);
    const base = initialState();
    const state = { ...base, editor: { ...base.editor, text: '/gri', cursor: 4 } };
    const { state: completed } = reduce(state, { type: 'key', key: { name: 'tab' } });
    expect(completed.editor.text).toBe('/grilling ');
  });

  it('Tab completes a skill token typed mid-prompt, keeping the rest of the text', () => {
    registerSkillCommands([{ name: 'grilling', description: 'Grill the plan' }]);
    const base = initialState();
    const text = 'explain this bug /gri then summarize';
    const cursor = text.indexOf('/gri') + '/gri'.length;
    const state = { ...base, editor: { ...base.editor, text, cursor } };
    const { state: completed } = reduce(state, { type: 'key', key: { name: 'tab' } });
    expect(completed.editor.text).toBe('explain this bug /grilling  then summarize');
    expect(completed.editor.cursor).toBe('explain this bug /grilling '.length);
  });

  it('dispatches a skill command to the planner instead of reporting it unknown', () => {
    registerSkillCommands([{ name: 'grilling', description: 'Grill the plan' }]);
    const { state, effects } = run('/grilling');
    expect(effects).toEqual([{ type: 'startConversation', goal: '/grilling' }]);
    expect(lastMessage(state)).toMatchObject({ role: 'user', text: '/grilling' });
  });

  it('sends a skill command to an existing session as a message, not a command', () => {
    registerSkillCommands([{ name: 'grilling', description: 'Grill the plan' }]);
    expect(run('/grilling', planned).effects).toEqual([
      { type: 'sendMessage', sessionId: 'session-1', message: '/grilling' },
    ]);
  });

  it('a skill name colliding with a built-in still dispatches the built-in', () => {
    registerSkillCommands([{ name: 'help', description: 'A skill pretending to be help' }]);
    expect(run('/help').state.overlay).toEqual({ kind: 'help', scroll: 0 });
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
    expect(lastMessage(state)?.role).toBe('error');
  });

  it('never echoes a command into the transcript as a user turn', () => {
    const { state } = run('/help');
    expect(messagesOf(state).some((m) => m.role === 'user')).toBe(false);
  });
});
