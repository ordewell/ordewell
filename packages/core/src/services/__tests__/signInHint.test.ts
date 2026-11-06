import { describe, it, expect } from 'vitest';
import { describeRunnerSignIn, describeSignIn, describeSignInWays, signInAction, signInOfVerdict } from '../signInHint';
import { rewordSignIn, runnerSignIn, signedOutFromFailure } from '../runnerAuth';
import { HEADLESS_CLI_COMMANDS, TERMINAL_UI_COMMANDS } from '../plannerReadiness';
import { CURSOR_AGENT_MANIFEST } from '../../plugins/builtin/cursor-agent.manifest';

// The literal sentences a person reads when an agent is signed out, per
// runner: one source builds them, so these pin every surface's wording.
const TERMINAL: Record<string, string> = {
  'claude-code': 'Claude Code is not signed in. Sign in with /login claude-code, or run claude auth login.',
  codex: 'Codex is not signed in. Sign in with /login codex, or run codex login.',
  opencode: 'OpenCode is not signed in. Run opencode auth login and choose a provider.',
  'copilot-cli': 'GitHub Copilot CLI is not signed in. Sign in with /login copilot-cli, or run copilot login.',
  'cursor-agent': 'Cursor is not signed in. Sign in with /login cursor-agent, or run cursor-agent login.',
  cline: 'Cline is not signed in. Sign in with /login cline, or run cline auth.',
  'qwen-code': 'Qwen Code is not signed in. Run /key and choose OpenRouter (or any OpenAI-compatible provider) to hand it a key, or run qwen and sign in there.',
  'gemini-cli': 'Gemini CLI is not signed in. Run /key and choose Google Gemini to hand it a key, or run gemini and choose how it signs in.',
};

const HEADLESS: Record<string, string> = {
  'claude-code': 'Claude Code is not signed in. Run claude auth login to sign in.',
  codex: 'Codex is not signed in. Run codex login to sign in.',
  opencode: 'OpenCode is not signed in. Run opencode auth login and choose a provider.',
  'copilot-cli': 'GitHub Copilot CLI is not signed in. Run copilot login to sign in.',
  'cursor-agent': 'Cursor is not signed in. Run cursor-agent login to sign in.',
  cline: 'Cline is not signed in. Run cline auth to sign in.',
  'qwen-code': 'Qwen Code is not signed in. Run ordewell key set openrouter <key> (or any OpenAI-compatible provider) to hand it a key, or run qwen and sign in there.',
  'gemini-cli': 'Gemini CLI is not signed in. Run ordewell key set google <key> to hand it a key, or run gemini and choose how it signs in.',
};

describe('the sign-in hint', () => {
  it.each(Object.keys(TERMINAL))('names the way in from the terminal UI for %s', (runner) => {
    const signIn = runnerSignIn(runner);
    expect(signIn && describeSignIn(signIn, TERMINAL_UI_COMMANDS)).toBe(TERMINAL[runner]);
  });

  it.each(Object.keys(HEADLESS))('names the agent\'s own command from the headless CLI for %s', (runner) => {
    const signIn = runnerSignIn(runner);
    expect(signIn && describeSignIn(signIn, HEADLESS_CLI_COMMANDS)).toBe(HEADLESS[runner]);
  });

  it('offers the login Ordewell can run, else the key entry, else nothing to press', () => {
    expect(signInAction(runnerSignIn('cursor-agent'))).toBe('login');
    expect(signInAction(runnerSignIn('claude-code'))).toBe('login');
    expect(signInAction(runnerSignIn('qwen-code'))).toBe('key');
    expect(signInAction(runnerSignIn('gemini-cli'))).toBe('key');
    expect(signInAction(runnerSignIn('opencode'))).toBeNull();
    expect(signInAction(undefined)).toBeNull();
  });

  it('rides on the verdict a failed turn leaves, so every surface that reads the verdict can word it', () => {
    const auth = signedOutFromFailure(CURSOR_AGENT_MANIFEST, 'Cursor is not signed in.');
    expect(auth?.signIn && describeSignIn(auth.signIn, TERMINAL_UI_COMMANDS)).toBe(TERMINAL['cursor-agent']);
    expect(auth?.loginCommand).toEqual(['cursor-agent', 'login']);
  });

  it.each(Object.keys(TERMINAL))('rewords %s\'s terminal hint for the headless CLI inside a longer message', (runner) => {
    const said = `${TERMINAL[runner]} Then try again.\n\nNot logged in`;
    expect(rewordSignIn(said, TERMINAL_UI_COMMANDS, HEADLESS_CLI_COMMANDS)).toBe(`${HEADLESS[runner]} Then try again.\n\nNot logged in`);
  });

  it('names only the ways in where the agent may be signed in already', () => {
    expect(describeSignInWays(runnerSignIn('cursor-agent')!, TERMINAL_UI_COMMANDS)).toBe('Sign in with /login cursor-agent, or run cursor-agent login.');
    expect(describeSignInWays(runnerSignIn('gemini-cli')!, TERMINAL_UI_COMMANDS)).toBe('Run /key and choose Google Gemini to hand it a key, or run gemini and choose how it signs in.');
    expect(describeSignInWays({ runner: 'x', label: 'X' }, TERMINAL_UI_COMMANDS)).toBe('');
  });

  it('says what a runner row carries: the hint when signed out, the login when unknown, else nothing', () => {
    const cursor = runnerSignIn('cursor-agent')!;
    const qwen = runnerSignIn('qwen-code')!;
    expect(describeRunnerSignIn({ state: 'signed-out', signIn: cursor }, TERMINAL_UI_COMMANDS)).toBe(TERMINAL['cursor-agent']);
    expect(describeRunnerSignIn({ state: 'signed-out', signIn: qwen }, TERMINAL_UI_COMMANDS)).toBe(TERMINAL['qwen-code']);
    expect(describeRunnerSignIn({ state: 'unknown', signIn: cursor }, TERMINAL_UI_COMMANDS)).toBe('Sign in with /login cursor-agent, or run cursor-agent login.');
    // A key or a by-hand route is no news for an agent that may be signed in already.
    expect(describeRunnerSignIn({ state: 'unknown', signIn: qwen }, TERMINAL_UI_COMMANDS)).toBeNull();
    expect(describeRunnerSignIn({ state: 'signed-in', signIn: cursor }, TERMINAL_UI_COMMANDS)).toBeNull();
    // Signed out with no way in: an alarm with nowhere to send the person is noise.
    expect(describeRunnerSignIn({ state: 'signed-out', signIn: { runner: 'x', label: 'X' } }, TERMINAL_UI_COMMANDS)).toBeNull();
    expect(describeRunnerSignIn({ state: 'signed-out' }, TERMINAL_UI_COMMANDS)).toBeNull();
    expect(describeRunnerSignIn(undefined, TERMINAL_UI_COMMANDS)).toBeNull();
  });

  it('reads the ways in off a verdict, or its bare login command where it carries none', () => {
    const cursor = runnerSignIn('cursor-agent')!;
    expect(signInOfVerdict('cursor-agent', 'Cursor', { signIn: cursor, loginCommand: ['other'] })).toBe(cursor);
    expect(signInOfVerdict('codex', 'Codex', { loginCommand: ['codex', 'login'] })).toEqual({ runner: 'codex', label: 'Codex', login: ['codex', 'login'] });
    expect(signInOfVerdict('codex', 'Codex', { loginCommand: [] })).toEqual({ runner: 'codex', label: 'Codex' });
    expect(signInOfVerdict('codex', 'Codex', undefined)).toBeUndefined();
  });

  it('leaves a message that names no sign-in as it was', () => {
    expect(rewordSignIn('The tests are red.', TERMINAL_UI_COMMANDS, HEADLESS_CLI_COMMANDS)).toBe('The tests are red.');
  });

  it('knows no way in for a runner it does not ship', () => {
    expect(runnerSignIn('no-such-agent')).toBeUndefined();
  });
});
