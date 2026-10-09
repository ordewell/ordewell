import { describe, it, expect, afterEach, vi } from 'vitest';
import * as vscode from 'vscode';
import { removedPluginNotice } from '@ordewell/core';
import { activate, deactivate } from '../extension';
import { createExtension } from '../ExtensionHost';

vi.mock('@ordewell/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ordewell/core')>();
  return { ...actual, removedPluginNotice: vi.fn() };
});

vi.mock('../ExtensionHost', () => ({
  createExtension: vi.fn(() => ({ start: vi.fn(), dispose: vi.fn() })),
}));

afterEach(() => {
  deactivate();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('extension startup with removed runner manifests', () => {
  const context = {
    secrets: { get: async () => undefined },
    extensionUri: vscode.Uri.file('/extension'),
  } as unknown as vscode.ExtensionContext;

  it('logs one notice per activation and keeps its runner list built-in', async () => {
    const notice = 'Plugin runners were removed; see the CHANGELOG.';
    vi.mocked(removedPluginNotice).mockReturnValue(notice);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await activate(context);
    const output = vi.mocked(vscode.window.createOutputChannel).mock.results.at(-1)?.value as vscode.OutputChannel;
    expect(vi.mocked(output.appendLine).mock.calls.filter(([line]) => line.includes(notice))).toHaveLength(1);
    expect(vi.mocked(createExtension).mock.calls[0][0].runnerRegistry.list().map((entry) => entry.manifest.name)).toEqual(['claude-code', 'codex', 'opencode']);
  });

  it('logs no removal notice without leftover manifests', async () => {
    vi.mocked(removedPluginNotice).mockReturnValue(undefined);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await activate(context);
    const output = vi.mocked(vscode.window.createOutputChannel).mock.results.at(-1)?.value as vscode.OutputChannel;
    expect(vi.mocked(output.appendLine).mock.calls.some(([line]) => line.includes('Plugin runners were removed'))).toBe(false);
  });
});
