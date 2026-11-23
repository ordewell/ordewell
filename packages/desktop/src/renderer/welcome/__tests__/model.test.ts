import { describe, expect, it, vi } from 'vitest';
import type { DaemonCallResult } from '../../../shared/bridge';
import {
  failureMessage,
  gitFromRepos,
  gitLine,
  middleEllipsis,
  modKey,
  needsYouCount,
  noRunnerOn,
  relativeTime,
  runnerGroups,
  runnerCard,
  sessionLook,
  withTimeout,
} from '../model';

const NOW = new Date('2026-11-04T12:00:00Z');
const ago = (seconds: number): string => new Date(NOW.getTime() - seconds * 1000).toISOString();

describe('relativeTime', () => {
  it('says how long ago in words a person reads', () => {
    expect(relativeTime(ago(10), NOW)).toBe('just now');
    expect(relativeTime(ago(4 * 60), NOW)).toBe('4 minutes ago');
    expect(relativeTime(ago(3 * 3600), NOW)).toBe('3 hours ago');
    expect(relativeTime(ago(26 * 3600), NOW)).toBe('yesterday');
    expect(relativeTime(ago(21 * 24 * 3600), NOW)).toBe('3 weeks ago');
  });

  it('is empty for a time that does not parse, and just now for one in the future', () => {
    expect(relativeTime('not a date', NOW)).toBe('');
    expect(relativeTime(ago(-600), NOW)).toBe('just now');
  });
});

describe('middleEllipsis', () => {
  it('keeps both ends of a long path and leaves a short one alone', () => {
    expect(middleEllipsis('~/code/acme', 34)).toBe('~/code/acme');
    const cut = middleEllipsis('~/code/clients/very-long-organisation/acme-app', 20);
    expect(cut).toHaveLength(20);
    expect(cut.startsWith('~/code/cl')).toBe(true);
    expect(cut.endsWith('acme-app')).toBe(true);
    expect(cut).toContain('…');
  });
});

describe('gitFromRepos', () => {
  it('reads the folder itself as its branch, or a detached HEAD', () => {
    expect(gitFromRepos({ repos: [{ repo: '.', branch: 'main' }] })).toEqual({ kind: 'branch', name: 'main' });
    expect(gitFromRepos({ repos: [{ repo: '.', branch: null }] })).toEqual({ kind: 'detached' });
  });

  it('counts a folder of repositories, and says when there is none', () => {
    expect(gitFromRepos({ repos: [{ repo: 'a', branch: 'main' }, { repo: 'b', branch: 'dev' }, { repo: 'c' }] })).toEqual({ kind: 'repos', count: 3 });
    expect(gitFromRepos({ repos: [{ repo: 'api', branch: 'main' }] })).toEqual({ kind: 'repos', count: 1 });
    expect(gitFromRepos({ repos: [] })).toEqual({ kind: 'none' });
  });

  it('answers undefined for anything but the repos response', () => {
    expect(gitFromRepos(undefined)).toBeUndefined();
    expect(gitFromRepos({ repos: 'x' })).toBeUndefined();
  });

  it('writes each as one line', () => {
    expect(gitLine({ kind: 'branch', name: 'feature/tax-split' })).toBe('feature/tax-split');
    expect(gitLine({ kind: 'detached' })).toBe('Detached HEAD');
    expect(gitLine({ kind: 'repos', count: 1 })).toBe('1 repository');
    expect(gitLine({ kind: 'repos', count: 3 })).toBe('3 repositories');
    expect(gitLine({ kind: 'none' })).toBe('Not a git repository');
  });
});

describe('sessionLook', () => {
  it('gives each plan status a shape and the Sessions list word', () => {
    expect(sessionLook('running')).toEqual({ status: 'running', word: 'Running' });
    expect(sessionLook('completed')).toEqual({ status: 'passed', word: 'Settled' });
    expect(sessionLook('rejected')).toEqual({ status: 'blocked', word: 'Rejected' });
    expect(sessionLook('draft')).toEqual({ status: 'not-started', word: 'Draft' });
    expect(sessionLook('unknown').word).toBe('Unknown');
    expect(sessionLook('paused').word).toBe('paused');
  });
});

describe('needsYouCount', () => {
  const ok = (escalations: unknown[]): DaemonCallResult => ({ ok: true, status: 200, data: { escalations } });

  it('adds the waiting escalations, and a session nobody holds adds nothing', () => {
    expect(needsYouCount([ok([1, 2]), { ok: false, status: 404, error: 'not live' }, ok([3])])).toBe(3);
    expect(needsYouCount([])).toBe(0);
  });

  it('is unknown rather than zero when a call fails another way or answers oddly', () => {
    expect(needsYouCount([ok([1]), { ok: false, status: 500, error: 'boom' }])).toBeUndefined();
    expect(needsYouCount([{ ok: true, status: 200, data: {} }])).toBeUndefined();
  });
});

describe('withTimeout', () => {
  it('settles as a failure when the call never answers', async () => {
    vi.useFakeTimers();
    try {
      const pending = withTimeout(new Promise<DaemonCallResult>(() => undefined), 15_000, 'The daemon');
      await vi.advanceTimersByTimeAsync(15_000);
      await expect(pending).resolves.toEqual({ ok: false, error: 'The daemon did not answer within 15 seconds.' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('passes an answer through and turns a rejection into a failure', async () => {
    const answer: DaemonCallResult = { ok: true, status: 200, data: 1 };
    await expect(withTimeout(Promise.resolve(answer), 1000, 'x')).resolves.toBe(answer);
    await expect(withTimeout(Promise.reject(new Error('gone')), 1000, 'x')).resolves.toEqual({ ok: false, error: 'gone' });
  });
});

describe('failureMessage', () => {
  it("prefers the daemon's own words to the transport's", () => {
    expect(failureMessage({ ok: false, status: 500, error: 'HTTP 500', data: { error: 'runners unavailable' } })).toBe('runners unavailable');
    expect(failureMessage({ ok: false, error: 'socket hang up' })).toBe('socket hang up');
  });
});

describe('runnerCard', () => {
  it('shows a signed-in runner with its version and nothing to do', () => {
    expect(runnerCard({ id: 'claude-code', state: 'signed-in', version: '1.4.2' }, 'Claude Code'))
      .toEqual({ id: 'claude-code', tone: 'passed', word: 'Signed in', version: '1.4.2' });
  });

  it('says a provider runner is the built-in runner on its key, with nothing to do (ADR-0070)', () => {
    expect(runnerCard({ id: 'openrouter', state: 'signed-in', provider: 'openrouter' }, 'OpenRouter'))
      .toEqual({ id: 'openrouter', tone: 'passed', word: 'Key set', hint: 'The built-in runner, on your OpenRouter key.' });
    expect(runnerCard({ id: 'openrouter', state: 'off', provider: 'openrouter' }, 'OpenRouter').word).toBe('Off in Settings');
  });

  // The welcome window has no composer, so a hint naming /login or /key-set points at nothing (F8).
  it("names a signed-out runner's Log in button and its own CLI sign-in", () => {
    expect(runnerCard({ id: 'codex', state: 'signed-out', loginCommand: ['codex', 'login'], signIn: { runner: 'codex', label: 'Codex', login: ['codex', 'login'] } }, 'Codex')).toMatchObject({
      tone: 'attention', word: 'Signed out', hint: 'Sign in with the Log in button, or run codex login.', command: 'codex login', action: 'login', runnerLabel: 'Codex',
    });
  });

  it('names the key entry button when the agent has no login Ordewell can run', () => {
    expect(runnerCard({ id: 'gemini-cli', state: 'signed-out', signIn: { runner: 'gemini-cli', label: 'Gemini CLI', key: { provider: 'google', label: 'Google Gemini' } } }, 'Gemini CLI')).toMatchObject({
      tone: 'attention', word: 'Signed out', hint: 'Use the Set API key… button and choose Google Gemini to hand it a key.', action: 'key', provider: 'google',
    });
    expect(runnerCard({ id: 'cursor-agent', state: 'signed-out' }, 'Cursor').hint).toBeUndefined();
  });

  // Not having an agent is not a fault: a Claude-only user saw eight red cards around the one that works (F9).
  it('tells how to install a missing runner and links its install page, in a neutral tone', () => {
    expect(runnerCard({ id: 'opencode', state: 'missing' }, 'OpenCode')).toMatchObject({
      tone: 'idle', word: 'Not installed', hint: 'Install OpenCode, then Retry.', docs: 'https://opencode.ai/docs',
    });
    expect(runnerCard({ id: 'aider', state: 'missing' }, 'Aider').docs).toBeUndefined();
  });

  it('gives a runner Ordewell cannot start its reason alone, however its login stands', () => {
    const reason = 'Cline 1.0.0 is older than the 1.3.0 Ordewell needs.';
    const card = runnerCard({ id: 'cline', state: 'signed-out', unavailable: reason, signIn: { runner: 'cline', label: 'Cline', login: ['cline', 'auth'] } }, 'Cline');
    expect(card).toMatchObject({ tone: 'failed', word: 'Unavailable', hint: reason });
    expect(card).not.toHaveProperty('action');
    expect(runnerCard({ id: 'cline', state: 'missing', unavailable: reason }, 'Cline').word).toBe('Not installed');
    expect(runnerCard({ id: 'cline', state: 'off', unavailable: reason }, 'Cline').word).toBe('Off in Settings');
  });

  it('says a runner is off in Settings, or was not checked', () => {
    expect(runnerCard({ id: 'codex', state: 'off' }, 'Codex')).toMatchObject({ tone: 'idle', word: 'Off in Settings' });
    expect(runnerCard({ id: 'codex', state: 'unknown', detail: 'timed out' }, 'Codex')).toMatchObject({ tone: 'idle', word: 'Not checked', hint: 'timed out' });
  });

  describe('runnerGroups (F9)', () => {
    const ids = (lines: Array<{ id: string }>) => lines.map((line) => line.id);

    it('puts the agents that can work first, the installed rest next, and the missing ones aside, each in core order', () => {
      const groups = runnerGroups([
        { id: 'claude-code', state: 'missing' },
        { id: 'codex', state: 'signed-out' },
        { id: 'opencode', state: 'off' },
        { id: 'pi', state: 'signed-in' },
        { id: 'copilot-cli', state: 'missing' },
        { id: 'qwen-code', state: 'signed-in', unavailable: 'too old' },
        { id: 'cline', state: 'unknown' },
        { id: 'gemini-cli', state: 'signed-in' },
      ]);
      expect(ids(groups.shown)).toEqual(['pi', 'gemini-cli', 'codex', 'cline', 'opencode', 'qwen-code']);
      expect(ids(groups.more)).toEqual(['claude-code', 'copilot-cli']);
    });

    it('sets nothing aside when every agent is installed, and everything when none is', () => {
      expect(runnerGroups([{ id: 'codex', state: 'signed-in' }]).more).toEqual([]);
      const none = runnerGroups([{ id: 'codex', state: 'missing' }, { id: 'pi', state: 'missing' }]);
      expect(none.shown).toEqual([]);
      expect(ids(none.more)).toEqual(['codex', 'pi']);
    });
  });

  it('calls the row empty only when every runner is off', () => {
    expect(noRunnerOn([{ id: 'a', state: 'off' }, { id: 'b', state: 'off' }])).toBe(true);
    expect(noRunnerOn([{ id: 'a', state: 'off' }, { id: 'b', state: 'missing' }])).toBe(false);
    expect(noRunnerOn([])).toBe(false);
  });
});

describe('modKey', () => {
  it('writes the shortcut modifier as the platform does', () => {
    expect(modKey('darwin')).toBe('⌘');
    expect(modKey('linux')).toBe('Ctrl+');
    expect(modKey(undefined)).toBe('Ctrl+');
  });
});
