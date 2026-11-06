import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import CheckpointPanel from '../CheckpointPanel';

const props = {
  taskTitle: 'Add rate limiting',
  pausedAt: Date.now(),
  onApprove: () => {},
  onReject: () => {},
};

function summary(): HTMLElement {
  return document.querySelector('.checkpoint-summary') as HTMLElement;
}

describe('reading a full checkpoint summary', () => {
  it('shows only the first line until the reader expands it, then the whole text', () => {
    const text = 'Shipped the endpoint\nand left the tests for later';
    render(<CheckpointPanel {...props} summary={text} />);

    expect(summary().textContent).toBe('Shipped the endpoint');

    fireEvent.click(screen.getByText('Show full'));
    expect(summary().textContent).toBe(text);

    fireEvent.click(screen.getByText('Show less'));
    expect(summary().textContent).toBe('Shipped the endpoint');
  });

  it('offers no expand control when there is nothing hidden', () => {
    render(<CheckpointPanel {...props} summary="ready for review" />);
    expect(document.querySelector('.checkpoint-summary-toggle')).toBeNull();
  });

  it('lets the reader see the tail of a single overlong line', () => {
    const long = 'x'.repeat(200);
    render(<CheckpointPanel {...props} summary={long} />);

    expect(summary().textContent!.length).toBe(120);
    expect(summary().textContent!.endsWith('…')).toBe(true);

    fireEvent.click(screen.getByText('Show full'));
    expect(summary().textContent).toBe(long);
  });
});

describe('a delegated task\'s question (ADR-0056 M5, M8)', () => {
  const delegated = { ...props, summary: 'Round half up or to even?', delegated: true };

  it('approves with the words typed and a raise of its budget', () => {
    const approved: Array<[string | undefined, number | undefined]> = [];
    render(<CheckpointPanel {...delegated} onApprove={(words, raise) => approved.push([words, raise])} />);

    fireEvent.change(screen.getByLabelText('Your answer'), { target: { value: 'Round half up.' } });
    fireEvent.change(screen.getByLabelText('Raise its budget by (tokens)'), { target: { value: '700000' } });
    fireEvent.click(screen.getByText('Approve & Continue'));

    expect(approved).toEqual([['Round half up.', 700_000]]);
  });

  it('approves as is with nothing typed', () => {
    const approved: Array<[string | undefined, number | undefined]> = [];
    render(<CheckpointPanel {...delegated} onApprove={(words, raise) => approved.push([words, raise])} />);
    fireEvent.click(screen.getByText('Approve & Continue'));
    expect(approved).toEqual([[undefined, undefined]]);
  });

  it('holds a raise that is not a whole number of tokens back, and says why', () => {
    const approved: unknown[] = [];
    render(<CheckpointPanel {...delegated} onApprove={(...args) => approved.push(args)} />);
    fireEvent.change(screen.getByLabelText('Raise its budget by (tokens)'), { target: { value: '1.5' } });
    expect((screen.getByText('Approve & Continue') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('A raise is a whole number of tokens, 1 or more.')).toBeTruthy();
    expect(approved).toEqual([]);
  });

  it('offers a plain task\'s question neither', () => {
    render(<CheckpointPanel {...props} summary="ready for review" />);
    expect(screen.queryByLabelText('Your answer')).toBeNull();
    expect(screen.queryByLabelText('Raise its budget by (tokens)')).toBeNull();
  });

  it('offers no raise where none can be given, and still takes the answer', () => {
    const approved: unknown[][] = [];
    render(<CheckpointPanel {...props} summary="which rounding?" delegated raisable={false} onApprove={(...args) => approved.push(args)} />);
    expect(screen.queryByLabelText('Raise its budget by (tokens)')).toBeNull();
    fireEvent.change(screen.getByLabelText('Your answer'), { target: { value: 'Floor.' } });
    fireEvent.click(screen.getByText('Approve & Continue'));
    expect(approved).toEqual([['Floor.', undefined]]);
  });
});
