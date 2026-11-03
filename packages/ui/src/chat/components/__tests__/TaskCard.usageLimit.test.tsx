import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import TaskCard from '../TaskCard';
import SubTaskCard from '../SubTaskCard';
import type { Task } from '@ordewell/core';

// Within the hour from now, so the label is a bare clock time whatever the date.
const soon = (): Date => {
  const at = new Date();
  at.setMinutes(at.getMinutes() < 30 ? 50 : at.getMinutes(), 0, 0);
  return at;
};

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 't1', order: 1, title: 'Test task', description: 'A task', type: 'ai', status: 'awaiting_user',
    awaitingReason: 'usage-limit', resumeAt: soon().toISOString(),
    dependencies: [], subtasks: [], assignedRunner: 'claude-code', taskMode: 'build',
    ...overrides,
  };
}

const saved = { continuable: true as const };

describe('a task paused on a usage limit (#84)', () => {
  it('says when it resumes, and keeps it from resuming without a running plan', () => {
    const cancelled: string[] = [];
    render(<TaskCard task={makeTask()} models={[]} onCancelResume={(id) => cancelled.push(id)} />);

    expect(screen.getByText('Paused on a usage limit', { selector: '.task-status-badge' })).toBeTruthy();
    expect(screen.getByText(/^Resumes at \d{1,2}(:\d{2})?[ap]m$/)).toBeTruthy();
    fireEvent.click(screen.getByText('Don\'t resume'));
    expect(cancelled).toEqual(['t1']);
  });

  it('shows neither once it waits for a manual retry', () => {
    render(<TaskCard task={makeTask({ resumeAt: undefined })} models={[]} onCancelResume={() => {}} />);
    expect(screen.getByText('Paused on a usage limit', { selector: '.task-status-badge' })).toBeTruthy();
    expect(screen.queryByText(/^Resumes at/)).toBeNull();
    expect(screen.queryByText('Don\'t resume')).toBeNull();
  });

  it('resumes it now when its session was saved, with or without a resume time, without a running plan', () => {
    const resumed: string[] = [];
    const { unmount } = render(<TaskCard task={makeTask()} run={saved} models={[]} onResumeNow={(id) => resumed.push(id)} onCancelResume={() => {}} />);
    fireEvent.click(screen.getByText('Resume now'));
    unmount();
    render(<TaskCard task={makeTask({ resumeAt: undefined })} run={saved} models={[]} onResumeNow={(id) => resumed.push(id)} />);
    fireEvent.click(screen.getByText('Resume now'));
    expect(resumed).toEqual(['t1', 't1']);
  });

  it('offers no resume now without a saved session', () => {
    render(<TaskCard task={makeTask()} models={[]} onResumeNow={() => {}} />);
    expect(screen.queryByText('Resume now')).toBeNull();
  });

  it('offers resume now, don\'t resume and skip among its actions while the run is held on the limit', () => {
    const calls: string[] = [];
    render(<TaskCard task={makeTask()} run={saved} models={[]} expanded onExpandedChange={() => {}}
      onResumeNow={() => calls.push('resume')} onCancelResume={() => calls.push('cancel')} onSkip={() => calls.push('skip')} />);
    const actions = screen.getAllByRole('button').filter((b) => b.classList.contains('task-action-btn')).map((b) => b.textContent);
    expect(actions).toEqual(['Resume Now', 'Don\'t Resume', 'Skip']);
    fireEvent.click(screen.getByText('Resume Now'));
    fireEvent.click(screen.getByText('Don\'t Resume'));
    fireEvent.click(screen.getByText('Skip'));
    expect(calls).toEqual(['resume', 'cancel', 'skip']);
  });

  it('has a message box that resumes it with the message, and no send now', () => {
    const sent: [string, string][] = [];
    render(<TaskCard task={makeTask()} run={saved} models={[]} expanded onExpandedChange={() => {}}
      onSendMessage={(id, text) => sent.push([id, text])} onSendMessageNow={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText(/resume it with/), { target: { value: 'limits reset, go on' } });
    expect(document.querySelector('.send-key-hint')).toBeNull();
    fireEvent.click(screen.getByText('Resume'));
    expect(sent).toEqual([['t1', 'limits reset, go on']]);
  });

  it('says it on a subtask card as well', () => {
    const cancelled: string[] = [];
    const parent = makeTask({ id: 'p1', status: 'in_progress', awaitingReason: undefined, resumeAt: undefined });
    render(<SubTaskCard task={makeTask({ id: 's1' })} parentTask={parent} models={[]} onCancelResume={(id) => cancelled.push(id)} />);
    expect(screen.getByText(/^Resumes at /)).toBeTruthy();
    fireEvent.click(screen.getByText('Don\'t resume'));
    expect(cancelled).toEqual(['s1']);
  });
});
