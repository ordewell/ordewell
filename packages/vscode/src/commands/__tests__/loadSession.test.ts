import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { createTask, loadState, saveSession, type LegacyPlanState } from '@ordewell/core';
import { registerCommands, type CommandDeps } from '../CommandRegistry';
import { __setWorkspaceFolders } from '../../test/vscode.mock';

const registerCommand = vscode.commands.registerCommand as unknown as ReturnType<typeof vi.fn>;

function plan(): LegacyPlanState {
  const at = '2026-01-01T00:00:00Z';
  return {
    tasks: [createTask({ id: 't1', order: 1, title: 'Parse JSON', assignedRunner: 'claude-code' })],
    generatedAt: at,
    status: 'approved',
    runners: ['claude-code'],
    lastUpdated: at,
  };
}

describe('loading a session from history', () => {
  let workspace: string;
  beforeEach(() => { workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-load-')); });
  afterEach(() => { fs.rmSync(workspace, { recursive: true, force: true }); });

  // The restore state is what the next window reload reopens: it must name the
  // loaded session, or the reload carries on under the id the window started with.
  it('keeps the loaded session\'s id in the restore state', async () => {
    const meta = saveSession(plan(), 'build me a parser', workspace);
    registerCommand.mockClear();
    const session = { loadPlan: vi.fn(), runSnapshot: vi.fn() };
    const chatProvider = { restoreChat: vi.fn(), showPlan: vi.fn(), adoptRun: vi.fn() };
    registerCommands({ subscriptions: [] } as unknown as vscode.ExtensionContext, {
      session,
      chatProvider,
      fsAdapter: { getWorkspaceRoot: () => workspace },
      setCurrentPlan: vi.fn(),
      setCurrentGoal: vi.fn(),
      persistState: vi.fn(),
      sendRunSettings: vi.fn(),
      log: vi.fn(),
    } as unknown as CommandDeps);
    const loadById = registerCommand.mock.calls.find(([id]) => id === 'ordewell.loadSessionById')![1] as (id: string) => Promise<void>;

    await loadById(meta.id);

    expect(session.loadPlan).toHaveBeenCalledWith(expect.anything(), 'build me a parser', workspace, { sessionId: meta.id });
    expect(loadState(workspace)?.sessionId).toBe(meta.id);
  });

  it('answers that nothing opened, and leaves the window as it was, when the Session refuses the load', async () => {
    const meta = saveSession(plan(), 'build me a parser', workspace);
    registerCommand.mockClear();
    const session = { loadPlan: vi.fn(() => { throw new Error('could not be saved'); }), runSnapshot: vi.fn() };
    const chatProvider = { restoreChat: vi.fn(), showPlan: vi.fn(), adoptRun: vi.fn() };
    const setCurrentPlan = vi.fn();
    registerCommands({ subscriptions: [] } as unknown as vscode.ExtensionContext, {
      session,
      chatProvider,
      fsAdapter: { getWorkspaceRoot: () => workspace },
      setCurrentPlan,
      setCurrentGoal: vi.fn(),
      persistState: vi.fn(),
      sendRunSettings: vi.fn(),
      log: vi.fn(),
    } as unknown as CommandDeps);
    const loadById = registerCommand.mock.calls.find(([id]) => id === 'ordewell.loadSessionById')![1] as (id: string) => Promise<boolean>;

    await expect(loadById(meta.id)).resolves.toBe(false);

    expect(setCurrentPlan).not.toHaveBeenCalled();
    expect(chatProvider.restoreChat).not.toHaveBeenCalled();
  });

  it('pushes this window\'s run settings once the loaded session is the one it shows', async () => {
    const meta = saveSession(plan(), 'build me a parser', workspace);
    registerCommand.mockClear();
    const session = { loadPlan: vi.fn(), runSnapshot: vi.fn() };
    const chatProvider = { restoreChat: vi.fn(), showPlan: vi.fn(), adoptRun: vi.fn() };
    const sendRunSettings = vi.fn();
    registerCommands({ subscriptions: [] } as unknown as vscode.ExtensionContext, {
      session,
      chatProvider,
      fsAdapter: { getWorkspaceRoot: () => workspace },
      setCurrentPlan: vi.fn(),
      setCurrentGoal: vi.fn(),
      persistState: vi.fn(),
      sendRunSettings,
      log: vi.fn(),
    } as unknown as CommandDeps);
    const loadById = registerCommand.mock.calls.find(([id]) => id === 'ordewell.loadSessionById')![1] as (id: string) => Promise<void>;

    await loadById(meta.id);

    expect(sendRunSettings).toHaveBeenCalledTimes(1);
  });
});

// Task #47: with no folder, the root was the extension host's cwd, `/` for a
// VS Code started from the Dock. A load or save is refused before it reads or
// writes any project.
describe('the session commands in a window with no folder', () => {
  const showWarningMessage = vscode.window.showWarningMessage as unknown as ReturnType<typeof vi.fn>;
  let workspace: string;
  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-load-nofolder-'));
    showWarningMessage.mockReset();
    vi.mocked(vscode.window.showQuickPick).mockClear();
    vi.mocked(vscode.window.showInputBox).mockClear();
    __setWorkspaceFolders(undefined);
  });
  afterEach(() => { fs.rmSync(workspace, { recursive: true, force: true }); });

  function register() {
    registerCommand.mockClear();
    const session = { loadPlan: vi.fn(), runSnapshot: vi.fn() };
    const saveCurrentSession = vi.fn(() => null);
    registerCommands({ subscriptions: [] } as unknown as vscode.ExtensionContext, {
      session,
      chatProvider: { restoreChat: vi.fn(), showPlan: vi.fn(), adoptRun: vi.fn() },
      fsAdapter: { getWorkspaceRoot: () => workspace },
      getCurrentGoal: () => 'build me a parser',
      setCurrentPlan: vi.fn(),
      setCurrentGoal: vi.fn(),
      persistState: vi.fn(),
      saveCurrentSession,
      sendRunSettings: vi.fn(),
      log: vi.fn(),
    } as unknown as CommandDeps);
    const command = (id: string) => registerCommand.mock.calls.find(([name]) => name === id)![1] as (...args: unknown[]) => Promise<unknown>;
    return { session, saveCurrentSession, command };
  }
  const noFolderWarnings = () => showWarningMessage.mock.calls.filter(([text]) => String(text).startsWith('Ordewell needs an open folder'));

  it('opens no saved session, by id or from the list', async () => {
    const meta = saveSession(plan(), 'build me a parser', workspace);
    const h = register();
    await expect(h.command('ordewell.loadSessionById')(meta.id)).resolves.toBe(false);
    await h.command('ordewell.loadSession')();
    expect(h.session.loadPlan).not.toHaveBeenCalled();
    expect(vscode.window.showQuickPick).not.toHaveBeenCalled();
    expect(loadState(workspace)).toBeNull();
    expect(noFolderWarnings()).toHaveLength(2);
  });

  it('saves nothing', async () => {
    const h = register();
    await h.command('ordewell.saveSession')();
    expect(vscode.window.showInputBox).not.toHaveBeenCalled();
    expect(h.saveCurrentSession).not.toHaveBeenCalled();
    expect(noFolderWarnings()).toHaveLength(1);
  });
});
