import { describe, it, expect, vi } from 'vitest';
import * as vscode from 'vscode';
import { ChatViewProvider } from '../providers/ChatViewProvider';
import type { DiscoveredModel } from '@ordewell/core';

vi.mock('vscode', () => ({
  EventEmitter: class {
    listeners: ((e: unknown) => void)[] = [];
    event = (fn: (e: unknown) => void) => { this.listeners.push(fn); return { dispose() {} }; };
    fire(e: unknown) { for (const fn of this.listeners) fn(e); }
  },
  Uri: { joinPath: (...parts: unknown[]) => ({ toString: () => parts.join('/') }) },
}));

function providerWithCapture(): { provider: ChatViewProvider; posted: { type: string }[] } {
  const provider = new ChatViewProvider({ toString: () => 'file:///ext' } as unknown as vscode.Uri);
  const posted: { type: string }[] = [];
  const fakeView = {
    webview: {
      options: {},
      html: '',
      cspSource: 'vscode-resource:',
      asWebviewUri: (u: unknown) => u,
      onDidReceiveMessage: () => ({ dispose() {} }),
      postMessage: (msg: { type: string }) => { posted.push(msg); return Promise.resolve(true); },
    },
  } as unknown as vscode.WebviewView;
  provider.resolveWebviewView(fakeView, {} as never, {} as never);
  posted.length = 0;
  return { provider, posted };
}

describe('ChatViewProvider.setGoal', () => {
  it('never sends a state transition — an empty goal must not wipe the webview timeline', () => {
    const { provider, posted } = providerWithCapture();
    provider.setGoal('');
    provider.setGoal('build a login page');
    expect(posted.map((m) => m.type)).toEqual(['setGoal', 'setGoal']);
    expect(posted.some((m) => m.type === 'setState')).toBe(false);
  });
});

describe('ChatViewProvider.setModels', () => {
  it('sends full DiscoveredModel objects so variants and runnerProvider survive to the webview', () => {
    const { provider, posted } = providerWithCapture();
    const models: DiscoveredModel[] = [
      { modelId: 'opencode/deepseek-v4-pro', modelLabel: 'DeepSeek V4 Pro', runnerProvider: 'opencode', variants: [{ id: 'low', label: 'Low' }, { id: 'high', label: 'High' }] },
      { modelId: 'opencode-go/deepseek-v4-pro', modelLabel: 'DeepSeek V4 Pro (Go)', runnerProvider: 'opencode-go', variants: [{ id: 'low', label: 'Low' }] },
      { modelId: 'openrouter/~anthropic/claude-sonnet-latest', modelLabel: 'Claude Sonnet', runnerProvider: 'openrouter', variants: [] },
    ];
    provider.setModels(models);

    expect(posted).toHaveLength(1);
    const msg = posted[0] as { type: string; models: DiscoveredModel[] };
    expect(msg.type).toBe('setModels');
    expect(msg.models).toHaveLength(3);
    expect(msg.models[0]).toMatchObject(models[0]);
    expect(msg.models[1].runnerProvider).toBe('opencode-go');
    expect(msg.models[2].runnerProvider).toBe('openrouter');
  });
});

describe('ChatViewProvider.setSkills', () => {
  it('sends the discovered skill list to the webview', () => {
    const { provider, posted } = providerWithCapture();
    provider.setSkills([{ name: 'grilling', description: 'Grill a plan' }]);

    expect(posted).toHaveLength(1);
    const msg = posted[0] as { type: string; skills: { name: string; description: string }[] };
    expect(msg.type).toBe('setSkills');
    expect(msg.skills).toEqual([{ name: 'grilling', description: 'Grill a plan' }]);
  });
});

describe('ChatViewProvider.resendAllState', () => {
  it('rebuilds flat models as DiscoveredModel[] preserving variants and all runner providers', () => {
    const { provider, posted } = providerWithCapture();
    const byRunner: Record<string, DiscoveredModel[]> = {
      opencode: [
        { modelId: 'opencode/deepseek-v4-pro', modelLabel: 'DeepSeek V4 Pro', runnerProvider: 'opencode', variants: [{ id: 'low', label: 'Low' }] },
        { modelId: 'opencode-go/deepseek-v4-pro', modelLabel: 'DeepSeek V4 Pro (Go)', runnerProvider: 'opencode-go', variants: [{ id: 'high', label: 'High' }] },
      ],
    };
    provider.setModelsByRunner(byRunner);
    posted.length = 0;

    provider.resendAllState();

    const setModelsMsg = posted.find((m) => m.type === 'setModels') as { type: string; models: DiscoveredModel[] } | undefined;
    expect(setModelsMsg).toBeDefined();
    expect(setModelsMsg!.models).toHaveLength(2);
    expect(setModelsMsg!.models[0].modelId).toBe('opencode/deepseek-v4-pro');
    expect(setModelsMsg!.models[0].variants).toEqual([{ id: 'low', label: 'Low' }]);
    expect(setModelsMsg!.models[1].runnerProvider).toBe('opencode-go');
  });
});
