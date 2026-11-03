import React, { useState, useEffect, useMemo } from 'react';
import { ConversationBlocks } from '../chat/components/ChatMessage';
import { OpenPatchContext } from '../chat/openPatch';
import { useFollowOutput } from '../chat/followOutput';
import { contextMeterText, contextMeterTitle, hasAccountLimits, taskActivity } from '@ordewell/core/plan-utils';
import { applyConversationPatch, EMPTY_PATCHED_VIEW, patchedBlocks, type PatchedView } from '../shared/conversationPatch';
import type { HostToTaskLog, TaskLogStatus } from '../shared/taskLogProtocol';
import { useTaskLogBridge } from '../bridge';
import { taskCommand, useRunnerCommands } from '../chat/components/RunnerCommands';
import ElapsedTime from '../chat/components/ElapsedTime';
import AccountLimitRows from '../chat/components/AccountLimitRows';
import PendingMessages, { QUEUE_TITLE, SendKeyHint, isSendNowKey, type PendingMessage } from '../chat/components/PendingMessages';
import type { AccountLimitSnapshot, TaskActivity, TaskLogHeaderUsage, TaskLogHeaderView } from '@ordewell/core';

/**
 * One row of the log header's usage: its context, the runner's live limits,
 * then its cost, as the TUI draws them. Only the last row — the task total
 * under a past attempt's own numbers — takes the limits, so a past attempt
 * keeps its row as it was. The row is cut where core's meter ends, and each
 * side is its own live region since the limits between them are not one.
 */
function UsageRow({ row, total, limits }: { row: TaskLogHeaderUsage; total: boolean; limits: readonly AccountLimitSnapshot[] }) {
  const meter = contextMeterText(row.contextFill);
  const at = meter ? row.text.indexOf(meter) : -1;
  const context = meter && at >= 0 ? row.text.slice(0, at + meter.length) : '';
  const rest = row.text.slice(context.length).replace(/^ · /, '');
  return (
    <div className={total ? 'usage-line usage-line-total' : 'usage-line'}>
      {context && <span className="usage-line-measures" role="status" title={row.contextFill && contextMeterTitle(row.contextFill)}>{context}</span>}
      {context && limits.length > 0 && ' · '}
      <AccountLimitRows limits={limits} />
      {(context || limits.length > 0) && rest && ' · '}
      {rest && <span className="usage-line-measures" role="status">{rest}</span>}
    </div>
  );
}

function noop(): void {}

const STOP_ARM_MS = 2_000;

/** How a header state is painted: the CSS class each kind shares, decided beside the markup that uses it. */
const STATE_CLASS: Record<TaskLogHeaderView['state']['kind'], string> = {
  done: 'done',
  failed: 'failed',
  skipped: 'idle',
  blocked: 'waiting',
  awaiting: 'waiting',
  checkpoint: 'checkpoint',
  approval: 'approval',
  running: 'working',
  quiet: 'waiting',
  todo: 'idle',
};

/**
 * One structured task's log (ADR-0018, V1), in its own editor tab. It draws
 * the same display blocks as the planner chat through the same components and
 * stylesheet, and adds what only a task has: a live-state header, a message
 * box that also stops the turn, the pending messages, and an attempt switcher. The host
 * reduces the log and patches blocks in; nothing here knows the event format.
 */
export default function TaskLogApp({ composerLabel }: {
  /** Who a message goes to, as a surface names it: the composer's accessible name and its placeholder's start. */
  composerLabel?: string;
} = {}) {
  const bridge = useTaskLogBridge();
  const [view, setView] = useState<PatchedView>(EMPTY_PATCHED_VIEW);
  const [status, setStatus] = useState<TaskLogStatus | null>(null);
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [stopArmed, setStopArmed] = useState(false);
  const [limits, setLimits] = useState<readonly AccountLimitSnapshot[]>([]);

  const blocks = useMemo(() => patchedBlocks(view), [view]);
  const followRef = useFollowOutput<HTMLDivElement>([blocks]);
  const header = status?.header;
  const shownLimits = limits.filter(hasAccountLimits);
  const state = header?.state;
  // A child takes a person's words and nothing else (ADR-0056 M8), so nothing here may read as a runner command.
  const child = status?.child;
  const commands = child ? [] : header?.commands ?? [];
  const completion = useRunnerCommands(text, setText, commands);
  const canSend = text.trim().length > 0;

  useEffect(() => {
    const handler = (msg: HostToTaskLog) => {
      switch (msg.type) {
        case 'init':
          // A reload restores this tab by task id, so the id has to outlive the
          // webview's own memory; a child's tab by the child's too, proved
          // against the tree when it comes back.
          bridge.setState({ taskId: msg.status.taskId, ...(msg.status.child ? { childId: msg.status.child.id } : {}) });
          setView(applyConversationPatch(EMPTY_PATCHED_VIEW, {
            type: 'conversationPatch',
            order: msg.blocks.map((b) => b.id),
            changed: msg.blocks,
          }));
          setStatus(msg.status);
          setError('');
          break;
        case 'patch':
          setView((prev) => applyConversationPatch(prev, {
            type: 'conversationPatch',
            order: msg.order,
            changed: msg.changed,
          }));
          break;
        case 'status':
          setStatus(msg.status);
          break;
        case 'accountLimits':
          setLimits(msg.limits);
          break;
        case 'showError':
          setError(msg.error);
          if (msg.draft) { const draft = msg.draft; setText((current) => current.trim() ? current : draft); }
          break;
      }
    };
    const unsubscribe = bridge.subscribe(handler);
    bridge.post({ type: 'ready' });
    return unsubscribe;
  }, [bridge]);

  // A finished task has no turn to message: its box continues it instead, and
  // one paused on a usage limit is resumed by it.
  const continues = !child && header?.continuable === true;
  const resumes = !child && header?.resumable === true;
  // A script task runs no model (ADR-0035): its log is output only.
  const script = status?.script === true;

  const send = (): void => {
    const value = text.trim();
    if (!value) return;
    try {
      const command = taskCommand(value, commands);
      if (command && !continues) {
        bridge.post({ type: 'invokeTaskCommand', ...command });
        setText('');
        return;
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return;
    }
    bridge.post(continues ? { type: 'continueTask', text: value } : { type: 'sendTaskMessage', text: value });
    setText('');
  };

  const working = header?.working === true && state?.kind !== 'done' && state?.kind !== 'failed';
  // Force send (ADR-0023, F1) needs a turn to interrupt; a finished task's box continues it instead.
  const canSendNow = !child && working && canSend && !continues && !(commands.length > 0 && text.trim().startsWith('/'));

  const sendNow = (): void => {
    const value = text.trim();
    if (!value) return;
    bridge.post({ type: 'sendTaskMessageNow', text: value });
    setText('');
  };

  const pending = useMemo((): PendingMessage[] => (status?.queued ?? []).map((m) => ({
    key: m.id,
    text: m.text,
    state: m.forced ? 'sending' : m.handedOver ? 'waiting' : 'queued',
    onSendNow: m.forced || child ? undefined : () => bridge.post({ type: 'sendQueuedTaskMessageNow', id: m.id }),
    onRemove: m.forced || m.handedOver || child ? undefined : () => bridge.post({ type: 'removeQueuedTaskMessage', id: m.id }),
  })), [status?.queued, child]);

  // The pairing is what keeps a stray tap from interrupting a turn, so an arm
  // lapses on its own, and never outlives the turn it was aimed at.
  useEffect(() => {
    if (!stopArmed) return;
    if (!working) {
      setStopArmed(false);
      return;
    }
    const timer = setTimeout(() => setStopArmed(false), STOP_ARM_MS);
    return () => clearTimeout(timer);
  }, [stopArmed, working]);

  const onComposerKeyDown = (e: React.KeyboardEvent): void => {
    if (e.nativeEvent.isComposing || completion.keyDown(e)) return;
    if (e.key === 'Escape' && working && !child) {
      e.preventDefault();
      if (stopArmed) {
        setStopArmed(false);
        bridge.post({ type: 'interruptTask' });
      } else {
        setStopArmed(true);
      }
      return;
    }
    if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return;
    e.preventDefault();
    if (isSendNowKey(e) && canSendNow) sendNow();
    else send();
  };

  // Spinner only while a turn is open, or a subagent outlives it; a quiet task's line is the static marker.
  const activity = ((): TaskActivity | null => {
    if (!status || !header) return null;
    const archived = status.attempts.length > 0 && status.attempt < Math.max(...status.attempts);
    return taskActivity({ blocks, turnStartedAt: status.turnStartedAt ?? undefined, working: header.working, lastTurnEnd: status.lastTurnEnd ?? undefined, archived }, { status: status.taskStatus, idleSince: status.idleSince, awaitingApproval: state?.kind === 'approval' ? 1 : 0 });
  })();

  // One button, as in the planner's composer: Stop only while a turn is live
  // and nothing is typed, so typing a message always turns it back into Send.
  const stops = !script && !child && working && !canSend;
  const sendLabel = resumes ? 'Resume' : continues ? 'Continue' : 'Send';

  return (
    <OpenPatchContext.Provider value={(path) => bridge.post({ type: 'openFile', path })}>
    <div className="task-log-container">
      {status && (
        <div className="task-log-header">
          <span className="task-log-title">Task {status.orderLabel ?? status.order} · {status.title}</span>
          {status.runner && <span className="task-log-runner">{status.runner}</span>}
          {state && <span className={`task-log-state ${STATE_CLASS[state.kind]}`}>{state.label}</span>}
          {header?.resumes && <span className="task-log-runner">{header.resumes}</span>}
          {resumes && (
            <button type="button" className="task-log-detail" onClick={() => bridge.post({ type: 'resumeNow' })}
              title="The limit has reset: resume it in its saved session now">
              Resume now
            </button>
          )}
          {!child && header?.resumes && (
            <button type="button" className="task-log-detail" onClick={() => bridge.post({ type: 'cancelResume' })}
              title="Keep it from resuming on its own: resume or retry it yourself once the limit resets">
              Don't resume
            </button>
          )}
          <span className="task-log-spacer" />
          {status.attempts.length > 1 && (
            <label className="task-log-attempt">
              Attempt
              <select value={status.attempt} onChange={(e) => bridge.post({ type: 'selectAttempt', attempt: Number(e.target.value) })}>
                {status.attempts.map((attempt) => <option key={attempt} value={attempt}>{attempt}</option>)}
              </select>
            </label>
          )}
        </div>
      )}

      {error && (
        <div className="task-log-error" role="alert">
          <span>{error}</span>
          <button type="button" onClick={() => setError('')}>Dismiss</button>
        </div>
      )}

      {/* Keyed by attempt so a switched-to attempt opens at its newest output, with nothing of another attempt's open. */}
      <div className="task-log-body" key={status?.attempt} ref={followRef}>
        {blocks.length === 0
          ? <div className="task-log-empty">{working ? 'Working…' : 'No output yet.'}</div>
          : <ConversationBlocks blocks={blocks} asRun={script} onShowPlan={noop}
              onAnswerApproval={child ? undefined : (id, decision) => bridge.post({ type: 'answerApproval', id, decision })} />}
      </div>

      {activity && (
        <div className={`task-log-activity${activity.busy ? '' : ' quiet'}`} role="status">
          {activity.busy ? <span className="chat-msg-spinner" aria-hidden="true" /> : <span className="task-log-activity-mark" aria-hidden="true">~</span>}
          <span className="task-log-activity-label">{activity.label}</span>
          <ElapsedTime since={activity.since} className="task-log-activity-time" />
        </div>
      )}

      {header?.usage.map((row, i, rows) => (
        <UsageRow key={i} row={row} total={i > 0} limits={i === rows.length - 1 ? shownLimits : []} />
      ))}

      {!header?.usage.length && shownLimits.length > 0 && <div className="usage-line"><AccountLimitRows limits={shownLimits} /></div>}

      {stopArmed && <div className="stop-hint" role="status">Press Esc again to stop</div>}

      {!script && <PendingMessages messages={pending} />}

      {child?.note ? <div className="task-log-readonly" role="note">{child.note}</div> : script ? (
        <div className="task-log-readonly" role="note">
          This script task runs no model, so it takes no messages. Its output is above.
        </div>
      ) : (
        <div className="task-log-composer">
          {completion.palette}
          <textarea className="task-log-input" value={text} rows={2} aria-label={composerLabel}
            placeholder={`${composerLabel ? `${composerLabel}: ` : ''}${resumes ? 'The limit has reset? A message to resume it with…' : continues ? 'Continue the task in its saved session…' : 'Message the task…'} (Enter to send, Shift+Enter for a new line)`}
            onChange={(e) => completion.change(e.target.value)} onKeyDown={onComposerKeyDown} />
          <button type="button" className={`send-btn${stops ? ' processing' : ''}`}
            disabled={!stops && !canSend}
            title={stops ? 'Interrupt (Esc Esc)' : canSendNow ? QUEUE_TITLE : `${sendLabel} (Enter)`} aria-label={stops ? 'Interrupt' : sendLabel}
            onClick={stops ? () => bridge.post({ type: 'interruptTask' }) : send}>
            {stops ? (
              <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
                <rect x="0" y="0" width="12" height="12" rx="2" />
              </svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M2 8L14 2L8 14L6.5 9.5L2 8Z" fill="currentColor" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
              </svg>
            )}
          </button>
          {canSendNow && <SendKeyHint />}
        </div>
      )}
    </div>
    </OpenPatchContext.Provider>
  );
}
