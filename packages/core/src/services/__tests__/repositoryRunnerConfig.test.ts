import { expect, it } from 'vitest';
import { repositoryRunnerConfigPaths } from '../../index';

it('selects executable repository runner configuration in a changed-path list', () => {
  const cases: Array<[string, boolean]> = [
    ['.mcp.json', true],
    ['.claude/settings.json', true],
    ['.claude/settings.local.json', true],
    ['.claude/hooks/start.sh', true],
    ['.claude/hooks/nested/start.sh', true],
    ['.claude/plugins/example/index.js', true],
    ['.claude-plugin/plugin.json', true],
    ['.claude-plugin/nested/file.js', true],
    ['.claude/plugin.json', true],
    ['.claude/marketplace.json', true],
    ['.claude/catalog/plugin.json', true],
    ['.claude/catalog/marketplace.json', true],
    ['CLAUDE.md', false],
    ['AGENTS.md', false],
    ['.claude/CLAUDE.md', false],
    ['docs/mcp.json', false],
    ['opencode.json', true],
    ['opencode.jsonc', true],
    ['.opencode/opencode.json', true],
    ['.opencode/plugin/x.ts', true],
    ['.opencode/plugins/x.ts', true],
    ['.opencode/tool/x.ts', true],
    ['.opencode/node_modules/x/index.js', false],
    ['.opencode/package.json', false],
    ['.opencode/agent/review.md', true],
    ['.opencode/agents/build.md', true],
    ['.opencode/agents-extra/build.md', false],
    ['.codex/config.toml', true],
    ['.codex/hooks.json', true],
    ['opencode.json.bak', false],
    ['.mcp.json.bak', false],
    ['.claude/settings.json.bak', false],
    ['.claude/hooks-other/start.sh', false],
    ['.claude/plugins-extra/index.js', false],
    ['.claude-plugin-extra/plugin.json', false],
    ['.claude/catalog/not-plugin.json', false],
    ['packages/x/.claude/settings.json', false],
    ['packages/x/.mcp.json', false],
    ['.pi/settings.json', true],
    ['.pi/mcp.json', true],
    ['.pi/extensions', true],
    ['.pi/extensions/hook.ts', true],
    ['.pi/extensions-extra/hook.ts', false],
    ['.pi/extensions/nested/index.ts', true],
    ['.pi/prompts/review.md', false],
    ['.pi/settings.json.bak', false],
  ];
  for (const [path, included] of cases) {
    expect(repositoryRunnerConfigPaths([path]), path).toEqual(included ? [path] : []);
  }
  expect(repositoryRunnerConfigPaths([])).toEqual([]);
  expect(repositoryRunnerConfigPaths(['.mcp.json', '.claude/settings.json', '.mcp.json']))
    .toEqual(['.claude/settings.json', '.mcp.json']);
});
