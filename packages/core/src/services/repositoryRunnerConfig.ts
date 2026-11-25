/** Where a runner looks for project configuration, relative to the directory it starts in. */
export const RUNNER_CONFIG_ROOTS = ['.mcp.json', '.claude', '.claude-plugin', 'opencode.json', 'opencode.jsonc', '.opencode', '.codex', '.pi'] as const;

/** Select runner configuration that can run code or redirect a launch from paths relative to the directory the runner starts in. */
export function repositoryRunnerConfigPaths(paths: readonly string[]): string[] {
  return [...new Set(paths.filter(path =>
    // Project MCP servers start commands or send data to a repository-chosen URL.
    path === '.mcp.json' ||
    // Settings can run hooks and helpers, load plugins, or redirect traffic.
    path === '.claude/settings.json' ||
    // Local settings have the same execution capabilities as project settings.
    path === '.claude/settings.local.json' ||
    // Hook files provide commands invoked by the runner.
    path.startsWith('.claude/hooks/') ||
    // Plugin files can provide code and hooks loaded by the runner.
    path.startsWith('.claude/plugins/') ||
    // Plugin metadata can load plugins and their executable components.
    path.startsWith('.claude-plugin/') ||
    // Plugin and marketplace manifests can select code for the runner to load.
    /^\.claude\/(?:[^/]+\/)*(?:plugin|marketplace)\.json$/.test(path) ||
    // OpenCode config declares MCP servers and plugins; its plugin and tool
    // directories are code it loads, and an agent definition sets the prompt,
    // model and permissions of the built-in agent its id names, which a task
    // launches with. The rest of `.opencode/` is dependencies OpenCode
    // installs itself, which a later launch must not be held for.
    /^(?:\.opencode\/)?opencode\.jsonc?$/.test(path) ||
    /^\.opencode\/(?:plugins?|tools?|agents?)\//.test(path) ||
    // Codex project config carries MCP servers, hooks and `notify` commands.
    path.startsWith('.codex/') ||
    // Pi's project settings load packages and extensions, its extensions are
    // code it runs, and its MCP config starts commands or reaches a URL.
    path === '.pi/settings.json' ||
    path === '.pi/mcp.json' ||
    path === '.pi/extensions' ||
    path.startsWith('.pi/extensions/')
  ))].sort();
}

/**
 * The runner configuration among `paths`, named from a repository's top, for
 * a runner that starts `prefix` below it (`''` at the top): one of the top's
 * own, which Claude reads there too, or one of the runner's directory, as
 * the launch check names each (ADR-0028).
 */
export function runnerConfigFromTop(paths: readonly string[], prefix: string): string[] {
  return [...new Set(paths.filter((name) => repositoryRunnerConfigPaths([name]).length > 0
    || (prefix !== '' && name.startsWith(prefix) && repositoryRunnerConfigPaths([name.slice(prefix.length)]).length > 0)))].sort();
}

/**
 * Whether `file`, named from a repository's top in either separator, is
 * runner configuration that agents load when they start: one of the top's
 * own, or of a directory from the top down to `workspace`, the workspace's
 * folder from the top (`''` at the top), the directories the launch check
 * reads (ADR-0028). A name given from the workspace's folder is asked with no
 * `workspace`: the folder's own configuration then reads as a top's.
 */
export function isAgentSettingsPath(file: string, workspace = ''): boolean {
  const name = file.replace(/\\/g, '/');
  const levels = workspace.replace(/\\/g, '/').split('/').filter((part) => part !== '' && part !== '.');
  for (let depth = 0; depth <= levels.length; depth++) {
    const prefix = levels.slice(0, depth).map((part) => `${part}/`).join('');
    if (name.startsWith(prefix) && repositoryRunnerConfigPaths([name.slice(prefix.length)]).length > 0) return true;
  }
  return false;
}
