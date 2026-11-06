import React from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import App from '../../test/ChatApp';
import { post } from './webview';

// A signed-out agent's empty catalog is fixed by signing in, not by `/refresh`,
// so the setup panel shows core's own reason instead of the generic hint.
describe('a runner that lists no models', () => {
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
