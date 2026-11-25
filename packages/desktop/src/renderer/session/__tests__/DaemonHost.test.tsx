import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RUN_SETTINGS_DEFAULTS } from '@ordewell/core';
import type { HostToWebview } from '@ordewell/ui/protocol';
import type { ConfirmationRequest } from '@ordewell/ui/host';
import type { HolderView } from '../../../shared/bridge';
import { DaemonHost, type Confirm, type DaemonHostOptions } from '../DaemonHost';
import { ChatSurface } from '../useSession';
import { fakeDaemon, ok, surfacePlan, surfaceTask } from './fakeDaemon';

const WORKSPACE = '/work/acme';
const PLAN = surfacePlan([
  surfaceTask({ id: 't1', order: 1, title: 'Parse the config', assignedRunner: 'claude-code' }),
  surfaceTask({ id: 't2', order: 2, title: 'Wire the CLI', dependencies: ['t1'] }),
]);

let hosts: DaemonHost[] = [];
afterEach(() => {
  for (const host of hosts) host.dispose();
  hosts = [];
  if (typeof window !== 'undefined' && window.navigator?.userAgent.includes('Electron')) window.localStorage.clear();
});

/** The window's confirm, answered by `answer` with whatever choice it names: a test asks for one it offers. */
function hostWith(answer: (request: ConfirmationRequest<string>) => Promise<string | null> = async () => null, detectionTimeoutMs?: number, watchMs?: number): DaemonHost {
  const ask: Confirm = async <C extends string>(request: ConfirmationRequest<C>) => await answer(request) as C | null;
  const host = new DaemonHost(WORKSPACE, ask, { detectionTimeoutMs, watchMs });
  hosts.push(host);
  return host;
}

/** A host that has opened s1, its first frames delivered and its load read: the daemon's snapshot is the plan's run, nothing started. */
async function opened(daemon: ReturnType<typeof fakeDaemon>, host: DaemonHost): Promise<void> {
  await act(() => host.open('s1'));
  await act(async () => {
    daemon.push('s1', { type: 'connected', sessionId: 's1' }, { type: 'run_snapshot', sessionId: 's1', view: { tasks: PLAN.tasks, runMerge: null, handoff: null, mergeResult: null }, stream: 'd1', seq: 0 });
  });
}

/** Every message a host sends a mounted chat: the place the login and key answers arrive. */
function watch(host: DaemonHost): HostToWebview[] {
  const seen: HostToWebview[] = [];
  host.port('conversation').subscribe((msg) => seen.push(msg));
  return seen;
}

function hostWithOptions(options: DaemonHostOptions, answer: Confirm = async () => null): DaemonHost {
  const host = new DaemonHost(WORKSPACE, answer, options);
  hosts.push(host);
  return host;
}

describe('DaemonHost', () => {
  it('follows a new session on its own socket, and loads nothing for it', () => {
    const daemon = fakeDaemon();
    const host = hostWith();
    expect(daemon.subscribe).toHaveBeenCalledWith(host.sessionId, expect.any(Function));
    expect(daemon.calls('sessions.load')).toEqual([]);
  });

  it('opens a saved session through its lease, and the plan list draws the frames that follow', async () => {
    // The daemon's plan as it stands: a status update cues the list to read it again.
    let plan = PLAN;
    const daemon = fakeDaemon({ 'sessions.load': () => ok({ ok: true, plan, goal: 'Ship the parser' }) });
    const host = hostWith();
    render(<ChatSurface host={host} layout="plan" />);
    await opened(daemon, host);

    expect(daemon.calls('sessions.load')[0]).toEqual([{ id: 's1', workspace: WORKSPACE }, undefined]);
    expect(host.sessionId).toBe('s1');
    expect(host.getSnapshot().goal).toBe('Ship the parser');
    expect(daemon.subscribe).toHaveBeenLastCalledWith('s1', expect.any(Function));
    expect(await screen.findByText('Parse the config')).toBeInTheDocument();
    expect(screen.getByText('Wire the CLI')).toBeInTheDocument();

    plan = surfacePlan([{ ...PLAN.tasks[0]!, status: 'in_progress' }, PLAN.tasks[1]!]);
    await act(async () => {
      daemon.push('s1',
        { type: 'task_started', taskId: 't1', order: 1, title: 'Parse the config', runner: 'claude-code', stream: 'd1', seq: 1 },
        { type: 'status_update', tasks: [{ id: 't1', status: 'in_progress', verdict: null }, { id: 't2', status: 'pending', verdict: null }], stream: 'd1', seq: 2 },
      );
    });
    await waitFor(() => expect(host.getSnapshot().state.run.tasks.find((t) => t.id === 't1')?.status).toBe('in_progress'));
    expect(await screen.findByRole('img', { name: 'Running' })).toBeInTheDocument();
    expect(screen.getAllByRole('img', { name: 'Not started' })).toHaveLength(1);
  });

  it('posts a card\'s command to the daemon route that does it', async () => {
    const daemon = fakeDaemon({ 'sessions.load': ok({ ok: true, plan: surfacePlan(PLAN.tasks, 'draft'), goal: 'Ship the parser' }) });
    const host = hostWith();
    render(<ChatSurface host={host} layout="plan" />);
    await opened(daemon, host);
    await screen.findByText('Parse the config');

    await act(() => host.handle({ type: 'sendSystemCommand', command: 'executePlan' }));
    expect(daemon.calls('plans.execute')).toEqual([[{ sessionId: 's1' }, undefined]]);

    await act(() => host.handle({ type: 'sendSystemCommand', command: 'skip', taskId: 't2' }));
    expect(daemon.calls('plans.executeCommand')).toContainEqual([{ sessionId: 's1' }, { command: 'skip_task', task: 't2' }]);

    await act(() => host.handle({ type: 'resolveApproval', id: 'a1', granted: true }));
    expect(daemon.calls('approvals.decide')).toEqual([[{ sessionId: 's1', approvalId: 'a1' }, { granted: true }]]);
  });

  it('keeps the worktree a run\'s first status reported before its start answered', async () => {
    const worktree = { state: 'active' as const, branch: 'ordewell/r1/1-parse', worktree: '/work/acme/.ordewell/worktrees/r1/1-parse', repos: [] };
    const daemon = fakeDaemon({
      'sessions.load': ok({ ok: true, plan: surfacePlan(PLAN.tasks, 'draft'), goal: 'Ship the parser' }),
      // The socket outruns the call's answer, as it does against a real daemon.
      'plans.execute': () => {
        daemon.push('s1', { type: 'status_update', tasks: [{ id: 't1', status: 'in_progress', verdict: null, isolation: worktree }], stream: 'd1', seq: 1 });
        return ok({ ok: true });
      },
    });
    const host = hostWith();
    await opened(daemon, host);

    await act(() => host.handle({ type: 'sendSystemCommand', command: 'executePlan' }));
    expect(host.getSnapshot().state.run.tasks.find((t) => t.id === 't1')?.isolation).toEqual(worktree);
  });

  it('lists the runners while the model catalog is still being discovered', async () => {
    // A runner CLI slow to list its models holds models.list, never runners.list's answer.
    const daemon = fakeDaemon({
      'runners.list': ok({ runners: [{ id: 'claude-code', name: 'Claude Code', enabled: true }] }),
      'models.list': new Promise<never>(() => undefined),
    });
    const host = hostWith();
    void host.handle({ type: 'ready' });
    await waitFor(() => expect(host.getSnapshot().state.runnersKnown).toBe(true));
    expect(host.getSnapshot().state.enabledRunnerIds).toEqual(['claude-code']);
    expect(daemon.calls('models.list')).toHaveLength(1);
    expect(host.getSnapshot().state.modelDiscovery).toEqual({ state: 'loading' });
  });

  it('reports session opening until the saved session has been adopted', async () => {
    let finish: ((result: ReturnType<typeof ok>) => void) | undefined;
    fakeDaemon({ 'sessions.load': () => new Promise((resolve) => { finish = resolve; }) });
    const host = hostWith();
    const previous = host.sessionId;
    const opening = host.open('saved');
    expect(host.getSnapshot().opening).toBe('saved');
    expect(host.sessionId).toBe(previous);
    await waitFor(() => expect(finish).toBeDefined());
    finish?.(ok({ ok: true, plan: PLAN, goal: 'Ship the parser' }));
    await opening;
    expect(host.sessionId).toBe('saved');
    expect(host.getSnapshot().opening).toBeUndefined();
  });

  it('reports a slow catalog separately from agent detection and retries it', async () => {
    let answer: ReturnType<typeof ok> | Promise<never> = new Promise<never>(() => undefined);
    const daemon = fakeDaemon({
      'runners.list': ok({ runners: [{ id: 'codex', name: 'Codex', enabled: true }] }),
      'settings.get': ok({ aiProvider: 'codex' }),
      'models.list': () => answer,
    });
    const host = hostWith(undefined, 100);
    const first = render(<ChatSurface host={host} layout="conversation" />);
    expect(await screen.findByText('Loading models…')).toBeInTheDocument();
    expect(screen.queryByText(/No models discovered/)).toBeNull();
    await screen.findByText(/Couldn't load models/);
    expect(host.getSnapshot().state.modelDiscovery?.state).toBe('failed');
    expect(host.getSnapshot().state.detectionError).toBeNull();
    // A later mounted pane gets the failure too, rather than returning to an empty picker.
    first.unmount();
    render(<ChatSurface host={host} layout="conversation" />);
    expect(await screen.findByText(/Couldn't load models/)).toBeInTheDocument();
    answer = ok({ models: [], modelsByRunner: { codex: [{ modelId: 'gpt-5', modelLabel: 'GPT-5', variants: [] }] }, modesByRunner: {}, orchestratorModel: '', providers: [], orchestratorModels: [] });
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(host.getSnapshot().state.modelDiscovery?.state).toBe('ready'));
    expect(screen.queryByText(/Couldn't load models|No models discovered/)).toBeNull();
    expect(daemon.calls('models.list')).toHaveLength(2);
  });

  it('keeps a newer catalog pending when an overtaken discovery answers late', async () => {
    const releases: Array<(answer: ReturnType<typeof ok>) => void> = [];
    fakeDaemon({
      'runners.list': ok({ runners: [{ id: 'codex', name: 'Codex', enabled: true }] }),
      'models.list': () => new Promise((resolve) => { releases.push(resolve); }),
    });
    const host = hostWith();
    const first = host.handle({ type: 'ready' });
    const second = host.handle({ type: 'refreshModels' });
    releases[0]!(ok({ models: [], modelsByRunner: {}, modesByRunner: {}, providers: [] }));
    await first;
    expect(host.getSnapshot().state.modelDiscovery?.state).toBe('loading');
    releases[1]!(ok({ models: [], modelsByRunner: {}, modesByRunner: {}, providers: [] }));
    await second;
    expect(host.getSnapshot().state.modelDiscovery?.state).toBe('ready');
  });

  // No API key and a model catalog still being listed: the coding agent the
  // daemon found is who plans, so the chat must not wait on the catalog.
  it('leaves Detecting coding agents for the agents the daemon found, while the model catalog still lists', async () => {
    fakeDaemon({
      'runners.list': ok({ runners: [{ id: 'claude-code', name: 'Claude Code', enabled: true }], orchestratorModel: '' }),
      'models.list': new Promise<never>(() => undefined),
    });
    const host = hostWith();
    render(<ChatSurface host={host} layout="conversation" />);
    await waitFor(() => expect(host.getSnapshot().state.plannerKnown).toBe(true));
    expect(host.getSnapshot().state.planner.backends.filter((b) => b.usable).map((b) => b.runner)).toEqual(['claude-code']);
    expect(screen.queryByText('Detecting coding agents…')).toBeNull();
  });

  it('shows the planner\'s decision record in the planner conversation, and not in the plan panel', async () => {
    const decisionRecord = [{ id: 'D1', kind: 'decision' as const, text: 'Use SQLite', why: 'one file, no server', at: 0, timestamp: '2026-01-01T00:00:00.000Z' }];
    const daemon = fakeDaemon({ 'sessions.load': ok({ ok: true, plan: { ...PLAN, decisionRecord }, goal: 'g' }) });
    const host = hostWith();
    const { container } = render(<><section data-testid="conversation"><ChatSurface host={host} layout="conversation" /></section><section data-testid="plan"><ChatSurface host={host} layout="plan" /></section></>);
    await opened(daemon, host);
    await waitFor(() => expect(screen.getByTestId('conversation').querySelector('.decision-record')?.textContent).toContain('Use SQLite'));
    expect(screen.getByTestId('plan').querySelector('.plan-list')).not.toBeNull();
    expect(screen.getByTestId('plan').querySelector('.decision-record')).toBeNull();
    expect(container.querySelectorAll('.decision-record')).toHaveLength(1);
  });

  it('lists an installed agent the daemon cannot start as unusable, with its reason', async () => {
    const reason = 'GitHub Copilot CLI is too old for Ordewell: found 1.0.104, needs 1.0.105 or later.';
    fakeDaemon({
      'runners.list': ok({
        runners: [
          { id: 'claude-code', name: 'Claude Code', enabled: true },
          { id: 'copilot-cli', name: 'GitHub Copilot CLI', enabled: true, usable: false, reason },
        ],
        orchestratorModel: '',
      }),
      'models.list': ok({ models: [], modelsByRunner: {}, modesByRunner: {}, orchestratorModel: '', providers: [], orchestratorModels: [], providerErrors: {} }),
    });
    const host = hostWith();
    render(<ChatSurface host={host} layout="conversation" />);
    await waitFor(() => expect(host.getSnapshot().state.plannerKnown).toBe(true));

    const copilot = host.getSnapshot().state.planner.backends.find((b) => b.runner === 'copilot-cli');
    expect(copilot).toMatchObject({ kind: 'harness', usable: false, reason });
  });

  it('says detection failed, with a Retry that asks again, when the daemon does not list its agents in time', async () => {
    let listing: Promise<never> | ReturnType<typeof ok> = new Promise<never>(() => undefined);
    const daemon = fakeDaemon({
      'runners.list': () => listing,
      'models.list': ok({ models: [], modelsByRunner: {}, modesByRunner: {}, orchestratorModel: '', providers: [], orchestratorModels: [], providerErrors: {} }),
    });
    const host = hostWith(undefined, 50);
    render(<ChatSurface host={host} layout="conversation" />);
    // The chat body and the Settings panel's planner block both say it.
    const [said] = await screen.findAllByText(/Couldn't detect coding agents/);
    expect(said).toHaveTextContent("Couldn't detect coding agents: the daemon did not list its coding agents");

    listing = ok({ runners: [{ id: 'codex', name: 'Codex', enabled: true }], orchestratorModel: '' });
    fireEvent.click(screen.getAllByRole('button', { name: 'Retry' })[0]!);
    await waitFor(() => expect(host.getSnapshot().state.plannerKnown).toBe(true));
    expect(daemon.calls('runners.list')).toHaveLength(2);
    expect(screen.queryByText(/Couldn't detect coding agents/)).toBeNull();
    expect(screen.queryByText('Detecting coding agents…')).toBeNull();
  });

  it('keeps the agents it detected for a chat that mounts after a held session is opened', async () => {
    const sessionHeld = { holder: { hostId: 'h1', pid: 4242, host: { kind: 'vscode' }, since: '2026-11-03T09:00:00.000Z', heartbeatAt: '2026-11-03T09:00:00.000Z', runnerGroups: [] } };
    fakeDaemon({
      'runners.list': ok({ runners: [{ id: 'claude-code', name: 'Claude Code', enabled: true }], orchestratorModel: '' }),
      'sessions.load': { ok: false, status: 409, error: 'Conflict', data: { ok: false, error: 'held', code: 'session_held', sessionHeld } },
      'sessions.get': ok({ meta: { id: 's1', goal: 'Ship the parser' }, plan: { status: 'approved', tasks: [], conversation: {} } }),
    });
    const host = hostWith();
    const first = render(<ChatSurface host={host} layout="conversation" />);
    await waitFor(() => expect(host.getSnapshot().state.plannerKnown).toBe(true));
    first.unmount();

    await act(() => host.open('s1'));
    expect(host.getSnapshot().readOnly).toBe(true);
    render(<ChatSurface host={host} layout="conversation" />);
    await screen.findByRole('textbox', { name: 'Message the planner' });
    expect(screen.queryByText('Detecting coding agents…')).toBeNull();
    expect(screen.queryByText('Loading…')).toBeNull();
  });

  it('detects again once the daemon is back, when it was away for the first detection', async () => {
    let away = true;
    const daemon = fakeDaemon({
      'runners.list': () => (away
        ? { ok: false, status: 0, error: 'The Ordewell daemon is not reachable.' }
        : ok({ runners: [{ id: 'claude-code', name: 'Claude Code', enabled: true }], orchestratorModel: '' })),
    });
    const host = hostWith();
    render(<ChatSurface host={host} layout="conversation" />);
    await waitFor(() => expect(host.getSnapshot().state.detectionError).toBe('The Ordewell daemon is not reachable.'));

    away = false;
    act(() => daemon.setStatus({ state: 'reconnecting', port: 3700, attempt: 1, canStart: false }));
    act(() => daemon.setStatus(daemon.connected));
    await waitFor(() => expect(host.getSnapshot().state.plannerKnown).toBe(true));
    expect(host.getSnapshot().state.detectionError).toBeNull();
  });

  it('asks before a removal, in ui\'s words, and removes only on a yes', async () => {
    const daemon = fakeDaemon({ 'sessions.load': ok({ ok: true, plan: PLAN, goal: 'g' }) });
    const asked: ConfirmationRequest<string>[] = [];
    let answer: string | null = null;
    const host = hostWith(async (request) => { asked.push(request); return answer; });
    await opened(daemon, host);
    await waitFor(() => expect(host.getSnapshot().state.plan?.tasks).toHaveLength(2));

    await act(() => host.handle({ type: 'removeTask', taskId: 't1' }));
    expect(asked[0]?.message).toMatch(/Parse the config/);
    expect(daemon.calls('plans.deleteTask')).toEqual([]);

    answer = 'remove';
    await act(() => host.handle({ type: 'removeTask', taskId: 't1' }));
    expect(daemon.calls('plans.deleteTask')).toEqual([[{ sessionId: 's1', taskId: 't1' }, undefined]]);
  });

  it('sends a card edit whole to the daemon, whose session holds it to the unstarted precondition', async () => {
    const daemon = fakeDaemon({ 'sessions.load': ok({ ok: true, plan: PLAN, goal: 'g' }), 'plans.cardEdit': ok({ ok: true }) });
    const host = hostWith();
    await opened(daemon, host);
    await waitFor(() => expect(host.getSnapshot().state.plan?.tasks).toHaveLength(2));

    await act(() => host.handle({ type: 'editTask', taskId: 't1', edit: { kind: 'prompt', prompt: 'Do it differently' } }));

    expect(daemon.calls('plans.cardEdit')).toEqual([[{ sessionId: 's1', taskId: 't1' }, { kind: 'prompt', prompt: 'Do it differently' }]]);
    expect(daemon.calls('plans.updateTask')).toEqual([]);
  });

  it('keeps its session when another host holds the one asked for, and says who', async () => {
    const sessionHeld = { holder: { host: { kind: 'vscode', pid: 4242 }, acquiredAt: '2026-11-03T09:00:00.000Z' } };
    const daemon = fakeDaemon({
      'sessions.load': { ok: false, status: 409, error: 'Conflict', data: { ok: false, error: 'This session is open in VS Code.', code: 'session_held', sessionHeld } },
    });
    const host = hostWith();
    const before = host.sessionId;
    await act(() => host.open('s1'));
    expect(host.sessionId).toBe(before);
    expect(host.getSnapshot().held).toEqual(sessionHeld);
    expect(daemon.subscribe).toHaveBeenCalledTimes(1);
  });

  it('sends a card\'s Open chat and a file link to the frame\'s navigator', async () => {
    fakeDaemon();
    const host = hostWith();
    const navigator = { openTask: vi.fn(), openFile: vi.fn(), showPlan: vi.fn() };
    host.setNavigator(navigator);
    await act(() => host.handle({ type: 'openTaskLog', taskId: 't1' }));
    await act(() => host.handle({ type: 'openFile', path: 'src/a.ts' }));
    expect(navigator.openTask).toHaveBeenCalledWith('t1', 'chat');
    expect(navigator.openFile).toHaveBeenCalledWith('src/a.ts');
  });

  it('starts a blank session from New session, on a socket of its own', async () => {
    const daemon = fakeDaemon({ 'sessions.load': ok({ ok: true, plan: PLAN, goal: 'g' }) });
    const host = hostWith();
    render(<ChatSurface host={host} layout="plan" />);
    await opened(daemon, host);
    await screen.findByText('Parse the config');
    act(() => host.newSession());
    expect(host.sessionId).not.toBe('s1');
    expect(daemon.subscribe).toHaveBeenLastCalledWith(host.sessionId, expect.any(Function));
    await waitFor(() => expect(screen.queryByText('Parse the config')).toBeNull());
  });

  it('answers a planner message by starting the planner on the daemon', async () => {
    const daemon = fakeDaemon({ 'plans.converseStart': ok({ ok: true, sessionId: 'p1', turnId: 'turn-1' }) });
    const host = hostWith();
    render(<ChatSurface host={host} layout="conversation" />);
    const box = await screen.findByRole('textbox', { name: 'Message the planner' });
    fireEvent.change(box, { target: { value: 'Add a parser' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(daemon.calls('plans.converseStart')).toHaveLength(1));
    expect(daemon.calls('plans.converseStart')[0]?.[1]).toMatchObject({ goal: 'Add a parser', surface: 'desktop' });
  });

  it('starts the plan on the runners the chat has switched on', async () => {
    const daemon = fakeDaemon({
      'runners.list': ok({ runners: [
        { id: 'claude-code', name: 'Claude Code', enabled: true },
        { id: 'codex', name: 'Codex', enabled: true },
      ], orchestratorModel: '' }),
      'models.list': ok({ models: [], modelsByRunner: {}, modesByRunner: {}, orchestratorModel: '', providers: [], orchestratorModels: [], providerErrors: {} }),
      'settings.get': ok({ orchestratorModel: '', aiProvider: '', plannerThinkingEffort: '', autonomousMode: false, maxParallel: 3, modelAllowlist: {}, run: { ...RUN_SETTINGS_DEFAULTS } }),
      'plans.converseStart': ok({ ok: true, sessionId: 'p1', turnId: 'turn-1' }),
    });
    const host = hostWithOptions({});
    await act(() => host.handle({ type: 'ready' }));

    await act(() => host.handle({ type: 'sendMessage', text: 'Add a parser', runners: ['codex'], typed: true }));

    expect(daemon.calls('plans.converseStart')[0]?.[1]).toMatchObject({ goal: 'Add a parser', runners: ['codex'] });
  });
});

/**
 * A chat is a session from its first message: the daemon saves it as it
 * admits the goal, so the goal is the open session's as the first turn
 * starts, not once the planner has answered, and it stays with a first turn
 * that fails; only a goal refused before any turn starts leaves none.
 */
describe('DaemonHost first message', () => {
  /** A first turn the test holds: the daemon admits it (its start frame) and answers once `finish` or `fail` is called. */
  function heldFirstTurn() {
    let answer: ((result: ReturnType<typeof ok>) => void) | undefined;
    const daemon = fakeDaemon({
      'plans.converseStart': (params) => new Promise((resolve) => {
        answer = resolve;
        const sessionId = (params as { sessionId: string }).sessionId;
        daemon.push(sessionId, { type: 'planner_turn_started', turnId: 'turn-1', prompt: 'Add a parser', startedAt: new Date().toISOString(), sessionId, stream: 'd1', seq: 1 });
      }),
    });
    const host = hostWith();
    const seen = watch(host);
    const sent = host.handle({ type: 'sendMessage', text: 'Add a parser', typed: true });
    const finish = (result: ReturnType<typeof ok>) => {
      answer!(result);
      return sent;
    };
    return { daemon, host, seen, sent, finish };
  }

  it('is the open session\'s goal as soon as its first turn starts, before the planner answers', async () => {
    const { host, daemon, finish } = heldFirstTurn();
    await waitFor(() => expect(daemon.calls('plans.converseStart')).toHaveLength(1));

    await waitFor(() => expect(host.getSnapshot().goal).toBe('Add a parser'));

    await act(() => finish(ok({ plan: surfacePlan([], 'draft') })));
    expect(host.getSnapshot().goal).toBe('Add a parser');
  });

  it('keeps its goal, and reads the session from the daemon after, when the first turn fails once started', async () => {
    const { host, daemon, finish, seen } = heldFirstTurn();
    await waitFor(() => expect(daemon.calls('plans.converseStart')).toHaveLength(1));

    await act(() => finish({ ok: false, status: 500, error: 'Internal Server Error', data: { error: 'the planner crashed' } }));

    expect(host.getSnapshot().goal).toBe('Add a parser');
    expect(seen).toContainEqual(expect.objectContaining({ type: 'showError', error: 'the planner crashed' }));
    // The daemon holds it now: a stop reaches it, as it does for any session but a fresh one.
    await act(() => host.handle({ type: 'stopResearch' }));
    expect(daemon.calls('plans.stopPlanning')).toEqual([[{ sessionId: host.sessionId }, undefined]]);
  });

  it('stops the daemon\'s turn when Stop is pressed during the first turn', async () => {
    const { host, daemon, finish } = heldFirstTurn();
    await waitFor(() => expect(daemon.calls('plans.converseStart')).toHaveLength(1));

    await act(() => host.handle({ type: 'stopResearch' }));

    expect(daemon.calls('plans.stopPlanning')).toEqual([[{ sessionId: host.sessionId }, undefined]]);
    await act(() => finish(ok({ plan: surfacePlan([], 'draft') })));
  });

  it('leaves no goal, and hands the message back, when the planner is not ready', async () => {
    const daemon = fakeDaemon({
      'plans.converseStart': { ok: false, status: 409, error: 'Conflict', data: { error: 'Claude Code is not signed in.', code: 'planner_not_ready' } },
    });
    const host = hostWith();
    const seen = watch(host);

    await act(() => host.handle({ type: 'sendMessage', text: 'Add a parser', typed: true }));

    expect(daemon.calls('plans.converseStart')).toHaveLength(1);
    expect(host.getSnapshot().goal).toBe('');
    expect(seen).toContainEqual({ type: 'promptUnsent', text: 'Add a parser' });
    expect(seen).toContainEqual(expect.objectContaining({ type: 'showError', code: 'planner_not_ready' }));
    // Nothing was sent, so no session holds a turn to stop.
    await act(() => host.handle({ type: 'stopResearch' }));
    expect(daemon.calls('plans.stopPlanning')).toEqual([]);
  });
});

describe('DaemonHost held prompts', () => {
  it('sends a prompt the chat asked to hold once the turn it waited for has already ended', async () => {
    const daemon = fakeDaemon({ 'plans.converseStart': ok({ ok: true, sessionId: 'p1', turnId: 'turn-1' }) });
    const host = hostWith();
    const seen = watch(host);

    await act(() => host.handle({ type: 'holdPrompt', text: 'and add tests' }));

    expect(daemon.calls('plans.converseStart')[0]?.[1]).toMatchObject({ goal: 'and add tests' });
    expect(seen.filter((m) => m.type === 'heldPrompts').at(-1) ?? { prompts: [] }).toMatchObject({ prompts: [] });
  });

  it('sends what was typed during a Retry compaction once the compaction is over', async () => {
    const daemon = fakeDaemon({
      'sessions.load': ok({ ok: true, sessionId: 's1', goal: 'Ship the parser', plan: PLAN }),
      'plans.converseMessage': ok({ plan: PLAN }),
      // The compaction is a planner turn the chat did not send: its frames open and close it while the route runs.
      'plans.retryCompact': async () => {
        daemon.push('s1', { type: 'planner_turn_started', turnId: 'c1', sessionId: 's1', stream: 'd1', seq: 1 });
        await host.handle({ type: 'holdPrompt', text: 'and add tests' });
        daemon.push('s1', { type: 'planner_turn_ended', turnId: 'c1', outcome: 'message', sessionId: 's1', stream: 'd1', seq: 2 });
        return ok({ ok: true });
      },
    });
    const host = hostWith();
    watch(host);
    await opened(daemon, host);

    await act(() => host.handle({ type: 'sendSystemCommand', command: 'retryPlannerCompaction', taskId: '' }));

    expect(daemon.calls('plans.converseMessage')).toEqual([[{ sessionId: 's1' }, { message: 'and add tests', surface: 'desktop' }]]);
  });

  it('sends a held prompt once the turn\'s answer is in, though its ended frame has not come yet', async () => {
    const daemon = fakeDaemon({
      'sessions.load': ok({ ok: true, sessionId: 's1', goal: 'Ship the parser', plan: PLAN }),
      // The socket and the call are two channels: the answer can come first.
      'plans.converseMessage': async (_params, body) => {
        if ((body as { message: string }).message === 'first') {
          daemon.push('s1', { type: 'planner_turn_started', turnId: 'p1', sessionId: 's1', stream: 'd1', seq: 1 });
          await host.handle({ type: 'holdPrompt', text: 'and add tests' });
        }
        return ok({ plan: PLAN });
      },
    });
    const host = hostWith();
    watch(host);
    await opened(daemon, host);

    await act(() => host.handle({ type: 'sendMessage', text: 'first', typed: true }));

    expect(daemon.calls('plans.converseMessage').map(([, body]) => body)).toEqual([{ message: 'first', surface: 'desktop' }, { message: 'and add tests', surface: 'desktop' }]);
  });

  it('sends what was typed during a Retry compaction whose ended frame trails the route\'s answer', async () => {
    const daemon = fakeDaemon({
      'sessions.load': ok({ ok: true, sessionId: 's1', goal: 'Ship the parser', plan: PLAN }),
      'plans.converseMessage': ok({ plan: PLAN }),
      'plans.retryCompact': async () => {
        daemon.push('s1', { type: 'planner_turn_started', turnId: 'c1', sessionId: 's1', stream: 'd1', seq: 1 });
        await host.handle({ type: 'holdPrompt', text: 'and add tests' });
        return ok({ ok: true });
      },
    });
    const host = hostWith();
    watch(host);
    await opened(daemon, host);

    await act(() => host.handle({ type: 'sendSystemCommand', command: 'retryPlannerCompaction', taskId: '' }));
    expect(daemon.calls('plans.converseMessage')).toEqual([]);
    await act(async () => {
      daemon.push('s1', { type: 'planner_turn_ended', turnId: 'c1', outcome: 'message', sessionId: 's1', stream: 'd1', seq: 2 });
    });

    await waitFor(() => expect(daemon.calls('plans.converseMessage')).toEqual([[{ sessionId: 's1' }, { message: 'and add tests', surface: 'desktop' }]]));
  });

  it.each([
    ['the typed text last', 'three', 'one\ntwo\nthree'],
    ['an empty composer', '', 'one\ntwo'],
  ])('sends now everything held, glued in order, with %s, stopping the turn in flight', async (_case, typed, sent) => {
    const daemon = fakeDaemon({
      'sessions.load': ok({ ok: true, sessionId: 's1', goal: 'Ship the parser', plan: PLAN }),
      'plans.converseMessage': async () => {
        daemon.push('s1', { type: 'planner_turn_started', turnId: 'p1', sessionId: 's1', stream: 'd1', seq: 1 });
        await host.handle({ type: 'holdPrompt', text: 'one' });
        await host.handle({ type: 'holdPrompt', text: 'two' });
        await host.handle({ type: 'sendMessageNow', text: typed });
        return ok({ plan: PLAN });
      },
      'plans.converseMessageNow': ok({ plan: PLAN }),
    });
    const host = hostWith();
    const seen = watch(host);
    await opened(daemon, host);

    await act(() => host.handle({ type: 'sendMessage', text: 'first', typed: true }));

    expect(daemon.calls('plans.converseMessageNow').map(([, body]) => body)).toEqual([{ message: sent, surface: 'desktop' }]);
    // Nothing was left held to follow the forced turn.
    expect(daemon.calls('plans.converseMessage').map(([, body]) => body)).toEqual([{ message: 'first', surface: 'desktop' }]);
    expect(seen.filter((m) => m.type === 'heldPrompts').at(-1)).toMatchObject({ prompts: [] });
  });

  it.each([
    ['refused', 'planner_not_ready', ['one\ntwo\nthree']],
    ['stopped', 'planner_turn_stopped', []],
  ])('gives back what a send now took only when its turn was %s', async (_case, code, unsent) => {
    const daemon = fakeDaemon({
      'sessions.load': ok({ ok: true, sessionId: 's1', goal: 'Ship the parser', plan: PLAN }),
      'plans.converseMessage': async () => {
        daemon.push('s1', { type: 'planner_turn_started', turnId: 'p1', sessionId: 's1', stream: 'd1', seq: 1 });
        await host.handle({ type: 'holdPrompt', text: 'one' });
        await host.handle({ type: 'holdPrompt', text: 'two' });
        await host.handle({ type: 'sendMessageNow', text: 'three' });
        return ok({ plan: PLAN });
      },
      'plans.converseMessageNow': { ok: false, status: 409, error: 'refused', data: { error: 'No.', code } },
    });
    const host = hostWith();
    const seen = watch(host);
    await opened(daemon, host);

    await act(() => host.handle({ type: 'sendMessage', text: 'first', typed: true }));

    expect(seen.flatMap((m) => (m.type === 'promptUnsent' ? [m.text] : []))).toEqual(unsent);
    expect(seen.filter((m) => m.type === 'heldPrompts').at(-1)).toMatchObject({ prompts: [] });
  });

  it('sends now with no turn in flight as a plain send', async () => {
    const daemon = fakeDaemon({
      'sessions.load': ok({ ok: true, sessionId: 's1', goal: 'Ship the parser', plan: PLAN }),
      'plans.converseMessage': ok({ plan: PLAN }),
      'plans.converseMessageNow': ok({ plan: PLAN }),
    });
    const host = hostWith();
    watch(host);
    await opened(daemon, host);

    await act(() => host.handle({ type: 'sendMessageNow', text: 'a normal reply' }));
    await act(() => host.handle({ type: 'sendMessageNow', text: '' }));

    expect(daemon.calls('plans.converseMessageNow')).toEqual([]);
    expect(daemon.calls('plans.converseMessage').map(([, body]) => body)).toEqual([{ message: 'a normal reply', surface: 'desktop' }]);
  });

  it('sends everything held as one message once the turn ends', async () => {
    const daemon = fakeDaemon({
      'sessions.load': ok({ ok: true, sessionId: 's1', goal: 'Ship the parser', plan: PLAN }),
      'plans.converseMessage': async (_params, body) => {
        if ((body as { message: string }).message === 'first') {
          daemon.push('s1', { type: 'planner_turn_started', turnId: 'p1', sessionId: 's1', stream: 'd1', seq: 1 });
          await host.handle({ type: 'holdPrompt', text: 'one' });
          await host.handle({ type: 'holdPrompt', text: 'two' });
        }
        return ok({ plan: PLAN });
      },
    });
    const host = hostWith();
    watch(host);
    await opened(daemon, host);

    await act(() => host.handle({ type: 'sendMessage', text: 'first', typed: true }));

    expect(daemon.calls('plans.converseMessage').map(([, body]) => body)).toEqual([{ message: 'first', surface: 'desktop' }, { message: 'one\ntwo', surface: 'desktop' }]);
  });

  it.each([
    [true, ['two', 'one']],
    [false, []],
  ])('takes back the newest held prompt, into the composer only when it was empty (%s)', async (toComposer, unsent) => {
    const daemon = fakeDaemon({
      'sessions.load': ok({ ok: true, sessionId: 's1', goal: 'Ship the parser', plan: PLAN }),
      'plans.converseMessage': async () => {
        daemon.push('s1', { type: 'planner_turn_started', turnId: 'p1', sessionId: 's1', stream: 'd1', seq: 1 });
        await host.handle({ type: 'holdPrompt', text: 'one' });
        await host.handle({ type: 'holdPrompt', text: 'two' });
        await host.handle({ type: 'unsendPrompt', toComposer });
        await host.handle({ type: 'unsendPrompt', toComposer });
        return ok({ plan: PLAN });
      },
    });
    const host = hostWith();
    const seen = watch(host);
    await opened(daemon, host);

    await act(() => host.handle({ type: 'sendMessage', text: 'first', typed: true }));

    expect(seen.flatMap((m) => (m.type === 'promptUnsent' ? [m.text] : []))).toEqual(unsent);
    expect(daemon.calls('plans.converseMessage')).toHaveLength(1);
  });

  it('holds what is typed during the next session\'s turn after a switch overtook a turn of the last one', async () => {
    let finishFirst = (): void => undefined;
    let finishSecond = (): void => undefined;
    const daemon = fakeDaemon({
      'sessions.load': (params) => ok({ ok: true, sessionId: params?.id, goal: 'Ship the parser', plan: PLAN }),
      'plans.converseMessage': (params) => new Promise((resolve) => {
        const done = (): void => resolve(ok({ plan: PLAN }));
        if (params?.sessionId === 's1') finishFirst = done;
        else finishSecond = done;
      }),
    });
    const host = hostWith();
    watch(host);
    await opened(daemon, host);

    let first: Promise<void> = Promise.resolve();
    await act(async () => { first = host.handle({ type: 'sendMessage', text: 'first', typed: true }); });
    await act(() => host.open('s2'));
    await act(async () => { finishFirst(); await first; });

    let second: Promise<void> = Promise.resolve();
    await act(async () => { second = host.handle({ type: 'sendMessage', text: 'second', typed: true }); });
    // Not awaited: a prompt sent at once, rather than held, waits on its own turn.
    await act(async () => { void host.handle({ type: 'sendMessage', text: 'third', typed: true }); });
    expect(daemon.calls('plans.converseMessage').map(([, body]) => body)).toEqual([{ message: 'first', surface: 'desktop' }, { message: 'second', surface: 'desktop' }]);

    // The turn that ends sends the held prompt, and waits on that one's turn in turn.
    await act(async () => { finishSecond(); });
    await waitFor(() => expect(daemon.calls('plans.converseMessage').at(-1)).toEqual([{ sessionId: 's2' }, { message: 'third', surface: 'desktop' }]));
    await act(async () => { finishSecond(); await second; });
  });
});

// A task card's composer offers the commands its runner loaded, and sends a
// picked one as a command rather than as text (#66).
describe('DaemonHost task commands', () => {
  const REVIEW = { name: 'review', description: 'Review the change', kind: 'command' as const };
  const logged = () => ({
    'sessions.load': ok({ ok: true, sessionId: 's1', goal: 'Ship the parser', plan: PLAN }),
    'sessions.taskLog': ok({ attempts: [1, 2] }),
    'sessions.taskLogAttempt': (params?: Record<string, string>) => ok({
      attempt: Number(params?.attempt),
      events: params?.attempt === '2' ? [{ type: 'runner_loaded', commands: [REVIEW], mcpServers: [] }] : [],
    }),
  });

  it('answers a card with the commands its runner loaded in the latest attempt', async () => {
    const daemon = fakeDaemon(logged());
    const host = hostWith();
    const seen = watch(host);
    await opened(daemon, host);

    await act(() => host.handle({ type: 'getTaskCommands', taskId: 't1' }));

    await vi.waitFor(() => expect(seen.filter((m) => m.type === 'taskCommands').at(-1)).toEqual({ type: 'taskCommands', taskId: 't1', commands: [REVIEW] }));
  });

  it('hands a task log tab the sections of a first message whole, for the tab to fold', async () => {
    const first = '## Prior task outputs\nTask 1 added the lexer.\n\nWire the parser in.';
    const brief = 'Wire the parser in.';
    const daemon = fakeDaemon({
      ...logged(),
      'sessions.taskLogAttempt': ok({ attempt: 1, events: [{
        type: 'turn_start', message: first,
        parts: [
          { kind: 'priorOutputs', title: 'Prior task outputs', start: 0, end: first.indexOf('\n\n') },
          { kind: 'brief', title: 'Brief', start: first.indexOf(brief), end: first.length },
        ],
      }] }),
    });
    const host = hostWith();
    await opened(daemon, host);
    const seen: Array<{ type: string; blocks?: unknown[] }> = [];
    host.taskLog('t1').subscribe((msg) => seen.push(msg as { type: string; blocks?: unknown[] }));

    host.taskLog('t1').post({ type: 'ready' });

    await vi.waitFor(() => expect(seen.find((m) => m.type === 'init')).toBeTruthy());
    expect(seen.find((m) => m.type === 'init')?.blocks).toEqual([expect.objectContaining({
      role: 'user', text: brief,
      sections: [{ title: 'Handoffs from earlier tasks', sections: [{ kind: 'priorOutputs', title: 'Prior task outputs', text: 'Task 1 added the lexer.' }] }],
    })]);
  });

  it('tells the cards when a runner loads its commands mid-run', async () => {
    const daemon = fakeDaemon(logged());
    const host = hostWith();
    const seen = watch(host);
    await opened(daemon, host);

    await act(async () => {
      daemon.push('s1', { type: 'task_log', taskId: 't1', attempt: 2, events: [{ type: 'runner_loaded', commands: [REVIEW], mcpServers: [] }], sessionId: 's1', stream: 'd1', seq: 1 });
    });

    await vi.waitFor(() => expect(seen.filter((m) => m.type === 'taskCommands').at(-1)).toEqual({ type: 'taskCommands', taskId: 't1', commands: [REVIEW] }));
  });
});

// The composer suggests every one of these (packages/ui's SLASH_COMMANDS), so
// each must do what it does in the extension and the TUI, not be refused.
describe('DaemonHost slash commands the composer offers', () => {
  const loads = (params?: Record<string, string>) => ok({ ok: true, sessionId: params?.id ?? 's1', goal: 'Ship the parser', plan: PLAN });

  it('condenses the conversation for a typed /compact', async () => {
    const daemon = fakeDaemon({ 'sessions.load': loads, 'plans.compact': ok({ plan: PLAN }) });
    const host = hostWith();
    watch(host);
    await opened(daemon, host);

    await act(() => host.handle({ type: 'sendMessage', text: '/compact', typed: true }));

    expect(daemon.calls('plans.compact').map(([params]) => params)).toEqual([{ sessionId: 's1' }]);
  });

  it('forks the conversation for /fork and follows the fork the daemon adopted', async () => {
    const daemon = fakeDaemon({ 'sessions.load': loads, 'plans.fork': ok({ sessionId: 'f1', goal: 'Ship the parser', plan: PLAN }) });
    const host = hostWith();
    watch(host);
    await opened(daemon, host);

    await act(() => host.handle({ type: 'sendMessage', text: '/fork', typed: true }));

    expect(daemon.calls('plans.fork').map(([params]) => params)).toEqual([{ sessionId: 's1' }]);
    expect(host.sessionId).toBe('f1');
  });

  it('rewinds to the message /rewind names and puts that message back in the composer', async () => {
    const daemon = fakeDaemon({
      'sessions.load': loads,
      'plans.rewind': ok({ sessionId: 'r1', goal: 'Ship the parser', plan: PLAN, rewoundMessage: 'and add tests' }),
    });
    const host = hostWith();
    const seen = watch(host);
    await opened(daemon, host);

    await act(() => host.handle({ type: 'sendMessage', text: '/rewind 2', typed: true }));

    expect(daemon.calls('plans.rewind')).toEqual([[{ sessionId: 's1' }, { index: 2 }]]);
    expect(host.sessionId).toBe('r1');
    expect(seen).toContainEqual(expect.objectContaining({ type: 'promptUnsent', text: 'and add tests' }));
  });

  it('lists what /rewind alone can go back to', async () => {
    const target = { index: 2, preview: 'and add tests', content: 'and add tests', timestamp: '2026-11-06T10:00:00.000Z' };
    const daemon = fakeDaemon({ 'sessions.load': loads, 'plans.rewindTargets': ok({ targets: [target] }) });
    const host = hostWith();
    const seen = watch(host);
    await opened(daemon, host);

    await act(() => host.handle({ type: 'sendMessage', text: '/rewind', typed: true }));

    expect(daemon.calls('plans.rewind')).toEqual([]);
    await vi.waitFor(() => expect(JSON.stringify(seen)).toContain('/rewind 2  and add tests'));
  });

  it('sends a skill\'s slash to the planner, as the extension and the TUI do', async () => {
    const daemon = fakeDaemon({ 'sessions.load': loads, 'plans.converseMessage': ok({ plan: PLAN }) });
    const host = hostWith();
    watch(host);
    await opened(daemon, host);

    await act(() => host.handle({ type: 'sendMessage', text: '/review-pr fix it', typed: true }));

    expect(daemon.calls('plans.converseMessage')).toEqual([[{ sessionId: 's1' }, { message: '/review-pr fix it', surface: 'desktop' }]]);
  });

  it('opens Settings, where the planner and the allowlist are picked, for /planner and /allowlist', async () => {
    fakeDaemon({ 'sessions.load': loads });
    const host = hostWith();
    watch(host);
    const navigator = { openTask: vi.fn(), openFile: vi.fn(), showPlan: vi.fn(), showSettings: vi.fn() };
    host.setNavigator(navigator);

    await act(() => host.handle({ type: 'sendMessage', text: '/planner', typed: true }));
    await act(() => host.handle({ type: 'sendMessage', text: '/allowlist', typed: true }));

    expect(navigator.showSettings).toHaveBeenCalledTimes(2);
  });
});

// A signed-out agent stays listed and is flagged; its own way in is the chat's
// to run, and a key is written through the daemon, never kept here (ADR-0052).
describe('DaemonHost sign-in, keys and planner controls', () => {
  const MODELS = ok({ models: [], modelsByRunner: {}, modesByRunner: {}, orchestratorModel: '', providers: [], orchestratorModels: [], providerErrors: {} });
  const SETTINGS = {
    orchestratorModel: 'gpt-5',
    aiProvider: 'codex',
    plannerThinkingEffort: '',
    autonomousMode: false,
    maxParallel: 3,
    modelAllowlist: {},
    run: { ...RUN_SETTINGS_DEFAULTS },
  };
  const codex = (state: 'signed-out' | 'signed-in') => ({
    id: 'codex', name: 'Codex', enabled: true,
    auth: { state, loginCommand: ['codex', 'login'], signIn: { runner: 'codex', label: 'Codex', login: ['codex', 'login'] } },
  });

  it('reads the open session\'s settings, so the Run block shows its values and not the file\'s', async () => {
    const daemon = fakeDaemon({
      'runners.list': ok({ runners: [], orchestratorModel: '' }),
      'models.list': MODELS,
      'settings.get': ok(SETTINGS),
    });
    const host = hostWithOptions({});
    await act(() => host.handle({ type: 'ready' }));

    expect(daemon.calls('settings.get')[0]?.[0]).toEqual({ workspace: WORKSPACE, sessionId: host.sessionId });
  });

  it('sends the workspace\'s skills on ready: user-invocable ones to type, task skills to the cards', async () => {
    const daemon = fakeDaemon({
      'runners.list': ok({ runners: [], orchestratorModel: '' }),
      'models.list': MODELS,
      'settings.get': ok(SETTINGS),
      'skills.list': ok({ skills: [
        { name: 'review-pr', description: 'Review a PR', appliesTo: 'planner', userInvocable: true },
        { name: 'hidden', description: 'Model only', appliesTo: 'planner', userInvocable: false },
        { name: 'tdd', description: 'Test first', appliesTo: 'task', userInvocable: false },
      ] }),
    });
    const host = hostWithOptions({});
    const seen = watch(host);
    await act(() => host.handle({ type: 'ready' }));

    expect(daemon.calls('skills.list')[0]?.[0]).toEqual({ workspace: WORKSPACE });
    expect(seen.filter((m) => m.type === 'setSkills').at(-1)).toEqual({
      type: 'setSkills', skills: [{ name: 'review-pr', description: 'Review a PR', appliesTo: 'planner' }],
    });
    expect(seen.filter((m) => m.type === 'setTaskSkills').at(-1)).toEqual({
      type: 'setTaskSkills', skills: [{ name: 'tdd', description: 'Test first' }],
    });
  });

  it('names the coding agent behind a harness planner, so the chat lists that agent\'s models', async () => {
    const model = { modelId: 'sonnet', modelLabel: 'Sonnet', variants: [{ id: 'high', label: 'High' }] };
    fakeDaemon({
      'runners.list': ok({ runners: [{ id: 'claude-code', name: 'Claude Code', enabled: true }], orchestratorModel: '' }),
      'models.list': ok({
        models: [model], modelsByRunner: { 'claude-code': [model] }, modesByRunner: {},
        orchestratorModel: 'sonnet', providers: [], orchestratorModels: [], providerErrors: {},
      }),
      'settings.get': ok({ ...SETTINGS, aiProvider: 'claude-code', orchestratorModel: 'sonnet', plannerThinkingEffort: 'high' }),
    });
    const host = hostWithOptions({});
    const seen = watch(host);
    await act(() => host.handle({ type: 'ready' }));

    const planner = seen.filter((m) => m.type === 'setPlannerBackends').at(-1);
    expect(planner).toMatchObject({ provider: 'claude-code', runner: 'claude-code', effort: 'high' });
    expect(host.getSnapshot().state.modelsByRunner['claude-code']).toEqual([model]);
  });

  // The daemon names a found key its detected agent plans past (ADR-0076); the chat's first screen says so.
  it('passes on the key the detected agent plans past, so the first screen can say who plans and why', async () => {
    fakeDaemon({
      'runners.list': ok({ runners: [{ id: 'claude-code', name: 'Claude Code', enabled: true }], orchestratorModel: '' }),
      'models.list': MODELS,
      'settings.get': ok({ ...SETTINGS, aiProvider: 'claude-code', orchestratorModel: '', unusedPlanningKey: 'openai' }),
    });
    const host = hostWithOptions({});
    const seen = watch(host);
    await act(() => host.handle({ type: 'ready' }));

    expect(seen.filter((m) => m.type === 'setPlannerBackends').at(-1)).toMatchObject({ provider: 'claude-code', unusedPlanningKey: 'openai' });
  });

  it('sends no runner when a vendor plans, so its vendor catalog is offered', async () => {
    fakeDaemon({
      'runners.list': ok({ runners: [], orchestratorModel: '' }),
      'models.list': MODELS,
      'settings.get': ok({ ...SETTINGS, aiProvider: 'openrouter' }),
    });
    const host = hostWithOptions({});
    const seen = watch(host);
    await act(() => host.handle({ type: 'ready' }));

    const planner = seen.filter((m) => m.type === 'setPlannerBackends').at(-1);
    expect(planner).toMatchObject({ provider: 'openrouter' });
    expect(planner && 'runner' in planner ? planner.runner : undefined).toBeUndefined();
  });

  it('follows the chosen agent after its model and effort are picked', async () => {
    let settings = { ...SETTINGS, aiProvider: 'claude-code', orchestratorModel: 'sonnet', plannerThinkingEffort: '' };
    fakeDaemon({
      'runners.list': ok({ runners: [{ id: 'claude-code', name: 'Claude Code', enabled: true }], orchestratorModel: '' }),
      'models.list': () => ok({
        models: [], modelsByRunner: {}, modesByRunner: {},
        orchestratorModel: settings.orchestratorModel, providers: [], orchestratorModels: [], providerErrors: {},
      }),
      'settings.get': () => ok({ ...settings }),
      'settings.update': (_params, body) => {
        const change = body as { orchestratorModel?: string; plannerThinkingEffort?: string };
        settings = {
          ...settings,
          ...(change.orchestratorModel !== undefined ? { orchestratorModel: change.orchestratorModel } : {}),
          ...(change.plannerThinkingEffort !== undefined ? { plannerThinkingEffort: change.plannerThinkingEffort } : {}),
        };
        return ok({ ...settings });
      },
    });
    const host = hostWithOptions({});
    const seen = watch(host);
    await act(() => host.handle({ type: 'ready' }));

    await act(() => host.handle({ type: 'setPlannerModel', modelId: 'opus', effort: 'high' }));

    expect(seen.filter((m) => m.type === 'setPlannerBackends').at(-1)).toMatchObject({ runner: 'claude-code', effort: 'high' });
    expect(seen.filter((m) => m.type === 'setModelConfig').at(-1)).toMatchObject({ modelConfig: { orchestrator: 'opus' } });
  });

  it('follows the planner the chat switches to, runner and all', async () => {
    let provider = 'openrouter';
    fakeDaemon({
      'runners.list': ok({ runners: [{ id: 'claude-code', name: 'Claude Code', enabled: true }], orchestratorModel: '' }),
      'models.list': MODELS,
      'settings.get': () => ok({ ...SETTINGS, aiProvider: provider }),
      'settings.update': (_params, body) => {
        const env = (body as { env?: Record<string, string> }).env;
        if (env?.AI_PROVIDER) provider = env.AI_PROVIDER;
        return ok({ ...SETTINGS, aiProvider: provider });
      },
    });
    const host = hostWithOptions({});
    const seen = watch(host);
    await act(() => host.handle({ type: 'ready' }));

    await act(() => host.handle({ type: 'setPlanner', provider: 'claude-code', requestId: 'r1' }));
    expect(seen.filter((m) => m.type === 'setPlannerBackends').at(-1)).toMatchObject({ provider: 'claude-code', runner: 'claude-code' });

    await act(() => host.handle({ type: 'setPlanner', provider: 'openrouter', requestId: 'r2' }));
    const vendor = seen.filter((m) => m.type === 'setPlannerBackends').at(-1);
    expect(vendor).toMatchObject({ provider: 'openrouter' });
    expect(vendor && 'runner' in vendor ? vendor.runner : undefined).toBeUndefined();
  });

  it('offers the vendor planner its discovered model options', async () => {
    fakeDaemon({
      'runners.list': ok({ runners: [], orchestratorModel: '' }),
      'models.list': ok({
        models: [], modelsByRunner: {}, modesByRunner: {},
        orchestratorModel: 'mock/model', providers: ['openrouter'], providerErrors: {},
        orchestratorModels: [{ id: 'mock/model', label: 'Mock Model', provider: 'mock', apiProvider: 'openrouter' }],
      }),
      'settings.get': ok({ ...SETTINGS, aiProvider: 'openrouter', orchestratorModel: 'mock/model' }),
    });
    const host = hostWithOptions({});
    const seen = watch(host);
    await act(() => host.handle({ type: 'ready' }));

    expect(seen.filter((m) => m.type === 'setModelOptions').at(-1)).toMatchObject({
      modelOptions: [{ id: 'mock/model', label: 'Mock Model', apiProvider: 'openrouter' }],
    });
  });

  it('sends the per-runner model allowlist the task cards filter by', async () => {
    fakeDaemon({
      'runners.list': ok({ runners: [{ id: 'codex', name: 'Codex', enabled: true }], orchestratorModel: '' }),
      'models.list': MODELS,
      'settings.get': ok({ ...SETTINGS, modelAllowlist: { codex: ['gpt-5'] } }),
    });
    const host = hostWithOptions({});
    const seen = watch(host);
    await act(() => host.handle({ type: 'ready' }));

    expect(seen.filter((m) => m.type === 'setModelAllowlist').at(-1)).toEqual({ type: 'setModelAllowlist', allowlist: { codex: ['gpt-5'] } });
  });

  it('gives a chat that mounts after detection the allowlist, model options and Run settings the first one got', async () => {
    fakeDaemon({
      'runners.list': ok({ runners: [{ id: 'codex', name: 'Codex', enabled: true }], orchestratorModel: '' }),
      'models.list': ok({
        models: [], modelsByRunner: {}, modesByRunner: {},
        orchestratorModel: 'mock/model', providers: ['openrouter'], providerErrors: {},
        orchestratorModels: [{ id: 'mock/model', label: 'Mock Model', provider: 'mock', apiProvider: 'openrouter' }],
      }),
      'settings.get': ok({ ...SETTINGS, aiProvider: 'openrouter', orchestratorModel: 'mock/model', autonomousMode: true, modelAllowlist: { codex: ['gpt-5'] } }),
    });
    const host = hostWithOptions({});
    watch(host);
    await act(() => host.handle({ type: 'ready' }));

    const later: HostToWebview[] = [];
    const port = host.port('plan');
    port.subscribe((msg) => later.push(msg));
    await act(() => port.post({ type: 'ready' }));

    expect(later).toContainEqual({ type: 'setModelAllowlist', allowlist: { codex: ['gpt-5'] } });
    expect(later.find((m) => m.type === 'setModelOptions')).toMatchObject({ modelOptions: [{ id: 'mock/model', apiProvider: 'openrouter' }] });
    expect(later.find((m) => m.type === 'setRunSettings')).toMatchObject({ autonomous: true, maxParallel: 3 });
  });

  it('shows the workspace isolation preview the startup view and approval card draw', async () => {
    const preview = { status: 'ready' as const, repos: [{ path: '.', top: false }], shared: [] };
    fakeDaemon({
      'runners.list': ok({ runners: [], orchestratorModel: '' }),
      'models.list': MODELS,
      'settings.get': ok(SETTINGS),
      'workspaces.isolationPreview': ok({ preview }),
    });
    const host = hostWithOptions({});
    const seen = watch(host);
    await act(() => host.handle({ type: 'ready' }));

    await waitFor(() => expect(seen).toContainEqual({ type: 'isolationPreview', preview }));
  });

  it('says what the daemon said when Merge all finds nothing left to merge', async () => {
    const message = 'This run is already merged and closed: there is nothing to merge.';
    const daemon = fakeDaemon({ 'sessions.load': ok({ ok: true, plan: PLAN, goal: 'g' }), 'plans.isolationMerge': ok({ outcome: 'nothing', message }) });
    const host = hostWith(async (request) => request.choices[0]!.id);
    await opened(daemon, host);
    const seen = watch(host);
    await act(() => host.handle({ type: 'isolationAction', action: 'merge' }));
    expect(daemon.calls('plans.isolationMerge')).toHaveLength(1);
    await waitFor(() => expect(JSON.stringify(seen)).toContain(message));
  });

  it('opens the chat\'s settings panel on /settings', async () => {
    const daemon = fakeDaemon();
    const host = hostWithOptions({});
    const seen = watch(host);
    await act(() => host.handle({ type: 'sendMessage', text: '/settings', typed: true }));

    expect(seen).toContainEqual({ type: 'openSettings' });
    expect(daemon.calls('plans.converseStart')).toEqual([]);
  });

  it('remembers the plan dock height across chat instances', async () => {
    fakeDaemon({
      'runners.list': ok({ runners: [], orchestratorModel: '' }),
      'models.list': MODELS,
      'settings.get': ok(SETTINGS),
    });
    const host = hostWithOptions({});
    await act(() => host.handle({ type: 'setPlanDockHeight', height: 321 }));

    const seen = watch(host);
    await act(() => host.handle({ type: 'ready' }));

    await waitFor(() => expect(seen).toContainEqual({ type: 'planDockHeight', height: 321 }));
  });

  it('opens a signed-out agent\'s login terminal, polls its own status, and clears the pending state', async () => {
    let listed = 0;
    const daemon = fakeDaemon({
      'runners.list': () => {
        listed += 1;
        return ok({ runners: [codex(listed >= 2 ? 'signed-in' : 'signed-out')], orchestratorModel: '' });
      },
      'models.list': MODELS,
      'settings.get': ok(SETTINGS),
    });
    const ended = new Promise<void>(() => undefined);
    const openLogin = vi.fn(async () => ({ ended }));
    const host = hostWithOptions({ openLogin, pollMs: 1, sleep: async () => undefined });
    const seen = watch(host);
    await act(() => host.handle({ type: 'ready' }));

    await act(() => host.handle({ type: 'loginPlanner', runner: 'codex' }));

    expect(openLogin).toHaveBeenCalledWith('codex', 'Codex');
    expect(seen).toContainEqual({ type: 'plannerLoginEnded', runner: 'codex', ok: true });
    // The probe the login changed is re-read before the surface is told.
    expect(daemon.calls('runners.list').length).toBeGreaterThanOrEqual(3);
  });

  it('ends a login that times out, saying so', async () => {
    fakeDaemon({
      'runners.list': ok({ runners: [codex('signed-out')], orchestratorModel: '' }),
      'models.list': MODELS,
      'settings.get': ok(SETTINGS),
    });
    const openLogin = vi.fn(async () => ({ ended: new Promise<void>(() => undefined) }));
    const host = hostWithOptions({ openLogin, loginTimeoutMs: 0 });
    const seen = watch(host);
    await act(() => host.handle({ type: 'ready' }));

    await act(() => host.handle({ type: 'loginPlanner', runner: 'codex' }));

    expect(seen).toContainEqual({ type: 'plannerLoginEnded', runner: 'codex', ok: false, message: 'Sign-in did not finish in time.' });
  });

  it('ends a login when its terminal closes, without asking again', async () => {
    const daemon = fakeDaemon({
      'runners.list': ok({ runners: [codex('signed-out')], orchestratorModel: '' }),
      'models.list': MODELS,
      'settings.get': ok(SETTINGS),
    });
    const openLogin = vi.fn(async () => ({ ended: Promise.resolve() }));
    const host = hostWithOptions({ openLogin, pollMs: 60_000 });
    const seen = watch(host);
    await act(() => host.handle({ type: 'ready' }));
    const reads = daemon.calls('runners.list').length;

    await act(() => host.handle({ type: 'loginPlanner', runner: 'codex' }));

    expect(seen).toContainEqual({ type: 'plannerLoginEnded', runner: 'codex', ok: false, message: 'The terminal closed before sign-in finished.' });
    expect(daemon.calls('runners.list')).toHaveLength(reads);
  });

  it('says when the login terminal cannot be opened, still clearing the pending state', async () => {
    fakeDaemon({
      'runners.list': ok({ runners: [codex('signed-out')], orchestratorModel: '' }),
      'models.list': MODELS,
      'settings.get': ok(SETTINGS),
    });
    const host = hostWithOptions({ openLogin: async () => { throw new Error('no terminal here'); } });
    const seen = watch(host);
    await act(() => host.handle({ type: 'ready' }));

    await act(() => host.handle({ type: 'loginPlanner', runner: 'codex' }));

    expect(seen).toContainEqual({ type: 'plannerLoginEnded', runner: 'codex', ok: false, message: 'The login terminal could not be opened. no terminal here' });
  });

  it('sends a key-based agent\'s Log in to the key entry instead of a terminal', async () => {
    fakeDaemon({
      'runners.list': ok({
        runners: [{ id: 'gemini-cli', name: 'Gemini CLI', enabled: true, auth: { state: 'signed-out', signIn: { runner: 'gemini-cli', label: 'Gemini CLI', key: { provider: 'google', label: 'Google Gemini' } } } }],
        orchestratorModel: '',
      }),
      'models.list': MODELS,
      'settings.get': ok({ ...SETTINGS, aiProvider: 'gemini-cli' }),
    });
    const askForKey = vi.fn(async () => null);
    const openLogin = vi.fn();
    const host = hostWithOptions({ askForKey, openLogin });
    const seen = watch(host);
    await act(() => host.handle({ type: 'ready' }));

    await act(() => host.handle({ type: 'loginPlanner', runner: 'gemini-cli' }));

    expect(askForKey).toHaveBeenCalledWith({ provider: 'google', runnerLabel: 'Gemini CLI' });
    expect(openLogin).not.toHaveBeenCalled();
    expect(seen).toContainEqual({ type: 'plannerLoginEnded', runner: 'gemini-cli', ok: false, message: 'The key was not saved.' });
  });

  it('writes a key through the daemon\'s settings route and keeps it out of every state and log', async () => {
    const daemon = fakeDaemon({
      'runners.list': ok({ runners: [], orchestratorModel: '' }),
      'models.list': MODELS,
      'settings.get': ok(SETTINGS),
      'settings.update': ok({ ...SETTINGS }),
    });
    const key = 'sk-live-SECRET-123';
    const host = hostWithOptions({ askForKey: async () => ({ provider: 'google', key }) });
    const seen = watch(host);
    const logged = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) => vi.spyOn(console, level).mockImplementation(() => undefined));
    await act(() => host.handle({ type: 'ready' }));

    await act(() => host.handle({ type: 'sendMessage', text: '/key google', typed: false }));

    expect(daemon.calls('settings.update')).toContainEqual([undefined, expect.objectContaining({ env: { GEMINI_API_KEY: key }, workspace: WORKSPACE })]);
    expect(JSON.stringify(host.getSnapshot())).not.toContain(key);
    expect(JSON.stringify(seen)).not.toContain(key);
    expect(logged.every((spy) => spy.mock.calls.every((call) => !call.some((arg) => String(arg).includes(key))))).toBe(true);
    logged.forEach((spy) => spy.mockRestore());
  });

  // Bug: Custom's key was saved alone, and Custom is set up by its endpoint, so no Custom planner or runner appeared.
  // Bug: saved with no key, Custom kept the key set before, which was then sent to the new endpoint.
  it('writes Custom\'s endpoint through the same settings route, with its key, or an empty one that takes the old key away', async () => {
    const daemon = fakeDaemon({
      'runners.list': ok({ runners: [], orchestratorModel: '' }),
      'models.list': MODELS,
      'settings.get': ok(SETTINGS),
      'settings.update': ok({ ...SETTINGS }),
    });
    const answers = [
      { provider: 'openai_compatible' as const, key: 'sk-local', baseUrl: 'http://localhost:8000/v1' },
      { provider: 'openai_compatible' as const, key: '', baseUrl: 'http://localhost:11434/v1' },
    ];
    const host = hostWithOptions({ askForKey: async () => answers.shift() ?? null });
    watch(host);
    await act(() => host.handle({ type: 'ready' }));

    await act(async () => { await host.enterApiKey('openai_compatible'); });
    await act(async () => { await host.enterApiKey('openai_compatible'); });

    const envs = daemon.calls('settings.update').map(([, body]) => (body as { env?: unknown }).env);
    expect(envs).toEqual([
      { OPENAI_COMPATIBLE_BASE_URL: 'http://localhost:8000/v1', OPENAI_COMPATIBLE_API_KEY: 'sk-local' },
      { OPENAI_COMPATIBLE_BASE_URL: 'http://localhost:11434/v1', OPENAI_COMPATIBLE_API_KEY: '' },
    ]);
  });

  // Bug: a key the daemon could not write to ~/.ordewell/.env read as saved, and was gone after the next restart.
  it('says so when the daemon took the key but could not save it', async () => {
    fakeDaemon({
      'runners.list': ok({ runners: [], orchestratorModel: '' }),
      'models.list': MODELS,
      'settings.get': ok(SETTINGS),
      'settings.update': ok({ ...SETTINGS, unsavedEnvKeys: ['GEMINI_API_KEY'] }),
    });
    const host = hostWithOptions({ askForKey: async () => ({ provider: 'google', key: 'g-key' }) });
    const seen = watch(host);
    await act(() => host.handle({ type: 'ready' }));

    let entered = false;
    await act(async () => { entered = await host.enterApiKey('google'); });

    expect(entered).toBe(true);
    // The note reaches the chat with the conversation's next flush.
    await vi.waitFor(() => expect(JSON.stringify(seen)).toContain('The Google Gemini key is in use, but it could not be saved to ~/.ordewell/.env: once Ordewell restarts, set it again.'));
    expect(seen.some((msg) => msg.type === 'showError')).toBe(false);
  });

  it('opens the key entry for /key-set, and for /key and its old `/key set` alike', async () => {
    fakeDaemon({
      'runners.list': ok({ runners: [], orchestratorModel: '' }),
      'models.list': MODELS,
      'settings.get': ok(SETTINGS),
    });
    const askForKey = vi.fn(async () => null);
    const host = hostWithOptions({ askForKey });
    await act(() => host.handle({ type: 'ready' }));

    // In any case, as the terminal UI and the extension read either word.
    for (const text of ['/key-set openrouter', '/key openrouter', '/key set openrouter', '/key-set set openrouter', '/key-set OpenRouter', '/key SET openrouter']) {
      askForKey.mockClear();
      await act(() => host.handle({ type: 'sendMessage', text, typed: true }));
      expect(askForKey, text).toHaveBeenCalledWith({ provider: 'openrouter' });
    }
    askForKey.mockClear();
    await act(() => host.handle({ type: 'sendMessage', text: '/key-set', typed: true }));
    // No provider named: the entry asks which one, every provider offered.
    expect(askForKey).toHaveBeenCalledWith({});
  });

  it('names /key-set when the provider asked for is not one', async () => {
    fakeDaemon({
      'runners.list': ok({ runners: [], orchestratorModel: '' }),
      'models.list': MODELS,
      'settings.get': ok(SETTINGS),
    });
    const askForKey = vi.fn(async () => null);
    const host = hostWithOptions({ askForKey });
    const seen = watch(host);
    await act(() => host.handle({ type: 'ready' }));

    await act(() => host.handle({ type: 'sendMessage', text: '/key-set nobody', typed: true }));

    expect(askForKey).not.toHaveBeenCalled();
    expect(JSON.stringify(seen)).toContain('Unknown provider: nobody. Run /key-set with no provider to see the list.');
  });

  it('offers a provider runner as a runner only: the planner of that name is the vendor\'s, with no login (ADR-0070)', async () => {
    fakeDaemon({
      'runners.list': ok({
        runners: [
          { id: 'claude-code', name: 'Claude Code', enabled: true, auth: { state: 'signed-in' }, plans: true },
          { id: 'openrouter', name: 'OpenRouter', enabled: true, auth: { state: 'signed-in' }, plans: false, provider: 'openrouter' },
          // A runner the daemon says cannot plan (one a workspace manifest adds) is no harness planner either.
          { id: 'acme', name: 'Acme', enabled: true, plans: false },
          { id: 'later-agent', name: 'Later Agent', enabled: true, plans: true },
        ],
        orchestratorModel: '',
      }),
      'models.list': ok({ models: [], modelsByRunner: {}, modesByRunner: {}, orchestratorModel: '', providers: ['openrouter'], orchestratorModels: [], providerErrors: {} }),
      'settings.get': ok({ ...SETTINGS, aiProvider: 'openrouter' }),
    });
    const askForKey = vi.fn(async () => null);
    const openLogin = vi.fn();
    const host = hostWithOptions({ askForKey, openLogin });
    const seen = watch(host);
    await act(() => host.handle({ type: 'ready' }));

    const { backends } = host.getSnapshot().state.planner;
    expect(backends.filter((b) => b.id === 'openrouter')).toEqual([expect.objectContaining({ kind: 'vendor', label: 'OpenRouter' })]);
    expect(backends.some((b) => b.id === 'acme')).toBe(false);
    expect(backends.find((b) => b.id === 'later-agent')).toMatchObject({ kind: 'harness', runner: 'later-agent' });
    expect(host.getSnapshot().state.runnerList.map((r) => r.displayName)).toContain('OpenRouter');

    await act(() => host.handle({ type: 'sendMessage', text: '/login openrouter', typed: true }));
    expect(openLogin).not.toHaveBeenCalled();
    expect(askForKey).not.toHaveBeenCalled();
    expect(seen).toContainEqual({
      type: 'plannerLoginEnded', runner: 'openrouter', ok: false,
      message: 'OpenRouter has no login: it runs on its API key, which /key-set openrouter replaces.',
    });
  });

  // Bug: with no vendor planner listed yet (the catalog unsettled, or failed), /login on a listed provider runner said it was an unknown coding agent.
  it('answers /login on a provider runner by its key even while no vendor planner is listed', async () => {
    fakeDaemon({
      'runners.list': ok({
        runners: [{ id: 'openrouter', name: 'OpenRouter', enabled: true, auth: { state: 'signed-in' }, plans: false, provider: 'openrouter' }],
        orchestratorModel: '',
      }),
      'models.list': ok({ models: [], modelsByRunner: {}, modesByRunner: {}, orchestratorModel: '', providers: [], orchestratorModels: [], providerErrors: {} }),
      'settings.get': ok(SETTINGS),
    });
    const openLogin = vi.fn();
    const host = hostWithOptions({ openLogin });
    const seen = watch(host);
    await act(() => host.handle({ type: 'ready' }));
    expect(host.getSnapshot().state.planner.backends.some((b) => b.kind === 'vendor')).toBe(false);

    const message = 'OpenRouter has no login: it runs on its API key, which /key-set openrouter replaces.';
    for (const text of ['/login openrouter', '/login OpenRouter']) {
      seen.length = 0;
      await act(() => host.handle({ type: 'sendMessage', text, typed: true }));
      expect(seen, text).toContainEqual({ type: 'plannerLoginEnded', runner: 'openrouter', ok: false, message });
    }
    // The pill's Log in names the runner by id, through the message path.
    seen.length = 0;
    await act(() => host.handle({ type: 'loginPlanner', runner: 'openrouter' }));
    expect(seen).toContainEqual({ type: 'plannerLoginEnded', runner: 'openrouter', ok: false, message });
    // Custom is reached at its endpoint, which may take no key at all.
    seen.length = 0;
    await act(() => host.handle({ type: 'sendMessage', text: '/login custom', typed: true }));
    expect(seen).toContainEqual({
      type: 'plannerLoginEnded', runner: 'openai_compatible', ok: false,
      message: 'Custom has no login: it runs on the endpoint OPENAI_COMPATIBLE_BASE_URL names, which /key-set openai_compatible replaces.',
    });
    expect(openLogin).not.toHaveBeenCalled();
  });

  it('never sends a button\'s unknown slash command to the planner as a goal', async () => {
    const daemon = fakeDaemon();
    const host = hostWithOptions({});
    watch(host);
    await act(() => host.handle({ type: 'ready' }));

    await act(() => host.handle({ type: 'sendMessage', text: '/bogus now', typed: false }));
    await act(() => host.handle({ type: 'sendMessage', text: '/sessions', typed: false }));

    expect(daemon.calls('plans.converseStart')).toEqual([]);
    expect(daemon.calls('plans.converseMessage')).toEqual([]);
  });

  it('saves a planner pick through the shared settings and re-detects', async () => {
    const daemon = fakeDaemon({
      'runners.list': ok({ runners: [], orchestratorModel: '' }),
      'models.list': MODELS,
      'settings.get': ok(SETTINGS),
      'settings.update': ok({ ...SETTINGS, aiProvider: 'claude-code' }),
    });
    const host = hostWithOptions({});
    watch(host);
    await act(() => host.handle({ type: 'ready' }));

    await act(() => host.handle({ type: 'setPlanner', provider: 'claude-code', requestId: 'r1' }));

    expect(daemon.calls('settings.update')).toContainEqual([undefined, expect.objectContaining({ env: { AI_PROVIDER: 'claude-code' }, workspace: WORKSPACE })]);
    expect(daemon.calls('runners.list').length).toBeGreaterThanOrEqual(2);
  });

  it('saves a runner pill and answers the click with the state the daemon holds', async () => {
    const daemon = fakeDaemon({
      'runners.list': ok({ runners: [{ id: 'codex', name: 'Codex', enabled: true }], orchestratorModel: '' }),
      'models.list': MODELS,
      'settings.get': ok(SETTINGS),
    });
    const host = hostWithOptions({});
    const seen = watch(host);
    await act(() => host.handle({ type: 'ready' }));

    await act(() => host.handle({ type: 'setRunnerEnabled', runnerId: 'codex', enabled: true, requestId: 'r1' }));

    expect(daemon.calls('runners.setEnabled')).toEqual([[{ id: 'codex' }, { enabled: true }]]);
    expect(seen).toContainEqual({ type: 'runnerChoiceSaved', requestId: 'r1', runnerId: 'codex', enabled: true });
  });

  it('saves a Run setting through the same route and pushes the values back', async () => {
    let current = { ...SETTINGS };
    const daemon = fakeDaemon({
      'runners.list': ok({ runners: [], orchestratorModel: '' }),
      'models.list': MODELS,
      'settings.get': () => ok({ ...current }),
      'settings.update': (_params, body) => {
        const change = body as { run?: Record<string, unknown> };
        if (change.run) current = { ...current, run: { ...current.run, ...change.run } as typeof current.run };
        return ok({ ...current });
      },
    });
    const host = hostWithOptions({});
    const seen = watch(host);
    await act(() => host.handle({ type: 'ready' }));

    await act(() => host.handle({ type: 'changeSettings', change: { run: { mergeAtGatesAutomatically: true } } }));

    expect(daemon.calls('settings.update').at(-1)?.[1]).toMatchObject({ run: { mergeAtGatesAutomatically: true }, workspace: WORKSPACE });
    expect(seen.at(-1)).toMatchObject({ type: 'setRunSettings', run: { mergeAtGatesAutomatically: true } });
  });

  it('shows the run settings of the session it switches to, to a mounted chat and to one that mounts after', async () => {
    // The daemon's run settings are the live session's own: s1 runs autonomously, s2 does not.
    const daemon = fakeDaemon({
      'runners.list': ok({ runners: [], orchestratorModel: '' }),
      'models.list': MODELS,
      'sessions.load': (params) => ok({ ok: true, sessionId: params?.id, goal: 'Ship the parser', plan: PLAN }),
      'settings.get': (params) => ok(params?.sessionId === 's1'
        ? { ...SETTINGS, autonomousMode: true, maxParallel: 5, run: { ...RUN_SETTINGS_DEFAULTS, mergeAtGatesAutomatically: true } }
        : { ...SETTINGS, autonomousMode: false, maxParallel: 2, run: { ...RUN_SETTINGS_DEFAULTS, mergeAtGatesAutomatically: false } }),
    });
    const host = hostWithOptions({});
    const seen = watch(host);
    await act(() => host.open('s1'));
    await act(() => host.handle({ type: 'ready' }));
    expect(seen.filter((m) => m.type === 'setRunSettings').at(-1)).toMatchObject({ autonomous: true, maxParallel: 5 });

    await act(() => host.open('s2'));

    await waitFor(() => expect(seen.filter((m) => m.type === 'setRunSettings').at(-1)).toMatchObject({ autonomous: false, maxParallel: 2, run: { mergeAtGatesAutomatically: false } }));
    expect(daemon.calls('settings.get').at(-1)?.[0]).toEqual({ workspace: WORKSPACE, sessionId: 's2' });
    const later: HostToWebview[] = [];
    const chat = host.port('conversation');
    chat.subscribe((msg) => later.push(msg));
    chat.post({ type: 'ready' });
    expect(later.find((m) => m.type === 'setRunSettings')).toMatchObject({ autonomous: false, maxParallel: 2 });
  });
});

// W16: a session another Ordewell daemon holds is joined, and driven through
// that daemon alongside its other client (ADR-0063 H8).
describe('DaemonHost joining a held session', () => {
  const VSCODE_HELD = { holder: { hostId: 'v1', pid: 51234, host: { kind: 'vscode' }, since: '2026-11-04T10:02:00.000Z', heartbeatAt: '2026-11-04T10:02:00.000Z', runnerGroups: [] } };
  const SINCE = '2026-11-04T10:00:00.000Z';
  const TUI_HELD = { holder: { hostId: 'h1', pid: 48200, host: { kind: 'daemon', port: 49213, ownerPid: 48120 }, since: SINCE, heartbeatAt: SINCE, runnerGroups: [] } };
  const HOLDER: HolderView = { port: 49213, pid: 48200, ownerPid: 48120, version: '0.12.3', contract: 1, since: SINCE };
  const heldBy = (sessionHeld: unknown) => ({ ok: false, status: 409, error: 'Conflict', data: { ok: false, error: 'held', code: 'session_held', sessionHeld } }) as const;
  const TRANSCRIPT = { conversationHistory: [
    { role: 'user', content: 'Add SSO login', timestamp: SINCE },
    { role: 'assistant', content: 'Two tasks: parse the config, then wire the CLI.', timestamp: SINCE },
  ] };
  const saved = (goal = 'Add SSO login') => ok({ meta: { id: 's1', goal }, plan: { status: 'approved', phase: 'planning', pendingTasks: PLAN.tasks }, conversation: TRANSCRIPT, plannerTurnId: 'turn-7' });

  // The phase-tagged plan keeps no transcript: without the read's own, a joined planner showed the welcome hero (W16).
  it('draws the joined session\'s planner conversation', async () => {
    const daemon = fakeDaemon({ 'sessions.load': heldBy(TUI_HELD), 'sessions.get': saved() });
    daemon.joinWith({ ok: true, holder: HOLDER });
    const host = hostWith();
    render(<ChatSurface host={host} layout="conversation" />);

    await act(() => host.open('s1'));
    await act(async () => {
      daemon.push('s1', { type: 'connected', sessionId: 's1' }, { type: 'run_snapshot', sessionId: 's1', view: { tasks: PLAN.tasks, runMerge: null, handoff: null, mergeResult: null }, stream: 'd9', seq: 0 });
    });

    expect(await screen.findByText('Two tasks: parse the config, then wire the CLI.')).toBeInTheDocument();
  });

  it('draws the saved conversation under a refused join', async () => {
    const daemon = fakeDaemon({ 'sessions.load': heldBy(TUI_HELD), 'sessions.get': saved() });
    daemon.joinWith({ ok: false, reason: 'mismatch', message: 'No.' });
    const host = hostWith();
    render(<ChatSurface host={host} layout="conversation" />);

    await act(() => host.open('s1'));

    expect(await screen.findByText('Two tasks: parse the config, then wire the CLI.')).toBeInTheDocument();
    expect(host.getSnapshot().readOnly).toBe(true);
  });

  it('joins the daemon that holds the session it opens, and drives the session there', async () => {
    const daemon = fakeDaemon({ 'sessions.load': heldBy(TUI_HELD), 'sessions.get': saved() });
    daemon.joinWith({ ok: true, holder: HOLDER });
    const host = hostWith();
    render(<ChatSurface host={host} layout="plan" />);

    await act(() => host.open('s1'));
    await act(async () => {
      daemon.push('s1', { type: 'connected', sessionId: 's1' }, { type: 'run_snapshot', sessionId: 's1', view: { tasks: PLAN.tasks, runMerge: null, handoff: null, mergeResult: null }, stream: 'd9', seq: 0 });
    });

    expect(daemon.join).toHaveBeenCalledWith('s1');
    expect(host.getSnapshot()).toMatchObject({ sessionId: 's1', goal: 'Add SSO login', readOnly: false, link: { kind: 'joined', holder: HOLDER } });
    expect(daemon.subscribe).toHaveBeenLastCalledWith('s1', expect.any(Function));
    expect(await screen.findByText('Parse the config')).toBeInTheDocument();

    await act(() => host.handle({ type: 'sendMessage', text: 'Add MFA too', typed: false }));
    expect(daemon.calls('plans.converseMessage')).toEqual([[{ sessionId: 's1' }, { message: 'Add MFA too', surface: 'desktop' }]]);
    // A load at the holder would adopt the session over its live planner turn.
    act(() => host.refreshPlan());
    await waitFor(() => expect(daemon.calls('sessions.get').length).toBeGreaterThan(2));
    expect(daemon.calls('sessions.load')).toHaveLength(1);
  });

  it('says when the holder has exited, and continues the session in the app\'s own daemon when asked', async () => {
    let held = true;
    // The TUI was running t1 when it exited: the run is the holder's, so here it is restored (W17), not live.
    const left = surfacePlan([surfaceTask({ id: 't1', order: 1, title: 'Parse the config', status: 'in_progress' })], 'running');
    const adopted = { sessionId: 's1', goal: 'Add SSO login', plan: left, run: { tasks: left.tasks, runMerge: null, handoff: null, mergeResult: null } };
    const daemon = fakeDaemon({ 'sessions.load': () => (held ? heldBy(TUI_HELD) : ok(adopted)), 'sessions.get': saved() });
    daemon.joinWith({ ok: true, holder: HOLDER });
    const host = hostWith();
    await act(() => host.open('s1'));

    held = false;
    daemon.joinWith({ ok: false, reason: 'free', message: 'Nothing holds this session now.' });
    act(() => daemon.close('s1'));

    await waitFor(() => expect(host.getSnapshot().link).toEqual({ kind: 'gone', holder: HOLDER }));
    expect(host.getSnapshot().readOnly).toBe(true);
    expect(daemon.leave).toHaveBeenCalledWith('s1');

    await act(() => host.continueHere());

    expect(host.getSnapshot()).toMatchObject({ sessionId: 's1', link: null, held: null, readOnly: false, restored: true });
    expect(daemon.calls('sessions.load')).toEqual([[{ id: 's1', workspace: WORKSPACE }, undefined], [{ id: 's1', workspace: WORKSPACE }, undefined]]);
  });

  it('keeps the read-only view up until Continue here has adopted the session', async () => {
    let held = true;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const left = surfacePlan([surfaceTask({ id: 't1', order: 1, title: 'Parse the config', status: 'in_progress' })], 'running');
    const adopted = { sessionId: 's1', goal: 'Add SSO login', plan: left, run: { tasks: left.tasks, runMerge: null, handoff: null, mergeResult: null } };
    const daemon = fakeDaemon({
      'sessions.load': async () => {
        if (held) return heldBy(TUI_HELD);
        await gate;
        return ok(adopted);
      },
      'sessions.get': saved(),
    });
    daemon.joinWith({ ok: true, holder: HOLDER });
    const host = hostWith();
    await act(() => host.open('s1'));

    held = false;
    daemon.joinWith({ ok: false, reason: 'free', message: 'Nothing holds this session now.' });
    act(() => daemon.close('s1'));
    await waitFor(() => expect(host.getSnapshot().link).toEqual({ kind: 'gone', holder: HOLDER }));

    let continuing: Promise<void> = Promise.resolve();
    act(() => { continuing = host.continueHere(); });
    // The adoption is still in flight: the banner stays, and a message is refused rather than dropped.
    expect(host.getSnapshot()).toMatchObject({ link: { kind: 'gone', holder: HOLDER }, readOnly: true });
    await act(() => host.handle({ type: 'sendMessage', text: 'Carry on from here.', typed: false }));
    expect(daemon.calls('plans.converseMessage')).toEqual([]);

    release();
    await act(async () => { await continuing; });
    expect(host.getSnapshot()).toMatchObject({ sessionId: 's1', link: null, readOnly: false });
    await act(() => host.handle({ type: 'sendMessage', text: 'Carry on from here.', typed: false }));
    expect(daemon.calls('plans.converseMessage')).toEqual([[{ sessionId: 's1' }, { message: 'Carry on from here.', surface: 'desktop' }]]);
  });

  it('joins the holder again when its socket drops while it still holds the session', async () => {
    const daemon = fakeDaemon({ 'sessions.load': heldBy(TUI_HELD), 'sessions.get': saved() });
    daemon.joinWith({ ok: true, holder: HOLDER });
    const host = hostWith();
    await act(() => host.open('s1'));

    act(() => daemon.close('s1'));

    await waitFor(() => expect(daemon.join).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(daemon.subscribe).toHaveBeenCalledTimes(3));
    expect(host.getSnapshot().link).toEqual({ kind: 'joined', holder: HOLDER });
    expect(daemon.leave).not.toHaveBeenCalled();
  });

  it('leaves the holder when the window moves to another session', async () => {
    const daemon = fakeDaemon({ 'sessions.load': heldBy(TUI_HELD), 'sessions.get': saved() });
    daemon.joinWith({ ok: true, holder: HOLDER });
    const host = hostWith();
    await act(() => host.open('s1'));

    act(() => host.newSession());

    expect(daemon.leave).toHaveBeenCalledWith('s1');
    expect(host.getSnapshot()).toMatchObject({ link: null, held: null });
  });

  it('shows why a join was refused, over the saved state', async () => {
    const daemon = fakeDaemon({ 'sessions.load': heldBy(TUI_HELD), 'sessions.get': saved() });
    const message = "The TUI's daemon is 0.9.0 (contract 0); this app speaks contract 1, so it can't join.";
    daemon.joinWith({ ok: false, reason: 'mismatch', message });
    const host = hostWith();

    await act(() => host.open('s1'));

    expect(host.getSnapshot()).toMatchObject({ sessionId: 's1', readOnly: true, link: { kind: 'refused', reason: 'mismatch', message }, held: TUI_HELD });
  });

  it('offers Continue here once a refused holder exits, keeping the saved state on screen meanwhile', async () => {
    let held = true;
    const daemon = fakeDaemon({
      'sessions.load': () => (held ? heldBy(TUI_HELD) : ok({ ok: true, plan: PLAN, goal: 'Add SSO login' })),
      'sessions.get': saved(),
    });
    daemon.joinWith(() => (held
      ? { ok: false, reason: 'mismatch', message: "The TUI's daemon is 0.9.0 (contract 0); this app speaks contract 1, so it can't join." }
      : { ok: false, reason: 'free', message: 'Nothing holds this session now.' }));
    const host = hostWith(async () => null, undefined, 10);

    await act(() => host.open('s1'));
    expect(host.getSnapshot()).toMatchObject({ sessionId: 's1', readOnly: true, link: { kind: 'refused' } });

    held = false;
    await waitFor(() => expect(host.getSnapshot().link).toMatchObject({ kind: 'gone' }), { timeout: 5_000 });
    expect(host.getSnapshot()).toMatchObject({ sessionId: 's1', readOnly: true });
  });

  it('says the holder still runs, and why, when take over is refused', async () => {
    const daemon = fakeDaemon({ 'sessions.load': heldBy(TUI_HELD), 'sessions.get': saved() });
    daemon.joinWith({ ok: false, reason: 'token', message: "Can't read the token of the daemon on :49213." });
    const host = hostWith();
    await act(() => host.open('s1'));

    const outcome = await act(() => host.takeOver());

    expect(outcome).toEqual({
      ok: false,
      message: 'The TUI (pid 48120) is still running and holds this session. Quit it, or close the session there, then choose Continue here.',
    });
    expect(host.getSnapshot()).toMatchObject({ sessionId: 's1', readOnly: true });
  });

  it('says the session runs here once take over succeeds', async () => {
    let held = true;
    const daemon = fakeDaemon({
      'sessions.load': () => (held ? heldBy(VSCODE_HELD) : ok({ sessionId: 's1', goal: 'Add SSO login', plan: PLAN })),
      'sessions.get': saved(),
    });
    const host = hostWith();
    await act(() => host.open('s1'));
    held = false;

    const outcome = await act(() => host.takeOver());

    expect(outcome).toEqual({ ok: true, message: 'This window now runs the session.' });
    expect(host.getSnapshot()).toMatchObject({ sessionId: 's1', readOnly: false, held: null });
    expect(daemon.join).not.toHaveBeenCalled();
  });
});

// A VS Code window runs its session inside the extension host: there is no
// daemon to join, so the app offers a new session or a read-only watch (W16).
describe('DaemonHost with a session a VS Code window holds', () => {
  const SINCE = '2026-11-04T10:02:00.000Z';
  const VSCODE = { holder: { hostId: 'v1', pid: 51234, host: { kind: 'vscode' }, since: SINCE, heartbeatAt: SINCE, runnerGroups: [] } };
  const heldBy = { ok: false, status: 409, error: 'Conflict', data: { ok: false, error: 'held', code: 'session_held', sessionHeld: VSCODE } } as const;
  const savedWith = (tasks: typeof PLAN.tasks, said: string[] = ['Add SSO login']) => ok({
    meta: { id: 's1', goal: 'Add SSO login' },
    plan: { status: 'approved', phase: 'planning', pendingTasks: tasks },
    conversation: { conversationHistory: said.map((content, i) => ({ role: i % 2 ? 'assistant' : 'user', content, timestamp: SINCE })) },
  });

  it('starts a new session in the workspace with the held goal in the composer, not sent', async () => {
    const daemon = fakeDaemon({ 'sessions.load': heldBy, 'sessions.get': savedWith(PLAN.tasks) });
    const host = hostWith();
    await act(() => host.open('s1'));

    act(() => host.startHere());
    render(<ChatSurface host={host} layout="conversation" />);

    expect(await screen.findByRole('textbox', { name: 'Message the planner' })).toHaveValue('Add SSO login');
    expect(host.getSnapshot()).toMatchObject({ readOnly: false, held: null, link: null });
    expect(host.getSnapshot().sessionId).not.toBe('s1');
    expect(daemon.join).not.toHaveBeenCalled();
    expect(daemon.calls('plans.converseMessage')).toEqual([]);
  });

  it('watches the saved state read-only, drawing what the holder saves', async () => {
    let tasks = PLAN.tasks;
    fakeDaemon({ 'sessions.load': heldBy, 'sessions.get': () => savedWith(tasks) });
    const host = hostWith(undefined, undefined, 20);
    render(<ChatSurface host={host} layout="plan" />);
    await act(() => host.open('s1'));
    expect(await screen.findByText('Parse the config')).toBeInTheDocument();

    tasks = [...PLAN.tasks, surfaceTask({ id: 't3', order: 3, title: 'Add MFA' })];

    expect(await screen.findByText('Add MFA')).toBeInTheDocument();
    expect(host.getSnapshot()).toMatchObject({ sessionId: 's1', readOnly: true });
  });

  it('draws the held session\'s conversation read-only, and what the holder says next', async () => {
    let said = ['Add SSO login', 'Two tasks to start.'];
    fakeDaemon({ 'sessions.load': heldBy, 'sessions.get': () => savedWith(PLAN.tasks, said) });
    const host = hostWith(undefined, undefined, 20);
    render(<ChatSurface host={host} layout="conversation" />);
    await act(() => host.open('s1'));
    expect(await screen.findByText('Two tasks to start.')).toBeInTheDocument();

    said = [...said, 'Add MFA too', 'A third task, for MFA.'];

    expect(await screen.findByText('A third task, for MFA.')).toBeInTheDocument();
  });

  it('stops watching once the window leaves the held session', async () => {
    const daemon = fakeDaemon({ 'sessions.load': heldBy, 'sessions.get': savedWith(PLAN.tasks) });
    const host = hostWith(undefined, undefined, 20);
    await act(() => host.open('s1'));
    act(() => host.newSession());
    const reads = daemon.calls('sessions.get').length;

    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(daemon.calls('sessions.get')).toHaveLength(reads);
  });
});

// The plan list opens a session on every click and never waits for the last
// one, so two opens race and the window must end on the newer click.
describe('DaemonHost opening one session after another', () => {
  const later = <T,>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => { resolve = r; });
    return { promise, resolve };
  };

  it('stays on the session clicked last when the first one\'s load answers after it', async () => {
    const loads = { s1: later<ReturnType<typeof ok>>(), s2: later<ReturnType<typeof ok>>() };
    const daemon = fakeDaemon({ 'sessions.load': (params) => loads[(params as { id: 's1' | 's2' }).id].promise });
    const host = hostWith();

    let opening!: Promise<unknown>;
    await act(async () => {
      opening = Promise.all([host.open('s1'), host.open('s2')]);
      loads.s2.resolve(ok({ ok: true, plan: PLAN, goal: 'Second' }));
      await loads.s2.promise;
      loads.s1.resolve(ok({ ok: true, plan: PLAN, goal: 'First' }));
      await opening;
    });

    expect(host.sessionId).toBe('s2');
    expect(host.getSnapshot().goal).toBe('Second');
    expect(daemon.subscribe).toHaveBeenLastCalledWith('s2', expect.any(Function));
    expect(daemon.subscribe.mock.calls.some(([id]) => id === 's1')).toBe(false);
  });

  it('lets go of a held session it joined once a newer open has superseded it', async () => {
    const SINCE = '2026-11-04T10:00:00.000Z';
    const held = { holder: { hostId: 'h1', pid: 48200, host: { kind: 'daemon', port: 49213, ownerPid: 48120 }, since: SINCE, heartbeatAt: SINCE, runnerGroups: [] } };
    const joining = later<{ ok: true; holder: HolderView }>();
    const daemon = fakeDaemon({
      'sessions.load': (params) => (params as { id: string }).id === 's1'
        ? { ok: false, status: 409, error: 'Conflict', data: { ok: false, error: 'held', code: 'session_held', sessionHeld: held } }
        : ok({ ok: true, plan: PLAN, goal: 'Second' }),
      'sessions.get': ok({ meta: { id: 's1', goal: 'First' }, plan: { status: 'approved', phase: 'planning', pendingTasks: PLAN.tasks } }),
    });
    daemon.join.mockImplementation(async () => joining.promise);
    const host = hostWith();

    await act(async () => {
      const first = host.open('s1');
      await vi.waitFor(() => expect(daemon.join).toHaveBeenCalledWith('s1'));
      const second = host.open('s2');
      await second;
      joining.resolve({ ok: true, holder: { port: 49213, pid: 48200, ownerPid: 48120, version: '0.12.3', contract: 1, since: SINCE } });
      await first;
    });

    expect(host.sessionId).toBe('s2');
    expect(host.getSnapshot().link).toBeNull();
    expect(daemon.leave).toHaveBeenCalledWith('s1');
    expect(daemon.subscribe.mock.calls.some(([id]) => id === 's1')).toBe(false);
  });
});
