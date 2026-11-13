import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { DisplayBlock, SerializedTask, SessionMessage } from '@ordewell/core';
import { SessionView } from '../SessionView';
import { applyConversationPatch, EMPTY_PATCHED_VIEW, patchedBlocks, type HostToWebview, type PatchedView } from '../../protocol';

/** A webview stand-in: it keeps only what the host posted, the way App does. */
function webview() {
  let view: PatchedView = EMPTY_PATCHED_VIEW;
  return {
    post: (msg: HostToWebview) => {
      if (msg.type === 'conversationPatch') view = applyConversationPatch(view, msg);
    },
    said: (): string[] => patchedBlocks(view).flatMap((block: DisplayBlock) => (block.type === 'message' && block.role === 'system' ? [block.text] : [])),
  };
}

function planned(id: string, over: Partial<SerializedTask> = {}): SerializedTask {
  return {
    id, order: 1, title: `Task ${id}`, type: 'ai', status: 'pending', description: 'd', dependencies: [],
    assignedRunner: 'claude-code', assignedModel: null, taskMode: 'build', prompt: null, subtasks: [],
    userSteps: undefined, autonomy: undefined, sliceType: undefined, userStoriesCovered: undefined,
    ...over,
  };
}

const started = (taskId: string, title = `Task ${taskId}`): SessionMessage => ({ type: 'task_started', taskId, order: 1, title, runner: 'claude-code' });

describe('SessionView', () => {
  let screen: ReturnType<typeof webview>;
  let session: SessionView;

  beforeEach(() => {
    vi.useFakeTimers();
    screen = webview();
    session = new SessionView(screen.post);
  });
  afterEach(() => vi.useRealTimers());

  const send = (...messages: SessionMessage[]) => {
    for (const message of messages) session.receive(message);
    vi.runAllTimers();
  };

  const plan = (...tasks: SerializedTask[]): SessionMessage => ({ type: 'plan_generated', plan: { tasks, runners: ['claude-code'], generatedAt: '2026-10-13T09:00:00.000Z' }, goal: 'g', runners: ['claude-code'] });

  describe('the notices a run earns, worded by core as the terminal words them', () => {
    it('says a task started, once', () => {
      send(plan(planned('t1')), started('t1', 'Add a parser'));

      expect(screen.said()).toEqual(['Started "Add a parser" · Claude Code']);
    });

    it('does not say it again for a task the run already shows at work', () => {
      send(plan(planned('t1')), started('t1', 'Add a parser'), started('t1', 'Add a parser'));

      expect(screen.said()).toEqual(['Started "Add a parser" · Claude Code']);
    });

    it('speaks again when a retry has put the task back to pending', () => {
      send(
        plan(planned('t1')),
        started('t1', 'Add a parser'),
        { type: 'status_update', tasks: [{ id: 't1', status: 'failed', verdict: null }] },
        { type: 'status_update', tasks: [{ id: 't1', status: 'pending', verdict: null }] },
        started('t1', 'Add a parser'),
      );

      expect(screen.said()).toEqual(['Started "Add a parser" · Claude Code', 'Started "Add a parser" · Claude Code']);
    });

    it('asks for the plan\'s sign-off without pointing at a command, since a button approves it here', () => {
      send({ type: 'review_needed', tasks: [] }, { type: 'review_approved' });

      expect(screen.said()).toEqual(['Plan needs your sign-off.', 'Plan approved.']);
    });

    it('reports how a run ended', () => {
      send({ type: 'execution_complete', summary: { total: 3, completed: 2, failed: 1, blocked: 0, skipped: 0 } });

      expect(screen.said()).toEqual(['Execution finished: 2/3 tasks complete · 1 failed.']);
    });

    it('counts a stopped run from the statuses it holds, as a stop sends no tally', () => {
      send(
        plan(planned('t1'), planned('t2'), planned('t3')),
        { type: 'status_update', tasks: [{ id: 't1', status: 'completed', verdict: null }, { id: 't2', status: 'in_progress', verdict: null }, { id: 't3', status: 'pending', verdict: null }] },
        { type: 'execution_stopped' },
      );

      expect(screen.said()).toEqual(['Execution stopped: 1/3 tasks complete.']);
    });

    it('says nothing for a message that earns no line', () => {
      send({ type: 'run_closed' }, { type: 'status_update', tasks: [] }, { type: 'task_output', taskId: 't1', text: 'chatter' });

      expect(screen.said()).toEqual([]);
    });
  });

  describe('what a message asks of the host', () => {
    it('hands back the cue the host acts on, alongside the line', () => {
      expect(session.receive({ type: 'review_needed', tasks: [] })).toEqual({ type: 'plan' });
      expect(session.receive({ type: 'execution_complete', summary: { total: 1, completed: 1, failed: 0, blocked: 0, skipped: 0 } })).toEqual({ type: 'settled' });
      expect(session.receive({ type: 'execution_stopped' })).toEqual({ type: 'settled', dock: 'draft' });
      expect(session.receive({ type: 'review_approved' })).toBeNull();
    });

    it('clears the task\'s command list when it starts', () => {
      const posts: HostToWebview[] = [];
      const view = new SessionView((msg) => posts.push(msg));

      view.receive(started('t1'));

      expect(posts).toContainEqual({ type: 'taskCommands', taskId: 't1', commands: [] });
    });
  });
});
