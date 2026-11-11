import React from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { DecisionRecordEntry } from '@ordewell/core';
import App from '../../test/ChatApp';
import DecisionRecordPanel from '../components/DecisionRecordPanel';
import { post as send } from './webview';

const entry = (over: Partial<DecisionRecordEntry> & Pick<DecisionRecordEntry, 'id' | 'kind' | 'text'>): DecisionRecordEntry => ({
  at: 0, timestamp: '2026-01-01T00:00:00.000Z', ...over,
});

const RECORD: DecisionRecordEntry[] = [
  entry({ id: 'D1', kind: 'decision', text: 'Use SQLite', why: 'one file, no server' }),
  entry({ id: 'C1', kind: 'constraint', text: 'no new dependencies' }),
  entry({ id: 'R1', kind: 'rejected', text: 'Postgres', why: 'needs a server' }),
  entry({ id: 'Q1', kind: 'question', text: 'Which migration tool?' }),
  entry({ id: 'D2', kind: 'decision', text: 'Use LMDB', why: 'faster reads', supersedes: 'D1' }),
];

describe('the planner\'s decision record', () => {
  it('lists each standing entry under its kind and hides what was superseded', () => {
    const { container } = render(<DecisionRecordPanel record={RECORD} />);
    const text = container.textContent!;
    expect(text).toContain('4 standing');
    expect(text).toContain('Decisions');
    expect(text).toContain('D2 Use LMDB Why: faster reads');
    expect(text).toContain('“no new dependencies”');
    expect(text).toContain('Rejected');
    expect(text).toContain('Postgres');
    expect(text).toContain('Open questions');
    expect(text).toContain('Which migration tool?');
    expect(text).not.toContain('Use SQLite');
  });

  it('shows the superseded entries, marked, when asked', () => {
    const { container } = render(<DecisionRecordPanel record={RECORD} />);
    fireEvent.click(screen.getByLabelText(/Show 1 superseded/));
    expect(container.textContent).toContain('D1 Use SQLite (superseded by D2)');
  });

  it('draws nothing for a plan with no record, and offers no toggle without superseded entries', () => {
    expect(render(<DecisionRecordPanel />).container.textContent).toBe('');
    expect(render(<DecisionRecordPanel record={[]} />).container.textContent).toBe('');
    expect(render(<DecisionRecordPanel record={[RECORD[1]]} />).container.querySelector('input')).toBeNull();
  });
});

describe('the record in the chat', () => {
  beforeEach(() => {
    render(<App />);
  });

  it('appears with the plan and goes when a plan arrives without one', () => {
    const plan = { tasks: [], generatedAt: new Date().toISOString(), status: 'draft' as const, runners: ['claude-code'], lastUpdated: new Date().toISOString() };
    send({ type: 'planUpdated', plan: { ...plan, decisionRecord: RECORD } });
    expect(document.querySelector('.decision-record')?.textContent).toContain('Use LMDB');
    send({ type: 'planUpdated', plan });
    expect(document.querySelector('.decision-record')).toBeNull();
  });
});
