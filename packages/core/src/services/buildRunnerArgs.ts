import type { RunnerRegistry } from '../plugins/RunnerRegistry';
import { resolveArgs } from '../plugins/resolveArgs';
import type { RunnerInvocation } from '../plugins/types';

export type RunnerMode = string;

export type { RunnerInvocation } from '../plugins/types';

export function buildRunnerInvocation(opts: {
  runner: string;
  prompt: string;
  modelId?: string;
  thinkingEffort?: string;
  modelVariants?: string[];
  mode?: RunnerMode;
  headless?: boolean;
  interactive?: boolean;
  cwd?: string;
  registry: RunnerRegistry;
}): RunnerInvocation {
  const entry = opts.registry.get(opts.runner);
  if (!entry) {
    throw new Error(`Unknown runner: ${opts.runner}. Use \`ordewell plugins list\` to see registered runners.`);
  }

  const manifest = entry.manifest;

  return resolveArgs(manifest, {
    prompt: opts.prompt,
    model: opts.modelId,
    thinkingEffort: opts.thinkingEffort,
    modelVariants: opts.modelVariants,
    mode: opts.mode ?? 'build',
    headless: opts.headless,
    interactive: opts.interactive,
    cwd: opts.cwd,
  });
}
