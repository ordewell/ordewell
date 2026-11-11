import { useEffect, useRef, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { Button } from '@ordewell/ui/design';
import type { ConfirmationRequest } from '@ordewell/ui/host';
import './confirm.css';

/**
 * A confirmation, with a kind this window may name beyond ui's own: the
 * checkout's and the Git view's questions are asked only here, and ui's
 * words are not theirs to decide.
 */
export type WindowConfirmation<C extends string> = Omit<ConfirmationRequest<C>, 'kind'> & {
  kind: string;
  /** The first choice destroys something: it is drawn in the failure colour, and focus still starts on Cancel (checklist A4). */
  destructive?: boolean;
  /** What the dismissing button says when "Cancel" would mislead: a refusal is closed, not cancelled. */
  cancelLabel?: string;
};

/** ui's own confirmations whose yes cannot be undone from the window. */
const DESTRUCTIVE_KINDS: ReadonlySet<string> = new Set(['remove_task', 'revert_task', 'discard_run', 'discard_changes']);

interface DialogProps<C extends string> {
  request: WindowConfirmation<C>;
  body?: ReactNode;
  answer(choice: C | null): void;
}

function ConfirmDialog<C extends string>({ request, body, answer }: DialogProps<C>): JSX.Element {
  const destructive = request.destructive ?? DESTRUCTIVE_KINDS.has(request.kind);
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panel.current?.querySelector<HTMLElement>('button')?.focus();
    return () => before?.focus();
  }, []);
  return (
    <div className="frame-scrim session-confirm-scrim">
      <div
        ref={panel}
        className="session-confirm"
        role="dialog"
        aria-modal="true"
        aria-labelledby="session-confirm-message"
        data-destructive={destructive ? 'true' : undefined}
        onKeyDown={(event) => {
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); answer(null); return; }
          // A modal keeps Tab inside it: the window behind cannot be acted on until it is answered.
          if (event.key !== 'Tab') return;
          const buttons = [...(panel.current?.querySelectorAll<HTMLElement>('button') ?? [])];
          const at = buttons.indexOf(document.activeElement as HTMLElement);
          const next = event.shiftKey ? (at <= 0 ? buttons.length - 1 : at - 1) : (at + 1) % buttons.length;
          event.preventDefault();
          buttons[next]?.focus();
        }}
      >
        <p id="session-confirm-message" className="session-confirm-message">{request.message}</p>
        {body}
        {request.detail && <p className="session-confirm-detail">{request.detail}</p>}
        <div className="session-confirm-actions">
          <Button className="session-confirm-cancel" onClick={() => answer(null)}>{request.cancelLabel ?? 'Cancel'}</Button>
          {request.choices.map((choice, i) => (
            <Button
              key={choice.id}
              variant={i === 0 && !destructive ? 'primary' : i === 0 ? 'danger' : 'secondary'}
              className={i === 0 ? `frame-primary${destructive ? ' session-confirm-destructive' : ''}` : 'session-confirm-choice'}
              onClick={() => answer(choice.id)}
            >
              {choice.label}
            </Button>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * Ask one of ui's confirmations in the window (`confirmations.ts`). Not the
 * native dialog main offers: some questions have several answers (the
 * isolation choice), and every host shows the words ui decided, so the
 * dialog is drawn here from the request as it stands. Null is no answer,
 * which every caller reads as no.
 */
export function confirm<C extends string>(request: WindowConfirmation<C>): Promise<C | null> {
  return confirmWith(request, undefined);
}

/** {@link confirm} with more than words to show, as Merge all's preflight lists the files in the way. */
export function confirmWith<C extends string>(request: WindowConfirmation<C>, body: ReactNode): Promise<C | null> {
  return new Promise((resolve) => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const answer = (choice: C | null): void => {
      root.unmount();
      container.remove();
      resolve(choice);
    };
    root.render(<ConfirmDialog request={request} body={body} answer={answer} />);
  });
}
