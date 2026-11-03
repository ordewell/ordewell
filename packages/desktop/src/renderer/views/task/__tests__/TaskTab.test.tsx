import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { Tab } from '../../../frame/layout';
import { DaemonHost } from '../../../session/DaemonHost';
import { fakeDaemon, ok, surfacePlan, surfaceTask } from '../../../session/__tests__/fakeDaemon';
import { TaskTab } from '../TaskTab';
import { requestTaskView, resetTaskViews } from '../taskView';

const PLAN = surfacePlan([
  surfaceTask({ id: 't0', order: 1, title: 'Read the spec' }),
  surfaceTask({
    id: 't1',
    order: 2,
    title: 'Parse the config',
    prompt: 'Parse ordewell.json into a Config.',
    assignedRunner: 'claude-code',
    dependencies: ['t0'],
    status: 'completed',
    verdict: {
      outcome: 'pass',
      reason: 'The runner reported done',
      decidedAt: '2026-11-03T09:00:00.000Z',
      checks: [{ name: 'task_complete', passed: true, skipped: false, detail: 'done' }],
    },
    handoff: {
      summary: 'Config parsing lands in src/config.ts.',
      findings: [{ id: 'F1', severity: 'minor', title: 'Unknown keys are ignored' }],
      findingCount: 1,
    },
  }),
]);

const TAB: Tab = { kind: 'task', id: 't1', title: 'Parse the config', key: 'task::t1', preview: false, fixed: false };

let hosts: DaemonHost[] = [];
afterEach(() => {
  for (const host of hosts) host.dispose();
  hosts = [];
  resetTaskViews();
});

async function openedHost(): Promise<DaemonHost> {
  const daemon = fakeDaemon({
    'sessions.load': ok({ ok: true, plan: PLAN, goal: 'Ship the parser' }),
    'sessions.taskLog': ok({ attempts: [] }),
  });
  const host = new DaemonHost('/work/acme');
  hosts.push(host);
  await act(() => host.open('s1'));
  await act(async () => { daemon.push('s1', { type: 'connected', sessionId: 's1' }); });
  return host;
}

describe('TaskTab', () => {
  it('shows the task\'s details in the order a reader asks them', async () => {
    const host = await openedHost();
    render(<TaskTab tab={TAB} host={host} />);

    expect(await screen.findByRole('heading', { name: '#2 Parse the config' })).toBeInTheDocument();
    // The handoff card is a region of its own, inside its section: only the tab's own sections are in question.
    const sections = [...document.querySelectorAll('.session-task-details > section')].map((section) => section.getAttribute('aria-label'));
    expect(sections).toEqual(['Verdict', 'Prompt', 'Assignment', 'Depends on', 'Handoff section', 'Attempts']);

    expect(within(screen.getByRole('region', { name: 'Verdict' })).getByText(/The runner reported done/)).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Prompt' })).getByText('Parse ordewell.json into a Config.')).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Assignment' })).getByText(/^Claude Code · default model/)).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Depends on' })).getByText(/Read the spec/)).toBeInTheDocument();
    const handoff = screen.getByRole('region', { name: 'Handoff section' });
    expect(within(handoff).getByText(/Config parsing lands in src\/config.ts/)).toBeInTheDocument();
    expect(within(handoff).getByText(/Unknown keys are ignored/)).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Attempts' })).getByText('Not run yet.')).toBeInTheDocument();
  });

  it('chats with the task\'s runner under a composer that names the task and the runner', async () => {
    const host = await openedHost();
    render(<TaskTab tab={TAB} host={host} />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Chat' }));
    expect(await screen.findByRole('textbox', { name: 'Message #2 · Claude Code' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Chat' })).toHaveAttribute('aria-selected', 'true');
  });

  it('switches an open tab to its chat when a card asks to open it', async () => {
    const host = await openedHost();
    render(<TaskTab tab={TAB} host={host} />);
    await screen.findByRole('region', { name: 'Verdict' });

    act(() => requestTaskView('t1', 'chat'));
    expect(await screen.findByRole('textbox', { name: 'Message #2 · Claude Code' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'Details' }));
    act(() => requestTaskView('t1', 'chat'));
    expect(await screen.findByRole('textbox', { name: 'Message #2 · Claude Code' })).toBeInTheDocument();
  });

  it('says so when the task is not in the session\'s plan', async () => {
    const host = await openedHost();
    render(<TaskTab tab={{ ...TAB, id: 'gone' }} host={host} />);
    expect(await screen.findByText('This task is not in the session\'s plan.')).toBeInTheDocument();
  });
});
