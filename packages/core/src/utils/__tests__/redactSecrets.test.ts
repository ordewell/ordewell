import { describe, it, expect } from 'vitest';
import { redactSecrets } from '../redactSecrets';

/**
 * Two halves, and the second matters as much as the first: a planner reading a
 * config file must not leak its credentials, and a planner reading ordinary
 * source code — which is full of the words `token` and `key` — must get that
 * code back byte for byte.
 */

const PEM = [
  '-----BEGIN RSA PRIVATE KEY-----',
  'MIIEogIBAAKCAQEAyq8Hn0aJ5rW1kXQ0mF7pB2vN9sT4uL6cD8eG1hI3jK5lM7nO',
  'p9QrS1tU3vW5xY7zA9bC1dE3fG5hI7jK9lM1nO3pQ5rS7tU9vW1xY3zA5bC7dE9f',
  '-----END RSA PRIVATE KEY-----',
].join('\n');

describe('redactSecrets — credential material', () => {
  it('redacts a named credential variable in a dotenv file', () => {
    const out = redactSecrets('DATABASE_PASSWORD=hunter2\nDEBUG=true\n');

    expect(out).not.toContain('hunter2');
    expect(out).toContain('DATABASE_PASSWORD=[REDACTED credential: 7 chars]');
    expect(out).toContain('DEBUG=true');
  });

  it('redacts a named credential in JSON, keeping the key visible', () => {
    const out = redactSecrets('{ "apiKey": "AIzaSyD-9fK2mQ7xR1tV4wY6zB8cE0gJ3lN5pS7u" }');

    expect(out).not.toContain('AIzaSyD');
    expect(out).toContain('"apiKey": "[REDACTED');
  });

  it('redacts provider key prefixes wherever they appear', () => {
    const secrets = [
      'sk-proj-T3BlbkFJa1b2c3d4e5f6g7h8i9j0k1l2',
      'sk-ant-api03-9fK2mQ7xR1tV4wY6zB8cE0gJ3lN5pS7u',
      'ghp_a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8',
      'xoxb-123456789012-1234567890123-aBcDeFgHiJkLmNoP',
      'rk_live_a1b2c3d4e5f6g7h8i9j0k1l2',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk',
    ];

    for (const secret of secrets) {
      const out = redactSecrets(`the value is ${secret} — rotate it`);
      expect(out, secret).not.toContain(secret);
      expect(out, secret).toContain('[REDACTED api key');
      expect(out, secret).toContain('rotate it');
    }
  });

  it('redacts a cloud access key identifier printed on its own', () => {
    const out = redactSecrets('User: arn:aws:iam::123456789012:user/dev (AKIAIOSFODNN7EXAMPLE)');

    expect(out).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(out).toContain('[REDACTED access key id: 20 chars]');
  });

  it('drops a private key body but keeps the block headers', () => {
    const out = redactSecrets(PEM);

    expect(out).not.toContain('MIIEogIBAAKCAQEA');
    expect(out).toContain('-----BEGIN RSA PRIVATE KEY-----');
    expect(out).toContain('-----END RSA PRIVATE KEY-----');
    expect(out).toContain('[REDACTED private key: 128 chars]');
  });

  it('redacts a private key truncated mid-block, keeping what followed it', () => {
    const truncated = [
      '-----BEGIN OPENSSH PRIVATE KEY-----',
      'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtz',
      '',
      '(File has more lines — use offset=2000 to read beyond line 2000)',
    ].join('\n');

    const out = redactSecrets(truncated);

    expect(out).not.toContain('b3BlbnNzaC1rZXktdjEA');
    expect(out).toContain('[REDACTED private key');
    expect(out).toContain('(File has more lines — use offset=2000 to read beyond line 2000)');
  });

  it('redacts through the line prefixes read_file and grep add', () => {
    const numbered = redactSecrets('  12|STRIPE_SECRET_KEY=sk_live_a1b2c3d4e5f6g7h8i9j0k1l2');
    expect(numbered).not.toContain('sk_live_a1b2c3');
    expect(numbered).toContain('  12|STRIPE_SECRET_KEY=');

    const grepped = redactSecrets('config/.env:3:export GITHUB_TOKEN=ghp_a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8');
    expect(grepped).not.toContain('ghp_a1b2c3');
    expect(grepped).toContain('config/.env:3:export GITHUB_TOKEN=');
  });

  it('marks the length of what it removed rather than deleting it', () => {
    const out = redactSecrets('API_KEY=abcdefghij0123456789');

    expect(out).toMatch(/\[REDACTED credential: 20 chars\]/);
  });

  // An unambiguous credential name — `password`, `secret`, `privateKey` — means
  // the value itself is claimed to *be* the secret, not a reference to one. The
  // identifier-shaped bypass exists for values like `cohereKey` (a setting
  // naming another setting), which never carry a digit; a value that mixes
  // letters and a digit is not that shape, so it should not get the benefit of
  // the doubt just because it starts with a letter.
  it('redacts a named credential whose value merely looks like an identifier', () => {
    const out = redactSecrets('password: "TopSecretValue123"');

    expect(out).not.toContain('TopSecretValue123');
    expect(out).toContain('password: "[REDACTED credential');
  });

  it('redacts the same shape from a YAML-style config line, not only dotenv', () => {
    const out = redactSecrets('  secret: mySecretPass99\n  name: app\n');

    expect(out).not.toContain('mySecretPass99');
    expect(out).toContain('secret: [REDACTED credential');
    expect(out).toContain('name: app');
  });
});

describe('redactSecrets — ordinary source code', () => {
  const untouched = [
    'interface Config { apiKey: string; token?: number; secret: boolean }',
    'const token = accessToken;',
    'const secret = process.env.CLIENT_SECRET;',
    'headers: { Authorization: `Bearer ${apiToken}` }',
    'if (tokenType === "string_literal") return keyName;',
    'export const API_KEY_HEADER = "x-api-key";',
    "  { secretStoreKey: 'cohereKey', vscodeApiKeyKey: 'cohereApiKey' },",
    "const other = { ...CONTEXT, token: 'a-different-daemons-token' };",
    '"secretlint": "bin/secretlint.js"',
    'let privateKeyPath = ./keys/id_rsa',
    'auth_url: https://login.example.com/oauth/authorize',
    '// TODO: rotate the token before the release',
    'TOKEN_TTL=3600',
    'function readApiKey(): string | undefined { return this.credentials.apiKey; }',
    '-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8A\n-----END PUBLIC KEY-----',
  ];

  for (const line of untouched) {
    it(`leaves untouched: ${line.slice(0, 48)}`, () => {
      expect(redactSecrets(line)).toBe(line);
    });
  }

  it('returns empty and secret-free text unchanged', () => {
    expect(redactSecrets('')).toBe('');
    expect(redactSecrets('nothing to see here')).toBe('nothing to see here');
  });
});
