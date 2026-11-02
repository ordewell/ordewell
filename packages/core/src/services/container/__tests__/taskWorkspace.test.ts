import { spawnSync } from 'child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CODEX_SIGN_IN_FILE, COPY_CODEX_SIGN_IN, COPY_OPENCODE_SIGN_IN, COPY_SIGN_IN, HOME_DIR, mirrorDir, repoDir } from '../taskWorkspace';

describe('where a repository is in a container', () => {
  it('keeps a lone repository at the workspace', () => {
    expect(repoDir({ path: '.' })).toBe('/task/work');
  });

  it('keeps a group at its paths', () => {
    expect(repoDir({ path: 'services/api' })).toBe('/task/work/services/api');
  });

  it('gives every repo of a group a mirror of its own, however alike their paths: one shared would swap their pins', () => {
    const paths = ['a/b', 'a_b', 'a-b', 'a.b'];

    expect(new Set(paths.map((path) => mirrorDir({ path }))).size).toBe(paths.length);
  });

  it('writes a mirror path a shell and git take as it is', () => {
    expect(mirrorDir({ path: "it's a/repo $HOME" })).toMatch(/^\/mirror\/[0-9a-f]+\.git$/);
  });
});

/**
 * The hand-off as a shell runs it, under a stand-in for `claude` that answers as
 * the real one was measured to (ADR-0059 L7): logged in on a token or a key.
 * `dockerLease.e2e.test.ts` runs it with the real binary.
 */
describe('a task\'s copy of a sign-in', () => {
  const STAND_IN = '#!/bin/sh\ncat "$CLAUDE_CONFIG_DIR/.credentials.json" "$CLAUDE_CONFIG_DIR/.claude.json" 2>/dev/null | grep -q -e accessToken -e primaryApiKey\n';
  let root: string;
  let kept: string;
  let copy: string;

  const handOff = () => spawnSync('sh', ['-c', COPY_SIGN_IN.replace(/(?<![\w/])\/(login|task)\//g, `${root}/$1/`)], {
    env: { PATH: `${root}/bin:${process.env.PATH}` },
    encoding: 'utf8',
    timeout: 5000,
  });
  const signIn = (token: string) => writeFileSync(join(kept, '.credentials.json'), JSON.stringify({ accessToken: token }));
  const held = () => JSON.parse(readFileSync(join(copy, '.credentials.json'), 'utf8')) as { accessToken: string };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ordewell-sign-in-'));
    kept = join(root, 'login', 'claude');
    copy = join(root, 'task', 'login', 'claude');
    mkdirSync(kept, { recursive: true });
    mkdirSync(join(root, 'bin'));
    writeFileSync(join(root, 'bin', 'claude'), STAND_IN);
    chmodSync(join(root, 'bin', 'claude'), 0o755);
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('leaves a token the task refreshed to its next attempt: the kept one may have been replaced by that refresh', () => {
    signIn('as signed in');
    expect(handOff().status).toBe(0);
    writeFileSync(join(copy, '.credentials.json'), JSON.stringify({ accessToken: 'refreshed by the task' }));

    expect(handOff().status).toBe(0);

    expect(held().accessToken).toBe('refreshed by the task');
  });

  it('gives a new sign-in to the next attempt, and keeps the sessions that attempt resumes', () => {
    signIn('expired and refused');
    expect(handOff().status).toBe(0);
    mkdirSync(join(copy, 'projects'));
    writeFileSync(join(copy, 'projects', 'session.jsonl'), 'the conversation');
    signIn('signed in again');

    expect(handOff().status).toBe(0);

    expect(held().accessToken).toBe('signed in again');
    expect(readFileSync(join(copy, 'projects', 'session.jsonl'), 'utf8')).toBe('the conversation');
  });

  it('refuses what an abandoned sign-in leaves, which is files and no login', () => {
    writeFileSync(join(kept, '.claude.json'), '{"firstStartTime":"2026-11-02"}');

    const refused = handOff();

    expect(refused.status).toBe(3);
    expect(refused.stderr).toContain('no sign-in');
  });

  it('hands over a Console key, which a sign-in keeps outside its credentials file', () => {
    writeFileSync(join(kept, '.claude.json'), '{"primaryApiKey":"made-up"}');

    expect(handOff().status).toBe(0);

    expect(readFileSync(join(copy, '.claude.json'), 'utf8')).toContain('primaryApiKey');
  });

  it('is not held up by what a task leaves in place of its mark, which it can write', () => {
    signIn('as signed in');
    expect(handOff().status).toBe(0);
    const mark = join(root, 'task', 'login', 'handed');
    rmSync(mark);
    expect(spawnSync('mkfifo', [mark]).status).toBe(0);

    expect(handOff().status).toBe(0);

    expect(statSync(mark).isFile()).toBe(true);
  });

  it('keeps the copy from everyone but its owner', () => {
    signIn('as signed in');
    chmodSync(join(kept, '.credentials.json'), 0o644);

    expect(handOff().status).toBe(0);

    expect(statSync(join(copy, '.credentials.json')).mode & 0o077).toBe(0);
  });
});

describe('a task\'s copy of a person\'s Codex sign-in', () => {
  const roots: string[] = [];
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

  /** The token's middle part is all the copy reads; Codex's own auth.json holds three such parts. */
  const token = (claims: object) => `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`;
  const inAnHour = () => Math.floor(Date.now() / 1000) + 3600;
  const signIn = (exp = inAnHour()) => ({
    auth_mode: 'chatgpt',
    OPENAI_API_KEY: null,
    tokens: { id_token: token({ email: 'someone@example.com' }), access_token: token({ exp }), refresh_token: 'the-one-refresh-token', account_id: 'account-1' },
    last_refresh: '2020-01-01T00:00:00Z',
  });

  /** The script, run as a helper would, with its two volumes under a temporary directory. */
  const copy = (kept: unknown, prepare: (file: string) => void = () => undefined) => {
    const root = mkdtempSync(join(tmpdir(), 'ordewell-sign-in-'));
    roots.push(root);
    const home = join(root, 'home');
    const file = CODEX_SIGN_IN_FILE.replace(HOME_DIR, home);
    if (kept !== undefined) {
      mkdirSync(join(root, 'login/codex'), { recursive: true });
      writeFileSync(join(root, 'login/codex/auth.json'), typeof kept === 'string' ? kept : JSON.stringify(kept));
    }
    mkdirSync(join(home, '.codex'), { recursive: true });
    prepare(file);
    const script = COPY_CODEX_SIGN_IN.replaceAll('/login/', `${root}/login/`).replaceAll(HOME_DIR, home);
    const run = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
    return { code: run.status, stderr: run.stderr, file, root };
  };

  it('keeps what a task spends and leaves out what only one holder can spend', () => {
    const kept = signIn();
    const { code, file } = copy(kept);

    expect(code).toBe(0);
    const written = JSON.parse(readFileSync(file, 'utf8')) as ReturnType<typeof signIn>;
    expect(written.tokens).toEqual({ ...kept.tokens, refresh_token: '' });
    expect(written.auth_mode).toBe('chatgpt');
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('stamps it as fresh, or a task would spend its first turn on a refresh that cannot work', () => {
    const { file } = copy(signIn());

    const { last_refresh: refreshed } = JSON.parse(readFileSync(file, 'utf8')) as { last_refresh: string };
    expect(Date.now() - Date.parse(refreshed)).toBeLessThan(60_000);
  });

  it.each<[string, unknown, RegExp]>([
    ['no sign-in', undefined, /no sign-in/],
    ['a file that is not a sign-in', 'not json', /no sign-in/],
    ['an API key', { OPENAI_API_KEY: 'sk-kept', tokens: null }, /API key/],
    ['no tokens', { auth_mode: 'chatgpt', tokens: {} }, /no ChatGPT sign-in/],
    ['an access token it cannot read', { tokens: { id_token: 'a.b.c', access_token: 'not-a-token', account_id: 'a' } }, /cannot be read/],
    ['an access token with no end', { tokens: { id_token: 'a.b.c', access_token: token({}), account_id: 'a' } }, /expired/],
  ])('refuses %s, and writes nothing', (_label, kept, why) => {
    const { code, stderr, file } = copy(kept);

    expect(code).toBe(3);
    expect(stderr).toMatch(why);
    expect(existsSync(file)).toBe(false);
  });

  it('refuses one past its time, and says so', () => {
    const { code, stderr, file } = copy(signIn(Math.floor(Date.now() / 1000) - 60));

    expect(code).toBe(3);
    expect(stderr).toMatch(/expired/);
    expect(existsSync(file)).toBe(false);
  });

  it('never prints a token it refuses', () => {
    const kept = signIn(Math.floor(Date.now() / 1000) - 60);
    const { stderr } = copy(kept);

    expect(stderr).not.toContain(kept.tokens.access_token);
    expect(stderr).not.toContain(kept.tokens.refresh_token);
  });

  it('writes past a link an earlier attempt planted, and leaves its target alone', () => {
    const outside = join(tmpdir(), `ordewell-sign-in-target-${process.pid}`);
    writeFileSync(outside, 'untouched');
    try {
      const { code, file } = copy(signIn(), (planted) => symlinkSync(outside, planted));

      expect(code).toBe(0);
      expect(lstatSync(file).isSymbolicLink()).toBe(false);
      expect(readFileSync(outside, 'utf8')).toBe('untouched');
    } finally {
      rmSync(outside, { force: true });
    }
  });

  it('writes past a folder an earlier attempt left in its place', () => {
    const { code, file } = copy(signIn(), (planted) => mkdirSync(join(planted, 'nested'), { recursive: true }));

    expect(code).toBe(0);
    expect(statSync(file).isFile()).toBe(true);
  });
});

describe('a task\'s copy of a person\'s OpenCode sign-in', () => {
  let root: string;
  let kept: string;
  let copy: string;

  const handOff = () => spawnSync('sh', ['-c', COPY_OPENCODE_SIGN_IN.replace(/(?<![\w/])\/(login|task)\//g, `${root}/$1/`)], { encoding: 'utf8', timeout: 5000 });
  const signIn = (provider: string) => writeFileSync(join(kept, 'auth.json'), JSON.stringify({ [provider]: { access: provider } }));
  const held = () => JSON.parse(readFileSync(join(copy, 'auth.json'), 'utf8')) as Record<string, unknown>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ordewell-opencode-sign-in-'));
    kept = join(root, 'login', 'opencode');
    copy = join(root, 'task', 'login', 'opencode');
    mkdirSync(kept, { recursive: true });
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('leaves a login the task refreshed to its next attempt, until the kept one changes', () => {
    signIn('anthropic');
    expect(handOff().status).toBe(0);
    writeFileSync(join(copy, 'auth.json'), JSON.stringify({ anthropic: { access: 'refreshed by the task' } }));

    expect(handOff().status).toBe(0);
    expect(held()).toEqual({ anthropic: { access: 'refreshed by the task' } });

    signIn('openai');
    expect(handOff().status).toBe(0);
    expect(held()).toEqual({ openai: { access: 'openai' } });
  });

  it('refuses an empty volume, and writes nothing', () => {
    const refused = handOff();

    expect(refused.status).toBe(3);
    expect(refused.stderr).toContain('no sign-in');
    expect(existsSync(join(copy, 'auth.json'))).toBe(false);
  });

  it('keeps the copy from everyone but its owner', () => {
    signIn('anthropic');
    chmodSync(join(kept, 'auth.json'), 0o644);

    expect(handOff().status).toBe(0);

    expect(statSync(join(copy, 'auth.json')).mode & 0o077).toBe(0);
  });
});
