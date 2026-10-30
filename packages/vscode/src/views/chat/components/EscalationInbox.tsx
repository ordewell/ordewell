import React, { useEffect, useId, useRef, useState } from 'react';
import type { Escalation, EscalationOption } from '@ordewell/core';
import type { EscalationAnswer, HostToWebview } from '../../../shared/protocol';

interface EscalationInboxProps {
  escalations: readonly Escalation[];
  /** Sends the answer to the host; its verdict comes back as an `escalationAnswered` message. */
  onAnswer: (answer: EscalationAnswer) => void;
  onOpenTask: (taskId: string) => void;
}

/** An answer in the making: an option that asks a question or takes a note waits for them before it is sent. */
interface Drafting {
  escalationId: string;
  option: EscalationOption;
}

/** A refusal is kept apart from the list: a stale entry has left it by the time the host says so. */
interface Refusal {
  key: number;
  title: string;
  message: string;
}

const taskLabel = (e: Escalation): string => (e.task ? `${e.task.ref} ${e.task.title}` : 'This run');

/**
 * What waits on the user (ADR-0053), drawn from the run view's list. Nothing is
 * kept here but the answer being written, the answers in flight and the
 * refusals: the list itself is the host's, replaced whole on every update, so
 * an entry leaves the moment its wait does.
 */
export default function EscalationInbox({ escalations, onAnswer, onOpenTask }: EscalationInboxProps) {
  const [open, setOpen] = useState(true);
  const [drafting, setDrafting] = useState<Drafting | null>(null);
  const [note, setNote] = useState('');
  const [sending, setSending] = useState<ReadonlyMap<string, string>>(new Map());
  const [refusals, setRefusals] = useState<Refusal[]>([]);
  const requests = useRef(new Map<string, { escalation: Escalation; option: EscalationOption }>());
  const nextRequest = useRef(0);
  const nextRefusal = useRef(0);
  const listId = useId();

  useEffect(() => {
    const onMessage = (event: MessageEvent<HostToWebview>) => {
      const msg = event.data;
      if (msg?.type !== 'escalationAnswered') return;
      const request = requests.current.get(msg.requestId);
      if (!request) return;
      requests.current.delete(msg.requestId);
      setSending((prev) => {
        const next = new Map(prev);
        next.delete(request.escalation.id);
        return next;
      });
      if (msg.ok) return;
      setRefusals((prev) => [...prev, {
        key: nextRefusal.current++,
        title: `${request.option.label}: ${taskLabel(request.escalation)}`,
        message: msg.message,
      }]);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  // A draft belongs to an escalation that may end under it: nothing is left to answer then.
  useEffect(() => {
    if (drafting && !escalations.some((e) => e.id === drafting.escalationId)) setDrafting(null);
  }, [escalations, drafting]);

  if (escalations.length === 0 && refusals.length === 0) return null;

  const send = (escalation: Escalation, option: EscalationOption, text: string, confirmed: boolean) => {
    const requestId = `${listId}-${nextRequest.current++}`;
    requests.current.set(requestId, { escalation, option });
    setSending((prev) => new Map(prev).set(escalation.id, option.label));
    setDrafting(null);
    setNote('');
    onAnswer({ requestId, id: escalation.id, option: option.id, ...(text.trim() ? { note: text.trim() } : {}), ...(confirmed ? { confirmed: true } : {}) });
  };

  const choose = (escalation: Escalation, option: EscalationOption) => {
    if (option.confirm || option.note) {
      setNote('');
      setDrafting({ escalationId: escalation.id, option });
      return;
    }
    send(escalation, option, '', false);
  };

  return (
    <section className="escalation-inbox" aria-label="Waiting on you">
      <button
        type="button"
        className="escalation-inbox-bar"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((v) => !v)}
      >
        <span className={`plan-dock-chevron${open ? '' : ' collapsed'}`} aria-hidden="true">
          <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
            <path d="M2 4L5.5 7.5L9 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
        <span className="escalation-inbox-count">{escalations.length} waiting on you</span>
      </button>
      <div id={listId} className="escalation-inbox-body" hidden={!open}>
        {refusals.map((refusal) => (
          <div key={refusal.key} className="escalation-refusal" role="alert">
            <span className="escalation-refusal-text"><strong>Not done — {refusal.title}.</strong> {refusal.message}</span>
            <button
              type="button"
              className="task-log-open-btn"
              aria-label={`Dismiss: ${refusal.title}`}
              onClick={() => setRefusals((prev) => prev.filter((r) => r.key !== refusal.key))}
            >
              Dismiss
            </button>
          </div>
        ))}
        <ul className="escalation-list">
          {escalations.map((escalation) => {
            const busy = sending.get(escalation.id);
            const writing = drafting?.escalationId === escalation.id ? drafting.option : null;
            const who = taskLabel(escalation);
            return (
              <li key={escalation.id} className="escalation-entry" aria-busy={busy !== undefined}>
                <div className="escalation-entry-head">
                  <span className="escalation-entry-task">{who}</span>
                  {escalation.task && (
                    <button
                      type="button"
                      className="task-log-open-btn"
                      aria-label={`Open task ${who}`}
                      onClick={() => onOpenTask(escalation.task!.id)}
                    >
                      Open task
                    </button>
                  )}
                </div>
                <div className="escalation-entry-reason">{escalation.reason}</div>
                {busy !== undefined ? (
                  <div className="escalation-entry-sending" role="status">Sending: {busy}&hellip;</div>
                ) : writing ? (
                  <form
                    className="escalation-entry-form"
                    // Esc closes an open question first (the same rule the task cards keep), so it does not also reach the app's Esc handlers.
                    onKeyDown={(e) => {
                      if (e.key !== 'Escape') return;
                      e.preventDefault();
                      setDrafting(null);
                    }}
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (writing.note === 'required' && !note.trim()) return;
                      send(escalation, writing, note, true);
                    }}
                  >
                    {writing.confirm && <p className="escalation-entry-confirm">{writing.confirm}</p>}
                    {writing.note && (
                      <label className="escalation-entry-note">
                        <span>{writing.note === 'required' ? 'Note (required)' : 'Note (optional)'}</span>
                        <textarea value={note} rows={2} autoFocus onChange={(e) => setNote(e.target.value)} />
                      </label>
                    )}
                    <span className="escalation-entry-actions">
                      <button type="submit" className="task-action-btn run" autoFocus={!writing.note} disabled={writing.note === 'required' && !note.trim()}>
                        {writing.confirm ? `Yes, ${writing.label}` : writing.label}
                      </button>
                      <button type="button" className="task-log-open-btn" onClick={() => setDrafting(null)}>Cancel</button>
                    </span>
                  </form>
                ) : (
                  <span className="escalation-entry-actions">
                    {escalation.options.map((option) => (
                      <button
                        key={option.id}
                        type="button"
                        className="task-log-open-btn"
                        aria-label={`${option.label}: ${who}`}
                        onClick={() => choose(escalation, option)}
                      >
                        {option.label}
                      </button>
                    ))}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
