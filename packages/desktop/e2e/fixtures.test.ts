import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { appEnv, type Sandbox } from './fixtures';

/** The developer's own provider setup, which must never reach the app under test. */
const DEVELOPER: Record<string, string> = {
  OPENROUTER_API_KEY: 'sk-or-developer',
  OPENROUTER_BASE_URL: 'https://openrouter.ai/api/v1',
  OPENAI_API_KEY: 'sk-developer',
  OPENAI_BASE_URL: 'https://api.openai.com/v1',
  GEMINI_API_KEY: 'gemini-developer',
  GEMINI_MODEL: 'gemini-2.5-pro',
  MISTRAL_API_KEY: 'mistral-developer',
  XAI_API_KEY: 'xai-developer',
  ANTHROPIC_API_KEY: 'sk-ant-developer',
  ORCHESTRATOR_MODEL: 'fable',
  AI_PROVIDER: 'openrouter',
};

let tmp: string | undefined;
afterEach(() => {
  vi.unstubAllEnvs();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  tmp = undefined;
});

function sandbox(): Sandbox {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-appenv-'));
  return { tmp, home: path.join(tmp, 'home'), repo: path.join(tmp, 'repo'), userData: path.join(tmp, 'user-data'), fakeClaudeLog: path.join(tmp, 'fake-claude.log') };
}

// appEnv builds a PATH of POSIX shims and symlinks, as the desktop e2e it serves runs on.
describe.skipIf(process.platform === 'win32')('appEnv', () => {
  it('passes the app none of the developer\'s provider keys, endpoints or model choice when it has no provider', () => {
    for (const [key, value] of Object.entries(DEVELOPER)) vi.stubEnv(key, value);

    const env = appEnv(sandbox(), 1, 2, { noProvider: true });

    expect(Object.keys(env).filter((key) => key in DEVELOPER)).toEqual([]);
  });

  it('gives the app the mock planner alone when it has one', () => {
    for (const [key, value] of Object.entries(DEVELOPER)) vi.stubEnv(key, value);

    const env = appEnv(sandbox(), 1, 2);

    expect(Object.fromEntries(Object.keys(DEVELOPER).filter((key) => key in env).map((key) => [key, env[key]]))).toEqual({
      AI_PROVIDER: 'openrouter',
      ORCHESTRATOR_MODEL: 'mock/desktop-e2e',
      OPENROUTER_API_KEY: 'mock-key',
      OPENROUTER_BASE_URL: 'http://127.0.0.1:2/v1',
    });
  });
});
