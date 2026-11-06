import { describe, it, expect, afterEach } from 'vitest';
import { initialState, reduce, type Action, type Effect } from '../reducer';
import { registerSkillCommands } from '../slash';
import type { RunnerView, TaskView, TuiState } from '../state';
import { chatOf, lastMessage, messagesOf } from './chat';

function run(text: string, overrides: Partial<TuiState> = {}) {
  const base = initialState(overrides);
  const state = { ...base, editor: { ...base.editor, text, cursor: text.length } };
  return reduce(state, { type: 'key', key: { name: 'enter' } });
}

const task = (over: Partial<TaskView>): TaskView => ({
  id: 'task-1', order: 1, title: 'Do the thing', type: 'ai', status: 'pending', dependencies: [], attempted: true, ...over,
});

const planned: Partial<TuiState> = {
  sessionId: 'session-1',
  tasks: [task({ id: 'task-a', order: 1 }), task({ id: 'task-b', order: 2, title: 'Second' })],
};

it.each([['/retry 2.1', 'child', 'taskAction'], ['/open #2', 'parent', 'openTaskLog'], ['/skip #2', 'parent', 'taskAction'], ['/retry chi', 'child', 'taskAction']])('resolves %s through the shared task reference grammar', (command, taskId, type) => {
  const tasks = [task({ id: 'parent', order: 2, subtasks: [task({ id: 'child', order: 1 })] })];

  expect(run(command, { sessionId: 'session-1', tasks }).effects).toEqual([
    expect.objectContaining({ type, taskId }),
  ]);
});

describe('retired mode toggles', () => {
  it.each(['/tdd on', '/verify on', '/transport terminal', '/terminal task-a'])('%s is no longer a command and goes to the planner as typed', (line) => {
    expect(run(line).effects).toEqual([{ type: 'startConversation', goal: line }]);
  });
});

describe('retired run-setting and planner-step commands', () => {
  // /settings and /planner are the one place each value is set; the headless
  // CLI keeps the one-value commands for scripts.
  it.each([
    '/auto full', '/supervisor act', '/automerge on', '/autorun on', '/parallel 8',
    '/model', '/model set sonnet', '/planner-effort high',
  ])('%s is no longer a command and goes to the planner as typed', (line) => {
    expect(run(line).effects).toEqual([{ type: 'startConversation', goal: line }]);
  });
});

describe('models and providers', () => {
  it('/planner with no argument opens the planner stepper', () => {
    const { state } = run('/planner');
    expect(state.overlay).toMatchObject({ kind: 'stepper' });
  });

  it('/planner names a runner that runs tasks but cannot plan, rather than calling it unknown', () => {
    const runners: RunnerView[] = [{ id: 'acme', name: 'Acme Agent', enabled: true }];
    const { state, effects } = run('/planner acme', { runners });
    expect(effects).toEqual([]);
    expect(lastMessage(state)).toMatchObject({ role: 'error' });
    expect(JSON.stringify(lastMessage(state))).toContain('Acme Agent runs tasks but cannot plan in Ordewell yet.');
    expect(JSON.stringify(lastMessage(state))).not.toContain('Unknown planner');
  });

  it('/planner says when a shell AI_PROVIDER overrides the planner just chosen', () => {
    const { effects } = run('/planner opencode', { plannerEnvOverride: 'claude-code' });
    expect(effects).toEqual([{
      type: 'setPlanner',
      provider: 'opencode',
      overrideNotice: 'Saved OpenCode as your planner, but AI_PROVIDER=claude-code in this environment takes precedence: unset it to plan with OpenCode.',
    }]);
  });

  it('/planner keeps the plain confirmation when AI_PROVIDER names the planner just chosen', () => {
    expect(run('/planner opencode', { plannerEnvOverride: 'opencode' }).effects).toEqual([{ type: 'setPlanner', provider: 'opencode' }]);
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

describe('login', () => {
  const claude: RunnerView = {
    id: 'claude-code', name: 'Claude Code', enabled: true,
    auth: { state: 'signed-out', loginCommand: ['claude', 'login'] },
  };
  const codex: RunnerView = {
    id: 'codex', name: 'Codex', enabled: true,
    auth: { state: 'signed-out', loginCommand: ['codex', 'login'] },
  };
  const opencode: RunnerView = { id: 'opencode', name: 'OpenCode', enabled: true, auth: { state: 'unknown' } };

  it("signs the active planner in through the command its manifest declares", () => {
    const { state, effects } = run('/login', { plannerProvider: 'claude-code', runners: [claude], runnersKnown: true });

    expect(effects).toEqual([{ type: 'plannerLogin', command: ['claude', 'login'], label: 'Claude Code' }]);
    expect(state.plannerProvider).toBe('claude-code');
  });

  it('signs in a named runner without making it the planner', () => {
    const { state, effects } = run('/login codex', { plannerProvider: 'claude-code', runners: [claude, codex], runnersKnown: true });

    expect(effects).toEqual([{ type: 'plannerLogin', command: ['codex', 'login'], label: 'Codex' }]);
    expect(state.plannerProvider).toBe('claude-code');
  });

  it("signs in a task-only agent through its manifest's login, though no probe can confirm it", () => {
    const copilot: RunnerView = {
      id: 'copilot-cli', name: 'GitHub Copilot CLI', enabled: true,
      auth: { state: 'unknown', loginCommand: ['copilot', 'login'] },
    };
    const { state, effects } = run('/login copilot-cli', { plannerProvider: 'claude-code', runners: [claude, copilot], runnersKnown: true });

    expect(effects).toEqual([{ type: 'plannerLogin', command: ['copilot', 'login'], label: 'GitHub Copilot CLI' }]);
    expect(state.plannerProvider).toBe('claude-code');
  });

  it('matches a named runner by its display label too', () => {
    const { effects } = run('/login Claude Code', { plannerProvider: 'codex', runners: [claude, codex], runnersKnown: true });

    expect(effects).toEqual([{ type: 'plannerLogin', command: ['claude', 'login'], label: 'Claude Code' }]);
  });

  it('offers a signed-in agent its login again, since an explicit /login may re-authenticate', () => {
    const signedIn: RunnerView = { ...claude, auth: { state: 'signed-in', loginCommand: ['claude', 'login'] } };

    expect(run('/login', { plannerProvider: 'claude-code', runners: [signedIn], runnersKnown: true }).effects).toEqual([
      { type: 'plannerLogin', command: ['claude', 'login'], label: 'Claude Code' },
    ]);
  });

  it.each([
    [
      'qwen-code', 'Qwen Code',
      { runner: 'qwen-code', label: 'Qwen Code', key: { provider: 'openrouter' as const, label: 'OpenRouter', others: 'any OpenAI-compatible provider' }, byHand: 'run qwen and sign in there' },
      'Qwen Code has no login Ordewell can run. Run /key and choose OpenRouter (or any OpenAI-compatible provider) to hand it a key, or run qwen and sign in there.',
    ],
    [
      'opencode', 'OpenCode',
      { runner: 'opencode', label: 'OpenCode', byHand: 'run opencode auth login and choose a provider' },
      'OpenCode has no login Ordewell can run. Run opencode auth login and choose a provider.',
    ],
  ])('names the way %s does sign in when Ordewell has no login to run', (id, name, signIn, said) => {
    const row: RunnerView = { id, name, enabled: true, auth: { state: 'signed-out', signIn } };
    const { effects, state } = run(`/login ${id}`, { plannerProvider: 'claude-code', runners: [claude, row], runnersKnown: true });

    expect(effects).toEqual([]);
    expect(lastMessage(state)?.text).toBe(said);
  });

  it('lists the agents that can sign in when the name matches none, and runs nothing', () => {
    const { state, effects } = run('/login nobody', { plannerProvider: 'claude-code', runners: [claude, codex, opencode], runnersKnown: true });

    expect(effects).toEqual([]);
    expect(lastMessage(state)?.text).toContain('claude-code, codex');
  });

  it('says a vendor planner has no coding agent to sign in', () => {
    const { state, effects } = run('/login', { plannerProvider: 'openrouter', runners: [claude], runnersKnown: true });
    expect(effects).toEqual([]);
    expect(lastMessage(state)?.text).toContain('not a coding agent');
  });

  it('says an active planner that is not installed has nothing to sign in', () => {
    const { state, effects } = run('/login', { plannerProvider: 'claude-code', runners: [codex], runnersKnown: true });

    expect(effects).toEqual([]);
    expect(lastMessage(state)?.text).toContain('Claude Code is not installed');
  });

  // Before the daemon answers, an empty runner list is not evidence that the
  // agent is missing: /login would otherwise tell a first-run user to install
  // the agent they already have.
  it('waits for the runner list instead of claiming the active agent is not installed', () => {
    const { state, effects } = run('/login', { plannerProvider: 'claude-code', runners: [], runnersKnown: false });

    expect(effects).toEqual([{ type: 'loadRunners' }]);
    expect(lastMessage(state)?.text).toMatch(/still checking which .* installed/i);
    expect(lastMessage(state)?.text).not.toContain('not installed');
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

describe('runners and mouse', () => {
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

  it('/runners names the way in on each row whose agent is signed out, or whose sign-in nobody could read', () => {
    const { state } = run('/runners', {
      runners: [
        {
          id: 'cursor-agent', name: 'Cursor', enabled: true,
          auth: { state: 'signed-out', loginCommand: ['cursor-agent', 'login'], signIn: { runner: 'cursor-agent', label: 'Cursor', login: ['cursor-agent', 'login'] } },
        },
        {
          id: 'qwen-code', name: 'Qwen Code', enabled: true,
          auth: {
            state: 'signed-out',
            signIn: { runner: 'qwen-code', label: 'Qwen Code', key: { provider: 'openrouter', label: 'OpenRouter', others: 'any OpenAI-compatible provider' }, byHand: 'run qwen and sign in there' },
          },
        },
        { id: 'copilot-cli', name: 'GitHub Copilot CLI', enabled: true, auth: { state: 'unknown', loginCommand: ['copilot', 'login'] } },
        { id: 'codex', name: 'Codex', enabled: true, auth: { state: 'signed-in', loginCommand: ['codex', 'login'] } },
      ],
    });
    const items = state.overlay?.kind === 'picker' ? state.overlay.picker.items : [];
    expect(items).toEqual([
      { id: 'cursor-agent', label: 'Cursor', detail: 'Cursor is not signed in. Sign in with /login cursor-agent, or run cursor-agent login.', warn: true },
      {
        id: 'qwen-code', label: 'Qwen Code', warn: true,
        detail: 'Qwen Code is not signed in. Run /key and choose OpenRouter (or any OpenAI-compatible provider) to hand it a key, or run qwen and sign in there.',
      },
      { id: 'copilot-cli', label: 'GitHub Copilot CLI', detail: 'Sign in with /login copilot-cli, or run copilot login.' },
      { id: 'codex', label: 'Codex' },
    ]);
  });

  it('/runners says why an installed agent cannot start, and will not offer to switch it on', () => {
    const reason = 'GitHub Copilot CLI is too old for Ordewell: found 1.0.104, needs 1.0.105 or later.';
    const { state } = run('/runners', {
      runners: [
        { id: 'claude-code', name: 'Claude Code', enabled: true },
        { id: 'copilot-cli', name: 'GitHub Copilot CLI', enabled: false, usable: false, reason },
      ],
    });

    const items = state.overlay?.kind === 'picker' ? state.overlay.picker.items : [];
    expect(items).toEqual([
      { id: 'claude-code', label: 'Claude Code' },
      { id: 'copilot-cli', label: 'GitHub Copilot CLI', detail: reason, disabled: true },
    ]);
  });

  it('/runners asks the daemon for the saved choice as it opens, since another surface may have changed it', () => {
    const { effects } = run('/runners', { runners: [{ id: 'opencode', name: 'OpenCode', enabled: true }] });
    expect(effects).toEqual([{ type: 'loadRunners' }]);
  });

  it('the saved choice, when it lands, replaces the ticks of a picker the user has not touched', () => {
    const stale = [
      { id: 'opencode', name: 'OpenCode', enabled: true },
      { id: 'codex', name: 'Codex', enabled: false },
    ];
    const opened = run('/runners', { runners: stale }).state;

    const { state } = reduce(opened, { type: 'runnersLoaded', runners: [
      { id: 'opencode', name: 'OpenCode', enabled: true },
      { id: 'codex', name: 'Codex', enabled: true },
    ] });

    expect(state.overlay).toMatchObject({ kind: 'picker', picker: { chosen: ['opencode', 'codex'] } });
  });

  it('keeps what the user has already ticked when the saved choice lands', () => {
    const stale = [
      { id: 'opencode', name: 'OpenCode', enabled: true },
      { id: 'codex', name: 'Codex', enabled: false },
    ];
    const opened = run('/runners', { runners: stale }).state;
    const ticked = reduce(opened, { type: 'key', key: { name: 'char', char: ' ' } }).state;
    const chosenBefore = (ticked.overlay as { picker: { chosen: string[] } }).picker.chosen;
    expect(chosenBefore).not.toEqual(['opencode']);

    const { state } = reduce(ticked, { type: 'runnersLoaded', runners: stale });

    expect(state.overlay).toMatchObject({ kind: 'picker', picker: { chosen: chosenBefore } });
  });

  it('/auto full and /auto guarded are gone; /settings owns the level', () => {
    expect(run('/auto full', { autonomous: false }).effects).toEqual([{ type: 'startConversation', goal: '/auto full' }]);
    expect(run('/auto guarded', { autonomous: true }).effects).toEqual([{ type: 'startConversation', goal: '/auto guarded' }]);
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

  it('/resume opens the same saved-session picker as /sessions', () => {
    const { state, effects } = run('/resume');
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
    expect(run('/stop', { ...planned, planner: 'planning' }).effects).toEqual([
      { type: 'cancelPlanning', sessionId: 'session-1' },
    ]);
  });
});

describe('task control', () => {
  const cases: [string, Effect][] = [
    ['/skip task-a', { type: 'taskAction', sessionId: 'session-1', taskId: 'task-a', action: 'skip' }],
    ['/retry task-a', { type: 'taskAction', sessionId: 'session-1', taskId: 'task-a', action: 'retry', watch: true }],
    ['/cancel task-a', { type: 'taskAction', sessionId: 'session-1', taskId: 'task-a', action: 'cancel' }],
    ['/force-start task-a', { type: 'taskAction', sessionId: 'session-1', taskId: 'task-a', action: 'force-start', watch: true }],
    ['/remove-task task-a', { type: 'removeTask', sessionId: 'session-1', taskId: 'task-a' }],
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
      changes: { assignedModel: expect.objectContaining({ thinkingEffort: 'high' }) },
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

  it('sends an unregistered /name to the planner as typed, without an error', () => {
    const { state, effects } = run('/nonsense');
    expect(effects).toEqual([{ type: 'startConversation', goal: '/nonsense' }]);
    expect(messagesOf(state).some((m) => m.role === 'error')).toBe(false);
  });

  it('never echoes a command into the transcript as a user turn', () => {
    const { state } = run('/help');
    expect(messagesOf(state).some((m) => m.role === 'user')).toBe(false);
  });
});

describe('a runner mode this host cannot run', () => {
  const REASON = "Codex's sandbox cannot start on this host.";
  const codexTask = task({ id: 'task-a', order: 1, assignedRunner: 'codex', taskMode: 'fullAccess' });
  const hosted: Partial<TuiState> = {
    sessionId: 'session-1',
    tasks: [codexTask],
    modesByRunner: {
      codex: [
        { id: 'agent', label: 'Agent', unavailable: REASON },
        { id: 'plan', label: 'Plan', unavailable: REASON },
        { id: 'fullAccess', label: 'Full access', autonomous: true },
      ],
    },
  };

  it('/task-mode refuses it with the reason and sends no edit', () => {
    const { state, effects } = run('/task-mode task-a plan', hosted);

    expect(effects).toEqual([]);
    expect(lastMessage(state)?.text).toContain(REASON);
  });

  it('/task-mode still sets a mode the host can run', () => {
    expect(run('/task-mode task-a fullAccess', hosted).effects).toEqual([expect.objectContaining({ type: 'updateTask', changes: { taskMode: 'fullAccess' } })]);
  });

  it('is listed greyed out in the mode picker, with the one-line notice for the host', () => {
    const { state } = run('/task-mode task-a', hosted);

    expect(state.overlay).toMatchObject({
      kind: 'picker',
      picker: {
        hint: expect.stringContaining('Codex sandbox unavailable on this host: Guarded mode is off'),
        items: [
          expect.objectContaining({ id: 'agent', disabled: true }),
          expect.objectContaining({ id: 'plan', disabled: true }),
          expect.not.objectContaining({ disabled: true }),
        ],
      },
    });
  });
});


describe('/update', () => {
  it.each([
    ['a run is executing', { sessionId: 'session-1', status: 'executing' as const }],
    ['a run is starting', { sessionId: 'session-1', status: 'starting' as const }],
    ['the planner is answering', { sessionId: 'session-1', planner: 'planning' as const }],
  ])('is refused while %s, and nothing runs', (_, overrides) => {
    const { state, effects } = run('/update', overrides);

    expect(effects).toEqual([]);
    expect(state.overlay).toBeNull();
    expect(lastMessage(state)).toMatchObject({ role: 'error' });
    expect(JSON.stringify(lastMessage(state))).toContain('/stop');
  });

  it('otherwise works out how this copy updates before asking anything', () => {
    const { state, effects } = run('/update', { sessionId: 'session-1' });

    expect(effects).toEqual([{ type: 'planUpdate' }]);
    expect(state.overlay).toBeNull();
  });

  const planned = (plan: Extract<Action, { type: 'updatePlanned' }>['plan'], overrides: Partial<TuiState> = {}) =>
    reduce(initialState({ sessionId: 'session-1', ...overrides }), { type: 'updatePlanned', plan });

  it('asks before running the command it names, saying the TUI exits for it', () => {
    const shown = 'brew upgrade ordewell';
    const { state, effects } = planned({ kind: 'run', shown });

    expect(effects).toEqual([]);
    expect(state.overlay).toMatchObject({ kind: 'confirm', action: { kind: 'update' } });
    expect(JSON.stringify(state.overlay)).toContain(shown);
    expect(JSON.stringify(state.overlay)).toContain('exit');
  });

  it('says what would update a copy no command can, and stays open', () => {
    const message = 'This copy runs through npx, so there is no install to update: `npx ordewell@latest` runs the latest. Nothing was run.';
    const { state, effects } = planned({ kind: 'none', message, status: 0 });

    expect(effects).toEqual([]);
    expect(state.overlay).toBeNull();
    expect(state.exiting).toBe(false);
    expect(lastMessage(state)).toMatchObject({ role: 'system' });
    expect(JSON.stringify(lastMessage(state))).toContain('npx ordewell@latest');
  });

  it('shows a copy that cannot replace itself as an error', () => {
    const { state } = planned({ kind: 'none', message: '/usr/local/bin is not writable', status: 1 });

    expect(lastMessage(state)).toMatchObject({ role: 'error' });
  });

  it('asks nothing when a run started while the copy was being looked at', () => {
    const { state } = planned({ kind: 'run', shown: 'brew upgrade ordewell' }, { status: 'executing' });

    expect(state.overlay).toBeNull();
    expect(lastMessage(state)).toMatchObject({ role: 'error' });
  });
});
