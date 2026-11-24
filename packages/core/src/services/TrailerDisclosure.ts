import { closeSync, openSync, writeSync } from 'fs';
import { join } from 'path';
import { globalDataDir } from '../utils/globalDataDir';
import { ensurePrivateDir } from '../utils/privateFile';
import { PLANNED_WITH_TRAILER } from './landingMessage';

/**
 * The disclosure of the `Planned-with: Ordewell` commit trailer (ADR-0030):
 * once per machine, the first merge that would write it says so, with the way
 * to turn it off. The claim is a file in `globalDataDir()` shared by every
 * surface, created exclusively as the first-run feedback notice's is
 * (ADR-0075), so whichever surface shows the line first is the only one.
 */
const STATE_FILE = 'trailer-disclosure.json';

/** The one line, as a merge confirmation or a notice beside an automatic merge words it. */
export const TRAILER_DISCLOSURE = `This commit will end with ${PLANNED_WITH_TRAILER}. \`ordewell trailer off\` removes it.`;

export interface TrailerDisclosureOptions {
  /** Whether the merge would write the trailer: the `plannedWithTrailer` setting. */
  trailerOn: boolean;
  /** Where the record lives; `globalDataDir()` by default. */
  stateDir?: string;
  now?: () => number;
}

/**
 * Whether the caller shows {@link TRAILER_DISCLOSURE} now. True at most once
 * per machine, and only with the trailer on; call it only where the line is
 * about to be shown. Never throws: a record that cannot be written is not shown.
 */
export function claimTrailerDisclosure(options: TrailerDisclosureOptions): boolean {
  if (!options.trailerOn) return false;
  const dir = options.stateDir ?? globalDataDir();
  const shownAt = new Date((options.now ?? Date.now)()).toISOString();
  try {
    ensurePrivateDir(dir);
    const fd = openSync(join(dir, STATE_FILE), 'wx', 0o600);
    try {
      writeSync(fd, `${JSON.stringify({ shownAt }, null, 2)}\n`);
    } finally {
      closeSync(fd);
    }
    return true;
  } catch {
    return false;
  }
}
