import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { findEnvFile, writeEnvVar, loadEnvFile } from '../env';

let origHome: string | undefined;
let origCwd: string;

beforeEach(() => {
  origHome = process.env.HOME;
  origCwd = process.cwd();
  process.env.HOME = os.tmpdir();
});

afterEach(() => {
  process.env.HOME = origHome;
  process.chdir(origCwd);
  // cleanup
  try {
    const file = path.join(os.tmpdir(), '.config', 'ordewell', '.env');
    if (fs.existsSync(file)) fs.unlinkSync(file);
  } catch { /* empty */ }
});

describe('findEnvFile', () => {
  it('returns ~/.config/ordewell/.env', () => {
    const result = findEnvFile();
    expect(result).toBe(path.join(os.tmpdir(), '.config', 'ordewell', '.env'));
  });
});

describe('writeEnvVar', () => {
  it('creates a new env file with the variable', () => {
    const file = path.join(os.tmpdir(), '.config', 'ordewell', '.env');
    writeEnvVar(file, 'TEST_KEY', 'test_value');
    expect(fs.existsSync(file)).toBe(true);
    const content = fs.readFileSync(file, 'utf8');
    expect(content).toContain('TEST_KEY=test_value');
  });

  it('updates existing env file', () => {
    const file = path.join(os.tmpdir(), '.config', 'ordewell', '.env');
    writeEnvVar(file, 'KEY1', 'val1');
    writeEnvVar(file, 'KEY1', 'val2');
    const content = fs.readFileSync(file, 'utf8');
    expect(content).toContain('KEY1=val2');
    expect(content).not.toContain('val1');
  });
});

describe('loadEnvFile', () => {
  const key = 'ORDEWELL_TEST_LOAD_ENV_KEY';

  afterEach(() => {
    delete process.env[key];
  });

  it('populates process.env from the resolved .env file', () => {
    const file = path.join(os.tmpdir(), '.config', 'ordewell', '.env');
    writeEnvVar(file, key, 'from-file');
    loadEnvFile();
    expect(process.env[key]).toBe('from-file');
  });

  it('does not override a var already set in the environment', () => {
    const file = path.join(os.tmpdir(), '.config', 'ordewell', '.env');
    writeEnvVar(file, key, 'from-file');
    process.env[key] = 'from-shell';
    loadEnvFile();
    expect(process.env[key]).toBe('from-shell');
  });

  it('is a no-op when no .env file exists', () => {
    expect(() => loadEnvFile()).not.toThrow();
    expect(process.env[key]).toBeUndefined();
  });
});
