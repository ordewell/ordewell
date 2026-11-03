import type { ChildFrame, ChildPlanView } from '@ordewell/core';
import type { HostToWebview } from '../shared/protocol';
import { ConversationViewHost } from './ConversationViewHost';

/** What moves a child's card: the frames after which its view is read again and sent. */
const VIEW_CHANGES: ReadonlySet<ChildFrame['type']> = new Set<ChildFrame['type']>([
  'status_update', 'plan_generated', 'task_started', 'task_updated', 'execution_complete', 'execution_stopped',
]);

/**
 * The child plan a surface has open, as the chat's child pane draws it. Its
 * frames come from the root's in-process directory or from the child's own
 * daemon socket ({@link DaemonChildStream}); `now` is the child's view at the
 * moment it is asked, read off the handle or folded from the socket.
 */
export class ChildView {
  private readonly conversation: ConversationViewHost;

  constructor(
    private readonly childId: string,
    private readonly post: (msg: HostToWebview) => void,
    private readonly now: () => ChildPlanView,
  ) {
    // The child pane keeps its own conversation; the rest of what a
    // conversation host posts (the composer's turn gate, held prompts) is the
    // root's, which a child must not move.
    this.conversation = new ConversationViewHost((message) => {
      if (message.type === 'conversationPatch') post({ type: 'childConversation', childId, message });
    });
  }

  /** The child as it is now, for a pane that has just opened it. */
  open(): void {
    const view = this.now();
    this.post({ type: 'childView', view });
    if (view.plan) this.conversation.reload(view.plan);
    else this.conversation.resync();
    // A turn already running holds the child's prose; without its start the
    // deltas after it would have no turn to land in.
    if (view.plannerTurnId) this.conversation.receive({ type: 'planner_turn_started', turnId: view.plannerTurnId });
  }

  receive(frame: ChildFrame): void {
    if (frame.type === 'notice') {
      this.post({ type: 'childNotice', childId: this.childId, message: frame.message });
      return;
    }
    this.conversation.receive(frame);
    if (VIEW_CHANGES.has(frame.type)) this.show();
  }

  /** The child's card again, after something no frame announces: an answer, a seat leaving. */
  show(): void {
    this.post({ type: 'childView', view: this.now() });
  }

  /** A webview that comes back holds nothing; what it had open is still open here. */
  resend(): void {
    this.show();
    this.conversation.resync();
  }
}
