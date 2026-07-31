export function flag(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  return idx !== -1 ? args[idx + 1] : undefined;
}

export function flags(args: string[], name: string): (string | undefined)[] {
  const results: (string | undefined)[] = [];
  let idx = 0;
  while (idx < args.length) {
    if (args[idx] === name) {
      results.push(args[idx + 1]);
    }
    idx++;
  }
  return results;
}

export function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

/** Flags that consume the following argument, so it isn't mistaken for a positional. */
const VALUE_FLAGS = new Set([
  '--session-id', '--port', '--workspace', '--goal', '--runner', '--model',
  '--title', '--description', '--prompt', '--depends-on', '--type', '--output',
]);

/**
 * Bare arguments — everything that is neither a flag nor a flag's value.
 * `ordewell retry --session-id s1 3` → `['3']`.
 */
export function positionals(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      if (VALUE_FLAGS.has(arg)) i++;
      continue;
    }
    out.push(arg);
  }
  return out;
}
