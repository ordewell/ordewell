import React, { useState, useEffect } from 'react';
import { truncateCheckpointSummary } from '@ordewell/core/plan-utils';

interface CheckpointPanelProps {
  taskTitle: string;
  summary: string;
  pausedAt: number;
  /** A delegated task's question: its approval can carry the answer's words and a raise of its budget (ADR-0056 M5, M8). */
  delegated?: boolean;
  /** Off for a person answering inside a child plan: no raise reaches a child's control (ADR-0055 D20). */
  raisable?: boolean;
  /**
   * What the form holds, when the caller keeps it: a form that comes back finds
   * its words, whatever unmounted it. Without one the form keeps its own.
   */
  draft?: CheckpointDraft;
  onDraft?: (draft: CheckpointDraft) => void;
  onApprove: (words?: string, raiseTokens?: number) => void;
  onReject: (reason: string) => void;
}

/** What a person has typed into the form: an approval's words, a rejection's reason, and which of the two is open. */
export interface CheckpointDraft {
  words: string;
  reason: string;
  rejecting: boolean;
}

const NOT_A_RAISE = 'A raise is a whole number of tokens, 1 or more.';

/** The raise as typed: undefined for none, null for what is no number of tokens. */
function raiseOf(text: string): number | undefined | null {
  const typed = text.trim();
  if (!typed) return undefined;
  const tokens = Number(typed);
  return Number.isSafeInteger(tokens) && tokens >= 1 ? tokens : null;
}

const TIMEOUT_MINUTES = 3;

export default function CheckpointPanel({ taskTitle, summary, pausedAt, delegated = false, raisable = true, draft, onDraft, onApprove, onReject }: CheckpointPanelProps) {
  const [own, setOwn] = useState<CheckpointDraft>({ words: '', reason: '', rejecting: false });
  const { words, reason, rejecting: showRejectInput } = draft ?? own;
  const write = (patch: Partial<CheckpointDraft>) => {
    const next = { words, reason, rejecting: showRejectInput, ...patch };
    setOwn(next);
    onDraft?.(next);
  };
  const [elapsed, setElapsed] = useState(0);
  const [showFull, setShowFull] = useState(false);
  const [raise, setRaise] = useState('');
  const raiseTokens = raiseOf(raise);

  useEffect(() => {
    const tick = () => setElapsed(Math.floor((Date.now() - pausedAt) / 60000));
    tick();
    const interval = setInterval(tick, 10000);
    return () => clearInterval(interval);
  }, [pausedAt]);

  const isTimeout = elapsed >= TIMEOUT_MINUTES;
  const fullSummary = summary.trim();
  const preview = truncateCheckpointSummary(summary);
  const truncated = preview !== fullSummary;

  return (
    <div className={`checkpoint-panel ${isTimeout ? 'checkpoint-timeout' : ''}`}>
      <div className="checkpoint-header">
        <span className="checkpoint-icon">&#9878;</span>
        <span className="checkpoint-title">HITL Checkpoint</span>
        <span className="checkpoint-elapsed">
          Paused {elapsed}m
          {isTimeout && <span className="checkpoint-timeout-badge">AWAITING INPUT</span>}
        </span>
      </div>
      <div className="checkpoint-task">Task: {taskTitle}</div>
      <div className="checkpoint-summary-block">
        <div className="checkpoint-summary" title={summary}>
          {showFull ? fullSummary : preview}
        </div>
        {truncated && (
          <button
            type="button"
            className="checkpoint-summary-toggle"
            aria-expanded={showFull}
            onClick={() => setShowFull((v) => !v)}
          >
            {showFull ? 'Show less' : 'Show full'}
          </button>
        )}
      </div>

      {delegated && !showRejectInput && (
        <div className="checkpoint-delegated">
          <label>
            Your answer
            <textarea value={words} onChange={(e) => write({ words: e.target.value })} placeholder="What it asked, answered (optional)" rows={2} />
          </label>
          {raisable && (
            <label>
              Raise its budget by (tokens)
              <input type="text" inputMode="numeric" value={raise} onChange={(e) => setRaise(e.target.value)} placeholder="none" />
            </label>
          )}
          {raiseTokens === null && <div className="checkpoint-delegated-error" role="alert">{NOT_A_RAISE}</div>}
        </div>
      )}

      {!showRejectInput ? (
        <div className="checkpoint-actions">
          <button className="checkpoint-approve-btn" disabled={raiseTokens === null} onClick={() => (delegated ? onApprove(words.trim() || undefined, raiseTokens ?? undefined) : onApprove())}>
            Approve &amp; Continue
          </button>
          <button className="checkpoint-reject-btn" onClick={() => write({ rejecting: true })}>
            Reject
          </button>
        </div>
      ) : (
        <div className="checkpoint-reject-form">
          <textarea
            value={reason}
            onChange={(e) => write({ reason: e.target.value })}
            placeholder="Why are you rejecting this checkpoint?"
            rows={2}
            autoFocus
          />
          <div className="checkpoint-reject-actions">
            <button onClick={() => onReject(reason)} disabled={!reason.trim()}>
              Send Rejection
            </button>
            <button className="cancel-btn" onClick={() => write({ rejecting: false })}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
