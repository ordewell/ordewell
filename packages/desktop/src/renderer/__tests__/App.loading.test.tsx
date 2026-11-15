import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WindowContext } from '../../shared/bridge';
import { fakeDaemon } from '../session/__tests__/fakeDaemon';
import { App } from '../App';

vi.mock('../views', () => ({ registerViews: () => () => undefined }));
vi.mock('../frame/commands', () => ({ registerFrameCommands: () => () => undefined }));
vi.mock('../frame/Frame', () => ({ Frame: () => <div>Project ready</div> }));
vi.mock('../Welcome', () => ({ Welcome: () => <div>Welcome ready</div> }));

beforeEach(() => {
  fakeDaemon();
  Object.assign(window.ordewell.app, {
    info: async () => ({ platform: 'darwin' }),
    onMenuCommand: () => () => undefined,
  });
  Object.assign(window.ordewell, { prefs: { get: async () => ({ layouts: {} }) } });
});

describe('opening the desktop app', () => {
  it('shows progress while main resolves the window, then while the project preferences load', async () => {
    let context: ((value: WindowContext) => void) | undefined;
    let prefs: ((value: { layouts: object }) => void) | undefined;
    Object.assign(window.ordewell.app, { context: () => new Promise<WindowContext>((resolve) => { context = resolve; }) });
    Object.assign(window.ordewell.prefs, { get: () => new Promise((resolve) => { prefs = resolve; }) });
    render(<App />);
    expect(screen.getByRole('status')).toHaveTextContent('Opening Ordewell…');
    await act(async () => context?.({ kind: 'workspace', path: '/work/acme' }));
    expect(screen.getByRole('status')).toHaveTextContent('Opening project…');
    await act(async () => prefs?.({ layouts: {} }));
    expect(screen.getByText('Project ready')).toBeInTheDocument();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('ends a failed window read with Retry instead of a blank window', async () => {
    const context = vi.fn().mockRejectedValueOnce(new Error('The window could not be read.')).mockResolvedValue({ kind: 'welcome' });
    Object.assign(window.ordewell.app, { context });
    render(<App />);
    expect(await screen.findByText('The window could not be read.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Welcome ready')).toBeInTheDocument();
  });
});
