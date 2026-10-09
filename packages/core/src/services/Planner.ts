import { Task, TaskSnapshot, RunnerId, DiscoveredModel, ResearchLogEntry, ResearchProgress, LegacyPlanState, plannerTaskView, type ActiveTaskSession } from '../models/Task';
import { IConfig } from '../interfaces/IConfig';
import { IFileSystem } from '../interfaces/IFileSystem';
import { IWebFetcher } from '../interfaces/IWebFetcher';
import { IAiService } from './AiService';
import type { RunnerModeInfo } from './ModeResolver';
import { validatePlanModification } from './PlanValidator';
import { repairLoop, modifyValidationFeedback } from './PlanRepair';
import { buildModifyDuringExecutionPrompt } from './PlanPrompts';
import { filterModelsForPrompt, coerceAssignments } from './ModelAllowlistResolver';
import { DEFAULT_PLANNER_MODES, type IsolatedExecution, type PlannerModes } from './plannerModes';
import { checkPlanSkills, type SkillLookup } from './taskSkills';

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

export interface ModifyPlanRequest {
  existingPlan: LegacyPlanState;
  userRequest: string;
  modelsByRunner: Partial<Record<RunnerId, DiscoveredModel[]>>;
  fs?: IFileSystem;
  fetcher?: IWebFetcher;
  onProgress?: (progress: ResearchProgress) => void;
  runnerModes?: Record<RunnerId, RunnerModeInfo[]>;
  autonomousDefault?: boolean;
  perRunnerAllowlist?: Partial<Record<RunnerId, string[]>>;
  modes?: PlannerModes;
}

export interface ModifyDuringExecutionRequest {
  executionLog: TaskSnapshot[];
  pendingTasks: Task[];
  activeSessions: Map<string, ActiveTaskSession>;
  userMessage: string;
  modelsByRunner: Partial<Record<RunnerId, DiscoveredModel[]>>;
  runners: RunnerId[];
  runnerModes?: Record<RunnerId, RunnerModeInfo[]>;
  autonomousDefault?: boolean;
  perRunnerAllowlist?: Partial<Record<RunnerId, string[]>>;
  /** Where the run in force puts each task (ADR-0013, ADR-0014). */
  isolatedExecution?: IsolatedExecution;
  /** The workspace root's skill catalog, which the rewritten tasks' skills are checked against. */
  skills: SkillLookup;
}

export interface ModifyDuringExecutionResult {
  pendingTasks: Task[];
  message: string;
  /** Skill names not found yet; the edit still lands, as a submitted plan's does. Absent means none. */
  skillWarnings?: string[];
}

/**
 * Owns one-shot plan generation and plan modification — the "planning is a
 * different workload from execution" thesis, as a module. The conversational
 * planning loop (ADR-0002) lives on {@link Session}, which talks to the AI
 * service directly because the conversation state is held there.
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

  /** One-shot plan generation for non-conversational surfaces. Never asks questions. */
  async generate(req: PlanRequest): Promise<LegacyPlanState> {
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

    return {
      tasks: coerceAssignments(tasks, req.perRunnerAllowlist ?? {}, req.runners, req.modelsByRunner),
      generatedAt: now,
      status: 'draft',
      runners: req.runners,
      lastUpdated: now,
      researchLog,
    };
  }

  async modify(req: ModifyPlanRequest): Promise<{ tasks: Task[] }> {
    const filteredModels = filterModelsForPrompt(req.modelsByRunner, req.perRunnerAllowlist ?? {});
    const result = await this.aiService.modifyPlan(
      req.existingPlan,
      req.userRequest,
      filteredModels,
      req.onProgress,
      req.fs,
      req.fetcher,
      req.runnerModes,
      plannerModesWith(req),
    );
    return { tasks: coerceAssignments(result.tasks, req.perRunnerAllowlist ?? {}, req.existingPlan.runners, req.modelsByRunner) };
  }

  async modifyDuringExecution(req: ModifyDuringExecutionRequest): Promise<ModifyDuringExecutionResult> {
    const pendingJson = JSON.stringify(req.pendingTasks.map(plannerTaskView), null, 2);
    const filteredModels = filterModelsForPrompt(req.modelsByRunner, req.perRunnerAllowlist ?? {});
    const allowlist = req.perRunnerAllowlist ?? {};

    const basePrompt = buildModifyDuringExecutionPrompt(
      req.executionLog,
      pendingJson,
      req.userMessage,
      filteredModels,
      req.runners,
      req.runnerModes,
      { autonomousDefault: req.autonomousDefault ?? true, isolatedExecution: req.isolatedExecution ?? false },
    );
    const send = (corrective?: string) => this.aiService.sendPlanningPrompt(
      corrective ? basePrompt + corrective : basePrompt,
      req.runners,
      req.runnerModes,
      req.autonomousDefault ?? true,
    );

    // A finished task echoed back is not a request to run it again — the
    // caller keeps finished work whatever comes back — so it is dropped here
    // rather than spending a repair round, or the whole edit, on refusing it.
    const finished = new Set(req.executionLog.filter((t) => t.status === 'completed').map((t) => t.id));

    return repairLoop<Task[], ModifyDuringExecutionResult>({
      first: () => send(),
      resend: (corrective) => send(corrective),
      interpret: (tasks) => {
        const coerced = coerceAssignments(tasks.filter((t) => !finished.has(t.id)), allowlist, req.runners, req.modelsByRunner);
        const validation = validatePlanModification({
          executionLog: req.executionLog,
          oldPending: req.pendingTasks,
          newPending: coerced,
          activeSessions: req.activeSessions,
        });
        const skills = checkPlanSkills(coerced, req.skills);
        const errors = [...validation.errors, ...skills.errors.map((e) => e.message)];
        if (errors.length === 0) {
          return { done: { pendingTasks: coerced, message: `Plan modified: ${coerced.length} pending task(s)`, skillWarnings: skills.warnings } };
        }
        return { retry: { errors, corrective: modifyValidationFeedback(errors) } };
      },
      maxRepairs: 2,
      onExhausted: ({ errors }) => {
        throw new Error(
          `Plan modification validation exhausted after 3 attempts. Last errors:\n${errors.map((e) => `- ${e}`).join('\n')}`,
        );
      },
    });
  }
}
