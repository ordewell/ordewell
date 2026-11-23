import type * as vscode from 'vscode';
import { claimFirstRunFeedback, FIRST_RUN_FEEDBACK, type ExecutionSummary, type FirstRunFeedbackOptions } from '@ordewell/core';

type Vscode = Pick<typeof vscode, 'env' | 'window' | 'Uri'>;

/**
 * The first-run feedback notice (ADR-0075) for a run this extension host's
 * session ended with every task passed. A notification takes no focus and
 * holds nothing up, and VS Code's own close button is its dismiss. Core
 * records it before it shows, in the record the TUI and the desktop app read
 * too, so no surface on the machine shows it again, whatever the person does.
 * Settles once the person has answered or closed it.
 */
export async function showFirstRunFeedback(host: Vscode, summary: ExecutionSummary, options: FirstRunFeedbackOptions): Promise<void> {
  if (!claimFirstRunFeedback(summary, options)) return;
  const { title, text, actions } = FIRST_RUN_FEEDBACK;
  try {
    const choice = await host.window.showInformationMessage(`${title} ${text}`, ...actions.map((action) => action.label));
    const picked = actions.find((action) => action.label === choice);
    if (picked) await host.env.openExternal(host.Uri.parse(picked.url));
  } catch {
    // A window closing under the message is no failure of the run's end.
  }
}
