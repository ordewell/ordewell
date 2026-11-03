import { useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import type { ConfirmationRequest } from '@ordewell/ui/host';

interface DialogProps<C extends string> {
  request: ConfirmationRequest<C>;
  answer(choice: C | null): void;
}

function ConfirmDialog<C extends string>({ request, answer }: DialogProps<C>): JSX.Element {
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
        {request.detail && <p className="session-confirm-detail">{request.detail}</p>}
        <div className="session-confirm-actions">
          <button type="button" className="session-confirm-cancel" onClick={() => answer(null)}>Cancel</button>
          {request.choices.map((choice, i) => (
            <button key={choice.id} type="button" className={i === 0 ? 'frame-primary' : 'session-confirm-choice'} onClick={() => answer(choice.id)}>{choice.label}</button>
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
export function confirm<C extends string>(request: ConfirmationRequest<C>): Promise<C | null> {
  return new Promise((resolve) => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const answer = (choice: C | null): void => {
      root.unmount();
      container.remove();
      resolve(choice);
    };
    root.render(<ConfirmDialog request={request} answer={answer} />);
  });
}
