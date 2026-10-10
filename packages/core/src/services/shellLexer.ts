/**
 * The lexer behind `classifyCommand` (commandPolicy.ts): a command line becomes segments.
 *
 * Which interpreter will run the line decides what the tokens are (see
 * {@link Dialect}), and `cd`-following lives here because only the lexer sees
 * every operator that makes the shell's directory depend on what ran
 * (ADR-0008). Everything that reads a segment's meaning — the tiers, the
 * wrappers, the flag allowlist — is in the modules that import this one.
 */

import type { ShellDialect } from './researchShell';

/**
 * What the interpreter that will run this command treats as syntax.
 *
 * `BaseFileSystem.execBashImpl` runs the command through `shell: true`, which
 * means `/bin/sh` on POSIX and `cmd.exe` on Windows — two different languages.
 * Lexing cmd.exe input with POSIX rules is not a near-miss, it inverts specific
 * answers: `\` is an escape in sh and an ordinary path separator in cmd, so
 * `rg pattern C:\repo\src` tokenized to `C:reposrc`, which then failed
 * containment against the very workspace it named. And `'` is a quote in sh and
 * a literal character in cmd, so `echo it's & del x` hid the `del` inside what
 * the lexer believed was a quoted string.
 *
 * Only the five rules that actually diverge are modeled. Constructs cmd.exe
 * lacks (`$(…)`, backticks) are still recognized on Windows: over-splitting
 * costs a needless approval prompt, under-splitting costs the gate.
 */
export interface Dialect {
  /** The character that escapes the next one outside quotes. */
  escape: string;
  /**
   * Whether {@link escape} still escapes inside a double-quoted run.
   *
   * POSIX `\` does; cmd.exe `^` does not. Getting this wrong is not cosmetic:
   * with `^` honoured inside quotes, `echo "a^"& del b` lexed as one `echo`
   * segment — the escape swallowed the closing quote, so the `&` looked quoted
   * and the `del` cmd.exe would actually run became an argument nobody
   * classified.
   */
  escapeInQuotes: boolean;
  /** Characters that open a quoted run. */
  quotes: string[];
  /** Matches a variable reference the interpreter will expand. */
  expansion: RegExp;
  /**
   * Whether `$'…'` and `$"…"` are quoting forms of their own (bash's ANSI-C
   * and locale quoting). Read as a literal `$` and a plain quote,
   * `cat $'/etc/passwd'` hid its path behind a `$` no path check recognizes.
   * `$'…'` is not a single-quoted run: `\'` inside it is an escaped quote, so
   * reading it as one ended the string early and `echo $'\''; rm -rf ~ #'`
   * lexed as a lone `echo`. See {@link ansiCQuoteEnd}.
   */
  dollarQuotes: boolean;
  /**
   * Whether `<<` opens a here-document whose body is the lines that follow.
   * cmd.exe has none, so there the lines after it are commands.
   */
  hereDocuments: boolean;
  /**
   * Characters that end a command name with no space before them. cmd.exe
   * reads `cmd/c del x` as `cmd /c del x`, and skips `,` and `=` like spaces,
   * so `,del x` runs `del`. Read by `nameDelimiter` in {@link lex}.
   */
  nameDelimiters: string;
  /** Executable extensions stripped before a binary is matched against the tiers. */
  strippedExtensions: string[];
}

const POSIX_DIALECT: Dialect = {
  escape: '\\',
  escapeInQuotes: true,
  quotes: ["'", '"'],
  // Positional and special parameters (`$1`, `$@`, `$$`, …) expand too.
  expansion: /^\$[A-Za-z_{0-9@*#?$!-]/,
  dollarQuotes: true,
  hereDocuments: true,
  nameDelimiters: '',
  strippedExtensions: [],
};

const CMD_DIALECT: Dialect = {
  escape: '^',
  escapeInQuotes: false,
  quotes: ['"'],
  // `%VAR%` and delayed-expansion `!VAR!`.
  expansion: /^[%!][A-Za-z_]/,
  dollarQuotes: false,
  hereDocuments: false,
  nameDelimiters: '/,=',
  // Without this, `del.exe` and `C:\bin\del.exe` both missed the refusal list.
  strippedExtensions: ['.exe', '.cmd', '.bat', '.com', '.ps1', '.msc'],
};

export function dialectFor(dialect: ShellDialect | undefined): Dialect {
  const resolved = dialect ?? (process.platform === 'win32' ? 'cmd' : 'posix');
  return resolved === 'cmd' ? CMD_DIALECT : POSIX_DIALECT;
}

export interface Segment {
  binary: string;
  args: string[];
  /**
   * Leading `VAR=value` tokens, as written.
   *
   * Retained rather than discarded: the assignment is what decides what the
   * binary does — `LD_PRELOAD` loads attacker code into it, `PATH` changes
   * which executable is even reached — so classifying the binary alone answers
   * the wrong question. See `refusalFor` in commandPolicy.ts.
   */
  assignments: string[];
  /** True when this segment consumes another command's output (`… | seg`). */
  piped: boolean;
  /**
   * Stdin comes from a redirect, here-document or here-string. Kept apart from
   * {@link piped}: an interpreter reads its code from either, but `xargs` is
   * only refused for a pipe, since its documented use is `xargs … < list`.
   */
  stdinRedirected: boolean;
  /**
   * A token contains a `$var` or a substitution the shell will expand. Tracked
   * at lex time because only the lexer knows a `$` inside single quotes is
   * literal.
   */
  expandable: boolean;
  /**
   * A word holds an unquoted `*`, `?` or `[`: the shell may replace it with
   * file names the command line never spells, a repository file named
   * `--server=…` among them.
   */
  globbed: boolean;
  /** The binary token as written, when the shell computes it — see {@link isComputedWord}. */
  computedBinary?: string;
  /**
   * The binary token as written, when it is a path (`./bin/gh`): what runs is
   * that file, perhaps one the repository ships, not the program {@link binary} names.
   */
  binaryPath?: string;
  /**
   * Files read through `<`, kept apart from `args` because the shell never
   * passes them to the command. For path confinement only.
   */
  inputs: string[];
  /** What joined this segment to the one before it; absent for the first. */
  joinedBy?: 'and' | 'pipe' | 'other';
  /**
   * The literal `cd` targets, in order, that are certain to have run in the
   * shell executing this segment — see {@link followCd}. Only on top-level
   * segments of a command simple enough to follow.
   */
  cwd?: string[];
  /** Something else on the line can change where this `cd` lands — see {@link markShellState}. */
  cdSteered?: boolean;
  /**
   * A cmd.exe command word this lexer cannot read as a clean name: it holds a
   * `/` (cmd ends a name there, so `C:/…/rm.exe` is a drive plus a switch, not a
   * path) or a `=` (cmd has no `NAME=value cmd` prefix). Refused rather than
   * basenamed, where the basename would drop the part that decides what runs.
   */
  ambiguousCmdName?: string;
}

/** An output redirect whose target is not provably a no-op (`/dev/null`, an fd duplication). */
export interface UnsafeRedirect {
  /** The operator as written, fd prefix included: `>`, `2>`, `>>`, `&>`. */
  operator: string;
  /** The target text as the shell would see it, or `''` if the redirect had none. */
  target: string;
}

export interface Lexed {
  segments: Segment[];
  /** Set for the first output redirect that isn't `/dev/null` or an fd duplication. */
  unsafeRedirect?: UnsafeRedirect;
  /** An unquoted `(` or `)`: a subshell, whose `cd` does not outlive it. */
  grouped: boolean;
  /** An unquoted `<(…)`/`>(…)` spawns a process this classifier never tokenizes. */
  processSubstitution: boolean;
  /** Lexing ran off the end inside a quote or a substitution — nothing here is trustworthy. */
  unbalanced: boolean;
  /** A substitution holds a construct that hides where it ends — see {@link matchParen}. */
  unreadable?: boolean;
  /**
   * An unquoted `(( … ))` arithmetic command. The lexer does not evaluate
   * arithmetic, and a `<<` inside it is a left-shift, not a here-document — so
   * rather than read it wrong, the whole line is refused.
   */
  arithmetic?: boolean;
  /**
   * A cmd.exe command word starts with `/`. cmd.exe reads it as a switch, and
   * after a `;` — a space to cmd.exe, a separator here — as one belonging to
   * the command before it: `cmd;/c del x` runs `del`.
   */
  switchName?: string;
  /** Substitution bodies were left unlexed when {@link lexAll} hit its bound. */
  truncated?: boolean;
  /**
   * The line is commands joined only by `&&` and `|`, each with a command
   * name — the one shape {@link followCd} can follow. Decided here, where every
   * operator is seen, because a segment that never becomes a {@link Segment} (a
   * bare `X=1`, a redirect alone) can still carry the `||` or `;` that makes the
   * shell's directory depend on what ran.
   */
  followable: boolean;
  /** A segment that ran no command, only an assignment or a redirect: it may have set `CDPATH`. */
  bareSegment: boolean;
}

/**
 * Whether a redirect target resolves to `/dev/null` — the one write target that
 * writes nothing. Resolved by segment, not by substring match: `/dev/null/../x`
 * must not slip through as a no-op just because it starts with the right prefix.
 */
function isDevNullTarget(target: string): boolean {
  if (!target.startsWith('/')) return false;
  const resolved: string[] = [];
  for (const seg of target.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') resolved.pop();
    else resolved.push(seg);
  }
  return `/${resolved.join('/')}` === '/dev/null';
}

/** {@link matchParen} met a construct only a parser could find the end of. */
const UNREADABLE = -2;

/**
 * Index of the `)` closing the `$(` whose `(` is at `open`; -1 when the line
 * ends first, or {@link UNREADABLE}.
 *
 * The shell parses the body as a command line of its own, so a quoted or
 * escaped `)` does not close it. Counting bare parens closed
 * `"$(echo \); rm -rf ~)"` at the `\)` and left the `rm` inside what the lexer
 * took for a quoted string. Three constructs can hide a `)` from any scan short
 * of a parser, and each answers UNREADABLE so the caller refuses: a
 * here-document, a comment, and a `${…}` expansion, whose quoting rules differ
 * by operator — `"$(ls ${x%)}; rm -rf ~)"` closed at the `)` of its pattern.
 * A `${…}` holding no quote, paren, escape or nested expansion is skipped.
 */
function matchParen(s: string, open: number, dialect: Dialect): number {
  let depth = 0;
  let quote = '';
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (quote === "'") { if (c === "'") quote = ''; continue; }
    if (c === dialect.escape && (quote === '' || dialect.escapeInQuotes)) { i++; continue; }
    if (dialect.dollarQuotes && quote === '' && c === '$' && s[i + 1] === "'") {
      const end = ansiCQuoteEnd(s, i + 2);
      if (end < 0) return -1;
      i = end; continue;
    }
    if (c === '$' && s[i + 1] === '{') {
      const end = s.indexOf('}', i + 2);
      if (end < 0) return -1;
      if (/[()'"`$\\{\n]/.test(s.slice(i + 2, end))) return UNREADABLE;
      i = end; continue;
    }
    if (c === '$' && s[i + 1] === '(') {
      const close = matchParen(s, i + 1, dialect);
      if (close < 0) return close;
      i = close; continue;
    }
    if (c === '`') {
      const close = matchBacktick(s, i, dialect);
      if (close < 0) return -1;
      i = close; continue;
    }
    if (quote === '"') { if (c === '"') quote = ''; continue; }
    if (dialect.quotes.includes(c)) { quote = c; continue; }
    if (c === '<' && s.startsWith('<<<', i)) { i += 2; continue; }
    if (c === '<' && s[i + 1] === '<') return UNREADABLE;
    if (c === '#' && (i === open + 1 || /[\s;&|(]/.test(s[i - 1]))) return UNREADABLE;
    if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return i;
  }
  return -1;
}

/**
 * Index of the backtick closing the one at `open`, or -1. Quotes do not protect
 * a backtick here, in the shell either; only an escape does.
 */
function matchBacktick(s: string, open: number, dialect: Dialect): number {
  for (let i = open + 1; i < s.length; i++) {
    if (s[i] === dialect.escape) i++;
    else if (s[i] === '`') return i;
  }
  return -1;
}

/**
 * Index of the `'` closing a `$'…'` whose body starts at `start`, or -1.
 * Unlike a single-quoted run, a backslash escapes the next character, `\'`
 * included.
 */
function ansiCQuoteEnd(s: string, start: number): number {
  for (let i = start; i < s.length; i++) {
    if (s[i] === '\\') i++;
    else if (s[i] === "'") return i;
  }
  return -1;
}

/** A backtick body as the shell runs it: inside backticks `\`` is a nested substitution, not a literal backtick. */
function backtickBody(body: string, dialect: Dialect): string {
  return dialect.escape === '\\' ? body.replace(/\\([$`\\])/g, '$1') : body;
}

interface HereDocument {
  delimiter: string;
  /** Any part of the delimiter was quoted, so the body is not expanded. */
  quoted: boolean;
  /** `<<-`: leading tabs are stripped from the body and the delimiter line. */
  stripTabs: boolean;
}

/**
 * Skip the here-document bodies that start at `start`, returning the index
 * after the last delimiter line, -1 when one is never closed, or
 * {@link UNREADABLE}.
 *
 * A body is data, not commands. Lexed as commands, a quote in it opened a
 * string that hid the lines after the delimiter: `cat <<EOF\n'\nEOF\nrm -rf ~ #'`
 * lexed as one `cat`. An unquoted delimiter still expands the body, so its
 * substitutions run and are queued in `nested` like any other.
 */
function skipHereDocuments(s: string, start: number, docs: HereDocument[], nested: string[], dialect: Dialect): number {
  let pos = start;
  for (const doc of docs) {
    const bodyStart = pos;
    let bodyEnd = -1;
    while (pos < s.length) {
      const newline = s.indexOf('\n', pos);
      const lineEnd = newline < 0 ? s.length : newline;
      const line = s.slice(pos, lineEnd);
      const lineStart = pos;
      pos = newline < 0 ? s.length : newline + 1;
      if ((doc.stripTabs ? line.replace(/^\t+/, '') : line) === doc.delimiter) { bodyEnd = lineStart; break; }
    }
    if (bodyEnd < 0) return -1;
    if (doc.quoted) continue;
    const body = s.slice(bodyStart, bodyEnd);
    for (let i = 0; i < body.length; i++) {
      if (body[i] === '\\') { i++; continue; }
      if (body[i] === '$' && body[i + 1] === '(') {
        const close = matchParen(body, i + 1, dialect);
        if (close < 0) return close;
        nested.push(body.slice(i + 2, close));
        i = close;
      } else if (body[i] === '`') {
        const close = matchBacktick(body, i, dialect);
        if (close < 0) return -1;
        nested.push(backtickBody(body.slice(i + 1, close), dialect));
        i = close;
      }
    }
  }
  return pos;
}

/**
 * Tokenize one command line the way a shell would: quotes and backslashes are
 * consumed, and only *unquoted* metacharacters are operators.
 *
 * This is the whole difference between the classifier seeing what will run and
 * seeing the raw string. Splitting on a bare `/[|;&]/` made `rg "error|warn"`
 * two segments (so the planner's commonest search asked for approval, scoped to
 * the nonsense binary `warn"`), while leaving quotes on argument tokens hid
 * `cat "/etc/passwd"` from the path-confinement check entirely.
 *
 * Substitution bodies are lifted out into `nested` and classified as their own
 * command lines, so `$(rm -rf /)` cannot hide inside an `echo`.
 */
export function lex(command: string, nested: string[], dialect: Dialect): Lexed {
  const segments: Segment[] = [];
  let unsafeRedirect: UnsafeRedirect | undefined;
  let processSubstitution = false;
  let unbalanced = false;
  let unreadable = false;
  let arithmetic = false;
  let switchName: string | undefined;
  let grouped = false;
  let joinedBy: Segment['joinedBy'];
  let followable = true;
  let bareSegment = false;

  let tokens: string[] = [];
  let expandable = false;
  let globbed = false;
  let current = '';
  let started = false;
  let piped = false;
  let stdinRedirected = false;
  let quote = '';

  // Set while lexing the word after a redirect operator, so that word is
  // captured as the redirect's operand instead of pushed onto the segment as an
  // ordinary argument. An input redirect's word used to be pushed: it can come
  // first, so `< cat rm x` lexed as a `cat` while the shell ran `rm x`. `data`
  // is a here-string, and `heredoc` a here-document delimiter; neither names a file.
  let redirectTarget: 'write' | 'read' | 'data' | 'heredoc' | undefined;
  let redirectOperator = '';
  let inputs: string[] = [];

  // Here-documents opened on the current line, whose bodies start after its newline.
  const hereDocs: HereDocument[] = [];
  let hereDocQuoted = false;
  let hereDocStripTabs = false;

  // Brace expansion (`{a,b}`, `{1..3}`) in the current word, unquoted: bash
  // turns it into other words before anything runs.
  let braceOpen = false;
  let braceList = false;

  // An unquoted `#` has opened a comment that runs to the end of this physical
  // line. The lexer does not otherwise model comments (it over-refuses a `;` or
  // `rm` written in one, which is safe), but a `<<` in a comment is not a
  // here-document, so while this is set no here-document is opened.
  let inComment = false;

  const endToken = (hardBoundary = true) => {
    braceOpen = false;
    braceList = false;
    if (redirectTarget) {
      // Whitespace right after the operator (`2> /dev/null`) is not the end of
      // the target — keep waiting rather than concluding there is none.
      if (!started && !hardBoundary) return;
      if (redirectTarget === 'write' && !unsafeRedirect && !isDevNullTarget(current)) {
        unsafeRedirect = { operator: redirectOperator, target: current };
      }
      if (redirectTarget === 'read' && started) inputs.push(current);
      if (redirectTarget === 'heredoc') {
        // The shell does not expand a delimiter, so a `$` in one is spelled in
        // a way this lexer does not track; and with no delimiter there is no body end.
        if (!started) unbalanced = true;
        else if (/[$`]/.test(current)) unreadable = true;
        else hereDocs.push({ delimiter: current, quoted: hereDocQuoted, stripTabs: hereDocStripTabs });
        hereDocQuoted = false;
      }
      redirectTarget = undefined;
      current = '';
      started = false;
      return;
    }
    if (started) tokens.push(current);
    current = '';
    started = false;
  };
  // cmd.exe ends a command name at an unquoted `/` or `,` and skips `,` and
  // `=` before one — escaped ones too, since it strips `^` before reading the
  // name. A `=` inside the name is left alone, and a `/` after a drive letter
  // is not split off: either leaves the word holding a delimiter, which
  // `toSegment` refuses rather than basename down to the wrong name.
  const nameDelimiter = (ch: string): boolean => {
    if (!dialect.nameDelimiters.includes(ch) || tokens.length > 0 || redirectTarget) return false;
    if (!started) {
      if (ch !== '/') return true;
      switchName ??= /^\S*/.exec(command.slice(i))?.[0];
      return false;
    }
    if (ch === '=') return false;
    // `C:/…` is one drive-absolute path, not the drive `C:` plus a `/switch`.
    if (ch === '/' && /^[A-Za-z]:/.test(current)) return false;
    endToken();
    if (ch === '/') { current = ch; started = true; }
    return true;
  };
  const endSegment = (nextPiped: boolean, next: Segment['joinedBy'] = 'other', last = false) => {
    endToken();
    if (!last && next === 'other') followable = false;
    if (tokens.length > 0) {
      const seg = toSegment(tokens, piped, dialect);
      if (!seg.binary) { followable = false; bareSegment = true; }
      segments.push({ ...seg, expandable, globbed, stdinRedirected, inputs, joinedBy });
    } else if (!last || segments.length > 0 || joinedBy !== undefined) {
      // Nothing ran here, or only a redirect did, yet an operator still joined it.
      followable = false;
      bareSegment = true;
    }
    tokens = [];
    inputs = [];
    expandable = false;
    globbed = false;
    stdinRedirected = false;
    piped = nextPiped;
    joinedBy = next;
  };

  let i = 0;
  while (i < command.length) {
    const c = command[i];

    // A single-quoted run is literal end to end — no escapes, no expansion.
    // Only POSIX has one; `CMD_DIALECT.quotes` omits `'` so this never fires
    // there, and an apostrophe stays an ordinary character.
    if (quote === "'") {
      if (c === "'") { quote = ''; i++; continue; }
      current += c; started = true; i++; continue;
    }

    // `quote` is '' or '"' here — the single-quote run returned above.
    if (c === dialect.escape && (quote === '' || dialect.escapeInQuotes)) {
      const next = command[i + 1];
      if (redirectTarget === 'heredoc') hereDocQuoted = true;
      if (next !== undefined && !(quote === '' && nameDelimiter(next))) { current += next; started = true; }
      i += 2; continue;
    }

    // Substitutions expand inside double quotes too, so these precede the
    // double-quote passthrough below.
    // The substitution stays in the token as written: what it expands to is
    // decided when the shell runs, and dropping it left an empty word — which
    // as a command name took the whole segment out of classification.
    if (c === '$' && command[i + 1] === '(') {
      const close = matchParen(command, i + 1, dialect);
      if (close === UNREADABLE) { unreadable = true; break; }
      if (close < 0) { unbalanced = true; break; }
      nested.push(command.slice(i + 2, close));
      current += command.slice(i, close + 1); started = true; expandable = true;
      i = close + 1; continue;
    }
    if (c === '`') {
      const close = matchBacktick(command, i, dialect);
      if (close < 0) { unbalanced = true; break; }
      nested.push(backtickBody(command.slice(i + 1, close), dialect));
      current += command.slice(i, close + 1); started = true; expandable = true;
      i = close + 1; continue;
    }
    if (dialect.dollarQuotes && quote === '' && c === '$' && command[i + 1] === "'") {
      const end = ansiCQuoteEnd(command, i + 2);
      if (end < 0) { unbalanced = true; break; }
      // Kept undecoded, `$` included: the word is computed either way.
      expandable = true;
      current += `$${command.slice(i + 2, end)}`; started = true;
      i = end + 1; continue;
    }
    if (dialect.dollarQuotes && quote === '' && c === '$' && command[i + 1] === '"') {
      expandable = true;
      current += c; started = true; i++; continue;
    }
    // `${…}` and old-style `$[…]` arithmetic are consumed whole, so a `<<`
    // inside one (`${x:-a<<b}`, `$[1<<2]`) is never read as a here-document
    // operator. A nested construct could hide where the expansion ends — the
    // same risk `matchParen` refuses inside `$(…)` — so one refuses rather than
    // guess; a plain expansion is kept in the word as written.
    if (dialect.dollarQuotes && (command[i + 1] === '{' || command[i + 1] === '[') && c === '$') {
      const closeCh = command[i + 1] === '{' ? '}' : ']';
      const end = command.indexOf(closeCh, i + 2);
      if (end < 0) { unbalanced = true; break; }
      if (/[()'"`$\\{\n]/.test(command.slice(i + 2, end))) { unreadable = true; break; }
      current += command.slice(i, end + 1); started = true; expandable = true;
      i = end + 1; continue;
    }
    if (dialect.expansion.test(command.slice(i, i + 2))) {
      expandable = true;
      current += c; started = true; i++; continue;
    }

    if (quote === '"') {
      if (c === '"') { quote = ''; started = true; i++; continue; }
      current += c; started = true; i++; continue;
    }

    if (dialect.quotes.includes(c)) {
      if (redirectTarget === 'heredoc') hereDocQuoted = true;
      quote = c; started = true; i++; continue;
    }

    if (c === '<' || c === '>') {
      if (command[i + 1] === '(') { processSubstitution = true; i += 2; continue; }

      // `2>err.log`: the fd is glued to the operator with no space, so it
      // accumulated in `current` as a plain-looking token — pull it back out
      // rather than let it fall through to `endToken` as a spurious argument.
      let fd = '';
      if (started && /^[0-9]+$/.test(current)) {
        fd = current;
        current = '';
        started = false;
      } else {
        endToken();
      }

      // `<<<` is a here-string; `>>>` is not an operator, and its third `>`
      // opens a second redirect.
      const run = c === '<' && command.startsWith('<<<', i) ? 3 : command[i + 1] === c ? 2 : 1;
      // Any fd and a duplication count too: telling which one the program reads
      // its code from is not worth the risk of getting it wrong.
      if (c === '<') stdinRedirected = true;

      // `2>&1` / `>&2` / `<&3`: duplicates a stream, opens no file — safe.
      const dup = /^&([0-9]+|-)(?![0-9])/.exec(command.slice(i + run));
      if (dup) {
        i += run + dup[0].length;
        continue;
      }
      if (c === '>') {
        redirectTarget = 'write';
        redirectOperator = fd + c.repeat(run);
      } else if (run === 2 && dialect.hereDocuments && !inComment) {
        redirectTarget = 'heredoc';
        hereDocStripTabs = command[i + run] === '-';
        if (hereDocStripTabs) i++;
      } else {
        redirectTarget = run === 1 ? 'read' : 'data';
      }
      i += run;
      continue;
    }

    // `&>file` / `&>>file`: bash shorthand for redirecting stdout+stderr to a
    // file. Must be checked before the `&`-as-operator branch below.
    if (c === '&' && command[i + 1] === '>') {
      endToken();
      const doubled = command[i + 2] === '>';
      redirectTarget = 'write';
      redirectOperator = doubled ? '&>>' : '&>';
      i += doubled ? 3 : 2;
      continue;
    }

    // `(( … ))` arithmetic: a `<<` inside it is a left-shift, not a
    // here-document, and the lexer does not evaluate arithmetic — refuse rather
    // than read it as either. `$((…))` never reaches here: its `$(` is consumed
    // above. A genuine nested subshell `( (…) )` has a space between the parens.
    if (c === '(' && command[i + 1] === '(' && dialect.dollarQuotes) { arithmetic = true; break; }

    // Subshell grouping is not part of any token: `(rm -rf /)` must lex to `rm`.
    if (c === '(' || c === ')') { endToken(); grouped = true; i++; continue; }

    if (c === '|') {
      const double = command[i + 1] === '|';
      // `|&` pipes stderr too — still a pipe, not a `|` and a separate `&`.
      endSegment(!double, double ? 'other' : 'pipe');
      i += double || command[i + 1] === '&' ? 2 : 1;
      continue;
    }
    if (c === '&' || c === ';' || c === '\n') {
      endSegment(false, c === '&' && command[i + 1] === '&' ? 'and' : 'other');
      if (c === '\n') inComment = false;
      if (c === '\n' && hereDocs.length > 0) {
        const end = skipHereDocuments(command, i + 1, hereDocs.splice(0), nested, dialect);
        if (end === UNREADABLE) { unreadable = true; break; }
        if (end < 0) { unbalanced = true; break; }
        i = end; continue;
      }
      i += command[i + 1] === c ? 2 : 1;
      continue;
    }

    if (/\s/.test(c)) { endToken(false); i++; continue; }
    if (quote === '' && nameDelimiter(c)) { i++; continue; }

    // A `#` at a word boundary opens a comment for the rest of this line; only
    // its effect on here-document opening is modeled (see {@link inComment}).
    if (c === '#' && !started && dialect.hereDocuments) inComment = true;
    else if (c === '{') braceOpen = true;
    else if (braceOpen && (c === ',' || (c === '.' && command[i + 1] === '.'))) braceList = true;
    else if (braceOpen && braceList && c === '}') expandable = true;
    else if (c === '*' || c === '?' || c === '[') globbed = true;
    current += c; started = true; i++;
  }

  if (quote !== '') unbalanced = true;
  endSegment(false, 'other', true);
  // The line ended before a body began: a here-document that never closed.
  if (hereDocs.length > 0) unbalanced = true;

  return { segments, unsafeRedirect, processSubstitution, unbalanced, unreadable, arithmetic, switchName, grouped, followable, bareSegment };
}

/**
 * The name a segment's binary is matched against the tiers under.
 *
 * `path.basename` alone is not enough: Node's POSIX `path` does not split on
 * `\`, so `C:\Windows\System32\del.exe` came back whole and matched nothing in
 * `REFUSED_COMMANDS`. Both separators are stripped regardless of host, and the
 * dialect decides whether an executable extension comes off too.
 */
export function binaryName(token: string, dialect: Dialect): string {
  const base = token.split(/[/\\]/).pop() ?? '';
  // `dot > 0`, not `>= 0`: `lastIndexOf` returns -1 for a name with no dot, and
  // `slice(-1)` would then make the last character look like the extension.
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return base;
  return dialect.strippedExtensions.includes(base.slice(dot).toLowerCase()) ? base.slice(0, dot) : base;
}

/** A `NAME=value` or `NAME+=value` token, in the one position a shell treats as an assignment. */
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*\+?=/;

/**
 * Whether the shell, not the command line, decides what this word says: it
 * holds a substitution, an expansion or a brace list. Quotes are gone by now,
 * so a `$` or a brace the command line quoted counts too — harmless for a
 * command name, since no program is named with one.
 */
function isComputedWord(token: string, dialect: Dialect): boolean {
  if (/[$`]/.test(token) || /\{[^{}]*(?:,|\.\.)[^{}]*\}/.test(token)) return true;
  for (let i = 0; i < token.length; i++) if (dialect.expansion.test(token.slice(i, i + 2))) return true;
  return false;
}

export function toSegment(tokens: string[], piped: boolean, dialect: Dialect): Segment {
  const rest = [...tokens];
  const assignments: string[] = [];
  // `FOO=bar cmd` — assignments precede the binary. Kept on the segment, not
  // dropped: they are refused, and the message has to name the one it saw. Only
  // a POSIX shell has this prefix form; cmd.exe has no `NAME=value cmd`, so
  // there a `=`-bearing word is a command name, caught by {@link ambiguousCmdName}.
  const hasAssignments = !dialect.nameDelimiters.includes('=');
  while (hasAssignments && rest.length > 0 && ASSIGNMENT.test(rest[0])) assignments.push(rest.shift()!);
  const first = rest[0];
  // A cmd.exe command word holding a `/` or `=` cannot be read as a clean name:
  // cmd ends a name at `/` (so the basename would drop the part after it) and
  // has no assignment prefix. The policy refuses it rather than basename down.
  const ambiguousCmdName = dialect.nameDelimiters.includes('/') && first !== undefined && /[/=]/.test(first)
    ? first : undefined;
  return {
    binary: first !== undefined ? binaryName(first, dialect) : '',
    args: rest.slice(1),
    assignments,
    piped,
    stdinRedirected: false,
    expandable: false,
    globbed: false,
    inputs: [],
    ...(first !== undefined && isComputedWord(first, dialect) ? { computedBinary: first } : {}),
    ...(first !== undefined && /[/\\]/.test(first) ? { binaryPath: first } : {}),
    ...(ambiguousCmdName !== undefined ? { ambiguousCmdName } : {}),
  };
}

/** Lex a command line and every substitution body nested inside it. */
export function lexAll(command: string, dialect: Dialect, cdpathSet = false): Lexed {
  const queue: string[] = [];
  const top = lex(command, queue, dialect);
  const all: Lexed = { ...top, segments: top.segments.filter((s) => s.binary) };
  markShellState(all.segments, top.bareSegment);
  if (top.followable && !top.grouped && queue.length === 0 && !cdpathSet) followCd(all.segments);

  // Bounded: a pathological `$($($(…)))` must not spin here.
  for (let depth = 0; depth < 32 && queue.length > 0; depth++) {
    const inner = lex(queue.shift()!, queue, dialect);
    all.segments.push(...inner.segments.filter((s) => s.binary));
    all.unsafeRedirect ??= inner.unsafeRedirect;
    all.processSubstitution ||= inner.processSubstitution;
    all.unbalanced ||= inner.unbalanced;
    all.unreadable ||= inner.unreadable;
    all.arithmetic ||= inner.arithmetic;
    all.switchName ??= inner.switchName;
  }
  // Whatever is still queued would run unclassified.
  if (queue.length > 0) all.truncated = true;
  return all;
}

/**
 * A `cd` whose target is one literal word: no variable, no substitution, no
 * flag (`-P`, `-`), no `~`, no glob, no second operand. Bare `cd` goes home and `cd -`
 * goes to `$OLDPWD`, neither named on the command line.
 */
export function literalCdTarget(seg: Segment): string | undefined {
  if (seg.binary !== 'cd' || seg.assignments.length > 0 || seg.expandable || seg.inputs.length > 0) return undefined;
  if (seg.args.length !== 1) return undefined;
  const [target] = seg.args;
  // A glob is expanded by the shell to a name this command line does not spell.
  return target === '' || target.startsWith('-') || target.startsWith('~') || /[*?[]/.test(target) ? undefined : target;
}

/**
 * Record on each segment the `cd` targets that are certain to have run before
 * it, so path confinement resolves a relative path from where the shell will
 * actually be rather than from the workspace root. `cd api && cat ../web/x`
 * reads inside the workspace; judged from the root it climbs out of it.
 *
 * This is deliberately a small fragment of the shell, because a wrong answer
 * here is a read outside the workspace judged as inside it. It is followed only
 * where the command is a list of pipelines joined by `&&`: a failed `cd` then
 * ends the list, so everything after it ran in the new directory. Any `;`,
 * `||`, `&`, newline, subshell or substitution makes the shell's directory
 * depend on what ran, and nothing is followed. A `cd` inside a multi-stage
 * pipeline runs in a subshell and is skipped, and the directory it sits in
 * is the one its stages share.
 */
export function followCd(segments: Segment[]): void {
  if (segments.some((s) => s.joinedBy === 'other' || SHELL_STATE_COMMANDS.has(s.binary))) return;
  const inPipeline = (i: number) => segments[i].joinedBy === 'pipe' || segments[i + 1]?.joinedBy === 'pipe';
  // A `cd` it cannot read leaves the shell somewhere unknown for the rest of the line.
  if (segments.some((s, i) => s.binary === 'cd' && !inPipeline(i) && literalCdTarget(s) === undefined)) return;
  let chain: string[] = [];
  segments.forEach((seg, i) => {
    seg.cwd = chain;
    const target = inPipeline(i) ? undefined : literalCdTarget(seg);
    if (target !== undefined) chain = [...chain, target];
  });
}

/**
 * A `cd` stays navigation only while nothing else on the line can redirect it.
 * A bare `CDPATH=…` or a state-changing builtin can send a bare-name `cd`
 * somewhere no argument names, which the root-judged fallback cannot see —
 * so on such a line `cd` is no longer `auto`.
 */
function markShellState(segments: Segment[], bareSegment: boolean): void {
  if (!bareSegment && !segments.some((s) => SHELL_STATE_COMMANDS.has(s.binary))) return;
  for (const seg of segments) if (seg.binary === 'cd') seg.cdSteered = true;
}

/**
 * Builtins that change what a later `cd` or path means in the same shell:
 * `CDPATH` and `cdable_vars` redirect a bare-name `cd`, and the directory
 * stack, `eval` and `source` move the shell where the line does not say.
 */
export const SHELL_STATE_COMMANDS = new Set([
  'export', 'set', 'shopt', 'declare', 'typeset', 'readonly', 'local', 'unset', 'let',
  'source', '.', 'eval', 'exec', 'pushd', 'popd', 'alias', 'unalias', 'builtin', 'command', 'enable', 'hash', 'trap',
]);
