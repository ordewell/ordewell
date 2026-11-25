import React, { createContext, useContext } from 'react';
import { setsUpKey, signInAction, type RunnerSignIn } from '@ordewell/core/plan-utils';
import PlannerLoginAction from './PlannerLogin';

/** The pills' own login state and actions, keyed by runner id, which every error's sign-in shares. */
export interface ErrorSignInActions {
  pending: Readonly<Record<string, true>>;
  done: Readonly<Record<string, true>>;
  failure: Readonly<Record<string, string>>;
  onLogIn: (runner: string) => void;
  onKey: (provider: string) => void;
}

export const ErrorSignInContext = createContext<ErrorSignInActions | null>(null);

/**
 * The way out of an error the failure itself says is that agent's sign-in
 * (ADR-0052): keyed by the agent it names, never by the planner picked since.
 * The login is the pills' own, so one in flight anywhere waits here too; it
 * sends nothing when it ends, as the refused message waits for its sender.
 * The same for the error banner and for a planner turn the runner ended
 * signed out, which the conversation keeps as its error.
 */
export default function ErrorSignIn({ signIn }: { signIn: RunnerSignIn }) {
  const actions = useContext(ErrorSignInContext);
  if (!actions) return null;
  const { runner } = signIn;
  const action = signInAction(signIn);
  const pending = actions.pending[runner] === true;
  const failure = actions.failure[runner];
  // An agent that only lacks a key Ordewell can hand it was never signed out: its login is a setup.
  const setsUp = setsUpKey(signIn);
  if (actions.done[runner] === true) {
    return <p className="error-sign-in-outcome" role="status">{setsUp ? `${signIn.label} is set up.` : `Signed in to ${signIn.label}.`} Send your message again.</p>;
  }
  return (
    <>
      {failure !== undefined && <p className="error-sign-in-outcome" role="status">{failure}</p>}
      {action === 'login' && setsUp && (
        <PlannerLoginAction
          className="error-sign-in"
          label={`Set up ${signIn.label}`}
          pendingLabel="Setting up…"
          pending={pending}
          onLogIn={() => actions.onLogIn(runner)}
          ariaLabel={pending ? `Setting up ${signIn.label}` : `Set up ${signIn.label} with a provider API key`}
        />
      )}
      {action === 'login' && !setsUp && (
        <PlannerLoginAction
          className="error-sign-in"
          label="Sign in"
          pending={pending}
          onLogIn={() => actions.onLogIn(runner)}
          ariaLabel={pending ? `Signing in to ${signIn.label}` : `Sign in to ${signIn.label}`}
        />
      )}
      {action === 'key' && signIn.key && (
        <button type="button" className="error-sign-in" aria-label={`Add a key for ${signIn.label}`} onClick={() => actions.onKey(signIn.key!.provider)}>
          Add key
        </button>
      )}
    </>
  );
}
