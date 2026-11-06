import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { ApprovalBlock } from '@ordewell/core';
import { ApprovalCard } from '../components/ChatMessage';

describe('the approval card for a planner asking to start work (ADR-0029)', () => {
  const block: ApprovalBlock = {
    type: 'approval', id: 'b1', approvalId: 'ap-1', kind: 'task_start', status: 'pending',
    subject: 'Start task #2 "Add the cache"', scope: 'Start task #2 "Add the cache"',
    detail: 'The planner wants to start work. It runs on claude-code in acceptEdits mode, as the plan set it.',
  };

  it('names what would start, promises no wider grant, and answers through the same buttons', () => {
    const onResolve = vi.fn();
    const { container } = render(<ApprovalCard block={block} onResolve={onResolve} />);

    expect(screen.getByText('Start work')).toBeTruthy();
    expect(screen.getByText('Start task #2 "Add the cache"')).toBeTruthy();
    expect(container.textContent).not.toMatch(/also allows/i);
    fireEvent.click(screen.getByText('Allow'));
    expect(onResolve).toHaveBeenCalledWith('ap-1', true);
  });
});
