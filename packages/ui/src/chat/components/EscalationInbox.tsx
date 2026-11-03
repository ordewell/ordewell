import React, { useEffect, useId, useRef, useState } from 'react';
import type { Escalation, EscalationOption } from '@ordewell/core';
import { taskLabel, type EscalationAnswers } from './escalationAnswers';

interface EscalationInboxProps {
  escalations: readonly Escalation[];
  /** The answers in flight and the refusals: held above, so a refusal outlives its entry. */
  answers: EscalationAnswers;
  /** The list is open rather than its control alone. Held above, remembered across reloads. */
  open: boolean;
  onToggle: () => void;
  onOpenTask: (taskId: string) => void;
}

/** An answer in the making: an option that asks a question or takes a note waits for them before it is sent. */
interface Drafting {
  escalationId: string;
  option: EscalationOption;
}

/**
 * What waits on the user (ADR-0053): a small control at the right end of the
 * usage line, and the list as a dropdown upward from it, over the conversation,
 * so it takes no room from the composer. The list is closed with `hidden`, never
 * unmounted, so an answer being written survives a collapse. Nothing is kept
 * here but that answer: the list itself is the host's, replaced whole on every
 * update, so an entry leaves the moment its wait does.
 */
export default function EscalationInbox({ escalations, answers, open, onToggle, onOpenTask }: EscalationInboxProps) {
  const [drafting, setDrafting] = useState<Drafting | null>(null);
  const [note, setNote] = useState('');
  const barRef = useRef<HTMLButtonElement>(null);
  const listId = useId();
  const { sending, refusals } = answers;

  // A draft belongs to an escalation that may end under it: nothing is left to answer then.
  useEffect(() => {
    if (drafting && !escalations.some((e) => e.id === drafting.escalationId)) setDrafting(null);
  }, [escalations, drafting]);

  // Esc closes an open question first (the form marks its own), then the list.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      e.preventDefault();
      onToggle();
      barRef.current?.focus();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, onToggle]);

  if (escalations.length === 0 && refusals.length === 0) return null;

  const send = (escalation: Escalation, option: EscalationOption, text: string, confirmed: boolean) => {
    setDrafting(null);
    setNote('');
    answers.answer(escalation, option, text, confirmed);
  };

  const choose = (escalation: Escalation, option: EscalationOption) => {
    if (option.confirm || option.note) {
      setNote('');
      setDrafting({ escalationId: escalation.id, option });
      return;
    }
    send(escalation, option, '', false);
  };

  const count = escalations.length > 0 ? `${escalations.length} waiting` : `${refusals.length} not done`;

  return (
    <section className="escalation-inbox" aria-label="Waiting on you">
      <button
        ref={barRef}
        type="button"
        className="escalation-inbox-bar"
        // The visible words lead the name, so a voice command for the label still finds it.
        aria-label={escalations.length > 0 ? `${count} on you` : count}
        aria-expanded={open}
        aria-controls={listId}
        onClick={onToggle}
      >
        <span className="escalation-inbox-count">{count}</span>
        <span className={`escalation-inbox-chevron${open ? '' : ' collapsed'}`} aria-hidden="true">
          <svg width="9" height="9" viewBox="0 0 11 11" fill="none">
            <path d="M2 4L5.5 7.5L9 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
      </button>
      <div id={listId} className="escalation-inbox-body" hidden={!open}>
        {refusals.map((refusal) => (
          <div key={refusal.key} className="escalation-refusal" role="alert">
            <span className="escalation-refusal-text"><strong>Not done — {refusal.title}.</strong> {refusal.message}</span>
            <button
              type="button"
              className="task-log-open-btn"
              aria-label={`Dismiss: ${refusal.title}`}
              onClick={() => answers.dismiss(refusal.key)}
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
