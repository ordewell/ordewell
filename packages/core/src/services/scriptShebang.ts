import * as fs from 'fs';
import * as path from 'path';

/*
 * The interpreter a script task's body names on its first line (ADR-0035). The
 * body is the literal text the user consented to, so the interpreter comes from
 * that text and from nowhere else: planners write bash (`set -o pipefail`,
 * `<<<`, `read -d`) and the host's `sh` is dash on much of Linux. A body with
 * no `#!` line runs as it always has.
 */

export interface Shebang {
  /** The `#!` line as written, for a message. */
  line: string;
  /** The program the line names: `/usr/bin/env`, `/bin/bash`. */
  program: string;
  /** The words after it, split on whitespace; quoting is not read. */
  words: string[];
}

/** The shells a body can be handed to with `-c`, which every one of them reads alike. */
const SHELLS: ReadonlySet<string> = new Set(['sh', 'bash', 'dash', 'ash', 'zsh', 'ksh']);

/** The first line of `script` when it is a `#!` line naming a program; null for a body that has none. */
export function shebangOf(script: string): Shebang | null {
  const first = script.split('\n', 1)[0].replace(/\r$/, '');
  if (!first.startsWith('#!')) return null;
  const [program, ...words] = first.slice(2).trim().split(/\s+/);
  return program ? { line: first, program, words } : null;
}

/** `env`'s options whose value is the next word, which names no interpreter. */
const ENV_VALUED: ReadonlySet<string> = new Set(['-u', '--unset', '-C', '--chdir', '-P']);

/**
 * The interpreter a `#!` line comes to, as a bare name or an absolute path,
 * and the words that follow it. `/usr/bin/env bash -e` is bash with `-e`: `env`
 * only looks the name up, its own options (`-S`, `-i`, `-u NAME`,
 * `NAME=value`) are skipped.
 */
export function interpreterOf(shebang: Shebang): { name: string; words: string[] } {
  if (baseName(shebang.program) !== 'env') return { name: shebang.program, words: shellWords(shebang.words) };
  for (let at = 0; at < shebang.words.length; at++) {
    const word = shebang.words[at];
    if (ENV_VALUED.has(word)) at++;
    else if (!word.startsWith('-') && !word.includes('=')) return { name: word, words: shellWords(shebang.words.slice(at + 1)) };
  }
  return { name: shebang.program, words: [] };
}

/**
 * The line's words as they can stand before `-c`. `#!/bin/sh -` and
 * `#!/bin/bash --` end the shell's options for the kernel, which puts the file
 * after them; before `-c` they would make `-c` the script's name instead.
 */
function shellWords(words: string[]): string[] {
  return words.filter((word) => word !== '-' && word !== '--');
}

function baseName(file: string): string {
  return path.win32.basename(file).replace(/\.exe$/i, '').toLowerCase();
}

/** Whether the interpreter is a shell a body can be handed to with `-c`. */
export function isShell(name: string): boolean {
  return SHELLS.has(baseName(name));
}

/** What a refusal of a non-shell says: Ordewell hands a body to a shell, not to any program. */
export function notAShell(shebang: Shebang, name: string): string {
  return `Script not run: the #! line "${shebang.line}" names "${name}", which is not a shell. A script is handed to ${[...SHELLS].join(', ')} (\`<interpreter> -c <script>\`); put another language's program in a command instead.`;
}

/**
 * The argument vector a POSIX host runs for a `#!` line: the program as
 * written, so `env` still looks the name up where it runs, then the line's own
 * words and the body.
 */
export function shebangArgv(shebang: Shebang, script: string): string[] {
  return [shebang.program, ...shellWords(shebang.words), '-c', script];
}

/** A message naming the interpreter that was not found. */
export function interpreterMissing(shebang: Shebang, name: string, hint?: string): string {
  return `Script not run: could not find "${name}", which the #! line "${shebang.line}" names.${hint ? ` ${hint}` : ''}`;
}

/**
 * Where `name` is on a POSIX host: an executable file at the path it names, or
 * the first directory of `searchPath` that holds one. Null when there is none.
 */
export function findOnPath(name: string, searchPath: string | undefined, isExecutable: (file: string) => boolean = executable): string | null {
  if (name.includes('/')) return isExecutable(name) ? name : null;
  for (const dir of (searchPath ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

function executable(file: string): boolean {
  try {
    if (!fs.statSync(file).isFile()) return false;
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
