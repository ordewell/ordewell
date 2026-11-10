import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import React, { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { taskRowView } from '@ordewell/core/plan-utils';
import type { Task } from '@ordewell/core';
import { RUNNER_NAMES, RunnerBadge, runnerName } from '../runners';
import { RefreshCw } from 'lucide-react';
import { Button } from '../Button';
import { PullIcon, PushIcon } from '../arrows';
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

  it('gives every runner it names a colour of its own, in the token table and the badge rules', () => {
    const tokens = readFileSync(resolve(__dirname, '../../tokens.css'), 'utf8');
    const rules = readFileSync(resolve(__dirname, '../../design.css'), 'utf8');
    const colours = new Set<string>();
    for (const id of Object.keys(RUNNER_NAMES)) {
      const { container } = render(<RunnerBadge runner={id} />);
      const badge = container.querySelector('.ow-runner-badge')!;
      expect(badge.textContent).toBe(runnerName(id));
      expect(badge.className).toContain(`ow-runner-${id}`);
      expect(badge.className).not.toContain('ow-runner-other');
      expect(tokens).toMatch(new RegExp(`--ow-runner-${id}:\\s*#[0-9a-f]{6};\\s*--ow-runner-${id}-tint:`));
      expect(rules).toContain(`.ow-runner-${id} {`);
      colours.add(new RegExp(`--ow-runner-${id}:\\s*(#[0-9a-f]{6})`).exec(tokens)![1]);
    }
    expect(colours.size).toBe(Object.keys(RUNNER_NAMES).length);
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

describe('a busy button', () => {
  it('turns its icon, says it is busy and refuses a press, with the turning stopped under reduced motion', () => {
    const press = vi.fn();
    render(<Button icon={RefreshCw} busy onClick={press}>Fetch</Button>);
    const button = screen.getByRole('button', { name: 'Fetch' });
    expect(button).toHaveAttribute('aria-busy', 'true');
    expect(button).toBeDisabled();
    expect(button.querySelector('svg')).toHaveClass('ow-spin');
    fireEvent.click(button);
    expect(press).not.toHaveBeenCalled();

    const rules = readFileSync(resolve(__dirname, '../../design.css'), 'utf8');
    // The guard is the media block that holds the rule, not any later one.
    expect(rules).toMatch(/prefers-reduced-motion: reduce\) \{[^@]*?\.ow-spin \{ animation: none; \}/);
  });

  it('is an ordinary button, with no busy mark or moving icon, when nothing is pending', () => {
    render(<><Button icon={RefreshCw}>Fetch</Button><Button icon={PullIcon} busyMotion="glide">Pull</Button></>);
    for (const name of ['Fetch', 'Pull']) {
      const button = screen.getByRole('button', { name });
      expect(button).not.toHaveAttribute('aria-busy');
      expect(button).toBeEnabled();
      expect(button.querySelector('svg')).not.toHaveClass('ow-spin');
      expect(button.querySelector('svg')).not.toHaveClass('ow-glide');
    }
  });

  it.each([
    { icon: PullIcon, name: 'Pull', way: 'down', shift: /0% \{ transform: translateY\(-\d+px\)[^}]*\}[^@]*100% \{ transform: translateY\(\d+px\)/ },
    { icon: PushIcon, name: 'Push', way: 'up', shift: /0% \{ transform: translateY\(\d+px\)[^}]*\}[^@]*100% \{ transform: translateY\(-\d+px\)/ },
  ])('glides $name\'s arrow $way with its line still, never turning it, and holds it under reduced motion', ({ icon, name, way, shift }) => {
    const press = vi.fn();
    render(<Button icon={icon} busy busyMotion="glide" onClick={press}>{name}</Button>);
    const button = screen.getByRole('button', { name });
    expect(button).toHaveAttribute('aria-busy', 'true');
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(press).not.toHaveBeenCalled();

    const svg = button.querySelector('svg')!;
    expect(svg).toHaveClass('ow-glide');
    expect(svg).not.toHaveClass('ow-spin');
    const arrow = svg.querySelector(`g.ow-glide-${way}`)!;
    expect(arrow.querySelectorAll('path')).toHaveLength(2);
    // The line is drawn outside the moving group, and the arrow is clipped short of it.
    const line = svg.querySelector(':scope > path')!;
    expect(arrow.contains(line)).toBe(false);
    const clip = arrow.parentElement!.getAttribute('clip-path')!;
    expect(clip).toMatch(/^url\(#[\w-]+\)$/);
    expect(svg.querySelector(`clipPath${clip.slice(4, -1)}`)).not.toBeNull();

    const rules = readFileSync(resolve(__dirname, '../../design.css'), 'utf8');
    const keyframes = rules.match(new RegExp(`@keyframes ow-glide-${way} \\{[\\s\\S]*?\\n\\}`))![0];
    expect(keyframes).toMatch(shift);
    expect(keyframes).not.toMatch(/rotate/);
    expect(rules).toMatch(new RegExp(`\\.ow-glide \\.ow-glide-${way} \\{ animation: ow-glide-${way} `));
    expect(rules).toMatch(new RegExp(`prefers-reduced-motion: reduce\\) \\{[^@]*?\\.ow-glide \\.ow-glide-${way}[^{]*\\{ animation: none; \\}`));
  });

  it('turns its icon by default, so a button that does not ask for a glide is unchanged', () => {
    render(<Button busy>Load more</Button>);
    const button = screen.getByRole('button', { name: 'Load more' });
    expect(button).toHaveAttribute('aria-busy', 'true');
    expect(button.querySelector('svg')).toBeNull();
    cleanup();
    render(<Button icon={PullIcon} busy>Pull</Button>);
    expect(screen.getByRole('button', { name: 'Pull' }).querySelector('svg')).toHaveClass('ow-spin');
  });

  it('gives each arrow on a page its own clip', () => {
    const { container } = render(<><PullIcon /><PullIcon /><PushIcon /></>);
    const ids = [...container.querySelectorAll('clipPath')].map((c) => c.id);
    expect(new Set(ids).size).toBe(3);
  });
});
