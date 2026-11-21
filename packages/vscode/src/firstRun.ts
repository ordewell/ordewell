import * as vscode from 'vscode';

/** In `globalState`, one for every window: the view is revealed in the first window after install, not in each. */
const REVEALED_KEY = 'ordewell.firstRunRevealedAt';

interface Store {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void> | Promise<void>;
}

/**
 * The activity bar icon is easy to miss after an install, and the panel is
 * where everything starts, so the first activation opens it, once.
 */
export async function revealOnFirstActivation(commands: Pick<typeof vscode.commands, 'executeCommand'>, store: Store | undefined): Promise<void> {
  try {
    if (!store || store.get<number>(REVEALED_KEY) !== undefined) return;
    // Recorded first: a reveal that fails is not worth retrying on every start.
    await store.update(REVEALED_KEY, Date.now());
    await commands.executeCommand('ordewellChatView.focus');
  } catch {
    // The view stays where it is; the walkthrough's first step opens it.
  }
}

/** The walkthrough's steps past the first complete on these keys (package.json `contributes.walkthroughs`). */
export type WalkthroughStep = 'goalGiven' | 'planApproved';

export function markWalkthroughStep(step: WalkthroughStep): void {
  void Promise.resolve(vscode.commands.executeCommand('setContext', `ordewell.walkthrough.${step}`, true)).catch(() => {});
}
