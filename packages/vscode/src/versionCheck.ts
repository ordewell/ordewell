import type * as vscode from 'vscode';
import { startVersionCheck, type VersionCheck, type VersionCheckOptions } from '@ordewell/core';

type Vscode = Pick<typeof vscode, 'env' | 'window'>;

/**
 * The daily version check (ADR-0048) for one extension host. VS Code's own
 * telemetry setting is the off switch: off means no notice, no file and no
 * ping, and turning it off mid-session stops the daily re-check.
 *
 * The update line is a message pointing at the Extensions view, since the
 * Marketplace updates the extension, and comes at most once a day: every
 * window starts an extension host, and a message interrupts each one.
 */
export function startExtensionVersionCheck(
  host: Vscode,
  version: string,
  options: Partial<Omit<VersionCheckOptions, 'version' | 'onNotice' | 'onUpdate' | 'telemetryEnabled'>> = {},
): { dispose(): void } {
  const check: VersionCheck = startVersionCheck({
    version,
    telemetryEnabled: host.env.isTelemetryEnabled,
    onNotice: (text) => { void host.window.showInformationMessage(text); },
    onUpdate: (text) => { void host.window.showInformationMessage(text); },
    howToUpdate: 'update it from the Extensions view',
    updateLine: 'daily',
    ...options,
  });
  const subscription = host.env.onDidChangeTelemetryEnabled((enabled) => {
    if (!enabled) check.stop();
  });
  return {
    dispose() {
      subscription.dispose();
      check.stop();
    },
  };
}
