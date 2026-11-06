import { vi } from 'vitest';
import { VENDORS } from '../apiProviders';

/**
 * Blanks every variable through which Ordewell's provider reaches an ACP
 * agent's credential hook (ADR-0060, R9), so a key on the machine running the
 * tests cannot change which route a test takes. Undone by `vi.unstubAllEnvs`.
 */
export function stubNoOrdewellProvider(): void {
  const names = new Set(['AI_PROVIDER', 'ORCHESTRATOR_MODEL', 'OPENAI_BASE_URL', 'OPENAI_MODEL']);
  for (const meta of Object.values(VENDORS)) {
    names.add(meta.apiKeyEnvVar);
    for (const name of meta.detectEnvVars) names.add(name);
    if (meta.baseUrlEnvVar) names.add(meta.baseUrlEnvVar);
  }
  for (const name of names) vi.stubEnv(name, '');
}
