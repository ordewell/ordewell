import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as vscode from 'vscode';
import { listSessions, loadSession } from '@ordewell/core';
import { handleSlashCommand, isKnownSlashCommand, type SlashDeps } from '../SlashParser';
import { resolveSlashAlias, isBuiltinSlashCommand, slashHelp } from '@ordewell/ui/protocol';

vi.mock('@ordewell/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ordewell/core')>();
  return { ...actual, listSessions: vi.fn(), loadSession: vi.fn() };
});

const showQuickPick = vscode.window.showQuickPick as unknown as ReturnType<typeof vi.fn>;
const showInformationMessage = vscode.window.showInformationMessage as unknown as ReturnType<typeof vi.fn>;
const executeCommand = vscode.commands.executeCommand as unknown as ReturnType<typeof vi.fn>;

// The /sessions branch touches none of SlashDeps; an empty stub keeps the
// alias test about routing, not the planner wizard.
const deps = {} as unknown as SlashDeps;

const SESSION = {
  id: 's1',
  goal: 'Ship it',
  taskCount: 2,
  createdAt: 1700000000000,
  status: 'active',
  runners: ['codex'],
};

beforeEach(() => {
  vi.mocked(listSessions).mockReturnValue([] as never);
  showQuickPick.mockReset();
  showInformationMessage.mockReset();
  executeCommand.mockClear();
});

describe('/resume alias for /sessions (VS Code)', () => {
  it('is a built-in that resolves to /sessions and is listed in /help as an alias', () => {
    expect(isBuiltinSlashCommand('/resume')).toBe(true);
    expect(isBuiltinSlashCommand('/RESUME')).toBe(true);
    expect(isKnownSlashCommand('/resume')).toBe(true);
    expect(resolveSlashAlias('/resume')).toBe('/sessions');
    expect(resolveSlashAlias('/sessions')).toBe('/sessions');

    const line = slashHelp().split('\n').find((l) => l.startsWith('/resume'));
    expect(line).toBeDefined();
    expect(line).toContain('Alias for /sessions');
    expect(line).toMatch(/saved session/i);
  });

  it('shows the same "No saved sessions." note as /sessions', async () => {
    vi.mocked(listSessions).mockReturnValue([] as never);

    await handleSlashCommand('/sessions', deps);
    await handleSlashCommand('/resume', deps);

    expect(showInformationMessage.mock.calls.map((c) => c[0])).toEqual([
      'No saved sessions.',
      'No saved sessions.',
    ]);
  });

  it('opens the same saved-session picker and does nothing on cancel', async () => {
    vi.mocked(listSessions).mockReturnValue([SESSION] as never);
    showQuickPick.mockResolvedValue(undefined);

    await handleSlashCommand('/sessions', deps);
    await handleSlashCommand('/resume', deps);

    expect(executeCommand).not.toHaveBeenCalled();
    const [fromSessions, fromResume] = showQuickPick.mock.calls;
    expect(fromResume[1]).toEqual(fromSessions[1]);
    expect(fromSessions[0].map((o: { sessionId: string }) => o.sessionId)).toEqual(['s1']);
    expect(fromResume[0].map((o: { sessionId: string }) => o.sessionId)).toEqual(['s1']);
  });

  it('loads the picked session through the same command path', async () => {
    vi.mocked(listSessions).mockReturnValue([SESSION] as never);
    showQuickPick.mockResolvedValue({ sessionId: 's1' });
    vi.mocked(loadSession).mockReturnValue({ plan: {} } as never);

    await handleSlashCommand('/sessions', deps);
    await handleSlashCommand('/resume', deps);

    expect(executeCommand.mock.calls).toEqual([
      ['ordewell.loadSessionById', 's1'],
      ['ordewell.loadSessionById', 's1'],
    ]);
  });
});
