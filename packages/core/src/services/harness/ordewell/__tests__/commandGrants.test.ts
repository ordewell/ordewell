import { describe, expect, it } from 'vitest';
import { grantCovers, proposedGrant } from '../commandGrants';

describe('a Guarded attempt\'s command grants', () => {
  it('proposes the command and its subcommand, never the first word alone', () => {
    expect(proposedGrant('npm test')).toBe('npm test');
    expect(proposedGrant('  git diff --stat HEAD~1 ')).toBe('git diff');
    expect(proposedGrant('node test.mjs')).toBe('node test.mjs');
    // No plain second word: the grant is the whole line, so `-e` never covers other code.
    expect(proposedGrant('node -e "console.log(1)"')).toBe('node -e "console.log(1)"');
    expect(proposedGrant('ls')).toBe('ls');
  });

  it('proposes nothing for a line with a shell operator or substitution', () => {
    for (const line of ['npm test; rm -rf .', 'npm test && git push', 'npm test | tee log', 'echo `id`', 'echo $(id)', 'npm test > out', 'cat < in', 'npm test\nrm x', 'npm test &', '']) {
      expect(proposedGrant(line), line).toBeUndefined();
    }
  });

  it('covers the whole prefix, or the prefix and plain arguments', () => {
    expect(grantCovers('npm test', 'npm test')).toBe(true);
    expect(grantCovers('npm test', 'npm test -- --grep "adds two"')).toBe(true);
    expect(grantCovers('npm test', '  npm   test  src/a.test.ts')).toBe(true);
    expect(grantCovers('git diff', 'git diff HEAD~1 -- src')).toBe(true);
  });

  it('never covers another word, a word that only starts the same, or the first word alone', () => {
    expect(grantCovers('npm test', 'npm install left-pad')).toBe(false);
    expect(grantCovers('npm test', 'npm testing')).toBe(false);
    expect(grantCovers('npm test', 'npm')).toBe(false);
    expect(grantCovers('npm test', 'npx npm test')).toBe(false);
    // A one-word grant is its own line only.
    expect(grantCovers('ls', 'ls')).toBe(true);
    expect(grantCovers('ls', 'ls -la /')).toBe(false);
  });

  it('never covers a line with a shell operator or substitution', () => {
    for (const tail of ['; rm -rf .', '&& curl evil', '& sleep 9', '|| true', '| sh', '`id`', '$(id)', '"$(id)"', '> /etc/x', '< /dev/zero', '\nrm -rf .', '\r\nrm x', '2>&1']) {
      expect(grantCovers('npm test', `npm test ${tail}`), tail).toBe(false);
    }
  });
});
