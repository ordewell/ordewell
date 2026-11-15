import React from 'react';
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import App from '../../test/ChatApp';
import { post } from './webview';

// A signed-out agent's empty catalog is fixed by signing in, not by `/refresh`,
// so the setup panel shows core's own reason instead of the generic hint.
describe('a runner that lists no models', () => {
  it('shows discovery progress until the catalog settles, then shows its models', () => {
    render(<App />);
    post({ type: 'modelDiscovery', state: 'loading' });
    post({ type: 'setConfiguredProviders', providers: [] });
    post({ type: 'setPlannerBackends', backends: [{ id: 'codex', label: 'Codex', kind: 'harness', runner: 'codex', usable: true }], provider: 'codex', runner: 'codex' });

    expect(screen.getByText('Loading models…').closest('[role="status"]')).toHaveAttribute('aria-busy', 'true');
    expect(screen.queryByText(/No models discovered/)).toBeNull();
    fireEvent.click(screen.getByText('Loading models…'));
    expect(screen.queryByText('No models found')).toBeNull();

    post({ type: 'setModelsByRunner', modelsByRunner: { codex: [{ modelId: 'gpt-5', modelLabel: 'GPT-5', variants: [] }] } });
    post({ type: 'modelDiscovery', state: 'ready' });
    expect(screen.queryByText('Loading models…')).toBeNull();
    expect(screen.queryByText(/No models discovered/)).toBeNull();
    fireEvent.click(screen.getByText('Select model...'));
    expect(screen.getByText('GPT-5')).toBeInTheDocument();
  });

  it('only shows the empty state after discovery has answered empty', () => {
    render(<App />);
    post({ type: 'modelDiscovery', state: 'loading' });
    post({ type: 'setConfiguredProviders', providers: [] });
    post({ type: 'setPlannerBackends', backends: [{ id: 'codex', label: 'Codex', kind: 'harness', runner: 'codex', usable: true }], provider: 'codex', runner: 'codex' });
    post({ type: 'setModelsByRunner', modelsByRunner: { codex: [] } });
    expect(screen.queryByText(/No models discovered/)).toBeNull();
    post({ type: 'modelDiscovery', state: 'ready' });
    expect(screen.getByText(/No models discovered/)).toBeInTheDocument();
  });

  it('keeps the catalog usable during refresh and reports a failed read with Retry', () => {
    render(<App />);
    post({ type: 'setConfiguredProviders', providers: [] });
    post({ type: 'setPlannerBackends', backends: [{ id: 'codex', label: 'Codex', kind: 'harness', runner: 'codex', usable: true }], provider: 'codex', runner: 'codex' });
    post({ type: 'setModelsByRunner', modelsByRunner: { codex: [{ modelId: 'gpt-5', modelLabel: 'GPT-5', variants: [] }] } });
    post({ type: 'modelDiscovery', state: 'loading' });
    expect(screen.getByText('Refreshing models…')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Select model...'));
    expect(screen.getByText('GPT-5')).toBeInTheDocument();
    post({ type: 'modelDiscovery', state: 'failed', error: 'The daemon did not answer.' });
    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't load models: The daemon did not answer.");
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.queryByText(/No models discovered/)).toBeNull();
  });

  it("shows the runner's own sign-in reason rather than /refresh", () => {
    render(<App />);
    post({ type: 'setConfiguredProviders', providers: [] });
    post({ type: 'setModelsByRunner', modelsByRunner: { 'qwen-code': [] } });
    post({
      type: 'setPlannerBackends',
      backends: [{ id: 'qwen-code', label: 'Qwen Code', kind: 'harness', runner: 'qwen-code', usable: true, auth: { state: 'signed-out' } }],
      provider: 'qwen-code',
      runner: 'qwen-code',
    });
    post({
      type: 'setModelDiscoveryErrors',
      errors: {},
      runnerErrors: { 'qwen-code': 'Qwen Code is not signed in. Run qwen and sign in there.' },
    });

    expect(screen.getByText('Qwen Code is not signed in. Run qwen and sign in there.')).toBeInTheDocument();
    expect(screen.queryByText(/run \/refresh/)).toBeNull();
  });

  it('still says /refresh when the runner gave no reason', () => {
    render(<App />);
    post({ type: 'setConfiguredProviders', providers: [] });
    post({ type: 'setModelsByRunner', modelsByRunner: { codex: [] } });
    post({
      type: 'setPlannerBackends',
      backends: [{ id: 'codex', label: 'Codex', kind: 'harness', runner: 'codex', usable: true, auth: { state: 'signed-in' } }],
      provider: 'codex',
      runner: 'codex',
    });
    post({ type: 'setModelDiscoveryErrors', errors: {}, runnerErrors: {} });

    expect(screen.getByText(/No models discovered for this agent yet: run/)).toBeInTheDocument();
  });
});
