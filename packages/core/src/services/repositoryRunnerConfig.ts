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
    path.startsWith('.pi/extensions/')
  ))].sort();
}
