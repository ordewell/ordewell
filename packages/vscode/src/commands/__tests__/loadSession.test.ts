import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { createTask, loadState, saveSession, type LegacyPlanState } from '@ordewell/core';
import { registerCommands, type CommandDeps } from '../CommandRegistry';

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
