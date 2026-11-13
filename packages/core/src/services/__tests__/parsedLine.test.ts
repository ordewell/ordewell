import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as shellLexer from '../shellLexer';
import { ParsedLine } from '../parsedLine';
import { cdUnfollowed, classifyCommand, excludedBy, innerCommandScopes, pathRefs } from '../commandPolicy';
import { disableWebCommandStartup, pinWebCommandAddresses, wgetVersionCommands } from '../webCommands';
import { parseAllowlist } from '../plannerAllowlist';

vi.mock('../shellLexer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../shellLexer')>();
  return { ...actual, lex: vi.fn(actual.lex), lexAll: vi.fn(actual.lexAll) };
});

const UNCHECKABLE = 'The wget executable cannot be checked safely';
const WGET_AFTER_CD = 'cd a && wget -O - https://x.com/';

/**
 * The probe used to read `process.env.CDPATH` while every other reader of the
 * line took the site's setting, so a site that had CDPATH where the host did
 * not got a probe run from a directory the shell might never enter.
 */
describe("the wget probe follows the site's cdpath setting", () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.CDPATH;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.CDPATH;
    else process.env.CDPATH = saved;
  });

  it('has no probe after a cd when the site sets CDPATH, though the host does not', () => {
    delete process.env.CDPATH;
    const line = ParsedLine.parse(WGET_AFTER_CD, { dialect: 'posix', cdpathSet: true });
    expect(wgetVersionCommands(line)).toEqual([undefined]);
    const verdict = classifyCommand(line);
    expect(verdict.tier).toBe('refuse');
    expect(verdict.reason).toContain(UNCHECKABLE);
  });

  it('probes from the followed cd when the site has no CDPATH, though the host does', () => {
    process.env.CDPATH = '/tmp';
    const line = ParsedLine.parse(WGET_AFTER_CD, { dialect: 'posix', cdpathSet: false });
    expect(wgetVersionCommands(line)).toEqual([
      "cd 'a' && XDG_DATA_HOME=/dev/null XDG_CONFIG_HOME=/dev/null LOCALAPPDATA=NUL 'wget' --no-config --version",
    ]);
    expect(classifyCommand(line).reason ?? '').not.toContain(UNCHECKABLE);
  });

  it('still has no probe where a line break was trimmed off an end of the line', () => {
    for (const command of [`\n${WGET_AFTER_CD}`, `${WGET_AFTER_CD}\n`]) {
      const line = ParsedLine.parse(command, { dialect: 'posix' });
      expect(wgetVersionCommands(line)).toEqual([undefined]);
      expect(classifyCommand(line).tier).toBe('refuse');
    }
  });
});

/**
 * One awkward line — padded, a quoted cd target, an escaped space in a URL, a
 * path that climbs, an excluded inner command — read by every helper. Each
 * must see the one lex `ParsedLine.parse` made, so they agree on whether the
 * `cd` was followed and on where each word ends in the line as given.
 */
describe('every reader of a line sees the same tokens', () => {
  const COMMAND = "  cd 'docs dir' && curl -s https://x.com/a && wget -q -O - https://x.com/b\\ c && cat ../up.txt && kubectl get secret  ";
  const allow = parseAllowlist(['!kubectl *secret*']);
  const addresses = new Map([['https://x.com', '93.184.216.34']]);

  function readAll(line: ParsedLine) {
    return {
      verdict: classifyCommand(line, { allow }),
      refs: pathRefs(line),
      excluded: excludedBy(line, allow),
      scopes: innerCommandScopes(line),
      unfollowed: cdUnfollowed(line),
      probes: wgetVersionCommands(line),
      startup: disableWebCommandStartup(line),
      pinned: pinWebCommandAddresses(line, addresses),
    };
  }

  it('lexes the line once, however many helpers read it', () => {
    vi.mocked(shellLexer.lexAll).mockClear();
    vi.mocked(shellLexer.lex).mockClear();
    const line = ParsedLine.parse(COMMAND, { dialect: 'posix' });
    expect(shellLexer.lexAll).toHaveBeenCalledTimes(1);
    expect(shellLexer.lexAll).toHaveBeenCalledWith(COMMAND.trim(), line.dialect, false);
    readAll(line);
    expect(shellLexer.lexAll).toHaveBeenCalledTimes(1);
    expect(shellLexer.lex).not.toHaveBeenCalled();
  });

  it('follows the cd in every helper, or in none', () => {
    const followed = readAll(ParsedLine.parse(COMMAND, { dialect: 'posix', cdpathSet: false }));
    expect(followed.unfollowed).toBe(false);
    expect(followed.refs).toEqual([{ path: '../up.txt', cwd: ['docs dir'] }]);
    expect(followed.probes).toEqual([
      "cd 'docs dir' && XDG_DATA_HOME=/dev/null XDG_CONFIG_HOME=/dev/null LOCALAPPDATA=NUL 'wget' --no-config --version",
    ]);
    expect(followed.scopes).not.toContain('cd');

    const unfollowed = readAll(ParsedLine.parse(COMMAND, { dialect: 'posix', cdpathSet: true }));
    expect(unfollowed.unfollowed).toBe(true);
    expect(unfollowed.refs).toEqual([{ path: '../up.txt', cwd: [] }]);
    expect(unfollowed.probes).toEqual([undefined]);
    expect(unfollowed.scopes).toContain('cd');

    for (const read of [followed, unfollowed]) {
      expect(read.excluded).toBe('!kubectl *secret*');
      expect(read.verdict.tier).toBe('refuse');
    }
  });

  it('edits the line as given, at the words the lex found', () => {
    const { startup, pinned } = readAll(ParsedLine.parse(COMMAND, { dialect: 'posix' }));
    expect(startup).toBe(
      "  cd 'docs dir' && curl -q --noproxy '*' -s https://x.com/a && wget --no-config --no-hsts --no-proxy --no-netrc -q -O - https://x.com/b\\ c && cat ../up.txt && kubectl get secret  ",
    );
    expect(pinned.command).toBe(
      "  cd 'docs dir' && curl --resolve 'x.com:443:93.184.216.34' -s https://x.com/a && wget -q -O - https://x.com/b\\ c && cat ../up.txt && kubectl get secret  ",
    );
    expect([...pinned.resolves]).toEqual(['x.com:443:93.184.216.34']);
  });

  it('freezes what it holds, so no reader can change what the next one sees', () => {
    const line = ParsedLine.parse(COMMAND, { dialect: 'posix' });
    expect(Object.isFrozen(line)).toBe(true);
    expect(Object.isFrozen(line.segments)).toBe(true);
    for (const seg of line.segments) {
      expect(Object.isFrozen(seg)).toBe(true);
      expect(Object.isFrozen(seg.args)).toBe(true);
    }
  });
});
