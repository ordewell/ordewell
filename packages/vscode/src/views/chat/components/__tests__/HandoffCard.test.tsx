import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import HandoffCard from '../HandoffCard';

const handoff = {
  branch: 'ordewell/run-1/integration',
  baseRef: 'abcdef0123456789',
  landed: [
    { taskId: 't2', order: 2, title: 'Second task' },
    { taskId: 't1', order: 1, title: 'First task' },
  ],
};

describe('HandoffCard (ADR-0013)', () => {
  it('shows the integration branch and what landed, in plan order', () => {
    render(<HandoffCard {...handoff} onAction={vi.fn()} />);

    expect(screen.getByText('ordewell/run-1/integration')).toBeTruthy();
    expect(screen.getByText(/2 tasks landed/)).toBeTruthy();
    const items = document.querySelectorAll('.isolation-handoff-landed li');
    expect([...items].map((li) => li.textContent)).toEqual(['1First task', '2Second task']);
  });

  it('offers review, merge, clean up and discard', () => {
    render(<HandoffCard {...handoff} onAction={vi.fn()} />);

    for (const label of ['Review diff', 'Merge', 'Clean up', 'Discard']) {
      expect(screen.getByText(label)).toBeTruthy();
    }
  });

  it('routes each action to the host', () => {
    const onAction = vi.fn();
    render(<HandoffCard {...handoff} onAction={onAction} />);

    fireEvent.click(screen.getByText('Review diff'));
    fireEvent.click(screen.getByText('Merge'));
    fireEvent.click(screen.getByText('Clean up'));
    fireEvent.click(screen.getByText('Discard'));

    expect(onAction.mock.calls.map((c) => c[0])).toEqual(['reviewDiff', 'merge', 'cleanup', 'discard']);
  });
});
