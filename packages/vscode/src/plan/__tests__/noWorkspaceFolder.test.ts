import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { createSession, createTask, RunnerRegistry, BufferedTaskOutputSource, createEmptyPlan, saveState } from '@ordewell/core';
import type { IAiService, IRunner, LegacyPlanState, ModelResolver, Session } from '@ordewell/core';
import { fakeConfig, fakeFileSystem } from '@ordewell/core/testing';
import type { HostToWebview, WebviewToHost } from '@ordewell/ui/protocol';
import { ChatViewProvider } from '../../providers/ChatViewProvider';
import { VsCodeFileSystem } from '../../adapters/VsCodeFileSystem';
import { routeWebviewMessage, type WebviewRouterDeps } from '../webviewRouter';
import { restoreState } from '../../state/StatePersistence';
import { __setWorkspaceFolders } from '../../test/vscode.mock';

// Task #47: with no folder open, VS Code started from the Dock has `/` for its
// cwd, and the extension took that for the project: the first prompt made the
// session's lease mkdir `/.ordewell` and masked the planner's own answer. Here a
// read-only temp directory stands in for `/`, and the planner is a fake.

const showWarningMessage = vscode.window.showWarningMessage as unknown as ReturnType<typeof vi.fn>;
const executeCommand = vscode.commands.executeCommand as unknown as ReturnType<typeof vi.fn>;
const NO_FOLDER = 'Ordewell needs an open folder to plan in. Open a folder, then send your message again.';

const skipOnWindows = process.platform === 'win32';

function harness(initialFolders: readonly string[] | undefined) {
  __setWorkspaceFolders(initialFolders);
  const fsAdapter = new VsCodeFileSystem();
  const planner = {
    reset: vi.fn(),
    hasActiveConversation: () => false,
    startConversation: vi.fn(async () => ({ kind: 'reply', text: 'Which database?' })),
    continueConversation: vi.fn(async () => ({ kind: 'reply', text: 'Noted.' })),
  };
  const posts: HostToWebview[] = [];
  const chatProvider = new ChatViewProvider({ toString: () => 'file:///ext' } as unknown as vscode.Uri);
  chatProvider.postMessage = (msg) => { posts.push(msg); };
  const runner = { spawn: vi.fn(), stop: vi.fn(), stopAll: vi.fn(), activeCount: 0 } as unknown as IRunner;
  // Built as the extension host builds it: no saveSession, so the real store
  // and the process's lease host write wherever the root says.
  const session: Session = createSession({
    config: fakeConfig(),
    notifications: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), confirm: vi.fn().mockResolvedValue(undefined) },
    runner,
    registry: new RunnerRegistry(),
    workspaceRoot: () => fsAdapter.getWorkspaceRoot(),
    fsAdapter: fakeFileSystem(),
    broadcast: (msg) => chatProvider.conversation.receive(msg),
    modelResolver: { getCachedRunnerModels: () => [], modelsForRunners: vi.fn().mockResolvedValue({}) } as unknown as ModelResolver,
    settings: () => ({}),
    aiService: planner as unknown as IAiService,
    taskOutput: new BufferedTaskOutputSource(),
  });
  let current: LegacyPlanState = createEmptyPlan();
  let goal = '';
  const deps: WebviewRouterDeps = {
    session,
    chatProvider,
    modelResolver: {} as unknown as WebviewRouterDeps['modelResolver'],
    runnerRegistry: new RunnerRegistry(),
    config: { aiProvider: 'openrouter', apiKey: 'sk-test', getProviderApiKey: () => 'sk-test', planningModel: 'some/model', enabledRunners: ['claude-code'] } as unknown as WebviewRouterDeps['config'],
    fsAdapter,
    runner: { stopAll: vi.fn() } as unknown as WebviewRouterDeps['runner'],
    notifications: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), confirm: vi.fn() },
    getCurrentPlan: () => current,
    setCurrentPlan: (p) => { current = p; },
    getCurrentGoal: () => goal,
    setCurrentGoal: (g) => { goal = g; },
    isGeneratingPlan: () => session.isPlannerBusy,
    persistState: vi.fn(),
    saveCurrentSession: vi.fn(() => null),
    sendRunSettings: vi.fn(),
    log: () => {},
    extension: {
      ready: vi.fn(), refreshChildren: vi.fn(async () => {}), openChild: vi.fn(async () => {}), closeChild: vi.fn(), messageChild: vi.fn(async () => {}), answerChildCheckpoint: vi.fn(async () => {}), openChildTaskLog: vi.fn(async () => {}),
      refreshModels: vi.fn(), runSlashCommand: vi.fn(async () => {}), setPlanner: vi.fn(async () => {}), setPlannerModel: vi.fn(async () => {}),
      openTaskLog: vi.fn(), openFile: vi.fn(), openLink: vi.fn(), setPlanDockHeight: vi.fn(), changeSettings: vi.fn(async () => {}),
      setRunnerEnabled: vi.fn(async () => {}), loginPlanner: vi.fn(async () => {}),
    },
    getPendingRunners: () => undefined,
    setPendingRunners: () => {},
  };
  const startPlanning = vi.spyOn(session, 'startPlanning');
  const continueConversation = vi.spyOn(session, 'continueConversation');
  const forceSendPrompt = vi.spyOn(session, 'forceSendPrompt');
  const route = (msg: WebviewToHost) => routeWebviewMessage(msg, deps);
  const unsent = () => posts.filter((m): m is Extract<HostToWebview, { type: 'promptUnsent' }> => m.type === 'promptUnsent').map((m) => m.text);
  const noFolderWarnings = () => showWarningMessage.mock.calls.filter(([text]) => text === NO_FOLDER);
  const turnsStarted = () => startPlanning.mock.calls.length + continueConversation.mock.calls.length + forceSendPrompt.mock.calls.length;
  return { session, deps, fsAdapter, planner, posts, route, unsent, noFolderWarnings, turnsStarted };
}

describe.skipIf(skipOnWindows)('a VS Code window with no folder open (task #47)', () => {
  // chmod has no effect on Windows: the read-only stand-in for `/` is POSIX-only.
  let fakeRoot: string;
  let scratch: string;
  const sessions: Session[] = [];

  beforeEach(() => {
    showWarningMessage.mockReset();
    executeCommand.mockClear();
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-nofolder-'));
    fakeRoot = path.join(scratch, 'root');
    fs.mkdirSync(fakeRoot);
    fs.chmodSync(fakeRoot, 0o555);
    vi.spyOn(process, 'cwd').mockReturnValue(fakeRoot);
  });
  afterEach(() => {
    for (const s of sessions.splice(0)) s.destroy();
    vi.restoreAllMocks();
    fs.chmodSync(fakeRoot, 0o755);
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  const build = (folders: readonly string[] | undefined) => {
    const h = harness(folders);
    sessions.push(h.session);
    return h;
  };

  for (const [label, folders] of [['an empty window or one with only a loose file', undefined], ['a workspace with no folders', []]] as const) {
    it(`refuses a prompt in ${label} before any turn, lease or write, and gives the draft back`, async () => {
      const h = build(folders);
      expect(h.fsAdapter.getWorkspaceRoot()).not.toBe(fakeRoot);

      await h.route({ type: 'sendMessage', text: 'build me a parser', typed: true });

      expect(h.turnsStarted()).toBe(0);
      expect(h.planner.startConversation).not.toHaveBeenCalled();
      expect(fs.readdirSync(fakeRoot)).toEqual([]);
      expect(h.noFolderWarnings()).toHaveLength(1);
      expect(h.posts.filter((m) => m.type === 'showError')).toEqual([]);
      expect(h.unsent()).toEqual(['build me a parser']);
    });
  }

  it('offers VS Code\'s own Open Folder from the refusal', async () => {
    const h = build(undefined);
    showWarningMessage.mockResolvedValueOnce('Open Folder');
    await h.route({ type: 'sendMessage', text: 'build me a parser', typed: true });
    expect(h.noFolderWarnings()[0]).toEqual([NO_FOLDER, 'Open Folder']);
    await vi.waitFor(() => expect(executeCommand).toHaveBeenCalledWith('vscode.openFolder'));
  });

  it('refuses Send now and Try Again the same way', async () => {
    const h = build(undefined);
    await h.route({ type: 'sendMessageNow', text: 'right now' });
    await h.route({ type: 'sendMessage', text: 'again', typed: true, again: true } as WebviewToHost);
    expect(h.turnsStarted()).toBe(0);
    expect(h.noFolderWarnings()).toHaveLength(2);
    expect(h.unsent()).toEqual(['right now', 'again']);
    expect(fs.readdirSync(fakeRoot)).toEqual([]);
  });

  it('refuses Execute and a Retry compaction before the session runs anything', async () => {
    const h = build(undefined);
    const execute = vi.spyOn(h.session, 'execute');
    const retry = vi.spyOn(h.session, 'retryPlannerCompaction');
    await h.route({ type: 'sendSystemCommand', command: 'executePlan', taskId: '' });
    await h.route({ type: 'sendSystemCommand', command: 'retryPlannerCompaction', taskId: '' });
    expect(execute).not.toHaveBeenCalled();
    expect(retry).not.toHaveBeenCalled();
    expect(h.noFolderWarnings()).toHaveLength(2);
    expect(fs.readdirSync(fakeRoot)).toEqual([]);
  });

  it('resumes no saved session at activation, and says nothing until asked', () => {
    // A restore snapshot where the root would have pointed, from before the fix.
    const at = '2026-01-01T00:00:00Z';
    fs.chmodSync(fakeRoot, 0o755);
    saveState({ tasks: [createTask({ id: 't1', order: 1, title: 'Old task', prompt: 'p', assignedRunner: 'claude-code' })], generatedAt: at, status: 'draft', runners: ['claude-code'], lastUpdated: at }, fakeRoot, 'old-session');
    const h = build(undefined);
    const loadPlan = vi.spyOn(h.session, 'loadPlan');
    const setCurrentPlan = vi.spyOn(h.deps, 'setCurrentPlan');
    restoreState({ ...h.deps, workspaceRoot: () => fakeRoot, warn: vi.fn() });
    expect(loadPlan).not.toHaveBeenCalled();
    expect(setCurrentPlan).not.toHaveBeenCalled();
    expect(h.noFolderWarnings()).toEqual([]);
  });

  it('starts the turn once a folder is open, and writes the session there', async () => {
    const project = path.join(scratch, 'project');
    fs.mkdirSync(project);
    const h = build([project]);
    await h.route({ type: 'sendMessage', text: 'build me a parser', typed: true });
    expect(h.noFolderWarnings()).toEqual([]);
    expect(h.session.startPlanning).toHaveBeenCalledTimes(1);
    expect(h.planner.startConversation).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(path.join(project, '.ordewell'))).toBe(true);
    expect(fs.readdirSync(fakeRoot)).toEqual([]);
  });

  it('plans in the first folder of a multi-root workspace (ADR-0014)', async () => {
    const first = path.join(scratch, 'first');
    const second = path.join(scratch, 'second');
    fs.mkdirSync(first);
    fs.mkdirSync(second);
    const h = build([first, second]);
    expect(h.fsAdapter.getWorkspaceRoot()).toBe(first);
    await h.route({ type: 'sendMessage', text: 'build me a parser', typed: true });
    expect(h.planner.startConversation).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(path.join(first, '.ordewell'))).toBe(true);
    expect(fs.existsSync(path.join(second, '.ordewell'))).toBe(false);
  });

  it('after the last folder is removed, refuses the next prompt and keeps the session on its own project', async () => {
    const project = path.join(scratch, 'project');
    fs.mkdirSync(project);
    const h = build([project]);
    await h.route({ type: 'sendMessage', text: 'build me a parser', typed: true });
    expect(h.turnsStarted()).toBe(1);

    __setWorkspaceFolders([]);
    await h.route({ type: 'sendMessage', text: 'and add tests', typed: true });

    expect(h.turnsStarted()).toBe(1);
    expect(h.planner.continueConversation).not.toHaveBeenCalled();
    expect(h.noFolderWarnings()).toHaveLength(1);
    expect(h.unsent()).toEqual(['and add tests']);
    // Whatever the host still saves for the session it already holds goes to
    // that session's project, never to the extension host's cwd.
    expect(h.fsAdapter.getWorkspaceRoot()).toBe(project);
    expect(h.session.workspaceRoot).toBe(project);
    expect(fs.readdirSync(fakeRoot)).toEqual([]);
  });
});
