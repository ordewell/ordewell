import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import TaskCard from '../TaskCard';
import type { Task } from '@ordewell/core';

const manuallyCompleted: Task = {
  id: 't1', order: 1, title: 'Test task', description: 'A task', type: 'ai', status: 'completed',
  dependencies: [], subtasks: [], assignedRunner: 'claude-code', taskMode: 'build',
  verdict: {
    outcome: 'pass', reason: 'Marked complete by the user', decidedAt: '',
    checks: [{ name: 'manual', passed: true, skipped: false, detail: 'Task was manually marked complete by the user.' }],
  },
};

describe('TaskCard — verdict checks', () => {
  it('names a check the user made as theirs, never as a model review', () => {
    render(<TaskCard task={manuallyCompleted} models={[]} runners={[]} />);
    act(() => { fireEvent.click(screen.getByText('Test task')); });

    expect(screen.getByText('Marked by you')).toBeTruthy();
    expect(screen.queryByText('Model Review')).toBeNull();
  });
});
