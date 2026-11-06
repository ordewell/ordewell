import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RUN_SETTINGS_DEFAULTS } from '@ordewell/core';
import type { FrameApi } from '../../../frame/api';
import type { Tab } from '../../../frame/layout';
import { DaemonHost } from '../../../session/DaemonHost';
import { selectedTask } from '../../../session/selection';
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

function frameApi(): FrameApi {
  return { openTab: vi.fn(), announce: vi.fn() } as unknown as FrameApi;
}

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
    render(<TaskTab tab={TAB} host={host} api={frameApi()} />);

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
    render(<TaskTab tab={TAB} host={host} api={frameApi()} />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Chat' }));
    expect(await screen.findByRole('textbox', { name: 'Message #2 · Claude Code' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Chat' })).toHaveAttribute('aria-selected', 'true');
  });

  it('switches an open tab to its chat when a card asks to open it', async () => {
    const host = await openedHost();
    render(<TaskTab tab={TAB} host={host} api={frameApi()} />);
    await screen.findByRole('region', { name: 'Verdict' });

    act(() => requestTaskView('t1', 'chat'));
    expect(await screen.findByRole('textbox', { name: 'Message #2 · Claude Code' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'Details' }));
    act(() => requestTaskView('t1', 'chat'));
    expect(await screen.findByRole('textbox', { name: 'Message #2 · Claude Code' })).toBeInTheDocument();
  });

  it('heads the tab with its runner, its links and its actions', async () => {
    const host = await openedHost();
    const opened = vi.fn();
    const showPlan = vi.fn();
    host.setNavigator({ openTask: opened, openFile: vi.fn(), showPlan });
    const handle = vi.spyOn(host, 'handle').mockResolvedValue(undefined);
    render(<TaskTab tab={TAB} host={host} api={frameApi()} />);

    const header = (await screen.findByRole('heading', { name: '#2 Parse the config' })).closest('header') as HTMLElement;
    expect(within(header).getByText('Claude Code')).toBeInTheDocument();
    // A dependency's link shows it in the plan panel; only a chat opens a tab.
    fireEvent.click(within(header).getByRole('button', { name: '#1' }));
    expect(showPlan).toHaveBeenCalledTimes(1);
    expect(selectedTask(host)).toBe('t0');
    expect(opened).not.toHaveBeenCalled();

    // A passed task offers no Run; its first action is the header's button and the rest sit under ⋯.
    expect(within(header).queryByRole('button', { name: 'Run' })).toBeNull();
    fireEvent.click(within(header).getByRole('button', { name: 'Mark not done' }));
    expect(handle).toHaveBeenCalledWith({ type: 'sendSystemCommand', command: 'markIncomplete', taskId: 't1' });
    fireEvent.click(within(header).getByRole('button', { name: 'More for #2 Parse the config' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove…' }));
    expect(handle).toHaveBeenCalledWith({ type: 'removeTask', taskId: 't1' });
  });

  it('puts Log in first on a failed task whose agent is signed out, and asks the host', async () => {
    const failed = surfacePlan([surfaceTask({ id: 't1', order: 2, title: 'Parse the config', assignedRunner: 'codex', status: 'failed' })]);
    const daemon = fakeDaemon({
      'sessions.load': ok({ ok: true, plan: failed, goal: 'Ship the parser' }),
      'runners.list': ok({
        runners: [{
          id: 'codex', name: 'Codex', enabled: true,
          auth: { state: 'signed-out', loginCommand: ['codex', 'login'], signIn: { runner: 'codex', label: 'Codex', login: ['codex', 'login'] } },
        }],
        orchestratorModel: '',
      }),
      'models.list': ok({ models: [], modelsByRunner: {}, modesByRunner: {}, orchestratorModel: '', providers: [], orchestratorModels: [], providerErrors: {} }),
      'settings.get': ok({ orchestratorModel: '', aiProvider: 'codex', plannerThinkingEffort: '', autonomousMode: false, maxParallel: 3, modelAllowlist: {}, run: { ...RUN_SETTINGS_DEFAULTS } }),
    });
    const host = new DaemonHost('/work/acme');
    hosts.push(host);
    await act(() => host.handle({ type: 'ready' }));
    await act(() => host.open('s1'));
    const handle = vi.spyOn(host, 'handle').mockResolvedValue(undefined);
    render(<TaskTab tab={TAB} host={host} api={frameApi()} />);

    const header = (await screen.findByRole('heading', { name: '#2 Parse the config' })).closest('header') as HTMLElement;
    expect(header).toHaveTextContent('Sign in with /login codex, or run codex login.');
    fireEvent.click(within(header).getByRole('button', { name: 'Log in' }));
    expect(handle).toHaveBeenCalledWith({ type: 'loginPlanner', runner: 'codex' });
    expect(daemon.calls('sessions.load')).toHaveLength(1);
  });

  it('closes ⋯ on a second press of it and gives focus back to it after a pick', async () => {
    const host = await openedHost();
    vi.spyOn(host, 'handle').mockResolvedValue(undefined);
    render(<TaskTab tab={TAB} host={host} api={frameApi()} />);
    const more = await screen.findByRole('button', { name: 'More for #2 Parse the config' });

    fireEvent.click(more);
    expect(screen.getByRole('menu')).toBeInTheDocument();
    fireEvent.pointerDown(more);
    fireEvent.click(more);
    expect(screen.queryByRole('menu')).toBeNull();

    fireEvent.click(more);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove…' }));
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(more);
  });

  it('shows a task that has not run as having changed nothing', async () => {
    const host = await openedHost();
    render(<TaskTab tab={TAB} host={host} api={frameApi()} />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Changes' }));
    expect(screen.getByRole('tabpanel', { name: 'Changes' })).toBeInTheDocument();
  });

  it('says so when the task is not in the session\'s plan', async () => {
    const host = await openedHost();
    render(<TaskTab tab={{ ...TAB, id: 'gone' }} host={host} api={frameApi()} />);
    expect(await screen.findByText('This task is not in the session\'s plan.')).toBeInTheDocument();
  });
});
