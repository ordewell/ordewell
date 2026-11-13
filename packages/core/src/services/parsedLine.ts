import { dialectFor, lexAll, type Dialect, type Lexed, type Segment } from './shellLexer';
import type { ShellDialect } from './researchShell';

/**
 * The shell a command line will run in, which decides what its words mean.
 *
 * `dialect` is keyed to the interpreter rather than the OS on purpose: a
 * Windows host that has Git Bash runs the planner's commands in a POSIX shell
 * (see `resolveResearchShell`), and reading those under cmd.exe rules would be
 * the same mismatch in the other direction. Omitting it falls back to the host
 * default.
 */
export interface LineShell {
  dialect?: ShellDialect;
  /**
   * `CDPATH` is set in the environment the command will run in. A relative
   * `cd` may then land in a directory the command line never names, so `cd`
   * stops being navigation that can be followed.
   */
  cdpathSet?: boolean;
}

/**
 * One command line, lexed once under one site's shell (ADR-0008's single
 * lexer). Every reader of a line — classification, path confinement, the
 * exclusion and denial checks, the wget probe, the web rewrites — takes this
 * value rather than a string and options, so no two of them can read the same
 * line under different rules: a `cd` followed by one and not by another is a
 * path judged from the wrong directory. Only {@link ParsedLine.parse} makes
 * one, and what it holds is frozen.
 */
export class ParsedLine {
  private constructor(
    /** The line as given: what the shell runs, and what a rewrite edits. */
    readonly raw: string,
    /** {@link raw} trimmed, which is what was lexed: a leading newline must not change what is followed. */
    readonly text: string,
    /** Where {@link text} starts in {@link raw}, to map a word's offset back for a rewrite. */
    readonly offset: number,
    readonly dialect: Dialect,
    readonly cdpathSet: boolean,
    readonly lexed: Readonly<Lexed>,
    /**
     * A line break was trimmed off an end. The wget probe has always read the
     * line as given, where that break ends a list and no `cd` is followed, and
     * it still refuses there, so lexing once widens nothing.
     */
    readonly edgeBreak: boolean,
  ) {}

  static parse(command: string, shell: LineShell = {}): ParsedLine {
    return ParsedLine.lex(command, dialectFor(shell.dialect), shell.cdpathSet ?? false);
  }

  /** A rewrite of this line (startup flags, pinned addresses), read under this line's shell: a rewrite never changes the rules it is read by. */
  reparse(command: string): ParsedLine {
    return ParsedLine.lex(command, this.dialect, this.cdpathSet);
  }

  private static lex(command: string, dialect: Dialect, cdpathSet: boolean): ParsedLine {
    const text = command.trim();
    const offset = command.length - command.trimStart().length;
    const lexed = lexAll(text, dialect, cdpathSet);
    lexed.segments.forEach(freezeSegment);
    Object.freeze(lexed.segments);
    const edgeBreak = command.slice(0, offset).includes('\n') || command.slice(offset + text.length).includes('\n');
    return Object.freeze(new ParsedLine(command, text, offset, dialect, cdpathSet, Object.freeze(lexed), edgeBreak));
  }

  get segments(): readonly Segment[] {
    return this.lexed.segments;
  }

  /** The segments of the line itself, not of a substitution inside it: what a rewrite can edit in place. */
  get topSegments(): readonly Segment[] {
    return this.lexed.segments.filter((seg) => !seg.nested);
  }
}

function freezeSegment(seg: Segment): void {
  for (const value of Object.values(seg)) if (Array.isArray(value)) Object.freeze(value);
  Object.freeze(seg);
}
