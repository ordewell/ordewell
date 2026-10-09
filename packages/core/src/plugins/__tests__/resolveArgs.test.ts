import { describe, it, expect } from 'vitest';
import { resolveModeSettings, resolveTaskRunnerFlags, claudeThinkingArgs } from '../resolveArgs';
import { CLAUDE_CODE_MANIFEST } from '../builtin/claude-code.manifest';
import { CODEX_MANIFEST } from '../builtin/codex.manifest';
import { OPENCODE_MANIFEST } from '../builtin/opencode.manifest';

describe('resolveModeSettings', () => {
  it('reads the approval policy and reviewer a Codex mode carries', () => {
    expect(resolveModeSettings(CODEX_MANIFEST, 'agent')).toEqual({ approvalPolicy: 'on-request', approvalsReviewer: 'auto_review' });
    expect(resolveModeSettings(CODEX_MANIFEST, 'fullAccess')).toEqual({ approvalPolicy: 'never' });
    expect(resolveModeSettings(CODEX_MANIFEST, 'plan')).toEqual({ approvalPolicy: 'never' });
  });

  it('is empty for a runner whose manifest declares neither map', () => {
    expect(resolveModeSettings(CLAUDE_CODE_MANIFEST, 'auto')).toEqual({});
  });

  it('treats a missing mode like an unmapped one', () => {
    expect(resolveModeSettings(CODEX_MANIFEST, undefined)).toEqual({});
  });
});

describe('resolveTaskRunnerFlags', () => {
  it('hands a Codex task its sandbox value and the raw effort id, with no Claude flags', () => {
    expect(resolveTaskRunnerFlags(CODEX_MANIFEST, { mode: 'agent', model: 'gpt-5.5', thinkingEffort: 'high' })).toEqual({
      permissionMode: 'workspace-write',
      effort: 'high',
      modeSettings: { approvalPolicy: 'on-request', approvalsReviewer: 'auto_review' },
    });
  });

  it('hands a Claude task the raw effort id too: the thinking flags are the adapter\'s to build', () => {
    expect(resolveTaskRunnerFlags(CLAUDE_CODE_MANIFEST, { mode: 'bypassPermissions', model: 'sonnet', thinkingEffort: 'max' })).toEqual({
      permissionMode: 'bypassPermissions',
      effort: 'max',
      modeSettings: {},
    });
  });

  it.each([
    [CLAUDE_CODE_MANIFEST, 'default'],
    [CODEX_MANIFEST, 'agent'],
  ])('drops the effort when no model is assigned (%#)', (manifest, mode) => {
    expect(resolveTaskRunnerFlags(manifest, { mode, thinkingEffort: 'high' })).not.toHaveProperty('effort');
  });

  it.each([
    ['build', 'acceptEdits'],
    ['', 'default'],
    ['default', 'default'],
    ['auto', 'auto'],
    ['plan', 'plan'],
    // A mode the manifest does not map is passed through as its own id.
    ['dontAsk', 'dontAsk'],
  ])('maps Claude mode "%s" to --permission-mode %s', (mode, expected) => {
    expect(resolveTaskRunnerFlags(CLAUDE_CODE_MANIFEST, { mode }).permissionMode).toBe(expected);
  });

  it.each([
    ['build', { permissionMode: 'build', modeSettings: { approvals: 'auto' } }],
    ['plan', { permissionMode: 'plan', modeSettings: {} }],
  ])('hands an OpenCode %s task its agent and how its requests are answered', (mode, expected) => {
    expect(resolveTaskRunnerFlags(OPENCODE_MANIFEST, { mode })).toEqual(expected);
  });
});

describe('Claude Code manifest — autonomy levels', () => {
  const byId = (id: string) => CLAUDE_CODE_MANIFEST.modes?.find((m) => m.id === id);

  it('Auto is the safe mode and Bypass permissions the autonomous one', () => {
    expect(byId('auto')).toMatchObject({ label: 'Auto', cliValue: 'auto', safe: true });
    expect(byId('bypassPermissions')).toMatchObject({ label: 'Bypass permissions', autonomous: true });
    expect(CLAUDE_CODE_MANIFEST.modes?.filter((m) => m.safe).map((m) => m.id)).toEqual(['auto']);
  });

  it('keeps Ask before edits selectable without a level tag', () => {
    expect(byId('default')).toBeDefined();
    expect(byId('default')?.safe).toBeUndefined();
    expect(byId('default')?.autonomous).toBeUndefined();
  });

  it('describes Auto as a classifier deciding each action', () => {
    expect(byId('auto')?.description).toMatch(/classifier/i);
  });
});

describe('claudeThinkingArgs', () => {
  it.each(['low', 'medium', 'high', 'xhigh', 'max'])('maps effort %s to enabled thinking', (effort) => {
    expect(claudeThinkingArgs(effort)).toEqual(['--thinking', 'enabled', '--effort', effort]);
  });

  it('keeps adaptive and disabled efforts and maps legacy values to adaptive', () => {
    expect(claudeThinkingArgs('adaptive')).toEqual(['--thinking', 'adaptive']);
    expect(claudeThinkingArgs('disabled')).toEqual(['--thinking', 'disabled']);
    expect(claudeThinkingArgs('enabled')).toEqual(['--thinking', 'adaptive']);
  });
});
