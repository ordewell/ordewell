import { describe, it, expect } from 'vitest';
import { nativeShellOffer } from '../nativeShell';

describe('nativeShellOffer', () => {
  it('offers the checked harness versions on macOS', () => {
    expect(nativeShellOffer({ runner: 'claude-code', version: '2.1.304', platform: 'darwin' })).toEqual({ offered: true });
    expect(nativeShellOffer({ runner: 'opencode', version: '2.0.32', platform: 'darwin' })).toEqual({ offered: true });
  });

  it('covers the checked line, not just the exact patch the checks ran on', () => {
    expect(nativeShellOffer({ runner: 'claude-code', version: '2.1.400', platform: 'darwin' }).offered).toBe(true);
    expect(nativeShellOffer({ runner: 'opencode', version: '2.0.99', platform: 'darwin' }).offered).toBe(true);
  });

  it.each([
    ['an older Claude Code', 'claude-code', '2.1.303'],
    ['a newer Claude Code line', 'claude-code', '2.2.0'],
    ['an older OpenCode 2.x', 'opencode', '2.0.31'],
    ['a newer OpenCode line', 'opencode', '2.1.0'],
    ['OpenCode 1.x', 'opencode', '1.18.34'],
    ['a prerelease of the checked version', 'claude-code', '2.1.304-beta.1'],
  ])('does not offer %s', (_label, runner, version) => {
    const offer = nativeShellOffer({ runner, version, platform: 'darwin' });
    expect(offer.offered).toBe(false);
    if (!offer.offered) expect(offer.reason).toContain(version);
  });

  it('names OpenCode 1.x when no version was reported', () => {
    const offer = nativeShellOffer({ runner: 'opencode', version: null, platform: 'darwin' });
    expect(offer.offered).toBe(false);
    if (!offer.offered) expect(offer.reason).toContain('OpenCode 1.x');
  });

  it('does not offer a checked version on an unchecked platform: Linux waits for its own live checks', () => {
    const offer = nativeShellOffer({ runner: 'claude-code', version: '2.1.304', platform: 'linux' });
    expect(offer.offered).toBe(false);
    if (!offer.offered) expect(offer.reason).toMatch(/macOS only.*Linux|Linux.*not/);
  });

  it('says the setting changes nothing for Codex, which already has its shell', () => {
    const offer = nativeShellOffer({ runner: 'codex', version: '0.162.0', platform: 'darwin' });
    expect(offer.offered).toBe(false);
    if (!offer.offered) expect(offer.reason).toContain('already runs its own shell');
  });

  it('says why Codex plans without its own shell on Windows, rather than claiming a sandbox it lacks there', () => {
    const offer = nativeShellOffer({ runner: 'codex', version: '0.166.0', platform: 'win32' });
    expect(offer.offered).toBe(false);
    if (!offer.offered) {
      expect(offer.reason).toMatch(/own shell off/);
      expect(offer.reason).not.toContain('without the network (ADR-0026)');
    }
  });

  it('refuses a harness it has never checked', () => {
    const offer = nativeShellOffer({ runner: 'unknown-agent', version: '1.0.0', platform: 'darwin' });
    expect(offer.offered).toBe(false);
    if (!offer.offered) expect(offer.reason).toContain('not been checked live');
  });
});
