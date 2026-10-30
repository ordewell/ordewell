import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act, fireEvent, cleanup } from '@testing-library/react';
import { EMPTY_TASK_LOG, EMPTY_TASK_LOG_FOLLOW, taskLogHeaderView, type AccountLimitSnapshot, type AttemptUsage, type DisplayBlock, type RunnerCommand, type StructuredTurnEnd, type TaskLogFollow, type TaskLogHeaderTask, type TaskUsageSummary, type UsageTotals } from '@ordewell/core';
import { replayTaskLog } from '@ordewell/core/plan-utils';
import TaskLogApp from '../TaskLogApp';
import type { HostToTaskLog, TaskLogStatus } from '../../../shared/taskLogProtocol';

const api = (globalThis as unknown as { __vscodeApi: { postMessage: ReturnType<typeof vi.fn> } }).__vscodeApi;

function send(msg: HostToTaskLog): void {
  act(() => { window.dispatchEvent(new MessageEvent('message', { data: msg })); });
}

/**
 * The header fields the app used to take raw (`working`, `planStatus`, …) are
 * turned into a real log and read through core's one header view, so these
 * tests draw what the TUI draws rather than a hand-copied header.
 */
type StatusOverrides = Partial<TaskLogStatus> & {
  planStatus?: string;
  working?: boolean;
  awaitingReason?: TaskLogHeaderTask['awaitingReason'];
  skipReason?: string;
  resumeAt?: string;
  awaitingApproval?: number;
  continuable?: boolean;
  lastTurnEnd?: StructuredTurnEnd;
  usage?: Pick<TaskUsageSummary, 'totals' | 'contextFill'>;
  usageTotal?: Pick<TaskUsageSummary, 'totals' | 'contextFill'>;
  commands?: readonly RunnerCommand[];
};

function attemptOf(n: number, usage: Pick<TaskUsageSummary, 'totals' | 'contextFill'>): AttemptUsage {
  return {
    attempt: n, runner: 'claude-code', startedAt: '', wallTimeMs: 0, totals: usage.totals, byModel: [],
    ...(usage.contextFill
      ? { lastPromptTokens: usage.contextFill.usedTokens, ...(usage.contextFill.windowTokens ? { contextWindow: usage.contextFill.windowTokens } : {}) }
      : {}),
  };
}

/** What a second attempt adds to reach a stated task total, for the past-attempt case below. */
function remainder(total: UsageTotals, own: UsageTotals): UsageTotals {
  const left: UsageTotals = { ...total };
  for (const key of ['inputTokens', 'outputTokens', 'cachedInputTokens'] as const) {
    const value = (total[key] ?? 0) - (own[key] ?? 0);
    if (value > 0) left[key] = value; else delete left[key];
  }
  const cost = Object.entries(total.reportedCost ?? {}).flatMap(([currency, amount]) => {
    const value = amount - (own.reportedCost?.[currency] ?? 0);
    return value > 0 ? [[currency, value] as const] : [];
  });
  if (cost.length > 0) left.reportedCost = Object.fromEntries(cost); else delete left.reportedCost;
  return left;
}

function status(over: StatusOverrides = {}): TaskLogStatus {
  const {
    planStatus = 'in_progress', working = false, awaitingReason, skipReason, resumeAt,
    awaitingApproval = 0, continuable = false, lastTurnEnd, usage, usageTotal, commands,
    attempt = 1, attempts = [1], ...rest
  } = over;
  const ledger = usageTotal && usage
    ? [attemptOf(1, usage), attemptOf(2, { totals: remainder(usageTotal.totals, usage.totals), ...(usageTotal.contextFill ? { contextFill: usageTotal.contextFill } : {}) })]
    : usage ? [attemptOf(1, usage)] : [];
  const view = {
    ...EMPTY_TASK_LOG,
    working,
    ...(lastTurnEnd ? { lastTurnEnd } : {}),
    ...(commands?.length ? { blocks: [{ type: 'runner_loaded' as const, id: 'r', commands: [...commands], mcpServers: [] }] } : {}),
  };
  const follow: TaskLogFollow = { ...EMPTY_TASK_LOG_FOLLOW, view, attempts, attempt };
  return {
    taskId: 't1', order: 2, title: 'Parse JSON', runner: 'claude-code',
    header: taskLogHeaderView({
      status: planStatus,
      ...(awaitingReason ? { awaitingReason } : {}),
      ...(skipReason !== undefined ? { skipReason } : {}),
      resumeAt: resumeAt ?? null,
      continuable,
      attemptUsage: ledger,
    }, follow, awaitingApproval, attempt),
    taskStatus: planStatus, idleSince: null, turnStartedAt: null,
    queued: [], attempts, attempt,
    ...rest,
  };
}

const message = (id: string, text: string): DisplayBlock => ({ type: 'message', id, role: 'agent', text, streaming: false });

function init(overrides: StatusOverrides = {}, blocks: DisplayBlock[] = [message('b1', 'hello from the agent')]): void {
  send({ type: 'init', status: status(overrides), blocks });
}

/** Each footer row as a reader sees it: the limits' screen-reader description is in the DOM but never drawn. */
function visibleFooter(): string[] {
  return [...document.querySelectorAll('.usage-line')].map((line) => {
    const drawn = line.cloneNode(true) as Element;
    drawn.querySelectorAll('.account-limit-details').forEach((details) => details.remove());
    return drawn.textContent ?? '';
  });
}

const claudeLimits: AccountLimitSnapshot = {
  harness: 'claude-code', label: 'Claude Code', status: 'fresh', plan: 'Pro',
  buckets: [{ id: 'claude-code', windows: [{ slot: 'primary', usedPercent: 18, durationMinutes: 300, resetsAt: null }] }],
  readAt: '2026-03-02T10:00:00.000Z',
};

describe('the task log tab (ADR-0018, V1)', () => {
  beforeEach(() => {
    cleanup();
    api.postMessage.mockClear();
  });

  it('names a subtask by its dotted reference in the header', () => {
    render(<TaskLogApp />);
    init({ orderLabel: '2.1' });

    expect(document.querySelector('.task-log-title')?.textContent).toBe('Task 2.1 · Parse JSON');
  });

  it('draws a handoff from the attempt log and opens its full report with the report\'s own disclosure', () => {
    const report = Array.from({ length: 12 }, (_, i) => `Report line ${i + 1}`).join('\n');
    const view = replayTaskLog([{ type: 'handoff', handoff: {
      summary: 'Check the token boundary.', findingCount: 2,
      findings: [
        { id: 'F1', severity: 'blocker', title: 'Token escapes', detail: 'A sibling can read it.', evidence: [
          { kind: 'file', path: 'src/token.ts', line: 42 },
          { kind: 'commit', sha: 'abc123', repo: 'core', resolved: true },
          { kind: 'task', task: '#3', finding: 'F2' },
          { kind: 'url', url: 'https://example.com/evidence' },
        ] },
        { id: 'F2', severity: 'info', title: 'Checked the fallback' },
      ], artifacts: [{ kind: 'file', path: 'docs/result.md' }], report,
    } }]);
    render(<TaskLogApp />);
    init({ planStatus: 'completed' }, [...view.blocks]);
    expect(screen.getByText('Handoff · 2 findings · Blocker')).toBeTruthy();
    expect(screen.getByText('Check the token boundary.')).toBeTruthy();
    expect(screen.getByText('F1 · Blocker · Token escapes')).toBeTruthy();
    expect(screen.getByText('A sibling can read it.')).toBeTruthy();
    expect(screen.getByText(/src\/token.ts:42 \(unresolved\)/)).toBeTruthy();
    expect(screen.getByText(/commit abc123 in core/)).toBeTruthy();
    expect(screen.getByText(/commit abc123 in core/)).not.toHaveTextContent('commit abc123 in core (unresolved)');
    expect(screen.getByText(/task #3 F2/)).toBeTruthy();
    expect(screen.getByText(/https:\/\/example.com\/evidence/)).toBeTruthy();
    expect(screen.getByText('docs/result.md (unresolved)')).toBeTruthy();
    expect(document.querySelector('.task-handoff-report')).toHaveTextContent('Report line 8');
    expect(document.querySelector('.task-handoff-report')).not.toHaveTextContent('Report line 9');
    const more = screen.getByRole('button', { name: '+4 lines of the report' });
    expect(more).toHaveAttribute('aria-expanded', 'false');
    expect(more).toHaveAttribute('aria-controls', document.querySelector('.task-handoff-report')!.id);
    expect(screen.queryByRole('button', { name: /expand all|collapse all/i })).toBeNull();
    fireEvent.click(more);
    expect(document.querySelector('.task-handoff-report')?.textContent).toBe(report);
    expect(more).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Show less of the report' }));
    expect(document.querySelector('.task-handoff-report')).not.toHaveTextContent('Report line 9');
    expect(screen.getByText('Done')).toBeTruthy();
  });

  it.each(['script', 'user'])('draws a %s handoff with no findings and nothing to open for a short report', (kind) => {
    render(<TaskLogApp />);
    const view = replayTaskLog([{ type: 'handoff', handoff: {
      summary: `${kind} finished`, findings: [], findingCount: 0, report: 'Short report',
    } }]);
    init({ planStatus: 'completed' }, [...view.blocks]);
    expect(screen.getByText('Handoff · no findings')).toBeTruthy();
    expect(screen.getByText(`${kind} finished`)).toBeTruthy();
    expect(screen.getByText('Short report')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /of the report|expand all/i })).toBeNull();
  });

  it('replaces a live handoff through a patch and drops it when switching attempts', () => {
    render(<TaskLogApp />);
    init();
    const block: DisplayBlock = { type: 'handoff', id: 'handoff', handoff: {
      summary: '<script>author text</script>', findings: [], findingCount: 3,
    } };
    send({ type: 'patch', order: [block.id], changed: [block] });
    expect(screen.getByText('<script>author text</script>')).toBeTruthy();
    expect(document.querySelector('.task-handoff script')).toBeNull();
    expect(screen.getByText("+3 more findings, in the attempt's log")).toBeTruthy();
    send({ type: 'patch', order: [block.id], changed: [{ ...block, handoff: { summary: 'Restated', findings: [], findingCount: 0 } }] });
    expect(document.querySelectorAll('.task-handoff')).toHaveLength(1);
    expect(screen.queryByText('<script>author text</script>')).toBeNull();
    init({ attempt: 2, attempts: [1, 2] }, []);
    expect(screen.queryByText('Restated')).toBeNull();
  });

  it('offers no interrupt or send-now on a settled task with a stale open turn', () => {
    render(<TaskLogApp />);
    init({ planStatus: 'completed', working: true });
    expect(screen.getByText('Done')).toBeTruthy();
    expect(screen.queryByLabelText('Interrupt')).toBeNull();
    const input = screen.getByPlaceholderText(/Message the task/);
    fireEvent.keyDown(input, { key: 'Escape' });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(api.postMessage).not.toHaveBeenCalledWith({ type: 'interruptTask' });
    fireEvent.change(input, { target: { value: 'another detail' } });
    expect(screen.getByLabelText('Send').getAttribute('title')).toBe('Send (Enter)');
  });

  it('pins the task\'s whole spend below the log and follows it as usage arrives', () => {
    render(<TaskLogApp />);
    init();
    expect(screen.queryByRole('status')).toBeNull();

    send({ type: 'status', status: status({ usage: { totals: { inputTokens: 12400, outputTokens: 3100, cachedInputTokens: 2000, reportedCost: { USD: 0.42 } }, contextFill: { usedTokens: 36_000, windowTokens: 200_000 } } }) });
    expect(visibleFooter()).toEqual(['ctx 36k (18%) · $0.42']);
    expect(screen.getAllByRole('status').map((region) => region.textContent)).toEqual(['ctx 36k (18%)', '$0.42']);
    expect(screen.getByText(/ctx 36k/)).toHaveAttribute('title', '36,000 of 200,000 tokens');

    send({ type: 'status', status: status({ usage: { totals: { inputTokens: 13000, outputTokens: 3200 }, contextFill: { usedTokens: 13_000 } } }) });
    expect(screen.getByRole('status')).toHaveTextContent(/^ctx 13k$/);

    send({ type: 'status', status: status({ usage: { totals: { inputTokens: 13000, outputTokens: 3200 } } }) });
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('draws an earlier attempt\'s own spend above the task total', () => {
    render(<TaskLogApp />);
    init({
      attempt: 1, attempts: [1, 2],
      usage: { totals: { inputTokens: 1000, reportedCost: { USD: 0.5 } }, contextFill: { usedTokens: 10_000, windowTokens: 200_000 } },
      usageTotal: { totals: { inputTokens: 1500, reportedCost: { USD: 1.5 } }, contextFill: { usedTokens: 50_000, windowTokens: 200_000 } },
    });

    const lines = [...document.querySelectorAll('.usage-line')].map((el) => el.textContent);
    expect(lines).toEqual(['attempt 1: ctx 10k (5%) · $0.50', 'task total: ctx 50k (25%) · $1.50']);
  });

  it('keeps an earlier attempt\'s own row unchanged and draws live limits once, after the task total\'s context, as the TUI does', () => {
    render(<TaskLogApp />);
    send({ type: 'accountLimits', limits: [claudeLimits] });
    init({
      attempt: 1, attempts: [1, 2],
      usage: { totals: { inputTokens: 1000, reportedCost: { USD: 0.5 } }, contextFill: { usedTokens: 10_000, windowTokens: 200_000 } },
      usageTotal: { totals: { inputTokens: 1500, reportedCost: { USD: 1.5 } }, contextFill: { usedTokens: 50_000, windowTokens: 200_000 } },
    });

    expect(visibleFooter()).toEqual(['attempt 1: ctx 10k (5%) · $0.50', 'task total: ctx 50k (25%) · Claude Code 5h 18% used · $1.50']);
    expect(document.querySelectorAll('.account-limit')).toHaveLength(1);
    expect(document.querySelector('.account-limit')!.closest('.usage-line')!.className).toContain('usage-line-total');
    expect(document.querySelector('.account-limits')!.closest('[role="status"]')).toBeNull();
    expect(screen.getByText('task total: ctx 50k (25%)')).toHaveAttribute('title', '50,000 of 200,000 tokens');

    init({ usage: { totals: { inputTokens: 500, reportedCost: { USD: 1 } }, contextFill: { usedTokens: 40_000, windowTokens: 200_000 } } });
    expect(visibleFooter()).toEqual(['ctx 40k (20%) · Claude Code 5h 18% used · $1.00']);
  });

  it('joins only the known parts around the limits when the context, the cost or a percentage is missing', () => {
    render(<TaskLogApp />);
    send({ type: 'accountLimits', limits: [{ ...claudeLimits, buckets: [{ id: 'claude-code', windows: [
      { slot: 'primary', usedPercent: 18, durationMinutes: 300, resetsAt: null },
      { slot: 'secondary', usedPercent: null, durationMinutes: 10080, resetsAt: null },
    ] }] }] });
    init();
    expect(visibleFooter()).toEqual(['Claude Code 5h 18% used']);

    init({ usage: { totals: { inputTokens: 10 }, contextFill: { usedTokens: 13_000 } } });
    expect(visibleFooter()).toEqual(['ctx 13k · Claude Code 5h 18% used']);

    init({ usage: { totals: { inputTokens: 10, reportedCost: { USD: 0.42 } } } });
    expect(visibleFooter()).toEqual(['Claude Code 5h 18% used · $0.42']);

    init({ attempt: 1, attempts: [1, 2], usage: { totals: { reportedCost: { USD: 0.5 } } }, usageTotal: { totals: { reportedCost: { USD: 1.5 } } } });
    expect(visibleFooter()).toEqual(['attempt 1: $0.50', 'Claude Code 5h 18% used · task total: $1.50']);
  });

  it('completes only the runner commands and sends a command with arguments', () => {
    render(<TaskLogApp />);
    init({ working: true, commands: [{ name: 'compact', description: 'Compact native context', argumentHint: '[focus]', kind: 'builtin' }] });
    const input = screen.getByPlaceholderText(/Message the task/);
    fireEvent.change(input, { target: { value: '/' } });
    expect(screen.getByRole('listbox')).toHaveTextContent('/compact');
    expect(screen.getByRole('listbox')).toHaveTextContent('Compact native context');
    expect(screen.getByRole('listbox')).toHaveTextContent('[focus]');
    expect(screen.queryByText('/approve')).toBeNull();
    fireEvent.keyDown(input, { key: 'Tab' });
    expect(input).toHaveValue('/compact ');
    fireEvent.change(input, { target: { value: '/compact keep API details' } });
    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true });
    expect(api.postMessage).toHaveBeenCalledWith({ type: 'invokeTaskCommand', name: 'compact', args: 'keep API details' });
  });

  it('draws command results, automatic compaction and collapsed runner configuration', () => {
    render(<TaskLogApp />);
    const view = replayTaskLog([
      { type: 'runner_loaded', commands: [{ name: 'review', kind: 'skill', description: 'Review code' }], mcpServers: [{ name: 'docs', status: 'connected' }] },
      { type: 'command', name: 'compact', args: 'keep APIs' },
      { type: 'command_output', text: 'Native context summary' },
      { type: 'compaction', trigger: 'auto', preTokens: 12000, postTokens: 3000 },
      { type: 'turn_end', reason: 'completed' },
    ]);
    init({}, [...view.blocks]);
    expect(screen.getByText('/compact keep APIs')).toBeTruthy();
    expect(screen.getByText('done')).toBeTruthy();
    expect(screen.getByText('Native context summary')).toBeTruthy();
    const groups = () => [...document.querySelectorAll<HTMLButtonElement>('.activity-group-toggle')];
    expect(groups().map((g) => g.textContent)).toEqual(["Loaded the runner's setup", 'Compacted the context']);
    groups().forEach((g) => fireEvent.click(g));
    expect(screen.getByText('Context compacted by the runner on its own · 12k → 3k tokens')).toBeTruthy();
    expect(screen.getByText(/Runner loaded 1 skill/)).toBeTruthy();
    expect(screen.queryByText('docs (connected)')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Runner loaded 1 skill/ }));
    expect(screen.getByText('docs (connected)')).toBeTruthy();
    expect(screen.getByText('/review')).toBeTruthy();
  });

  it('offers no palette when no commands are reported and sends slash text as typed', () => {
    render(<TaskLogApp />);
    init({ commands: [], working: true });
    const input = screen.getByPlaceholderText(/Message the task/);
    fireEvent.change(input, { target: { value: '/' } });
    expect(screen.queryByRole('listbox')).toBeNull();
    fireEvent.change(input, { target: { value: '/custom details' } });
    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true });
    expect(api.postMessage).toHaveBeenCalledWith({ type: 'sendTaskMessageNow', text: '/custom details' });
  });

  it('refuses Ordewell commands in a task and lets Escape close completion before interrupting', () => {
    render(<TaskLogApp />);
    init({ working: true, commands: [{ name: 'compact', kind: 'builtin', description: 'Native compaction' }] });
    const input = screen.getByPlaceholderText(/Message the task/);
    fireEvent.change(input, { target: { value: '/' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(screen.queryByText('Press Esc again to stop')).toBeNull();
    fireEvent.change(input, { target: { value: '/run' } });
    fireEvent.click(screen.getByLabelText('Send'));
    expect(screen.getByRole('alert')).toHaveTextContent('The runner does not offer that command');
    expect(api.postMessage).toHaveBeenCalledTimes(1);
    expect(input).toHaveValue('/run');
  });

  it('asks the host for the log when it mounts', () => {
    render(<TaskLogApp />);
    expect(api.postMessage).toHaveBeenCalledWith({ type: 'ready' });
  });

  it('draws the saved blocks through the chat components', () => {
    render(<TaskLogApp />);
    init();

    expect(screen.getByText('Task 2 · Parse JSON')).toBeTruthy();
    expect(screen.getByText('hello from the agent')).toBeTruthy();
  });

  it('applies a live patch to the blocks it was sent', () => {
    render(<TaskLogApp />);
    init({}, [message('b1', 'first')]);
    send({ type: 'patch', order: ['b1', 'b2'], changed: [message('b2', 'second')] });

    expect(screen.getByText('first')).toBeTruthy();
    expect(screen.getByText('second')).toBeTruthy();
  });

  it('shows the live state and sends a message on Send', () => {
    render(<TaskLogApp />);
    init({ working: true, awaitingReason: 'input' });
    expect(screen.getByText('Working')).toBeTruthy();

    const input = screen.getByPlaceholderText(/Message the task/);
    act(() => { fireEvent.change(input, { target: { value: 'use Postgres' } }); });
    act(() => { fireEvent.click(screen.getByLabelText('Send')); });

    expect(api.postMessage).toHaveBeenCalledWith({ type: 'sendTaskMessage', text: 'use Postgres' });
  });

  it('says what a waiting task waits on, and why a skipped one was skipped', () => {
    render(<TaskLogApp />);
    init({ planStatus: 'awaiting_user', awaitingReason: 'files-changed' });
    expect(screen.getByText('Changed tracked files', { selector: '.task-log-state' })).toBeTruthy();

    send({ type: 'status', status: status({ planStatus: 'skipped', skipReason: 'no GPU on this host' }) });
    expect(screen.getByText('Skipped: no GPU on this host', { selector: '.task-log-state' })).toBeTruthy();
  });

  it('shows an undelivered message from the task log with an empty queue', () => {
    render(<TaskLogApp />);
    const view = replayTaskLog([
      { type: 'message_queued', messageId: 'm1', text: 'use Postgres' },
      { type: 'message_undelivered', messageId: 'm1', text: 'use Postgres' },
    ]);
    init({ queued: [...view.queued] }, [...view.blocks]);
    expect(screen.getByText('use Postgres · not delivered')).toBeTruthy();
    expect(screen.queryByTitle('Remove this message')).toBeNull();
  });

  it('shows the completion reminder as Ordewell\'s, not the user\'s', () => {
    render(<TaskLogApp />);
    const view = replayTaskLog([{ type: 'turn_start', message: 'Call task_complete.', from: 'ordewell' }]);
    init({}, [...view.blocks]);
    expect(screen.getByText('Ordewell: Call task_complete.')).toBeTruthy();
  });

  it('stacks pending messages above the composer, with no heading, and takes one back', () => {
    render(<TaskLogApp />);
    init({ queued: [{ id: 'q1', text: 'then add tests' }] });

    expect(screen.getByRole('list', { name: 'Pending messages' }).nextElementSibling?.classList.contains('task-log-composer')).toBe(true);
    expect(screen.getByText('then add tests')).toBeTruthy();
    expect(screen.queryByText(/^Queued/)).toBeNull();
    act(() => { fireEvent.click(screen.getByLabelText('Remove pending message: then add tests')); });
    expect(api.postMessage).toHaveBeenCalledWith({ type: 'removeQueuedTaskMessage', id: 'q1' });
  });

  describe('Send now (ADR-0023, F1)', () => {
    it('is a key, not a second button: a hint and the Send tooltip name it while a turn is live and something is typed', () => {
      render(<TaskLogApp />);
      init({ working: true });
      expect(document.querySelector('.send-key-hint')).toBeNull();

      const input = screen.getByPlaceholderText(/Message the task/);
      act(() => { fireEvent.change(input, { target: { value: 'stop, use Postgres' } }); });

      expect(document.querySelectorAll('.task-log-composer button')).toHaveLength(1);
      expect(document.querySelector('.send-key-hint')?.textContent).toBe('Enter queue · Ctrl+Enter send now');
      expect(screen.getByLabelText('Send').getAttribute('title')).toBe('Queue (Enter) · Send now (Ctrl+Enter)');

      act(() => { fireEvent.keyDown(input, { key: 'Enter', metaKey: true }); });
      expect(api.postMessage).toHaveBeenCalledWith({ type: 'sendTaskMessageNow', text: 'stop, use Postgres' });
      expect((input as HTMLTextAreaElement).value).toBe('');
    });

    it('force sends on Ctrl+Enter while a turn is live, and plain sends when none is', () => {
      render(<TaskLogApp />);
      init({ working: true });
      const input = screen.getByPlaceholderText(/Message the task/);
      act(() => { fireEvent.change(input, { target: { value: 'now' } }); });
      act(() => { fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true }); });
      expect(api.postMessage).toHaveBeenCalledWith({ type: 'sendTaskMessageNow', text: 'now' });

      send({ type: 'status', status: status({ working: false }) });
      act(() => { fireEvent.change(input, { target: { value: 'later' } }); });
      act(() => { fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true }); });
      expect(api.postMessage).toHaveBeenCalledWith({ type: 'sendTaskMessage', text: 'later' });
      act(() => { fireEvent.change(input, { target: { value: 'later still' } }); });
      expect(document.querySelector('.send-key-hint')).toBeNull();
    });

    it('is not offered on a finished task, whose box continues it', () => {
      render(<TaskLogApp />);
      init({ working: true, planStatus: 'completed', continuable: true });
      act(() => { fireEvent.change(screen.getByPlaceholderText(/Continue the task/), { target: { value: 'more' } }); });
      expect(document.querySelector('.send-key-hint')).toBeNull();
      expect(screen.getByLabelText('Continue').getAttribute('title')).toBe('Continue (Enter)');
    });

    it('is on each pending message the runner already has too, and each says where it stands', () => {
      render(<TaskLogApp />);
      init({ working: true, queued: [{ id: 'q0', text: 'stop now', forced: true }, { id: 'q1', text: 'then add tests' }, { id: 'q2', text: 'handed', handedOver: true }] });

      const states = [...document.querySelectorAll('.pending-message-state')].map((el) => el.textContent);
      expect(states).toEqual(['sending now…', 'queued', 'waiting for the current step']);
      expect(screen.queryByLabelText('Send now: stop now')).toBeNull();
      act(() => { fireEvent.click(screen.getByLabelText('Send now: then add tests')); });
      act(() => { fireEvent.click(screen.getByLabelText('Send now: handed')); });
      expect(api.postMessage).toHaveBeenCalledWith({ type: 'sendQueuedTaskMessageNow', id: 'q1' });
      expect(api.postMessage).toHaveBeenCalledWith({ type: 'sendQueuedTaskMessageNow', id: 'q2' });
    });

    it('offers × only on a message still in Ordewell\'s queue', () => {
      render(<TaskLogApp />);
      init({ working: true, queued: [{ id: 'q0', text: 'stop now', forced: true }, { id: 'q1', text: 'then add tests' }, { id: 'q2', text: 'handed', handedOver: true }] });

      expect([...document.querySelectorAll('.pending-message-remove')].map((el) => el.getAttribute('aria-label')))
        .toEqual(['Remove pending message: then add tests']);
    });

    it('sends a pending message now on Ctrl+Enter while focus is on it', () => {
      render(<TaskLogApp />);
      init({ working: true, queued: [{ id: 'q2', text: 'handed', handedOver: true }] });

      act(() => { fireEvent.keyDown(screen.getByLabelText('Send now: handed'), { key: 'Enter', ctrlKey: true }); });
      expect(api.postMessage).toHaveBeenCalledWith({ type: 'sendQueuedTaskMessageNow', id: 'q2' });
    });
  });

  it('is one button: disabled when idle and empty, Stop while a turn is live and empty, Send once typed', () => {
    render(<TaskLogApp />);
    init({ working: false });
    expect((screen.getByLabelText('Send') as HTMLButtonElement).disabled).toBe(true);

    send({ type: 'status', status: status({ working: true }) });
    act(() => { fireEvent.click(screen.getByLabelText('Interrupt')); });
    expect(api.postMessage).toHaveBeenCalledWith({ type: 'interruptTask' });

    act(() => { fireEvent.change(screen.getByPlaceholderText(/Message the task/), { target: { value: 'wait, use Postgres' } }); });
    expect(screen.queryByLabelText('Interrupt')).toBeNull();
    act(() => { fireEvent.click(screen.getByLabelText('Send')); });
    expect(api.postMessage).toHaveBeenCalledWith({ type: 'sendTaskMessage', text: 'wait, use Postgres' });
  });

  it('sends on Enter and keeps Shift+Enter for a new line', () => {
    render(<TaskLogApp />);
    init({ working: true });
    const input = screen.getByPlaceholderText(/Message the task/);
    act(() => { fireEvent.change(input, { target: { value: 'hello' } }); });

    act(() => { fireEvent.keyDown(input, { key: 'Enter', shiftKey: true }); });
    expect(api.postMessage).not.toHaveBeenCalledWith({ type: 'sendTaskMessage', text: 'hello' });

    act(() => { fireEvent.keyDown(input, { key: 'Enter' }); });
    expect(api.postMessage).toHaveBeenCalledWith({ type: 'sendTaskMessage', text: 'hello' });
  });

  describe('Esc Esc to interrupt', () => {
    const esc = (input: HTMLElement): void => { act(() => { fireEvent.keyDown(input, { key: 'Escape' }); }); };

    it('arms on the first Esc with a hint and interrupts on the second', () => {
      render(<TaskLogApp />);
      init({ working: true });
      const input = screen.getByPlaceholderText(/Message the task/);

      esc(input);
      expect(screen.getByText('Press Esc again to stop')).toBeTruthy();
      expect(api.postMessage).not.toHaveBeenCalledWith({ type: 'interruptTask' });

      esc(input);
      expect(screen.queryByText('Press Esc again to stop')).toBeNull();
      expect(api.postMessage).toHaveBeenCalledWith({ type: 'interruptTask' });
    });

    it('lets the arm lapse after a pause', () => {
      vi.useFakeTimers();
      try {
        render(<TaskLogApp />);
        init({ working: true });
        esc(screen.getByPlaceholderText(/Message the task/));
        act(() => { vi.advanceTimersByTime(2_100); });
        expect(screen.queryByText('Press Esc again to stop')).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it('does nothing when no turn is live', () => {
      render(<TaskLogApp />);
      init({ working: false });
      const input = screen.getByPlaceholderText(/Message the task/);
      esc(input);
      esc(input);
      expect(screen.queryByText('Press Esc again to stop')).toBeNull();
      expect(api.postMessage).not.toHaveBeenCalledWith({ type: 'interruptTask' });
    });
  });

  it('follows a live patch into view', () => {
    const { container } = render(<TaskLogApp />);
    init({ working: true }, [message('b1', 'first')]);
    const body = container.querySelector('.task-log-body') as HTMLElement;
    let top = 0;
    Object.defineProperty(body, 'scrollHeight', { configurable: true, get: () => 600 });
    Object.defineProperty(body, 'scrollTop', { configurable: true, get: () => top, set: (v: number) => { top = v; } });

    send({ type: 'patch', order: ['b1', 'b2'], changed: [message('b2', 'second')] });
    expect(top).toBe(600);
  });

  it('switches to an earlier attempt', () => {
    render(<TaskLogApp />);
    init({ attempts: [1, 2], attempt: 2 });

    act(() => { fireEvent.change(screen.getByLabelText('Attempt'), { target: { value: '1' } }); });
    expect(api.postMessage).toHaveBeenCalledWith({ type: 'selectAttempt', attempt: 1 });
  });

  it('shows a control refusal the host reported', () => {
    render(<TaskLogApp />);
    init();
    send({ type: 'showError', error: 'Task is not running.' });

    expect(screen.getByText('Task is not running.')).toBeTruthy();
  });

  it('turns the message box into Continue for a finished task that can be continued (ADR-0018, K1)', () => {
    render(<TaskLogApp />);
    init({ planStatus: 'completed', continuable: true });

    const input = screen.getByPlaceholderText(/Continue the task/);
    act(() => { fireEvent.change(input, { target: { value: 'also handle arrays' } }); });
    act(() => { fireEvent.click(screen.getByLabelText('Continue')); });

    expect(api.postMessage).toHaveBeenCalledWith({ type: 'continueTask', text: 'also handle arrays' });
    expect(screen.queryByLabelText('Send')).toBeNull();
  });

  it('draws a script task\'s log as output only, with no composer or queue (ADR-0035)', () => {
    render(<TaskLogApp />);
    init({ script: true, working: true, planStatus: 'in_progress' });

    expect(document.querySelector('.task-log-composer')).toBeNull();
    expect(screen.queryByPlaceholderText(/Message the task/)).toBeNull();
    expect(screen.queryByLabelText('Send')).toBeNull();
    expect(document.querySelector('.task-log-readonly')?.textContent).toContain('takes no messages');
  });

  it('keeps every step of a script task\'s log in view, its whole output and exit with it, folding nothing (ADR-0035)', () => {
    const tail = Array.from({ length: 6 }, (_, i) => `test ${i + 1} failed`).join('\n');
    const run = replayTaskLog([
      { type: 'script_run', argv: ['npm', 'ci'] },
      { type: 'script_output', text: 'added 12 packages\n' },
      { type: 'script_exit', code: 0, signal: null, durationMs: 2000 },
      { type: 'script_run', argv: ['npm', 'test'] },
      { type: 'script_output', text: `${tail}\n` },
      { type: 'script_exit', code: 1, signal: null, durationMs: 3000 },
      { type: 'script_run', argv: ['npm', 'run', 'lint'] },
      { type: 'script_output', text: 'linting src/\n' },
    ]);
    render(<TaskLogApp />);
    init({ script: true, working: true, planStatus: 'in_progress' }, [...run.blocks]);

    expect(document.querySelector('.activity-group')).toBeNull();
    const rows = [...document.querySelectorAll('.conversation > .cmd-row')];
    expect(rows.map((row) => row.querySelector('.cmd-row-head')?.textContent)).toEqual(['Run(npm ci)', 'Run(npm test)', 'Run(npm run lint)']);
    expect(rows[1]).toHaveTextContent('test 6 failed');
    expect(rows[1]).toHaveTextContent('exited 1 after 3 s');
    expect(rows[2]).toHaveTextContent('linting src/');
    // Each command once, in its head: no arguments block repeats it.
    expect(document.querySelector('.conversation .cmd-row-args')).toBeNull();
    expect(rows[1]).not.toHaveTextContent('"command"');
    // Output only: nothing in it opens or closes.
    expect(document.querySelector('.conversation [aria-expanded]')).toBeNull();
    expect(document.querySelector('.task-log-readonly')?.textContent).toContain('Its output is above.');
  });

  describe('a runner\'s tool request (ADR-0018, A1)', () => {
    const request = (overrides: Partial<Extract<DisplayBlock, { type: 'approval' }>> = {}): DisplayBlock => ({
      type: 'approval', id: 'b2', approvalId: 'ap-1', kind: 'runner_tool', subject: 'Bash(npm test)', scope: 'Bash', status: 'pending', allowForTask: true,
      ...overrides,
    });

    it('offers Allow, Allow for this task and Deny, each sent with its whole decision', () => {
      render(<TaskLogApp />);
      init({ working: true, awaitingApproval: 1 }, [request()]);
      expect(screen.getByText('Waiting for approval', { selector: '.task-log-state' })).toBeTruthy();

      fireEvent.click(screen.getByText('Allow'));
      fireEvent.click(screen.getByText('Allow for this task'));
      expect(api.postMessage).toHaveBeenCalledWith({ type: 'answerApproval', id: 'ap-1', decision: { decision: 'allow' } });
      expect(api.postMessage).toHaveBeenCalledWith({ type: 'answerApproval', id: 'ap-1', decision: { decision: 'allowForTask' } });
    });

    it('denies with the note typed on the card', () => {
      render(<TaskLogApp />);
      init({}, [request()]);
      fireEvent.change(screen.getByPlaceholderText(/Note to the agent/), { target: { value: '  write it under notes/ ' } });
      fireEvent.click(screen.getByText('Deny'));
      expect(api.postMessage).toHaveBeenCalledWith({ type: 'answerApproval', id: 'ap-1', decision: { decision: 'deny', note: 'write it under notes/' } });
    });

    it('leaves out Allow for this task when the runner offered no grant', () => {
      render(<TaskLogApp />);
      init({}, [request({ allowForTask: false })]);
      expect(screen.queryByText('Allow for this task')).toBeNull();
      expect(screen.getByText('Allow')).toBeTruthy();
    });

    it('settles into how it was answered, with no buttons left', () => {
      render(<TaskLogApp />);
      init({}, [
        request({ status: 'granted', decidedBy: 'asked', forTask: true }),
        request({ id: 'b3', approvalId: 'ap-2', status: 'denied', decidedBy: 'asked', note: 'use notes/' }),
        request({ id: 'b4', approvalId: 'ap-3', status: 'withdrawn' }),
      ]);
      expect(screen.getByRole('button', { name: 'Settled 3 approval requests (1 denied)' })).toHaveAttribute('aria-expanded', 'false');
      fireEvent.click(screen.getByRole('button', { name: 'Settled 3 approval requests (1 denied)' }));
      expect(screen.getByText('Approved for this task')).toBeTruthy();
      expect(screen.getByText('Note to the agent: use notes/')).toBeTruthy();
      expect(screen.getByText('Withdrawn')).toBeTruthy();
      expect(screen.queryByText('Allow')).toBeNull();
    });
  });
});

describe('a message the runner reads mid-turn (ADR-0023)', () => {
  beforeEach(() => {
    cleanup();
    api.postMessage.mockClear();
  });

  const before = [
    { type: 'turn_start', message: 'Do the task' },
    { type: 'tool_call', id: 'c1', name: 'Bash', args: '{"command":"sleep 20"}' },
    { type: 'message_queued', messageId: 'm1', text: 'use Postgres' },
    { type: 'message_queued', messageId: 'm2', text: 'then add tests' },
    { type: 'message_handed_over', messageId: 'm1' },
  ] as const;

  it('marks a message the runner already has, with no way to take it back but a way to send it now', () => {
    render(<TaskLogApp />);
    const view = replayTaskLog([...before]);
    init({ working: true, queued: [...view.queued] }, [...view.blocks]);

    expect(screen.getByText('waiting for the current step')).toBeTruthy();
    expect(screen.getByLabelText('Send now: use Postgres')).toBeTruthy();
    const removes = screen.getAllByTitle('Remove this message');
    expect(removes).toHaveLength(1);
    act(() => { fireEvent.click(removes[0]); });
    expect(api.postMessage).toHaveBeenCalledWith({ type: 'removeQueuedTaskMessage', id: 'm2' });
  });

  it('draws the message in the log where the runner read it, and takes it off the queue', () => {
    render(<TaskLogApp />);
    const view = replayTaskLog([
      ...before,
      { type: 'tool_result', id: 'c1', output: '', success: true },
      { type: 'message_delivered', messageId: 'm1', text: 'use Postgres' },
      { type: 'text', text: 'Switching to Postgres.' },
    ]);
    init({ working: true, queued: [...view.queued] }, [...view.blocks]);

    expect(screen.queryByText('handed over')).toBeNull();
    const prompt = screen.getByText('Do the task');
    const read = screen.getByText('use Postgres');
    const reply = screen.getByText('Switching to Postgres.');
    expect(prompt.compareDocumentPosition(read) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(read.compareDocumentPosition(reply) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText('then add tests')).toBeTruthy();
  });

  it('draws its runner\'s account limits beside the task\'s own spend, and keeps them across an attempt switch', () => {
    render(<TaskLogApp />);
    init({ usage: { totals: { inputTokens: 10, reportedCost: { USD: 1.5 } }, contextFill: { usedTokens: 50_000, windowTokens: 200_000 } } });
    send({ type: 'accountLimits', limits: [{
      harness: 'claude-code', label: 'Claude Code', status: 'fresh',
      buckets: [{ id: 'claude', windows: [{ slot: 'primary', usedPercent: 24, durationMinutes: 300, resetsAt: null }, { slot: 'secondary', usedPercent: 61, durationMinutes: 10080, resetsAt: null }] }],
      readAt: '2026-03-02T10:00:00.000Z',
    }] });

    expect(visibleFooter()).toEqual(['ctx 50k (25%) · Claude Code 5h 24% used · Weekly 61% used · $1.50']);

    init({ attempt: 1, attempts: [1, 2] });
    expect(document.querySelector('.account-limit')!.textContent).toBe('Claude Code 5h 24% used · Weekly 61% used');

    send({ type: 'accountLimits', limits: [] });
    expect(document.querySelector('.account-limits')).toBeNull();
  });
});

describe('the runner\'s activity, folded (ADR-0017, X1)', () => {
  beforeEach(() => {
    cleanup();
    api.postMessage.mockClear();
  });

  const turn = replayTaskLog([
    { type: 'turn_start', message: 'parse it' },
    { type: 'thinking', text: 'Look first.' },
    { type: 'tool_call', id: 'c1', name: 'Bash', args: '{"command":"ls"}' },
    { type: 'tool_result', id: 'c1', output: 'src', success: true },
    { type: 'tool_call', id: 'c2', name: 'WebFetch', args: '{"url":"https://example.com"}' },
    { type: 'tool_result', id: 'c2', output: 'refused', success: false },
    { type: 'text', text: 'Now the parser.' },
    { type: 'tool_call', id: 'c3', name: 'Write', args: '{"file_path":"src/parse.ts"}' },
    { type: 'approval_requested', approvalId: 'ap-1', tool: 'Write', args: '{"file_path":"src/parse.ts"}', allowForTask: false },
  ]);
  const top = () => [...document.querySelectorAll('.conversation > *')].map((el) => (el.classList.contains('activity-group')
    ? el.querySelector('.activity-group-toggle')!.textContent : el.className.split(' ')[0]));

  it('says what each run did between the agent\'s messages, the waiting request outside where it is answered', () => {
    render(<TaskLogApp />);
    init({ working: true }, [...turn.blocks]);
    expect(top()).toEqual(['chat-msg', 'Ran a command, fetched a page (1 failed)', 'chat-msg', 'Making an edit', 'approval-card']);
    expect(screen.getByRole('button', { name: 'Allow' })).toBeTruthy();
  });

  it('tells a call the user denied once, as denied, though its result came back failed', () => {
    const denied = replayTaskLog([
      { type: 'turn_start', message: 'clean up' },
      { type: 'tool_call', id: 't3', name: 'Bash', args: '{"command":"rm -rf dist"}' },
      { type: 'approval_requested', approvalId: 'ap-3', tool: 'Bash', args: '{"command":"rm -rf dist"}', allowForTask: false, toolCallId: 't3' },
      { type: 'approval_decided', approvalId: 'ap-3', decision: 'deny' },
      { type: 'tool_result', id: 't3', output: 'The user denied this call', success: false },
    ]);
    render(<TaskLogApp />);
    init({ working: true }, [...denied.blocks]);
    expect(top()).toEqual(['chat-msg', '1 command denied']);
    expect(document.querySelector('.activity-group')).toHaveAttribute('data-state', 'failed');
    fireEvent.click(document.querySelector<HTMLButtonElement>('.activity-group-toggle')!);
    // Both rows stay in the group, for what was asked and what was answered.
    expect(document.querySelector('.activity-group-body .cmd-row')).toBeTruthy();
    expect(document.querySelector('.activity-group-body .approval-card')).toHaveAttribute('data-status', 'denied');
  });

  it('keeps what was opened as the live patch settles the call, and opens nothing for another attempt', () => {
    render(<TaskLogApp />);
    init({ working: true, attempts: [1, 2], attempt: 2 }, [...turn.blocks]);
    const groups = () => [...document.querySelectorAll<HTMLButtonElement>('.activity-group-toggle')];
    fireEvent.click(groups()[1]);
    fireEvent.click(document.querySelector<HTMLButtonElement>('.activity-group-body .cmd-row-header > button')!);
    expect(document.querySelector('.cmd-row-args')).toBeTruthy();

    const settled = replayTaskLog([{ type: 'tool_result', id: 'c3', output: '@@ -0,0 +1 @@\n+export {}', success: true }], turn);
    const changed = settled.blocks.filter((b) => !turn.blocks.includes(b));
    send({ type: 'patch', order: settled.blocks.map((b) => b.id), changed });
    expect(groups()[1].textContent).toBe('Made an edit');
    expect(groups()[1]).toHaveAttribute('aria-expanded', 'true');
    expect(document.querySelector('.activity-group-body .cmd-row-header > button')).toHaveAttribute('aria-expanded', 'true');

    send({ type: 'init', status: status({ attempts: [1, 2], attempt: 1 }), blocks: [...turn.blocks] });
    expect(groups().map((g) => g.getAttribute('aria-expanded'))).toEqual(['false', 'false']);
  });

  describe('the activity line above the composer (#80)', () => {
    const thinking = replayTaskLog([{ type: 'turn_start', message: 'go' }, { type: 'thinking_delta', text: 'Hmm' }]);
    const line = (): HTMLElement | null => document.querySelector('.task-log-activity');

    it('sits between the log body and the composer, outside the scrolling body, and spins while a turn is open', () => {
      render(<TaskLogApp />);
      init({ working: true }, [...thinking.blocks]);

      expect(line()?.textContent).toContain('Thinking…');
      expect(line()?.querySelector('.chat-msg-spinner')).not.toBeNull();
      expect(document.querySelector('.task-log-body')?.contains(line())).toBe(false);
      const order = [...document.querySelector('.task-log-container')!.children];
      expect(order.indexOf(line()!)).toBeGreaterThan(order.indexOf(document.querySelector('.task-log-body')!));
      expect(order.indexOf(line()!)).toBeLessThan(order.indexOf(document.querySelector('.task-log-composer')!));
    });

    it('keeps Send/Stop where it was', () => {
      render(<TaskLogApp />);
      init({ working: true }, [...thinking.blocks]);

      expect(screen.getByRole('button', { name: 'Interrupt' })).toBeTruthy();
    });

    it('names a pending tool from its headline', () => {
      const view = replayTaskLog([{ type: 'turn_start', message: 'go' }, { type: 'tool_call', id: 'r1', name: 'Read', args: '{"file_path":"README.md"}' }]);
      render(<TaskLogApp />);
      init({ working: true }, [...view.blocks]);

      expect(line()?.textContent).toContain('Running Read(README.md)…');
    });

    it('goes static, worded as the plan pane words it, once the task is quiet', () => {
      render(<TaskLogApp />);
      init({ working: true, idleSince: '2026-08-18T00:00:00.000Z' }, [...thinking.blocks]);

      expect(line()?.textContent).toContain('Stalled');
      expect(line()?.textContent).toContain('~');
      expect(line()?.querySelector('.chat-msg-spinner')).toBeNull();
    });

    it('is absent while a runner request waits', () => {
      const asked = replayTaskLog([{ type: 'turn_start', message: 'go' }, { type: 'approval_requested', approvalId: 'p1', tool: 'Bash', args: '{}', allowForTask: true }]);
      render(<TaskLogApp />);
      init({ working: true }, [...asked.blocks]);

      expect(line()).toBeNull();
    });

    it('is absent while a checkpoint waits, even with its turn still open', () => {
      render(<TaskLogApp />);
      init({ working: true, planStatus: 'awaiting_user', awaitingReason: 'checkpoint' }, [...thinking.blocks]);

      expect(line()).toBeNull();
    });

    it('is absent once no turn is open', () => {
      render(<TaskLogApp />);
      init({ working: false }, [...thinking.blocks]);

      expect(line()).toBeNull();
    });

    describe('and how long the turn has run (#81)', () => {
      const startedAt = '2026-10-30T10:00:00.000Z';
      const at = (seconds: number) => new Date(Date.parse(startedAt) + seconds * 1000);
      const time = (): string | undefined => line()?.querySelector('.task-log-activity-time')?.textContent ?? undefined;
      beforeEach(() => { vi.useFakeTimers(); });
      afterEach(() => { vi.useRealTimers(); });

      it('ends the line with the time since the turn began, counting on a timer of its own', () => {
        vi.setSystemTime(at(42));
        render(<TaskLogApp />);
        init({ working: true, turnStartedAt: startedAt }, [...thinking.blocks]);
        expect(time()).toBe('42s');

        act(() => { vi.advanceTimersByTime(3000); });
        expect(time()).toBe('45s');
        act(() => { vi.advanceTimersByTime(140_000); });
        expect(time()).toBe('3m 05s');
      });

      it('keeps counting once the task is quiet', () => {
        vi.setSystemTime(at(185));
        render(<TaskLogApp />);
        init({ working: true, idleSince: '2026-10-30T10:01:00.000Z', turnStartedAt: startedAt }, [...thinking.blocks]);
        expect(line()?.textContent).toContain('Stalled');
        expect(time()).toBe('3m 05s');

        act(() => { vi.advanceTimersByTime(5000); });
        expect(time()).toBe('3m 10s');
      });

      it('shows the spinner with no time for a turn saved before they were dated', () => {
        vi.setSystemTime(at(42));
        render(<TaskLogApp />);
        init({ working: true }, [...thinking.blocks]);
        expect(line()?.querySelector('.chat-msg-spinner')).not.toBeNull();
        expect(time()).toBeUndefined();
      });

      it('is kept out of the live region, which would read it out every second', () => {
        vi.setSystemTime(at(42));
        render(<TaskLogApp />);
        init({ working: true, turnStartedAt: startedAt }, [...thinking.blocks]);
        expect(line()?.querySelector('.task-log-activity-time')?.getAttribute('aria-hidden')).toBe('true');
      });
    });

    it('is absent for a script task, which runs no model', () => {
      render(<TaskLogApp />);
      init({ working: true, script: true }, [...thinking.blocks]);

      expect(line()).toBeNull();
    });
  });
});
