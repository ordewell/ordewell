import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Escalation } from '@ordewell/core';
import { registerFrameCommands } from '../../../frame/commands';
import { Frame } from '../../../frame/Frame';
import { FrameProvider, FrameStore } from '../../../frame/store';
import { daemonHost, resetDaemonHosts } from '../../../session/DaemonHost';
import { selectedTask } from '../../../session/selection';
import { registerViews } from '../../index';
import { resetTaskViews } from '../../task/taskView';
import { fakeDaemon, ok, surfacePlan, surfaceTask } from '../../../session/__tests__/fakeDaemon';

// Monaco needs a browser; these views never open a file.
vi.mock('../../../monaco', async () => (await import('../../../test/monacoMock')).fakeMonacoModule());

const WORKSPACE = '/work/acme';
const PLAN = surfacePlan([
  surfaceTask({ id: 't1', order: 1, title: 'Read the auth module', assignedRunner: 'claude-code' }),
  surfaceTask({ id: 't2', order: 2, title: 'Add SAML callback route', dependencies: ['t1'] }),
], 'running');

const APPROVAL: Escalation = {
  id: 'approval:t2:1:a1',
  kind: 'approval',
  task: { id: 't2', ref: '#2', title: 'Add SAML callback route' },
  attempt: 1,
  approval: 'a1',
  reason: 'Its runner asks: npm i saml2-js',
  options: [{ id: 'allow', label: 'Allow' }, { id: 'deny', label: 'Deny', note: 'optional' }],
};

const FAILED: Escalation = {
  id: 'failed:t1:1',
  kind: 'failed',
  task: { id: 't1', ref: '#1', title: 'Read the auth module' },
  attempt: 1,
  reason: 'Tests failed (exit 1).',
  options: [
    { id: 'retry', label: 'Retry' },
    { id: 'complete', label: 'Mark complete', confirm: 'Mark #1 complete by hand?' },
  ],
};

const RUN = {
  tasks: PLAN.tasks,
  runMerge: null,
  handoff: null,
  mergeResult: null,
  escalations: [APPROVAL, FAILED],
};

let offs: Array<() => void> = [];
afterEach(() => {
  for (const off of offs) off();
  offs = [];
  resetDaemonHosts();
  resetTaskViews();
});

async function mount(answers: Parameters<typeof fakeDaemon>[0] = {}): Promise<{ store: FrameStore; host: ReturnType<typeof daemonHost>; daemon: ReturnType<typeof fakeDaemon> }> {
  const daemon = fakeDaemon({
    'sessions.load': ok({ ok: true, plan: PLAN, goal: 'Add SSO login' }),
    ...answers,
  });
  const store = new FrameStore({ workspace: WORKSPACE, platform: 'linux' });
  offs.push(registerFrameCommands(store), registerViews(store.api));
  const host = daemonHost(WORKSPACE);
  render(<FrameProvider value={store}><Frame daemon={{ state: 'connected', port: 3700, owned: true, daemon: { version: '0.12.3', contract: 1 } }} /></FrameProvider>);
  await act(() => host.open('s1'));
  await act(async () => {
    daemon.push('s1', { type: 'connected', sessionId: 's1' }, { type: 'run_snapshot', sessionId: 's1', view: RUN, stream: 'd1', seq: 0 });
  });
  return { store, host, daemon };
}

describe('the Needs you list', () => {
  it('counts what waits, names each wait, opens a question\'s chat and shows a failure on its card', async () => {
    const { store, host, daemon } = await mount();
    const navigator = { openTask: vi.fn(), openFile: vi.fn(), showPlan: vi.fn() };
    host.setNavigator(navigator);
    act(() => store.api.setNeedsYouCount(2));

    expect(screen.getByRole('button', { name: 'Needs you, 2' })).toBeInTheDocument();
    const sidebar = screen.getByRole('navigation', { name: 'Sessions' });
    expect(within(sidebar).getByText('#2 Add SAML callback route')).toBeInTheDocument();
    expect(within(sidebar).getByText('Its runner asks: npm i saml2-js')).toBeInTheDocument();
    expect(within(sidebar).getByText('Tests failed (exit 1).')).toBeInTheDocument();

    const second = within(sidebar).getByText('#2 Add SAML callback route').closest('li');
    expect(second).not.toBeNull();
    fireEvent.click(within(second as HTMLElement).getByRole('button', { name: 'Open #2 Add SAML callback route' }));
    expect(navigator.openTask).toHaveBeenCalledWith('t2', 'chat');

    // A failure is read on the task's card, in the plan panel, not in a tab.
    const first = within(sidebar).getByText('#1 Read the auth module').closest('li');
    fireEvent.click(within(first as HTMLElement).getByRole('button', { name: 'Open #1 Read the auth module' }));
    expect(navigator.showPlan).toHaveBeenCalledTimes(1);
    expect(selectedTask(host)).toBe('t1');
    expect(navigator.openTask).toHaveBeenCalledTimes(1);

    // The popover draws the same list.
    fireEvent.click(screen.getByRole('button', { name: 'Needs you, 2' }));
    const popover = screen.getByRole('dialog', { name: 'Needs you' });
    expect(within(popover).getByText('#2 Add SAML callback route')).toBeInTheDocument();

    expect(daemon.calls('plans.answerEscalation')).toEqual([]);
  });

  it('answers inline, asking first for an option that carries a note', async () => {
    const { daemon } = await mount();
    const sidebar = screen.getByRole('navigation', { name: 'Sessions' });

    fireEvent.click(within(sidebar).getByRole('button', { name: 'Deny: #2 Add SAML callback route' }));
    const form = within(sidebar).getByText('Note (optional)').closest('form');
    expect(form).not.toBeNull();
    fireEvent.change(within(form as HTMLElement).getByRole('textbox'), { target: { value: 'use the config file' } });
    fireEvent.submit(form as HTMLElement);

    await waitFor(() => expect(daemon.calls('plans.answerEscalation')).toHaveLength(1));
    expect(daemon.calls('plans.answerEscalation')[0]?.[1]).toMatchObject({ id: APPROVAL.id, option: 'deny', note: 'use the config file' });
  });

  it('stops every answer while the daemon is away, in the title bar\'s popover too (W15)', async () => {
    const { store, daemon } = await mount();
    act(() => store.api.setNeedsYouCount(2));
    act(() => store.api.setReadOnly(true));

    // The chip may still say how many wait, but the popover is drawn outside the inert body.
    fireEvent.click(screen.getByRole('button', { name: 'Needs you, 2' }));
    const popover = screen.getByRole('dialog', { name: 'Needs you' });
    const allow = within(popover).getByRole('button', { name: 'Allow: #2 Add SAML callback route' });
    expect(allow).toBeDisabled();
    expect(within(popover).getByRole('button', { name: 'Retry: #1 Read the auth module' })).toBeDisabled();
    fireEvent.click(allow);
    expect(daemon.calls('plans.answerEscalation')).toEqual([]);
  });

  it('asks for the confirmation an option carries before answering it', async () => {
    const { daemon } = await mount();
    const sidebar = screen.getByRole('navigation', { name: 'Sessions' });

    fireEvent.click(within(sidebar).getByRole('button', { name: 'Mark complete: #1 Read the auth module' }));
    expect(within(sidebar).getByText('Mark #1 complete by hand?')).toBeInTheDocument();
    fireEvent.click(within(sidebar).getByRole('button', { name: 'Yes, Mark complete' }));

    await waitFor(() => expect(daemon.calls('plans.answerEscalation')).toHaveLength(1));
    expect(daemon.calls('plans.answerEscalation')[0]?.[1]).toMatchObject({ id: FAILED.id, option: 'complete', confirmed: true });
  });

  it('shows a refused answer as a refusal, not a toast elsewhere', async () => {
    await mount({
      'plans.answerEscalation': { ok: false, status: 409, error: 'That wait has moved on.', data: { error: 'That wait has moved on.', code: 'refused' } },
    });
    const sidebar = screen.getByRole('navigation', { name: 'Sessions' });

    fireEvent.click(within(sidebar).getByRole('button', { name: 'Allow: #2 Add SAML callback route' }));
    await waitFor(() => expect(within(sidebar).getByRole('alert')).toHaveTextContent('Not done — Allow: #2 Add SAML callback route.'));
    expect(within(sidebar).getByRole('alert')).toHaveTextContent('That wait has moved on.');
    fireEvent.click(within(sidebar).getByRole('button', { name: 'Dismiss' }));
    expect(within(sidebar).queryByRole('alert')).not.toBeInTheDocument();
  });
});
