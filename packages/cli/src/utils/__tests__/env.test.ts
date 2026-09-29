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
    const file = path.join(os.tmpdir(), '.ordewell', '.env');
    if (fs.existsSync(file)) fs.unlinkSync(file);
  } catch { /* empty */ }
});

describe('findEnvFile', () => {
  it('returns ~/.ordewell/.env', () => {
    const result = findEnvFile();
    expect(result).toBe(path.join(os.tmpdir(), '.ordewell', '.env'));
  });
});

describe('writeEnvVar', () => {
  it('creates a new env file with the variable', () => {
    const file = path.join(os.tmpdir(), '.ordewell', '.env');
    writeEnvVar(file, 'TEST_KEY', 'test_value');
    expect(fs.existsSync(file)).toBe(true);
    const content = fs.readFileSync(file, 'utf8');
    expect(content).toContain('TEST_KEY=test_value');
  });

  it('updates existing env file', () => {
    const file = path.join(os.tmpdir(), '.ordewell', '.env');
    writeEnvVar(file, 'KEY1', 'val1');
    writeEnvVar(file, 'KEY1', 'val2');
    const content = fs.readFileSync(file, 'utf8');
    expect(content).toContain('KEY1=val2');
    expect(content).not.toContain('val1');
  });

  it('tightens an existing world-readable .env to 0600', () => {
    if (process.platform === 'win32') return;
    const file = path.join(os.tmpdir(), '.ordewell', '.env');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'KEY1=old\n');
    fs.chmodSync(file, 0o644);

    writeEnvVar(file, 'KEY1', 'new');

    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(file, 'utf8')).toBe('KEY1=new\n');
  });

  it('rejects a key containing regex metacharacters', () => {
    const file = path.join(os.tmpdir(), '.ordewell', '.env');
    expect(() => writeEnvVar(file, 'KEY.*', 'value')).toThrow(/valid environment variable/);
  });

  it('rejects a value containing a newline', () => {
    const file = path.join(os.tmpdir(), '.ordewell', '.env');
    expect(() => writeEnvVar(file, 'KEY', 'one\ntwo')).toThrow(/newline/);
  });
});

describe('loadEnvFile', () => {
  const key = 'ORDEWELL_TEST_LOAD_ENV_KEY';

  afterEach(() => {
    delete process.env[key];
  });

  it('populates process.env from the resolved .env file', () => {
    const file = path.join(os.tmpdir(), '.ordewell', '.env');
    writeEnvVar(file, key, 'from-file');
    loadEnvFile();
    expect(process.env[key]).toBe('from-file');
  });

  it('does not override a var already set in the environment', () => {
    const file = path.join(os.tmpdir(), '.ordewell', '.env');
    writeEnvVar(file, key, 'from-file');
    process.env[key] = 'from-shell';
    loadEnvFile();
    expect(process.env[key]).toBe('from-shell');
  });

  it.each([
    ['double quotes', `${key}="sk-or-v1-abc"`],
    ['single quotes', `${key}='sk-or-v1-abc'`],
    ['an export prefix', `export ${key}=sk-or-v1-abc`],
    ['CRLF line endings', `${key}=sk-or-v1-abc\r`],
  ])('reads the bare value when the line uses %s', (_label, line) => {
    const file = path.join(os.tmpdir(), '.ordewell', '.env');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${line}\n`);
    loadEnvFile();
    expect(process.env[key]).toBe('sk-or-v1-abc');
  });

  it('is a no-op when no .env file exists', () => {
    expect(() => loadEnvFile()).not.toThrow();
    expect(process.env[key]).toBeUndefined();
  });
});
