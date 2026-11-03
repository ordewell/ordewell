import React from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AccountLimitSnapshot, SessionMessage } from '@ordewell/core';
import App from '../App';
import { hostBridge } from './hostBridge';

const TURN = 'turn-1';
const turnStarted: SessionMessage = { type: 'planner_turn_started', turnId: TURN };
const usage = (over: Partial<Extract<SessionMessage, { type: 'planner_usage' }>>): SessionMessage => ({
  type: 'planner_usage', turnId: TURN, totals: { inputTokens: 1_234, outputTokens: 567 }, ...over,
});

describe('usage line', () => {
  let host: ReturnType<typeof hostBridge>;
  beforeEach(() => {
    render(<App />);
    host = hostBridge();
  });

  it('sits outside the scrolling conversation and draws the context and cost, no token count', () => {
    host.session(turnStarted, usage({
      totals: { inputTokens: 1_234, outputTokens: 567, cachedInputTokens: 900, reportedCost: { usd: 0.0123 } },
      contextFill: { usedTokens: 700, windowTokens: 10_000 },
    }));

    const line = document.querySelector('.usage-line')!;
    expect(line.textContent).toBe('Planner ctx 700 (7%) · $0.0123');
    expect(document.querySelector('.message-list')!.contains(line)).toBe(false);
  });

  it('keeps drawing the newest usage when a supervisor wake-up turn opens above the line', () => {
    host.session(turnStarted, usage({ totals: { inputTokens: 1000 }, contextFill: { usedTokens: 1000 } }));
    host.session({ type: 'planner_turn_started', turnId: 'w1', prompt: '', wakeUps: ['Run update: task 1 failed'], supervisor: true });
    host.session(usage({ turnId: 'w1', totals: { inputTokens: 2000 }, contextFill: { usedTokens: 2000 } }));

    expect(document.querySelector('.usage-line')!.textContent).toBe('Planner ctx 2k');
  });

  it('draws no line when neither the context nor a cost is known', () => {
    host.session(turnStarted, usage({}));

    expect(document.querySelector('.usage-line')).toBeNull();
  });

  it('draws the used tokens alone while the window is unknown', () => {
    host.session(turnStarted, usage({ contextFill: { usedTokens: 61_143 } }));

    expect(document.querySelector('.usage-line')!.textContent).toBe('Planner ctx 61k');
    expect(document.querySelector('.usage-line-context')!.getAttribute('title')).toBe('61,143 tokens');
  });

  it('gives the meter exact counts on hover', () => {
    host.session(turnStarted, usage({ contextFill: { usedTokens: 61_143, windowTokens: 1_000_000 } }));

    expect(document.querySelector('.usage-line-context')!.textContent).toBe('Planner ctx 61k (6%)');
    expect(document.querySelector('.usage-line-context')!.getAttribute('title')).toBe('61,143 of 1,000,000 tokens');
  });

  it('lists each model\'s cost on hover, leaving out those with none', () => {
    host.session(turnStarted, usage({
      totals: { reportedCost: { USD: 1.75 } },
      byModel: [
        { source: 'claude-code', model: 'opus', totals: { inputTokens: 5, reportedCost: { USD: 1.5 } } },
        { source: 'claude-code', model: 'sonnet', totals: { reportedCost: { USD: 0.25 } } },
        { source: 'codex', model: 'gpt', totals: { inputTokens: 9 } },
      ],
    }));

    expect(document.querySelector('.usage-line-cost')!.getAttribute('title')).toBe('claude-code / opus: $1.50\nclaude-code / sonnet: $0.25');
  });

  it('explains a subscription estimate at list price on the cost hover', () => {
    const totals = { reportedCost: { USD: 7.89 }, costProvenance: { USD: { kind: 'estimate' as const, billing: 'subscription' as const, basis: 'list' as const } } };
    host.session(turnStarted, usage({ totals, byModel: [{ source: 'claude-code', model: 'opus', totals }] }));
    const cost = document.querySelector('.usage-line-cost')!;
    expect(cost.textContent).toBe('≈$7.89 API-equivalent');
    expect(cost.getAttribute('title')).toBe("claude-code / opus: ≈$7.89 API-equivalent — Claude Code's estimate at list price; not billed on a subscription");
  });

  it('keeps the subagent count, whose hover gives each one\'s cost or says it reported none', () => {
    host.session(turnStarted, usage({
      totals: { reportedCost: { USD: 0.5 } },
      bySubagent: { 'sub-1': { inputTokens: 200, reportedCost: { USD: 0.02 } }, 'sub-2': { inputTokens: 40 } },
    }));

    const agents = document.querySelector('.usage-line-subagents')!;
    expect(agents.textContent).toBe('2 subagents');
    expect(agents.getAttribute('title')).toBe('sub-1: $0.02\nsub-2: reported no cost');
    expect(document.querySelector('.usage-line')!.textContent).not.toMatch(/\bin\b|\bout\b/);
  });
});

const codexLimits = (over: Partial<AccountLimitSnapshot> = {}): AccountLimitSnapshot => ({
  harness: 'codex',
  label: 'Codex',
  status: 'fresh',
  plan: 'plus',
  buckets: [{ id: 'codex', windows: [
    { slot: 'primary', usedPercent: 24, durationMinutes: 300, resetsAt: '2026-03-02T15:00:00.000Z' },
    { slot: 'secondary', usedPercent: 61, durationMinutes: 10080, resetsAt: '2026-03-06T09:00:00.000Z' },
  ] }],
  readAt: '2026-03-02T10:00:00.000Z',
  ...over,
});

const claudeLimits = (over: Partial<AccountLimitSnapshot> = {}): AccountLimitSnapshot => ({
  harness: 'claude-code', label: 'Claude Code', status: 'fresh', plan: 'Pro',
  buckets: [{ id: 'claude-code', windows: [{ slot: 'primary', usedPercent: 18, durationMinutes: 300, resetsAt: null }] }],
  readAt: '2026-03-02T10:00:00.000Z', ...over,
});

const openCodeLimits = (provider: string): AccountLimitSnapshot => ({
  harness: 'opencode', label: 'OpenCode', provider, status: 'fresh', plan: 'Go',
  buckets: [{ id: provider, windows: [{ slot: 'primary', usedPercent: 31, durationMinutes: 300, resetsAt: null }] }],
  readAt: '2026-03-02T10:00:00.000Z',
});

/** Each footer row as a reader sees it: the limits' screen-reader description is in the DOM but never drawn. */
function visibleFooter(): string[] {
  return [...document.querySelectorAll('.usage-line')].map((line) => {
    const drawn = line.cloneNode(true) as Element;
    drawn.querySelectorAll('.account-limit-details').forEach((details) => details.remove());
    return drawn.textContent ?? '';
  });
}

describe('account limits under the planner', () => {
  let host: ReturnType<typeof hostBridge>;
  beforeEach(() => {
    render(<App />);
    host = hostBridge();
  });

  it('draws a signed-in harness\'s limits before the planner has made any call', () => {
    host.planner([{ id: 'codex', label: 'Codex', kind: 'harness', runner: 'codex', usable: true }], 'codex', 'codex');
    host.provider.setAccountLimits([codexLimits()]);

    expect(document.querySelector('.usage-line-context')).toBeNull();
    const row = document.querySelector('.account-limit')!;
    expect(row.textContent).toBe('Codex 5h 24% used · Weekly 61% used');
    expect(row.getAttribute('title')).toMatch(/^Codex 5h: 24% used, resets .+\nCodex Weekly: 61% used, resets .+\nPlan: plus\nRead .+$/);
    expect(document.querySelector('.message-list')!.contains(row)).toBe(false);
    expect(row.closest('.usage-line')).not.toBeNull();
  });

  it('reaches each row\'s resets, plan and read time from the keyboard and a screen reader, not only a mouse hover', () => {
    host.planner([{ id: 'codex', label: 'Codex', kind: 'harness', runner: 'codex', usable: true }], 'codex', 'codex');
    host.provider.setAccountLimits([codexLimits({ status: 'stale' })]);

    const row = document.querySelector<HTMLElement>('.account-limit')!;
    expect(row.tabIndex).toBe(0);
    const detail = document.getElementById(row.getAttribute('aria-describedby')!)!;
    const lines = Array.from(detail.children, (line) => line.textContent);
    expect(lines).toHaveLength(4);
    expect(lines[0]).toMatch(/^Codex 5h: 24% used, resets \S/);
    expect(lines[1]).toMatch(/^Codex Weekly: 61% used, resets \S/);
    expect(lines[2]).toBe('Plan: plus');
    expect(lines[3]).toMatch(/^Last read \S.*; not current, a newer read is pending or failed$/);
    // A passive readout: a poll that moves a percentage is not announced over what the user is doing.
    const region = document.querySelector('.account-limits')!;
    expect(region.getAttribute('role')).not.toBe('status');
    expect(region.getAttribute('aria-live')).toBeNull();
  });

  it('draws context, then live limits, then reported cost and the subagent count, as the TUI does', () => {
    host.planner([{ id: 'codex', label: 'Codex', kind: 'harness', runner: 'codex', usable: true }], 'codex', 'codex');
    host.session(turnStarted, usage({
      totals: { reportedCost: { USD: 0.5 } }, contextFill: { usedTokens: 700, windowTokens: 10_000 },
      bySubagent: { 'sub-1': { reportedCost: { USD: 0.02 } } },
    }));
    host.provider.setAccountLimits([codexLimits()]);

    expect(document.querySelectorAll('.usage-line')).toHaveLength(1);
    expect(visibleFooter()).toEqual(['Planner ctx 700 (7%) · Codex 5h 24% used · Weekly 61% used · $0.50 · 1 subagent']);
    // The measures are announced; the passive quota between them is not part of any live region.
    const announced = within(document.querySelector<HTMLElement>('.usage-line')!).getAllByRole('status').map((region) => region.textContent);
    expect(announced).toEqual(['Planner ctx 700 (7%)', '$0.50']);
    expect(document.querySelector('.account-limits')!.closest('[role="status"]')).toBeNull();
    expect(document.querySelector('.usage-line-context')!.getAttribute('title')).toBe('700 of 10,000 tokens');
  });

  it('joins only the known parts when the context, the cost or a percentage is missing', () => {
    host.planner([{ id: 'codex', label: 'Codex', kind: 'harness', runner: 'codex', usable: true }], 'codex', 'codex');
    const unknownWeekly = codexLimits({ buckets: [{ id: 'codex', windows: [
      { slot: 'primary', usedPercent: 24, durationMinutes: 300, resetsAt: null },
      { slot: 'secondary', usedPercent: null, durationMinutes: 10080, resetsAt: null },
    ] }] });
    host.provider.setAccountLimits([unknownWeekly]);
    expect(visibleFooter()).toEqual(['Codex 5h 24% used']);

    host.session(turnStarted, usage({ contextFill: { usedTokens: 61_000 } }));
    expect(visibleFooter()).toEqual(['Planner ctx 61k · Codex 5h 24% used']);

    cleanup();
    render(<App />);
    host = hostBridge();
    host.planner([{ id: 'codex', label: 'Codex', kind: 'harness', runner: 'codex', usable: true }], 'codex', 'codex');
    host.provider.setAccountLimits([unknownWeekly]);
    host.session(turnStarted, usage({ totals: { reportedCost: { USD: 0.42 } } }));
    expect(visibleFooter()).toEqual(['Codex 5h 24% used · $0.42']);
  });

  it('shows only the selected planner harness limits, switches cleanly, and follows a restricted provider model', () => {
    const codex = { id: 'codex', label: 'Codex', kind: 'harness' as const, runner: 'codex', usable: true };
    const claude = { id: 'claude-code', label: 'Claude Code', kind: 'harness' as const, runner: 'claude-code', usable: true };
    const openCode = { id: 'opencode', label: 'OpenCode', kind: 'harness' as const, runner: 'opencode', usable: true };
    host.provider.setAccountLimits([codexLimits(), claudeLimits(), openCodeLimits('opencode-go')]);
    const shown = (): string[] => [...document.querySelectorAll('.account-limit')].map((row) => row.textContent ?? '');
    const observed: string[][] = [];

    host.planner([codex, claude, openCode], 'codex', 'codex');
    observed.push(shown());

    host.planner([codex, claude, openCode], 'claude-code', 'claude-code');
    observed.push(shown());

    host.planner([codex, claude, openCode], 'opencode', 'opencode');
    host.plannerModel('opencode-go/qwen3-coder');
    observed.push(shown());
    host.plannerModel('openrouter/anthropic/claude');
    observed.push(shown());

    host.planner([{ id: 'openrouter', label: 'OpenRouter', kind: 'vendor', usable: true }], 'openrouter');
    observed.push(shown());
    expect(observed).toEqual([
      ['Codex 5h 24% used · Weekly 61% used'],
      ['Claude Code 5h 18% used'],
      ['OpenCode 5h 31% used'],
      [],
      [],
    ]);
    expect(document.querySelector('.usage-line')).toBeNull();
  });

  it('keeps a limits-only footer when measured planner context arrives later', () => {
    host.planner([{ id: 'codex', label: 'Codex', kind: 'harness', runner: 'codex', usable: true }], 'codex', 'codex');
    host.provider.setAccountLimits([codexLimits()]);
    expect(document.querySelectorAll('.usage-line')).toHaveLength(1);
    expect(document.querySelector('.usage-line-context')).toBeNull();

    host.session(turnStarted, usage({ contextFill: { usedTokens: 700, windowTokens: 10_000 } }));
    expect(document.querySelectorAll('.usage-line')).toHaveLength(1);
    expect(document.querySelector('.account-limit')!.closest('.usage-line'))
      .toBe(document.querySelector('.usage-line-measures')!.closest('.usage-line'));
  });

  it('keeps reset, plan and read-time details accessible without expanding or widening the focused row', () => {
    host.planner([{ id: 'codex', label: 'Codex', kind: 'harness', runner: 'codex', usable: true }], 'codex', 'codex');
    host.provider.setAccountLimits([codexLimits()]);
    const style = document.createElement('style');
    style.textContent = readFileSync(resolve(process.cwd(), '../ui/src/styles.css'), 'utf8');
    document.head.append(style);
    const row = document.querySelector<HTMLElement>('.account-limit')!;
    const details = document.getElementById(row.getAttribute('aria-describedby')!)!;
    expect(row.getAttribute('title')).toMatch(/resets.+Plan: plus.+Read/s);
    expect(details.textContent).toMatch(/resets/);
    expect(details.textContent).toMatch(/Plan: plus/);
    expect(details.textContent).toMatch(/Read/);
    fireEvent.mouseEnter(row);
    style.textContent = `${style.textContent}\n`;
    expect(getComputedStyle(details).display).toBe('none');
    row.focus();
    // JSDOM caches computed styles after focus; a fresh stylesheet forces the real rule to recascade.
    style.textContent = `${style.textContent}\n`;
    expect(getComputedStyle(details).display).toBe('none');
    expect(getComputedStyle(row).textOverflow).toBe('ellipsis');
    expect(getComputedStyle(row).whiteSpace).toBe('nowrap');
  });

  it('clips a narrow account-limit label while keeping the complete detail description', () => {
    host.planner([{ id: 'codex', label: 'Codex', kind: 'harness', runner: 'codex', usable: true }], 'codex', 'codex');
    host.provider.setAccountLimits([codexLimits()]);
    const style = document.createElement('style');
    style.textContent = readFileSync(resolve(process.cwd(), '../ui/src/styles.css'), 'utf8');
    document.head.append(style);
    const row = document.querySelector<HTMLElement>('.account-limit')!;
    expect(getComputedStyle(row).textOverflow).toBe('ellipsis');
    expect(getComputedStyle(row).whiteSpace).toBe('nowrap');
    expect(row.getAttribute('title')).toContain('Weekly: 61% used');
  });

  it('shows full details in an overlay on keyboard focus and dismisses it with Escape', () => {
    host.planner([{ id: 'codex', label: 'Codex', kind: 'harness', runner: 'codex', usable: true }], 'codex', 'codex');
    host.provider.setAccountLimits([codexLimits()]);
    const style = document.createElement('style');
    style.textContent = readFileSync(resolve(process.cwd(), '../ui/src/styles.css'), 'utf8');
    document.head.append(style);
    const row = document.querySelector<HTMLElement>('.account-limit')!;
    fireEvent.focus(row);

    const tooltip = screen.getByRole('tooltip');
    expect(tooltip.textContent).toMatch(/Codex 5h: 24% used, resets.+Weekly: 61% used, resets.+Plan: plus.+Read/s);
    expect(tooltip.closest('.usage-line')).toBeNull();
    expect(getComputedStyle(tooltip).position).toBe('fixed');
    fireEvent.keyDown(row, { key: 'Escape' });
    expect(screen.queryByRole('tooltip')).toBeNull();
    expect(document.querySelectorAll('.usage-line')).toHaveLength(1);
  });

  it('keeps a focused footer compact when the account read refreshes', () => {
    host.planner([{ id: 'codex', label: 'Codex', kind: 'harness', runner: 'codex', usable: true }], 'codex', 'codex');
    host.provider.setAccountLimits([codexLimits()]);
    const style = document.createElement('style');
    style.textContent = readFileSync(resolve(process.cwd(), '../ui/src/styles.css'), 'utf8');
    document.head.append(style);
    document.querySelector<HTMLElement>('.account-limit')!.focus();
    host.provider.setAccountLimits([codexLimits({ status: 'stale' })]);
    style.textContent = `${style.textContent}\n`;
    expect(document.querySelectorAll('.account-limit-details')).toHaveLength(1);
    expect(getComputedStyle(document.querySelector('.account-limit-details')!).display).toBe('none');
    expect(document.querySelectorAll('.usage-line')).toHaveLength(1);
    expect(document.querySelector('.account-limit')!.textContent).toContain('(stale)');
  });

  it('draws no row for a harness that is signed out, unsupported, not installed or not yet read', () => {
    host.planner([{ id: 'codex', label: 'Codex', kind: 'harness', runner: 'codex', usable: true }], 'codex', 'codex');
    host.provider.setAccountLimits(['signed_out', 'unsupported', 'not_installed', 'unknown'].map((status) =>
      codexLimits({ status: status as AccountLimitSnapshot['status'], buckets: [], readAt: null })));

    expect(document.querySelector('.account-limits')).toBeNull();
  });

  it('marks a stale read on the row, and draws a true 0% as used nothing', () => {
    host.planner([{ id: 'codex', label: 'Codex', kind: 'harness', runner: 'codex', usable: true }], 'codex', 'codex');
    host.provider.setAccountLimits([codexLimits({ status: 'stale', buckets: [{ id: 'codex', windows: [{ slot: 'primary', usedPercent: 0, durationMinutes: 300, resetsAt: null }] }] })]);

    const row = document.querySelector('.account-limit')!;
    expect(row.textContent).toBe('Codex 5h 0% used (stale)');
    expect(row.className).toContain('stale');
  });

  it('replays the last limits to a webview that reconnects', () => {
    host.planner([{ id: 'codex', label: 'Codex', kind: 'harness', runner: 'codex', usable: true }], 'codex', 'codex');
    host.provider.setAccountLimits([codexLimits()]);
    cleanup();
    render(<App />);
    host.provider.resendAllState();

    expect(document.querySelector('.account-limit')!.textContent).toBe('Codex 5h 24% used · Weekly 61% used');
  });
});
