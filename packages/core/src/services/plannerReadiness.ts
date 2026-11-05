import type { AiProvider, IConfig, PlannerBackendId } from '../interfaces/IConfig';
import { CLI_PROVIDERS, getProviderMeta, isApiProvider, isCliProvider, runnerForProvider } from './ProviderRegistry';
import { recordedRunnerAuth, runnerSignIn, type RunnerAuth } from './runnerAuth';
import { describeSignIn, HEADLESS_CLI_SIGN_IN, TERMINAL_UI_SIGN_IN, type RunnerSignIn, type SignInSyntax } from './signInHint';

/** What the preflight reads: the planner choice and whatever it needs to be reachable. */
export type PlannerReadinessConfig = Pick<IConfig, 'aiProvider' | 'planningModel' | 'openaiCompatibleBaseUrl' | 'getProviderApiKey'>;

/**
 * Why the selected planner cannot plan yet, as data. Each surface words it with
 * its own command spelling (`describePlannerNotReady`), so a daemon, a chat and
 * a shell script can all say the same thing without sharing a syntax.
 */
export type PlannerNotReady =
  | { code: 'no_key'; provider: AiProvider; label: string; keyEnvVar: string }
  | { code: 'no_base_url'; provider: AiProvider; label: string; baseUrlEnvVar: string }
  | { code: 'no_model'; provider: AiProvider; label: string }
  | { code: 'signed_out'; provider: PlannerBackendId; label: string; runner: string; signIn: RunnerSignIn };

/** A runner's latest login verdict, read synchronously because every planner turn is judged that way. */
export type RunnerAuthLookup = (runner: string) => RunnerAuth | undefined;

/**
 * What the selected planner still needs before it can plan, or null when it is
 * ready. There are two ways in (ADR-0009), and only one of them involves an
 * credential: a harness planner drives a coding agent already installed on the
 * machine, authenticated by the user's own subscription, so demanding an API
 * key of it turns a working setup into a wall. Its model is optional too: an
 * unset id means "the agent's own default".
 *
 * A harness planner whose own status command says the user is signed out is
 * refused too: the agent will fail every turn until they log in. Only that
 * verdict blocks — unknown says nothing, and a stale signed-in one is left to
 * the runner's own failure.
 */
export function plannerNotReady(
  config: PlannerReadinessConfig,
  auth: RunnerAuthLookup = () => undefined,
): PlannerNotReady | null {
  const provider = config.aiProvider;
  if (isCliProvider(provider)) {
    const runner = runnerForProvider(provider);
    if (!runner) return null;
    const verdict = auth(runner);
    if (verdict?.state !== 'signed-out') return null;
    // A verdict recorded before it carried its ways in is read from the
    // manifest instead; one for a runner Ordewell does not ship has none to name.
    const signIn = verdict.signIn ?? runnerSignIn(runner);
    if (!signIn) return null;
    return {
      code: 'signed_out',
      provider,
      label: getProviderMeta(provider)?.label ?? provider,
      runner,
      signIn,
    };
  }
  if (!isApiProvider(provider)) return null;
  const meta = getProviderMeta(provider);
  if (provider === 'openai_compatible') {
    // A local endpoint (ollama, vLLM) takes no key; the URL is what makes it reachable.
    if (!config.openaiCompatibleBaseUrl) {
      return { code: 'no_base_url', provider, label: meta.label, baseUrlEnvVar: meta.baseUrlEnvVar ?? '' };
    }
  } else if (!config.getProviderApiKey(provider)) {
    return { code: 'no_key', provider, label: meta.label, keyEnvVar: meta.apiKeyEnvVar };
  }
  if (!config.planningModel) return { code: 'no_model', provider, label: meta.label };
  return null;
}

/**
 * `plannerNotReady` judged on a host's own config — the one way every host
 * builds the preflight's input, so none can hand it a key the selected
 * planner's transport will not read (a stored OpenRouter key passing for an
 * OpenAI planner, which then failed inside the transport). Every planner turn
 * judges through this too, so none can let through what another refuses.
 */
export function plannerNotReadyFor(
  config: Pick<IConfig, 'aiProvider' | 'orchestratorModel' | 'planningModel' | 'openaiCompatibleBaseUrl' | 'getProviderApiKey'>,
  auth: RunnerAuthLookup = recordedRunnerAuth,
): PlannerNotReady | null {
  return plannerNotReady(
    {
      aiProvider: config.aiProvider,
      // The vendor transports read different fields (OpenAI-style the
      // orchestrator model, Gemini the planning model, which has a default),
      // so either one set means a model will be found.
      planningModel: config.orchestratorModel || config.planningModel,
      openaiCompatibleBaseUrl: config.openaiCompatibleBaseUrl,
      getProviderApiKey: (provider) => config.getProviderApiKey(provider),
    },
    auth,
  );
}

/** How one surface spells the commands a not-ready message points at, a sign-in hint's included. */
export interface PlannerCommandSyntax extends SignInSyntax {
  pickPlanner: string;
  setKey(provider: AiProvider): string;
  setModel: string;
}

export const TERMINAL_UI_COMMANDS: PlannerCommandSyntax = {
  pickPlanner: '/planner',
  setKey: () => '/key',
  // `/planner` walks harness, model and effort in one flow; there is no
  // separate `/model` (or `/planner-effort`) to point at.
  setModel: '/planner',
  ...TERMINAL_UI_SIGN_IN,
};

/** The VS Code chat shares the terminal's slash commands: its Planner panel and `/planner` own the model. */
export const CHAT_COMMANDS: PlannerCommandSyntax = { ...TERMINAL_UI_COMMANDS };

export const HEADLESS_CLI_COMMANDS: PlannerCommandSyntax = {
  pickPlanner: 'ordewell planner <id>',
  setKey: (provider) => `ordewell key set ${provider} <key>`,
  setModel: 'ordewell model set <id>',
  ...HEADLESS_CLI_SIGN_IN,
};

/** "A, B and C" — read from the harness registrations, so it lists what can plan instead of a copy that goes stale. */
function harnessPlannerNames(): string {
  const names = CLI_PROVIDERS.map((id) => getProviderMeta(id)?.label ?? id);
  if (names.length < 2) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * The clause the vendor transports append to their own missing-credential
 * throw. They are the last guard, reached only when a path skipped the
 * preflight, and cannot know which surface is calling, so it uses the
 * terminal UI's spelling.
 */
export const PLANNER_ESCAPE_HINT = `or pick a coding agent with ${TERMINAL_UI_COMMANDS.pickPlanner}: it plans with no API key`;

export function describePlannerNotReady(reason: PlannerNotReady, commands: PlannerCommandSyntax): string {
  if (reason.code === 'signed_out') return `${describeSignIn(reason.signIn, commands)} Then try again.`;
  if (reason.code === 'no_model') {
    // The TUI and VS Code pick the model inside `/planner`; the headless CLI
    // has its own `ordewell model set`. Name the one place, not two.
    return commands.setModel === commands.pickPlanner
      ? `No planner model selected for ${reason.label}. Pick one with ${commands.setModel}.`
      : `No planner model selected for ${reason.label}. Pick one with ${commands.setModel}, or switch planner with ${commands.pickPlanner}.`;
  }
  const lead = `No planner is ready. Pick one with ${commands.pickPlanner}: ${harnessPlannerNames()} plan with no API key.`;
  if (reason.code === 'no_base_url') {
    return `${lead} To plan with ${reason.label} instead, set ${reason.baseUrlEnvVar}.`;
  }
  return `${lead} To plan with ${reason.label} instead, add ${reason.keyEnvVar} with ${commands.setKey(reason.provider)}.`;
}

/**
 * A planner turn refused before it began. Carries the reason as data so a
 * client that spells commands differently (the headless CLI) can re-word it;
 * the message is the terminal UI's spelling, which is what most clients show.
 */
export class PlannerNotReadyError extends Error {
  constructor(readonly reason: PlannerNotReady) {
    super(describePlannerNotReady(reason, TERMINAL_UI_COMMANDS));
    this.name = 'PlannerNotReadyError';
  }
}
