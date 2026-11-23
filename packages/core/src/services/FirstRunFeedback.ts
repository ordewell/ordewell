import { closeSync, openSync, writeSync } from 'fs';
import { join } from 'path';
import { globalDataDir } from '../utils/globalDataDir';
import { ensurePrivateDir } from '../utils/privateFile';
import { everyTaskPassed, type ExecutionSummary } from './SessionMessage';

/**
 * The first-run feedback notice (ADR-0075): once per machine, at the end of
 * the first run whose every task passed, a surface a person is at asks how it
 * went. It sends nothing; only an action the person picks opens a browser.
 */

/**
 * Beside the version check's `version-check.json` in `globalDataDir()`, shared
 * by every surface on the machine, but a file of its own: a release that
 * rewrites that file keeps only the fields it knows (ADR-0048), which would
 * show this notice again.
 */
const STATE_FILE = 'first-run-feedback.json';

/**
 * CI services set `CI`, most to `true`, some to their own name; only a value
 * that says no keeps a run there interactive.
 */
const inCi = (env: Record<string, string | undefined>): boolean => !/^(|0|false|no)$/i.test(env.CI?.trim() ?? '');

/** Read as the version check reads `ORDEWELL_NO_VERSION_CHECK` (ADR-0048). */
const truthy = (value: string | undefined): boolean => /^(1|true|yes)$/i.test(value?.trim() ?? '');

export interface FirstRunFeedbackOptions {
  /**
   * Whether a person is at this surface: false for no TTY, piped output, a
   * headless command or a test's window, where a notice is noise in a log.
   */
  interactive: boolean;
  env?: Record<string, string | undefined>;
  /** Where the record lives; `globalDataDir()` by default. */
  stateDir?: string;
  now?: () => number;
}

/**
 * Whether this surface shows the notice now, for a run that ended with
 * `summary`. True at most once per machine: the claim is the record, written
 * before anything is shown, so whatever the person then does, and whichever
 * surface showed it, no surface shows it again. Never throws.
 */
export function claimFirstRunFeedback(summary: ExecutionSummary, options: FirstRunFeedbackOptions): boolean {
  const env = options.env ?? process.env;
  if (!options.interactive || inCi(env) || truthy(env.ORDEWELL_NO_FEEDBACK_NOTICE) || !everyTaskPassed(summary)) return false;
  const dir = options.stateDir ?? globalDataDir();
  const shownAt = new Date((options.now ?? Date.now)()).toISOString();
  try {
    ensurePrivateDir(dir);
    // Created exclusively: two surfaces ending runs together cannot both
    // create it, and any file already there, readable or not, was a claim.
    // One that cannot be written is not shown either, since nothing would
    // then stop it at every passed run.
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
