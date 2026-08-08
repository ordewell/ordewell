import { describe, it, expect } from 'vitest';
import { initialState, reduce, type Step } from '../reducer';
import type { ApprovalRequestView, TuiState } from '../state';

const key = (name: string, char?: string) => ({ type: 'key' as const, key: { name, char } });
const press = (state: TuiState, name: string, char?: string): Step => reduce(state, key(name, char));

const REQUEST: ApprovalRequestView = {
  id: 'ap-1',
  kind: 'shell_command',
  subject: 'npm test',
  scope: 'npm test',
  detail: 'Planner research wants to run: npm test',
};

const PATH_REQUEST: ApprovalRequestView = {
  id: 'ap-2',
  kind: 'external_path',
  subject: '/tmp/dump/a.log',
  scope: '/tmp/dump/*',
};

const requested = (request = REQUEST) => ({ type: 'approvalRequested' as const, request, sessionId: 's1' });

function withPending(request = REQUEST): TuiState {
  return reduce(initialState({ sessionId: 's1', status: 'researching' }), requested(request)).state;
}

describe('approval overlay', () => {
  it('opens a modal when the planner asks for something', () => {
    const state = withPending();

    expect(state.overlay).toMatchObject({ kind: 'approval' });
    expect(state.overlay).toMatchObject({ request: { id: 'ap-1', subject: 'npm test' } });
  });

  it('ignores a request for a different session', () => {
    const state = initialState({ sessionId: 's1' });
    const next = reduce(state, { type: 'approvalRequested', request: REQUEST, sessionId: 'other' }).state;

    expect(next.overlay).toBeNull();
  });

  it('grants on y and tells the daemon', () => {
    const { state, effects } = press(withPending(), 'y', 'y');

    expect(state.overlay).toBeNull();
    expect(effects).toContainEqual({ type: 'respondApproval', sessionId: 's1', approvalId: 'ap-1', granted: true });
  });

  it('grants on enter, matching the confirm overlay it sits beside', () => {
    const { effects } = press(withPending(), 'enter');

    expect(effects).toContainEqual({ type: 'respondApproval', sessionId: 's1', approvalId: 'ap-1', granted: true });
  });

  it('denies on n', () => {
    const { state, effects } = press(withPending(), 'n', 'n');

    expect(state.overlay).toBeNull();
    expect(effects).toContainEqual({ type: 'respondApproval', sessionId: 's1', approvalId: 'ap-1', granted: false });
  });

  it('denies on escape once no turn is in flight, so dismissing is never consent', () => {
    // A prompt outliving its turn (answered elsewhere, or the turn already
    // settled) still gets the plain deny — there is nothing left to stop.
    const { effects } = press({ ...withPending(), status: 'idle' }, 'escape');

    expect(effects).toContainEqual({ type: 'respondApproval', sessionId: 's1', approvalId: 'ap-1', granted: false });
  });

  it('escape stops the whole turn while one is in flight, rather than denying one call', () => {
    const { state, effects } = press(withPending(), 'escape');

    expect(effects).toEqual([{ type: 'cancelPlanning', sessionId: 's1' }]);
    expect(state.overlay).toBeNull();
  });

  it('ignores keys that mean neither yes nor no rather than guessing', () => {
    const { state, effects } = press(withPending(), 'k', 'k');

    expect(state.overlay).toMatchObject({ kind: 'approval' });
    expect(effects).toEqual([]);
  });

  it('records the decision in the transcript, so the run has a visible audit trail', () => {
    const granted = press(withPending(), 'y', 'y').state;
    const denied = press(withPending(), 'n', 'n').state;

    expect(granted.messages.at(-1)?.content).toContain('npm test');
    expect(granted.messages.at(-1)?.content).toMatch(/approved/i);
    expect(denied.messages.at(-1)?.content).toMatch(/denied/i);
  });
});

describe('approval queue', () => {
  it('shows the second request only after the first is answered', () => {
    const first = withPending();
    const both = reduce(first, requested(PATH_REQUEST)).state;

    expect(both.overlay).toMatchObject({ request: { id: 'ap-1' } });

    const afterFirst = press(both, 'y', 'y').state;
    expect(afterFirst.overlay).toMatchObject({ request: { id: 'ap-2' } });
  });

  it('does not queue the same request twice when a socket replays it', () => {
    const state = reduce(withPending(), requested(REQUEST)).state;
    const answered = press(state, 'y', 'y').state;

    expect(answered.overlay).toBeNull();
  });

  it('drops a queued request that was answered on another surface', () => {
    const both = reduce(withPending(), requested(PATH_REQUEST)).state;
    const settled = reduce(both, { type: 'approvalSettled', approvalId: 'ap-2', sessionId: 's1' }).state;

    expect(press(settled, 'y', 'y').state.overlay).toBeNull();
  });

  it('closes the open modal when that request is settled elsewhere', () => {
    const settled = reduce(withPending(), { type: 'approvalSettled', approvalId: 'ap-1', sessionId: 's1' }).state;

    expect(settled.overlay).toBeNull();
  });

  it('clears pending approvals on a new session — they belong to the old one', () => {
    const cleared = reduce(withPending(), { type: 'sessionCleared' }).state;

    expect(cleared.overlay).toBeNull();
    expect(cleared.pendingApprovals).toEqual([]);
  });

  // /new builds the fresh state directly rather than going through
  // sessionCleared, so a queued prompt from the abandoned session survived it
  // and would then be answered against a session id that no longer exists.
  it('clears them on /new too, not only on sessionCleared', () => {
    const queued = reduce(withPending(), requested(PATH_REQUEST)).state;
    const typed = { ...queued, overlay: null, editor: { ...queued.editor, text: '/new', cursor: 4 } };
    // The transcript holds the earlier decision, so /new confirms first.
    const reset = press(press(typed, 'enter').state, 'enter').state;

    expect(reset.sessionId).toBeNull();
    expect(reset.overlay).toBeNull();
    expect(reset.pendingApprovals).toEqual([]);
  });
});
