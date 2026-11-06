import { startVersionCheck, type VersionCheck, type VersionCheckOptions } from '@ordewell/core';
import { updateHint, type SelfUpdateDeps } from './selfUpdate';
import { cliVersion } from './version';

/**
 * The version check for one CLI start (ADR-0048). It runs here, in the process
 * the user is looking at, and not in the daemon: the daemon has no terminal of
 * its own, outlives the command that spawned it, and is shared by every client
 * on its port, so it could neither show the notice before its first ping nor
 * tell which client should see the update line.
 *
 * A headless command writes the one-time notice to stderr, so stdout stays
 * the command's own, and the update line only to a stderr that is a terminal,
 * at most once a day ({@link startHeadlessVersionCheck}): a script's log is
 * no place for it, and a command run many times a day would repeat it. The TUI
 * draws both in its frame, which a stray write would tear, and names the
 * update on every start.
 *
 * The update line says how this copy updates: `ordewell update` (or the TUI's
 * `/update`) for an install it can update in place, and what would otherwise.
 */
export function startCliVersionCheck(
  show: Pick<VersionCheckOptions, 'onNotice' | 'onUpdate'>,
  options: Partial<Omit<VersionCheckOptions, 'onNotice' | 'onUpdate'>> = {},
  copy: Pick<SelfUpdateDeps, 'sea' | 'entry'> = {},
): VersionCheck {
  return startVersionCheck({
    version: cliVersion(copy.sea),
    howToUpdate: updateHint('run `ordewell update`', copy),
    ...options,
    ...show,
  });
}

/** The check a headless command starts, writing to `stderr`. */
export function startHeadlessVersionCheck(
  stderr: { isTTY?: boolean; write(text: string): unknown } = process.stderr,
  options: Partial<Omit<VersionCheckOptions, 'onNotice' | 'onUpdate'>> = {},
  copy: Pick<SelfUpdateDeps, 'sea' | 'entry'> = {},
): VersionCheck {
  const writeLine = (line: string): void => {
    stderr.write(`${line}\n`);
  };
  return startCliVersionCheck(
    { onNotice: writeLine, ...(stderr.isTTY ? { onUpdate: writeLine } : {}) },
    { updateLine: 'daily', ...options },
    copy,
  );
}
