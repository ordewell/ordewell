import { describe, it, expect, vi } from 'vitest';
import type { ApprovalDecision } from '../../../interfaces/IApproval';
import type { AgentEvent } from '../AgentAdapter';
import { PermissionLedger, type LedgerStance, type RaisedRequest } from '../permissionLedger';

/**
 * The permission table and lifecycle every runner adapter shares (ADR-0026).
 * The adapter suites prove each one reads its runner's requests into it.
 */

const request = (id: string, extra: Partial<RaisedRequest> = {}): RaisedRequest => ({
  id,
  name: 'Write',
  detail: '{"file_path":"/repo/a.txt"}',
  input: { file_path: '/repo/a.txt' },
  suggestions: [{ grant: 'session' }],
  ask: { kind: 'path', path: '/etc/hosts', directory: false },
  ordewell: false,
  ...extra,
});

function ledger(stance: LedgerStance) {
  const replies: [string, ApprovalDecision][] = [];
  const events: AgentEvent[] = [];
  const permissions = new PermissionLedger<string>((handle, decision) => { replies.push([handle, decision]); }, () => stance);
  return { permissions, replies, events, onEvent: (e: AgentEvent) => events.push(e) };
}

const PLANNER: LedgerStance = { role: 'planner', autoApprove: false };
const TASK: LedgerStance = { role: 'task', autoApprove: false };
const AUTO_TASK: LedgerStance = { role: 'task', autoApprove: true };

describe('PermissionLedger', () => {
  it('never opens a user override when a read-only decision cannot be delivered', async () => {
    const events: AgentEvent[] = [];
    const permissions = new PermissionLedger<string>(
      async () => { throw new Error('server gone'); },
      () => ({ role: 'task', autoApprove: true, decide: () => ({ decision: 'deny' }) }),
    );
    permissions.raise(request('r1'), 'h1', (event) => events.push(event));
    await vi.waitFor(() => expect(events.some((e) => e.type === 'error')).toBe(true));
    expect(events.some((e) => e.type === 'permission_request')).toBe(false);
    expect(permissions.answer('r1', { decision: 'allow' })).toBe(false);
  });

  it('answers what the stance decides and holds what it leaves undecided, a planner\'s with its ask', () => {
    const decide = (r: RaisedRequest): ApprovalDecision | undefined => (r.name === 'Edit' ? { decision: 'deny', note: 'read-only' } : undefined);
    const { permissions, replies, events, onEvent } = ledger({ role: 'planner', autoApprove: false, decide });
    permissions.raise(request('r1', { name: 'Edit' }), 'h1', onEvent);
    permissions.raise(request('r2', { name: 'Read' }), 'h2', onEvent);

    expect(replies).toEqual([['h1', { decision: 'deny', note: 'read-only' }]]);
    expect(events).toEqual([
      expect.objectContaining({ id: 'r1', decided: { decision: 'deny', note: 'read-only' } }),
      expect.objectContaining({ id: 'r2', ask: { kind: 'path', path: '/etc/hosts', directory: false } }),
    ]);
    expect(events[1]).not.toHaveProperty('decided');
    expect(permissions.answer('r1', { decision: 'allow' })).toBe(false);
    expect(permissions.answer('r2', { decision: 'allow' })).toBe(true);
    expect(replies[1]).toEqual(['h2', { decision: 'allow' }]);
  });

  it.each([['planner', PLANNER], ['task', TASK], ['auto-approving task', AUTO_TASK]])(
    'allows an Ordewell tool at once for a %s, and shows it decided',
    (_label, stance) => {
      const { permissions, replies, events, onEvent } = ledger(stance);
      permissions.raise(request('r1', { name: 'mcp__ordewell__task_complete', ordewell: true }), 'h1', onEvent);

      expect(events).toEqual([{
        type: 'permission_request',
        id: 'r1',
        name: 'mcp__ordewell__task_complete',
        detail: '{"file_path":"/repo/a.txt"}',
        input: { file_path: '/repo/a.txt' },
        decided: { decision: 'allow' },
      }]);
      expect(replies).toEqual([['h1', { decision: 'allow' }]]);
      expect(permissions.answer('r1', { decision: 'deny' })).toBe(false);
    },
  );

  // A completion left unanswered holds the verdict hostage just as one put to
  // a person would: the consumer showing it failing is Ordewell's bug, and the
  // runner is answered regardless.
  it.each([['an Ordewell tool', TASK, true], ['an auto-approved request', AUTO_TASK, false]])(
    'answers %s even when showing it throws',
    (_label, stance, ordewell) => {
      const { permissions, replies } = ledger(stance);
      const raise = () => permissions.raise(request('r1', { ordewell }), 'h1', () => { throw new Error('consumer blew up'); });

      expect(raise).toThrow('consumer blew up');
      expect(replies).toEqual([['h1', { decision: 'allow' }]]);
    },
  );

  it('holds a planner\'s request open with what it is for and none of the runner\'s grants', () => {
    const { permissions, replies, events, onEvent } = ledger(PLANNER);
    permissions.raise(request('r1', { toolUseId: 'call_1' }), 'h1', onEvent);

    expect(events).toEqual([{
      type: 'permission_request',
      id: 'r1',
      name: 'Write',
      detail: '{"file_path":"/repo/a.txt"}',
      input: { file_path: '/repo/a.txt' },
      toolUseId: 'call_1',
      ask: { kind: 'path', path: '/etc/hosts', directory: false },
    }]);
    expect(replies).toEqual([]);
  });

  it('holds a task\'s request open with the runner\'s grants and no planner ask', () => {
    const { permissions, replies, events, onEvent } = ledger(TASK);
    permissions.raise(request('r1'), 'h1', onEvent);

    expect(events).toEqual([{
      type: 'permission_request',
      id: 'r1',
      name: 'Write',
      detail: '{"file_path":"/repo/a.txt"}',
      input: { file_path: '/repo/a.txt' },
      suggestions: [{ grant: 'session' }],
    }]);
    expect(replies).toEqual([]);
  });

  it('gives a task\'s request that offered no grants an empty list, so "Allow for this task" reads the same on every runner', () => {
    const { permissions, events, onEvent } = ledger(TASK);
    permissions.raise(request('r1', { suggestions: undefined }), 'h1', onEvent);

    expect(events[0]).toMatchObject({ suggestions: [] });
  });

  it('answers a task\'s request at once when its mode auto-approves, and shows it decided', () => {
    const { permissions, replies, events, onEvent } = ledger(AUTO_TASK);
    permissions.raise(request('r1'), 'h1', onEvent);

    expect(events).toEqual([{
      type: 'permission_request',
      id: 'r1',
      name: 'Write',
      detail: '{"file_path":"/repo/a.txt"}',
      input: { file_path: '/repo/a.txt' },
      decided: { decision: 'allow' },
    }]);
    expect(replies).toEqual([['h1', { decision: 'allow' }]]);
  });

  it('never auto-approves a planner\'s request', () => {
    const { permissions, replies, onEvent } = ledger({ role: 'planner', autoApprove: true });
    permissions.raise(request('r1'), 'h1', onEvent);

    expect(replies).toEqual([]);
  });

  it('answers an open request once, through the handle it was raised with', () => {
    const { permissions, replies, onEvent } = ledger(TASK);
    permissions.raise(request('r1'), 'h1', onEvent);
    permissions.raise(request('r2'), 'h2', onEvent);

    expect(permissions.answer('r2', { decision: 'deny', note: 'no' })).toBe(true);
    expect(permissions.answer('r2', { decision: 'allow' })).toBe(false);
    expect(permissions.answer('never', { decision: 'allow' })).toBe(false);
    expect(replies).toEqual([['h2', { decision: 'deny', note: 'no' }]]);
  });

  it('withdraws a request the runner settled itself, and only an open one', () => {
    const { permissions, replies, events, onEvent } = ledger(TASK);
    permissions.raise(request('r1'), 'h1', onEvent);
    permissions.withdraw('r1', onEvent);
    permissions.withdraw('r1', onEvent);
    permissions.withdraw(undefined, onEvent);

    expect(events.slice(1)).toEqual([{ type: 'permission_cancelled', id: 'r1' }]);
    expect(permissions.answer('r1', { decision: 'allow' })).toBe(false);
    expect(replies).toEqual([]);
  });

  it('cancels every request still open when the turn ends, once', () => {
    const { permissions, replies, events, onEvent } = ledger(PLANNER);
    permissions.raise(request('r1'), 'h1', onEvent);
    permissions.raise(request('r2'), 'h2', onEvent);
    permissions.answer('r1', { decision: 'allow' });
    permissions.raise(request('r3'), 'h3', onEvent);
    permissions.endTurn(onEvent);
    permissions.endTurn(onEvent);

    expect(events.slice(3)).toEqual([{ type: 'permission_cancelled', id: 'r2' }, { type: 'permission_cancelled', id: 'r3' }]);
    expect(permissions.answer('r2', { decision: 'allow' })).toBe(false);
    expect(replies).toEqual([['h1', { decision: 'allow' }]]);
  });

  it('reads its stance at each request, so a ledger made before the runner starts follows the start', () => {
    let stance = PLANNER;
    const replies: ApprovalDecision[] = [];
    const permissions = new PermissionLedger<string>((_handle, decision) => { replies.push(decision); }, () => stance);
    stance = AUTO_TASK;
    permissions.raise(request('r1'), 'h1', () => {});

    expect(replies).toEqual([{ decision: 'allow' }]);
  });
});
