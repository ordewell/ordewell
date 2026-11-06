import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { openTaskLog, type ChildDirectory, type ChildPlanEntry, type ChildPlanHandle, type ChildControlOutcome, type ChildTaskControl, type TaskLogLocation } from '@ordewell/core';
import { CHILD_TASK_LOG_VIEW_TYPE, ChildTaskLogs } from '../ChildTaskLogs';
import type { HostToTaskLog, TaskLogStatus } from '@ordewell/ui/protocol';
import { __panels, __resetPanels, createFakeWebviewPanel, window } from '../../test/vscode.mock';

const createWebviewPanel = vscode.window.createWebviewPanel as unknown as ReturnType<typeof vi.fn>;
type Panel = (typeof __panels)[number];

interface FakeChild {
  entry: ChildPlanEntry;
  status: string;
  awaitingReason?: string;
  control: ReturnType<typeof vi.fn<(taskId: string, control: ChildTaskControl) => Promise<ChildControlOutcome>>>;
}

function tree() {
  const location: TaskLogLocation = { baseDir: fs.mkdtempSync(path.join(os.tmpdir(), 'child-logs-')), sessionId: 'nested', rootSessionId: 'root' };
  openTaskLog(location, 'runner').append([{ type: 'turn_start', message: 'do it' }]);
  const child: FakeChild = {
    entry: { sessionId: 'nested', parent: 'child', node: '0/1/1', taskId: 'n', title: 'Nested', depth: 2, state: 'working' },
    status: 'in_progress',
    control: vi.fn(async () => ({ ok: true, message: 'Sent.' })),
  };
  const handle = {
    entry: () => child.entry,
    view: () => ({
      child: child.entry,
      plan: { tasks: [{ id: 'runner', order: 1, title: 'Runner', type: 'structured', status: child.status, awaitingReason: child.awaitingReason, subtasks: [] }] },
      run: { tasks: [], runMerge: null, handoff: null, mergeResult: null },
    }),
    watch: () => () => {},
    control: child.control,
    logLocation: () => location,
  } as unknown as ChildPlanHandle;
  let changed = () => {};
  const directory = {
    find: vi.fn(async (id: string): Promise<ChildPlanHandle | null> => id === 'nested' ? handle : null),
    onChange: (listener: () => void) => { changed = listener; return () => {}; },
  } as unknown as Pick<ChildDirectory, 'find' | 'onChange'> & { find: ReturnType<typeof vi.fn> };
  const root = { id: 'root' };
  const logs = new ChildTaskLogs({ extensionUri: vscode.Uri.file('/ext'), directory: () => directory, rootId: () => root.id, openFile: vi.fn(), log: vi.fn() });
  return { logs, child, directory, root, changed: () => changed() };
}

function statuses(panel: Panel): TaskLogStatus[] {
  return panel.webview.postMessage.mock.calls.map((call) => call[0] as HostToTaskLog).flatMap((message) => (message.type === 'init' || message.type === 'status' ? [message.status] : []));
}

function restorablePanel(): Panel {
  return createFakeWebviewPanel(CHILD_TASK_LOG_VIEW_TYPE, 'Task 1 · Runner');
}

describe('a child runner tab', () => {
  beforeEach(() => {
    __resetPanels();
    createWebviewPanel.mockClear();
  });

  async function opened(h: ReturnType<typeof tree>): Promise<Panel> {
    await h.logs.open('nested', 'runner');
    const panel = __panels.at(-1)!;
    panel.__receive({ type: 'ready' });
    return panel;
  }

  it('speaks to the runner through the child found in the tree', async () => {
    const h = tree();
    const panel = await opened(h);
    h.directory.find.mockClear();

    panel.__receive({ type: 'sendTaskMessage', text: 'Check the edge case.' });

    await vi.waitFor(() => expect(h.child.control).toHaveBeenCalledWith('runner', { kind: 'message', text: 'Check the edge case.' }));
    expect(h.directory.find).toHaveBeenCalledWith('nested');
  });

  it('shows a refusal in the tab', async () => {
    const h = tree();
    h.child.control.mockResolvedValueOnce({ ok: false, code: 'refused', message: 'The budget is spent.' });
    const panel = await opened(h);

    panel.__receive({ type: 'sendTaskMessage', text: 'Go on.' });

    await vi.waitFor(() => expect(panel.webview.postMessage).toHaveBeenCalledWith({ type: 'showError', error: 'The budget is spent.', draft: 'Go on.' }));
  });

  it('refuses when the child has left the tree since the tab opened', async () => {
    const h = tree();
    const panel = await opened(h);
    h.directory.find.mockResolvedValueOnce(null);

    panel.__receive({ type: 'sendTaskMessage', text: 'Still there?' });

    await vi.waitFor(() => expect(panel.webview.postMessage).toHaveBeenCalledWith({ type: 'showError', error: 'This child plan is no longer in this session.', draft: 'Still there?' }));
    expect(h.child.control).not.toHaveBeenCalled();
  });

  it('offers only a message: a force, an interrupt or a Continue never reaches the child', async () => {
    const h = tree();
    const panel = await opened(h);

    for (const message of [
      { type: 'sendTaskMessageNow', text: 'Now!' }, { type: 'interruptTask' }, { type: 'continueTask', text: 'Again' },
      { type: 'resumeNow' }, { type: 'cancelResume' }, { type: 'removeQueuedTaskMessage', id: 'm' }, { type: 'sendQueuedTaskMessageNow', id: 'm' },
      { type: 'invokeTaskCommand', name: 'compact', args: '' }, { type: 'answerApproval', id: 'a', decision: { decision: 'allow' } },
    ]) panel.__receive(message);
    await new Promise((resolve) => setImmediate(resolve));

    expect(h.child.control).not.toHaveBeenCalled();
    expect(h.directory.find).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['an ended child', (child: FakeChild) => { child.entry = { ...child.entry, state: 'ended' }; }, 'This child plan has ended, so it only reads.'],
    ['a refused child', (child: FakeChild) => { child.entry = { ...child.entry, refused: 'The budget is spent.' }; }, 'The budget is spent.'],
    ['a task at its checkpoint', (child: FakeChild) => { child.status = 'awaiting_user'; child.awaitingReason = 'checkpoint'; }, 'This task is waiting at a checkpoint: answer it in the chat, on this subplanner.'],
    ['a finished task', (child: FakeChild) => { child.status = 'completed'; }, 'This task is not running, so it takes no message.'],
  ])('says why %s takes no message, as the tree changes', async (_name, change, note) => {
    const h = tree();
    const panel = await opened(h);
    expect(statuses(panel).at(-1)?.child).toEqual({ id: 'nested' });

    change(h.child);
    h.changed();

    expect(statuses(panel).at(-1)?.child).toEqual({ id: 'nested', note });
  });

  it('reveals the tab already open', async () => {
    const h = tree();
    const panel = await opened(h);

    await h.logs.open('nested', 'runner');

    expect(createWebviewPanel).toHaveBeenCalledTimes(1);
    expect(panel.reveal).toHaveBeenCalled();
  });

  it('says why nothing opened', async () => {
    const h = tree();

    await expect(h.logs.open('stranger', 'runner')).rejects.toThrow('This child plan is no longer in this session.');
    await expect(h.logs.open('nested', 'never-ran')).rejects.toThrow('This task has no runner chat yet.');
    expect(createWebviewPanel).not.toHaveBeenCalled();
  });

  it('closes with the root session it belongs to, and stays through a new tab of the same root', async () => {
    const h = tree();
    const panel = await opened(h);

    h.logs.rootChanged();
    expect(panel.dispose).not.toHaveBeenCalled();

    h.root.id = 'another';
    h.logs.rootChanged();
    expect(panel.dispose).toHaveBeenCalledTimes(1);
  });

  describe('across a reload', () => {
    it('comes back for a child and task the tree still holds', async () => {
      const h = tree();
      const panel = restorablePanel();

      await h.logs.restore(panel as unknown as vscode.WebviewPanel, { childId: 'nested', taskId: 'runner' });
      panel.__receive({ type: 'ready' });

      expect(panel.dispose).not.toHaveBeenCalled();
      expect(statuses(panel).at(-1)).toMatchObject({ taskId: 'runner', child: { id: 'nested' } });
      panel.__receive({ type: 'sendTaskMessage', text: 'After the reload.' });
      await vi.waitFor(() => expect(h.child.control).toHaveBeenCalledWith('runner', { kind: 'message', text: 'After the reload.' }));
    });

    it.each([
      ['no saved identity', undefined],
      ['a malformed identity', { childId: 7, taskId: 'runner' }],
      ['a child outside this tree', { childId: 'stranger', taskId: 'runner' }],
      ['a task the child does not hold', { childId: 'nested', taskId: 'other' }],
    ])('closes for %s', async (_name, state) => {
      const h = tree();
      const panel = restorablePanel();

      await h.logs.restore(panel as unknown as vscode.WebviewPanel, state);

      expect(panel.dispose).toHaveBeenCalledTimes(1);
    });

    it('closes when the directory cannot answer', async () => {
      const h = tree();
      h.directory.find.mockRejectedValueOnce(new Error('Tree unavailable'));
      const panel = restorablePanel();

      await h.logs.restore(panel as unknown as vscode.WebviewPanel, { childId: 'nested', taskId: 'runner' });

      expect(panel.dispose).toHaveBeenCalledTimes(1);
    });

    it('closes a second tab of the same runner', async () => {
      const h = tree();
      const first = restorablePanel();
      const second = restorablePanel();

      await Promise.all([
        h.logs.restore(first as unknown as vscode.WebviewPanel, { childId: 'nested', taskId: 'runner' }),
        h.logs.restore(second as unknown as vscode.WebviewPanel, { childId: 'nested', taskId: 'runner' }),
      ]);

      expect(first.dispose).not.toHaveBeenCalled();
      expect(second.dispose).toHaveBeenCalledTimes(1);
    });

    it('closes if the root changed while the tree was read', async () => {
      const h = tree();
      const panel = restorablePanel();

      const restoring = h.logs.restore(panel as unknown as vscode.WebviewPanel, { childId: 'nested', taskId: 'runner' });
      h.root.id = 'another';
      await restoring;

      expect(panel.dispose).toHaveBeenCalledTimes(1);
    });

    it('keeps no tab a person closed while the tree was read', async () => {
      const h = tree();
      const panel = restorablePanel();

      const restoring = h.logs.restore(panel as unknown as vscode.WebviewPanel, { childId: 'nested', taskId: 'runner' });
      panel.dispose();
      await restoring;

      expect(panel.dispose).toHaveBeenCalledTimes(1);
      await h.logs.open('nested', 'runner');
      expect(createWebviewPanel).toHaveBeenCalledTimes(1);
    });

    it('registers its serializer under its own view type', () => {
      tree().logs.register();

      expect(window.registerWebviewPanelSerializer).toHaveBeenCalledWith(CHILD_TASK_LOG_VIEW_TYPE, expect.anything());
    });

    it('declares the activation event VS Code fires to revive it', () => {
      const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../../../package.json'), 'utf8')) as { activationEvents?: string[] };

      expect(manifest.activationEvents).toContain(`onWebviewPanel:${CHILD_TASK_LOG_VIEW_TYPE}`);
    });
  });
});
