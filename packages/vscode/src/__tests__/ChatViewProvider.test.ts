import { describe, it, expect, vi } from 'vitest';
import * as vscode from 'vscode';
import { ChatViewProvider } from '../providers/ChatViewProvider';
import { createEmptyPlan, createTask, type DiscoveredModel, type SkillLoad } from '@ordewell/core';

vi.mock('vscode', () => ({
  EventEmitter: class {
    listeners: ((e: unknown) => void)[] = [];
    event = (fn: (e: unknown) => void) => { this.listeners.push(fn); return { dispose() {} }; };
    fire(e: unknown) { for (const fn of this.listeners) fn(e); }
  },
  Uri: { joinPath: (...parts: unknown[]) => ({ toString: () => parts.join('/') }) },
  commands: { executeCommand: vi.fn() },
}));

const executeCommand = vscode.commands.executeCommand as unknown as ReturnType<typeof vi.fn>;

function providerWithCapture(): { provider: ChatViewProvider; posted: { type: string }[]; view: { show: ReturnType<typeof vi.fn> }; dispose: () => void } {
  let onDispose: () => void = () => {};
  const provider = new ChatViewProvider({ toString: () => 'file:///ext' } as unknown as vscode.Uri);
  const posted: { type: string }[] = [];
  const fakeView = {
    show: vi.fn(),
    onDidDispose: (fn: () => void) => { onDispose = fn; return { dispose() {} }; },
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
  return { provider, posted, view: fakeView as unknown as { show: ReturnType<typeof vi.fn> }, dispose: () => onDispose() };
}

describe('ChatViewProvider.reveal', () => {
  it('shows a hidden chat without stealing focus, so the user sees the request', () => {
    const { provider, view } = providerWithCapture();

    provider.reveal();

    expect(view.show).toHaveBeenCalledWith(true);
    expect(executeCommand).not.toHaveBeenCalled();
  });

  it('focuses the view when it was never opened, so the request still has somewhere to land', () => {
    const provider = new ChatViewProvider({ toString: () => 'file:///ext' } as unknown as vscode.Uri);
    executeCommand.mockClear();

    provider.reveal();

    expect(executeCommand).toHaveBeenCalledWith('ordewellChatView.focus');
  });
});

describe('ChatViewProvider after its webview is disposed', () => {
  it('stops posting to the dead webview and focuses the view again on reveal', () => {
    const { provider, posted, view, dispose } = providerWithCapture();
    executeCommand.mockClear();

    dispose();
    provider.setConversationBusy(true);
    provider.reveal();

    expect(posted).toEqual([]);
    expect(view.show).not.toHaveBeenCalled();
    expect(executeCommand).toHaveBeenCalledWith('ordewellChatView.focus');
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

describe('ChatViewProvider.showPendingPlanEdits', () => {
  it('sends every waiting plan edit with its id, so the chat can list and withdraw each one', () => {
    const { provider, posted } = providerWithCapture();

    provider.showPendingPlanEdits([{ id: 'q-1', text: 'also add tests' }]);

    expect(posted).toEqual([{ type: 'pendingPlanEdits', edits: [{ id: 'q-1', text: 'also add tests' }] }]);
  });
});

describe('ChatViewProvider.sendPlanUpdated', () => {
  const body = 'Ask hard questions. SECRET-BODY';
  const load: SkillLoad = { invokedBy: 'user', name: 'grilling', source: 'global', path: '~/.ordewell/skills/grilling/SKILL.md', content: body };

  it('sends the webview skill-load notices without bodies, and leaves the host\'s own plan whole', () => {
    const { provider, posted } = providerWithCapture();
    const plan = {
      ...createEmptyPlan(),
      tasks: [{ ...createTask({ id: 't1' }), attemptSkills: [{ name: 'tdd', source: 'global' as const, path: '~/.ordewell/skills/tdd/SKILL.md', content: body }] }],
      conversationHistory: [{ role: 'user' as const, content: 'loaded', timestamp: '2026-01-01T00:00:00Z', kind: 'skill_load' as const, skill: load }],
      queuedMessages: [{ id: 'q1', text: '/grilling go', timestamp: '2026-01-01T00:00:01Z', skills: [load] }],
    };

    provider.sendPlanUpdated(plan);

    expect(JSON.stringify(posted)).not.toContain('SECRET-BODY');
    expect(posted[0]).toMatchObject({ type: 'planUpdated', plan: { conversationHistory: [{ skill: { name: 'grilling' } }] } });
    expect(plan.conversationHistory[0].skill.content).toBe(body);
    expect(plan.queuedMessages[0].skills[0].content).toBe(body);
    expect(plan.tasks[0].attemptSkills?.[0].content).toBe(body);
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

describe('ChatViewProvider.setTaskSkills', () => {
  it('sends the task-skill catalog to the webview', () => {
    const { provider, posted } = providerWithCapture();
    provider.setTaskSkills([{ name: 'tdd', description: 'Test first' }]);

    expect(posted).toEqual([{ type: 'setTaskSkills', skills: [{ name: 'tdd', description: 'Test first' }] }]);
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

describe('ChatViewProvider conversation reloads', () => {
  const history = [
    { role: 'user' as const, content: 'goal', timestamp: '2026-01-01T00:00:00Z' },
    { role: 'assistant' as const, content: 'Plan generated with 1 task.', timestamp: '2026-01-01T00:00:02Z', kind: 'plan_generated' as const },
  ];
  const researchLog = [
    { id: 'r1', tool: 'read_file' as const, args: '{"path":"a.ts"}', result: 'x', timestamp: '2026-01-01T00:00:01Z', success: true, outcome: 'success' as const },
  ];

  it('reopens a session with its research and plan markers, not just the transcript', () => {
    const { provider, posted } = providerWithCapture();
    provider.restoreChat({ conversationHistory: history, researchLog });

    expect(posted).toEqual([
      { type: 'restoreChat' },
      {
        type: 'conversationPatch',
        order: ['b1', 'b2', 'b3'],
        changed: [
          expect.objectContaining({ type: 'message', role: 'user', text: 'goal' }),
          expect.objectContaining({ type: 'tool', headline: { name: 'Read', keyArg: 'a.ts' }, status: 'ok' }),
          expect.objectContaining({ type: 'plan', status: 'generated', taskCount: 1 }),
        ],
      },
    ]);
  });

  it('redraws only the conversation after a compaction — a restoreChat would also wipe a running task\'s output', () => {
    const { provider, posted } = providerWithCapture();
    provider.replaceConversation({ conversationHistory: history, researchLog });

    expect(posted.map((m) => m.type)).toEqual(['conversationPatch']);
  });

  it('tells the webview when to lock and free the input', () => {
    const { provider, posted } = providerWithCapture();
    provider.setConversationBusy(true);
    provider.setConversationBusy(false);
    expect(posted).toEqual([{ type: 'conversationBusy', busy: true }, { type: 'conversationBusy', busy: false }]);
  });
});
