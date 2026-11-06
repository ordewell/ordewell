import { installMethod, startVersionCheck, upgradeCommand, type SeaDeps, type VersionCheck, type VersionCheckOptions } from '@ordewell/core';
import { cliVersion } from './version';

/**
 * The version check for one CLI start (ADR-0048). It runs here, in the process
 * the user is looking at, and not in the daemon: the daemon has no terminal of
 * its own, outlives the command that spawned it, and is shared by every client
 * on its port, so it could neither show the notice before its first ping nor
 * tell which client should see the update line.
 *
 * A headless command shows both the one-time notice and the update line on
 * stderr ({@link toStderr}), so stdout stays the command's own; the TUI draws
 * them in its frame, which a stray write would tear.
 *
 * The update line names the upgrade for the way this copy was installed: an
 * npm upgrade does nothing for the standalone binary (ADR-0065 C9).
 */
export function startCliVersionCheck(
  show: Pick<VersionCheckOptions, 'onNotice' | 'onUpdate'>,
  options: Partial<Omit<VersionCheckOptions, 'onNotice' | 'onUpdate'>> = {},
  sea: SeaDeps = {},
): VersionCheck {
  return startVersionCheck({
    version: cliVersion(sea),
    upgradeCommand: upgradeCommand(installMethod(sea)),
    ...options,
    ...show,
  });
}

const writeLine = (line: string): void => console.error(line);

export const toStderr: Pick<VersionCheckOptions, 'onNotice' | 'onUpdate'> = { onNotice: writeLine, onUpdate: writeLine };
