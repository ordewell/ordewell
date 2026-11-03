import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DaemonStatus } from '../../../../shared/bridge';
import { registerFrameCommands } from '../../../frame/commands';
import { Frame } from '../../../frame/Frame';
import { FrameProvider, FrameStore } from '../../../frame/store';
import { daemonHost, resetDaemonHosts, type DaemonHost } from '../../../session/DaemonHost';
import { fakeDaemon, ok, surfacePlan, surfaceTask } from '../../../session/__tests__/fakeDaemon';
import { diffEditors } from '../../../test/monacoMock';
import { fileTabId } from '../../explorer/fileTabs';
import { checkoutDiffTabId } from '../../checkout/checkoutTabs';
import { clearComments } from '../comments';
import { register } from '../DiffTab';
import { HANDOFF, runTask, runView, worktree } from './fixtures';

// Monaco needs a browser's layout and Vite's workers; a test gives it two strings and a selection.
vi.mock('../../../monaco', async () => (await import('../../../test/monacoMock')).fakeMonacoModule());

const WORKSPACE = '/work/acme';
const SIZES = { sidebar: 260, right: 360, bottom: 240 };
const CONNECTED: DaemonStatus = { state: 'connected', port: 3700, owned: true, daemon: { version: '0.12.3', contract: 1 } };

const TASKS = [
  runTask({ id: 't1', order: 1, title: 'Add the login button', status: 'completed', isolation: worktree('integrated') }),
  runTask({ id: 't3', order: 3, title: 'Wire SSO', status: 'in_progress', isolation: worktree('active') }),
];

const PATCH = [
  'diff --git a/src/sso.ts b/src/sso.ts',
  '--- a/src/sso.ts',
  '+++ b/src/sso.ts',
  '@@ -1,3 +1,3 @@',
  ' export function login() {',
  '-  return null;',
  '+  return okta();',
  ' }',
  '',
].join('\n');
const AFTER = 'export function login() {\n  return okta();\n}\n';

let store: FrameStore;
let offs: Array<() => void> = [];
beforeEach(() => { offs = []; diffEditors.length = 0; });
afterEach(() => {
  for (const off of offs) off();
  clearComments();
  resetDaemonHosts();
  vi.restoreAllMocks();
});

async function mount(): Promise<{ daemon: ReturnType<typeof fakeDaemon>; host: DaemonHost }> {
  const daemon = fakeDaemon({
    'sessions.load': ok({ ok: true, plan: surfacePlan(TASKS.map(({ id, order, title, status }) => surfaceTask({ id, order, title, status })), 'running'), goal: 'Ship SSO' }),
    'plans.taskDiff': () => ok({ available: true, text: `[repo .] src/sso.ts: +1 -1\n${PATCH}` }),
    'git.diff': () => ok({ files: [{ path: 'src/sso.ts', status: 'M', added: 1, removed: 1 }], patch: PATCH }),
    'files.content': () => ok({ kind: 'text', text: AFTER, hash: 'h1', size: AFTER.length }),
  });
  const host = daemonHost(WORKSPACE);
  await act(() => host.open('s1'));
  await act(async () => {
    daemon.push('s1', { type: 'connected', sessionId: 's1' }, { type: 'run_snapshot', sessionId: 's1', view: runView(TASKS, HANDOFF), stream: 'd1', seq: 0 });
  });
  store = new FrameStore({ workspace: WORKSPACE, platform: 'linux', sizes: SIZES });
  offs.push(registerFrameCommands(store), register(store.api));
  render(<FrameProvider value={store}><Frame daemon={CONNECTED} /></FrameProvider>);
  return { daemon, host };
}

async function openDiff(taskId: string): Promise<void> {
  act(() => store.api.openTab({ kind: 'diff', id: fileTabId('.', 'src/sso.ts'), title: 'sso.ts', scope: { kind: 'task', sessionId: 's1', taskId } }));
  await waitFor(() => expect(diffEditors).toHaveLength(1));
}

/** The person selects lines in the after side of the diff, as Monaco reports it. */
function select(startLine: number, endLine: number, text: string): void {
  act(() => diffEditors[0]!.options.onLines?.({ side: 'modified', startLine, endLine, text }));
}

describe('a diff tab', () => {
  it('draws the file\'s two sides and names the scope, repo and base it reads', async () => {
    const { host } = await mount();
    const openTask = vi.spyOn(host, 'openTask');
    await openDiff('t3');
    const editor = diffEditors[0]!;
    expect(editor.options.original.text).toBe('export function login() {\n  return null;\n}\n');
    expect(editor.options.modified.text).toBe(AFTER);

    const panel = within(screen.getByRole('tabpanel'));
    expect(panel.getByText('the workspace')).toBeInTheDocument();
    expect(panel.getByText('base main')).toBeInTheDocument();
    fireEvent.click(panel.getByRole('button', { name: 'Task #3 worktree' }));
    expect(openTask).toHaveBeenCalledWith('t3', 'details');

    fireEvent.click(panel.getByRole('button', { name: 'Unified' }));
    expect(editor.setSideBySide).toHaveBeenLastCalledWith(false);
    fireEvent.click(panel.getByRole('button', { name: 'Next change' }));
    expect(editor.goToChange).toHaveBeenLastCalledWith('next');
    act(() => store.api.runCommand('changes.previousChange'));
    expect(editor.goToChange).toHaveBeenLastCalledWith('previous');
  });

  it('sends a comment on the selected lines to the running task, quoting them, and keeps it shown', async () => {
    const { daemon } = await mount();
    await openDiff('t3');
    const comment = screen.getByRole('button', { name: 'Comment to task #3' });
    expect(comment).toBeDisabled();

    select(2, 2, '  return okta();');
    fireEvent.click(comment);
    const box = screen.getByRole('form', { name: 'Comment on src/sso.ts, line 2' });
    fireEvent.change(within(box).getByRole('textbox', { name: 'Comment to task #3' }), { target: { value: 'Read the provider from config.' } });
    fireEvent.click(within(box).getByRole('button', { name: 'Send to task #3' }));

    await waitFor(() => expect(daemon.calls('plans.executeCommand')).toEqual([[
      { sessionId: 's1' },
      { command: 'message_task', task: 't3', text: 'On src/sso.ts, line 2 of your change:\n>   return okta();\n\nRead the provider from config.' },
    ]]));
    const sent = await screen.findByRole('note', { name: 'Comment on src/sso.ts, line 2' });
    expect(sent).toHaveTextContent('Sent to task #3');
    expect(sent).toHaveTextContent('Read the provider from config.');
    expect(screen.queryByRole('form')).not.toBeInTheDocument();
  });

  it('keeps the comment and offers the planner when it does not reach the task', async () => {
    const { daemon, host } = await mount();
    daemon.answers['plans.executeCommand'] = { ok: false, status: 409, error: 'The task is not running.' };
    const askPlanner = vi.spyOn(host, 'askPlanner');
    await openDiff('t3');
    select(2, 2, '  return okta();');
    fireEvent.click(screen.getByRole('button', { name: 'Comment to task #3' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Comment to task #3' }), { target: { value: 'Use okta.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send to task #3' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/It did not reach task #3: .*The task is not running\./);
    expect(screen.getByRole('textbox', { name: 'Comment for the planner' })).toHaveValue('Use okta.');
    fireEvent.click(screen.getByRole('button', { name: 'Ask the planner' }));
    expect(askPlanner).toHaveBeenCalledWith('On src/sso.ts, line 2 of task #3\'s change:\n>   return okta();\n\nUse okta.');
  });

  it('turns a comment on a finished task into a question for the planner, its composer filled', async () => {
    const { daemon, host } = await mount();
    const askPlanner = vi.spyOn(host, 'askPlanner');
    await openDiff('t1');
    select(1, 2, 'export function login() {\n  return okta();');
    fireEvent.click(screen.getByRole('button', { name: 'Comment to task #1' }));

    const box = screen.getByRole('form', { name: 'Comment on src/sso.ts, lines 1–2' });
    expect(box).toHaveTextContent('Task #1 has finished, so it reads no more messages.');
    fireEvent.change(within(box).getByRole('textbox', { name: 'Comment for the planner' }), { target: { value: 'Add a test for this.' } });
    fireEvent.click(within(box).getByRole('button', { name: 'Ask the planner' }));

    expect(askPlanner).toHaveBeenCalledWith('On src/sso.ts, lines 1–2 of task #1\'s change:\n> export function login() {\n>   return okta();\n\nAdd a test for this.');
    expect(daemon.calls('plans.executeCommand')).toEqual([]);
    expect(await screen.findByRole('note', { name: 'Comment on src/sso.ts, lines 1–2' })).toHaveTextContent('Put in the planner’s composer');
  });

  it('draws the checkout\'s own change from the index against the working tree', async () => {
    const { daemon } = await mount();
    act(() => store.api.openTab({
      kind: 'diff',
      id: checkoutDiffTabId('.', 'src/sso.ts', 'unstaged'),
      title: 'sso.ts (Changes)',
      scope: { kind: 'checkout' },
    }));
    await waitFor(() => expect(diffEditors).toHaveLength(1));
    expect(diffEditors[0]!.options.original.text).toBe('export function login() {\n  return null;\n}\n');
    expect(diffEditors[0]!.options.modified.text).toBe(AFTER);
    expect(daemon.calls('git.diff').at(-1)).toEqual([
      { workspace: WORKSPACE, repo: '.', scope: 'checkout', kind: 'unstaged', path: 'src/sso.ts' },
      undefined,
    ]);
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Working tree');
  });
});
