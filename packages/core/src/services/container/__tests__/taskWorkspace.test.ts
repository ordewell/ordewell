import { spawnSync } from 'child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { COPY_SIGN_IN, mirrorDir, repoDir } from '../taskWorkspace';

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
