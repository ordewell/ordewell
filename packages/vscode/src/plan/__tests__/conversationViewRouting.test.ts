import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type * as vscode from 'vscode';
import type { SessionMessage } from '@ordewell/core';
import { handleSessionMessage, type PlanManagerDeps } from '../PlanManager';
import { ChatViewProvider } from '../../providers/ChatViewProvider';
import { applyConversationPatch, EMPTY_PATCHED_VIEW, patchedBlocks, type HostToWebview, type PatchedView } from '@ordewell/ui/protocol';

function chat() {
  const provider = new ChatViewProvider({ toString: () => 'file:///ext' } as unknown as vscode.Uri);
  const posted: HostToWebview[] = [];
  let view: PatchedView = EMPTY_PATCHED_VIEW;
  provider.postMessage = (msg) => {
    posted.push(msg);
    if (msg.type === 'conversationPatch') view = applyConversationPatch(view, msg);
  };
  return { provider, posted, blocks: () => patchedBlocks(view) };
}

describe('planner events reach the webview through the conversation view', () => {
  let screen: ReturnType<typeof chat>;
  let deps: PlanManagerDeps;

  beforeEach(() => {
    vi.useFakeTimers();
    screen = chat();
    deps = { session: {}, chatProvider: screen.provider, isGeneratingPlan: () => true } as unknown as PlanManagerDeps;
  });
  afterEach(() => vi.useRealTimers());

  const send = (...msgs: SessionMessage[]) => {
    for (const msg of msgs) handleSessionMessage(msg, deps);
    vi.runAllTimers();
  };

  it('draws a turn\'s command row and settled reply', () => {
    send(
      { type: 'planner_turn_started', turnId: 't', prompt: 'look around' },
      { type: 'research_step', tool: 'bash', args: '{"command":"ls"}', toolCallId: 'c1', turnId: 't' },
      { type: 'research_step_done', turnId: 't', step: { id: 's', tool: 'bash', args: '{"command":"ls"}', result: 'a\nb', timestamp: '', success: true, outcome: 'success', toolCallId: 'c1' } },
      { type: 'planner_message', content: 'Two files.', timestamp: '', turnId: 't' },
      { type: 'planner_turn_ended', turnId: 't', outcome: 'message' },
    );

    expect(screen.blocks()).toEqual([
      expect.objectContaining({ type: 'message', role: 'user', text: 'look around' }),
      expect.objectContaining({ type: 'tool', headline: { name: 'Bash', keyArg: 'ls' }, status: 'ok', output: 'a\nb' }),
      expect.objectContaining({ type: 'message', role: 'planner', text: 'Two files.', streaming: false }),
    ]);
  });

  it('announces a task starting in the same words the TUI uses', () => {
    send({ type: 'task_started', taskId: 'x', order: 1, title: 'Add a parser', runner: 'claude-code' });

    expect(screen.blocks()).toEqual([
      expect.objectContaining({ type: 'message', role: 'system', text: 'Started "Add a parser" · claude-code' }),
    ]);
  });

  it('draws a silent approval decision as a card carrying its source', () => {
    send({ type: 'approval_decided', kind: 'shell_command', subject: 'npm test', scope: 'npm test', granted: true, source: 'remembered' });

    expect(screen.blocks()).toContainEqual(expect.objectContaining({
      type: 'approval', subject: 'npm test', status: 'granted', decidedBy: 'remembered',
    }));
    // The card is the record now; a duplicate system line would say it twice.
    expect(screen.blocks()).not.toContainEqual(expect.objectContaining({ type: 'message', role: 'system' }));
  });

  it('forwards liveness so the webview watchdog sees a quiet planner working', () => {
    send({ type: 'planner_liveness' });

    expect(screen.posted).toEqual([{ type: 'plannerLiveness' }]);
  });
});
