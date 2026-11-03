import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { homeEnv, setEnv } from '@ordewell/core/testing';
import { handleSetup } from '../setup';

describe('ordewell setup', () => {
  let home = '';
  let restoreEnv: () => void;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-setup-'));
    restoreEnv = setEnv({ ...homeEnv(home), OPENROUTER_API_KEY: undefined, OPENAI_API_KEY: undefined, GEMINI_API_KEY: undefined });
  });

  afterEach(() => {
    restoreEnv();
    fs.rmSync(home, { recursive: true, force: true });
  });

  function written(): string {
    return fs.readFileSync(path.join(home, '.ordewell', '.env'), 'utf8');
  }

  it('keeps an OpenAI key under its own name', () => {
    process.env.OPENAI_API_KEY = 'sk-openai-secret';
    handleSetup([]);

    expect(written()).toContain('OPENAI_API_KEY=sk-openai-secret');
    expect(written()).not.toContain('OPENROUTER_API_KEY=sk-openai-secret');
  });

  it('keeps an OpenRouter key under its own name', () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-secret';
    handleSetup([]);

    expect(written()).toContain('OPENROUTER_API_KEY=sk-or-secret');
  });
});
