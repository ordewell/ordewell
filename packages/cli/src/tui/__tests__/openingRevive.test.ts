import { describe, expect, it, vi } from 'vitest';
import type { GlobalRunSettings, SettingsResponse, SurfacePlan } from '@ordewell/core';
import { DaemonError, WorkspaceInitNeededError, type SessionFollow } from '../../apiClient';
import { runEffect, type EffectDeps, type OrdewellApi } from '../effects';
import { initialState, reduce, type Action, type Effect } from '../reducer';
import type { TuiState } from '../state';
import { messagesOf } from './chat';

/**
 * An opening turn whose connection was refused waits for the daemon to be
 * revived, and the user may load another session meanwhile. The retry belongs
 * to the welcome that asked for it: it must not take over the session on
 * screen, nor carry that session's queued prompt into the opening.
 */

const RUN_SETTINGS: GlobalRunSettings = {
  supervisorLevel: 'watch', mergeAtGatesAutomatically: false, plannedWithTrailer: true,
  autorun: false, supervisorRetryLimit: 3, wakeUpReadBudget: 0, delegationTokens: 0,
};

/** A settings answer that says only what these tests read: its run settings. */
const settingsWith = (run: Partial<GlobalRunSettings>): SettingsResponse => ({ run: { ...RUN_SETTINGS, ...run } }) as SettingsResponse;

/** A welcome whose saved run settings were read at launch, autorun among them. */
const KNOWN_AUTORUN_WELCOME: Partial<TuiState> = { runSettings: { ...RUN_SETTINGS, autorun: true }, runSettingsKnown: true };

const refused = (): Error => Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:3742'), { code: 'ECONNREFUSED' });

const B_PLAN = {
  tasks: [],
  conversationHistory: [
    { role: 'user', content: 'Plan B', timestamp: '2026-10-29T10:00:00.000Z' },
    { role: 'assistant', content: 'Working on B.', timestamp: '2026-10-29T10:00:01.000Z' },
  ],
} as unknown as SurfacePlan;

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

/** The reducer and the effect runner wired as `app.ts` wires them: every effect a step returns is run. */
function tui(api: Partial<OrdewellApi>, over: Partial<EffectDeps> = {}, initial: Partial<TuiState> = {}) {
  let state: TuiState = initialState({ workspace: '/ws', ...initial });
  const running = new Set<Promise<void>>();
  const deps: EffectDeps = {
    api: {
      startConversation: vi.fn(async () => ({ tasks: [], conversationHistory: [] })),
      sendConversationMessage: vi.fn(async () => ({ tasks: [] })),
      adoptSession: vi.fn(async () => ({ plan: B_PLAN, goal: 'Plan B', plannerTurnId: 'turn-b' })),
      getSettings: vi.fn(async () => ({})),
      getRunners: vi.fn(async () => ({ runners: [] })),
      getIsolationPreview: vi.fn(async () => ({ preview: { status: 'none', repos: [], shared: [] } })),
      streamPlanning: vi.fn(() => ({ ready: Promise.resolve(), close: () => {} })),
      followSession: vi.fn(() => ({ ready: Promise.resolve(true), ended: new Promise(() => {}), close: () => {} }) as SessionFollow),
      ...api,
    } as unknown as OrdewellApi,
    workspace: '/ws',
    port: 3742,
    dispatch: (action: Action) => apply(action),
    newSessionId: () => 'session-opening',
    setEnvVar: () => {},
    saveAutonomy: () => ({ overridden: false }),
    setMouseCapture: () => {},
    hasBin: () => true,
    pipeToClipboard: () => {},
    writeTerminal: () => {},
    reviveDaemon: vi.fn().mockResolvedValue(true),
    login: async () => ({ ok: true }),
    exit: () => {},
    ...over,
  };
  function fire(effect: Effect): void {
    const run = runEffect(effect, deps).finally(() => running.delete(run));
    running.add(run);
  }
  function apply(action: Action): void {
    const step = reduce(state, action);
    state = step.state;
    for (const effect of step.effects) fire(effect);
  }
  return {
    deps,
    api: deps.api as unknown as Record<string, ReturnType<typeof vi.fn>>,
    get state() { return state; },
    type(text: string): void {
      state = { ...state, editor: { ...state.editor, text, cursor: text.length } };
      apply({ type: 'key', key: { name: 'enter' } });
    },
    fire,
    async settle(): Promise<void> {
      while (running.size > 0) await Promise.allSettled([...running]);
    },
  };
}

describe('an opening retried after a revived daemon', () => {
  it('leaves a session loaded meanwhile, and its queued prompt, alone', async () => {
    const revive = deferred<boolean>();
    const h = tui(
      { startConversation: vi.fn().mockRejectedValueOnce(refused()).mockResolvedValue({ tasks: [], conversationHistory: [] }) },
      { reviveDaemon: vi.fn(() => revive.promise) },
    );

    h.type('Opening goal');
    await vi.waitFor(() => expect(h.deps.reviveDaemon).toHaveBeenCalled());

    h.fire({ type: 'loadSession', sessionId: 'B' });
    await vi.waitFor(() => expect(h.state.sessionId).toBe('B'));
    expect(h.state.planner).toBe('joined');
    h.type("B's next prompt");
    expect(h.state.queuedPrompts).toEqual(["B's next prompt"]);
    const transcript = messagesOf(h.state).map((m) => [m.role, m.text]);

    revive.resolve(true);
    await h.settle();

    expect(h.state.sessionId).toBe('B');
    expect(h.state.goal).toBe('Plan B');
    expect(h.state.planner).toBe('joined');
    expect(h.state.turnGate.open).toBe('turn-b');
    expect(h.state.queuedPrompts).toEqual(["B's next prompt"]);
    expect(messagesOf(h.state).map((m) => [m.role, m.text]).slice(0, transcript.length)).toEqual(transcript);
    expect(messagesOf(h.state).some((m) => m.text === 'Opening goal')).toBe(false);
    expect(h.api.sendConversationMessage).not.toHaveBeenCalled();
    // The welcome that asked for it is gone, so the goal is not opened behind B's back.
    expect(h.api.startConversation).toHaveBeenCalledTimes(1);

    // B's own turn ending is what sends B's prompt, to B.
    h.deps.dispatch({ type: 'sessionMessage', sessionId: 'B', message: { type: 'planner_turn_ended', turnId: 'turn-b', outcome: 'message' } });
    await h.settle();
    expect(h.api.sendConversationMessage).toHaveBeenCalledTimes(1);
    expect(h.api.sendConversationMessage).toHaveBeenCalledWith('B', "B's next prompt");
  });

  it('retries an opening still on screen, in the same session, and drains what was typed behind it there', async () => {
    const revive = deferred<boolean>();
    const h = tui(
      { startConversation: vi.fn().mockRejectedValueOnce(refused()).mockResolvedValue({ tasks: [], conversationHistory: [] }) },
      { reviveDaemon: vi.fn(() => revive.promise) },
    );

    h.type('Opening goal');
    await vi.waitFor(() => expect(h.deps.reviveDaemon).toHaveBeenCalled());
    expect(h.state.sessionId).toBe('session-opening');
    h.type('and then this');
    expect(h.state.queuedPrompts).toEqual(['and then this']);

    revive.resolve(true);
    await h.settle();

    expect(h.api.startConversation).toHaveBeenCalledTimes(2);
    expect(h.api.startConversation.mock.calls.map((c) => c[0])).toEqual(['session-opening', 'session-opening']);
    expect(h.api.sendConversationMessage).toHaveBeenCalledWith('session-opening', 'and then this');
    expect(h.state.sessionId).toBe('session-opening');
    expect(messagesOf(h.state).map((m) => m.text)).toContain('The server had stopped; started a new one and retried.');
  });

  it('lets the opening go, onto the welcome, when the daemon does not come back', async () => {
    const h = tui(
      { startConversation: vi.fn().mockRejectedValue(refused()) },
      { reviveDaemon: vi.fn().mockResolvedValue(false) },
    );

    h.type('Opening goal');
    await h.settle();

    expect(h.state.sessionId).toBeNull();
    expect(h.state.planner).toBe('idle');
    expect(messagesOf(h.state).at(-1)).toMatchObject({ role: 'error' });
    expect(messagesOf(h.state).at(-1)?.text).toContain('No Ordewell server is listening on port 3742');
  });

  it('reads the run settings back onto the welcome it lets the opening go to', async () => {
    const h = tui(
      {
        startConversation: vi.fn().mockRejectedValue(refused()),
        getSettings: vi.fn(async () => settingsWith({ autorun: true })),
      },
      { reviveDaemon: vi.fn().mockResolvedValue(false) },
    );

    h.type('Opening goal');
    await h.settle();

    expect(h.state.sessionId).toBeNull();
    expect(h.api.getSettings).toHaveBeenLastCalledWith(undefined);
    expect(h.state.runSettingsKnown).toBe(true);
    expect(h.state.runSettings.autorun).toBe(true);
  });

  it('reads the run settings back onto the welcome when the retry is refused too', async () => {
    const h = tui({
      startConversation: vi.fn().mockRejectedValue(refused()),
      getSettings: vi.fn(async () => settingsWith({ autorun: true })),
    });

    h.type('Opening goal');
    await h.settle();

    expect(h.state.sessionId).toBeNull();
    expect(h.state.runSettingsKnown).toBe(true);
    expect(h.state.runSettings.autorun).toBe(true);
  });

  it('reports the refusal on an idle welcome without waiting on a settings read that never answers', async () => {
    const h = tui(
      {
        startConversation: vi.fn().mockRejectedValue(refused()),
        getSettings: vi.fn(() => new Promise<never>(() => {})),
      },
      { reviveDaemon: vi.fn().mockResolvedValue(false) },
      KNOWN_AUTORUN_WELCOME,
    );

    h.type('Opening goal');

    await vi.waitFor(() => expect(messagesOf(h.state).at(-1)?.text).toContain('No Ordewell server is listening on port 3742'), { timeout: 1000 });
    expect(h.state.sessionId).toBeNull();
    expect(h.state.planner).toBe('idle');
    expect(h.state.runSettingsKnown).toBe(true);
    expect(h.state.runSettings.autorun).toBe(true);
  });

  it("keeps the welcome's known run settings when the settings read is refused too", async () => {
    const h = tui(
      {
        startConversation: vi.fn().mockRejectedValue(refused()),
        getSettings: vi.fn().mockRejectedValue(refused()),
      },
      { reviveDaemon: vi.fn().mockResolvedValue(false) },
      KNOWN_AUTORUN_WELCOME,
    );

    h.type('Opening goal');
    await h.settle();

    expect(h.api.getSettings).toHaveBeenCalledWith(undefined);
    expect(h.state.sessionId).toBeNull();
    expect(h.state.planner).toBe('idle');
    expect(messagesOf(h.state).at(-1)?.text).toContain('No Ordewell server is listening on port 3742');
    expect(h.state.runSettingsKnown).toBe(true);
    expect(h.state.runSettings.autorun).toBe(true);
  });

  it('reports a refused retry on an idle welcome, its run settings kept, while the read hangs', async () => {
    const h = tui(
      {
        startConversation: vi.fn().mockRejectedValue(refused()),
        getSettings: vi.fn(() => new Promise<never>(() => {})),
      },
      {},
      KNOWN_AUTORUN_WELCOME,
    );

    h.type('Opening goal');

    await vi.waitFor(() => expect(messagesOf(h.state).at(-1)?.text).toContain('No Ordewell server is listening on port 3742'), { timeout: 1000 });
    expect(h.api.startConversation).toHaveBeenCalledTimes(2);
    expect(h.state.sessionId).toBeNull();
    expect(h.state.planner).toBe('idle');
    expect(h.state.runSettingsKnown).toBe(true);
    expect(h.state.runSettings.autorun).toBe(true);
  });

  it("does not let the welcome's late settings answer paint over a session loaded after the failure", async () => {
    const welcomeRead = deferred<SettingsResponse>();
    const h = tui(
      {
        startConversation: vi.fn().mockRejectedValue(refused()),
        getSettings: vi.fn((sessionId?: string) => sessionId === 'B'
          ? Promise.resolve(settingsWith({ supervisorLevel: 'act' }))
          : welcomeRead.promise),
      },
      { reviveDaemon: vi.fn().mockResolvedValue(false) },
      KNOWN_AUTORUN_WELCOME,
    );

    h.type('Opening goal');
    await vi.waitFor(() => expect(h.api.getSettings).toHaveBeenCalledWith(undefined));
    expect(h.state.planner).toBe('idle');
    h.fire({ type: 'loadSession', sessionId: 'B' });
    await vi.waitFor(() => expect(h.state.runSettings.supervisorLevel).toBe('act'));

    welcomeRead.resolve(settingsWith({ supervisorLevel: 'off' }));
    await h.settle();

    expect(h.state.sessionId).toBe('B');
    expect(h.state.runSettings.supervisorLevel).toBe('act');
    expect(h.state.runSettings.autorun).toBe(false);
  });

  it('reads an opening that opened its own run settings, as at any normal start', async () => {
    const h = tui(
      { getSettings: vi.fn(async (sessionId?: string) => settingsWith({ autorun: sessionId !== 'session-opening' })) },
      {},
      KNOWN_AUTORUN_WELCOME,
    );

    h.type('Opening goal');
    await h.settle();

    expect(h.deps.reviveDaemon).not.toHaveBeenCalled();
    expect(h.api.getSettings).toHaveBeenLastCalledWith('session-opening');
    expect(h.state.sessionId).toBe('session-opening');
    expect(h.state.runSettingsKnown).toBe(true);
    expect(h.state.runSettings.autorun).toBe(false);
  });

  it("keeps the welcome's run settings off a session loaded while the daemon failed to come back", async () => {
    const revive = deferred<boolean>();
    const h = tui(
      {
        startConversation: vi.fn().mockRejectedValue(refused()),
        getSettings: vi.fn(async (sessionId?: string) => settingsWith({ autorun: sessionId === 'B' })),
      },
      { reviveDaemon: vi.fn(() => revive.promise) },
    );

    h.type('Opening goal');
    await vi.waitFor(() => expect(h.deps.reviveDaemon).toHaveBeenCalled());
    h.fire({ type: 'loadSession', sessionId: 'B' });
    await vi.waitFor(() => expect(h.state.sessionId).toBe('B'));
    await vi.waitFor(() => expect(h.state.runSettings.autorun).toBe(true));

    revive.resolve(false);
    await h.settle();

    expect(h.api.getSettings).toHaveBeenLastCalledWith(undefined);
    expect(h.state.sessionId).toBe('B');
    expect(h.state.runSettings.autorun).toBe(true);
  });

  it('does not revive twice for one opening: a refused retry is reported on the welcome', async () => {
    const h = tui({ startConversation: vi.fn().mockRejectedValue(refused()) });

    h.type('Opening goal');
    await h.settle();

    expect(h.deps.reviveDaemon).toHaveBeenCalledTimes(1);
    expect(h.api.startConversation).toHaveBeenCalledTimes(2);
    expect(h.state.sessionId).toBeNull();
    expect(h.state.planner).toBe('idle');
    expect(messagesOf(h.state).at(-1)?.text).toContain('No Ordewell server is listening on port 3742');
  });

  it('does not send a goal stopped while the daemon was down', async () => {
    const revive = deferred<boolean>();
    const h = tui(
      {
        startConversation: vi.fn().mockRejectedValueOnce(refused()).mockResolvedValue({ tasks: [], conversationHistory: [] }),
        cancelPlanning: vi.fn().mockRejectedValue(new DaemonError('Session not found', 404, 'session_not_found')),
      },
      { reviveDaemon: vi.fn(() => revive.promise) },
    );

    h.type('Opening goal');
    await vi.waitFor(() => expect(h.deps.reviveDaemon).toHaveBeenCalled());
    h.type('/stop');

    revive.resolve(true);
    await h.settle();

    expect(h.api.startConversation).toHaveBeenCalledTimes(1);
    expect(h.state.sessionId).toBeNull();
    expect(h.state.planner).toBe('idle');
  });

  it("keeps the welcome's known run settings when the goal is stopped while the daemon was down", async () => {
    const revive = deferred<boolean>();
    const h = tui(
      { startConversation: vi.fn().mockRejectedValueOnce(refused()).mockResolvedValue({ tasks: [], conversationHistory: [] }) },
      { reviveDaemon: vi.fn(() => revive.promise) },
      KNOWN_AUTORUN_WELCOME,
    );

    h.type('Opening goal');
    await vi.waitFor(() => expect(h.deps.reviveDaemon).toHaveBeenCalled());
    h.type('/stop');

    revive.resolve(true);
    await h.settle();

    expect(h.api.startConversation).toHaveBeenCalledTimes(1);
    expect(h.state.sessionId).toBeNull();
    expect(h.state.runSettingsKnown).toBe(true);
    expect(h.state.runSettings.autorun).toBe(true);
  });

  it('returns a prompt typed behind the opening to the editor when the daemon does not come back', async () => {
    const revive = deferred<boolean>();
    const h = tui({ startConversation: vi.fn().mockRejectedValue(refused()) }, { reviveDaemon: vi.fn(() => revive.promise) });

    h.type('Opening goal');
    await vi.waitFor(() => expect(h.deps.reviveDaemon).toHaveBeenCalled());
    h.type('typed while down');
    expect(h.state.queuedPrompts).toEqual(['typed while down']);

    revive.resolve(false);
    await h.settle();

    expect(h.state.sessionId).toBeNull();
    expect(h.state.queuedPrompts).toEqual([]);
    expect(h.state.editor.text).toBe('typed while down');
    expect(h.api.sendConversationMessage).not.toHaveBeenCalled();
  });

  it('returns a prompt typed behind the opening to the editor when the retry is refused too', async () => {
    const revive = deferred<boolean>();
    const h = tui({ startConversation: vi.fn().mockRejectedValue(refused()) }, { reviveDaemon: vi.fn(() => revive.promise) });

    h.type('Opening goal');
    await vi.waitFor(() => expect(h.deps.reviveDaemon).toHaveBeenCalled());
    h.type('typed while down');

    revive.resolve(true);
    await h.settle();

    expect(h.api.startConversation).toHaveBeenCalledTimes(2);
    expect(h.state.sessionId).toBeNull();
    expect(h.state.queuedPrompts).toEqual([]);
    expect(h.state.editor.text).toBe('typed while down');
    expect(h.api.sendConversationMessage).not.toHaveBeenCalled();
  });

  it('does not ask to initialize the workspace over a session loaded while the opening was refused', async () => {
    const answer = deferred<void>();
    const h = tui({
      startConversation: vi.fn(async () => {
        await answer.promise;
        throw new WorkspaceInitNeededError('not a project', '/ws');
      }),
    });

    h.type('Opening goal');
    await vi.waitFor(() => expect(h.api.startConversation).toHaveBeenCalled());
    h.fire({ type: 'loadSession', sessionId: 'B' });
    await vi.waitFor(() => expect(h.state.sessionId).toBe('B'));
    h.type("B's next prompt");

    answer.resolve();
    await h.settle();

    expect(h.state.sessionId).toBe('B');
    expect(h.state.overlay).toBeNull();
    expect(h.state.planner).toBe('joined');
    expect(h.state.queuedPrompts).toEqual(["B's next prompt"]);
  });

  it('still asks on the welcome when the opening is the one on screen', async () => {
    const h = tui({ startConversation: vi.fn().mockRejectedValue(new WorkspaceInitNeededError('not a project', '/ws')) });

    h.type('Opening goal');
    await h.settle();

    expect(h.state.sessionId).toBeNull();
    expect(h.state.overlay).toMatchObject({ kind: 'confirm', action: { kind: 'init-workspace', goal: 'Opening goal' } });
  });

  it("keeps the opening's read-back, after a lost reply, off a session loaded meanwhile", async () => {
    const readBack = deferred<void>();
    const h = tui({
      startConversation: vi.fn().mockRejectedValue(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })),
      adoptSession: vi.fn(async (id: string) => {
        if (id === 'B') return { plan: B_PLAN, goal: 'Plan B', plannerTurnId: 'turn-b' };
        await readBack.promise;
        throw new DaemonError('internal error', 500);
      }),
    });

    h.type('Opening goal');
    await vi.waitFor(() => expect(h.api.adoptSession).toHaveBeenCalledWith('session-opening', '/ws'));
    h.fire({ type: 'loadSession', sessionId: 'B' });
    await vi.waitFor(() => expect(h.state.sessionId).toBe('B'));
    const transcript = messagesOf(h.state).map((m) => [m.role, m.text]);

    readBack.resolve();
    await h.settle();

    expect(h.state.sessionId).toBe('B');
    expect(h.state.planner).toBe('joined');
    expect(messagesOf(h.state).map((m) => [m.role, m.text])).toEqual(transcript);
  });

  it('leaves a fork made while the daemon came back on screen, with the approval waiting in it', async () => {
    const revive = deferred<boolean>();
    const h = tui(
      {
        startConversation: vi.fn().mockRejectedValueOnce(refused()).mockResolvedValue({ tasks: [], conversationHistory: [] }),
        // /fork asks for an idle planner, so B has no turn running.
        adoptSession: vi.fn(async () => ({ plan: B_PLAN, goal: 'Plan B' })),
        forkConversation: vi.fn(async () => ({ sessionId: 'B2', goal: 'Plan B', plan: B_PLAN })),
      },
      { reviveDaemon: vi.fn(() => revive.promise) },
    );

    h.type('Opening goal');
    await vi.waitFor(() => expect(h.deps.reviveDaemon).toHaveBeenCalled());
    h.fire({ type: 'loadSession', sessionId: 'B' });
    await vi.waitFor(() => expect(h.state.sessionId).toBe('B'));
    h.type('/fork');
    await vi.waitFor(() => expect(h.state.sessionId).toBe('B2'));
    h.deps.dispatch({
      type: 'sessionMessage', sessionId: 'B2',
      message: { type: 'approval_request', id: 'ap-1', kind: 'shell_command', subject: 'npm test', scope: 'npm test' },
    });
    expect(h.state.overlay).toMatchObject({ kind: 'approval', request: { id: 'ap-1' } });

    revive.resolve(true);
    await h.settle();

    expect(h.api.forkConversation).toHaveBeenCalledWith('B');
    expect(h.api.startConversation).toHaveBeenCalledTimes(1);
    expect(h.state.sessionId).toBe('B2');
    expect(h.state.overlay).toMatchObject({ kind: 'approval', request: { id: 'ap-1' } });
  });
});
