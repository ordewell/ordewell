import type { RunnerId } from '../models/Task';

/**
 * The built-in runners as a surface reads them: the id core keys everything by,
 * the name people see, and the vendor's own installation page.
 *
 * Browser-safe on purpose. The manifests that declare a runner also carry its
 * Node-only readers, so a renderer cannot import them; this table is the one
 * place a renderer reads, and `installDocs.test.ts` fails if a built-in
 * manifest disagrees with it.
 */
export interface RunnerCatalogEntry {
  id: RunnerId;
  label: string;
  installDocs: string;
}

/** In manifest order, which is picker order on every surface. */
export const RUNNER_CATALOG: readonly RunnerCatalogEntry[] = [
  { id: 'claude-code', label: 'Claude Code', installDocs: 'https://docs.claude.com/en/docs/claude-code/setup' },
  { id: 'codex', label: 'Codex', installDocs: 'https://github.com/openai/codex' },
  { id: 'opencode', label: 'OpenCode', installDocs: 'https://opencode.ai/docs' },
  { id: 'copilot-cli', label: 'GitHub Copilot CLI', installDocs: 'https://docs.github.com/en/copilot/how-tos/set-up/install-copilot-cli' },
  { id: 'qwen-code', label: 'Qwen Code', installDocs: 'https://github.com/QwenLM/qwen-code' },
  { id: 'cline', label: 'Cline', installDocs: 'https://docs.cline.bot/getting-started/installing-cline' },
  { id: 'gemini-cli', label: 'Gemini CLI', installDocs: 'https://github.com/google-gemini/gemini-cli' },
  { id: 'cursor-agent', label: 'Cursor', installDocs: 'https://cursor.com/docs/cli/installation' },
];

export const RUNNER_IDS: readonly RunnerId[] = RUNNER_CATALOG.map((runner) => runner.id);

export const RUNNER_LABELS: Readonly<Record<string, string>> = Object.fromEntries(
  RUNNER_CATALOG.map((runner) => [runner.id, runner.label]),
);

export const RUNNER_INSTALL_DOCS: Readonly<Record<string, string>> = Object.fromEntries(
  RUNNER_CATALOG.map((runner) => [runner.id, runner.installDocs]),
);
