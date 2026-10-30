import { describe, it, expect } from 'vitest';
import { EMPTY_RUN, type IsolationPreview, type LegacyPlanState, type RunTask, type RunView } from '@ordewell/core';
import { reduceHost, resetSession, runnersOn, INITIAL_HOST_STATE, type HostState, type HostMessage } from '../hostState';

const NOW = 1_000;
const msg = (m: { type: HostMessage['type'] } & Record<string, unknown>): HostMessage => ({ now: NOW, ...m }) as HostMessage;

function planWith(status: string): LegacyPlanState {
  return { status, tasks: [] } as unknown as LegacyPlanState;
}

function runWith(tasks: Partial<RunTask>[], over: Partial<RunView> = {}): RunView {
  return { ...EMPTY_RUN, ...over, tasks: tasks.map((t) => ({ subtasks: [], ...t })) as RunTask[] };
}

function staleSession(): HostState {
  return {
    ...INITIAL_HOST_STATE,
    plan: planWith('running'),
    isExecuting: true,
    isResearchActive: true,
    error: 'boom',
    run: runWith([{ id: 't1', awaitingApproval: 2, idleSince: '2026-01-01T00:00:00Z', mergeGate: ['t0'] }]),
    dockExpanded: true,
  };
}

describe('resetSession', () => {
  it('clears the run and the plan on restore', () => {
    const next = reduceHost(staleSession(), msg({ type: 'restoreChat' }));
    expect(next.run).toEqual(EMPTY_RUN);
    expect(next.plan).toBeNull();
    expect(next.checkpoint).toBeNull();
    expect(next.isResearchActive).toBe(false);
    expect(next.isExecuting).toBe(false);
  });

  it("'empty' clears the run but leaves running flags and held prompts alone", () => {
    const held = { ...INITIAL_HOST_STATE.held };
    const next = resetSession({ ...staleSession(), held, stopped: true }, 'empty');
    expect(next.run).toEqual(EMPTY_RUN);
    expect(next.error).toBe('');
    expect(next.isResearchActive).toBe(true);
    expect(next.held).toBe(held);
    expect(next.stopped).toBe(true);
  });

  it("'restore' opens the gates and 'new' closes them", () => {
    const gated = { ...staleSession(), stopped: true, sessionCleared: true };
    const restored = resetSession(gated, 'restore');
    expect(restored.stopped).toBe(false);
    expect(restored.sessionCleared).toBe(false);
    const fresh = resetSession(staleSession(), 'new');
    expect(fresh.stopped).toBe(true);
    expect(fresh.sessionCleared).toBe(true);
  });

  it('is not undone by a conversation reset: the conversation stays the host\'s', () => {
    const before = staleSession();
    expect(resetSession(before, 'new').conversation).toBe(before.conversation);
  });
});

describe('reduceHost gates', () => {
  it('drops planUpdated while stopped until a planner turn opens', () => {
    const stopped = reduceHost(staleSession(), { type: 'turnStopped' });
    const dropped = reduceHost(stopped, msg({ type: 'planUpdated', plan: planWith('draft') }));
    expect(dropped).toBe(stopped);
    const reopened = reduceHost(stopped, msg({ type: 'plannerTurn', active: true }));
    expect(reduceHost(reopened, msg({ type: 'planUpdated', plan: planWith('draft') })).plan?.status).toBe('draft');
  });

  it('drops showError after a new session until the next send', () => {
    const cleared = reduceHost(staleSession(), { type: 'resetSession', kind: 'new' });
    expect(reduceHost(cleared, msg({ type: 'showError', error: 'late' })).error).toBe('');
    const sent = reduceHost(cleared, { type: 'turnRequested' });
    expect(reduceHost(sent, msg({ type: 'showError', error: 'real' })).error).toBe('real');
  });

  // /fork fails before any turn opens, and /compact's turn may never open either.
  it('shows the error of a command typed after a new session', () => {
    const cleared = reduceHost(staleSession(), { type: 'resetSession', kind: 'new' });
    const sent = reduceHost(cleared, { type: 'commandSent' });
    expect(reduceHost(sent, msg({ type: 'showError', error: 'Could not fork the conversation: no session' })).error)
      .toBe('Could not fork the conversation: no session');
  });
});

describe('reduceHost after the watchdog', () => {
  const busy = { ...INITIAL_HOST_STATE, isResearchActive: true };
  const alive = msg({ type: 'plannerTurnAlive' });

  it('re-locks the input when the host says the turn it gave up on is still out', () => {
    const lost = reduceHost(busy, { type: 'turnLost' });
    expect(lost.isResearchActive).toBe(false);
    expect(reduceHost(lost, alive).isResearchActive).toBe(true);
  });

  it('ignores the turn being alive when the watchdog never fired: a stop or an end freed the input', () => {
    expect(reduceHost(INITIAL_HOST_STATE, alive)).toBe(INITIAL_HOST_STATE);
    const stopped = reduceHost(busy, { type: 'turnStopped' });
    expect(reduceHost(stopped, alive)).toBe(stopped);
  });

  it('stops waiting on the lost turn once the host or the user has spoken since', () => {
    const lost = reduceHost(busy, { type: 'turnLost' });
    for (const after of [
      reduceHost(lost, msg({ type: 'plannerTurn', active: false })),
      reduceHost(lost, { type: 'turnStopped' }),
      reduceHost(lost, { type: 'resetSession', kind: 'new' }),
      reduceHost(lost, msg({ type: 'showError', error: 'planner down' })),
    ]) {
      expect(reduceHost(after, alive).isResearchActive).toBe(false);
    }
  });
});

describe('the planner turn\'s start (#81)', () => {
  const startedAt = '2026-10-30T10:00:00.000Z';
  const running = reduceHost(INITIAL_HOST_STATE, msg({ type: 'plannerTurn', active: true, startedAt }));

  it('is the open turn\'s', () => {
    expect(running.plannerTurnStartedAt).toBe(startedAt);
    expect(reduceHost(running, msg({ type: 'plannerTurn', active: false })).plannerTurnStartedAt).toBeUndefined();
  });

  it('does not outlive a turn that ends without the host closing it', () => {
    const ended: Record<string, HostState> = {
      stopped: reduceHost(running, { type: 'turnStopped' }),
      errored: reduceHost(running, msg({ type: 'showError', error: 'planner down' })),
      'a new session': reduceHost(running, { type: 'resetSession', kind: 'new' }),
      'a restored one': reduceHost(running, { type: 'resetSession', kind: 'restore' }),
    };
    for (const [how, state] of Object.entries(ended)) {
      expect([how, state.plannerTurnStartedAt]).toEqual([how, undefined]);
      expect([how, reduceHost(state, { type: 'turnRequested' }).plannerTurnStartedAt]).toEqual([how, undefined]);
    }
  });

  it('is dropped when a new turn is asked for after the watchdog gave up on the last', () => {
    const lost = reduceHost(running, { type: 'turnLost' });
    expect(reduceHost(lost, { type: 'turnRequested' }).plannerTurnStartedAt).toBeUndefined();
  });

  it('is kept while the lost turn is still out, and comes back with it', () => {
    const lost = reduceHost(running, { type: 'turnLost' });
    expect(reduceHost(lost, msg({ type: 'plannerTurnAlive' })).plannerTurnStartedAt).toBe(startedAt);
  });
});

describe('reduceHost runView', () => {
  const checkpointTask = { id: 't1', title: 'Add rate limiting', status: 'awaiting_user' as const, awaitingReason: 'checkpoint' as const, checkpoint: 'ready for review' };

  it('adopts the run as sent', () => {
    const view = runWith([{ id: 't1', awaitingApproval: 2, idleSince: '2026-01-01T00:00:00Z' }]);
    const next = reduceHost(INITIAL_HOST_STATE, msg({ type: 'runView', view }));
    expect(next.run).toBe(view);
  });

  it('stamps a checkpoint question that arrives on the run view', () => {
    const next = reduceHost(INITIAL_HOST_STATE, msg({ type: 'runView', view: runWith([checkpointTask]) }));
    expect(next.checkpoint?.pausedAt).toBe(NOW);
    expect(next.checkpoint?.taskTitle).toBe('Add rate limiting');
    expect(next.checkpoint?.summary).toBe('ready for review');
  });

  it('keeps the paused clock across a re-sent view, and clears the panel when the question is gone', () => {
    const waiting = msg({ type: 'runView', view: runWith([checkpointTask]) });
    const first = reduceHost(INITIAL_HOST_STATE, { ...waiting, now: 500 });
    const again = reduceHost(first, { ...waiting, now: 9_000 });
    expect(again.checkpoint?.pausedAt).toBe(500);

    expect(reduceHost(again, msg({ type: 'runView', view: EMPTY_RUN })).checkpoint).toBeNull();
  });

  it('forgets the answered question with the session, and re-opens a different one', () => {
    const asked = reduceHost(INITIAL_HOST_STATE, msg({ type: 'runView', view: runWith([checkpointTask]) }));
    const answered = reduceHost(asked, { type: 'checkpointAnswered' });
    expect(answered.checkpoint).toBeNull();
    expect(reduceHost(answered, msg({ type: 'runView', view: runWith([checkpointTask]) })).checkpoint).toBeNull();

    expect(resetSession(answered, 'restore').answeredCheckpoint).toBeNull();

    const different = reduceHost(answered, msg({ type: 'runView', view: runWith([{ ...checkpointTask, checkpoint: 'another review' }]) }));
    expect(different.checkpoint?.summary).toBe('another review');
  });
});

describe('reduceHost runView isolation', () => {
  const landed = [{ taskId: 't1', order: 1, title: 'A' }];
  const repos = [{ path: '.', integrationBranch: 'ordewell/r/integration', baseRef: 'abc', landed }];

  it('keeps the supervisor deferral on the handoff', () => {
    const next = reduceHost(INITIAL_HOST_STATE, msg({ type: 'runView', view: runWith([], { handoff: { repos, landed, deferredTo: 'supervisor' } }) }));

    expect(next.run.handoff).toEqual({ repos, landed, deferredTo: 'supervisor' });
  });

  it('replaces a deferred handoff with the unmarked one that follows it', () => {
    const deferred = reduceHost(INITIAL_HOST_STATE, msg({ type: 'runView', view: runWith([], { handoff: { repos, landed, deferredTo: 'supervisor' } }) }));

    const next = reduceHost(deferred, msg({ type: 'runView', view: runWith([], { handoff: { repos, landed } }) }));

    expect(next.run.handoff).toEqual({ repos, landed });
  });
});

// A pill click stays until the host acknowledges that request by id: a runner
// list names no request, so however stale it is, it cannot settle or undo one.
describe('a Runners pill clicked', () => {
  const ALL = ['claude-code', 'codex', 'opencode'];
  const installed = (enabled: string[]) => [
    { id: 'claude-code', displayName: 'Claude Code', enabled: enabled.includes('claude-code') },
    { id: 'codex', displayName: 'Codex', enabled: enabled.includes('codex') },
    { id: 'opencode', displayName: 'OpenCode', enabled: enabled.includes('opencode') },
  ];
  const listed = (state: HostState, enabled: string[]): HostState => reduceHost(state, msg({ type: 'setRunners', runners: installed(enabled) }));
  const click = (state: HostState, runnerId: string, enabled: boolean, requestId: string): HostState =>
    reduceHost(state, { type: 'runnerChoiceRequested', runnerId, enabled, requestId });
  const ack = (state: HostState, requestId: string, runnerId: string, enabled: boolean): HostState =>
    reduceHost(state, msg({ type: 'runnerChoiceSaved', requestId, runnerId, enabled }));
  const pendingIds = (state: HostState): string[] => Object.keys(state.pendingRunners).sort();

  it('shows the click at once, and the host\'s acknowledgement settles it as saved', () => {
    const known = listed(INITIAL_HOST_STATE, ['claude-code']);

    const enabling = click(known, 'codex', true, 'r1');
    expect(runnersOn(enabling)).toEqual(['claude-code', 'codex']);
    expect(enabling.enabledRunnerIds).toEqual(['claude-code']);

    const saved = ack(enabling, 'r1', 'codex', true);
    expect(runnersOn(saved)).toEqual(['claude-code', 'codex']);
    expect(saved.enabledRunnerIds).toEqual(['claude-code', 'codex']);
    expect(saved.pendingRunners).toEqual({});
  });

  it('keeps Codex off and pending when a stale runner list that still holds it lands before the acknowledgement', () => {
    const disabling = click(listed(INITIAL_HOST_STATE, ALL), 'codex', false, 'r1');
    expect(runnersOn(disabling)).toEqual(['claude-code', 'opencode']);

    const stale = listed(disabling, ALL);

    expect(runnersOn(stale)).toEqual(['claude-code', 'opencode']);
    expect(pendingIds(stale)).toEqual(['codex']);
  });

  it('clears the click only on the acknowledgement of that request, whatever lists came between', () => {
    const disabling = click(listed(INITIAL_HOST_STATE, ALL), 'codex', false, 'r1');
    const stale = listed(listed(disabling, ALL), ALL);

    const saved = ack(stale, 'r1', 'codex', false);

    expect(runnersOn(saved)).toEqual(['claude-code', 'opencode']);
    expect(saved.enabledRunnerIds).toEqual(['claude-code', 'opencode']);
    expect(saved.pendingRunners).toEqual({});
  });

  it('goes back to the saved state when the acknowledgement says the save did not take', () => {
    const known = listed(INITIAL_HOST_STATE, ALL);
    const disabling = click(known, 'codex', false, 'r1');
    expect(runnersOn(disabling)).toEqual(['claude-code', 'opencode']);

    const refused = ack(disabling, 'r1', 'codex', true);

    expect(runnersOn(refused)).toEqual(ALL);
    expect(refused.pendingRunners).toEqual({});
  });

  it('does not take an ordinary runner list for a refusal', () => {
    const disabling = click(listed(INITIAL_HOST_STATE, ALL), 'codex', false, 'r1');

    const ordinary = listed(disabling, ALL);

    expect(runnersOn(ordinary)).not.toContain('codex');
    expect(ordinary.pendingRunners).not.toEqual({});
  });

  it('keeps the click through an unrelated list that changes another runner', () => {
    const disabling = click(listed(INITIAL_HOST_STATE, ALL), 'codex', false, 'r1');

    // Another surface switched OpenCode off while the click was with the host.
    const other = listed(disabling, ['claude-code', 'codex']);

    expect(runnersOn(other)).toEqual(['claude-code']);
    expect(pendingIds(other)).toEqual(['codex']);
  });

  it('settles two runners\' clicks one by one, whichever acknowledgement comes first', () => {
    const both = click(click(listed(INITIAL_HOST_STATE, ALL), 'codex', false, 'r1'), 'opencode', false, 'r2');
    expect(runnersOn(both)).toEqual(['claude-code']);

    const secondFirst = ack(both, 'r2', 'opencode', false);
    expect(runnersOn(secondFirst)).toEqual(['claude-code']);
    expect(pendingIds(secondFirst)).toEqual(['codex']);

    const firstLast = ack(secondFirst, 'r1', 'codex', false);
    expect(runnersOn(firstLast)).toEqual(['claude-code']);
    expect(firstLast.enabledRunnerIds).toEqual(['claude-code']);
    expect(firstLast.pendingRunners).toEqual({});
  });

  it('keeps a newer click on the same runner when the older click\'s acknowledgement comes first', () => {
    const off = click(listed(INITIAL_HOST_STATE, ALL), 'codex', false, 'r1');
    const backOn = click(off, 'codex', true, 'r2');

    const older = ack(backOn, 'r1', 'codex', false);

    expect(runnersOn(older)).toContain('codex');
    expect(pendingIds(older)).toEqual(['codex']);

    const settled = ack(older, 'r2', 'codex', true);
    expect(runnersOn(settled)).toEqual(ALL);
    expect(settled.pendingRunners).toEqual({});
  });

  it('ignores an acknowledgement that arrives twice, or for a request this page never made', () => {
    const off = click(listed(INITIAL_HOST_STATE, ALL), 'codex', false, 'r1');
    const backOn = click(off, 'codex', true, 'r2');
    const settled = ack(ack(backOn, 'r1', 'codex', false), 'r2', 'codex', true);

    expect(ack(settled, 'r1', 'codex', false)).toEqual(settled);
    expect(ack(settled, 'r2', 'codex', true)).toEqual(settled);
    expect(ack(settled, 'never-asked', 'codex', false)).toEqual(settled);
  });

  it('starts with no click pending in a page that is built anew', () => {
    expect(INITIAL_HOST_STATE.pendingRunners).toEqual({});
    expect(runnersOn(listed(INITIAL_HOST_STATE, ['claude-code', 'opencode']))).toEqual(['claude-code', 'opencode']);
  });
});

describe('setModesByRunner', () => {
  it('keeps the host\'s one-line notice for a runner whose modes are off, and drops it once they are back', () => {
    const notice = { line: 'Codex sandbox unavailable on this host: read-only and Guarded modes are off', docs: 'https://example.test/docs' };
    const off = reduceHost(INITIAL_HOST_STATE, msg({ type: 'setModesByRunner', modesByRunner: {}, notice }));
    expect(off.runnerNotice).toEqual(notice);

    expect(reduceHost(off, msg({ type: 'setModesByRunner', modesByRunner: {} })).runnerNotice).toBeNull();
  });
});

describe('setModelAllowlist', () => {
  it('holds the allowlist the host sent, and an empty one once it is cleared', () => {
    const set = reduceHost(INITIAL_HOST_STATE, msg({ type: 'setModelAllowlist', allowlist: { codex: ['gpt-5'] } }));
    expect(set.modelAllowlist).toEqual({ codex: ['gpt-5'] });
    expect(reduceHost(set, msg({ type: 'setModelAllowlist', allowlist: {} })).modelAllowlist).toEqual({});
  });
});

describe('conversationEpoch: which conversation the blocks belong to', () => {
  const block = { type: 'message' as const, id: 'b1', role: 'user' as const, text: 'hi', streaming: false };
  const patch = (order: string[]) => msg({ type: 'conversationPatch', order, changed: order.length ? [block] : [] });

  it('moves on when a session is restored, and when the host empties the conversation', () => {
    const shown = reduceHost(INITIAL_HOST_STATE, patch(['b1']));
    expect(shown.conversationEpoch).toBe(INITIAL_HOST_STATE.conversationEpoch);
    const restored = reduceHost(shown, msg({ type: 'restoreChat' }));
    expect(restored.conversationEpoch).toBe(shown.conversationEpoch + 1);
    const emptied = reduceHost(shown, patch([]));
    expect(emptied.conversationEpoch).toBe(shown.conversationEpoch + 1);
  });

  it('moves on when the host replaces the conversation with blocks that reuse its ids', () => {
    const shown = reduceHost(INITIAL_HOST_STATE, patch(['b1']));
    const compacted = reduceHost(shown, msg({ type: 'conversationPatch', order: ['b1'], changed: [{ ...block, text: 'summary' }], replaced: true }));
    expect(compacted.conversationEpoch).toBe(shown.conversationEpoch + 1);
  });

  it('stays put while the same conversation is patched, or an empty one stays empty', () => {
    const shown = reduceHost(INITIAL_HOST_STATE, patch(['b1']));
    expect(reduceHost(shown, patch(['b1'])).conversationEpoch).toBe(shown.conversationEpoch);
    expect(reduceHost(INITIAL_HOST_STATE, patch([])).conversationEpoch).toBe(INITIAL_HOST_STATE.conversationEpoch);
  });
});

describe('the repositories notice', () => {
  const preview: IsolationPreview = { status: 'ready', shared: [], repos: [{ path: '.', head: { kind: 'branch', branch: 'main', commit: 'a1b2c3d' }, dirty: false }] };

  it('is unheard of until the host says, then holds what it last sent, null included', () => {
    expect(INITIAL_HOST_STATE.isolationPreview).toBeUndefined();

    const shown = reduceHost(INITIAL_HOST_STATE, msg({ type: 'isolationPreview', preview }));
    expect(shown.isolationPreview).toEqual(preview);

    // A workspace change or a reload sends null: the old branch is gone, not kept until the answer.
    expect(reduceHost(shown, msg({ type: 'isolationPreview', preview: null })).isolationPreview).toBeNull();
  });

  it('belongs to the workspace, so a new, restored or emptied session keeps it', () => {
    const shown = reduceHost(INITIAL_HOST_STATE, msg({ type: 'isolationPreview', preview }));

    for (const kind of ['empty', 'restore', 'new'] as const) {
      expect(resetSession(shown, kind).isolationPreview).toEqual(preview);
    }
  });
});
