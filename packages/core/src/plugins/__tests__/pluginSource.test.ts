import { describe, it, expect } from 'vitest';
import {
  assertInstallablePluginUrl,
  classifyPluginSource,
  ALLOWED_PLUGIN_HOSTS,
} from '../pluginSource';

describe('assertInstallablePluginUrl', () => {
  it('accepts an ordinary https repository on an allowed host', () => {
    const url = assertInstallablePluginUrl('https://github.com/user/repo.git');
    expect(url.hostname).toBe('github.com');
    expect(url.pathname).toBe('/user/repo.git');
  });

  it('accepts every host in the allowed set', () => {
    for (const host of ALLOWED_PLUGIN_HOSTS) {
      expect(() => assertInstallablePluginUrl(`https://${host}/user/repo.git`)).not.toThrow();
    }
  });

  it.each([
    ['git protocol', 'git://github.com/user/repo.git'],
    ['ssh protocol', 'ssh://git@github.com/user/repo.git'],
    ['file protocol', 'file:///etc/passwd'],
    ['http protocol', 'http://github.com/user/repo.git'],
    ['ext transport helper', 'ext::sh -c "touch /tmp/pwned"'],
    ['ext helper with host', 'ext::ssh %S github.com /user/repo'],
  ])('rejects %s', (_label, url) => {
    expect(() => assertInstallablePluginUrl(url)).toThrow();
  });

  it('rejects a host outside the allowed set', () => {
    expect(() => assertInstallablePluginUrl('https://evil.example/user/repo.git'))
      .toThrow(/host not allowed/i);
  });

  it('rejects an allowed host used only as a userinfo prefix', () => {
    expect(() => assertInstallablePluginUrl('https://github.com@evil.example/repo.git')).toThrow();
  });

  it.each([
    ['command substitution', 'https://github.com/user/$(touch /tmp/pwned)'],
    ['backticks', 'https://github.com/user/`id`'],
    ['semicolon chaining', 'https://github.com/user/repo.git;touch /tmp/pwned'],
    ['ampersand chaining', 'https://github.com/user/repo.git&&id'],
    ['pipe', 'https://github.com/user/repo.git|id'],
    ['embedded quote', 'https://github.com/user/"repo".git'],
    ['newline', 'https://github.com/user/repo\n.git'],
  ])('rejects a URL carrying %s', (_label, url) => {
    expect(() => assertInstallablePluginUrl(url)).toThrow();
  });

  it('rejects embedded credentials, ports, queries and fragments', () => {
    expect(() => assertInstallablePluginUrl('https://user:pw@github.com/u/r.git')).toThrow(/credentials/i);
    expect(() => assertInstallablePluginUrl('https://github.com:8443/u/r.git')).toThrow(/port/i);
    expect(() => assertInstallablePluginUrl('https://github.com/u/r.git?x=1')).toThrow(/query/i);
    expect(() => assertInstallablePluginUrl('https://github.com/u/r.git#frag')).toThrow(/query|fragment/i);
  });

  it('rejects empty and non-string input', () => {
    expect(() => assertInstallablePluginUrl('')).toThrow();
    expect(() => assertInstallablePluginUrl('   ')).toThrow();
    expect(() => assertInstallablePluginUrl(undefined)).toThrow();
    expect(() => assertInstallablePluginUrl(42)).toThrow();
  });

  it('rejects a dash-prefixed argument masquerading as a URL', () => {
    expect(() => assertInstallablePluginUrl('--upload-pack=touch /tmp/pwned')).toThrow();
  });
});

describe('classifyPluginSource', () => {
  it('expands the github: shorthand to an https URL', () => {
    expect(classifyPluginSource('github:user/repo')).toEqual({
      kind: 'git',
      url: 'https://github.com/user/repo.git',
    });
  });

  it('does not double-suffix a github: shorthand that already ends in .git', () => {
    expect(classifyPluginSource('github:user/repo.git')).toEqual({
      kind: 'git',
      url: 'https://github.com/user/repo.git',
    });
  });

  it('routes any scheme-bearing source to the git route so it is validated', () => {
    expect(classifyPluginSource('git://evil.example/repo').kind).toBe('git');
    expect(classifyPluginSource('ext::sh -c id').kind).toBe('git');
    expect(classifyPluginSource('https://gitlab.com/u/r.git').kind).toBe('git');
  });

  it('routes an scp-style remote to the git route', () => {
    expect(classifyPluginSource('git@github.com:user/repo.git').kind).toBe('git');
  });

  it('treats ordinary paths as local directories', () => {
    expect(classifyPluginSource('./my-plugin')).toEqual({ kind: 'path', path: './my-plugin' });
    expect(classifyPluginSource('/abs/my-plugin')).toEqual({ kind: 'path', path: '/abs/my-plugin' });
    expect(classifyPluginSource('C:\\plugins\\mine')).toEqual({ kind: 'path', path: 'C:\\plugins\\mine' });
  });
});
