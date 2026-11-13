/**
 * The per-binary flag allowlist that keeps `auto` read-only.
 *
 * A permitted binary is permitted with the flags it is known to be read-only
 * with; an unrecognised flag is refused, not prompted.
 */

import { mayBecomeFlag, type Segment } from './shellLexer';

/**
 * Flags known to be read-only, per permitted binary.
 *
 * The permitted tier used to mean "any flag at all is fine on this binary",
 * which is not what a permitted binary is. They keep their own ability to run
 * helper programs — `rg --pre`, `sort --compress-program`, `git --exec-path`,
 * `git grep -O`, `git ls-remote --upload-pack`, `rg --hostname-bin` — and to
 * write files with no `>` for the redirect check to see: `sort -o`, `tree -o`,
 * `git diff --output`, and the file finder's whole `-fprint`/`-fprintf`/`-fls`
 * family beyond the `-exec` forms guarded separately below.
 *
 * That is a class rather than a list, and the list that can stay complete is the
 * read-only one. So the sets here are an allowlist: a flag that is not on its
 * binary's set is **refused**.
 *
 * Refused, not prompted. Grants are remembered at `scope` granularity and the
 * scope of a non-multiplexer is the binary name, so demoting an unrecognised
 * flag to `ask` would mean one benign approval of `rg` covers every later `rg`
 * with any flag at all — the same bypass in a different place.
 *
 * Bare booleans are not exempt either. `yq -i` rewrites the file it was pointed
 * at and `git branch -D` deletes a ref, both taking no value at all, so
 * "restrict value-taking flags and wave booleans through" would have missed
 * them.
 *
 * The sets are deliberately generous, and they are drawn from what the planner
 * actually emits — the bash calls in this project's own research logs — not from
 * reading help output end to end. Too tight is the realistic failure mode and it
 * fails quietly: a refusal the model works around costs turns instead of
 * erroring where anyone would see it.
 */
export interface FlagSpec {
  /**
   * Consume nothing. Long flags whose value is *optional* (`--color`,
   * `--pretty`, `git status --porcelain=v1`) belong here: the `--flag=value`
   * spelling is matched on the name either way, and the separated spelling of an
   * optional-value flag is an operand rather than a value.
   */
  booleans?: string[];
  /** Take a value — glued on (`grep -m1`, `cut -d:`), `=`-joined, or the next token. */
  values?: string[];
  /** Open-ended spellings: `head -50`, `git log -12`, `find -O2`. */
  patterns?: RegExp[];
  /**
   * Short booleans may be written as one token — `ls -la`, `grep -rniE`. Off for
   * binaries that spell flags as single-dash words, where walking the token
   * character by character would read `-name` as five short flags.
   */
  cluster?: boolean;
  /**
   * Every token is data. Only for binaries with no flag that runs a program or
   * writes a file: `echo --- files changed ---` is the planner's commonest
   * section marker, and there is nothing to police behind it.
   */
  freeform?: boolean;
  /**
   * `--` does not end the flags here, because the arguments are an expression
   * rather than options followed by operands — any token can still be a
   * predicate. Confirmed by running it: `find . -- -fprint OUT` writes OUT, so
   * treating `--` as the end of the flags would have handed back the write this
   * allowlist exists to refuse. `--` itself is then unrecognised and refused,
   * which costs nothing: it has no legitimate use on such a binary.
   */
  expressionArgs?: boolean;
}

/** Accepted on every binary; asking a tool what it does is read-only. */
export const UNIVERSAL_FLAGS = ['--help', '--version'];

/** `head -50`, `git log -12`, `tail -60` — the count spelled as the flag. */
const COUNT_FLAG = /^-\d+$/;

export const FLAG_POLICY: Record<string, FlagSpec> = {
  ls: {
    cluster: true,
    booleans: ['-1', '-a', '-A', '-b', '-c', '-C', '-d', '-D', '-f', '-F', '-g', '-G', '-h', '-H',
      '-i', '-k', '-l', '-L', '-m', '-n', '-N', '-o', '-p', '-q', '-Q', '-r', '-R', '-s', '-S',
      '-t', '-u', '-U', '-v', '-x', '-X', '-Z',
      '--all', '--almost-all', '--author', '--escape', '--classify', '--file-type', '--full-time',
      '--no-group', '--human-readable', '--si', '--dereference-command-line', '--inode',
      '--kibibytes', '--dereference', '--numeric-uid-gid', '--literal', '--hide-control-chars',
      '--show-control-chars', '--quote-name', '--reverse', '--recursive', '--size',
      '--directory', '--group-directories-first', '--context', '--zero'],
    values: ['-w', '-I', '-T', '--width', '--ignore', '--hide', '--block-size', '--color',
      '--format', '--sort', '--time', '--time-style', '--indicator-style', '--quoting-style',
      '--tabsize'],
  },
  tree: {
    cluster: true,
    // `-o` is absent on purpose: it is tree's write-to-a-file flag, which the
    // redirect check never sees because there is no redirect.
    booleans: ['-a', '-d', '-f', '-i', '-l', '-x', '-C', '-n', '-p', '-s', '-h', '-u', '-g', '-D',
      '-t', '-c', '-r', '-F', '-q', '-N', '-Q', '-v', '-J', '-X', '-Z',
      '--noreport', '--dirsfirst', '--du', '--prune', '--matchdirs', '--inodes', '--device',
      '--si', '--gitignore', '--ignore-case', '--filesfirst', '--nolinks', '--hintro'],
    values: ['-L', '-P', '-I', '-H', '--filelimit', '--timefmt', '--charset', '--sort',
      '--gitfile', '--info', '--prefix'],
  },
  git: {
    cluster: true,
    // Absent on purpose, and each for a reason that was demonstrated rather than
    // guessed at:
    //   -c, --config-env  set configuration inline, and several configuration
    //                     keys name a program to run (`core.pager`, `core.editor`,
    //                     `diff.external`), so this is an execution flag with one
    //                     indirection in front of it.
    //   --exec-path       redirects where git finds its helper programs; a
    //                     fabricated helper ran during an ordinary remote listing.
    //   -O, --open-files-in-pager  runs an arbitrary named program over search hits.
    //   --upload-pack, --receive-pack  name the program run on the other end.
    //   --textconv, --ext-diff  run filters the repository itself configures.
    //   --git-dir, --work-tree  repoint git at a tree whose configuration is not
    //                     the one the developer is looking at.
    //   -o, --output      write a file. `git ls-files -o` is a legitimate spelling
    //                     of `--others`, but `git archive -o` writes, and the
    //                     long spelling stays available for the read.
    booleans: ['-a', '-b', '-E', '-F', '-h', '-H', '-i', '-I', '-l', '-p', '-P', '-q', '-r',
      '-R', '-s', '-t', '-u', '-v', '-w', '-z',
      '--oneline', '--graph', '--stat', '--shortstat', '--numstat', '--dirstat', '--summary',
      '--name-only', '--name-status', '--raw', '--patch', '--no-patch', '--patch-with-stat',
      '--cached', '--staged', '--porcelain', '--short', '--long', '--branch', '--show-stash',
      '--show-current', '--all', '--tags', '--heads', '--remotes', '--list', '--verbose',
      '--quiet', '--abbrev-ref', '--count', '--reverse', '--first-parent', '--no-merges',
      '--merges', '--follow', '--full-history', '--simplify-merges', '--sparse', '--dense',
      '--ancestry-path', '--left-right', '--cherry', '--cherry-pick', '--cherry-mark',
      '--boundary', '--topo-order', '--date-order', '--author-date-order', '--relative-date',
      '--parents', '--children', '--timestamp', '--no-walk', '--do-walk', '--decorate',
      '--no-decorate', '--abbrev-commit', '--no-abbrev-commit', '--abbrev', '--no-abbrev',
      '--color', '--no-color', '--pretty', '--format', '--expand-tabs', '--no-expand-tabs',
      '--numbered', '--email', '--no-notes', '--notes', '--show-signature',
      '--find-renames', '--find-copies', '--find-copies-harder', '--break-rewrites',
      '--no-renames', '--irreversible-delete', '--full-index', '--binary', '--text', '--check',
      '--exit-code', '--word-diff', '--function-context', '--ignore-all-space',
      '--ignore-space-change', '--ignore-space-at-eol', '--ignore-blank-lines',
      '--ignore-cr-at-eol', '--no-prefix', '--default-prefix', '--no-textconv', '--no-ext-diff',
      '--submodule', '--ignore-submodules', '--recurse-submodules', '--no-recurse-submodules',
      '--others', '--deleted', '--modified', '--unmerged', '--stage', '--killed',
      '--ignored', '--exclude-standard', '--error-unmatch', '--full-name', '--directory',
      '--no-empty-directory', '--untracked-files', '--no-optional-locks', '--no-pager',
      '--paginate', '--bare', '--literal-pathspecs', '--glob-pathspecs', '--noglob-pathspecs',
      '--icase-pathspecs', '--line-number', '--column', '--heading', '--no-index',
      '--untracked', '--no-recursive', '--name-rev', '--root', '--dirty', '--broken',
      '--always', '--merged', '--no-merged',
      '--show-toplevel', '--show-cdup', '--git-common-dir', '--absolute-git-dir',
      '--is-inside-work-tree', '--is-inside-git-dir', '--is-bare-repository', '--symbolic',
      '--symbolic-full-name', '--verify', '--short-hash', '--textual', '--batch',
      '--batch-check', '--batch-all-objects', '--buffer', '--follow-symlinks', '--use-mailmap'],
    values: ['-n', '-C', '-B', '-M', '-L', '-S', '-G', '-U', '-e', '-m', '-f', '-g', '-x', '-X', '-W',
      '--max-count', '--skip', '--since', '--after', '--until', '--before', '--author',
      '--grep', '--grep-reflog', '--committer', '--date', '--diff-filter', '--unified',
      '--stat-width', '--stat-name-width', '--stat-count', '--word-diff-regex', '--line-prefix',
      '--src-prefix', '--dst-prefix', '--pickaxe-regex', '--anchored', '--color-moved',
      '--color-words', '--inter-hunk-context', '--max-parents', '--min-parents',
      '--simplify-by-decoration', '--glob', '--exclude', '--sort', '--contains', '--points-at',
      '--decorate-refs', '--decorate-refs-exclude', '--encoding', '--context', '--max-depth',
      // `--filters` is absent from this list on purpose: it runs the clean and
      // smudge filters the repository under research configures, which is the
      // same execution vector as the configuration flag above with a different
      // spelling.
      '--and', '--or', '--not', '--all-match', '--threads', '--path'],
    patterns: [COUNT_FLAG],
  },
  wc: {
    cluster: true,
    booleans: ['-c', '-l', '-m', '-w', '-L',
      '--bytes', '--chars', '--lines', '--words', '--max-line-length', '--total'],
  },
  du: {
    cluster: true,
    booleans: ['-0', '-a', '-b', '-c', '-D', '-h', '-H', '-k', '-l', '-L', '-m', '-P', '-s', '-S',
      '-x', '--all', '--apparent-size', '--bytes', '--total', '--dereference-args',
      '--human-readable', '--si', '--inodes', '--count-links', '--dereference',
      '--no-dereference', '--separate-dirs', '--summarize', '--one-file-system', '--null'],
    values: ['-d', '-t', '-B', '-X', '--max-depth', '--threshold', '--block-size', '--exclude',
      '--exclude-from', '--time', '--time-style', '--files0-from'],
  },
  df: {
    cluster: true,
    booleans: ['-a', '-h', '-H', '-i', '-k', '-l', '-m', '-P', '-T', '-v',
      '--all', '--human-readable', '--si', '--inodes', '--local', '--portability',
      '--print-type', '--total', '--sync', '--no-sync'],
    values: ['-B', '-t', '-x', '--block-size', '--type', '--exclude-type'],
  },
  file: {
    cluster: true,
    // `-C`/`--compile` is absent: it writes a compiled magic file.
    booleans: ['-b', '-c', '-h', '-i', '-k', '-L', '-n', '-N', '-p', '-r', '-s', '-S', '-v', '-z',
      '-0', '--brief', '--mime', '--mime-type', '--mime-encoding', '--dereference',
      '--no-dereference', '--keep-going', '--no-buffer', '--no-pad', '--raw', '--special-files',
      '--uncompress', '--print0', '--checking-printout'],
    values: ['-e', '-m', '-P', '-F', '--exclude', '--magic-file', '--separator', '--parameter',
      '--extension', '--files-from'],
  },
  head: {
    cluster: true,
    booleans: ['-q', '-v', '-z', '--quiet', '--silent', '--verbose', '--zero-terminated'],
    values: ['-c', '-n', '--bytes', '--lines'],
    patterns: [COUNT_FLAG],
  },
  tail: {
    cluster: true,
    booleans: ['-f', '-F', '-q', '-v', '-z', '--follow', '--retry', '--quiet', '--silent',
      '--verbose', '--zero-terminated'],
    values: ['-c', '-n', '-s', '--bytes', '--lines', '--sleep-interval', '--pid',
      '--max-unchanged-stats'],
    patterns: [COUNT_FLAG],
  },
  cat: {
    cluster: true,
    booleans: ['-A', '-b', '-e', '-E', '-n', '-s', '-t', '-T', '-u', '-v',
      '--show-all', '--number-nonblank', '--show-ends', '--number', '--squeeze-blank',
      '--show-tabs', '--show-nonprinting'],
  },
  sort: {
    cluster: true,
    // Absent on purpose: `-o`/`--output` writes a file with no redirect for the
    // redirect check to see, `-T`/`--temporary-directory` names where sort writes
    // its run files, and `--compress-program` names a program that sort runs
    // over its own temporary files — a permitted binary as an interpreter.
    booleans: ['-b', '-c', '-C', '-d', '-f', '-g', '-h', '-i', '-M', '-n', '-r', '-R', '-s', '-u',
      '-V', '-z', '--ignore-leading-blanks', '--check', '--dictionary-order', '--ignore-case',
      '--general-numeric-sort', '--human-numeric-sort', '--ignore-nonprinting', '--month-sort',
      '--numeric-sort', '--random-sort', '--reverse', '--stable', '--unique', '--version-sort',
      '--zero-terminated', '--debug'],
    values: ['-k', '-t', '-S', '--key', '--field-separator', '--buffer-size',
      '--random-source', '--batch-size', '--parallel', '--sort'],
  },
  uniq: {
    cluster: true,
    booleans: ['-c', '-d', '-D', '-i', '-u', '-z', '--count', '--repeated', '--all-repeated',
      '--ignore-case', '--unique', '--zero-terminated'],
    values: ['-f', '-s', '-w', '--skip-fields', '--skip-chars', '--check-chars', '--group'],
  },
  // No flag on either runs a program or writes a file, and the planner's
  // commonest use of `echo` is a section marker — `echo --- files changed ---`
  // is three tokens that all begin with a dash and none of them is a flag.
  echo: { freeform: true },
  printf: { freeform: true },
  date: {
    cluster: true,
    // `-s`/`--set` is absent: it sets the system clock.
    booleans: ['-u', '-R', '-I', '--utc', '--universal', '--rfc-email', '--rfc-3339',
      '--iso-8601', '--debug'],
    values: ['-d', '-f', '-r', '--date', '--file', '--reference'],
  },
  stat: {
    cluster: true,
    booleans: ['-f', '-L', '-t', '--file-system', '--terse', '--dereference'],
    values: ['-c', '--format', '--printf', '--cached'],
  },
  basename: {
    cluster: true,
    booleans: ['-a', '-z', '--multiple', '--zero'],
    values: ['-s', '--suffix'],
  },
  dirname: {
    cluster: true,
    booleans: ['-z', '--zero'],
  },
  realpath: {
    cluster: true,
    booleans: ['-e', '-m', '-L', '-P', '-q', '-s', '-z', '--canonicalize-existing',
      '--canonicalize-missing', '--logical', '--physical', '--quiet', '--strip',
      '--no-symlinks', '--zero'],
    values: ['--relative-to', '--relative-base'],
  },
  pwd: { cluster: true, booleans: ['-L', '-P', '--logical', '--physical'] },
  which: { cluster: true, booleans: ['-a', '-s', '--all'] },
  type: { cluster: true, booleans: ['-a', '-f', '-p', '-P', '-t'] },
  uname: {
    cluster: true,
    booleans: ['-a', '-i', '-m', '-n', '-o', '-p', '-r', '-s', '-v', '--all', '--kernel-name',
      '--nodename', '--kernel-release', '--kernel-version', '--machine', '--processor',
      '--hardware-platform', '--operating-system'],
  },
  whoami: {},
  cut: {
    cluster: true,
    // `--output-delimiter` names a separator string, not a file.
    booleans: ['-n', '-s', '-z', '--only-delimited', '--complement', '--zero-terminated'],
    values: ['-b', '-c', '-d', '-f', '--bytes', '--characters', '--delimiter', '--fields',
      '--output-delimiter'],
  },
  nl: {
    cluster: true,
    booleans: ['-p', '--no-renumber'],
    values: ['-b', '-d', '-f', '-h', '-i', '-l', '-n', '-s', '-v', '-w', '--body-numbering',
      '--section-delimiter', '--footer-numbering', '--header-numbering', '--join-blank-lines',
      '--line-increment', '--number-format', '--number-separator', '--starting-line-number',
      '--number-width'],
  },
  rg: {
    cluster: true,
    // `--pre` runs a named preprocessor over every file searched and
    // `--hostname-bin` runs a named program to resolve the hostname; both are
    // absent, and `--pre-glob` with them.
    booleans: ['-a', '-c', '-F', '-h', '-H', '-i', '-I', '-l', '-L', '-n', '-N', '-o', '-p', '-P',
      '-q', '-s', '-S', '-u', '-uu', '-uuu', '-U', '-v', '-V', '-w', '-x', '-z',
      '--text', '--count', '--count-matches', '--fixed-strings', '--files', '--files-with-matches',
      '--files-without-match', '--follow', '--hidden', '--no-hidden', '--ignore-case',
      '--case-sensitive', '--smart-case', '--invert-match', '--line-number', '--no-line-number',
      '--with-filename', '--no-filename', '--heading', '--no-heading', '--column', '--no-column',
      '--byte-offset', '--vimgrep', '--json', '--stats', '--trim', '--pretty', '--passthru',
      '--word-regexp', '--line-regexp', '--multiline', '--multiline-dotall', '--no-multiline',
      '--crlf', '--null', '--null-data', '--binary', '--search-zip', '--no-ignore',
      '--no-ignore-dot', '--no-ignore-exclude', '--no-ignore-files', '--no-ignore-global',
      '--no-ignore-parent', '--no-ignore-vcs', '--no-ignore-messages', '--no-messages',
      '--no-require-git', '--require-git', '--one-file-system', '--pcre2', '--no-pcre2',
      '--auto-hybrid-regex', '--line-buffered', '--block-buffered', '--unicode', '--no-unicode',
      '--unrestricted', '--type-list', '--debug', '--trace', '--include-zero',
      '--no-context-separator', '--stop-on-nonmatch', '--quiet', '--no-binary'],
    values: ['-A', '-B', '-C', '-d', '-e', '-E', '-f', '-g', '-j', '-m', '-M', '-r', '-t', '-T',
      '--after-context', '--before-context', '--context', '--context-separator',
      '--field-context-separator', '--field-match-separator', '--regexp', '--file', '--glob',
      '--iglob', '--glob-case-insensitive', '--type', '--type-not', '--type-add', '--type-clear',
      '--max-count', '--max-columns', '--max-depth', '--maxdepth', '--max-filesize',
      '--replace', '--threads', '--encoding', '--engine', '--sort', '--sortr', '--color',
      '--colors', '--path-separator', '--ignore-file', '--dfa-size-limit', '--regex-size-limit',
      '--binary-files', '--max-columns-preview'],
  },
  grep: {
    cluster: true,
    // `-o` here is `--only-matching`, which writes nothing. It is the same two
    // characters as `sort -o`, which writes a file — the reason these sets are
    // per-binary rather than one shared list.
    booleans: ['-a', '-b', '-c', '-E', '-F', '-G', '-H', '-h', '-i', '-I', '-l', '-L', '-n', '-o',
      '-P', '-q', '-r', '-R', '-s', '-T', '-U', '-v', '-w', '-x', '-y', '-z', '-Z',
      '--extended-regexp', '--fixed-strings', '--basic-regexp', '--perl-regexp', '--ignore-case',
      '--no-ignore-case', '--invert-match', '--word-regexp', '--line-regexp', '--count',
      '--files-with-matches', '--files-without-match', '--line-number', '--with-filename',
      '--no-filename', '--only-matching', '--quiet', '--silent', '--no-messages', '--text',
      '--binary', '--line-buffered', '--null', '--null-data', '--byte-offset', '--recursive',
      '--dereference-recursive', '--initial-tab', '--unix-byte-offsets', '--no-group-separator',
      '--color', '--colour'],
    values: ['-A', '-B', '-C', '-d', '-D', '-e', '-f', '-m', '--after-context', '--before-context',
      '--context', '--regexp', '--file', '--max-count', '--devices', '--directories',
      '--binary-files', '--include', '--exclude', '--exclude-dir', '--exclude-from', '--label',
      '--group-separator'],
  },
  find: {
    // No clustering: find spells its flags as single-dash words, so walking the
    // characters of `-name` would read it as five short flags. And its arguments
    // are an expression, so `--` does not end them.
    expressionArgs: true,
    // Absent on purpose: `-exec`, `-execdir`, `-ok` and `-okdir` run an inner
    // command (also caught by the named guard below, which says so more
    // precisely), `-delete` removes files, and `-fprint`, `-fprint0`, `-fprintf`
    // and `-fls` are find's write family — the same write as `> file` with no
    // redirect for the redirect check to see.
    booleans: ['-H', '-L', '-P', '-a', '-and', '-o', '-or', '-not', '-d', '-depth', '-daystart',
      '-empty', '-executable', '-false', '-follow', '-help', '--help', '-ignore_readdir_race',
      '-noignore_readdir_race', '-ls', '-mount', '-nogroup', '-noleaf', '-nouser', '-print',
      '-print0', '-prune', '-quit', '-readable', '-true', '-version', '-writable', '-xdev'],
    values: ['-maxdepth', '-mindepth', '-name', '-iname', '-path', '-ipath', '-wholename',
      '-iwholename', '-regex', '-iregex', '-lname', '-ilname', '-type', '-xtype', '-size',
      '-newer', '-anewer', '-cnewer', '-mtime', '-mmin', '-ctime', '-cmin', '-atime', '-amin',
      '-used', '-uid', '-gid', '-user', '-group', '-perm', '-links', '-inum', '-samefile',
      '-fstype', '-regextype', '-files0-from', '-printf', '-context', '-D'],
    // `find -O2` glues the optimisation level on, and `-newermt`/`-newerat` and
    // friends spell the two comparison fields into the flag name.
    patterns: [/^-O\d$/, /^-newer[acmBt][acmBt]$/],
  },
  jq: {
    cluster: true,
    booleans: ['-a', '-c', '-C', '-e', '-h', '-j', '-M', '-n', '-r', '-R', '-s', '-S',
      '--ascii-output', '--compact-output', '--color-output', '--monochrome-output',
      '--exit-status', '--join-output', '--null-input', '--raw-input', '--raw-output',
      '--raw-output0', '--slurp', '--sort-keys', '--seq', '--stream', '--stream-errors',
      '--tab', '--unbuffered', '--args', '--jsonargs'],
    values: ['-f', '-L', '--arg', '--argjson', '--slurpfile', '--rawfile', '--indent',
      '--from-file'],
  },
  yq: {
    cluster: true,
    // `-i`/`--inplace`/`--in-place` rewrite the file, and `-s`/`--split-exp`
    // writes one file per document. All absent — and all bare or near-bare
    // booleans, which is why exempting booleans was not an option.
    booleans: ['-C', '-e', '-h', '-j', '-M', '-n', '-N', '-P', '-r', '-S', '-v', '-y', '-Y',
      '--colors', '--no-colors', '--exit-status', '--no-doc', '--null-input', '--prettyPrint',
      '--raw-output', '--sort-keys', '--tojson', '--yaml-output', '--yaml-roundtrip',
      '--unwrapScalar', '--header-preprocess', '--no-exit-status', '--verbose', '--xml-strict-mode'],
    values: ['-I', '-o', '-p', '-L', '--indent', '--output-format', '--input-format',
      '--expression', '--width', '--xml-attribute-prefix', '--xml-content-name'],
  },
};

/**
 * The value-taking flag a token spells, when it spells one: `--regexp=x`,
 * `-e`, or the first value letter of a cluster such as `-ie/api/`, which
 * takes the rest of the token or, at its end, the next one.
 */
export function valueFlagIn(token: string, booleans: Set<string>, values: Set<string>): string | undefined {
  if (token.startsWith('--')) {
    const name = flagLabel(token);
    return values.has(name) ? name : undefined;
  }
  if (values.has(token)) return token;
  for (let i = 1; i < token.length; i++) {
    const short = `-${token[i]}`;
    if (booleans.has(short)) continue;
    return values.has(short) ? short : undefined;
  }
  return undefined;
}

/** How a recognized flag relates to the token after it. */
export type FlagShape = 'boolean' | 'value';

/**
 * Whether `token` is a flag the binary is known to treat as read-only, and
 * whether it wants the next token as its value.
 *
 * The reading of a token is never guessed at. A flag this returns `undefined`
 * for is refused, so the cost of being wrong is a refusal the model can see and
 * work around — not a value silently swallowed and left unclassified.
 */
export function matchFlag(spec: FlagSpec, booleans: Set<string>, values: Set<string>, token: string):
FlagShape | undefined {
  if (token.startsWith('--')) {
    // `--flag=value` carries its value in the same token, so it consumes nothing
    // whichever set the name is in.
    const eq = token.indexOf('=');
    const name = eq > 0 ? token.slice(0, eq) : token;
    if (booleans.has(name)) return 'boolean';
    if (values.has(name)) return eq > 0 ? 'boolean' : 'value';
    return undefined;
  }
  if (booleans.has(token)) return 'boolean';
  if (values.has(token)) return 'value';
  if (spec.patterns?.some((p) => p.test(token))) return 'boolean';
  if (!spec.cluster) return undefined;

  // `ls -la`, `grep -rniE`, and the glued short value at the end of a run:
  // `grep -m1`, `rg -A15`, `cut -d:`. `git shortlog -sn` is the same shape with
  // the value-taking flag last and its value in the following token.
  for (let i = 1; i < token.length; i++) {
    const short = `-${token[i]}`;
    if (booleans.has(short)) continue;
    if (values.has(short)) return i === token.length - 1 ? 'value' : 'boolean';
    return undefined;
  }
  return 'boolean';
}

/**
 * Whether a separated value flag should consume `next`.
 *
 * Declining to consume a token that looks like another flag is what stops a
 * value-taking flag from hiding one: `git shortlog -sn --unknown-flag` would
 * otherwise read `--unknown-flag` as `-n`'s value and nobody would classify it.
 * Numeric values are the exception, because `find -mtime -7` really does spell
 * its value with a leading dash.
 */
export function takesNextToken(next: string | undefined): boolean {
  if (next === undefined) return false;
  // getopt hands a value flag the next word whatever it says, so `tree -I -- -o
  // out` gives `-I` the `--` and still reads `-o`. Reading `--` as the end of
  // the flags would leave that `-o` an operand.
  return !/^-./.test(next) || /^-\d/.test(next) || next === '--';
}

/** The flag as the refusal should name it: `--output`, not `--output=out.diff`. */
export function flagLabel(token: string): string {
  const eq = token.startsWith('--') ? token.indexOf('=') : -1;
  return eq > 0 ? token.slice(0, eq) : token;
}

/** What a walk of a permitted binary's arguments found. */
export interface FlagScan {
  /** The first flag not known to be read-only, as the refusal should name it. */
  unknown?: string;
  /** Arguments that are not flags and not a flag's value. */
  operands: string[];
  /** Where each operand sits in the segment's arguments, so a flag's value equal to it is never mistaken for it. */
  operandAt: number[];
  /**
   * The first word, before the flags end, that the shell may expand into a
   * flag (`*`, `-[o]`, `$X`): the allowlist above only ever saw it as written.
   */
  rewritten?: string;
}

/**
 * Walk a permitted binary's arguments against its flag set.
 *
 * Returns nothing for a binary with no declared set. The permitted tier is what
 * this policy covers; applying it to a binary that only ever reaches the prompt
 * tier would refuse work the developer is being asked about anyway.
 */
export function scanFlags(seg: Segment): FlagScan | undefined {
  const spec = FLAG_POLICY[seg.binary];
  if (!spec || spec.freeform) return undefined;

  const booleans = new Set([...(spec.booleans ?? []), ...UNIVERSAL_FLAGS]);
  const values = new Set(spec.values ?? []);
  const operands: string[] = [];
  const operandAt: number[] = [];
  const operand = (at: number) => { operands.push(seg.args[at]); operandAt.push(at); };
  // A flag's value counts too: `sort -k *` hands `-k` the first file name and
  // reads every later one as a flag. An expression binary is left to its own
  // guard, since there any word may be a predicate.
  let rewritten: string | undefined;
  const judge = (token: string | undefined) => {
    if (rewritten === undefined && token !== undefined && !spec.expressionArgs && mayBecomeFlag(seg, token)) rewritten = token;
  };
  const found = (): Pick<FlagScan, 'rewritten'> => (rewritten !== undefined ? { rewritten } : {});

  let i = 0;
  while (i < seg.args.length) {
    const token = seg.args[i];
    // `--` ends the flags; everything after it is an operand, however it is
    // spelled. Except where the arguments are an expression — see
    // {@link FlagSpec.expressionArgs} — in which case `--` falls through to the
    // matcher and is refused along with anything the caller hoped to hide there.
    if (token === '--' && !spec.expressionArgs) {
      for (let j = i + 1; j < seg.args.length; j++) operand(j);
      break;
    }
    judge(token);
    if (!/^-./.test(token)) { operand(i); i++; continue; }

    const shape = matchFlag(spec, booleans, values, token);
    if (shape === undefined) return { unknown: flagLabel(token), operands, operandAt, ...found() };
    const consumes = shape === 'value' && takesNextToken(seg.args[i + 1]);
    if (consumes) judge(seg.args[i + 1]);
    i += consumes ? 2 : 1;
  }
  return { operands, operandAt, ...found() };
}

/**
 * The subcommand a multiplexer was asked to run.
 *
 * "First argument that does not start with a dash" is wrong as soon as a global
 * flag takes a value: `git -C packages/core log` answered `packages/core`, so an
 * ordinary log in a subdirectory was not recognised as a read-only subcommand
 * and prompted, while `git -C /tmp/x push` was not recognised as a `push` and
 * fell to the prompt tier the refusal tier is documented never to reach.
 *
 * Where {@link FLAG_POLICY} knows the binary's flags, the answer comes from
 * walking them; a multiplexer with no declared flag set keeps the positional
 * reading, since guessing at its arities is what {@link scanWrapperArgs}
 * already refuses to do.
 */
export function subcommandOf(seg: Segment): string | undefined {
  const scan = scanFlags(seg);
  if (scan) return scan.operands[0];
  return seg.args.find((a) => !a.startsWith('-'));
}
