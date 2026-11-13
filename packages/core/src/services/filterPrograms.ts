/**
 * Reading the programs `sed`, `awk`, `jq` and `yq` are handed.
 *
 * Both are text filters, and both can run a command or write a file from inside
 * their own program: sed's `e` command and the `e` flag of `s` hand text to the
 * shell, and its `w`/`W` commands and the `w` flag of `s` write a file; awk has
 * `system()`, pipes to and from commands, and `print > file`. Both can also
 * read a file their program names — sed's `r`/`R`, awk's `getline < file` and
 * an assignment to `ARGV` — which path confinement never sees, since it reads
 * only the arguments, and awk reads the process environment, provider keys
 * included, through `ENVIRON`. None of that is a flag, so a classifier that
 * looks at a segment's binary and flags saw `sed '1e rm -rf src'` as a plain
 * `sed` and put it on the prompt tier — where one approval of an ordinary
 * substitution is remembered for every later `sed`.
 *
 * The parsers here are deliberately partial. They follow the grammar a planner
 * actually writes and answer "cannot read" for everything else, and "cannot
 * read" refuses: a false refusal costs the model a rewrite, a false prompt puts
 * a shell command behind an approval the developer believes is a text filter.
 * Where implementations disagree about where a construct ends (GNU and BSD sed
 * on a delimiter inside a bracket expression; gawk and the one-true-awk on `/`
 * inside a bracket in a regex literal), the construct is unreadable rather
 * than read either way.
 */

import { FLAG_POLICY } from './flagPolicy';

export const SED_FAMILY = ['sed', 'gsed'];
export const AWK_FAMILY = ['awk', 'gawk', 'mawk', 'nawk'];

const INSPECT_OR_TASK = 'Use the read-only research tools, or describe it as a task.';

/** What a program does that the planner may not, or that it cannot be read well enough to rule out. */
type Hazard = 'exec' | 'pipe' | 'write' | 'read' | 'environment' | 'symbol-table' | 'extension' | 'unreadable';

// ---------------------------------------------------------------------------
// sed
// ---------------------------------------------------------------------------

/** Short options that take nothing, across GNU and BSD. `-l` is absent: GNU reads a value, BSD does not. */
const SED_SHORT_BOOLEANS = 'nErszu';
const SED_LONG_BOOLEANS = ['--quiet', '--silent', '--regexp-extended', '--separate', '--null-data',
  '--zero-terminated', '--unbuffered', '--posix', '--debug', '--sandbox', '--help', '--version'];

/**
 * Why a sed invocation is refused, or `undefined` when its scripts only read.
 *
 * GNU sed permutes its arguments, so an option after a file name is still an
 * option: `sed 1p file -e '1e rm x'` runs the `e`. Every token before `--` is
 * therefore read as a possible option. BSD sed stops at the first operand, so
 * that operand is its script even when an `-e` follows it — both readings are
 * inspected, and either one refusing refuses.
 */
export function sedRefusal(binary: string, args: string[]): string | undefined {
  return readSed(binary, args).refusal;
}

/**
 * Which of `args` are sed script text rather than files, for path confinement.
 * The first operand counts only when no script came by flag anywhere: GNU reads
 * it as a file then, and the file reading is the one confinement must assume.
 */
export function sedProgramArgs(binary: string, args: string[]): number[] {
  return readSed(binary, args).programArgs;
}

/** `10,40p`, `$p`, `5,+3p`, `100q`: a line-number address or two, then print or quit. */
const PRINT_BY_LINE = /^(?:\d+|\$)?(?:\s*,\s*(?:\d+|\$|\+\d+))?\s*[pq]$/;

/**
 * Whether sed only prints lines by number, the read `head` and `tail` make
 * without asking (ADR-0008). Every option must come before the first operand,
 * so GNU's argument permutation and BSD's first-operand script agree on which
 * word is the script.
 */
export function sedOnlyPrints(args: string[]): boolean {
  const scripts: string[] = [];
  let operands = 0;
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (token === '--') { operands += args.length - i - 1; break; }
    if (!/^-./.test(token)) { operands++; continue; }
    if (operands > 0) return false;
    if (SED_LONG_BOOLEANS.includes(token)) continue;
    const long = /^--expression(?:=(.*))?$/s.exec(token);
    const short = /^-([nErszu]*)e(.*)$/s.exec(token);
    if (long || short) {
      const inline = long ? long[1] : short?.[2] || undefined;
      const script = inline ?? args[++i];
      if (script === undefined) return false;
      scripts.push(script);
      continue;
    }
    if (!/^-[nErszu]+$/.test(token)) return false;
  }
  if (scripts.length === 0) {
    const first = args.find((a) => !/^-./.test(a));
    if (first === undefined) return false;
    scripts.push(first);
  }
  const commands = scripts.join('\n').split(/[;\n]/).map((c) => c.trim()).filter(Boolean);
  return commands.length > 0 && commands.every((c) => PRINT_BY_LINE.test(c));
}

interface FilterRead {
  refusal?: string;
  /** Indices into `args` holding program text. Empty when refused. */
  programArgs: number[];
}

function refused(refusal: string): FilterRead {
  return { refusal, programArgs: [] };
}

function readSed(binary: string, args: string[]): FilterRead {
  const scripts: string[] = [];
  const scriptArgs: number[] = [];
  let scriptFlagSeen = false;
  let firstOperand: string | undefined;
  let firstOperandArg = -1;
  let scriptFlagBeforeOperand = false;
  const noteOperand = (at: number) => {
    if (args[at] === undefined || firstOperand !== undefined) return;
    firstOperand = args[at];
    firstOperandArg = at;
    scriptFlagBeforeOperand = scriptFlagSeen;
  };
  const fromFile = (flag: string): FilterRead => refused(
    `"${binary} ${flag}" reads its script from a file this classifier cannot inspect. ${INSPECT_OR_TASK}`);
  const inPlace = (flag: string): FilterRead => refused(
    `"${binary} ${flag}" edits files in place. You are a read-only planner — describe the change as a task instead.`);
  const unknown = (flag: string): FilterRead => refused(
    `"${flag}" is not a flag this classifier knows on "${binary}", so it cannot tell which argument is the script. Re-run without it.`);

  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (token === '--') { noteOperand(i + 1); break; }
    if (!/^-./.test(token)) { noteOperand(i); continue; }

    if (token.startsWith('--')) {
      const eq = token.indexOf('=');
      const name = eq > 0 ? token.slice(0, eq) : token;
      if (name === '--expression') {
        const script = eq > 0 ? token.slice(eq + 1) : args[++i];
        if (script === undefined) return unknown(token);
        scripts.push(script);
        scriptArgs.push(i);
        scriptFlagSeen = true;
      } else if (name === '--file') {
        return fromFile(name);
      } else if (name === '--in-place') {
        return inPlace(name);
      } else if (name === '--line-length') {
        if (eq < 0) i++;
      } else if (!(SED_LONG_BOOLEANS.includes(name) && eq < 0)) {
        return unknown(name);
      }
      continue;
    }

    // Short options cluster (`-ne`, `-nE`), and the first value-taking letter
    // takes the rest of the token or, at the end of it, the next token.
    for (let j = 1; j < token.length; j++) {
      const letter = token[j];
      if (SED_SHORT_BOOLEANS.includes(letter)) continue;
      if (letter === 'e') {
        const script = j + 1 < token.length ? token.slice(j + 1) : args[++i];
        if (script === undefined) return unknown(token);
        scripts.push(script);
        scriptArgs.push(i);
        scriptFlagSeen = true;
        break;
      }
      if (letter === 'f') return fromFile(`-${letter}`);
      // GNU `-i[SUFFIX]`, BSD `-i SUFFIX` and `-I SUFFIX`, clustered or not:
      // `sed -ni` is in place too.
      if (letter === 'i' || letter === 'I') return inPlace(token);
      return unknown(token);
    }
  }

  const programArgs = scripts.length === 0 && firstOperand !== undefined ? [firstOperandArg] : scriptArgs;
  if (firstOperand !== undefined && (scripts.length === 0 || !scriptFlagBeforeOperand)) scripts.push(firstOperand);
  if (scripts.length === 0) return { programArgs };
  const refusal = sedRefusalFor(binary, scripts);
  return refusal ? refused(refusal) : { programArgs };
}

function sedRefusalFor(binary: string, scripts: string[]): string | undefined {

  // GNU and BSD both join several scripts with newlines before parsing, so an
  // `a\` in one `-e` continues into the next.
  switch (sedScriptHazard(scripts.join('\n'))) {
    case undefined: return undefined;
    case 'exec':
      return `The "${binary}" script runs a shell command (the "e" command or the "e" flag of "s"), which this classifier cannot inspect. ${INSPECT_OR_TASK}`;
    case 'write':
      return `The "${binary}" script writes a file (the "w"/"W" command or the "w" flag of "s"). You are a read-only planner — print the output instead, or describe the write as a task.`;
    case 'read':
      return `The "${binary}" script reads a file it names itself (the "r"/"R" command), which path confinement cannot see. Read that file directly instead.`;
    default:
      return `This classifier could not read the "${binary}" script well enough to rule out a shell command or a file write in it. Rewrite it with plain print, delete and substitute commands, or describe the work as a task.`;
  }
}

/** sed commands that take nothing after them. */
const SED_BARE_COMMANDS = '=dDgGhHnNpPxzF';
/** sed commands that take an optional number. */
const SED_NUMBER_COMMANDS = 'lqQL';

function sedScriptHazard(script: string): Hazard | undefined {
  const n = script.length;
  let i = 0;

  const skipBlanks = () => { while (i < n && (script[i] === ' ' || script[i] === '\t')) i++; };
  const skipDigits = () => { while (i < n && /\d/.test(script[i])) i++; };

  /**
   * A bracket expression inside a regex, entered at its `[`, read the way BSD
   * sed reads it: `\` is literal and `]` right after `[` or `[^` is a member.
   * GNU ignores brackets and ends the regex at an unescaped delimiter wherever
   * it falls, so a delimiter inside one is where the two disagree.
   */
  const readBracket = (delim: string): boolean => {
    i++;
    if (script[i] === '^') i++;
    if (script[i] === ']') i++;
    while (i < n) {
      const c = script[i];
      if (c === '\n') return false;
      if (c === '[' && ':.='.includes(script[i + 1] ?? '')) {
        const close = script.indexOf(`${script[i + 1]}]`, i + 2);
        if (close < 0) return false;
        const inner = script.slice(i, close);
        if (inner.includes(delim) || inner.includes('\n')) return false;
        i = close + 2;
        continue;
      }
      if (c === ']') { i++; return true; }
      // Escaped, both implementations read past it.
      if (c === '\\' && script[i + 1] === delim) { i += 2; continue; }
      if (c === delim) return false;
      i++;
    }
    return false;
  };

  /** Read up to and past the closing `delim`, having consumed the opening one. */
  const readDelimited = (delim: string, regex: boolean): boolean => {
    while (i < n) {
      const c = script[i];
      if (c === '\n') return false;
      if (c === '\\') {
        if (i + 1 >= n || script[i + 1] === '\n') return false;
        i += 2;
        continue;
      }
      if (c === delim) { i++; return true; }
      if (regex && c === '[') {
        if (!readBracket(delim)) return false;
        continue;
      }
      i++;
    }
    return false;
  };

  const readAddress = (second: boolean): boolean => {
    const c = script[i];
    if (c === undefined) return true;
    if (second && (c === '+' || c === '~')) { i++; skipDigits(); return true; }
    if (/\d/.test(c)) {
      skipDigits();
      if (script[i] === '~') { i++; skipDigits(); }
      return true;
    }
    if (c === '$') { i++; return true; }
    if (c === '/' || c === '\\') {
      const delim = c === '/' ? '/' : script[i + 1];
      if (delim === undefined || delim === '\n' || delim === '\\') return false;
      i += c === '/' ? 1 : 2;
      if (!readDelimited(delim, true)) return false;
      while (script[i] === 'I' || script[i] === 'M') i++;
      return true;
    }
    return true;
  };

  /**
   * GNU ends a label at a blank, `;` or `}`; POSIX runs it to the newline.
   * Stopping at the earliest reads anything POSIX keeps in the label as more
   * commands, which can only refuse more, never less.
   */
  const skipLabel = () => { while (i < n && !/[\s;}]/.test(script[i])) i++; };

  /** A command is over: only a separator, a closing brace, a comment or the end may follow. */
  const commandEnds = (): boolean => {
    skipBlanks();
    return i >= n || ';\n}#'.includes(script[i]);
  };

  while (i < n) {
    while (i < n && /[\s;]/.test(script[i])) i++;
    if (i >= n) break;

    if (!readAddress(false)) return 'unreadable';
    skipBlanks();
    if (script[i] === ',') {
      i++;
      skipBlanks();
      if (!readAddress(true)) return 'unreadable';
      skipBlanks();
    }
    while (script[i] === '!') { i++; skipBlanks(); }

    const cmd = script[i++];
    if (cmd === undefined) return 'unreadable';
    if (cmd === 'e') return 'exec';
    if (cmd === 'w' || cmd === 'W') return 'write';
    if (cmd === 'r' || cmd === 'R') return 'read';
    if (cmd === '{' || cmd === '}') continue;
    if (cmd === '#') { while (i < n && script[i] !== '\n') i++; continue; }
    if (SED_BARE_COMMANDS.includes(cmd)) {
      if (!commandEnds()) return 'unreadable';
      continue;
    }
    if (SED_NUMBER_COMMANDS.includes(cmd)) {
      skipBlanks();
      skipDigits();
      if (!commandEnds()) return 'unreadable';
      continue;
    }
    if (cmd === ':' || cmd === 'b' || cmd === 't' || cmd === 'T' || cmd === 'v') {
      skipBlanks();
      skipLabel();
      if (!commandEnds()) return 'unreadable';
      continue;
    }
    // Text for `a`/`i`/`c` runs to the end of the line, `;` included, with a
    // backslash carrying the text onto the next.
    if ('aic'.includes(cmd)) {
      while (i < n && script[i] !== '\n') i += script[i] === '\\' ? 2 : 1;
      continue;
    }
    if (cmd === 's' || cmd === 'y') {
      const delim = script[i];
      if (delim === undefined || delim === '\n' || delim === '\\') return 'unreadable';
      i++;
      if (!readDelimited(delim, cmd === 's') || !readDelimited(delim, false)) return 'unreadable';
      if (cmd === 's') {
        while (i < n) {
          const flag = script[i];
          if (flag === 'e') return 'exec';
          if (flag === 'w') return 'write';
          if (!/[gpiImM\d]/.test(flag)) break;
          i++;
        }
      }
      if (!commandEnds()) return 'unreadable';
      continue;
    }
    return 'unreadable';
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// awk
// ---------------------------------------------------------------------------

/**
 * Options that take nothing. Absent on purpose: gawk's `-o`/`-p`/`-d` write a
 * pretty-print, profile or variable dump to a file, `-D` opens the debugger,
 * `-W` passes through implementation options this classifier does not model,
 * and `-l`/`-i`/`-E` load code from a file.
 */
const AWK_SHORT_BOOLEANS = ['-b', '-c', '-C', '-h', '-M', '-N', '-n', '-O', '-P', '-r', '-s', '-S', '-t', '-V'];
const AWK_LONG_BOOLEANS = ['--characters-as-bytes', '--traditional', '--copyright', '--help', '--bignum',
  '--use-lc-numeric', '--non-decimal-data', '--optimize', '--posix', '--re-interval', '--no-optimize',
  '--sandbox', '--lint-old', '--lint', '--version'];
const AWK_CODE_FILE_FLAGS = ['-f', '-E', '-i', '-l', '--file', '--exec', '--include', '--load'];

/**
 * Why an awk invocation is refused, or `undefined` when its program only reads
 * and prints.
 *
 * Every awk stops reading options at the program text, so unlike sed nothing
 * after it is an option.
 */
export function awkRefusal(binary: string, args: string[]): string | undefined {
  return readAwk(binary, args).refusal;
}

/** Which of `args` are awk program text rather than files, for path confinement. */
export function awkProgramArgs(binary: string, args: string[]): number[] {
  return readAwk(binary, args).programArgs;
}

function readAwk(binary: string, args: string[]): FilterRead {
  const programs: string[] = [];
  const programArgs: number[] = [];
  const unknown = (flag: string): FilterRead => refused(
    `"${flag}" is not a flag this classifier knows on "${binary}", so it cannot tell which argument is the program. Re-run without it.`);

  let i = 0;
  for (; i < args.length; i++) {
    const token = args[i];
    if (token === '--') { i++; break; }
    if (!/^-./.test(token)) break;

    const long = token.startsWith('--');
    const eq = long ? token.indexOf('=') : -1;
    const name = long ? (eq > 0 ? token.slice(0, eq) : token) : token.slice(0, 2);
    const glued = long ? (eq > 0 ? token.slice(eq + 1) : '') : token.slice(2);

    if (AWK_CODE_FILE_FLAGS.includes(name)) {
      return refused(`"${binary} ${name}" loads program code from a file this classifier cannot inspect. ${INSPECT_OR_TASK}`);
    }
    if (name === '-e' || name === '--source') {
      const program = glued || args[++i];
      if (program === undefined) return unknown(token);
      programs.push(program);
      programArgs.push(i);
    } else if (['-F', '-v', '--field-separator', '--assign'].includes(name)) {
      if (!glued) i++;
    } else if (!(long ? AWK_LONG_BOOLEANS.includes(name) && (eq < 0 || name === '--lint') : AWK_SHORT_BOOLEANS.includes(token))) {
      return unknown(long ? name : token);
    }
  }
  if (programs.length === 0 && i < args.length) {
    programs.push(args[i]);
    programArgs.push(i);
  }
  const refusal = awkRefusalFor(binary, programs);
  return refusal ? refused(refusal) : { programArgs };
}

function awkRefusalFor(binary: string, programs: string[]): string | undefined {
  for (const program of programs) {
    switch (awkProgramHazard(program)) {
      case undefined: continue;
      case 'exec':
        return `The "${binary}" program calls "system", which runs a shell command this classifier cannot inspect. ${INSPECT_OR_TASK}`;
      case 'pipe':
        return `The "${binary}" program pipes to or from a command ("|"), which runs it through a shell this classifier cannot inspect. ${INSPECT_OR_TASK}`;
      case 'write':
        return `The "${binary}" program redirects its output to a file (">"). You are a read-only planner — print to standard output instead, or describe the write as a task.`;
      case 'read':
        return `The "${binary}" program reads a file it names itself ("getline <" or an "ARGV" entry), which path confinement cannot see. Name the file as an operand instead.`;
      case 'environment':
        return `The "${binary}" program reads the environment ("ENVIRON"), which holds credentials. Run printenv for the one variable you need, which asks first.`;
      case 'symbol-table':
        return `The "${binary}" program uses "SYMTAB", which gawk reads as every global by name, "ENVIRON" and "ARGV" included. Name the variable you need directly.`;
      case 'extension':
        return `The "${binary}" program uses an "@" form, which loads an extension, includes a source file or calls a function by name — none of which this classifier can inspect. ${INSPECT_OR_TASK}`;
      default:
        return `This classifier could not read the "${binary}" program well enough to rule out a shell command or a file write in it. Rewrite it in a plainer form, or describe the work as a task.`;
    }
  }
  return undefined;
}

const AWK_KEYWORDS = ['BEGIN', 'END', 'BEGINFILE', 'ENDFILE', 'function', 'func', 'if', 'else', 'while',
  'for', 'do', 'break', 'continue', 'next', 'nextfile', 'exit', 'return', 'delete', 'in', 'getline',
  'switch', 'case', 'default', 'print', 'printf'];

/**
 * What a `/` would mean here: the start of a regex literal, a division, or
 * something this reader will not guess at.
 *
 * The distinction is load-bearing. Read a regex as a division, and a `"` inside
 * it opens a string that swallows real code; read a division as a regex, and
 * the `/…/` swallows it instead. So a regex is only recognised where no left
 * operand exists for a division — after `(`, `,`, `{`, `}`, `;`, `!`, `~`,
 * `&&`, `||` or a newline — a division only after something that ends an
 * operand, and a `/` anywhere else is unreadable.
 */
type SlashMeans = 'regex' | 'divide' | 'unclear';

function awkProgramHazard(program: string): Hazard | undefined {
  const n = program.length;
  let i = 0;
  let slash: SlashMeans = 'regex';
  let depth = 0;
  // Set inside a print statement, at the paren depth it began at: only a `>`
  // at that depth is a redirect, `print (a > b)` compares.
  let printDepth: number | undefined;
  // Set after `getline`, at its depth: a `<` there or deeper, before the
  // statement or the enclosing parenthesis ends, names a file to read. A
  // comparison caught by it, `getline > 0 && n < 3`, refuses; reading it as a
  // comparison would let `getline line < f` through.
  let getlineDepth: number | undefined;
  // After `,`, `&&` or `||` a newline continues the statement instead of ending it.
  let continues = false;

  /** Read past a `/…/` or a bracket's `]`, `\` always escaping, a `/` inside a bracket unreadable. */
  const readRegex = (): boolean => {
    i++;
    let bracket = false;
    let firstMember = 0;
    while (i < n) {
      const c = program[i];
      if (c === '\n') return false;
      if (c === '\\') {
        if (i + 1 >= n || program[i + 1] === '\n') return false;
        i += 2;
        continue;
      }
      if (bracket) {
        // gawk keeps going past a `/` inside a bracket; the one-true-awk ends the regex there.
        if (c === '/') return false;
        if (c === '[' && ':.='.includes(program[i + 1] ?? '')) {
          const close = program.indexOf(`${program[i + 1]}]`, i + 2);
          if (close < 0 || program.slice(i, close).includes('/')) return false;
          i = close + 2;
          continue;
        }
        if (c === ']' && i > firstMember) bracket = false;
        i++;
        continue;
      }
      if (c === '/') { i++; return true; }
      if (c === '[') {
        bracket = true;
        i++;
        if (program[i] === '^') i++;
        // `]` right after `[` or `[^` is a member, not the close.
        firstMember = i;
        continue;
      }
      i++;
    }
    return false;
  };

  const readString = (): boolean => {
    i++;
    while (i < n) {
      const c = program[i];
      if (c === '\n') return false;
      if (c === '\\') { i += 2; continue; }
      i++;
      if (c === '"') return true;
    }
    return false;
  };

  while (i < n) {
    const c = program[i];
    if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }
    if (c === '\\') {
      if (program[i + 1] !== '\n') return 'unreadable';
      i += 2;
      continue;
    }
    if (c === '\n' || c === ';') {
      if (c === ';' || !continues) { printDepth = undefined; getlineDepth = undefined; }
      slash = 'regex';
      i++;
      continue;
    }
    if (c === '#') { while (i < n && program[i] !== '\n') i++; continue; }
    continues = false;

    if (c === '"') {
      if (!readString()) return 'unreadable';
      slash = 'divide';
      continue;
    }
    if (c === '/') {
      if (slash === 'unclear') return 'unreadable';
      if (slash === 'regex') {
        if (!readRegex()) return 'unreadable';
        slash = 'divide';
      } else {
        i++;
        slash = 'unclear';
      }
      continue;
    }
    // `|` is a pipe to or from a command, and `|&` a coprocess; only `||` is logic.
    if (c === '|') {
      if (program[i + 1] !== '|') return 'pipe';
      i += 2;
      slash = 'regex';
      continues = true;
      continue;
    }
    if (c === '&') {
      if (program[i + 1] === '&') { i += 2; slash = 'regex'; continues = true; continue; }
      i++;
      slash = 'unclear';
      continue;
    }
    if (c === '@') return 'extension';
    if (c === '>') {
      if (printDepth !== undefined && depth === printDepth) return 'write';
      i++;
      slash = 'unclear';
      continue;
    }
    if (c === '<') {
      if (getlineDepth !== undefined && depth >= getlineDepth) return 'read';
      i++;
      slash = 'unclear';
      continue;
    }
    if (c === '(' || c === '[') { depth++; i++; slash = 'regex'; continue; }
    if (c === ')' || c === ']') {
      depth--;
      if (getlineDepth !== undefined && depth < getlineDepth) getlineDepth = undefined;
      i++;
      slash = 'divide';
      continue;
    }
    if (c === '{' || c === '}') {
      if (c === '}') { printDepth = undefined; getlineDepth = undefined; }
      i++;
      slash = 'regex';
      continue;
    }
    if (c === ',') { i++; slash = 'regex'; continues = true; continue; }
    if (c === '!' || c === '~') { i++; slash = 'regex'; continue; }
    if (/[A-Za-z0-9_.]/.test(c)) {
      const start = i;
      while (i < n && /[A-Za-z0-9_.]/.test(program[i])) i++;
      const word = program.slice(start, i);
      // Any mention, not only a call: there is no reading of `system` in an
      // awk program that is not the built-in.
      if (word === 'system') return 'exec';
      if (word === 'ENVIRON') return 'environment';
      // Assigning an entry adds a file for awk to read after the operands
      // confinement saw; reading one is rare enough to refuse with it.
      if (word === 'ARGV') return 'read';
      // gawk's table of every global by name reaches ENVIRON and ARGV with
      // neither word written, under a name the program can build as it runs
      // (`SYMTAB["EN" "VIRON"]`), so the table itself is the hazard. `awk` may
      // be gawk. FUNCTAB only names functions; calling one through it needs
      // the `@` form refused above.
      if (word === 'SYMTAB') return 'symbol-table';
      if (word === 'getline') getlineDepth = depth;
      if (word === 'print' || word === 'printf') printDepth = depth;
      slash = AWK_KEYWORDS.includes(word) ? 'unclear' : 'divide';
      continue;
    }
    // Any other operator leaves a `/` after it ambiguous.
    i++;
    slash = 'unclear';
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// jq and yq
// ---------------------------------------------------------------------------

/**
 * JSON and YAML filters whose programs reach past the files they are handed:
 * jq's `$ENV` and `env` read the process environment, provider keys included,
 * and `import`/`include` load a module from any directory a `search` key
 * names. yq has `env`, `strenv`, `envsubst` and the `load` family, and its
 * `eval` runs a string as a program, which hides the rest from a reading.
 * `yq` is either that yq or the jq wrapper of the same name, so both
 * vocabularies are read for both (ADR-0008).
 */
export const JQ_FAMILY = ['jq', 'yq'];

const JQ_ENV_WORDS = ['env', 'strenv', 'envsubst'];
const JQ_LOAD_WORDS = ['import', 'include', 'modulemeta', 'eval'];
/** jq's options that take a name and a value. */
const JQ_PAIR_FLAGS = ['--arg', '--argjson', '--slurpfile', '--rawfile'];
/** yq's subcommands, which come before the expression. */
const YQ_SUBCOMMANDS = ['eval', 'e', 'eval-all', 'ea'];

/** Why a jq or yq invocation is refused, or `undefined` when its program only filters what it is given. */
export function jqRefusal(binary: string, args: string[]): string | undefined {
  const programs = jqProgramWords(binary, args);
  if (typeof programs === 'string') {
    return `"${binary} ${programs}" reads its program from a file this classifier cannot inspect. ${INSPECT_OR_TASK}`;
  }
  for (const { text } of programs) {
    const word = jqHazard(text);
    if (word === undefined) continue;
    return JQ_ENV_WORDS.includes(word) || word === '$ENV'
      ? `The "${binary}" program reads the environment ("${word}"), which holds credentials. Run printenv for the one variable you need, which asks first.`
      : `The "${binary}" program uses "${word}", which loads a file or runs a string as a program where this classifier cannot follow it. ${INSPECT_OR_TASK}`;
  }
  return undefined;
}

/**
 * The index of the last word that decides which program a jq or yq invocation
 * runs, as written: its program word, or the last word when none was found,
 * since then a word the shell rewrites may yet become one.
 */
export function jqProgramEnd(binary: string, args: string[]): number {
  const programs = jqProgramWords(binary, args);
  return typeof programs === 'string' || programs.length === 0 ? args.length - 1 : Math.max(...programs.map(({ at }) => at));
}

/**
 * Where an invocation's program text sits in `args`, or the flag that names a
 * program file. jq takes options anywhere, so every token is read; the program
 * is the first operand, or what `--expression` gave. Value widths come from
 * the flag allowlist, which refuses any flag outside it before this reading
 * matters.
 */
function jqProgramWords(binary: string, args: string[]): { at: number; text: string }[] | string {
  const values = new Set(FLAG_POLICY[binary]?.values ?? []);
  const expressions: { at: number; text: string }[] = [];
  const operands: number[] = [];
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (token === '--') { for (let j = i + 1; j < args.length; j++) operands.push(j); break; }
    if (!/^-./.test(token)) { operands.push(i); continue; }
    if (token.startsWith('--')) {
      const eq = token.indexOf('=');
      const name = eq > 0 ? token.slice(0, eq) : token;
      if (name === '--from-file') return name;
      if (name === '--expression') {
        if (eq > 0) expressions.push({ at: i, text: token.slice(eq + 1) });
        else if (++i < args.length) expressions.push({ at: i, text: args[i] });
      } else if (JQ_PAIR_FLAGS.includes(name)) {
        i += 2;
      } else if (values.has(name) && eq < 0) {
        i++;
      }
      continue;
    }
    for (let j = 1; j < token.length; j++) {
      const short = `-${token[j]}`;
      if (short === '-f') return short;
      if (values.has(short)) { if (j === token.length - 1) i++; break; }
    }
  }
  if (binary === 'yq' && YQ_SUBCOMMANDS.includes(args[operands[0]])) operands.shift();
  if (expressions.length > 0) return expressions;
  return operands.length > 0 ? [{ at: operands[0], text: args[operands[0]] }] : [];
}

/**
 * The first word in a program that reaches the environment or another file.
 * String literals are skipped, since `select(.name == "env")` compares text,
 * unless the program interpolates (`"\(env.KEY)"` runs code inside a string)
 * or has a comment (a `"` in one would pair with the wrong quote): then all of
 * it is read. A field (`.env`) and an object key (`{env: …}`) are not calls.
 */
function jqHazard(program: string): string | undefined {
  const code = program.includes('\\(') || program.includes('#')
    ? program
    : program.replace(/"(?:[^"\\]|\\.)*"/gs, '""');
  for (const match of code.matchAll(/(\$?)([A-Za-z_][A-Za-z0-9_]*)/g)) {
    const [, dollar, name] = match;
    const at = match.index;
    if (dollar) {
      if (name === 'ENV') return '$ENV';
      continue;
    }
    if (code[at - 1] === '.' && code[at - 2] !== '.') continue;
    if (/^\s*:(?!:)/.test(code.slice(at + name.length))) continue;
    if (JQ_ENV_WORDS.includes(name) || JQ_LOAD_WORDS.includes(name) || name.startsWith('load')) return name;
  }
  return undefined;
}
