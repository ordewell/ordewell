import { resolve } from 'path';

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

/**
 * Whether `name` is written at all, with or without a value. `flag` returns
 * undefined both for an absent flag and for a trailing one, and a command that
 * must not read a valueless `--type $EMPTY` as "not given" tells them apart here.
 */
export function flagGiven(args: string[], name: string): boolean {
  return args.some((arg) => arg === name || inlineValue(arg, name) !== undefined);
}

/**
 * The directory `--workspace` names, absolute. The daemon keeps the cwd of the
 * command that first started it, so a relative path sent as typed would be
 * resolved there instead of where the user is.
 */
export function workspaceOf(args: string[]): string {
  return resolve(flag(args, '--workspace') || process.cwd());
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

/**
 * Whether a command's arguments ask for its help: a bare `--help` or `-h`.
 * An argument is only ever the exact token, so a quoted sentence that contains
 * "--help" is text; the value a flag consumes (`--goal -h`) is text too; and
 * nothing after a `--` separator is read as an option.
 */
export function wantsHelp(args: string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') return false;
    if (arg === '--help' || arg === '-h') return true;
    if (VALUE_FLAGS.has(arg)) i++;
  }
  return false;
}
