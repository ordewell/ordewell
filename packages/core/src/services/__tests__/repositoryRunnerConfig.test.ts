import { describe, expect, it } from 'vitest';
import { isAgentSettingsPath, repositoryRunnerConfigPaths } from '../../index';
import { isAgentSettingsPath as browserSafe } from '../../plan-utils';

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

it('selects executable repository runner configuration in a changed-path list', () => {
  for (const [path, included] of cases) {
    expect(repositoryRunnerConfigPaths([path]), path).toEqual(included ? [path] : []);
  }
  expect(repositoryRunnerConfigPaths([])).toEqual([]);
  expect(repositoryRunnerConfigPaths(['.mcp.json', '.claude/settings.json', '.mcp.json']))
    .toEqual(['.claude/settings.json', '.mcp.json']);
});

describe('isAgentSettingsPath', () => {
  it('agrees with the list on every path it judges, at the top and in either separator', () => {
    for (const [path, included] of cases) {
      expect(isAgentSettingsPath(path), path).toBe(included);
      expect(isAgentSettingsPath(path.replace(/\//g, '\\')), `${path} with backslashes`).toBe(included);
    }
  });

  it('does not take a look-alike for one', () => {
    for (const path of ['docs/.claude-notes.md', 'src/claude/settings.json', 'my.mcp.json', 'claude/settings.json', '.claude-notes.md', 'x.mcp.json', 'src/.mcp.json.d/a']) {
      expect(isAgentSettingsPath(path), path).toBe(false);
      expect(isAgentSettingsPath(path, 'src'), `${path} below src`).toBe(false);
    }
  });

  it('reads the directories from the top down to a workspace below it, and none past it', () => {
    for (const [path, included] of cases) {
      expect(isAgentSettingsPath(`packages/app/${path}`, 'packages/app'), `packages/app/${path}`).toBe(included);
      expect(isAgentSettingsPath(`packages/${path}`, 'packages/app'), `packages/${path}`).toBe(included);
      expect(isAgentSettingsPath(path, 'packages/app'), `${path} at the top`).toBe(included);
      expect(isAgentSettingsPath(`packages\\app\\${path.replace(/\//g, '\\')}`, 'packages\\app'), `${path} in Windows spelling`).toBe(included);
    }
    expect(isAgentSettingsPath('packages/app/.claude/settings.json', 'packages/app/')).toBe(true);
    expect(isAgentSettingsPath('packages/app/.claude/settings.json', './packages/app')).toBe(true);
    // Below the workspace, beside it, or with no workspace named: not a directory the check reads.
    expect(isAgentSettingsPath('packages/app/src/.claude/settings.json', 'packages/app')).toBe(false);
    expect(isAgentSettingsPath('packages/other/.mcp.json', 'packages/app')).toBe(false);
    expect(isAgentSettingsPath('packages/app/.mcp.json')).toBe(false);
    expect(isAgentSettingsPath('packages/application/.mcp.json', 'packages/app')).toBe(false);
  });

  it('is the browser-safe entry\'s too', () => {
    expect(browserSafe).toBe(isAgentSettingsPath);
  });
});
