/**
 * What a stopped runner says about why it stopped, and what ending an attempt
 * does to the runner it leaves behind. TaskOrchestrator acts on the answers.
 */

import { connectorFor } from './harness/connectors';
import type { UsageLimitSignal } from './harness/AgentAdapter';

/**
 * Why a runner stopped, as far as the tail of its own output says. `usage-limit`
 * is the account, not the task, running out; `transient` is its provider
 * failing the turn, which a later try of the same turn may not meet
 * (ADR-0018 E1); anything else is `stopped`.
 */
export type RunnerStop = 'usage-limit' | 'transient' | 'stopped';

/**
 * What a runner says when its account, not the task, ran out. A stop with no
 * `task_complete` call that names a limit is retryable once the limit resets, so it pauses the
 * task instead of failing it. Deliberately narrow: a false positive would leave
 * a genuinely broken task waiting on the user forever, and the words below are
 * the ones the runners print for this and nothing else. Claude Code names
 * the limit it hit ("You've hit your 5-hour limit", "… your Opus limit"), so
 * its phrase is taken whatever the name, as its reset reader takes it.
 */
const USAGE_LIMIT_RE = /\b(?:usage|session|weekly|daily|monthly) limit\b|\byou['’]ve hit your (?:[\w'’-]+ ){0,3}?limit\b|\brate limit (?:exceeded|reached)\b|\brate[- ]limited\b|\blimit (?:will )?reset\b|\bquota (?:exceeded|reached)\b|\btoo many requests\b/i;

/**
 * What a runner says when its provider, not the account or the task, failed
 * the turn: a 5xx, an overload, a provider's own error (ADR-0018 E1). As narrow
 * as the limit's words, for the same reason: a false positive retries a turn
 * that will fail the same way, and only then asks the user. A bare number is
 * never enough, since a turn's error can quote a test's.
 */
const TRANSIENT_RE = /\bAPI Error: 5\d\d\b|\b(?:HTTP|status(?: code)?)[ :]*5\d\d\b|\b(?:internal server error|bad gateway|service unavailable|gateway timeout)\b|\boverloaded(?:_error)?\b|\bapi_error\b/i;

/**
 * A router's words for any upstream failure, its status beside them. Only the
 * status says whose: a 4xx other than a throttle's 429 (a bad key, a context
 * too long) is the request's, and fails the same way on every try. A context
 * too long says so in words even where no status is printed, and OpenCode 2.x
 * names a bad key or request by its type where it prints no status. Reading a 4xx
 * where there is none only asks the user sooner, so this errs wide.
 */
const PROVIDER_ERROR_RE = /\bprovider returned error\b/i;
const CLIENT_ERROR_RE = /(?:\bAPI Error:|\bHTTP(?:\/[\d.]+)?|\bstatus(?:[ _]?code)?|\berror|"(?:code|status|status_?code)"\s*:\s*"?)[ :]*4(?!29)\d\d\b|\b4(?!29)\d\d\s+provider returned error\b|\bprovider\.(?:auth|invalid-request)\b|\bmaximum context length\b|\bcontext[ _]length[ _]exceeded\b/i;

/** A provider's throttle, once the runner's own field has said it is not the account's limit. */
const THROTTLE_RE = /\brate[- ]?limit|\btoo many requests\b|\b429\b/i;

/**
 * The backoff before each try of a turn its provider failed, a task's and the
 * planner's alike (ADR-0018 E1); its length is how many tries the turn gets
 * before its error goes to the user.
 */
export const PROVIDER_RETRY_DELAYS_MS: readonly number[] = [30_000, 60_000, 120_000];

/** How much of a stopped runner's tail is read for the limit signature: the error is the last thing it prints. */
const USAGE_LIMIT_TAIL = 4096;

/**
 * A turn's failure as its runner reported it: its words, and `usageLimit`
 * where its protocol also says in a field whether it was the limit (Codex's
 * `codexErrorInfo`).
 */
export interface TurnFailure {
  message: string;
  usageLimit?: UsageLimitSignal | false;
}

/**
 * Classify a stopped runner from the tail of its own output, or a failed turn
 * from its error. A runner's own field is believed over its words on whether
 * it was the usage limit; without one, the words decide. The limit outranks a
 * transient error: its words name the account, and retrying before it resets
 * meets it again.
 */
export function classifyRunnerStop(said: string | TurnFailure): RunnerStop {
  const tail = wordsOf(said).slice(-USAGE_LIMIT_TAIL);
  const field = typeof said === 'string' ? undefined : said.usageLimit;
  if (field !== undefined ? field : USAGE_LIMIT_RE.test(tail)) return 'usage-limit';
  if (TRANSIENT_RE.test(tail) || (PROVIDER_ERROR_RE.test(tail) && !CLIENT_ERROR_RE.test(tail))) return 'transient';
  // A throttle the runner said was not its limit (Codex's `rateLimitExceeded`) is the provider's, and passes.
  if (field === false && THROTTLE_RE.test(tail)) return 'transient';
  return 'stopped';
}

function wordsOf(said: string | TurnFailure): string {
  return typeof said === 'string' ? said : said.message;
}

/** Every way an attempt ends: a verdict, a usage limit, cancel, release, Mark complete, retry, a failed spawn, stop, plan load. */
export type AttemptEnd = 'verdict' | 'usage-limit' | 'cancel' | 'release' | 'complete' | 'skip' | 'retry' | 'spawn-failed' | 'stop' | 'load';

/**
 * Whether ending an attempt with this reason has to stop its own runner now.
 * A verdict and a usage limit end it too (ADR-0018, L1): its log lives in Ordewell, and
 * whatever it did after the verdict would go unverified. Stop lets every
 * runner go itself before it ends the attempts; a load ends them and leaves
 * their runners be.
 */
export function stopsRunner(reason: AttemptEnd): boolean {
  return reason !== 'stop' && reason !== 'load';
}

/**
 * When a runner's usage limit resets: the time its failure carries in a field
 * where it has one, else read from the limit message it printed, or null when
 * that runner's wording carries no time Ordewell can read — the task then
 * waits for a manual retry. Each runner words it its own way, so its
 * connector reads it (`usageLimitReset`); a runner without a reader gets none.
 */
export function readUsageLimitReset(runner: string, said: string | TurnFailure, now: Date = new Date()): Date | null {
  const reset = (typeof said === 'string' ? null : reportedReset(said)) ?? readReset(runner, wordsOf(said), now);
  // A reset long past is not this stop's: the words were left over, and acting on them would retry at once.
  if (!reset || reset.getTime() < now.getTime() - DAY_MS) return null;
  return reset;
}

function reportedReset(failure: TurnFailure): Date | null {
  const at = failure.usageLimit ? failure.usageLimit.resetsAt : undefined;
  const reset = at === undefined ? null : new Date(at);
  return reset && !Number.isNaN(reset.getTime()) ? reset : null;
}

function readReset(runner: string, output: string, now: Date): Date | null {
  const read = connectorFor(runner)?.usageLimitReset;
  if (!read) return null;
  try {
    return read(output.slice(-USAGE_LIMIT_TAIL), now);
  } catch {
    // An unknown time zone name: the time cannot be placed, so it is not guessed.
    return null;
  }
}

const DAY_MS = 24 * 60 * 60_000;
