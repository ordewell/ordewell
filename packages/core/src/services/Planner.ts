import { Task, RunnerId, DiscoveredModel, ResearchLogEntry, ResearchProgress, LegacyPlanState } from '../models/Task';
import { IConfig } from '../interfaces/IConfig';
import { IFileSystem } from '../interfaces/IFileSystem';
import { IWebFetcher } from '../interfaces/IWebFetcher';
import { IAiService } from './AiService';
import type { RunnerModeInfo } from './ModeResolver';
import { filterModelsForPrompt } from './ModelAllowlistResolver';
import { DEFAULT_PLANNER_MODES, type PlannerModes } from './plannerModes';
import { PlanChangeCheck, planChangeErrorText, requestScope } from './PlanChangeCheck';
import { withoutUnprovidedSkills } from './taskSkills';

/**
 * `autonomousDefault` still arrives on its own — it is not a user toggle but a
 * property of the run — so it wins over whatever the mode set carried.
 */
function plannerModesWith(req: { modes?: PlannerModes; autonomousDefault?: boolean }): PlannerModes {
  const modes = req.modes ?? DEFAULT_PLANNER_MODES;
  return { ...modes, autonomousDefault: req.autonomousDefault ?? modes.autonomousDefault };
}

/**
 * Everything needed to produce a plan from a goal. Carries the planning context
 * that previously threaded through the scheduler as positional args.
 */
export interface PlanRequest {
  goal: string;
  runners: RunnerId[];
  modelsByRunner: Partial<Record<RunnerId, DiscoveredModel[]>>;
  fs?: IFileSystem;
  fetcher?: IWebFetcher;
  onProgress?: (progress: ResearchProgress) => void;
  runnerModes?: Record<RunnerId, RunnerModeInfo[]>;
  autonomousDefault?: boolean;
  signal?: AbortSignal;
  perRunnerAllowlist?: Partial<Record<RunnerId, string[]>>;
  modes?: PlannerModes;
}

/** A generated plan, and what its skill check warned about. */
export interface GeneratedPlan extends LegacyPlanState {
  /** Names not found yet, or no skill could have; the plan still lands. Absent means none, or not checked. */
  skillWarnings?: string[];
}

/** A one-shot plan refused for the skills it attaches; nothing of it was loaded. */
export class PlanSkillsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlanSkillsError';
  }
}

/**
 * Owns one-shot plan generation — the "planning is a different workload from
 * execution" thesis, as a module. The conversational planning loop (ADR-0002)
 * lives on {@link Session}, which talks to the AI service directly because the
 * conversation state is held there.
 */
export class Planner {
  /**
   * Resolved per call, never captured: the planner backend can change while a
   * surface is open (`/planner`, the webview pills), and a Planner holding the
   * service it was built with would keep planning on the backend the host has
   * already switched away from.
   */
  private readonly resolveAiService: () => IAiService;

  constructor(private config: IConfig, aiService: IAiService | (() => IAiService)) {
    this.resolveAiService = typeof aiService === 'function' ? aiService : () => aiService;
  }

  private get aiService(): IAiService { return this.resolveAiService(); }

  /**
   * One-shot plan generation for non-conversational surfaces. Never asks
   * questions. A plan attaching a planner skill to a task is refused, not
   * returned: there is no conversation to send it back through. A skill name
   * nothing provides is taken off its task with a warning instead, so one
   * invented name does not cost the whole plan.
   */
  async generate(req: PlanRequest): Promise<GeneratedPlan> {
    const now = new Date().toISOString();
    let tasks: Task[];
    let researchLog: ResearchLogEntry[] | undefined;

    const filteredModels = filterModelsForPrompt(req.modelsByRunner, req.perRunnerAllowlist ?? {});

    if (this.config.researchEnabled) {
      const result = await this.aiService.researchAndPlan(
        req.goal,
        req.runners,
        filteredModels,
        req.fs!,
        req.onProgress ?? (() => {}),
        req.fetcher,
        req.runnerModes,
        plannerModesWith(req),
        req.signal,
      );
      tasks = result.tasks;
      researchLog = result.researchLog;
    } else {
      const onProgress = req.onProgress;
      tasks = await this.aiService.generatePlanDirect(
        req.goal,
        req.runners,
        filteredModels,
        onProgress ? (token: string) => onProgress({ type: 'plan_token', planToken: token }) : undefined,
        req.fs,
        req.fetcher,
        req.runnerModes,
        plannerModesWith(req),
        req.signal,
      );
    }

    // It lands as a conversation's plan lands, held to the request it was asked under.
    const taskSkills = req.modes?.taskSkills;
    // Dropped, never accepted: the task still needs a provider to name it (ADR-0024).
    const dropped = taskSkills ? withoutUnprovidedSkills(tasks, taskSkills) : { tasks, warnings: [] };
    const checked = await new PlanChangeCheck(requestScope({ ...req, perRunnerAllowlist: req.perRunnerAllowlist ?? {}, taskSkills })).check({ kind: 'plan', tasks: dropped.tasks }, 'land');
    if (taskSkills && req.signal?.aborted) throw new Error('Plan generation was stopped.');
    if (!checked.ok) throw new PlanSkillsError(`The generated plan was refused: ${checked.errors.map(planChangeErrorText).join(' ')}`);
    const skillWarnings = [...dropped.warnings, ...checked.warnings];

    return {
      tasks: checked.tasks,
      generatedAt: now,
      status: 'draft',
      runners: req.runners,
      lastUpdated: now,
      researchLog,
      ...(skillWarnings.length > 0 ? { skillWarnings } : {}),
    };
  }
}
