import { describe, it, expect } from 'vitest';
import { buildGrepArgs, buildGlobArgs, buildFallbackGrepArgs, filterFallbackByAnchoredInclude, applyHeadLimit, formatSearchOutput } from '../ripgrepArgs';
import { SEARCH_EXCLUSIONS } from '../../interfaces/IFileSystem';

describe('buildGrepArgs', () => {
  it('never caps per file — the old --max-count made a wide search return tens of thousands of rows', () => {
    const { args } = buildGrepArgs('TODO', {}, '/repo');
    expect(args).not.toContain('--max-count');
    expect(args).not.toContain('-m');
  });

  it('carries the row cap out of band so the caller can truncate honestly', () => {
    expect(buildGrepArgs('TODO', {}, '/repo').headLimit).toBe(100);
    expect(buildGrepArgs('TODO', { headLimit: 25 }, '/repo').headLimit).toBe(25);
  });

  it('excludes the same directories glob does, so build output cannot eat the budget', () => {
    const { args } = buildGrepArgs('TODO', {}, '/repo');
    for (const dir of ['node_modules', 'dist', '.ordewell', '.git']) {
      expect(args).toContain(`!**/${dir}/**`);
    }
  });

  it('orders by recency, because with a hard cap what gets dropped is the result quality', () => {
    const { args } = buildGrepArgs('TODO', {}, '/repo');
    expect(args.join(' ')).toContain('--sortr modified');
  });

  it('passes the pattern behind -e and the root behind --, so neither can be read as a flag', () => {
    const { args } = buildGrepArgs('-oh-no', {}, '/repo');
    expect(args[args.indexOf('-e') + 1]).toBe('-oh-no');
    expect(args[args.length - 2]).toBe('--');
    expect(args[args.length - 1]).toBe('/repo');
  });

  it('keeps shell metacharacters literal — args are a list, never an interpolated string', () => {
    const { args } = buildGrepArgs('$(whoami)`id`', {}, '/repo');
    expect(args).toContain('$(whoami)`id`');
  });

  describe('output modes', () => {
    it('content mode returns numbered lines', () => {
      const { args } = buildGrepArgs('TODO', { outputMode: 'content' }, '/repo');
      expect(args).toContain('--line-number');
      expect(args).not.toContain('--files-with-matches');
    });

    it('files mode returns paths only', () => {
      const { args } = buildGrepArgs('TODO', { outputMode: 'files' }, '/repo');
      expect(args).toContain('--files-with-matches');
      expect(args).not.toContain('--line-number');
    });

    it('count mode returns per-file tallies', () => {
      const { args } = buildGrepArgs('TODO', { outputMode: 'count' }, '/repo');
      expect(args).toContain('--count-matches');
    });

    it('applies context only in content mode', () => {
      const content = buildGrepArgs('TODO', { outputMode: 'content', contextBefore: 2, contextAfter: 3 }, '/repo').args;
      expect(content).toContain('--before-context');
      expect(content).toContain('--after-context');

      const files = buildGrepArgs('TODO', { outputMode: 'files', contextBefore: 2 }, '/repo').args;
      expect(files).not.toContain('--before-context');
    });
  });

  it('maps literal and case-insensitive flags', () => {
    const { args } = buildGrepArgs('a(b)', { literal: true, caseInsensitive: true }, '/repo');
    expect(args).toContain('--fixed-strings');
    expect(args).toContain('--ignore-case');
  });

  it('passes an include glob through', () => {
    const { args } = buildGrepArgs('TODO', { include: '*.ts' }, '/repo');
    expect(args[args.indexOf('--glob', args.indexOf('--glob') + 1)]).toBeDefined();
    expect(args).toContain('*.ts');
  });
});

describe('buildGlobArgs', () => {
  it('lists files with the shared exclusions applied', () => {
    const args = buildGlobArgs('src/**/*.ts', '/repo');
    expect(args).toContain('--files');
    expect(args).toContain('src/**/*.ts');
    expect(args).toContain(`!**/${SEARCH_EXCLUSIONS[0]}/**`);
  });

  // ripgrep applies `--glob` last-wins, so the include must precede the
  // exclusions or it would override them and search node_modules/dist.
  it('places the include before the exclusions so negations win', () => {
    const args = buildGlobArgs('*.ts', '/repo');
    const includePos = args.indexOf('*.ts');
    const firstExclusionPos = args.indexOf(`!**/${SEARCH_EXCLUSIONS[0]}/**`);
    expect(includePos).toBeLessThan(firstExclusionPos);
  });
});

describe('buildGrepArgs include vs exclusions', () => {
  it('places the include before the exclusions so negations win', () => {
    const { args } = buildGrepArgs('TODO', { include: '*.ts' }, '/repo');
    const includePos = args.indexOf('*.ts');
    const firstExclusionPos = args.indexOf(`!**/${SEARCH_EXCLUSIONS[0]}/**`);
    expect(includePos).toBeLessThan(firstExclusionPos);
  });
});

describe('formatSearchOutput with root == /', () => {
  // Stripping a leading slash when the workspace root is `/` would leave the
  // model with `etc/passwd` — unusable as a path for read_file.
  it('does not strip a leading slash when the root is the filesystem root', () => {
    const capped = applyHeadLimit('/etc/passwd:1:hit', 100);
    expect(formatSearchOutput(capped, '/', { emptyMessage: 'none' })).toBe('/etc/passwd:1:hit');
  });
});

describe('formatSearchOutput separator', () => {
  // The prefix was built as `root + '/'`, so on Windows `C:\\repo` produced
  // `C:\\repo/`, matched nothing, and every row stayed absolute — full path
  // length paid on every result of every search.
  it('strips a Windows workspace prefix using the Windows separator', () => {
    const capped = applyHeadLimit('C:\\repo\\src\\a.ts:12:hit', 100);
    expect(formatSearchOutput(capped, 'C:\\repo', { emptyMessage: 'none', sep: '\\' }))
      .toBe('src\\a.ts:12:hit');
  });

  it('still strips a POSIX workspace prefix', () => {
    const capped = applyHeadLimit('/repo/src/a.ts:12:hit', 100);
    expect(formatSearchOutput(capped, '/repo', { emptyMessage: 'none', sep: '/' }))
      .toBe('src/a.ts:12:hit');
  });

  it('does not strip a lone drive root, which has no useful prefix', () => {
    const capped = applyHeadLimit('C:\\x.txt:1:hit', 100);
    expect(formatSearchOutput(capped, 'C:\\', { emptyMessage: 'none', sep: '\\' }))
      .toBe('x.txt:1:hit');
  });
});

describe('buildFallbackGrepArgs', () => {
  it('excludes the same directories as the ripgrep path', () => {
    const args = buildFallbackGrepArgs('TODO', {}, '/repo');
    expect(args).toContain('--exclude-dir=node_modules');
    expect(args).toContain('--exclude-dir=dist');
  });

  it('maps output modes onto POSIX grep flags', () => {
    expect(buildFallbackGrepArgs('TODO', { outputMode: 'files' }, '/repo')).toContain('-l');
    expect(buildFallbackGrepArgs('TODO', { outputMode: 'count' }, '/repo')).toContain('-c');
  });

  it('requests PCRE mode so patterns like find_symbol\'s (?:...) groups actually work', () => {
    // Without -P, GNU grep's BRE/ERE cannot express non-capturing groups: it
    // either errors ("Unmatched \{") or silently treats the pattern's
    // parens/pipes as literal characters and reports a confident empty
    // result — the same class of silent-wrong-answer bug the ADR fixed for
    // --max-count, reopened here for the regex dialect instead.
    expect(buildFallbackGrepArgs('(?:foo|bar)', {}, '/repo')).toContain('-P');
  });

  it('does not request -P in literal mode, since -P and -F are mutually exclusive', () => {
    const args = buildFallbackGrepArgs('literal(text)', { literal: true }, '/repo');
    expect(args).toContain('-F');
    expect(args).not.toContain('-P');
  });
});

describe('filterFallbackByAnchoredInclude', () => {
  // GNU grep's --include only matches a basename, so callers must strip an
  // anchored `include` before invoking grep and filter its output here instead.
  it('keeps content-mode lines whose path matches the anchored glob', () => {
    const stdout = [
      '/repo/subdir/nested.txt:1:nested content',
      '/repo/other/nested.txt:1:nested content',
    ].join('\n');
    const filtered = filterFallbackByAnchoredInclude(stdout, 'subdir/*.txt', '/repo', 'content');
    expect(filtered).toBe('/repo/subdir/nested.txt:1:nested content');
  });

  it('handles files mode, where the whole line is the path', () => {
    const stdout = '/repo/subdir/nested.txt\n/repo/other/nested.txt';
    const filtered = filterFallbackByAnchoredInclude(stdout, 'subdir/*.txt', '/repo', 'files');
    expect(filtered).toBe('/repo/subdir/nested.txt');
  });

  it('handles count mode, where the count trails the path after a colon', () => {
    const stdout = '/repo/subdir/nested.txt:2\n/repo/other/nested.txt:1';
    const filtered = filterFallbackByAnchoredInclude(stdout, 'subdir/*.txt', '/repo', 'count');
    expect(filtered).toBe('/repo/subdir/nested.txt:2');
  });

  it('matches ** across directory boundaries', () => {
    const stdout = '/repo/a/b/nested.txt:1:hit';
    const filtered = filterFallbackByAnchoredInclude(stdout, '**/*.txt', '/repo', 'content');
    expect(filtered).toBe('/repo/a/b/nested.txt:1:hit');
  });
});

describe('applyHeadLimit', () => {
  it('caps rows globally and reports the true total', () => {
    const stdout = Array.from({ length: 250 }, (_, i) => `line ${i}`).join('\n');
    const capped = applyHeadLimit(stdout, 100);

    expect(capped.rows).toHaveLength(100);
    expect(capped.total).toBe(250);
    expect(capped.truncated).toBe(true);
  });

  it('does not claim truncation when everything fit', () => {
    const capped = applyHeadLimit('a\nb\nc', 100);
    expect(capped.truncated).toBe(false);
    expect(capped.total).toBe(3);
  });

  it('treats empty output as zero rows rather than one blank row', () => {
    expect(applyHeadLimit('', 100).rows).toEqual([]);
    expect(applyHeadLimit('\n\n', 100).rows).toEqual([]);
  });
});

describe('formatSearchOutput', () => {
  it('makes paths workspace-relative so the model sees the paths it can pass back', () => {
    const capped = applyHeadLimit('/repo/src/a.ts:1:hit', 100);
    expect(formatSearchOutput(capped, '/repo', { emptyMessage: 'none' })).toBe('src/a.ts:1:hit');
  });

  it('says so when rows were dropped — a silent cut reads as a complete answer', () => {
    const stdout = Array.from({ length: 5 }, (_, i) => `/repo/f${i}.ts:1:hit`).join('\n');
    const output = formatSearchOutput(applyHeadLimit(stdout, 2), '/repo', { emptyMessage: 'none', hint: 'Narrow it.' });

    expect(output).toContain('showing 2 of 5 results');
    expect(output).toContain('Narrow it.');
  });

  it('returns the caller-supplied empty message rather than an empty string', () => {
    expect(formatSearchOutput(applyHeadLimit('', 100), '/repo', { emptyMessage: 'No matches found.' }))
      .toBe('No matches found.');
  });
});
