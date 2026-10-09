import { describe, it, expect } from 'vitest';
import { initialState, reduce } from '../reducer';
import type { TuiState } from '../state';
import { lastMessage } from './chat';

const send = (state: TuiState, action: Parameters<typeof reduce>[1]) => reduce(state, action).state;

describe('sessionStarted', () => {
  it('records the id the runtime allocated', () => {
    const s = send(initialState(), { type: 'sessionStarted', sessionId: 'session-7', goal: 'ship it' });
    expect(s.sessionId).toBe('session-7');
    expect(s.goal).toBe('ship it');
  });
});

describe('planUpdated', () => {
  const plan = {
    tasks: [
      { id: 'a', order: 1, title: 'First', type: 'ai', status: 'pending', dependencies: [] },
      { id: 'b', order: 2, title: 'Second', type: 'user', status: 'pending', dependencies: ['a'] },
    ],
  };

  it('replaces the task list and stops the planning spinner', () => {
    const s = send({ ...initialState(), status: 'planning' }, { type: 'planUpdated', plan });
    expect(s.tasks.map((t) => t.id)).toEqual(['a', 'b']);
    expect(s.status).toBe('idle');
  });

  it('reads tasks from pendingTasks when that is where the planner put them', () => {
    const s = send(initialState(), { type: 'planUpdated', plan: { pendingTasks: plan.tasks } });
    expect(s.tasks).toHaveLength(2);
  });

  // A persisted plan is split in two: finished tasks live in `executionLog`,
  // the rest in `pendingTasks`. Showing only the latter hides completed work.
  it('rejoins the execution log with the pending tasks', () => {
    const s = send(initialState(), {
      type: 'planUpdated',
      plan: {
        tasks: [],
        executionLog: [{ id: 'a', order: 1, title: 'Done already', type: 'ai', status: 'completed', dependencies: [] }],
        pendingTasks: [{ id: 'b', order: 2, title: 'Still to do', type: 'ai', status: 'pending', dependencies: ['a'] }],
      },
    });
    expect(s.tasks.map((t) => t.id)).toEqual(['a', 'b']);
    expect(s.tasks[0].status).toBe('completed');
  });

  it('orders the rejoined plan by task order, not by which list it came from', () => {
    const s = send(initialState(), {
      type: 'planUpdated',
      plan: {
        executionLog: [{ id: 'c', order: 3, title: 'Third', status: 'completed' }],
        pendingTasks: [{ id: 'a', order: 1, title: 'First' }, { id: 'b', order: 2, title: 'Second' }],
      },
    });
    expect(s.tasks.map((t) => t.id)).toEqual(['a', 'b', 'c']);
  });

  it('does not list a task twice when it appears in both lists', () => {
    const s = send(initialState(), {
      type: 'planUpdated',
      plan: {
        executionLog: [{ id: 'a', order: 1, title: 'Done', status: 'completed' }],
        pendingTasks: [{ id: 'a', order: 1, title: 'Done', status: 'pending' }],
      },
    });
    expect(s.tasks).toHaveLength(1);
    // The execution log is the record of what actually happened; it wins.
    expect(s.tasks[0].status).toBe('completed');
  });

  it('keeps the pane cursor inside the new plan', () => {
    const s = send({ ...initialState(), selectedTask: 9 }, { type: 'planUpdated', plan });
    expect(s.selectedTask).toBe(1);
  });

  it('survives a plan with no tasks at all', () => {
    const s = send(initialState(), { type: 'planUpdated', plan: {} });
    expect(s.tasks).toEqual([]);
    expect(s.selectedTask).toBe(0);
  });

  // Every string here was written by a model, so it gets the same treatment a
  // planner turn does — see `sanitize`. The pane paints these on every frame.
  it('sanitizes the text a model wrote, the same as it does a planner turn', () => {
    const s = send(initialState(), {
      type: 'planUpdated',
      plan: {
        tasks: [{
          id: 'a',
          order: 1,
          title: 'Add\tthe login\x07 route\x1b[10C',
          description: 'wires\x1b[2K it up',
          prompt: 'line one\r\nline two\x07',
          status: 'pending',
          type: 'ai',
          assignedRunner: 'claude\x07-code',
          assignedModel: { modelId: 'x\x1b[0m', modelLabel: 'Opus\x07 5', thinkingEffort: 'high\x07' },
        }],
      },
    });

    expect(s.tasks[0]).toMatchObject({
      title: 'Add the login route',
      description: 'wires it up',
      assignedRunner: 'claude-code',
    });
    // The prompt is edited in a multi-line editor, so its newlines survive.
    expect(s.tasks[0].prompt).toBe('line one\nline two');
    expect(s.tasks[0].assignedModel).toMatchObject({ modelLabel: 'Opus 5', thinkingEffort: 'high' });
  });

  // A newline in one of the pane's one-row fields is written into the middle of
  // a row rather than wrapped, which moves the cursor down a line and shoves
  // the rest of the frame with it.
  it('flattens a newline out of the fields the pane paints on one row', () => {
    const s = send(initialState(), {
      type: 'planUpdated',
      plan: { tasks: [{ id: 'a', order: 1, title: 'two\nlines', status: 'pending', type: 'ai', assignedRunner: 'a\nb' }] },
    });
    expect(s.tasks[0].title).toBe('two lines');
    expect(s.tasks[0].assignedRunner).toBe('a b');
  });
});

describe('planner conversation', () => {
  it('shows the planner question as an assistant turn; planUpdated settles the spinner', () => {
    const asked = send({ ...initialState(), status: 'planning' }, {
      type: 'sessionMessage', message: { type: 'planner_message', content: 'Which DB?', timestamp: '2026-09-27T10:00:00.000Z' },
    });
    expect(lastMessage(asked)).toMatchObject({ role: 'planner', text: 'Which DB?' });

    // `planUpdated` is the action that ends a turn — see `converse`, which
    // dispatches the turn's text first and this settle after it, so a queued
    // prompt can drain onto the settled state without this clobbering it.
    const settled = send(asked, { type: 'planUpdated', plan: { tasks: [] } });
    expect(settled.status).toBe('idle');
  });

  it('shows research progress on the spinner and in the transcript', () => {
    const s = send({ ...initialState(), status: 'planning' }, {
      type: 'sessionMessage', message: { type: 'research_step', tool: 'grep', args: '{"pattern":"auth"}' },
    });
    expect(s.busyLabel).toBe('Grep(auth)');
    expect(s.conversation.blocks).toEqual([
      expect.objectContaining({ type: 'tool', headline: { name: 'Grep', keyArg: 'auth' }, status: 'pending' }),
    ]);
  });
});

describe('execution', () => {
  const withTasks: Partial<TuiState> = {
    sessionId: 's1',
    tasks: [
      { id: 'a', order: 1, title: 'First', type: 'ai', status: 'pending', dependencies: [] },
      { id: 'b', order: 2, title: 'Second', type: 'ai', status: 'pending', dependencies: [] },
    ],
  };

  it('updates one task in place', () => {
    const s = send(initialState(withTasks), { type: 'taskStatus', taskId: 'b', status: 'running' });
    expect(s.tasks.map((t) => t.status)).toEqual(['pending', 'running']);
    expect(s.status).toBe('executing');
  });

  it('ignores a status for a task that is not in the plan', () => {
    const s = send(initialState(withTasks), { type: 'taskStatus', taskId: 'zz', status: 'running' });
    expect(s.tasks.map((t) => t.status)).toEqual(['pending', 'pending']);
  });

  it('returns to idle when the run finishes and reports the outcome', () => {
    const s = send(initialState({ ...withTasks, status: 'executing' }), {
      type: 'executionComplete',
      summary: { total: 2, completed: 2, failed: 0 },
    });
    expect(s.status).toBe('idle');
    expect(lastMessage(s)?.text).toContain('2/2');
  });

  it('stops following the run when the execution stream is lost, leaving task statuses as last reported', () => {
    const live = initialState({
      ...withTasks,
      status: 'executing',
      busyLabel: 'Running a',
      tasks: [{ ...withTasks.tasks![0], status: 'completed' }, { ...withTasks.tasks![1], status: 'in_progress' }],
    });
    const s = send(live, { type: 'executionLost' });
    expect(s.status).toBe('idle');
    expect(s.busyLabel).toBe('');
    expect(s.tasks.map((t) => t.status)).toEqual(['completed', 'in_progress']);
    expect(lastMessage(s)?.text).toContain('Lost the connection');
    expect(lastMessage(s)?.text).not.toContain('Restart the daemon');
    expect(lastMessage(s)?.text).toContain('/load');
  });

  // A run whose last live task is cancelled or marked done can never restart if
  // the indicator stays "executing": the daemon refuses the next Execute as
  // "already executing". The tasks are the truth, not the stream.
  const running: Partial<TuiState> = {
    ...withTasks,
    status: 'executing',
    tasks: withTasks.tasks!.map((t) => ({ ...t, status: 'in_progress' })),
  };

  it('returns to idle on a status snapshot with nothing running', () => {
    const s = send(initialState(running), {
      type: 'tasksStatus',
      updates: { a: { status: 'completed' }, b: { status: 'pending' } },
    });
    expect(s.status).toBe('idle');
  });

  it('returns to idle when a single task update leaves none running', () => {
    const s = send(initialState({ ...running, tasks: [withTasks.tasks![0], withTasks.tasks![1]] }), {
      type: 'taskStatus',
      taskId: 'a',
      status: 'pending',
    });
    expect(s.status).toBe('idle');
  });

  it('still says executing while some task is running', () => {
    const s = send(initialState({ ...withTasks, status: 'idle' }), {
      type: 'tasksStatus',
      updates: { a: { status: 'completed' }, b: { status: 'in_progress' } },
    });
    expect(s.status).toBe('executing');
  });

  it('does not let a run status clobber a planner turn in flight', () => {
    const s = send(initialState({ ...withTasks, status: 'researching' }), {
      type: 'tasksStatus',
      updates: { a: { status: 'pending' }, b: { status: 'pending' } },
    });
    expect(s.status).toBe('researching');
  });

  it('counts the pane when a stop arrives without a tally', () => {
    // `execution_stopped` carries no summary, and defaulting the count to zero
    // reported a run halted midway as "0/N complete" — the pane's own statuses
    // are the only tally there is.
    const tasks = [
      { ...withTasks.tasks![0], status: 'completed' },
      { ...withTasks.tasks![1], status: 'failed' },
    ];
    const s = send(initialState({ ...withTasks, tasks, status: 'executing' }), {
      type: 'executionComplete',
      stopped: true,
    });

    expect(s.status).toBe('idle');
    expect(lastMessage(s)?.text).toBe('Execution stopped — 1/2 tasks complete · 1 failed.');
  });
});

describe('loaded data', () => {
  it('mirrors the daemon settings into the skill toggles', () => {
    const s = send(initialState(), {
      type: 'settingsLoaded',
      settings: {
        orchestratorModel: 'x/y',
        tdd: { enabled: false },
        modelAllowlist: { opencode: ['a/b'] },
      },
    });
    expect(s.skills.tdd).toBe(false);
    expect(s.orchestratorModel).toBe('x/y');
    expect(s.allowlist).toEqual({ opencode: ['a/b'] });
  });

  it('fills the orchestrator picker from the cross-provider catalog, naming each provider', () => {
    const opened = reduce(
      { ...initialState(), editor: { ...initialState().editor, text: '/model', cursor: 6 } },
      { type: 'key', key: { name: 'enter' } },
    ).state;
    const s = send(opened, {
      type: 'modelsLoaded',
      models: [{ id: 'runner/x', label: 'Runner X', provider: 'claude-code' }],
      orchestratorModels: [
        { id: 'deepseek/v4', label: 'DeepSeek V4', provider: 'OpenRouter', pricing: '$0.14/0.28/MTok' },
        { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', provider: 'Google' },
      ],
    });
    // The picker shows the planner catalog (orchestratorModels), not runner models.
    expect(s.overlay).toMatchObject({
      kind: 'picker',
      picker: {
        items: [
          { id: 'deepseek/v4', detail: 'OpenRouter · $0.14/0.28/MTok' },
          { id: 'gemini-2.5-pro', detail: 'Google' },
        ],
      },
    });
  });

  it('warns in the picker when a configured provider failed, still listing the working ones', () => {
    const opened = reduce(
      { ...initialState(), editor: { ...initialState().editor, text: '/model', cursor: 6 } },
      { type: 'key', key: { name: 'enter' } },
    ).state;
    const s = send(opened, {
      type: 'modelsLoaded',
      models: [],
      orchestratorModels: [{ id: 'deepseek/v4', label: 'DeepSeek V4', provider: 'OpenRouter' }],
      providerErrors: { openai: 'Failed to fetch models: 401 Unauthorized' },
    });
    expect(s.overlay).toMatchObject({ kind: 'picker', picker: { items: [{ id: 'deepseek/v4' }] } });
    const hint = (s.overlay as { picker: { hint?: string } }).picker.hint ?? '';
    expect(hint).toContain('OpenAI');
    expect(hint).toContain('showing working providers only');
  });

  it('remembers which providers have keys, and keeps them when a later load omits the list', () => {
    const s = send(initialState(), { type: 'modelsLoaded', models: [], providers: ['openrouter'] });
    expect(s.configuredProviders).toEqual(['openrouter']);

    const again = send(s, { type: 'modelsLoaded', models: [] });
    expect(again.configuredProviders).toEqual(['openrouter']);
  });

  it('stores runners and sessions', () => {
    const withRunners = send(initialState(), {
      type: 'runnersLoaded',
      runners: [{ id: 'opencode', name: 'OpenCode', enabled: true }],
      orchestratorModel: 'm/1',
    });
    expect(withRunners.runners).toHaveLength(1);
    expect(withRunners.orchestratorModel).toBe('m/1');

    const withSessions = send(withRunners, {
      type: 'sessionsLoaded',
      sessions: [{ id: 's1', goal: 'g', taskCount: 2, status: 'planned', createdAt: '' }],
    });
    expect(withSessions.sessions).toHaveLength(1);
  });
});

describe('messages from the runtime', () => {
  it('shows a failure as an error turn and clears any spinner', () => {
    const s = send({ ...initialState(), status: 'planning' }, { type: 'failed', message: 'boom' });
    expect(lastMessage(s)).toMatchObject({ role: 'error', text: 'boom' });
    expect(s.status).toBe('idle');
  });

  it('shows a notice as a system turn', () => {
    const s = send(initialState(), { type: 'notice', message: 'Model set to x/y' });
    expect(lastMessage(s)).toMatchObject({ role: 'system', text: 'Model set to x/y' });
  });

  it('shows an error-level notice as an error turn, in red', () => {
    const s = send(initialState(), { type: 'notice', message: 'Failed to start task "t1": boom', level: 'error' });
    expect(lastMessage(s)).toMatchObject({ role: 'error', text: 'Failed to start task "t1": boom' });
  });

  it('records a resize', () => {
    const s = send(initialState(), { type: 'resize', rows: 50, cols: 120 });
    expect([s.rows, s.cols]).toEqual([50, 120]);
  });

  it('forgets a session the daemon never registered', () => {
    const dead = { ...initialState(), sessionId: 'session-dead', goal: 'x', status: 'planning' as const };
    const s = send(dead, { type: 'sessionCleared' });
    expect(s.sessionId).toBeNull();
    expect(s.goal).toBe('');
  });
});
