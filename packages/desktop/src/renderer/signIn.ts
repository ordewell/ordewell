import type { AiProvider } from '@ordewell/core';
import { describeRunnerSignIn, signInAction, signInOfVerdict, TERMINAL_UI_SIGN_IN } from '@ordewell/core/plan-utils';
import type { PlannerBackend, WebviewToHost } from '@ordewell/ui/protocol';

/** A signed-out agent as a card, a row or a menu offers it: core's words and the one action that fits. */
export interface SignInView {
  /** The runner this signs in. */
  runner: string;
  label: string;
  hint: string;
  action: 'login' | 'key';
  /** The vendor a key action opens. */
  provider?: AiProvider;
}

/**
 * What a surface shows for one planner backend, or undefined when it is
 * signed in (or its sign-in could not be read). The one function every
 * desktop surface uses, so Welcome, Settings, the task tab and the graph
 * cannot word the same agent differently (ADR-0052).
 */
export function signedOutSignIn(backend: PlannerBackend): SignInView | undefined {
  if (backend.auth?.state !== 'signed-out') return undefined;
  const runner = backend.runner ?? backend.id;
  const signIn = signInOfVerdict(runner, backend.label, backend.auth);
  const action = signInAction(signIn);
  if (!action) return undefined;
  return {
    runner,
    label: backend.label,
    hint: describeRunnerSignIn({ state: 'signed-out', ...(signIn ? { signIn } : {}) }, TERMINAL_UI_SIGN_IN) ?? `${backend.label} is not signed in.`,
    action,
    ...(action === 'key' && signIn?.key ? { provider: signIn.key.provider } : {}),
  };
}

/** Every signed-out agent the chat knows, by runner id. */
export function signedOutByRunner(backends: readonly PlannerBackend[]): Record<string, SignInView> {
  const byRunner: Record<string, SignInView> = {};
  for (const backend of backends) {
    const view = signedOutSignIn(backend);
    if (view) byRunner[backend.runner ?? backend.id] = view;
  }
  return byRunner;
}

/** The one host message a Sign in or Set API key control posts. */
export function signInMessage(view: SignInView): WebviewToHost {
  return view.action === 'key' && view.provider
    ? { type: 'sendMessage', text: `/key ${view.provider}` }
    : { type: 'loginPlanner', runner: view.runner };
}
