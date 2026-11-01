/** The value of `--name=value`, or undefined when `arg` is a different token. */
function inlineValue(arg: string, name: string): string | undefined {
  return arg.startsWith(`${name}=`) ? arg.slice(name.length + 1) : undefined;
}

export function flag(args: string[], name: string): string | undefined {
  for (let idx = 0; idx < args.length; idx++) {
    const arg = args[idx];
    if (arg === name) return args[idx + 1];
    const inline = inlineValue(arg, name);
    if (inline !== undefined) return inline;
  }
  return undefined;
}

export function flags(args: string[], name: string): (string | undefined)[] {
  const results: (string | undefined)[] = [];
  let idx = 0;
  while (idx < args.length) {
    const arg = args[idx];
    if (arg === name) {
      results.push(args[idx + 1]);
    } else {
      const inline = inlineValue(arg, name);
      if (inline !== undefined) results.push(inline);
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
  '--title', '--description', '--prompt', '--depends-on', '--type', '--output', '--reason', '--raise', '--answer',
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
      // `--name=value` carries its value inside the token, so there is no
      // following argument to skip.
      if (!arg.includes('=') && VALUE_FLAGS.has(arg)) i++;
      continue;
    }
    out.push(arg);
  }
  return out;
}
