import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import GetStarted from '../GetStarted';
import { RUN_SETTINGS_DEFAULTS } from '@ordewell/core';
import { orNames } from '../../runnerNames';

describe('GetStarted', () => {
  it('names the runners the host reports, not a list of its own', () => {
    const { container } = render(
      <GetStarted runnerNames={['Claude Code', 'Acme Agent']} onConfigure={vi.fn()} />,
    );
    expect(container.textContent).toContain('Claude Code or Acme Agent');
    expect(container.textContent).not.toContain('OpenCode');
  });

  it('still asks for a coding agent before the host has reported any', () => {
    const { container } = render(<GetStarted runnerNames={[]} onConfigure={vi.fn()} />);
    expect(container.textContent).toContain('Install a coding agent');
  });
});

describe('GetStarted — plan approval', () => {
  const withAutorun = (autorun: boolean) => ({ autonomous: false, run: { ...RUN_SETTINGS_DEFAULTS, autorun } });

  it('says nothing runs until approval while autorun is known to be off', () => {
    const { container } = render(<GetStarted runnerNames={[]} onConfigure={vi.fn()} runSettings={withAutorun(false)} />);
    expect(container.textContent).toContain('Nothing runs until you approve the plan.');
  });

  it('warns instead while autorun is known to be on', () => {
    const { container } = render(<GetStarted runnerNames={[]} onConfigure={vi.fn()} runSettings={withAutorun(true)} />);
    expect(container.textContent).not.toContain('Nothing runs until');
    expect(container.querySelector('.plan-approval-note.warn')?.textContent).toContain('Autorun is on');
    expect(container.querySelector('.plan-approval-note .command-token')?.textContent).toBe('/settings');
  });

  it('says neither while the run settings are unknown', () => {
    const { container } = render(<GetStarted runnerNames={[]} onConfigure={vi.fn()} runSettings={null} />);
    expect(container.textContent).not.toContain('Nothing runs until');
    expect(container.textContent).not.toContain('Autorun is on');
  });
});

describe('orNames', () => {
  it('reads as prose', () => {
    expect(orNames([], 'a coding agent')).toBe('a coding agent');
    expect(orNames(['A'])).toBe('A');
    expect(orNames(['A', 'B'])).toBe('A or B');
    expect(orNames(['A', 'B', 'C'])).toBe('A, B or C');
  });
});
