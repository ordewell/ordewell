import type { RunnerId } from '../models/Task';
import type { ApprovalModeSetting } from '../services/ApprovalPolicy';
import type { ProviderModelLists } from '../services/ProviderRouting';

/** An LLM vendor reached over HTTP. A closed set: each one has its own registration in `ProviderRegistry`. */
export type AiProvider = 'google' | 'openrouter' | 'openai_compatible' | 'openai' | 'xai' | 'groq' | 'deepseek' | 'together' | 'mistral' | 'anthropic' | 'fireworks' | 'perplexity' | 'zhipu' | 'kimi' | 'cerebras' | 'deepinfra' | 'doubao' | 'qwen' | 'hunyuan' | 'baichuan' | 'minimax' | 'yi' | 'stepfun' | 'siliconflow' | 'cohere' | 'novita';

/**
 * Who plans: an API vendor, or the id of a runner serving as a *harness
 * planner* (ADR-0009) — a coding agent CLI already installed on the machine,
 * driven as the planner over its own programmatic transport and authenticated
 * by the subscription the user already holds. Runners sit in the provider axis
 * deliberately: "what plans for me?" is one question, and it belongs in one
 * setting. The runner half is open — any built-in runner with a connector can
 * plan — so it is checked against the registry, not by the type:
 * `isApiProvider` narrows to a vendor, `isCliProvider` tells a harness planner.
 */
export type PlannerBackendId = AiProvider | RunnerId;

export interface IConfig {
  aiProvider: PlannerBackendId;
  apiKey: string;
  planningModel: string;
  enabledRunners: string[];
  maxParallelSessions: number;
  researchEnabled: boolean;
  researchMaxSteps: number;
  researchMaxFileSize: number;

  openAiBaseUrl: string;
  openAiApiKey: string;
  /** Provider keys + base URL the ModelResolver uses to fetch the picker catalogs. */
  openrouterKey: string;
  geminiKey: string;
  geminiBaseUrl?: string;
  /** Base URL + API key for a user-provided OpenAI-compatible endpoint (ollama, vLLM, LM Studio, etc.). */
  openaiCompatibleBaseUrl: string;
  openaiCompatibleApiKey: string;
  orchestratorModel: string;
  geminiModel: string;
  /** Model for research subagents (issue #34); defaults to the (cheap) planner model. */
  researchSubagentModel: string;
  /**
   * Thinking effort / model variant for a harness planner (ADR-0009), chosen
   * from the agent's own discovered variants. Separate from the per-task
   * efforts the plan carries — this one is the planner's own dial.
   */
  plannerThinkingEffort?: string;

  planMapEnabled: boolean;
  autonomousMode: boolean;

  /**
   * Run each AI task in its own git worktree and integrate the results on a
   * per-run branch (ADR-0013). Non-git workspaces fall back to the shared
   * workspace root regardless of this flag.
   */
  worktreeIsolation: boolean;
  /**
   * Shell command run in a fresh task worktree instead of symlinking ignored
   * artifacts from the main worktree — for repos where sharing `node_modules`
   * or a virtualenv is wrong.
   */
  worktreeSetupCommand?: string;
  /**
   * Repositories of the repo group listed by hand, relative to the workspace
   * (ADR-0014). When non-empty the group is exactly these, replacing the
   * repositories auto-detected directly inside the folder; needed for ones
   * deeper than that, which are never auto-detected.
   */
  workspaceRepos: string[];
  /**
   * Extra paths or globs, relative to each repo root, linked from the real repo
   * into its task worktree where they exist — gitignored local state such as
   * `*.tfstate` that a task must use, not a copy of.
   */
  worktreeLinks: string[];
  /**
   * How many conflict repairs one task may go through before its conflict is
   * left for a person (ADR-0015); 0 turns repair off.
   */
  conflictRepairAttempts: number;

  /**
   * What to do when planner research reaches outside its default envelope — an
   * out-of-workspace path, a shell command beyond the auto-allowed read-only
   * set, an MCP tool. `ask` prompts the user (and denies where no surface can
   * prompt, such as headless runs); `allow` and `deny` skip the prompt
   * entirely; `auto` follows {@link autonomousMode} (ADR-0026).
   */
  approvalMode: ApprovalModeSetting;
  /** Allowlist entries granted up front, beside the defaults (ADR-0026, `plannerAllowlist.ts`). */
  approvalPreApproved: string[];
  /** Whether the built-in allowlist of read-only command families and MCP tools applies. */
  approvalDefaults: boolean;
  /** The user's effect allowlist rules (ADR-0035, `effectAllowlist.ts`), read on every request. It has no defaults. */
  effectAllowlist: string[];
  /**
   * The user's notify command as an argument vector (ADR-0053), read as each
   * new escalation appears; empty when there is none. A repository never sets
   * it, because it would then run a command on the user's machine.
   */
  notifyCommand: string[];
  /** How many fetches and searches one planner turn may make (ADR-0027). User-only, like the approval settings. */
  webReadBudget: number;
  /**
   * Let a harness planner use its own shell beside `run_command` (ADR-0036
   * N1), where the installed version passed the live checks (N2, N4). Off by
   * default, and never a workspace's to choose.
   */
  plannerNativeShell: boolean;

  /** Get the base URL for an OpenAI-compatible provider. */
  getProviderBaseUrl(provider: AiProvider): string;
  /** Get the API key for a provider. */
  getProviderApiKey(provider: AiProvider): string;

  /**
   * Push the canonical provider routing lists in (sole producer: ModelResolver).
   * Config consumes them when resolving a chosen model id to its serving API.
   */
  setProviderModelLists(lists: ProviderModelLists): void;
}

export function enabledRunners(cfg: IConfig): RunnerId[] {
  return cfg.enabledRunners;
}
