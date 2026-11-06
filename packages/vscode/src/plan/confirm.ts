import * as vscode from 'vscode';
import type { ConfirmationRequest } from '@ordewell/ui/host';

/**
 * Ask a confirmation the shared view assembly worded (`@ordewell/ui/host`) in
 * a real modal: the webview's own `confirm()` is inert. The answer is the
 * chosen choice's id, or undefined for a dismissal, which every caller reads
 * as no.
 */
export async function confirm<C extends string>(request: ConfirmationRequest<C>): Promise<C | undefined> {
  const picked = await vscode.window.showWarningMessage(
    request.message,
    { modal: true, ...(request.detail !== undefined ? { detail: request.detail } : {}) },
    ...request.choices.map((choice) => choice.label),
  );
  return request.choices.find((choice) => choice.label === picked)?.id;
}
