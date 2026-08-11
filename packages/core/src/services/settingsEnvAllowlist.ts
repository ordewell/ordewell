/**
 * Which environment variables a settings update may write.
 *
 * The daemon's settings update sets `process.env` on the daemon itself, and
 * every runner it spawns inherits that environment. The admission rule used to
 * be "any upper-case key", which admitted the variables that make the runtime
 * load arbitrary modules, preload libraries into every child, redirect the
 * executable search path, move where settings are persisted, and turn approval
 * prompting off — so a single settings write was arbitrary code execution.
 *
 * The rule is now an allowlist: the provider credential and base-URL families,
 * derived from the provider registry so a new provider needs no second edit,
 * plus a small set of Ordewell's own configuration variables. Everything else
 * is refused and named back to the caller.
 */

import { ALL_PROVIDERS } from './ProviderRegistry';

/**
 * Ordewell's own settable configuration. Deliberately short: a variable earns a
 * place here only when a surface has a reason to change it on a live daemon.
 *
 * `ORDEWELL_AUTONOMOUS_MODE` is conspicuously absent and is in
 * `SETTINGS_ENV_REFUSED` instead — see that list.
 */
export const ORDEWELL_SETTABLE_ENV: readonly string[] = [
  'AI_PROVIDER',
  'ORCHESTRATOR_MODEL',
  'ORDEWELL_SUBAGENT_MODEL',
  'ORDEWELL_PLANNER_EFFORT',
  'ORDEWELL_RESEARCH_ENABLED',
  'ORDEWELL_MAX_PARALLEL',
];

/**
 * Refused by name, not merely left out of the allowlist.
 *
 * Omission alone would already refuse these, so this list buys no admission
 * behaviour — it buys a place where the reason is written down, and a failing
 * test the moment someone widens the allowlist over one of them. Each entry is
 * a known escalation from "can change a setting" to "can run code as the user":
 *
 * - The approval-mode and pre-approved-scope variables switch the consent gate
 *   off, so every later command runs unprompted.
 * - The settings-path override is honoured by the settings service, which
 *   creates directories recursively when persisting — admitting it turns the
 *   same write into an arbitrary-path file write.
 * - The runtime-option and dynamic-loader variables load attacker-chosen
 *   modules or shared objects into the daemon and into every process it spawns.
 * - The executable-path variables redirect which binary a runner's command name
 *   resolves to.
 */
export const SETTINGS_ENV_REFUSED: readonly string[] = [
  // Approval posture and pre-approved scope.
  'ORDEWELL_AUTONOMOUS_MODE',
  'ORDEWELL_APPROVAL_MODE',
  'ORDEWELL_APPROVAL_ALLOW',
  // Where settings are persisted.
  'ORDEWELL_SETTINGS_PATH',
  // Runtime options and dynamic loaders.
  'NODE_OPTIONS',
  'NODE_REPL_EXTERNAL_MODULE',
  'NODE_PATH',
  'ELECTRON_RUN_AS_NODE',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'LD_AUDIT',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'DYLD_FRAMEWORK_PATH',
  // Executable resolution.
  'PATH',
  'PATHEXT',
  'NODE',
];

const REFUSED = new Set(SETTINGS_ENV_REFUSED);

/** The provider credential and base-URL families, straight from the registry. */
function providerEnvKeys(): string[] {
  const keys: string[] = [];
  for (const meta of Object.values(ALL_PROVIDERS)) {
    if (meta.apiKeyEnvVar) keys.push(meta.apiKeyEnvVar);
    if (meta.baseUrlEnvVar) keys.push(meta.baseUrlEnvVar);
    for (const detect of meta.detectEnvVars) keys.push(detect);
  }
  return keys;
}

/**
 * The credential and endpoint keys alone. A write to one of these is what
 * invalidates a model catalog — picking a planner, a model or an effort level
 * changes nothing a catalog contains.
 */
export const PROVIDER_CREDENTIAL_ENV: ReadonlySet<string> = new Set(providerEnvKeys());

/**
 * Every key a settings update may write. Built once at module load; the refused
 * names are subtracted last so a provider registration can never smuggle one in.
 */
export const SETTINGS_ENV_ALLOWLIST: ReadonlySet<string> = new Set(
  [...providerEnvKeys(), ...ORDEWELL_SETTABLE_ENV].filter((key) => !REFUSED.has(key)),
);

export interface EnvAdmission {
  /** Keys that may be written, with their string values. */
  accepted: Record<string, string>;
  /** Keys the caller sent that were refused, in the order they arrived. */
  rejected: string[];
}

/**
 * Splits a settings update's `env` object into what may be written and what was
 * refused. A non-string value for an allowlisted key is refused rather than
 * dropped, so the caller never sees silence for a write that did not happen.
 */
export function admitSettingsEnv(env: Record<string, unknown>): EnvAdmission {
  const accepted: Record<string, string> = {};
  const rejected: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (REFUSED.has(key) || !SETTINGS_ENV_ALLOWLIST.has(key) || typeof value !== 'string') {
      rejected.push(key);
      continue;
    }
    accepted[key] = value;
  }
  return { accepted, rejected };
}
