import { vi } from 'vitest';
import { Session, type SessionDeps, type SessionPlanner } from '../createSession';
import { RunnerRegistry } from '../../plugins/RunnerRegistry';
import { ModelResolver } from '../ModelResolver';
import * as sessionStore from '../../utils/sessionStore';
import type { IAiService } from '../AiService';
import type { INotification } from '../../interfaces/INotification';
import type { ITerminalRunner } from '../../interfaces/ITerminalRunner';
import type { IFileSystem } from '../../interfaces/IFileSystem';
import type { SkillsService } from '../SkillsService';

import { fakeConfig, FakeTerminalSession } from '../../testing';

export const testWorkspace = process.cwd();

export { fakeConfig, FakeTerminalSession };

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
  config?: SessionDeps['config'];
  /** Supply a real adapter when a test needs the approval channel Session injects into it. */
  fsAdapter?: IFileSystem;
  settings?: SessionDeps['settings'];
  sessionId?: string;
  runner?: ITerminalRunner;
  /** Fakes go through the constructor seam — Partial so a test only stubs the calls it expects. */
  aiService?: Partial<IAiService>;
  planner?: Partial<SessionPlanner>;
  modelResolver?: Pick<ModelResolver, 'modelsForRunners'>;
  skillsService?: Pick<SkillsService, 'findSkill'>;
}

/**
 * A Session over fully faked deps. `saveSession` is stubbed so no test touches
 * the real saved-session store; assert persistence via `vi.mocked(saveSession)`.
 */
export function makeSession(overrides: SessionOverrides = {}): Session {
  const runner = overrides.runner ?? {
    spawn: vi.fn().mockResolvedValue({ id: 's1', taskId: '', onOutput: vi.fn(), onExit: vi.fn(), kill: vi.fn(), getOutput: () => '', write: vi.fn() }),
    stop: vi.fn(),
    stopAll: vi.fn(),
    activeCount: 0,
  } as unknown as ITerminalRunner;

  vi.spyOn(sessionStore, 'saveSession').mockImplementation(() => ({
    id: 'test-session-id', goal: 'test', runners: [], taskCount: 0,
    status: 'approved', createdAt: '', updatedAt: '',
  }));

  return new Session({
    config: overrides.config ?? fakeConfig(),
    notifications: fakeNotification(),
    runner,
    registry: new RunnerRegistry(),
    workspaceRoot: () => testWorkspace,
    fsAdapter: overrides.fsAdapter ?? fakeFs(),
    broadcast: overrides.broadcast ?? vi.fn(),
    modelResolver: (overrides.modelResolver ?? { modelsForRunners: vi.fn().mockResolvedValue({}) }) as ModelResolver,
    settings: overrides.settings ?? (() => ({ tddEnabled: false })),
    sessionId: overrides.sessionId,
    // Session drops a live conversation via reset() on fresh-plan and
    // plan-adoption boundaries — default it so partial fakes don't explode.
    aiService: overrides.aiService
      ? ({ reset: vi.fn(), ...overrides.aiService } as IAiService)
      : undefined,
    planner: overrides.planner as SessionPlanner | undefined,
    skillsService: overrides.skillsService as SkillsService | undefined,
  });
}
