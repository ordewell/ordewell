import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DELEGATION_OFFERED, RUN_SETTINGS_DEFAULTS } from '@ordewell/core';
import App from '../App';
import { post as send } from './hostBridge';

/**
 * Delegation is a setting in core with no delegated task behind it yet
 * (ADR-0055 D21), so the panel offers no control for it and no surface shows
 * it, whatever is stored. App.settingsPanel.test.tsx covers the control itself
 * with the switch mocked on.
 */
describe('delegation in the VS Code views, until a delegated task exists (ADR-0055 D21)', () => {
  it('is switched off', () => {
    expect(DELEGATION_OFFERED).toBe(false);
  });

  it('shows nothing about it in the welcome screen or the Settings panel, even with a budget stored', () => {
    render(<App />);
    send({ type: 'setRunSettings', autonomous: true, run: { ...RUN_SETTINGS_DEFAULTS, delegationTokens: 5_000_000 }, maxParallel: 5 });

    expect(screen.queryByText(/delegation/i)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));

    expect(screen.getByRole('group', { name: 'Autonomy' })).toBeInTheDocument();
    expect(screen.queryByRole('spinbutton', { name: 'Delegation budget' })).toBeNull();
    expect(screen.queryByText(/delegation/i)).toBeNull();
    expect(screen.getByText(/Supervisor, automerge and autorun apply to this session/)).toBeInTheDocument();
  });
});
