/**
 * What a stopped runner says about why it stopped, and what ending an attempt
 * does to the runner it leaves behind. TaskOrchestrator acts on the answers.
 */

/**
 * Why a runner stopped, as far as the tail of its own output says. `usage-limit`
 * is the account, not the task, running out; anything else is `stopped`.
 */
export type RunnerStop = 'usage-limit' | 'stopped';

/**
 * What a runner says when its account, not the task, ran out. A stop with no
 * `task_complete` call that names a limit is retryable once the limit resets, so it pauses the
 * task instead of failing it. Deliberately narrow: a false positive would leave
 * a genuinely broken task waiting on the user forever, and the words below are
 * the ones the runners print for this and nothing else.
 */
const USAGE_LIMIT_RE = /\b(?:usage|session|weekly|daily|monthly) limit\b|\brate limit (?:exceeded|reached)\b|\brate[- ]limited\b|\blimit (?:will )?reset\b|\bquota (?:exceeded|reached)\b|\btoo many requests\b/i;

/** How much of a stopped runner's tail is read for the limit signature: the error is the last thing it prints. */
const USAGE_LIMIT_TAIL = 4096;

/** Classify a stopped runner from the tail of its own output. */
export function classifyRunnerStop(output: string): RunnerStop {
  return USAGE_LIMIT_RE.test(output.slice(-USAGE_LIMIT_TAIL)) ? 'usage-limit' : 'stopped';
}

/** Every way an attempt ends: a verdict, cancel, release, Mark complete, retry, a failed spawn, stop, plan load. */
export type AttemptEnd = 'verdict' | 'cancel' | 'release' | 'complete' | 'retry' | 'spawn-failed' | 'stop' | 'load';

/**
 * Whether ending an attempt with this reason has to stop its own runner now.
 * A verdict ends it too (ADR-0018, L1): its log lives in Ordewell, and
 * whatever it did after the verdict would go unverified. Stop and load reset
 * every runner at once instead.
 */
export function stopsRunner(reason: AttemptEnd): boolean {
  return reason !== 'stop' && reason !== 'load';
}
