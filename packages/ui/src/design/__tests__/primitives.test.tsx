import React, { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { taskRowView } from '@ordewell/core/plan-utils';
import type { Task } from '@ordewell/core';
import { RunnerBadge, runnerName } from '../runners';
import { Tabs } from '../Tabs';
import TaskSummary from '../../chat/components/TaskSummary';

afterEach(cleanup);

describe('the runner badge', () => {
  it('names a runner it colours, and shortens without dropping the name', () => {
    const { container } = render(<><RunnerBadge runner="claude-code" /><RunnerBadge runner="claude-code" short /></>);
    const [full, short] = container.querySelectorAll('.ow-runner-badge');
    expect(full.textContent).toBe('Claude Code');
    expect(full.className).toContain('ow-runner-claude-code');
    expect(short.textContent).toBe('Claude');
    expect(short.getAttribute('title')).toBe('Claude Code');
  });

  it('draws a runner it does not know neutral, by its id', () => {
    const { container } = render(<RunnerBadge runner="acme" />);
    const badge = container.querySelector('.ow-runner-badge')!;
    expect(badge.textContent).toBe('acme');
    expect(badge.className).toContain('ow-runner-other');
    // An inherited key is not a runner.
    expect(runnerName('toString')).toBe('toString');
  });
});

describe('the tabs', () => {
  function Strip({ onSelect }: { onSelect: (id: string) => void }) {
    const [active, setActive] = useState('a');
    return (
      <Tabs label="Views" active={active} onSelect={(id) => { setActive(id); onSelect(id); }}
        tabs={[{ id: 'a', label: 'Alpha' }, { id: 'b', label: 'Beta', count: 3 }, { id: 'c', label: 'Gamma' }]} />
    );
  }

  it('keeps only the active tab in the Tab order and moves with the arrows, wrapping at the ends', () => {
    const onSelect = vi.fn();
    render(<Strip onSelect={onSelect} />);
    const alpha = screen.getByRole('tab', { name: 'Alpha' });
    expect(alpha.tabIndex).toBe(0);
    expect(screen.getByRole('tab', { name: /Beta/ }).tabIndex).toBe(-1);

    fireEvent.keyDown(alpha, { key: 'ArrowLeft' });
    expect(onSelect).toHaveBeenLastCalledWith('c');
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Gamma' }));

    fireEvent.keyDown(document.activeElement!, { key: 'Home' });
    expect(onSelect).toHaveBeenLastCalledWith('a');
    expect(screen.getByRole('tab', { name: 'Alpha' }).getAttribute('aria-selected')).toBe('true');
  });
});

describe('the task summary', () => {
  const task: Task = {
    id: 't', order: 2, title: 'Write the parser', description: '', type: 'ai', status: 'pending', dependencies: [], subtasks: [],
    assignedRunner: 'claude-code', taskMode: 'build', assignedModel: { modelId: 'anthropic/opus', modelLabel: 'Opus', thinkingEffort: 'high' },
  };
  const row = taskRowView(task);

  it('says the runner, model and effort on a second line when comfortable', () => {
    const { container } = render(<TaskSummary task={task} row={row} />);
    expect(container.querySelector('.task-summary-comfortable')).not.toBeNull();
    expect(container.querySelector('.task-assignment')?.textContent).toBe('Claude Code · Opus · high');
  });

  it('keeps the runner badge on one line when compact, with the rest in the tooltip', () => {
    const { container } = render(<TaskSummary task={task} row={row} density="compact" />);
    const summary = container.querySelector('.task-summary-compact')!;
    expect(summary.getAttribute('title')).toBe('Claude Code · Opus · high');
    expect(container.querySelector('.task-assignment')?.textContent).toBe('Claude');
    expect(screen.getByText('Write the parser')).toBeTruthy();
  });

  it('offers Open chat only once there is a chat to open', () => {
    const onOpenChat = vi.fn();
    render(<TaskSummary task={task} row={{ ...row, chatAvailable: false }} onOpenChat={onOpenChat} />);
    expect(screen.queryByRole('button', { name: 'Open chat' })).toBeNull();
    cleanup();
    render(<TaskSummary task={task} row={{ ...row, chatAvailable: true }} onOpenChat={onOpenChat} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open chat' }));
    expect(onOpenChat).toHaveBeenCalledOnce();
  });
});
