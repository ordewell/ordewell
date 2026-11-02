import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  BufferedTaskOutputSource, createEmptyPlan, createSession, createTask, detectInstalledPlanner, recordedInstalledPlanner, resetInstalledPlanner, RunnerRegistry,
  RUN_SETTINGS_DEFAULTS, type ConversationRequest, type ConversationTurn, type IAiService, type IRunner, type LegacyPlanState, type ModelResolver, type PlannerUsability,
} from '@ordewell/core';
import { fakeConfig, fakeFileSystem } from '@ordewell/core/testing';
import { ChatViewProvider } from '../../providers/ChatViewProvider';
import type { HostToWebview } from '../../shared/protocol';
import { handleNewSession, handleStartPlanning, handleStopPlanning, type PlanManagerDeps } from '../PlanManager';
import { routeWebviewMessage, type WebviewRouterDeps } from '../webviewRouter';

/** No AI_PROVIDER and no key: the planner is whatever the probe records, openrouter until it answers. */
function keylessConfig() {
  const config = fakeConfig({ getProviderApiKey: () => '', orchestratorModel: '', planningModel: '', enabledRunners: ['claude-code'] });
  Object.defineProperty(config, 'aiProvider', { get: () => recordedInstalledPlanner() ?? 'openrouter' });
  return config;
}

/** The activation probe, held until the test answers it: Claude Code is usable. */
function heldProbe() {
  let answer!: (value: PlannerUsability) => void;
  const gate = new Promise<PlannerUsability>((resolve) => { answer = resolve; });
  void detectInstalledPlanner({ plannerUsability: () => gate });
  return { answer: () => answer({ usable: true }) };
}

/**
 * A goal typed before the activation probe answers waits for it in the
 * Session (ADR-0009), which counts the wait as planner work: what the user
 * types meanwhile is held behind the goal, Stop and New session end the wait,
 * and only a goal started afresh replaces it.
 */
describe('a first goal waiting for the installed-agent probe', () => {
  const workspaces: string[] = [];
  afterEach(() => {
    resetInstalledPlanner();
    for (const dir of workspaces.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function harness() {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-start-wait-'));
    workspaces.push(workspace);
    const asked: string[] = [];
    let live = false;
    const planner = {
      startConversation: vi.fn(async (req: ConversationRequest): Promise<ConversationTurn> => {
        live = true;
        asked.push(req.goal);
        return { kind: 'message', text: 'Which database?', researchLog: [] };
      }),
      continueConversation: vi.fn(async (message: string): Promise<ConversationTurn> => {
        asked.push(message);
        return { kind: 'message', text: 'Noted.', researchLog: [] };
      }),
      hasActiveConversation: () => live,
      reset: vi.fn(() => { live = false; }),
    };
    const posts: HostToWebview[] = [];
    const chatProvider = new ChatViewProvider({ toString: () => 'file:///ext' } as unknown as vscode.Uri);
    chatProvider.postMessage = (msg) => { posts.push(msg); };
    const config = keylessConfig();
    const session = createSession({
      config,
      notifications: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), confirm: vi.fn().mockResolvedValue(undefined) },
      runner: { spawn: vi.fn(), stop: vi.fn(), stopAll: vi.fn(), activeCount: 0 } as unknown as IRunner,
      registry: new RunnerRegistry(),
      workspaceRoot: () => workspace,
      fsAdapter: fakeFileSystem(),
      broadcast: (msg) => chatProvider.conversation.receive(msg),
      modelResolver: { getCachedRunnerModels: () => [], modelsForRunners: vi.fn().mockResolvedValue({}) } as unknown as ModelResolver,
      settings: () => ({ run: { ...RUN_SETTINGS_DEFAULTS, supervisorLevel: 'off' } }),
      aiService: planner as unknown as IAiService,
      taskOutput: new BufferedTaskOutputSource(),
      saveSession: vi.fn(),
    });
    let current: LegacyPlanState = createEmptyPlan();
    let goal = '';
    let pending: WebviewRouterDeps['getPendingRunners'] extends () => infer R ? R : never;
    const sendRunSettings = vi.fn();
    const deps: WebviewRouterDeps = {
      session,
      chatProvider,
      modelResolver: {} as unknown as WebviewRouterDeps['modelResolver'],
      runnerRegistry: new RunnerRegistry(),
      config: config as unknown as WebviewRouterDeps['config'],
      fsAdapter: { getWorkspaceRoot: () => workspace } as unknown as WebviewRouterDeps['fsAdapter'],
      runner: { stopAll: vi.fn() } as unknown as WebviewRouterDeps['runner'],
      notifications: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), confirm: vi.fn() },
      getCurrentPlan: () => current,
      setCurrentPlan: (p) => { current = p; },
      getCurrentGoal: () => goal,
      setCurrentGoal: (g) => { goal = g; },
      isGeneratingPlan: () => session.isPlannerBusy,
      persistState: vi.fn(),
      saveCurrentSession: vi.fn(),
      sendRunSettings,
      log: () => {},
      extension: {
        ready: vi.fn(), refreshChildren: vi.fn(async () => {}), openChild: vi.fn(async () => {}), closeChild: vi.fn(), messageChild: vi.fn(async () => {}), answerChildCheckpoint: vi.fn(async () => {}), openChildTaskLog: vi.fn(async () => {}),
        refreshModels: vi.fn(),
        runSlashCommand: vi.fn(async () => {}),
        setPlanner: vi.fn(async () => {}),
        setPlannerModel: vi.fn(async () => {}),
        openTaskLog: vi.fn(),
        openFile: vi.fn(),
        setPlanDockHeight: vi.fn(),
        changeSettings: vi.fn(async () => {}),
        setRunnerEnabled: vi.fn(async () => {}),
        loginPlanner: vi.fn(async () => {}),
      },
      getPendingRunners: () => pending,
      setPendingRunners: (r) => { pending = r; },
    };
    const userSaid = () => (session.planState?.conversationHistory ?? []).filter((m) => m.role === 'user').map((m) => m.content);
    const errors = () => posts.filter((m) => m.type === 'showError');
    return { session, deps, planner, asked, userSaid, errors, sendRunSettings, goal: () => goal, route: (msg: Parameters<typeof routeWebviewMessage>[0]) => routeWebviewMessage(msg, deps) };
  }

  it('holds a prompt typed during the wait behind the goal: the planner gets the goal, then the prompt, and the goal stays', async () => {
    const h = harness();
    const probe = heldProbe();

    const start = h.route({ type: 'sendMessage', typed: true, text: 'Build an inventory service', runners: ['claude-code'] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const held = h.route({ type: 'holdPrompt', text: 'Use Postgres' });
    probe.answer();
    await Promise.all([start, held]);

    await vi.waitFor(() => expect(h.asked).toHaveLength(2));
    expect(h.asked[0]).toBe('Build an inventory service');
    expect(h.asked[1]).toContain('Use Postgres');
    await vi.waitFor(() => expect(h.userSaid()).toEqual(['Build an inventory service', 'Use Postgres']));
    expect(h.goal()).toBe('Build an inventory service');
    expect(h.session.currentGoal).toBe('Build an inventory service');
    // The new plan makes this window's session the one its Run block shows.
    expect(h.sendRunSettings).toHaveBeenCalled();
    expect(h.errors()).toEqual([]);
    h.session.destroy();
  });

  it('Stop during the wait cancels the goal and the prompt held behind it, and a goal sent after it runs', async () => {
    const h = harness();
    const probe = heldProbe();

    const start = h.route({ type: 'sendMessage', typed: true, text: 'Build an inventory service', runners: ['claude-code'] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await h.route({ type: 'holdPrompt', text: 'Use Postgres' });
    handleStopPlanning(h.deps);
    await start;
    expect(h.session.isPlannerBusy).toBe(false);

    const after = h.route({ type: 'sendMessage', typed: true, text: 'Build a ledger', runners: ['claude-code'] });
    probe.answer();
    await after;
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(h.asked).toEqual(['Build a ledger']);
    expect(h.userSaid()).toEqual(['Build a ledger']);
    expect(h.errors()).toEqual([]);
    h.session.destroy();
  });

  it('a new session during the wait starts nothing, and keeps nothing of the goal', async () => {
    const h = harness();
    const probe = heldProbe();

    const start = handleStartPlanning('ship it', h.deps);
    handleNewSession(h.deps);
    // A bare welcome shows the file's values, which the next session opens with.
    expect(h.sendRunSettings).toHaveBeenCalled();
    probe.answer();
    await start;
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(h.planner.startConversation).not.toHaveBeenCalled();
    expect(h.session.planState).toBeNull();
    expect(h.errors()).toEqual([]);
    h.session.destroy();
  });

  it('a goal started afresh during the wait replaces the first', async () => {
    const h = harness();
    const probe = heldProbe();

    const first = handleStartPlanning('first goal', h.deps);
    const second = handleStartPlanning('second goal', h.deps);
    probe.answer();
    await Promise.all([first, second]);

    expect(h.asked).toEqual(['second goal']);
    expect(h.goal()).toBe('second goal');
    expect(h.errors()).toEqual([]);
    h.session.destroy();
  });
});

/**
 * A message restored from before a reload waits for the probe in the Session
 * itself, with no host start to cancel: Stop must reach it there, or the
 * agent found later answers it and autorun starts the plan the user stopped.
 */
describe('a restored message waiting for the installed-agent probe', () => {
  afterEach(() => resetInstalledPlanner());

  it('is stopped by Stop: once the agent is found, no planner turn opens and autorun spawns nothing', async () => {
    let answer!: (value: PlannerUsability) => void;
    const gate = new Promise<PlannerUsability>((resolve) => { answer = resolve; });
    void detectInstalledPlanner({ plannerUsability: () => gate });

    const submitted: ConversationTurn = { kind: 'plan', tasks: [createTask({ id: 'p1', order: 1, title: 'Use Postgres', prompt: 'use it', assignedRunner: 'claude-code' })], text: '1. Use Postgres', researchLog: [] };
    const planner = { startConversation: vi.fn(async () => submitted), continueConversation: vi.fn(async () => submitted), hasActiveConversation: () => false, reset: vi.fn() };
    const runner = { spawn: vi.fn(), stop: vi.fn(), stopAll: vi.fn(), activeCount: 0 } as unknown as IRunner;
    const config = fakeConfig({ getProviderApiKey: () => '', orchestratorModel: '', planningModel: '' });
    // No AI_PROVIDER and no key: the planner is whatever the probe records.
    Object.defineProperty(config, 'aiProvider', { get: () => recordedInstalledPlanner() ?? 'openrouter' });
    const session = createSession({
      config,
      notifications: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), confirm: vi.fn().mockResolvedValue(undefined) },
      runner,
      registry: new RunnerRegistry(),
      workspaceRoot: () => '/nonexistent-ordewell-test-root',
      fsAdapter: fakeFileSystem(),
      broadcast: vi.fn(),
      modelResolver: { getCachedRunnerModels: () => [], modelsForRunners: vi.fn().mockResolvedValue({}) } as unknown as ModelResolver,
      settings: () => ({ run: { ...RUN_SETTINGS_DEFAULTS, supervisorLevel: 'off', autorun: true } }),
      aiService: planner as unknown as IAiService,
      taskOutput: new BufferedTaskOutputSource(),
      saveSession: vi.fn(),
    });
    const now = new Date().toISOString();
    const saved: LegacyPlanState = {
      tasks: [], generatedAt: now, status: 'draft', runners: ['claude-code'], lastUpdated: now,
      conversationHistory: [{ role: 'user', content: 'ship it', timestamp: now }, { role: 'assistant', content: 'Which database?', timestamp: now }],
      pendingTurns: [{ id: 'turn-1', source: 'user', text: 'Postgres', timestamp: now }],
    };
    session.loadPlan(saved, 'ship it', '/nonexistent-ordewell-test-root');
    const log = vi.fn();
    const deps = { session, chatProvider: { conversation: { stop: vi.fn() } }, log } as unknown as PlanManagerDeps;

    handleStopPlanning(deps);
    answer({ usable: true });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(log).toHaveBeenCalledWith('Research stopped');
    expect(planner.startConversation).not.toHaveBeenCalled();
    expect(planner.continueConversation).not.toHaveBeenCalled();
    expect(runner.spawn).not.toHaveBeenCalled();
    session.destroy();
  });
});
