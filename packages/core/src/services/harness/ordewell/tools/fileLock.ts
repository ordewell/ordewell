const tails = new Map<string, Promise<unknown>>();

/**
 * Runs `work` after every earlier call for the same `key` has finished, so two
 * tool calls the model sends in parallel for one file read and write it one
 * after the other and the second sees the first's change. Calls for other keys
 * do not wait. In-process only: one runner owns its worktree.
 */
export function withFileLock<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = tails.get(key) ?? Promise.resolve();
  const run = previous.then(work, work);
  const tail = run.catch(() => undefined);
  tails.set(key, tail);
  // Dropped once idle so the map does not grow with every file ever edited.
  void tail.then(() => { if (tails.get(key) === tail) tails.delete(key); });
  return run;
}

/** The lock key for a resolved path: Windows names a file in any case. */
export function lockKey(realPath: string): string {
  return process.platform === 'win32' ? realPath.toLowerCase() : realPath;
}
