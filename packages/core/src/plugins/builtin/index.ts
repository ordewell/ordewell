import type { RunnerManifest } from '../types';
import { CLAUDE_CODE_MANIFEST } from './claude-code.manifest';
import { CODEX_MANIFEST } from './codex.manifest';
import { OPENCODE_MANIFEST } from './opencode.manifest';
import { COPILOT_CLI_MANIFEST } from './copilot-cli.manifest';

/**
 * The built-in runners, by manifest. With a runner's entry in `CONNECTORS`,
 * this is the whole of declaring one: the runner list, the harness planners
 * and model discovery all read it. Insertion order is picker order on every
 * surface.
 */
export const BUILTIN_MANIFESTS: readonly RunnerManifest[] = [
  CLAUDE_CODE_MANIFEST,
  CODEX_MANIFEST,
  OPENCODE_MANIFEST,
  COPILOT_CLI_MANIFEST,
];
