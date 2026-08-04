import type { RunnerPluginManifest, ResolveContext, RunnerInvocation } from './types';

export class ResolveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResolveError';
  }
}

enum Block {
  None,
  IfModel,
  IfThinking,
  IfPlanMode,
  IfBuildMode,
  IfHeadless,
  IfVariant,
  IfInteractive,
  IfHeadlessSession,
  IfInteractiveVariant,
  IfProjectTrust,
}

/**
 * The session *shape*, which is not the same question as autonomy: a tmux
 * window runs a fully autonomous task on a real TTY. Callers that predate the
 * split (and every existing test) only set `headless`, so it still decides
 * when nothing else does.
 */
function isInteractive(ctx: ResolveContext): boolean {
  return ctx.interactive ?? !ctx.headless;
}

export function resolveArgs(manifest: RunnerPluginManifest, ctx: ResolveContext): RunnerInvocation {
  const args: string[] = [];
  const env: Record<string, string> = {};

  if (manifest.runner.env) {
    for (const [key, value] of Object.entries(manifest.runner.env)) {
      const resolved = substituteSimple(value, ctx);
      // An env value that resolves to nothing (e.g. its {{if …}} condition is
      // false) is omitted entirely rather than exported as an empty string.
      if (resolved.length > 0) env[key] = resolved;
    }
  }

  let block = Block.None;
  let include = true;

  for (let i = 0; i < manifest.runner.argsTemplate.length; i++) {
    const raw = manifest.runner.argsTemplate[i];

    const blockOpen = parseBlockOpen(raw);
    if (blockOpen !== null) {
      if (block !== Block.None) throw new ResolveError(`Nested conditional block at position ${i}: "${raw}"`);
      block = blockOpen;
      include = shouldIncludeBlock(block, ctx);
      continue;
    }

    if (raw === '{{/if}}') {
      if (block === Block.None) throw new ResolveError(`Unmatched {{/if}} at position ${i}`);
      block = Block.None;
      include = true;
      continue;
    }

    if (!include) continue;

    const resolved = resolveToken(raw, manifest, ctx);
    if (resolved.length === 0) continue;

    if (isFeatureToken(raw)) {
      const parts = resolved.split(/(?<!\\) /);
      for (const part of parts) {
        if (part.length > 0) args.push(part);
      }
    } else {
      args.push(resolved);
    }
  }

  if (block !== Block.None) {
    throw new ResolveError(`Unclosed conditional block: ${Block[block]}`);
  }

  return {
    command: manifest.runner.command,
    args,
    env,
    promptInArgs: manifest.runner.promptInArgs,
  };
}

function parseBlockOpen(raw: string): Block | null {
  switch (raw) {
    case '{{if model}}': return Block.IfModel;
    case '{{if thinking}}': return Block.IfThinking;
    case '{{if planMode}}': return Block.IfPlanMode;
    case '{{if buildMode}}': return Block.IfBuildMode;
    case '{{if headless}}': return Block.IfHeadless;
    case '{{if variant}}': return Block.IfVariant;
    case '{{if interactive}}': return Block.IfInteractive;
    case '{{if headlessSession}}': return Block.IfHeadlessSession;
    case '{{if interactiveVariant}}': return Block.IfInteractiveVariant;
    case '{{if projectTrust}}': return Block.IfProjectTrust;
    default: return null;
  }
}

function shouldIncludeBlock(block: Block, ctx: ResolveContext): boolean {
  switch (block) {
    case Block.IfModel: return !!ctx.model;
    case Block.IfThinking: return !!ctx.thinkingEffort && !!ctx.model;
    case Block.IfPlanMode: return ctx.mode === 'plan';
    case Block.IfBuildMode: return ctx.mode !== 'plan';
    // Headless skip-permission flags only make sense for build-mode (write) tasks;
    // plan mode is read-only and the flag can conflict with --permission-mode plan.
    case Block.IfHeadless: return !!ctx.headless && ctx.mode !== 'plan';
    // `--variant` is a headless-only flag: it exists on `opencode run` but not
    // on the interactive TUI, which exits immediately if handed an unknown flag.
    case Block.IfVariant: return !!ctx.thinkingEffort && !isInteractive(ctx);
    // Session-shape blocks: unlike IfHeadless (a permission-flag gate with a
    // plan-mode carve-out), these pick the CLI invocation shape — e.g.
    // opencode's `run` subcommand vs its interactive TUI — so no mode carve-out.
    case Block.IfInteractive: return isInteractive(ctx);
    case Block.IfHeadlessSession: return !isInteractive(ctx);
    // Interactive counterpart of IfVariant, for runners whose TUI has no
    // variant flag and must receive the variant via env config instead.
    // Requires a provider-prefixed model: the config pins variant per model.
    case Block.IfInteractiveVariant:
      return !!ctx.thinkingEffort && !!ctx.model?.includes('/') && isInteractive(ctx);
    // Guards the flag/value pair that pre-trusts the workspace directory. The
    // condition, not the token, is what keeps a bare `-c` out of the args when
    // there is no cwd to name.
    case Block.IfProjectTrust: return isInteractive(ctx) && !!ctx.cwd;
    default: return true;
  }
}

function isFeatureToken(token: string): boolean {
  return token.startsWith('{{feature:') && token.endsWith('}}');
}

/**
 * Map a thinking effort variant ID to the Claude Code CLI flags string.
 * Effort IDs: adaptive, low, medium, high, xhigh, max (per-model from the
 * Anthropic API). `disabled` is handled as a legacy value for old tasks.
 * Returns a space-separated string that will be split into separate args.
 */
function resolveClaudeThinkingFlags(effort: string): string {
  if (effort === 'disabled') return '--thinking disabled';
  if (effort === 'adaptive') return '--thinking adaptive';
  // low/medium/high/xhigh/max all use --thinking enabled + --effort <level>
  if (['low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) {
    return `--thinking enabled --effort ${effort}`;
  }
  // Legacy: old variant IDs — map to adaptive
  return '--thinking adaptive';
}

function resolveToken(token: string, manifest: RunnerPluginManifest, ctx: ResolveContext): string {
  if (token === '{{prompt}}') return ctx.prompt;
  if (token === '{{model}}') return ctx.model || '';
  if (token === '{{thinkingEffort}}') return ctx.thinkingEffort || '';
  if (token === '{{mode}}') return ctx.mode || 'build';

  /**
   * Codex's TUI opens with a blocking "do you trust this directory?" menu the
   * first time it runs anywhere it has not been trusted before — every sandbox
   * mode, and a positional prompt does not skip it. An orchestrated task has
   * nobody to answer it, so the run would sit on the menu forever. `codex exec`
   * never asks, so pre-trusting the workspace is what keeps the interactive
   * shape behaving like the headless one it replaces. Emitted as ONE argv entry
   * (the `-c` before it is a literal template token), so a workspace path with
   * spaces in it survives.
   */
  if (token === '{{projectTrust}}') {
    if (!ctx.cwd) return '';
    return `projects.${JSON.stringify(ctx.cwd)}.trust_level="trusted"`;
  }

  if (token === '{{feature:thinking}}') {
    return manifest.features.thinkingFlag || '';
  }

  if (token === '{{feature:thinkingVal}}') {
    const effort = ctx.thinkingEffort || 'medium';
    if (effort === 'high') return manifest.features.thinkingValueEnabled || 'enabled';
    if (effort === 'low') return manifest.features.thinkingValueDisabled || 'disabled';
    return manifest.features.thinkingValueAdaptive || 'adaptive';
  }

  // Combined thinking flags: --thinking MODE [--effort LEVEL]
  // Used by Claude Code's new argsTemplate.
  if (token === '{{feature:thinkingFlags}}') {
    const effort = ctx.thinkingEffort;
    if (!effort) return '';
    return resolveClaudeThinkingFlags(effort);
  }

  // Reasoning effort as a config override: `-c model_reasoning_effort=<level>`.
  // Used by Codex, whose CLI has no dedicated effort flag. Left unquoted on
  // purpose: bare levels fail TOML parsing and fall back to the raw string,
  // which is what codex expects — quoting would diverge between shell-mediated
  // (interactive terminal) and direct-spawn (headless) invocations.
  if (token === '{{feature:reasoningEffortConfig}}') {
    const effort = ctx.thinkingEffort;
    if (!effort) return '';
    return `-c model_reasoning_effort=${effort}`;
  }

  // Maps the current mode to the runner's --permission-mode CLI value.
  if (token === '{{feature:permissionModeVal}}') {
    const mode = ctx.mode || 'default';
    const map = manifest.features.permissionModeValues;
    if (map && map[mode] !== undefined) return map[mode];
    // Fallback: use mode ID directly as CLI value
    return mode;
  }

  if (token === '{{feature:planMode}}') {
    return manifest.features.planModeFlag || '';
  }

  if (token === '{{feature:buildMode}}') {
    return manifest.features.buildModeFlag || '';
  }

  if (token === '{{feature:headless}}') {
    return manifest.features.headlessFlag || '';
  }

  if (token.startsWith('{{feature:') && token.endsWith('}}')) {
    return '';
  }

  return token;
}

/**
 * The OPENCODE_CONFIG_CONTENT payload that pins a variant for a TUI session:
 * agent-scoped model+variant (opencode applies an agent's variant only when
 * the session uses that agent's configured model) PLUS disabling the model's
 * other variants — without the disables, the TUI's remembered last-used
 * variant silently wins over the agent config.
 */
function resolveOpencodeVariantConfig(ctx: ResolveContext): string {
  const model = ctx.model;
  const effort = ctx.thinkingEffort;
  if (!model || !effort) return '';
  const slash = model.indexOf('/');
  if (slash <= 0) return '';
  const provider = model.slice(0, slash);
  const bareModel = model.slice(slash + 1);
  const config: Record<string, unknown> = {
    agent: { [ctx.mode || 'build']: { model, variant: effort } },
  };
  const others = (ctx.modelVariants ?? []).filter((v) => v !== effort);
  if (others.length > 0) {
    config.provider = {
      [provider]: {
        models: {
          [bareModel]: {
            variants: Object.fromEntries(others.map((v) => [v, { disabled: true }])),
          },
        },
      },
    };
  }
  return JSON.stringify(config);
}

function substituteSimple(value: string, ctx: ResolveContext): string {
  // Env values support the same (non-nested) {{if X}}…{{/if}} conditions as
  // the args template: the wrapped text is kept or dropped as a whole.
  const conditioned = value.replace(/\{\{if (\w+)\}\}([\s\S]*?)\{\{\/if\}\}/g, (match, name, body) => {
    const block = parseBlockOpen(`{{if ${name}}}`);
    if (block === null) return match;
    return shouldIncludeBlock(block, ctx) ? body : '';
  });
  return conditioned
    .replace(/\{\{opencodeVariantConfig\}\}/g, () => resolveOpencodeVariantConfig(ctx))
    .replace(/\{\{prompt\}\}/g, ctx.prompt)
    .replace(/\{\{model\}\}/g, ctx.model || '')
    .replace(/\{\{thinkingEffort\}\}/g, ctx.thinkingEffort || '')
    .replace(/\{\{mode\}\}/g, ctx.mode || 'build');
}
