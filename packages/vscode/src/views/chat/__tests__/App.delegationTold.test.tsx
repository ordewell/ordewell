import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DELEGATION_OFFERED, RUN_SETTINGS_DEFAULTS } from '@ordewell/core';
import App from '../App';
import { post as send } from './hostBridge';

/*
 * A webview cannot read the checkout it was built from, so its own
 * DELEGATION_OFFERED is false wherever it runs: its host says whether
 * delegation is offered, with the run settings (ADR-0055 D21).
 */

const settings = (delegationOffered?: boolean) => send({
  type: 'setRunSettings', autonomous: true, run: { ...RUN_SETTINGS_DEFAULTS, delegationTokens: 5_000_000 }, maxParallel: 5,
  ...(delegationOffered === undefined ? {} : { delegationOffered }),
} as never);

describe('delegation, as the host tells the webview', () => {
  it('has the webview\'s own switch off, as it is in any build', () => {
    expect(DELEGATION_OFFERED).toBe(false);
  });

  it('shows the Tree budget and the summary once the host says it is offered', () => {
    render(<App />);
    settings(true);
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    expect(screen.getByRole('spinbutton', { name: 'Tree budget' })).toBeInTheDocument();
  });

  it('shows nothing of it when the host does not say so, or says it is not offered', () => {
    const { unmount } = render(<App />);
    settings();
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    expect(screen.queryByRole('spinbutton', { name: 'Tree budget' })).toBeNull();
    unmount();

    render(<App />);
    settings(false);
    expect(screen.queryByText(/delegation/i)).toBeNull();
  });
});
