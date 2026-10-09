import { vi, type Mock } from 'vitest';
import { createSession, type SaveSession, type Session, type SessionDeps, type SessionPlanner } from '../createSession';
import { RunnerRegistry } from '../../plugins/RunnerRegistry';
import { ModelResolver } from '../ModelResolver';
import type { IAiService } from '../AiService';
import type { INotification } from '../../interfaces/INotification';
import type { ITerminalRunner } from '../../interfaces/ITerminalRunner';
import type { IFileSystem } from '../../interfaces/IFileSystem';
import type { SkillsService } from '../SkillsService';
import type { TaskOutputSource } from '../../interfaces/TaskOutputSource';
import type { IWorktreeIsolation } from '../../interfaces/IWorktreeIsolation';
import { BufferedTaskOutputSource } from '../BufferedTaskOutputSource';
import { flattenTasks, type Task } from '../../models/Task';
import type { TaskLogEvent } from '../../models/TaskLog';
import type { TaskLogFile, TaskLogLocation } from '../../utils/taskLogStore';

import { fakeConfig, FakeStructuredSession, FakeTerminalSession } from '../../testing';

export const testWorkspace = process.cwd();

export { fakeConfig, FakeStructuredSession, FakeTerminalSession };

export function fakeNotification(): INotification {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), confirm: vi.fn().mockResolvedValue(undefined) };
}

export function fakeFs(): IFileSystem {
  const ok = { success: true, output: '', truncated: false };
  return {
    readFile: vi.fn().mockResolvedValue(ok),
    readFiles: vi.fn().mockResolvedValue(ok),
    glob: vi.fn().mockResolvedValue(ok),
    grep: vi.fn().mockResolvedValue(ok),
    findSymbol: vi.fn().mockResolvedValue(ok),
    listDir: vi.fn().mockResolvedValue(ok),
    bash: vi.fn().mockResolvedValue(ok),
    getWorkspaceRoot: vi.fn().mockReturnValue('/repo'),
  };
}

export interface SessionOverrides {
  broadcast?: SessionDeps['broadcast'];
  onNotice?: SessionDeps['onNotice'];
  config?: SessionDeps['config'];
  /** Supply a real adapter when a test needs the approval channel Session injects into it. */
  fsAdapter?: IFileSystem;
  settings?: SessionDeps['settings'];
  sessionId?: string;
  runner?: ITerminalRunner;
  /** Fakes go through the constructor seam — Partial so a test only stubs the calls it expects. */
  aiService?: Partial<IAiService>;
  planner?: Partial<SessionPlanner>;
  modelResolver?: Pick<ModelResolver, 'modelsForRunners'> & Partial<Pick<ModelResolver, 'getCachedRunnerModels' | 'contextWindowFor'>>;
  skillsService?: Pick<SkillsService, 'findSkill'> & Partial<Pick<SkillsService, 'listSkills'>>;
  taskOutput?: TaskOutputSource;
  /** Defaults to git behind a config with isolation off, so no test runs git in the repo it runs in. */
  isolation?: IWorktreeIsolation;
  /** Defaults to the directory the suite runs in; an end-to-end test points it at a temporary workspace. */
  workspaceRoot?: () => string;
  /**
   * Defaults to a fake that writes nothing, read back through {@link saves};
   * pass `saveSession` itself for a test that reads the store back.
   */
  saveSession?: SaveSession;
  /** Defaults to attempt files held in memory, so a structured run never writes into the repo the suite runs in. */
  openTaskLog?: SessionDeps['openTaskLog'];
  mcpServer?: SessionDeps['mcpServer'];
}

/** Task-log files that live in memory, numbered per task as the real store numbers them. */
export function memoryTaskLogs(): NonNullable<SessionDeps['openTaskLog']> & { files: Map<string, TaskLogEvent[][]> } {
  const files = new Map<string, TaskLogEvent[][]>();
  const open = (_location: TaskLogLocation, taskId: string): TaskLogFile => {
    const attempts = files.get(taskId) ?? [];
    files.set(taskId, attempts);
    const events: TaskLogEvent[] = [];
    attempts.push(events);
    return { attempt: attempts.length, append: (batch) => { events.push(...batch); } };
  };
  return Object.assign(open, { files });
}

const saveFakes = new WeakMap<Session, Mock<SaveSession>>();

/** The persistence fake a {@link makeSession} session writes through, for a test that asserts what was saved. */
export function saves(session: Session): Mock<SaveSession> {
  const fake = saveFakes.get(session);
  if (!fake) throw new Error('This session was given its own saveSession; assert on that instead');
  return fake;
}

/** A Session over fully faked deps, built through the real composition root. */
export function makeSession(overrides: SessionOverrides = {}): Session {
  const runner = overrides.runner ?? {
    spawn: vi.fn().mockResolvedValue({ id: 's1', taskId: '', onOutput: vi.fn(), onExit: vi.fn(), kill: vi.fn(), getOutput: () => '', write: vi.fn() }),
    stop: vi.fn(),
    stopAll: vi.fn(),
    activeCount: 0,
  } as unknown as ITerminalRunner;

  const save = vi.fn<SaveSession>();
  const session = createSession({
    config: overrides.config ?? fakeConfig(),
    notifications: fakeNotification(),
    runner,
    registry: new RunnerRegistry(),
    workspaceRoot: overrides.workspaceRoot ?? (() => testWorkspace),
    fsAdapter: overrides.fsAdapter ?? fakeFs(),
    broadcast: overrides.broadcast ?? vi.fn(),
    onNotice: overrides.onNotice,
    modelResolver: { getCachedRunnerModels: () => [], contextWindowFor: () => undefined, ...(overrides.modelResolver ?? { modelsForRunners: vi.fn().mockResolvedValue({}) }) } as ModelResolver,
    settings: overrides.settings ?? (() => ({})),
    sessionId: overrides.sessionId,
    // Session drops a live conversation via reset() on fresh-plan and
    // plan-adoption boundaries — default it so partial fakes don't explode.
    // A real service keeps its methods on the prototype, where a spread would drop them.
    aiService: overrides.aiService
      ? ('reset' in overrides.aiService ? overrides.aiService as IAiService : ({ reset: vi.fn(), ...overrides.aiService } as IAiService))
      : undefined,
    planner: overrides.planner as SessionPlanner | undefined,
    skillsService: overrides.skillsService
      ? { listSkills: () => [], ...overrides.skillsService } as SkillsService
      : undefined,
    taskOutput: overrides.taskOutput ?? new BufferedTaskOutputSource(),
    isolation: overrides.isolation,
    saveSession: overrides.saveSession ?? save,
    openTaskLog: overrides.openTaskLog ?? memoryTaskLogs(),
    mcpServer: overrides.mcpServer,
  });
  if (!overrides.saveSession) saveFakes.set(session, save);
  return session;
}

/** One task by id, nested subtasks included — read through the public plan tree. */
export function taskOf(session: Pick<Session, 'planTasks'>, taskId: string): Readonly<Task> | undefined {
  return flattenTasks(session.planTasks).find((t) => t.id === taskId);
}

/** Put `texts` on the session's queue, after whatever is already there, the way a mid-run edit waits. */
export function queue(session: Pick<Session, 'getQueuedMessages' | 'setQueuedMessages'>, ...texts: string[]): void {
  const now = new Date().toISOString();
  const queued = session.getQueuedMessages();
  session.setQueuedMessages([
    ...queued,
    ...texts.map((text, i) => ({ id: `q-test-${queued.length + i + 1}`, text, timestamp: now })),
  ]);
}
