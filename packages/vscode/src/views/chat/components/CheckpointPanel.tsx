import React, { useState, useEffect } from 'react';

interface CheckpointPanelProps {
  taskTitle: string;
  summary: string;
  pausedAt: number;
  onApprove: () => void;
  onReject: (reason: string) => void;
}

const TIMEOUT_MINUTES = 3;

export default function CheckpointPanel({ taskTitle, summary, pausedAt, onApprove, onReject }: CheckpointPanelProps) {
  const [reason, setReason] = useState('');
  const [showRejectInput, setShowRejectInput] = useState(false);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const tick = () => setElapsed(Math.floor((Date.now() - pausedAt) / 60000));
    tick();
    const interval = setInterval(tick, 10000);
    return () => clearInterval(interval);
  }, [pausedAt]);

  const isTimeout = elapsed >= TIMEOUT_MINUTES;

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
      <div className="checkpoint-summary">{summary}</div>

      {!showRejectInput ? (
        <div className="checkpoint-actions">
          <button className="checkpoint-approve-btn" onClick={onApprove}>
            Approve &amp; Continue
          </button>
          <button className="checkpoint-reject-btn" onClick={() => setShowRejectInput(true)}>
            Reject
          </button>
        </div>
      ) : (
        <div className="checkpoint-reject-form">
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Why are you rejecting this checkpoint?"
            rows={2}
            autoFocus
          />
          <div className="checkpoint-reject-actions">
            <button onClick={() => onReject(reason)} disabled={!reason.trim()}>
              Send Rejection
            </button>
            <button className="cancel-btn" onClick={() => setShowRejectInput(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
