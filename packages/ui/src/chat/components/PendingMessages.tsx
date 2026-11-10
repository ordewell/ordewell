import React from 'react';

/** Where a message typed during a turn stands (ADR-0023). */
export type PendingState = 'queued' | 'waiting' | 'sending';

export interface PendingMessage {
  key: string;
  text: string;
  state: PendingState;
  /** Absent when it cannot be taken back, e.g. the runner already has it. */
  onRemove?: () => void;
  /** The ×'s tooltip, when removing it has a shortcut of its own. */
  removeTitle?: string;
}

const STATE_LABEL: Record<PendingState, string> = {
  queued: 'queued',
  waiting: 'waiting for the current step',
  sending: 'sending now…',
};

const STATE_TITLE: Record<PendingState, string> = {
  queued: 'Sent when the running turn ends',
  waiting: 'The runner has this message and reads it after its current step',
  sending: 'Goes as soon as the running step is interrupted',
};

// Webviews run in the host's own Electron, so its user agent names the platform.
const MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent);

// Key labels as VS Code draws its own: symbols on macOS, where the system font
// has them, words elsewhere, where a ⏎ at hint size reads as a speck.
const ENTER_KEY = MAC ? '⏎' : 'Enter';

/** The send-now chord, as drawn in a key hint and as named in a tooltip. */
export const SEND_NOW_KEY = { glyph: MAC ? '⌘⏎' : 'Ctrl+Enter', name: MAC ? 'Cmd+Enter' : 'Ctrl+Enter' };

export const isSendNowKey = (e: React.KeyboardEvent): boolean =>
  e.key === 'Enter' && !e.shiftKey && (e.ctrlKey || e.metaKey);

/**
 * The Send button's tooltip while Enter queues: it names the other key too,
 * Ctrl+Enter, or Cmd+Enter on macOS, which sends everything queued and what is
 * typed, as one message.
 */
export const QUEUE_TITLE = `Queue (Enter) · Send all now (${SEND_NOW_KEY.name})`;

/**
 * The composer's key hint while a turn runs: Enter queues what is typed, the
 * chord interrupts the turn and sends everything queued with the typed text
 * last. It stands in for a second button. `held` is the empty composer's form,
 * where Enter has nothing to queue and only the chord applies. The wording is
 * the TUI's: "send all now".
 */
export function SendKeyHint({ held = false }: { held?: boolean }) {
  if (held) {
    return (
      <div className="send-key-hint">
        <kbd>{SEND_NOW_KEY.glyph}</kbd> send all now
      </div>
    );
  }
  return (
    <div className="send-key-hint">
      <kbd>{ENTER_KEY}</kbd> queue · <kbd>{SEND_NOW_KEY.glyph}</kbd> send all now
    </div>
  );
}

/**
 * Messages typed while a turn runs and not yet read, oldest first, drawn as a
 * compact stack above the composer in the user bubble's shape. Each shows
 * where it stands; its remove surfaces on hover or focus. They go as one
 * message, so one "Send all now" after the last row serves the stack, and the
 * send-now chord works on whichever row holds focus, as it does in the
 * composer. The planner chat and a task's chat draw the same stack.
 */
export default function PendingMessages({ messages, onSendAllNow }: { messages: readonly PendingMessage[]; onSendAllNow?: () => void }) {
  if (messages.length === 0) return null;
  return (
    <ul className="pending-messages" aria-label="Pending messages">
      {messages.map((m) => (
        <li key={m.key} className={`pending-message ${m.state}`}
          onKeyDown={(e) => {
            if (!isSendNowKey(e) || !onSendAllNow) return;
            e.preventDefault();
            onSendAllNow();
          }}>
          <div className="pending-message-text" title={m.text}>{m.text}</div>
          <div className="pending-message-meta">
            <span className="pending-message-state" title={STATE_TITLE[m.state]}>{STATE_LABEL[m.state]}</span>
            <span className="pending-message-actions">
              {m.onRemove && (
                <button type="button" className="pending-message-remove" onClick={m.onRemove}
                  title={m.removeTitle ?? 'Remove this message'} aria-label={`Remove pending message: ${m.text}`}>
                  ×
                </button>
              )}
            </span>
          </div>
        </li>
      ))}
      {onSendAllNow && (
        <li className="pending-messages-actions">
          <button type="button" className="pending-messages-now" onClick={onSendAllNow}
            title={`Interrupt the running turn and send everything queued now, as one message (${SEND_NOW_KEY.name})`}>
            Send all now <kbd aria-hidden="true">{SEND_NOW_KEY.glyph}</kbd>
          </button>
        </li>
      )}
    </ul>
  );
}
