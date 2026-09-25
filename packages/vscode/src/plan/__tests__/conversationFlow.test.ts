import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { Session, RunnerRegistry, BufferedTaskOutputSource, createTask, loadSession, saveSession } from '@ordewell/core';
import type { IAiService, ITerminalRunner, LegacyPlanState, ModelResolver } from '@ordewell/core';
import { fakeConfig, fakeFileSystem } from '@ordewell/core/testing';
import { forkConversation, rewindConversation, compactConversation, type ConversationDeps } from '../conversation';

const executeCommand = vscode.commands.executeCommand as unknown as ReturnType<typeof vi.fn>;
const withProgress = vscode.window.withProgress as unknown as ReturnType<typeof vi.fn>;
const showWarningMessage = vscode.window.showWarningMessage as unknown as ReturnType<typeof vi.fn>;

const GOAL = 'build me a parser';
const SUMMARY = 'Parser for JSON, streaming added, no dependencies.';

function plan(): LegacyPlanState {
  const at = (n: number) => `2026-01-01T00:00:0${n}Z`;
  return {
    tasks: [createTask({ id: 't1', order: 1, title: 'Parse JSON', prompt: 'do it', assignedRunner: 'claude-code' })],
    generatedAt: at(0),
    status: 'approved',
    runners: ['claude-code'],
    lastUpdated: at(0),
    conversationHistory: [
      { role: 'user', content: GOAL, timestamp: at(0) },
      { role: 'assistant', content: 'Plan generated with 1 task.', timestamp: at(1), kind: 'plan_generated' },
      { role: 'user', content: 'add streaming', timestamp: at(2) },
      { role: 'assistant', content: 'Tasks updated.', timestamp: at(3) },
      { role: 'user', content: 'keep it dependency-free', timestamp: at(4) },
      { role: 'assistant', content: 'Noted.', timestamp: at(5) },
      { role: 'user', content: 'one more thing', timestamp: at(6) },
      { role: 'assistant', content: 'Done.', timestamp: at(7) },
    ],
  };
}

function makeSession(workspace: string): Session {
  const planner: Partial<IAiService> = {
    startConversation: async () => ({ kind: 'message', text: `<conversation_summary>${SUMMARY}</conversation_summary>`, researchLog: [] }),
    continueConversation: async () => ({ kind: 'message', text: `<conversation_summary>${SUMMARY}</conversation_summary>`, researchLog: [] }),
    hasActiveConversation: () => false,
    reset: () => {},
  };
  const runner = { spawn: vi.fn(), stop: vi.fn(), stopAll: vi.fn(), activeCount: 0 } as unknown as ITerminalRunner;
  return new Session({
    config: fakeConfig(),
    notifications: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), confirm: vi.fn().mockResolvedValue(undefined) },
    runner,
    registry: new RunnerRegistry(),
    workspaceRoot: () => workspace,
    fsAdapter: fakeFileSystem(),
    broadcast: vi.fn(),
    modelResolver: { getCachedRunnerModels: () => [], modelsForRunners: vi.fn().mockResolvedValue({}) } as unknown as ModelResolver,
    settings: () => ({ tddEnabled: false }),
    aiService: planner as IAiService,
    taskOutput: new BufferedTaskOutputSource({ transcripts: { finalAssistantText: async () => null } }),
  });
}

describe('fork, rewind and compact through the VS Code conversation module', () => {
  let workspace: string;
  let current: Session;
  let chat: { showError: ReturnType<typeof vi.fn>; replaceConversation: ReturnType<typeof vi.fn>; setConversationBusy: ReturnType<typeof vi.fn> };
  let persistState: ReturnType<typeof vi.fn>;

  const deps = (): ConversationDeps => ({
    session: current,
    chatProvider: chat,
    setCurrentPlan: vi.fn(),
    persistState,
    isGeneratingPlan: () => false,
  } as unknown as ConversationDeps);

  const saved = (id: string) => loadSession(id, workspace)!.plan;
  const contents = (p: LegacyPlanState) => (p.conversationHistory ?? []).map((m) => m.content);

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-vscode-flow-'));
    chat = { showError: vi.fn(), replaceConversation: vi.fn(), setConversationBusy: vi.fn() };
    persistState = vi.fn();
    for (const fn of [executeCommand, withProgress, showWarningMessage]) fn.mockReset();
    withProgress.mockImplementation(async (_o: unknown, task: (p: unknown, t: unknown) => Promise<unknown>) =>
      task({}, { onCancellationRequested: () => ({ dispose: () => {} }) }));
    // The extension's loadSessionById: the fork becomes the session the surface drives.
    executeCommand.mockImplementation(async (cmd: string, id: string) => {
      if (cmd !== 'ordewell.loadSessionById') return undefined;
      const next = makeSession(workspace);
      next.loadPlan(loadSession(id, workspace)!.plan, GOAL, workspace, { sessionId: id });
      current = next;
      return undefined;
    });
    const meta = saveSession(plan(), GOAL, workspace, 'session-original');
    current = makeSession(workspace);
    current.loadPlan(loadSession(meta.id, workspace)!.plan, GOAL, workspace, { sessionId: meta.id });
  });

  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it('forks, rewinds the fork, then compacts it, leaving the original session file alone', async () => {
    const originalBefore = saved('session-original');

    await forkConversation(deps());
    const forkId = current.sessionId;
    expect(forkId).not.toBe('session-original');
    expect(saved(forkId).tasks.map((t) => t.id)).toEqual(['t1']);
    expect(contents(saved(forkId))).toEqual(contents(originalBefore));

    await rewindConversation(deps(), '6');
    expect(contents(saved(forkId))).toEqual(contents(originalBefore).slice(0, 6));
    expect(chat.replaceConversation).toHaveBeenLastCalledWith(expect.arrayContaining([expect.objectContaining({ content: 'Noted.' })]), true);
    expect(chat.replaceConversation.mock.lastCall![0]).toHaveLength(6);
    expect(saved(forkId).tasks.map((t) => t.id)).toEqual(['t1']);

    await compactConversation(deps());
    const condensed = saved(forkId).conversationHistory!;
    expect(condensed[0]).toMatchObject({ kind: 'compaction' });
    expect(condensed[0].content).toContain(SUMMARY);
    expect(condensed.slice(1).map((m) => m.content)).toEqual(['add streaming', 'Tasks updated.', 'keep it dependency-free', 'Noted.']);
    expect(chat.replaceConversation.mock.lastCall![0][0]).toMatchObject({ kind: 'compaction' });

    await rewindConversation(deps(), '0');
    expect(chat.showError).toHaveBeenCalledWith(expect.stringMatching(/Could not rewind.*condensed/));
    expect(saved(forkId).conversationHistory).toEqual(condensed);

    expect(saved('session-original')).toEqual(originalBefore);
  });

  it('refuses all three on a session with no conversation', async () => {
    current = makeSession(workspace);

    await forkConversation(deps());
    await rewindConversation(deps(), '2');
    await compactConversation(deps());

    expect(chat.showError).toHaveBeenCalledTimes(3);
    expect(chat.replaceConversation).not.toHaveBeenCalled();
  });
});
