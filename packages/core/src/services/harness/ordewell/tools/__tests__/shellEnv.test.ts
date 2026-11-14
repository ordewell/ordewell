import { describe, expect, it } from 'vitest';
import { buildToolEnv } from '../shellEnv';

describe('buildToolEnv', () => {
  const base = {
    PATH: '/usr/bin:/bin',
    HOME: '/home/u',
    LANG: 'C.UTF-8',
    LC_ALL: 'C',
    TMPDIR: '/tmp',
    CARGO_HOME: '/home/u/.cargo',
    OPENAI_API_KEY: 'sk-parent-openai',
    ANTHROPIC_API_KEY: 'sk-ant-parent',
    GITHUB_TOKEN: 'ghp_parent',
    MY_SERVICE_SECRET: 'shh',
    SOME_UNLISTED_VAR: 'not on the list',
    HTTPS_PROXY: 'http://user:pw@proxy.example:3128',
    NO_PROXY: 'localhost',
  };

  it('keeps ordinary variables and drops everything else', () => {
    const env = buildToolEnv(base, undefined, 'linux');
    expect(env).toMatchObject({ PATH: '/usr/bin:/bin', HOME: '/home/u', LANG: 'C.UTF-8', LC_ALL: 'C', TMPDIR: '/tmp', CARGO_HOME: '/home/u/.cargo', NO_PROXY: 'localhost' });
    expect(Object.keys(env)).not.toContain('SOME_UNLISTED_VAR');
  });

  it('holds no provider key, token, secret or proxy password', () => {
    const env = buildToolEnv(base, undefined, 'linux');
    const text = JSON.stringify(env);
    for (const secret of ['sk-parent-openai', 'sk-ant-parent', 'ghp_parent', 'shh', 'pw@proxy']) expect(text).not.toContain(secret);
    expect(Object.keys(env)).not.toEqual(expect.arrayContaining(['OPENAI_API_KEY']));
  });

  it('has one PATH key, whatever case the host spelled it in on Windows', () => {
    const env = buildToolEnv({ Path: 'C:\\Windows', SystemRoot: 'C:\\Windows', OPENAI_API_KEY: 'x' }, undefined, 'win32');
    expect(Object.keys(env).filter((k) => k.toLowerCase() === 'path')).toEqual(['Path']);
    expect(env.Path).toBe('C:\\Windows');
    expect(env.SystemRoot).toBe('C:\\Windows');
    expect(env.OPENAI_API_KEY).toBeUndefined();
  });

  it('puts the Git Bash utilities in front of PATH on Windows', () => {
    const shell = { file: 'C:\\Git\\bin\\bash.exe', args: ['-c'], dialect: 'posix' as const, utilsDir: 'C:\\Git\\usr\\bin' };
    const env = buildToolEnv({ Path: 'C:\\Windows' }, shell, 'win32');
    expect(env.Path).toBe('C:\\Git\\usr\\bin;C:\\Windows');
  });
});
