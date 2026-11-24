import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import GetStarted from '../GetStarted';

/** The handlers GetStarted needs and these cases do not exercise. */
const ACTIONS = { onConfigure: vi.fn(), onDetectAgain: vi.fn(), onOpenLink: vi.fn(), redetect: 'idle' as const };
import { RUN_SETTINGS_DEFAULTS } from '@ordewell/core';
import { orNames } from '../../runnerNames';

describe('GetStarted', () => {
  it('names the other runners the host reports, not a list of its own', () => {
    const { container } = render(
      <GetStarted runnerNames={['Claude Code', 'Acme Agent']} {...ACTIONS} />,
    );
    expect(container.querySelector('.get-started-alt')?.textContent).toBe('Any other agent Ordewell knows plans too once installed: Acme Agent.');
    expect(container.textContent).not.toContain('OpenCode');
  });

  it('still asks for a coding agent before the host has reported any', () => {
    const { container } = render(<GetStarted runnerNames={[]} {...ACTIONS} />);
    expect(container.textContent).toContain('Install a coding agent');
  });
});

describe('GetStarted — plan approval', () => {
  const withAutorun = (autorun: boolean) => ({ autonomous: false, run: { ...RUN_SETTINGS_DEFAULTS, autorun } });

  it('says nothing runs until approval while autorun is known to be off', () => {
    const { container } = render(<GetStarted runnerNames={[]} {...ACTIONS} runSettings={withAutorun(false)} />);
    expect(container.textContent).toContain('Nothing runs until you run the plan.');
  });

  it('warns instead while autorun is known to be on', () => {
    const { container } = render(<GetStarted runnerNames={[]} {...ACTIONS} runSettings={withAutorun(true)} />);
    expect(container.textContent).not.toContain('Nothing runs until');
    expect(container.querySelector('.plan-approval-note.warn')?.textContent).toContain('Autorun is on');
    expect(container.querySelector('.plan-approval-note .command-token')?.textContent).toBe('/settings');
  });

  it('says neither while the run settings are unknown', () => {
    const { container } = render(<GetStarted runnerNames={[]} {...ACTIONS} runSettings={null} />);
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
