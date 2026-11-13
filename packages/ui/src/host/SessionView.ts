import type { ApprovalRequestMessage, RunView, SessionMessage } from '@ordewell/core';
import { runNotice } from '@ordewell/core/plan-utils';
import type { HostToWebview } from '../shared/protocol';
import { ConversationViewHost, type SavedConversation } from './ConversationViewHost';
import { RunViewHost } from './RunViewHost';
import { isolationBlockedConfirmation, type ConfirmationRequest, type IsolationBlockedChoice } from './confirmations';

/**
 * What a session message asks of the host beyond the view: the parts that
 * only it can do, because they read or change what it alone holds.
 */
export type SessionCue =
  /** A planner approval waits on its chat card. Nothing blocks on it, so the host only brings the chat forward. */
  | { type: 'reveal' }
  /**
   * The plan may have moved: the host shows its plan again. `dock` is what the
   * dock's status becomes, `'run'` read from the run as it stands and
   * `'draft'` after a stop. Absent, the dock keeps the status it showed.
   */
  | { type: 'plan'; dock?: 'run' | 'draft' }
  /** The run ended, or stopped: the plan as `plan`, then the run's activity, and a host that saves the session saves it. */
  | { type: 'settled'; dock?: 'draft' }
  | { type: 'confirm'; request: ConfirmationRequest<IsolationBlockedChoice> }
  /** A runner loaded the commands a task's composer offers; the host reads them off the task's latest log. */
  | { type: 'commands'; taskId: string };

/** What a session holds now, for a view that joins it or rejoins it: the stream goes on from here. */
export interface SessionSnapshot {
  run: RunView;
  /** The planner's requests still waiting. Absent when the source does not know, which is not "none". */
  approvals?: readonly ApprovalRequestMessage[];
}

/**
 * The view of one session as the chat draws it, whatever carries the session
 * to it: the extension host's in-process Session, or a daemon's socket through
 * {@link DaemonSessionStream}. Both reduce to the same three inputs, a message
 * in order, a snapshot of what the session holds, and a saved conversation to
 * redraw from, so a webview cannot tell which host it is in.
 */
export class SessionView {
  /** The planner conversation; a host's own notices and prompt hold go to it directly. */
  readonly conversation: ConversationViewHost;
  /** The run; a host that ends a run on its own resets it directly. */
  readonly run: RunViewHost;

  constructor(private readonly post: (msg: HostToWebview) => void) {
    this.conversation = new ConversationViewHost(post);
    this.run = new RunViewHost(post);
  }

  receive(msg: SessionMessage): SessionCue | null {
    this.conversation.receive(msg);
    // Worded before the run folds the message in: a start the run already
    // shows is a duplicate, and only the run as it stood can tell. The wording
    // is core's, so the terminal says the same (ADR-0017). There is a button to
    // approve a plan here, so the sign-off line has nothing to point at.
    const notice = runNotice(msg, this.run.current);
    if (notice !== null) this.conversation.note('system', notice);
    // Every message feeds the run view too: the card badges, isolation marks
    // and merge and handoff cards are drawn from it, not from the plan.
    this.run.receive(msg);
    switch (msg.type) {
      case 'approval_request':
        return { type: 'reveal' };
      // Runner chatter was once dropped, so a task that failed mid-run showed
      // a red card and nothing else. The webview keeps only the tail.
      case 'task_output':
        this.post({ type: 'taskOutput', taskId: msg.taskId, text: msg.text });
        return null;
      case 'task_started':
        this.post({ type: 'taskCommands', taskId: msg.taskId, commands: [] });
        return null;
      // The run view holds each task's status already; the dock reads a
      // plan-level one, which is the host's to keep.
      case 'status_update':
        return { type: 'plan', dock: 'run' };
      // The Session changes the plan itself (a live turn's edits, a run
      // setting) and announces the result; the card follows it.
      case 'plan_generated':
      case 'review_needed':
        return { type: 'plan' };
      case 'execution_complete':
        return { type: 'settled' };
      // A Stop can come from another surface while this one still shows a
      // starting plan: the run's own word clears it.
      case 'execution_stopped':
        return { type: 'settled', dock: 'draft' };
      case 'isolation_blocked':
        return { type: 'confirm', request: isolationBlockedConfirmation(msg.message) };
      case 'task_log':
        return msg.events.some((event) => event.type === 'runner_loaded') ? { type: 'commands', taskId: msg.taskId } : null;
      // Drawn by the conversation or the run view above, or not by a chat at
      // all. Named so a new variant fails to compile until someone decides
      // what it means here.
      case 'checkpoint':
      case 'isolation_handoff':
      case 'isolation_merge':
      case 'run_closed':
      case 'planner_message':
      case 'plan_token':
      case 'planner_text_delta':
      case 'planner_thinking_delta':
      case 'planner_liveness':
      case 'research_step':
      case 'research_step_done':
      case 'review_approved':
      case 'task_updated':
      case 'planner_turn_started':
      case 'planner_skill_loaded':
      case 'planner_turn_ended':
      case 'planner_text_retracted':
      case 'planner_usage':
      case 'planner_compaction':
      case 'planner_detection':
      case 'subagent_started':
      case 'subagent_finished':
      case 'approval_settled':
      case 'approval_decided':
      case 'execution_action':
        return null;
      default: {
        const exhaustive: never = msg;
        return exhaustive;
      }
    }
  }

  /**
   * The run is taken whole rather than replayed, so a task blocked on a
   * runner approval, which no later message would announce, is drawn at once.
   * A request still waiting is put back on the conversation, which a reload
   * drew from a transcript that keeps no approval card.
   */
  adopt({ run, approvals }: SessionSnapshot): void {
    if (approvals) this.conversation.waiting(approvals);
    this.run.adopt(run);
  }

  /** The conversation as a saved session's records draw it, for a view that holds none of the stream before now. */
  reload(saved: SavedConversation): void {
    this.conversation.reload(saved);
  }
}
