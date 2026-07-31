/**
 * Definition-shaped search patterns for the `find_symbol` tool.
 *
 * Plain `grep` is bad at the question the planner actually asks. Searching for
 * `VerdictEngine` returns every import, call site, comment and string alongside
 * the one line that defines it, and with a hard result cap the definition is
 * often not even in the returned page. `find_symbol` spends the budget on
 * declarations first and reports references as a count plus a sample.
 *
 * This is deliberately regex over a real parser. An LSP-grade answer would mean
 * shipping per-language servers and waiting for them to index — the wrong trade
 * for the half of the architecture whose whole point is being cheap and fast.
 * The planner needs to scope tasks ("defined here, used across ~14 files in 3
 * packages"), not to prove rename-safety; that is the runner's job, and runners
 * have their own tools.
 *
 * Patterns target the Rust regex syntax ripgrep uses: non-capturing groups and
 * `\b` are available, lookaround and backreferences are not.
 */

export interface SymbolLanguage {
  id: string;
  extensions: string[];
  /** Keywords that introduce a declaration in `kw Name` position. */
  keywords: string[];
}

export const SYMBOL_LANGUAGES: SymbolLanguage[] = [
  {
    id: 'typescript',
    extensions: ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'],
    keywords: ['function', 'class', 'interface', 'type', 'enum', 'const', 'let', 'var', 'namespace', 'module'],
  },
  { id: 'python', extensions: ['.py', '.pyi'], keywords: ['def', 'class'] },
  { id: 'go', extensions: ['.go'], keywords: ['func', 'type', 'var', 'const', 'package'] },
  {
    id: 'rust',
    extensions: ['.rs'],
    keywords: ['fn', 'struct', 'enum', 'trait', 'type', 'const', 'static', 'mod', 'impl', 'union', 'macro_rules!'],
  },
  {
    id: 'jvm',
    extensions: ['.java', '.kt', '.kts', '.scala', '.groovy'],
    keywords: ['class', 'interface', 'enum', 'record', 'object', 'trait', 'val', 'var', 'fun', 'def'],
  },
  {
    id: 'csharp',
    extensions: ['.cs', '.fs', '.fsi'],
    keywords: ['class', 'interface', 'enum', 'struct', 'record', 'namespace', 'delegate', 'let', 'type'],
  },
  {
    id: 'c',
    extensions: ['.c', '.h', '.cc', '.cpp', '.cxx', '.hpp', '.hh', '.hxx', '.m', '.mm'],
    keywords: ['struct', 'class', 'enum', 'union', 'typedef', 'namespace', 'define'],
  },
  { id: 'ruby', extensions: ['.rb', '.rake', '.gemspec'], keywords: ['def', 'class', 'module'] },
  { id: 'php', extensions: ['.php'], keywords: ['function', 'class', 'interface', 'trait', 'enum', 'const'] },
  {
    id: 'swift',
    extensions: ['.swift'],
    keywords: ['func', 'class', 'struct', 'enum', 'protocol', 'extension', 'var', 'let', 'typealias'],
  },
  { id: 'elixir', extensions: ['.ex', '.exs'], keywords: ['def', 'defp', 'defmodule', 'defstruct', 'defmacro'] },
  { id: 'shell', extensions: ['.sh', '.bash', '.zsh'], keywords: ['function'] },
  { id: 'lua', extensions: ['.lua'], keywords: ['function', 'local'] },
  { id: 'dart', extensions: ['.dart'], keywords: ['class', 'enum', 'mixin', 'typedef', 'extension', 'var', 'final'] },
];

/** Escape a symbol so it is matched literally inside a generated pattern. */
export function escapeRegex(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function languageForId(id: string): SymbolLanguage | undefined {
  const wanted = id.trim().toLowerCase();
  return SYMBOL_LANGUAGES.find((l) => l.id === wanted)
    ?? SYMBOL_LANGUAGES.find((l) => l.extensions.includes(wanted.startsWith('.') ? wanted : `.${wanted}`));
}

/** The `--glob` filter that narrows a search to one language's files. */
export function includeGlobFor(language: SymbolLanguage): string {
  return language.extensions.length === 1
    ? `*${language.extensions[0]}`
    : `*{${language.extensions.map((e) => e.slice(1)).join(',')}}`;
}

function allKeywords(): string[] {
  return [...new Set(SYMBOL_LANGUAGES.flatMap((l) => l.keywords))];
}

/**
 * Build the definition pattern for `symbol`. Three shapes cover essentially
 * every mainstream language:
 *
 *   1. `keyword Name`            — declarations across all of them
 *   2. `Name = function|(`       — assigned function expressions and arrows
 *   3. `… Name(args) {`          — C/Java/Go-style bodies with a return type
 *
 * Passing a `language` narrows shape 1 to that language's keywords, which cuts
 * cross-language noise in polyglot repos.
 */
export function definitionPattern(symbol: string, language?: SymbolLanguage): string {
  const name = escapeRegex(symbol);
  const keywords = (language?.keywords ?? allKeywords()).map(escapeRegex).join('|');

  const declaration = `(?:^|[\\s(,;])(?:${keywords})\\s+${name}\\b`;
  const assignment = `\\b${name}\\s*[:=]\\s*(?:async\\s+)?(?:function\\b|\\()`;
  const body = `^[\\t ]*(?:[\\w<>\\[\\]*&:.~]+[\\t ]+)*${name}[\\t ]*\\([^;{]*\\)[\\t ]*(?:const[\\t ]*)?\\{`;

  return `${declaration}|${assignment}|${body}`;
}

/** Every mention of the symbol as a whole word — the reference side of the report. */
export function referencePattern(symbol: string): string {
  return `\\b${escapeRegex(symbol)}\\b`;
}
