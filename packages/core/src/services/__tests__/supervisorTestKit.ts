import { expect, vi } from 'vitest';
import { createTask, type LegacyPlanState, type ResearchProgress, type Task } from '../../models/Task';
import type { IRunner } from '../../interfaces/IRunner';
import type { IConfig } from '../../interfaces/IConfig';
import type { IWorktreeIsolation } from '../../interfaces/IWorktreeIsolation';
import type { ConversationRequest, ConversationTurn } from '../AiService';
import type { SessionMessage, SessionNotice } from '../SessionMessage';
import type { McpToolContext, PlannerToolHandler } from '../mcp';
import { WAKE_DEBOUNCE_MS } from '../Supervisor';
import type { SessionDeps } from '../createSession';
import { RUN_SETTINGS_DEFAULTS, type GlobalRunSettings } from '../SettingsService';
import { flushMicrotasks } from '../../testing';
import { fakeConfig, FakeRunnerSession, makeSession, testWorkspace } from './sessionTestKit';

/**
 * A supervised run under test (ADR-0029): a planner whose turns the test
 * answers by hand, a runner that records what it spawned, and the helpers that
 * settle a run under fake timers.
 */

export const NOW = new Date('2026-10-11T18:00:00Z');
// Claude Code's wording (#84), in UTC so the times do not depend on the machine's.
export const LIMIT = "You've hit your session limit · resets 8:10pm (UTC)";
export const RESUME_AT = '2026-10-11T20:11:00.000Z';
export const ctx: McpToolContext = { signal: new AbortController().signal };

export interface PlannerCall {
  message: string;
  signal?: AbortSignal;
  /** What the call streams through, as a backend would. */
  progress?: (progress: ResearchProgress) => void;
  finish(turn: ConversationTurn): void;
  fail(err: unknown): void;
}

/**
 * A planner whose turns the test answers by hand. A stopped call settles as a
 * backend's does, with what it had (`saidBeforeStop`), unless `ignoresStop`
 * makes it hang.
 */
export function heldPlanner() {
  const calls: PlannerCall[] = [];
  const state = { live: false, ignoresStop: false, saidBeforeStop: 'Looking at task 1', tools: undefined as PlannerToolHandler | undefined };
  const take = (message: string, signal?: AbortSignal, progress?: (progress: ResearchProgress) => void) => new Promise<ConversationTurn>((resolve, reject) => {
    calls.push({ message, signal, progress, finish: resolve, fail: reject });
    signal?.addEventListener('abort', () => {
      if (!state.ignoresStop) resolve({ kind: 'message', text: state.saidBeforeStop, researchLog: [], aborted: true });
    }, { once: true });
  });
  const aiService = {
    startConversation: vi.fn((req: ConversationRequest) => {
      state.live = true;
      state.tools = req.plannerTools?.handler;
      return take(req.initialMessage ?? req.goal, req.signal, req.onProgress);
    }),
    continueConversation: vi.fn((message: string, progress?: (progress: ResearchProgress) => void, signal?: AbortSignal) => take(message, signal, progress)),
    hasActiveConversation: () => state.live,
    reset: vi.fn(() => { state.live = false; }),
    restart: vi.fn(),
  };
  return { aiService, calls, state, tools: () => state.tools! };
}

export function recordingRunner() {
  const sessions = new Map<string, FakeRunnerSession>();
  const runner = {
    spawn: vi.fn(async ({ taskId }: Parameters<IRunner['spawn']>[0]) => {
      const session = new FakeRunnerSession(`s-${taskId}-${sessions.size + 1}`, taskId);
      sessions.set(taskId, session);
      return session;
    }),
    stop: vi.fn(),
    stopAll: vi.fn(),
    activeCount: 0,
  } satisfies IRunner;
  return { runner, of: (taskId: string) => sessions.get(taskId)!, spawnedIds: () => runner.spawn.mock.calls.map(([o]) => o.taskId) };
}

export const task = (id: string, order: number, over: Partial<Task> = {}): Task =>
  createTask({ id, order, title: `Task ${id}`, prompt: `do ${id}`, assignedRunner: 'claude-code', ...over });

export function plan(tasks: Task[], over: Partial<LegacyPlanState> = {}): LegacyPlanState {
  return {
    tasks,
    generatedAt: '2026-10-11T17:00:00Z',
    lastUpdated: '2026-10-11T17:00:00Z',
    status: 'approved',
    runners: ['claude-code'],
    conversationHistory: [
      { role: 'user', content: 'build it', timestamp: '2026-10-11T16:00:00Z' },
      { role: 'assistant', content: `Plan generated with ${tasks.length} tasks.`, timestamp: '2026-10-11T16:00:01Z', kind: 'plan_generated' },
    ],
    ...over,
  };
}

export interface Options {
  plan?: Partial<LegacyPlanState>;
  /** The user's run settings (ADR-0030), Watch and the other defaults unless set. */
  settings?: Partial<GlobalRunSettings>;
  config?: Partial<IConfig>;
  /** The enabled runners the user's settings file holds, read at each call as the host's settings are; the config's unless set. */
  enabledRunners?: () => string[] | undefined;
  isolation?: IWorktreeIsolation;
  /** False leaves the plan as loaded, never executed by the user. */
  execute?: boolean;
  /** What runs script tasks (ADR-0035); the recording runner of {@link supervised}'s `scripts` unless set. */
  scriptRunner?: IRunner;
  /** The host whose lease the session holds; none unless set. */
  leaseHost?: SessionDeps['leaseHost'];
}

/** A session running `tasks` under the user's supervisor level, Watch unless the options say otherwise. */
export async function supervised(tasks: Task[] = [task('t1', 1), task('t2', 2)], options: Options = {}) {
  // The user's settings file: a test changes it as another surface would.
  const settings: GlobalRunSettings = { ...RUN_SETTINGS_DEFAULTS, ...options.settings };
  const planner = heldPlanner();
  const run = recordingRunner();
  const scripts = recordingRunner();
  const messages: SessionMessage[] = [];
  const notices: SessionNotice[] = [];
  const session = makeSession({
    aiService: planner.aiService,
    runner: run.runner,
    scriptRunner: options.scriptRunner ?? scripts.runner,
    isolation: options.isolation,
    leaseHost: options.leaseHost,
    broadcast: (m) => messages.push(m),
    onNotice: (n) => notices.push(n),
    config: fakeConfig(options.config),
    settings: () => ({ run: { ...settings }, ...(options.enabledRunners ? { enabledRunners: options.enabledRunners() } : {}) }),
    ...(options.isolation ? { workspaceRoot: () => '/repo' } : {}),
  });
  session.loadPlan(plan(tasks, options.plan), 'build it', options.isolation ? '/repo' : testWorkspace);
  if (options.execute !== false) await session.execute({ command: 'run_plan' }, { kind: 'user' });
  return { session, planner, run, scripts, messages, notices, settings };
}

export const prose = (text: string): ConversationTurn => ({ kind: 'message', text, researchLog: [] });

/**
 * Run what is due now without moving the clock: microtasks, zero-delay timers,
 * and the real I/O a spawn waits on, which only a real turn of the event loop
 * lets through.
 */
export async function settled(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
  await new Promise((resolve) => setImmediate(resolve));
  await flushMicrotasks();
}

/** Settle until `condition` holds; a spawn reads the workspace's environment from a real subprocess, so this waits in real time. */
export async function until(condition: () => boolean): Promise<void> {
  const deadline = performance.now() + 2_000;
  while (!condition() && performance.now() < deadline) await settled();
  expect(condition()).toBe(true);
}

export const waitForInput = (s: FakeRunnerSession) => s.waitForInput();

export function hitLimit(s: FakeRunnerSession): void {
  s.emitEvent({ type: 'error', message: LIMIT });
  s.emitOutput(`${LIMIT}\n`);
  s.emitTurnEnd('failed');
}

export type Env = Awaited<ReturnType<typeof supervised>>;

/** The user changes run settings in this session, as a surface does: saved, then applied to the session's run. */
export function changeSettings(env: Pick<Env, 'session' | 'settings'>, changes: Partial<GlobalRunSettings>): void {
  Object.assign(env.settings, changes);
  env.session.applyRunSettings(changes);
}

/** A run whose supervisor is in its first wake-up turn, on task 1 waiting for input. */
export async function wokenUp(options: Options = {}, tasks: Task[] = [task('t1', 1), task('t2', 2)]): Promise<Env> {
  const env = await supervised(tasks, options);
  waitForInput(env.run.of('t1'));
  await settled();
  await vi.advanceTimersByTimeAsync(WAKE_DEBOUNCE_MS);
  await until(() => env.planner.calls.length === 1);
  return env;
}
