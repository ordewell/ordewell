import React from 'react';

interface PlannerLoginActionProps {
  onLogIn: () => void;
  pending?: boolean;
  /** The row's larger action or a pill's small one; both keep their slot while pending. */
  className: string;
  ariaLabel?: string;
  title?: string;
}

/**
 * The one login action the signed-out surface offers. The empty-state row and
 * a pill's own action share the look, spinner and busy state so a login cannot
 * look like two different controls depending on where it started. A capsule
 * hides the pending words to keep its reserved "Log in" width; the row keeps
 * them, because it has room for the longer line.
 *
 * `.planner-login` carries that shared look; the caller's class only chooses
 * where it sits (a pill segment or a row's action).
 */
export default function PlannerLoginAction({ onLogIn, pending, className, ariaLabel, title }: PlannerLoginActionProps) {
  return (
    <button
      type="button"
      className={`planner-login ${className}`}
      onClick={onLogIn}
      disabled={pending}
      aria-busy={pending ? true : undefined}
      aria-label={ariaLabel}
      title={title}
    >
      <span className="planner-login-state">
        {pending
          ? <><span className="planner-login-spinner" aria-hidden="true" /><span className="planner-login-pending-label">Signing in…</span></>
          : 'Log in'}
      </span>
    </button>
  );
}
