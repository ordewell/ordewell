/**
 * Tiered classification for the planner's `bash` tool.
 *
 * The planner is a read-only researcher: it never edits files, and the runners
 * do the real work. But research legitimately means running things — querying a
 * cloud control plane (`az`, `gh`), reproducing a failure (`npm test`), or
 * shaping output (`jq`). The old allowlist refused all of that, so the model's
 * only escape was to guess.
 *
 * Three tiers replace the flat allowlist:
 *
 *   auto    read-only inspection — runs with no prompt (the historical list)
 *   ask     anything else that is not obviously destructive — one approval,
 *           remembered for the rest of the session at `scope` granularity
 *   refuse  writes, privilege escalation, and anything that would smuggle
 *           arbitrary code past this classifier — never runs, never prompts
 *
 * `refuse` is deliberately not promptable. A planner that can `rm` is a planner
 * that can silently break the workspace it was asked to reason about, and the
 * architecture already says mutation belongs to the runners.
 *
 * Classification walks every segment of the command line (pipes, `&&`, `;`, and
 * command substitution) rather than matching substrings against the raw string.
 * The old substring denylist both over-matched (`ls docs/removed` tripped `rm`)
 * and under-matched (`$(rm -rf /)` was invisible once chaining was allowed).
 *
 * A segment is classified by the command that will actually execute, not by the
 * name at the front of it: wrappers are unwrapped first, recursively, so
 * `timeout 10 env nice rm -rf x` is an `rm`. See {@link WRAPPER_FAMILY}.
 *
 * A permitted binary is permitted with the flags it is known to be read-only
 * with, not with any flag at all: several of them will run a helper program or
 * write a file when asked to, so `auto` is a per-binary flag allowlist and an
 * unrecognised flag is refused. See {@link FLAG_POLICY}.
 *
 * The lexer is dialect-aware, because the interpreter that will actually run
 * the command decides what the tokens are, and getting that wrong is not a
 * cosmetic error here — it is the difference between classifying what runs and
 * classifying something else. See {@link Dialect}.
 */

import type { ShellDialect } from './researchShell';

/**
 * `env` is deliberately absent. Given a command it is a wrapper, classified by
 * what it actually runs (see {@link WRAPPER_FAMILY}); given none it prints the
 * whole process environment — provider credentials included — into the research
 * log, which is a disclosure the developer should get to see coming.
 *
 * Membership here is necessary but not sufficient: every name in this list also
 * declares the flags it is read-only with in {@link FLAG_POLICY}.
 */
export const AUTO_COMMANDS = [
  'ls', 'tree', 'git', 'wc', 'du', 'df', 'file', 'head', 'tail', 'cat', 'sort', 'uniq',
  'echo', 'printf', 'date', 'stat', 'basename', 'dirname', 'realpath', 'pwd',
  'which', 'type', 'uname', 'whoami', 'cut', 'nl', 'rg', 'grep', 'find', 'jq', 'yq',
];

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
interface FlagSpec {
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
const UNIVERSAL_FLAGS = ['--help', '--version'];

/** `head -50`, `git log -12`, `tail -60` — the count spelled as the flag. */
const COUNT_FLAG = /^-\d+$/;

const FLAG_POLICY: Record<string, FlagSpec> = {
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
    // redirect check to see, and `--compress-program` names a program that sort
    // runs over its own temporary files — a permitted binary as an interpreter.
    booleans: ['-b', '-c', '-C', '-d', '-f', '-g', '-h', '-i', '-M', '-n', '-r', '-R', '-s', '-u',
      '-V', '-z', '--ignore-leading-blanks', '--check', '--dictionary-order', '--ignore-case',
      '--general-numeric-sort', '--human-numeric-sort', '--ignore-nonprinting', '--month-sort',
      '--numeric-sort', '--random-sort', '--reverse', '--stable', '--unique', '--version-sort',
      '--zero-terminated', '--debug'],
    values: ['-k', '-t', '-S', '-T', '--key', '--field-separator', '--buffer-size',
      '--temporary-directory', '--random-source', '--batch-size', '--parallel', '--sort'],
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
 * `ls-remote` is deliberately absent, and it is the one entry here that is
 * read-only against the repository. It reaches the network: it contacts
 * whatever host the named remote or URL resolves to, which routes around the
 * web fetcher's per-origin approval and its request-forgery guard. So it
 * prompts rather than running silently.
 *
 * Prompting only became the right answer once {@link scopeFor} widened. Under
 * the old scope it would have been remembered as `git ls-remote`, so one
 * approval of the workspace's own remote would have authorised a listing
 * against any host at all — which is the same hole with an approval dialog in
 * front of it. The scope now carries the destination.
 */
export const GIT_READONLY_SUBCOMMANDS = [
  'log', 'status', 'diff', 'show', 'ls-files', 'ls-tree', 'branch', 'tag',
  'rev-parse', 'rev-list', 'describe', 'blame', 'grep', 'shortlog', 'whatchanged', 'cat-file',
];

/**
 * Never runs, with or without approval.
 *
 * The `cmd.exe` builtins at the end matter as much as the POSIX names above
 * them. `del`, `rd`, `move`, and friends mutate exactly what `rm` and `mv` do,
 * and on Windows they are what a model reaches for — so without them the whole
 * refusal tier was bypassable on that platform by writing the command the way
 * the platform spells it. Listed unconditionally rather than per-platform: a
 * POSIX box has no `del` to refuse, so the extra names cost nothing there.
 */
export const REFUSED_COMMANDS = [
  'rm', 'rmdir', 'unlink', 'shred', 'truncate', 'dd', 'mkfs', 'fdisk', 'parted',
  'mv', 'cp', 'install', 'ln', 'chmod', 'chown', 'chgrp', 'chattr',
  'mount', 'umount', 'sudo', 'doas', 'su', 'passwd',
  'kill', 'killall', 'pkill', 'shutdown', 'reboot', 'halt', 'poweroff',
  'systemctl', 'service', 'crontab', 'tee', 'dput', 'mkdir', 'touch',
  // Windows: destructive cmd.exe builtins and their utility equivalents.
  'del', 'erase', 'rd', 'md', 'move', 'copy', 'xcopy', 'robocopy', 'ren', 'rename',
  'mklink', 'attrib', 'icacls', 'cacls', 'takeown', 'format', 'diskpart',
  'taskkill', 'tskill', 'reg', 'regedit', 'sc', 'net', 'runas', 'schtasks',
];

/** Destructive or outward-facing subcommands of otherwise-permitted multiplexers. */
const REFUSED_SUBCOMMANDS: Record<string, string[]> = {
  git: ['push', 'reset', 'clean', 'checkout', 'switch', 'restore', 'rebase', 'merge', 'commit',
    'am', 'apply', 'cherry-pick', 'revert', 'stash', 'gc', 'prune', 'filter-branch',
    'update-ref', 'remote', 'config', 'init', 'clone', 'fetch', 'pull', 'submodule'],
  npm: ['publish', 'unpublish', 'deprecate', 'owner', 'access', 'token', 'login', 'logout'],
  yarn: ['publish', 'npm'],
  pnpm: ['publish'],
  docker: ['push', 'rm', 'rmi', 'kill', 'stop', 'prune', 'system'],
  kubectl: ['delete', 'apply', 'create', 'patch', 'replace', 'edit', 'drain', 'cordon', 'scale'],
  gh: ['release', 'secret', 'auth'],
  az: ['login', 'logout'],
  terraform: ['apply', 'destroy'],
};

/**
 * Shell reserved words and compound-command openers. `toSegment` takes the
 * first token as `seg.binary` with no keyword awareness, so any of these
 * leading a segment hides the command it introduces as an unrecognized
 * argument instead of exposing it to classification. `(`/`)` are absent
 * because the lexer already strips subshell grouping before tokenizing.
 */
const SHELL_KEYWORDS = ['{', '}', 'if', 'then', 'elif', 'else', 'fi', 'for', 'while', 'until',
  'do', 'done', 'case', 'esac', 'select', 'function', 'time', 'export'];

/** Binaries that execute whatever they are handed — refused when given inline code or fed from a pipe. */
const INTERPRETERS = ['sh', 'bash', 'zsh', 'fish', 'dash', 'ksh', 'csh', 'tcsh', 'pwsh', 'powershell',
  'python', 'python2', 'python3', 'node', 'deno', 'bun', 'ruby', 'perl', 'php', 'eval', 'exec', 'xargs',
  // Windows interpreters. `cmd /c "…"` is the platform's spelling of `sh -c`.
  'cmd', 'wscript', 'cscript', 'mshta', 'rundll32', 'regsvr32'];

/**
 * Flags that hand an interpreter code to run. Compared case-insensitively:
 * cmd.exe and PowerShell both accept their switches in any casing, so a
 * case-sensitive list refused `-Command` and waved `-command` through.
 */
const INLINE_CODE_FLAGS = ['-c', '-e', '--eval', '--command', '-Command', '--exec', '/c', '/k', '/r'];

function isInlineCodeFlag(arg: string): boolean {
  const lower = arg.toLowerCase();
  return INLINE_CODE_FLAGS.some((f) => f.toLowerCase() === lower);
}

/** Binaries whose leading arguments name the operation, and so belong in a grant's scope. */
const MULTIPLEXERS = ['git', 'npm', 'yarn', 'pnpm', 'npx', 'cargo', 'go', 'dotnet', 'docker', 'podman',
  'kubectl', 'helm', 'az', 'aws', 'gcloud', 'gh', 'glab', 'terraform', 'make', 'mvn', 'gradle',
  'composer', 'pip', 'pip3', 'poetry', 'uv', 'bundle', 'rake', 'swift', 'flutter', 'dart'];

/**
 * How a wrapper's own arguments are skipped to reach the command it will run.
 *
 * Getting an arity wrong here does not merely mis-parse: the token after the
 * flag is what gets classified, so a value-taking flag mistaken for a boolean
 * makes its *value* look like the command and the real command look like an
 * argument. That is why {@link scanWrapperArgs} refuses a flag it does not
 * recognize instead of guessing at its arity.
 */
interface WrapperSpec {
  /**
   * Consume the following token as their value — unless it is already glued on
   * (`-o0`, `-uPATH`) or spelled `--flag=value`, both of which are
   * self-contained.
   */
  valueFlags?: string[];
  /**
   * Consume nothing. Long flags whose value is *optional*
   * (`--block-signal[=SIG]`) belong here rather than in `valueFlags`: treating
   * them as value-taking would swallow the wrapped command whenever the value
   * is omitted, and the `--flag=value` spelling needs no declaration.
   */
  booleanFlags?: string[];
  /** Boolean flags whose spelling is open-ended — `nice -10`. */
  booleanPattern?: RegExp;
  /**
   * Take a whole command line as a string (`env -S 'rm -rf /'`). Refused for
   * the same reason `sh -c` is: the string is not tokens this classifier lexed.
   */
  stringFlags?: string[];
  /**
   * Flags under which the wrapper executes nothing at all — `command -v rm`
   * prints where `rm` lives without running it — so there is nothing to unwrap
   * to and the wrapper is classified on its own name.
   */
  noExecFlags?: string[];
  /** Non-flag arguments consumed before the command begins. `timeout`'s duration. */
  positionals?: number;
  /**
   * `NAME=value` tokens are the wrapper's own arguments rather than the start
   * of the command. Only `env`; they are carried onto the unwrapped segment so
   * the assignment refusal answers for them.
   */
  acceptsAssignments?: boolean;
}

const HELP_FLAGS = ['--help', '--version'];

/**
 * Commands that exist to run another command.
 *
 * `env rm -rf build` is an `rm`, and classification only ever looks at a
 * segment's first binary — so with `env` in the permitted set, four characters
 * walked around the entire refusal list *and* the entire interpreter list, with
 * no prompt at all.
 *
 * The other eight are here for a different reason, and extending to them is a
 * deliberate departure from how the case was reported. None of them was
 * permitted, so a wrapped `rm` fell through to `ask` — which is not "merely
 * inconvenient but safe". The refusal tier is documented as never promptable,
 * and a prefix that turns `rm -rf` into a prompt a developer can approve
 * defeats the guarantee the tier exists to provide. Unwrapping all nine costs
 * one declaration table over unwrapping `env` alone.
 *
 * Flag sets are drawn from what the tools actually accept, not from what they
 * are commonly written with: `stdbuf -o0` and `ionice -c3` glue the value on,
 * `nice -10` spells the adjustment as the flag, and `timeout` consumes a
 * positional duration before the command starts.
 */
const WRAPPER_FAMILY: Record<string, WrapperSpec> = {
  env: {
    valueFlags: ['-u', '--unset', '-C', '--chdir'],
    booleanFlags: ['-i', '--ignore-environment', '-0', '--null', '-v', '--debug',
      // Optional-value flags: see WrapperSpec.booleanFlags.
      '--block-signal', '--default-signal', '--ignore-signal', '--list-signal-handling',
      ...HELP_FLAGS],
    stringFlags: ['-S', '--split-string'],
    acceptsAssignments: true,
  },
  nice: {
    valueFlags: ['-n', '--adjustment'],
    booleanFlags: HELP_FLAGS,
    booleanPattern: /^-\d+$/,
  },
  timeout: {
    valueFlags: ['-s', '--signal', '-k', '--kill-after'],
    booleanFlags: ['--preserve-status', '--foreground', '-v', '--verbose', ...HELP_FLAGS],
    positionals: 1,
  },
  nohup: { booleanFlags: HELP_FLAGS },
  setsid: { booleanFlags: ['-c', '--ctty', '-f', '--fork', '-w', '--wait', '-h', '-V', ...HELP_FLAGS] },
  stdbuf: {
    valueFlags: ['-i', '--input', '-o', '--output', '-e', '--error'],
    booleanFlags: HELP_FLAGS,
  },
  ionice: {
    valueFlags: ['-c', '--class', '-n', '--classdata', '-p', '--pid', '-P', '--pgid', '-u', '--uid'],
    booleanFlags: ['-t', '--ignore', '-h', '-V', ...HELP_FLAGS],
  },
  // The multi-call binary ships its own `rm`, `mv` and `sh`, so the refused
  // name arrives as its first argument.
  busybox: { booleanFlags: ['--list', '--install', ...HELP_FLAGS] },
  command: { booleanFlags: ['-p'], noExecFlags: ['-v', '-V'] },
};

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
 * Only the four rules that actually diverge are modeled. Constructs cmd.exe
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
  /** Executable extensions stripped before a binary is matched against the tiers. */
  strippedExtensions: string[];
}

const POSIX_DIALECT: Dialect = {
  escape: '\\',
  escapeInQuotes: true,
  quotes: ["'", '"'],
  expansion: /^\$[A-Za-z_{]/,
  strippedExtensions: [],
};

const CMD_DIALECT: Dialect = {
  escape: '^',
  escapeInQuotes: false,
  quotes: ['"'],
  // `%VAR%` and delayed-expansion `!VAR!`.
  expansion: /^[%!][A-Za-z_]/,
  // Without this, `del.exe` and `C:\bin\del.exe` both missed the refusal list.
  strippedExtensions: ['.exe', '.cmd', '.bat', '.com', '.ps1', '.msc'],
};

function dialectFor(dialect: ShellDialect | undefined): Dialect {
  const resolved = dialect ?? (process.platform === 'win32' ? 'cmd' : 'posix');
  return resolved === 'cmd' ? CMD_DIALECT : POSIX_DIALECT;
}

/**
 * Options threaded through classification.
 *
 * `dialect` is keyed to the interpreter rather than the OS on purpose: a Windows
 * host that has Git Bash runs the planner's commands in a POSIX shell (see
 * {@link resolveResearchShell}), and classifying those under cmd.exe rules
 * would be the same mismatch in the other direction. Callers pass the dialect of
 * the shell they are actually going to use; omitting it falls back to the host
 * default.
 */
export interface CommandPolicyOptions {
  dialect?: ShellDialect;
}

export type CommandTier = 'auto' | 'ask' | 'refuse';

export interface CommandClassification {
  tier: CommandTier;
  /** What a grant covers, for `ask`. Derived from the non-auto segments only. */
  scope: string;
  /** Populated for `refuse`: why, in a sentence the model can act on. */
  reason?: string;
}

interface Segment {
  binary: string;
  args: string[];
  /**
   * Leading `VAR=value` tokens, as written.
   *
   * Retained rather than discarded: the assignment is what decides what the
   * binary does — `LD_PRELOAD` loads attacker code into it, `PATH` changes
   * which executable is even reached — so classifying the binary alone answers
   * the wrong question. See {@link refusalFor}.
   */
  assignments: string[];
  /** True when this segment consumes another command's output (`… | seg`). */
  piped: boolean;
  /**
   * A token contains a `$var` the shell will expand. Tracked at lex time
   * because only the lexer knows a `$` inside single quotes is literal.
   */
  expandable: boolean;
}

/** An output redirect whose target is not provably a no-op (`/dev/null`, an fd duplication). */
interface UnsafeRedirect {
  /** The operator as written, fd prefix included: `>`, `2>`, `>>`, `&>`. */
  operator: string;
  /** The target text as the shell would see it, or `''` if the redirect had none. */
  target: string;
}

interface Lexed {
  segments: Segment[];
  /** Set for the first output redirect that isn't `/dev/null` or an fd duplication. */
  unsafeRedirect?: UnsafeRedirect;
  /** An unquoted `<(…)`/`>(…)` spawns a process this classifier never tokenizes. */
  processSubstitution: boolean;
  /** Lexing ran off the end inside a quote or a substitution — nothing here is trustworthy. */
  unbalanced: boolean;
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

/** Index of the `)` closing the `(` at `open`, or -1. */
function matchParen(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')' && --depth === 0) return i;
  }
  return -1;
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
function lex(command: string, nested: string[], dialect: Dialect): Lexed {
  const segments: Segment[] = [];
  let unsafeRedirect: UnsafeRedirect | undefined;
  let processSubstitution = false;
  let unbalanced = false;

  let tokens: string[] = [];
  let expandable = false;
  let current = '';
  let started = false;
  let piped = false;
  let quote = '';

  // Set while lexing the text after a write-redirect operator, so that text is
  // captured as the redirect's target instead of pushed onto the segment as an
  // ordinary argument.
  let redirectTargetMode = false;
  let redirectOperator = '';

  const endToken = (hardBoundary = true) => {
    if (redirectTargetMode) {
      // Whitespace right after the operator (`2> /dev/null`) is not the end of
      // the target — keep waiting rather than concluding there is none.
      if (!started && !hardBoundary) return;
      if (!unsafeRedirect && !isDevNullTarget(current)) {
        unsafeRedirect = { operator: redirectOperator, target: current };
      }
      redirectTargetMode = false;
      current = '';
      started = false;
      return;
    }
    if (started) tokens.push(current);
    current = '';
    started = false;
  };
  const endSegment = (nextPiped: boolean) => {
    endToken();
    if (tokens.length > 0) segments.push({ ...toSegment(tokens, piped, dialect), expandable });
    tokens = [];
    expandable = false;
    piped = nextPiped;
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
      if (next !== undefined) { current += next; started = true; }
      i += 2; continue;
    }

    // Substitutions expand inside double quotes too, so these precede the
    // double-quote passthrough below.
    if (c === '$' && command[i + 1] === '(') {
      const close = matchParen(command, i + 1);
      if (close < 0) { unbalanced = true; break; }
      nested.push(command.slice(i + 2, close));
      started = true;
      i = close + 1; continue;
    }
    if (c === '`') {
      const close = command.indexOf('`', i + 1);
      if (close < 0) { unbalanced = true; break; }
      nested.push(command.slice(i + 1, close));
      started = true;
      i = close + 1; continue;
    }
    if (dialect.expansion.test(command.slice(i, i + 2))) {
      expandable = true;
      current += c; started = true; i++; continue;
    }

    if (quote === '"') {
      if (c === '"') { quote = ''; started = true; i++; continue; }
      current += c; started = true; i++; continue;
    }

    if (dialect.quotes.includes(c)) { quote = c; started = true; i++; continue; }

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

      const doubled = command[i + 1] === c;
      const opLen = doubled ? 2 : 1;

      if (c === '>') {
        // `2>&1` / `>&2`: duplicates a stream, writes no file — safe.
        const dup = /^&([0-9]+)(?![0-9])/.exec(command.slice(i + opLen));
        if (dup) {
          i += opLen + dup[0].length;
          continue;
        }
        redirectTargetMode = true;
        redirectOperator = fd + c.repeat(opLen);
      }
      i += opLen;
      continue;
    }

    // `&>file` / `&>>file`: bash shorthand for redirecting stdout+stderr to a
    // file. Must be checked before the `&`-as-operator branch below.
    if (c === '&' && command[i + 1] === '>') {
      endToken();
      const doubled = command[i + 2] === '>';
      redirectTargetMode = true;
      redirectOperator = doubled ? '&>>' : '&>';
      i += doubled ? 3 : 2;
      continue;
    }

    // Subshell grouping is not part of any token: `(rm -rf /)` must lex to `rm`.
    if (c === '(' || c === ')') { endToken(); i++; continue; }

    if (c === '|') {
      const double = command[i + 1] === '|';
      endSegment(!double);
      i += double ? 2 : 1;
      continue;
    }
    if (c === '&' || c === ';' || c === '\n') {
      endSegment(false);
      i += command[i + 1] === c ? 2 : 1;
      continue;
    }

    if (/\s/.test(c)) { endToken(false); i++; continue; }

    current += c; started = true; i++;
  }

  if (quote !== '') unbalanced = true;
  endSegment(false);

  return { segments, unsafeRedirect, processSubstitution, unbalanced };
}

/**
 * The name a segment's binary is matched against the tiers under.
 *
 * `path.basename` alone is not enough: Node's POSIX `path` does not split on
 * `\`, so `C:\Windows\System32\del.exe` came back whole and matched nothing in
 * `REFUSED_COMMANDS`. Both separators are stripped regardless of host, and the
 * dialect decides whether an executable extension comes off too.
 */
function binaryName(token: string, dialect: Dialect): string {
  const base = token.split(/[/\\]/).pop() ?? '';
  // `dot > 0`, not `>= 0`: `lastIndexOf` returns -1 for a name with no dot, and
  // `slice(-1)` would then make the last character look like the extension.
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return base;
  return dialect.strippedExtensions.includes(base.slice(dot).toLowerCase()) ? base.slice(0, dot) : base;
}

/** A `NAME=value` token, in the one position a shell treats as an assignment. */
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

function toSegment(tokens: string[], piped: boolean, dialect: Dialect): Segment {
  const rest = [...tokens];
  const assignments: string[] = [];
  // `FOO=bar cmd` — assignments precede the binary. Kept on the segment, not
  // dropped: they are refused, and the message has to name the one it saw.
  while (rest.length > 0 && ASSIGNMENT.test(rest[0])) assignments.push(rest.shift()!);
  return {
    binary: rest.length > 0 ? binaryName(rest[0], dialect) : '',
    args: rest.slice(1),
    assignments,
    piped,
    expandable: false,
  };
}

/**
 * Where a wrapper's own arguments end, or why they cannot be read.
 *
 * `no-exec` means the flags say the wrapper runs nothing, so there is no inner
 * command to find.
 */
type WrapperScan =
  | { kind: 'command'; tokens: string[]; assignments: string[] }
  | { kind: 'no-exec' }
  | { kind: 'refuse'; reason: string };

/** The short flag in `list` that `token` glues its value onto, if any. */
function joinedShortFlag(list: string[], token: string): string | undefined {
  if (token.length <= 2) return undefined;
  return list.find((f) => f.length === 2 && token.startsWith(f));
}

/**
 * Walk a wrapper's arguments up to the command it will run.
 *
 * An unrecognized flag is refused rather than assumed to be a boolean. The
 * alternative loses the whole point of the table: a flag that in fact takes a
 * separate value would leave that value classified as the command and the
 * refused binary sitting harmlessly in its argument list — a wrapped `rm` back
 * on the prompt tier, which is exactly what unwrapping exists to prevent.
 */
function scanWrapperArgs(binary: string, spec: WrapperSpec, args: string[]): WrapperScan {
  const valueFlags = spec.valueFlags ?? [];
  const stringFlags = spec.stringFlags ?? [];
  const assignments: string[] = [];
  let positionals = spec.positionals ?? 0;
  let i = 0;

  while (i < args.length) {
    const token = args[i];
    // `--` ends the wrapper's options; whatever follows is the command.
    if (token === '--') { i++; break; }

    if (/^-./.test(token)) {
      const eq = token.startsWith('--') ? token.indexOf('=') : -1;
      const name = eq > 0 ? token.slice(0, eq) : token;
      // `--flag=value` carries its value in the same token.
      const selfContained = eq > 0;

      if ((spec.noExecFlags ?? []).includes(name)) return { kind: 'no-exec' };
      if (stringFlags.includes(name) || joinedShortFlag(stringFlags, token)) {
        return {
          kind: 'refuse',
          reason: `"${binary} ${name}" splits a string into a command, which this classifier cannot inspect. Use the read-only research tools, or describe it as a task.`,
        };
      }
      if ((spec.booleanFlags ?? []).includes(name) || spec.booleanPattern?.test(token)) { i++; continue; }
      if (valueFlags.includes(name)) { i += selfContained ? 1 : 2; continue; }
      if (joinedShortFlag(valueFlags, token)) { i++; continue; }
      return {
        kind: 'refuse',
        reason: `"${token}" is not a flag this classifier knows on the wrapper "${binary}", so it cannot tell which command "${binary}" would actually run. Re-run without it.`,
      };
    }

    if (spec.acceptsAssignments && ASSIGNMENT.test(token)) { assignments.push(token); i++; continue; }
    if (positionals > 0) { positionals--; i++; continue; }
    break;
  }

  return { kind: 'command', tokens: args.slice(i), assignments };
}

/** A segment reduced to the command that will actually execute. */
interface Unwrapped {
  seg: Segment;
  /** Wrapper names peeled off, outermost first. Empty when nothing was wrapped. */
  wrappers: string[];
  /** Set when the wrapper's own arguments are what makes the segment refusable. */
  reason?: string;
}

/**
 * Peel wrappers until the segment names something that is not one.
 *
 * Recursive rather than one-shot because wrappers nest — `timeout 10 env nice
 * rm -rf x` is an `rm` — and peeling a single layer would answer for `env`.
 * Termination is structural: every peel consumes at least the wrapper's own
 * binary token.
 *
 * `piped` and `expandable` carry through, so piping into a wrapped interpreter
 * is still a pipe into an interpreter, and a wrapped command whose arguments
 * are not fully visible still cannot take the silent fast path.
 */
function unwrap(seg: Segment, dialect: Dialect): Unwrapped {
  const wrappers: string[] = [];
  // Assignments accumulate across layers instead of staying on the layer that
  // carried them: `env FOO=bar rm -rf x` has to reach `refusalFor` as an `rm`
  // that carries an assignment, which is the shape ticket 06's refusal reads.
  const assignments = [...seg.assignments];
  let current: Segment = seg;

  while (WRAPPER_FAMILY[current.binary]) {
    const scan = scanWrapperArgs(current.binary, WRAPPER_FAMILY[current.binary], current.args);
    if (scan.kind === 'refuse') return { seg: { ...current, assignments }, wrappers, reason: scan.reason };
    // No residual command: the wrapper is the whole invocation (`env` on its
    // own prints the environment), so it is classified under its own name.
    if (scan.kind === 'no-exec' || scan.tokens.length === 0) break;

    assignments.push(...scan.assignments);
    wrappers.push(current.binary);
    const inner = toSegment(scan.tokens, current.piped, dialect);
    assignments.push(...inner.assignments);
    current = { ...inner, assignments: [], expandable: current.expandable };
  }

  return { seg: { ...current, assignments }, wrappers };
}

/** Lex a command line and every substitution body nested inside it. */
function lexAll(command: string, dialect: Dialect): Lexed {
  const queue: string[] = [];
  const top = lex(command, queue, dialect);
  const all: Lexed = { ...top, segments: top.segments.filter((s) => s.binary) };

  // Bounded: a pathological `$($($(…)))` must not spin here.
  for (let depth = 0; depth < 32 && queue.length > 0; depth++) {
    const inner = lex(queue.shift()!, queue, dialect);
    all.segments.push(...inner.segments.filter((s) => s.binary));
    all.unsafeRedirect ??= inner.unsafeRedirect;
    all.processSubstitution ||= inner.processSubstitution;
    all.unbalanced ||= inner.unbalanced;
  }
  return all;
}

/**
 * Path-shaped arguments, in every spelling a host might use.
 *
 * The Windows forms are not cosmetic. `pathLikeArgs` feeds
 * `BaseFileSystem.authorizeCommandPaths`, so an argument this function fails to
 * recognize is one the workspace-confinement prompt never sees. With only the
 * POSIX forms, `cat C:\Users\me\.ssh\id_rsa` matched nothing and ran
 * unprompted — ADR-0008's escape gate silently absent on that platform rather
 * than merely weaker.
 */
function looksLikePath(arg: string): boolean {
  if (arg.startsWith('--') && arg.includes('=')) return looksLikePath(arg.slice(arg.indexOf('=') + 1));
  return arg.startsWith('/')
    || arg.startsWith('~')
    || arg.startsWith('../')
    || arg === '..'
    || arg.startsWith('./')
    // Windows: drive-absolute (`C:\x`, `C:/x`), drive-relative (`C:x`), UNC
    // (`\\server\share`), and root-relative (`\x`).
    || /^[A-Za-z]:/.test(arg)
    || arg.startsWith('\\')
    || arg.startsWith('..\\')
    || arg.startsWith('.\\');
}

/**
 * Every path-shaped argument across every segment (including inside `$(…)`),
 * for the workspace-confinement check `bash()` runs before an `auto`-tier
 * command reaches the shell. `auto` classification only ever looked at the
 * binary — `cat`, `find`, `rg` and friends are auto because *reading* is
 * read-only, but their arguments can still point anywhere on disk, which is
 * exactly the escape path confinement closes for `readFile`/`glob`/`grep`.
 */
export function pathLikeArgs(command: string, opts: CommandPolicyOptions = {}): string[] {
  const dialect = dialectFor(opts.dialect);
  return lexAll(command, dialect).segments.flatMap((seg) => seg.args.flatMap((a) => {
    // `--flag=value` is excluded by the leading-dash filter but its value can
    // still name an external path, so split it and check the value.
    if (a.startsWith('--') && a.includes('=')) {
      const v = a.slice(a.indexOf('=') + 1);
      return looksLikePath(v) ? [v] : [];
    }
    return (!a.startsWith('-') && looksLikePath(a)) ? [a] : [];
  }));
}

/** How a recognized flag relates to the token after it. */
type FlagShape = 'boolean' | 'value';

/**
 * Whether `token` is a flag the binary is known to treat as read-only, and
 * whether it wants the next token as its value.
 *
 * The reading of a token is never guessed at. A flag this returns `undefined`
 * for is refused, so the cost of being wrong is a refusal the model can see and
 * work around — not a value silently swallowed and left unclassified.
 */
function matchFlag(spec: FlagSpec, booleans: Set<string>, values: Set<string>, token: string):
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
function takesNextToken(next: string | undefined): boolean {
  if (next === undefined) return false;
  return !/^-./.test(next) || /^-\d/.test(next);
}

/** The flag as the refusal should name it: `--output`, not `--output=out.diff`. */
function flagLabel(token: string): string {
  const eq = token.startsWith('--') ? token.indexOf('=') : -1;
  return eq > 0 ? token.slice(0, eq) : token;
}

/** What a walk of a permitted binary's arguments found. */
interface FlagScan {
  /** The first flag not known to be read-only, as the refusal should name it. */
  unknown?: string;
  /** Arguments that are not flags and not a flag's value. */
  operands: string[];
}

/**
 * Walk a permitted binary's arguments against its flag set.
 *
 * Returns nothing for a binary with no declared set. The permitted tier is what
 * this policy covers; applying it to a binary that only ever reaches the prompt
 * tier would refuse work the developer is being asked about anyway.
 */
function scanFlags(seg: Segment): FlagScan | undefined {
  const spec = FLAG_POLICY[seg.binary];
  if (!spec || spec.freeform) return undefined;

  const booleans = new Set([...(spec.booleans ?? []), ...UNIVERSAL_FLAGS]);
  const values = new Set(spec.values ?? []);
  const operands: string[] = [];

  let i = 0;
  while (i < seg.args.length) {
    const token = seg.args[i];
    // `--` ends the flags; everything after it is an operand, however it is
    // spelled. Except where the arguments are an expression — see
    // {@link FlagSpec.expressionArgs} — in which case `--` falls through to the
    // matcher and is refused along with anything the caller hoped to hide there.
    if (token === '--' && !spec.expressionArgs) { operands.push(...seg.args.slice(i + 1)); break; }
    if (!/^-./.test(token)) { operands.push(token); i++; continue; }

    const shape = matchFlag(spec, booleans, values, token);
    if (shape === undefined) return { unknown: flagLabel(token), operands };
    i += shape === 'value' && takesNextToken(seg.args[i + 1]) ? 2 : 1;
  }
  return { operands };
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
function subcommandOf(seg: Segment): string | undefined {
  const scan = scanFlags(seg);
  if (scan) return scan.operands[0];
  return seg.args.find((a) => !a.startsWith('-'));
}

/**
 * How many leading arguments a scope carries past the binary.
 *
 * Two rather than one because multiplexers nest: `uv pip list` needs both
 * before the verb is even visible, and one would have scoped it to the inner
 * multiplexer with every verb sharing that grant.
 */
const SCOPE_LEAD_ARGS = 2;

/**
 * What a remembered approval covers.
 *
 * Scope used to be the binary plus its *first* non-flag argument, which
 * collapsed distinct operations onto one grant — approving a read authorised
 * the matching write. Three of those were confirmed by probing:
 *
 *   - `npm run <script>` scoped to `npm run`, so approving the project's test
 *     script pre-authorised every other script in the workspace manifest. This
 *     is the sharpest of the three: on an untrusted repository the attacker
 *     wrote those scripts, and approving a test run is the single most
 *     reasonable approval a developer is ever asked for.
 *   - `az group list` and `az group delete` shared `az group`.
 *   - `aws s3 ls` and `aws s3 rm` shared `aws s3`.
 *
 * So the scope takes the leading non-flag arguments, capped at
 * {@link SCOPE_LEAD_ARGS}. Walking stops at the **first flag**, which is what
 * keeps flag values out of the scope: `docker logs -n 5 web` and
 * `docker logs -n 100 web` are one stable grant rather than a fresh prompt per
 * limit. The cost of stopping there is that a leading flag empties the lead
 * entirely — `mvn -q test` scopes to `mvn` — and that is accepted deliberately,
 * because a scope that varies with a flag value is a scope that prompts forever.
 *
 * Positional rather than flag-aware on purpose. {@link subcommandOf} walks the
 * declared flag sets to find a subcommand, and that is right for deciding a
 * tier; here it would mean the scope depends on how completely a binary's flags
 * happen to be declared, so the same command line could widen its own grant as
 * the flag tables change.
 */
function scopeFor(seg: Segment): string {
  if (!MULTIPLEXERS.includes(seg.binary)) return seg.binary;
  const lead: string[] = [];
  for (const arg of seg.args) {
    if (arg.startsWith('-')) break;
    lead.push(arg);
    if (lead.length === SCOPE_LEAD_ARGS) break;
  }
  return [seg.binary, ...lead].join(' ');
}

function isAuto(seg: Segment): boolean {
  if (!AUTO_COMMANDS.includes(seg.binary)) return false;
  // `x=/etc/passwd; cat $x` gives `cat` the lone argument `$x`, which
  // `pathLikeArgs`/`looksLikePath` cannot see is a path at all — the shell
  // resolves it to whatever the variable holds. An auto-tier command whose
  // arguments are not fully visible at classification time is exactly the
  // confinement escape this file exists to close, so treat any variable
  // reference as disqualifying the fast path rather than trying to resolve it.
  if (seg.expandable) return false;
  if (seg.binary !== 'git') return true;
  const sub = subcommandOf(seg);
  return sub !== undefined && GIT_READONLY_SUBCOMMANDS.includes(sub);
}

function refusalFor(seg: Segment): string | undefined {
  if (REFUSED_COMMANDS.includes(seg.binary)) {
    return `"${seg.binary}" modifies state. You are a read-only planner — describe the change as a task instead, and the runner executing the plan will make it.`;
  }
  // `eval`/`exec` exist only to run a string as a command — the whole point of
  // this classifier is to inspect those strings, so they are never promptable.
  if (seg.binary === 'eval' || seg.binary === 'exec') {
    return `"${seg.binary}" runs a string as a command, which this classifier cannot inspect. Use the read-only research tools, or describe it as a task.`;
  }
  // `source`/`.` run a file's contents as commands the same way `eval` runs a
  // string — refused outright rather than left at `ask`, where an unclassified
  // binary's grant scope collapses to the bare name and one approved script
  // covers every other script sourced in the session.
  if (seg.binary === 'source' || seg.binary === '.') {
    return `"${seg.binary}" runs a file's contents as commands, which this classifier cannot inspect. Use the read-only research tools, or describe it as a task.`;
  }
  // A shell keyword or compound-command opener (`{`, `if`, `time`, `for`, ...)
  // becomes `seg.binary` the same way an ordinary program name would, which
  // leaves the command it actually introduces sitting as an unclassified
  // argument — `if rm -rf src; then :; fi` really does run `rm -rf src`,
  // because the clause's command list executes regardless of the condition.
  // `(`/`)` are not in this list: subshell grouping is stripped at lex time,
  // so `(rm -rf /)` already lexes straight to `rm`.
  if (SHELL_KEYWORDS.includes(seg.binary)) {
    return `"${seg.binary}" is a shell keyword or compound-command opener. This classifier only inspects the command that runs first, and a keyword hides the real one from it. Run the inner command directly, or describe it as a task.`;
  }
  const subs = REFUSED_SUBCOMMANDS[seg.binary];
  if (subs) {
    const sub = subcommandOf(seg);
    if (sub && subs.includes(sub)) {
      return `"${seg.binary} ${sub}" changes state or reaches outward. You are a read-only planner — put it in the plan and let the runner do it.`;
    }
  }
  // `git branch`/`git tag` are read-only subcommands, but their delete/move
  // flag forms mutate refs. The readonly-subcommand allowlist only inspects
  // the subcommand, so these have to be caught here.
  if (seg.binary === 'git') {
    const sub = subcommandOf(seg);
    if (sub === 'branch' || sub === 'tag') {
      const flag = seg.args.find((a) => ['-D', '-d', '-m', '-M', '--delete', '--move'].includes(a));
      if (flag) {
        return `"git ${sub} ${flag}" mutates refs. You are a read-only planner — describe the change as a task instead.`;
      }
      // The flag forms above are not the only way to write a ref: a bare
      // positional (`git branch foo`, `git tag v1`) creates or moves one with
      // no flag involved at all, which the flag-only check above cannot see.
      // `-l`/`--list` is the one shape where a positional is a filter pattern
      // rather than a ref name, so it stays read-only.
      const listing = seg.args.includes('-l') || seg.args.includes('--list');
      const scan = scanFlags(seg);
      const target = scan?.operands[1];
      if (!listing && target) {
        return `"git ${sub} ${target}" creates or moves a ref. You are a read-only planner — describe the change as a task instead.`;
      }
    }
  }
  // `find` is auto because listing is read-only, but `-exec`/`-delete` make it
  // run an arbitrary inner command — the exact bypass this classifier exists
  // to close. Refuse rather than prompt: the inner command is unauditable.
  if (seg.binary === 'find') {
    const flag = seg.args.find((a) => ['-exec', '-execdir', '-ok', '-okdir', '-delete'].includes(a));
    if (flag) {
      return `find with "${flag}" runs an inner command this classifier cannot inspect. Use the read-only research tools on find's output, or describe the change as a task.`;
    }
  }
  // `sed -i`/`awk -i inplace` rewrite files in place — mutation, not research.
  const sedInPlace = seg.binary === 'sed'
    ? seg.args.find((a) => a === '-i' || a === '--in-place' || /^-i./.test(a))
    : undefined;
  if (sedInPlace) {
    return `"sed ${sedInPlace}" edits files in place. You are a read-only planner — describe the change as a task instead.`;
  }
  if (seg.binary === 'awk' && seg.args.some((a) => a === 'inplace')) {
    return `"awk -i inplace" edits files in place. You are a read-only planner — describe the change as a task instead.`;
  }
  if (INTERPRETERS.includes(seg.binary)) {
    if (seg.piped) {
      return `Piping into "${seg.binary}" would run code this classifier cannot inspect. Run the producing command on its own and read its output.`;
    }
    if (seg.args.some(isInlineCodeFlag)) {
      return `Inline code via "${seg.binary} ${seg.args.find(isInlineCodeFlag)}" is not available to the planner. Use the read-only research tools, or describe it as a task.`;
    }
  }
  // Checked last, so a segment whose binary or subcommand is refused on its own
  // terms still says so: `FOO=1 rm -rf x` is answered with `rm`, not with the
  // assignment, and the model does not have to strip the prefix only to be
  // refused a second time.
  //
  // Refused with no name list and no value inspection. A denylist of variable
  // names cannot stay complete, and an allowlist does not help either, because
  // the same name is benign or hostile depending on the value. Prompting was
  // rejected because grants are remembered at `scope` granularity and the scope
  // does not distinguish assignments, so one benign approval would cover a
  // hostile variant. This is the same treatment `eval`, `exec` and process
  // substitution already get: constructs whose effect this classifier cannot
  // read are refused, not asked.
  if (seg.assignments.length > 0) {
    return `The environment assignment "${seg.assignments[0]}" decides what "${seg.binary}" actually does, and this classifier cannot judge the value. Re-run the command without the assignment.`;
  }
  // The flag allowlist, checked last so a binary refused on its own terms still
  // answers for itself. See {@link FLAG_POLICY}: a permitted binary given a flag
  // that is not known to be read-only is refused rather than prompted, so the
  // flags that run helper programs or write files are closed as a class instead
  // of one at a time.
  const scan = scanFlags(seg);
  if (scan?.unknown) {
    return `"${scan.unknown}" is not a flag this classifier knows to be read-only on "${seg.binary}", and flags on otherwise read-only binaries can run a helper program or write a file. Re-run with read-only flags only, or describe the work as a task.`;
  }
  // `uniq INPUT OUTPUT` writes its second operand. The allowlist cannot see this
  // one, because no flag is involved at all — the write is spelled as a
  // positional argument. Read from the scan rather than filtering the raw
  // arguments, so `uniq -f 1 names.txt` is one operand and not two.
  if (seg.binary === 'uniq' && scan && scan.operands.length > 1) {
    return `"uniq" writes to its second file argument ("${scan.operands[1]}"). You are a read-only planner — pipe the output instead of naming an output file, or describe the write as a task.`;
  }
  return undefined;
}

/**
 * Say the wrapper was seen through, so the model does not spend a turn trying
 * the next one. The refusal itself still names the wrapped command, per the same
 * rule that makes `FOO=1 rm -rf x` answer about `rm`: the answer has to be the
 * one the model can act on.
 */
function withWrapperNote(reason: string, wrappers: string[]): string {
  if (wrappers.length === 0) return reason;
  const quoted = wrappers.map((w) => `"${w}"`);
  const names = quoted.length > 1
    ? `${quoted.slice(0, -1).join(', ')} and ${quoted[quoted.length - 1]}`
    : quoted[0];
  return `${reason} Wrapping it in ${names} does not change what runs.`;
}

/**
 * Classify one command line. Output redirection is refused outright unless the
 * target provably writes nothing — `/dev/null`, or an fd duplication like
 * `2>&1` — since a planner that writes files has stopped being a planner.
 */
export function classifyCommand(command: string, opts: CommandPolicyOptions = {}): CommandClassification {
  const trimmed = command.trim();
  if (!trimmed) return { tier: 'refuse', scope: '', reason: 'Empty command.' };

  const dialect = dialectFor(opts.dialect);
  const { segments, unsafeRedirect, processSubstitution, unbalanced } = lexAll(trimmed, dialect);

  if (unbalanced) {
    return {
      tier: 'refuse',
      scope: '',
      reason: 'Unterminated quote or command substitution — this classifier cannot tell what would actually run. Rewrite the command with balanced quotes.',
    };
  }

  // Process substitution `<(…)`/`>(…)` spawns a process this classifier never
  // tokenizes — `cat <(rm -rf /)` would otherwise run `rm` with no prompt.
  if (processSubstitution) {
    return {
      tier: 'refuse',
      scope: '',
      reason: 'Process substitution runs another command this classifier cannot inspect. Run the command on its own and read its output, or describe it as a task.',
    };
  }

  if (unsafeRedirect) {
    const written = unsafeRedirect.target
      ? `"${unsafeRedirect.operator} ${unsafeRedirect.target}"`
      : `"${unsafeRedirect.operator}"`;
    return {
      tier: 'refuse',
      scope: '',
      reason: `${written} writes to a file. You are a read-only planner — read the output instead, or describe the write as a task.`,
    };
  }

  if (segments.length === 0) return { tier: 'refuse', scope: '', reason: 'No command found.' };

  // Every segment is reduced to the command that will actually execute first,
  // so `env`, `nice`, `timeout` and friends decide nothing about the answer.
  const unwrapped = segments.map((seg) => unwrap(seg, dialect));

  for (const { seg, wrappers, reason: wrapperReason } of unwrapped) {
    if (wrapperReason) return { tier: 'refuse', scope: '', reason: wrapperReason };
    const reason = refusalFor(seg);
    if (reason) return { tier: 'refuse', scope: '', reason: withWrapperNote(reason, wrappers) };
  }

  const nonAuto = unwrapped.map((u) => u.seg).filter((s) => !isAuto(s));
  if (nonAuto.length === 0) return { tier: 'auto', scope: '' };

  // A grant covers only the parts that actually needed one, so
  // `az group list | head` is remembered as `az group`, not the whole line.
  const scope = [...new Set(nonAuto.map(scopeFor))].sort().join(' + ');
  return { tier: 'ask', scope };
}
