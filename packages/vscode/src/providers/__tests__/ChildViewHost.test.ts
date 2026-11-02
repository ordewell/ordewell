import { describe, expect, it, vi } from 'vitest';
import type { ChildPlanHandle } from '@ordewell/core';
import { ChildViewHost } from '../ChildViewHost';
import type { HostToWebview } from '../../shared/protocol';

function selected(overrides: Partial<ChildPlanHandle>) {
  const entry = { sessionId: 'child', parent: 'root', node: '0/1', taskId: 'd', title: 'Delegate', depth: 1, state: 'parked' as const };
  const handle = { entry: () => entry, view: () => ({ child: entry, plan: null, run: { tasks: [], runMerge: null, handoff: null, mergeResult: null } }), watch: () => () => {}, ...overrides } as unknown as ChildPlanHandle;
  const directory = { list: async () => [entry], find: vi.fn(async (_id: string): Promise<ChildPlanHandle | null> => handle), onChange: () => () => {} };
  const post = vi.fn<(message: HostToWebview) => void>();
  return { host: new ChildViewHost(() => directory, post), post, directory };
}

describe('child view host', () => {
  it('reports a directory error to the waiting message composer', async () => {
    const entry = { sessionId: 'child', parent: 'root', node: '0/1', title: 'Delegate', depth: 1, state: 'parked' as const };
    const handle = { view: () => ({ child: entry, plan: null, run: { tasks: [], runMerge: null, handoff: null, mergeResult: null } }), watch: () => () => {} } as unknown as ChildPlanHandle;
    const find = vi.fn().mockResolvedValueOnce(handle).mockRejectedValueOnce(new Error('Tree unavailable'));
    const post = vi.fn();
    const tested = new ChildViewHost(() => ({ list: async () => [], find, onChange: () => () => {} }), post);
    await tested.open('child');
    await tested.message('child', 'Hello');
    expect(post).toHaveBeenCalledWith({ type: 'childMessageResult', childId: 'child', error: 'Tree unavailable' });
    tested.dispose();
  });
  it('closes a child when the root session changes', async () => {
    let root = 'root';
    const entry = { sessionId: 'child', parent: 'root', node: '0/1', title: 'Delegate', depth: 1, state: 'parked' as const };
    const handle = { view: () => ({ child: entry, plan: null, run: { tasks: [], runMerge: null, handoff: null, mergeResult: null } }), watch: () => () => {} } as unknown as ChildPlanHandle;
    const directory = { list: async () => [], find: async () => handle, onChange: () => () => {} };
    const post = vi.fn();
    const host = new ChildViewHost(() => directory, post, () => root);
    await host.refresh();
    await host.open('child');
    root = 'other';
    await host.refresh();
    expect(post).toHaveBeenCalledWith({ type: 'childClosed' });
    host.dispose();
  });
  it('refreshes the selected view when a child ends without another frame', async () => {
    let changed = () => {};
    const entry = { sessionId: 'child', parent: 'root', node: '0/1', taskId: 'd', title: 'Delegate', depth: 1, state: 'parked' as 'parked' | 'ended' };
    const handle = { entry: () => entry, view: () => ({ child: { ...entry }, plan: null, run: { tasks: [], runMerge: null, handoff: null, mergeResult: null } }), watch: () => () => {} } as unknown as ChildPlanHandle;
    const directory = { list: async () => [entry], find: async () => handle, onChange: (listener: () => void) => { changed = listener; return () => {}; } };
    const post = vi.fn();
    const host = new ChildViewHost(() => directory, post);
    host.start();
    await host.open('child');
    entry.state = 'ended';
    changed();
    await vi.waitFor(() => expect(post).toHaveBeenCalledWith(expect.objectContaining({ type: 'childView', view: expect.objectContaining({ child: expect.objectContaining({ state: 'ended' }) }) })));
    host.dispose();
  });
  it('reads and messages only the child selected through the directory', async () => {
    const entry = { sessionId: 'child', parent: 'root', node: '0/1', taskId: 'd', title: 'Delegate', depth: 1, state: 'parked' as const };
    const message = vi.fn(() => ({ ok: true as const, status: 'queued' as const }));
    const handle = { entry: () => entry, view: () => ({ child: entry, plan: null, run: { tasks: [], runMerge: null, handoff: null, mergeResult: null } }), watch: () => () => {}, message } as unknown as ChildPlanHandle;
    const directory = { list: async () => [entry], find: async (id: string) => id === 'child' ? handle : null, onChange: () => () => {} };
    const post = vi.fn();
    const host = new ChildViewHost(() => directory, post);
    await host.open('child');
    await host.message('child', 'Please check rounding.');
    expect(message).toHaveBeenCalledWith('Please check rounding.');
    expect(post).toHaveBeenCalledWith(expect.objectContaining({ type: 'childMessageResult', childId: 'child', status: 'queued' }));
    await host.message('other', 'wrong tree');
    expect(message).toHaveBeenCalledTimes(1);
    host.dispose();
  });
  it('tells the composer when the selection moved before a message reached its child', async () => {
    const message = vi.fn();
    const { host, post, directory } = selected({ message });
    await host.open('child');
    directory.find.mockImplementationOnce(async () => { host.close(); return null; });
    await host.message('child', 'Carry on');
    await host.message('child', 'Carry on');
    expect(message).not.toHaveBeenCalled();
    expect(post.mock.calls.filter(([sent]) => sent.type === 'childMessageResult' && sent.childId === 'child' && sent.error === 'The child plan is no longer open.')).toHaveLength(2);
    host.dispose();
  });
  it('closes a child that leaves the tree, rather than draw a plan nothing can reach', async () => {
    let changed = () => {};
    const { host, post, directory } = selected({});
    (directory as { onChange: (listener: () => void) => () => void }).onChange = (listener) => { changed = listener; return () => {}; };
    host.start();
    await host.open('child');
    post.mockClear();
    directory.find.mockResolvedValue(null);
    changed();
    await vi.waitFor(() => expect(post).toHaveBeenCalledWith({ type: 'childClosed' }));
    expect(post).toHaveBeenCalledWith({ type: 'childNotice', childId: 'child', message: 'The child plan is no longer open.' });
    expect(post).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'childView' }));
    host.dispose();
  });
  it('shows a returning webview the child it had open, its chat included', async () => {
    const entry = { sessionId: 'child', parent: 'root', node: '0/1', title: 'Delegate', depth: 1, state: 'parked' as const };
    const plan = { conversationHistory: [{ role: 'user', content: 'Check the rounding.', timestamp: '2026-11-02T10:00:00.000Z' }] };
    const { host, post } = selected({ view: () => ({ child: entry, plan, run: { tasks: [], runMerge: null, handoff: null, mergeResult: null } }) as never });
    await host.open('child');
    post.mockClear();
    host.resend();
    expect(post).toHaveBeenCalledWith(expect.objectContaining({ type: 'childView' }));
    expect(post).toHaveBeenCalledWith(expect.objectContaining({ type: 'childConversation', childId: 'child' }));
    host.close();
    post.mockClear();
    host.resend();
    expect(post).not.toHaveBeenCalled();
    host.dispose();
  });
  it('answers a question on the selected child, echoing it as it was read', async () => {
    const control = vi.fn(async () => ({ ok: true as const, message: 'Rejected.' }));
    const { host, post, directory } = selected({ control });
    await host.open('child');
    await host.answer({ childId: 'child', taskId: 'nested', question: 'Which rounding?', answer: 'reject', reason: 'Use floor.' });
    expect(directory.find).toHaveBeenCalledTimes(2);
    expect(control).toHaveBeenCalledWith('nested', { kind: 'checkpoint', answer: 'reject', question: 'Which rounding?', reason: 'Use floor.' });
    expect(post).toHaveBeenCalledWith({ type: 'childControlResult', childId: 'child', taskId: 'nested' });
    host.dispose();
  });
  it('shows the question now waiting when the one answered has moved on', async () => {
    const control = vi.fn(async () => ({ ok: false as const, code: 'not_waiting' as const, message: 'That checkpoint is not waiting any more.' }));
    const { host, post } = selected({ control });
    await host.open('child');
    post.mockClear();
    await host.answer({ childId: 'child', taskId: 'nested', question: 'Old question', answer: 'approve' });
    expect(post).toHaveBeenCalledWith({ type: 'childControlResult', childId: 'child', taskId: 'nested', error: 'That checkpoint is not waiting any more.' });
    expect(post).toHaveBeenCalledWith(expect.objectContaining({ type: 'childView' }));
    host.dispose();
  });
  it('never offers a Continue that a fresh retry may have taken away', async () => {
    const ended = { ok: false as const, code: 'view_only' as const, message: 'This child plan has ended, so it only reads. Continue its task to speak to it.' };
    const { host, post } = selected({ message: () => ended, control: async () => ended });
    await host.open('child');
    await host.message('child', 'Hello');
    await host.answer({ childId: 'child', taskId: 'nested', question: 'Which?', answer: 'approve' });
    expect(post).toHaveBeenCalledWith({ type: 'childMessageResult', childId: 'child', error: 'This child plan has ended, so it only reads.' });
    expect(post).toHaveBeenCalledWith({ type: 'childControlResult', childId: 'child', taskId: 'nested', error: 'This child plan has ended, so it only reads.' });
    host.dispose();
  });
  it('refuses an answer to a child that left the tree or is not the one on screen', async () => {
    const control = vi.fn(async () => ({ ok: true as const, message: 'Approved.' }));
    const { host, post, directory } = selected({ control });
    await host.answer({ childId: 'child', taskId: 'nested', question: 'Which?', answer: 'approve' });
    await host.open('child');
    directory.find.mockResolvedValueOnce(null);
    await host.answer({ childId: 'child', taskId: 'nested', question: 'Which?', answer: 'approve' });
    expect(control).not.toHaveBeenCalled();
    expect(post.mock.calls.filter(([message]) => message.type === 'childControlResult' && message.error === 'The child plan is no longer open.')).toHaveLength(2);
    host.dispose();
  });
});
