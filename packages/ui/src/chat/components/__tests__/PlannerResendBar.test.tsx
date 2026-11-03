import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import PlannerResendBar from '../PlannerResendBar';

// Within the hour from now, so the label is a bare clock time whatever the date.
const soon = (): string => {
  const at = new Date();
  at.setMinutes(at.getMinutes() < 30 ? 50 : at.getMinutes(), 0, 0);
  return at.toISOString();
};

describe('the planner turn waiting on the planner\'s usage limit', () => {
  it('says when it is resent, and keeps it from going on its own', () => {
    let cancelled = 0;
    render(<PlannerResendBar resend={{ runner: 'claude-code', at: soon() }} onCancel={() => cancelled++} />);

    expect(screen.getByText(/^Resending at \d{1,2}(:\d{2})?[ap]m, once claude-code's usage limit resets$/)).toBeTruthy();
    fireEvent.click(screen.getByText('Don\'t resend'));
    expect(cancelled).toBe(1);
  });

  it('shows nothing once nothing goes on its own', () => {
    const { container } = render(<PlannerResendBar resend={{ runner: 'claude-code' }} onCancel={() => {}} />);
    expect(container.textContent).toBe('');
    expect(render(<PlannerResendBar onCancel={() => {}} />).container.textContent).toBe('');
  });
});
