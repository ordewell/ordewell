import type { ChildDirectory, ChildPlanHandle } from '@ordewell/core';
import { ConversationViewHost } from '../ConversationViewHost';
import type { ChildCheckpointAnswer, HostToWebview } from '../shared/protocol';

const NOT_OPEN = 'The child plan is no longer open.';

/**
 * What a surface says for a refusal. An ended child's own text offers a
 * Continue, and a fresh retry may have taken that away, so it stops at what is
 * certain.
 */
export function refusalText(outcome: { code: string; message: string }): string {
  return outcome.code === 'view_only' ? 'This child plan has ended, so it only reads.' : outcome.message;
}

function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }

/** Keeps a selected child behind the root directory's tree membership check. */
export class ChildViewHost {
  private selected: { id: string; handle: ChildPlanHandle; unwatch: () => void; conversation: ConversationViewHost } | undefined;
  private generation = 0;
  private unlisten: (() => void) | undefined;
  private root: string | undefined;
  private refreshSequence = 0;

  constructor(private readonly directory: () => Pick<ChildDirectory, 'list' | 'find' | 'onChange'>, private readonly post: (message: HostToWebview) => void, private readonly rootId: () => string = () => 'root') {}

  async refresh(): Promise<void> {
    const sequence = ++this.refreshSequence;
    const root = this.rootId();
    if (this.root !== undefined && root !== this.root) {
      this.close();
      this.post({ type: 'childClosed' });
    }
    this.root = root;
    const children = await this.directory().list();
    if (sequence === this.refreshSequence && root === this.rootId()) this.post({ type: 'children', children, rootId: root });
  }

  /** Asked at each plan change, so cheap until the session under it really moved. */
  rootChanged(): void {
    if (this.root !== undefined && this.root !== this.rootId()) void this.refresh().catch((error: unknown) => this.report(error));
  }

  /** A webview that comes back holds nothing; what it had open is still open here. */
  resend(): void {
    if (!this.selected) return;
    this.post({ type: 'childView', view: this.selected.handle.view() });
    this.selected.conversation.resync();
  }

  start(): void {
    this.unlisten?.();
    this.unlisten = this.directory().onChange(() => {
      void this.refresh().catch((error: unknown) => this.report(error));
      void this.followSelected().catch((error: unknown) => this.report(error));
    });
    void this.refresh().catch((error: unknown) => this.report(error));
  }

  async open(id: string): Promise<void> {
    const generation = ++this.generation;
    const root = this.rootId();
    this.closeSelection();
    let handle: ChildPlanHandle | null;
    try { handle = await this.directory().find(id); }
    catch (error) {
      if (generation === this.generation) { this.post({ type: 'childClosed' }); this.report(error); }
      return;
    }
    if (generation !== this.generation || root !== this.rootId()) return;
    if (!handle) {
      this.post({ type: 'childClosed' });
      this.post({ type: 'childNotice', childId: id, message: 'Child plan not found.' });
      return;
    }
    const conversation = new ConversationViewHost((message) => {
      if (generation === this.generation && message.type === 'conversationPatch') this.post({ type: 'childConversation', childId: id, message });
    });
    const unwatch = handle.watch((frame) => {
      if (generation !== this.generation) return;
      if (frame.type === 'notice') this.post({ type: 'childNotice', childId: id, message: frame.message });
      else {
        conversation.receive(frame);
        if (frame.type === 'status_update' || frame.type === 'plan_generated' || frame.type === 'task_started' || frame.type === 'task_updated' || frame.type === 'execution_complete' || frame.type === 'execution_stopped') {
          this.post({ type: 'childView', view: handle.view() });
        }
      }
    });
    this.selected = { id, handle, unwatch, conversation };
    const view = handle.view();
    this.post({ type: 'childView', view });
    if (view.plan) conversation.reload(view.plan);
    else conversation.resync();
    if (view.plannerTurnId) conversation.receive({ type: 'planner_turn_started', turnId: view.plannerTurnId });
  }

  async message(id: string, text: string): Promise<void> {
    const report = (result: { status?: 'woken' | 'queued'; error?: string }) => this.post({ type: 'childMessageResult', childId: id, ...result });
    let handle: ChildPlanHandle;
    try {
      if (!text.trim()) throw new Error(NOT_OPEN);
      handle = await this.reach(id);
      const outcome = handle.message(text);
      report(outcome.ok ? { status: outcome.status } : { error: refusalText(outcome) });
    } catch (error) {
      report({ error: errorText(error) });
      return;
    }
    this.showViewAfter(id, handle);
  }

  /** The person's answer on this child's own task (ADR-0055 D20), so a depth-2 question never reaches the root. */
  async answer(answer: ChildCheckpointAnswer): Promise<void> {
    const { answerId, childId, taskId, question, answer: decision, reason } = answer;
    const report = (error?: string) => this.post({ type: 'checkpointResult', answerId, ...(error !== undefined ? { error } : {}) });
    let handle: ChildPlanHandle;
    try {
      handle = await this.reach(childId);
      const outcome = await handle.control(taskId, { kind: 'checkpoint', answer: decision, question, ...(reason ? { reason } : {}) });
      report(outcome.ok ? undefined : refusalText(outcome));
    } catch (error) {
      report(errorText(error));
      return;
    }
    // Not waiting any more: what is shown next is the question that is.
    this.showViewAfter(childId, handle);
  }

  /** A handle speaks for the tree it was found in, so every action finds it again. */
  private async reach(id: string): Promise<ChildPlanHandle> {
    if (this.selected?.id !== id) throw new Error(NOT_OPEN);
    const handle = await this.directory().find(id);
    if (!handle || this.selected?.id !== id) throw new Error(NOT_OPEN);
    return handle;
  }

  /** A seat leaving is a change too, and what left has no plan left to draw. */
  private async followSelected(): Promise<void> {
    const selected = this.selected;
    if (!selected) return;
    const handle = await this.directory().find(selected.id);
    if (this.selected !== selected) return;
    if (handle) { this.post({ type: 'childView', view: handle.view() }); return; }
    this.close();
    this.post({ type: 'childClosed' });
    this.post({ type: 'childNotice', childId: selected.id, message: NOT_OPEN });
  }

  private showView(id: string, handle: ChildPlanHandle): void {
    if (this.selected?.id === id) this.post({ type: 'childView', view: handle.view() });
  }

  /** The result is told by now, and a view that cannot be read is no second word on it: a person told "refused" of what landed would send it again. */
  private showViewAfter(id: string, handle: ChildPlanHandle): void {
    try { this.showView(id, handle); }
    catch (error) { this.post({ type: 'childNotice', childId: id, message: errorText(error) }); }
  }

  close(): void { ++this.generation; this.closeSelection(); }
  dispose(): void { this.close(); ++this.refreshSequence; this.unlisten?.(); this.unlisten = undefined; }
  private closeSelection(): void { this.selected?.unwatch(); this.selected = undefined; }
  private report(error: unknown): void { this.post({ type: 'childNotice', childId: this.selected?.id ?? '', message: errorText(error) }); }
}
