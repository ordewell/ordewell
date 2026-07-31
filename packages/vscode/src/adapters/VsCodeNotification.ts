import * as vscode from 'vscode';
import { INotification } from '@ordewell/core';

export class VsCodeNotification implements INotification {
  info(msg: string): void {
    vscode.window.showInformationMessage(msg);
  }

  warn(msg: string): void {
    vscode.window.showWarningMessage(msg);
  }

  error(msg: string): void {
    vscode.window.showErrorMessage(msg);
  }

  async confirm(msg: string, options: string[]): Promise<string | undefined> {
    const selected = await vscode.window.showWarningMessage(
      msg,
      { modal: true },
      ...options.map((o) => o as string)
    );
    return selected;
  }
}
