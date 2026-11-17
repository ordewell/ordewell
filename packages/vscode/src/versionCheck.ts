import type * as vscode from 'vscode';
import { startVersionCheck, type VersionCheck, type VersionCheckOptions } from '@ordewell/core';

type Vscode = Pick<typeof vscode, 'env' | 'window' | 'commands' | 'Uri' | 'StatusBarAlignment'>;

const DAY_MS = 24 * 60 * 60 * 1000;
const UPDATE = 'Update';
const WHATS_NEW = "What's new";
/** Release tags are `v<version>` (.github/workflows/release.yml). */
const RELEASE_URL = 'https://github.com/ordewell/ordewell/releases/tag/v';

/** Where the popup remembers when it last appeared; VS Code's `globalState` is one for every window. */
export interface PopupStore {
  get(): number | undefined;
  set(at: number): void;
}

export interface ExtensionVersionCheckOptions
  extends Partial<Omit<VersionCheckOptions, 'version' | 'onNotice' | 'onUpdate' | 'telemetryEnabled' | 'updateLine'>> {
  /** `publisher.name`, which the Extensions view opens; the item and the Update button open it. */
  extensionId?: string;
  popupStore?: PopupStore;
}

/**
 * The daily version check (ADR-0048) for one extension host. VS Code's own
 * telemetry setting is the off switch: off means no notice, no file and no
 * ping, and turning it off mid-session stops the daily re-check and hides the
 * status bar item.
 *
 * An update shows in two places. A status bar item stays while an update is
 * known, on every start, whatever any surface showed today: the core's once-a-day
 * `updateShownAt` is shared with the TUI and CLI and so would hide it. A message
 * with Update and What's new buttons comes at most once a day across windows,
 * on this extension's own clock, since every window starts an extension host and
 * a message interrupts each one.
 */
export function startExtensionVersionCheck(
  host: Vscode,
  version: string,
  options: ExtensionVersionCheckOptions = {},
): { dispose(): void } {
  const { extensionId = 'ordewell.ordewell', popupStore = memoryStore(), ...coreOptions } = options;
  let item: vscode.StatusBarItem | undefined;

  const openExtension = async (): Promise<void> => {
    try {
      // The extension's page, which carries the Update button. Built in since
      // VS Code 1.5x and in every fork: the Extensions workbench is VS Code's own.
      await host.commands.executeCommand('extension.open', extensionId);
    } catch {
      await host.commands.executeCommand('workbench.view.extensions');
    }
  };

  const showStatusBar = (latest: string): void => {
    item ??= host.window.createStatusBarItem(host.StatusBarAlignment.Right, 0);
    item.text = `$(arrow-circle-up) Ordewell ${latest}`;
    item.tooltip = `Ordewell ${latest} is out (you have ${version}). Click to update it from the Extensions view.`;
    item.command = { title: 'Update Ordewell', command: 'extension.open', arguments: [extensionId] };
    item.show();
  };

  const showPopup = (text: string, latest: string): void => {
    const shownAt = popupStore.get();
    const since = shownAt === undefined ? Infinity : Date.now() - shownAt;
    // A time in the future is a clock that went back; as in the core, do not wait it out.
    if (since >= 0 && since < DAY_MS) return;
    popupStore.set(Date.now());
    void Promise.resolve(host.window.showInformationMessage(text, UPDATE, WHATS_NEW)).then(async (choice) => {
      if (choice === UPDATE) await openExtension();
      else if (choice === WHATS_NEW) await host.env.openExternal(host.Uri.parse(`${RELEASE_URL}${latest}`));
    }).catch(() => {});
  };

  const check: VersionCheck = startVersionCheck({
    version,
    telemetryEnabled: host.env.isTelemetryEnabled,
    onNotice: (text) => { void host.window.showInformationMessage(text); },
    onUpdate: (text, latest) => {
      showStatusBar(latest);
      showPopup(text, latest);
    },
    howToUpdate: 'update it from the Extensions view',
    // Every start, so the item is there however recently another surface spoke; the popup keeps its own day.
    updateLine: 'every-start',
    ...coreOptions,
  });
  const subscription = host.env.onDidChangeTelemetryEnabled((enabled) => {
    if (enabled) return;
    check.stop();
    item?.hide();
  });
  return {
    dispose() {
      subscription.dispose();
      check.stop();
      item?.dispose();
      item = undefined;
    },
  };
}

function memoryStore(): PopupStore {
  let at: number | undefined;
  return { get: () => at, set: (value) => { at = value; } };
}
