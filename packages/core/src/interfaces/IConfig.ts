import type { RunnerId } from '../models/Task';
import type { ApprovalMode } from '../services/ApprovalPolicy';
import type { ProviderModelLists } from '../services/ProviderRouting';

/**
 * Who plans. Mostly LLM vendors reached over HTTP; the last three are *harness
 * planners* (ADR-0009) — a coding agent CLI already installed on the machine,
 * driven as the planner over its own programmatic transport and authenticated
 * by the subscription the user already holds. They are runners in the provider
 * axis, deliberately: "what plans for me?" is one question, and it belongs in
 * one setting. `isCliProvider` is the single guard that tells the two kinds
 * apart.
 */
export type AiProvider = 'google' | 'openrouter' | 'openai_compatible' | 'openai' | 'xai' | 'groq' | 'deepseek' | 'together' | 'mistral' | 'anthropic' | 'fireworks' | 'perplexity' | 'zhipu' | 'kimi' | 'cerebras' | 'deepinfra' | 'doubao' | 'qwen' | 'hunyuan' | 'baichuan' | 'minimax' | 'yi' | 'stepfun' | 'siliconflow' | 'cohere' | 'novita' | 'claude-code' | 'codex' | 'opencode';

export interface IConfig {
  aiProvider: AiProvider;
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
   * What to do when planner research reaches outside its default envelope — an
   * out-of-workspace path, or a shell command beyond the auto-allowed read-only
   * set. `ask` prompts the user (and denies where no surface can prompt, such as
   * headless runs); `allow` and `deny` skip the prompt entirely.
   */
  approvalMode: ApprovalMode;
  /** Scopes granted up front, so CI and power users never see a prompt. Trailing `*` matches by prefix. */
  approvalPreApproved: string[];

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
