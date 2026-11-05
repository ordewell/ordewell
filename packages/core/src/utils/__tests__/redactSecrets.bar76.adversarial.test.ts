import { describe, it, expect } from 'vitest';
import { redactSourceText, redactAgentText } from '../redactSecrets';

/**
 * Task #76: redaction checked against a fixed bar. Every value here is fake.
 *
 * (b) In agent text, a value under a credential-named key, of any shape, a
 *     Bearer token, a PEM private key in any form, is never shown, in whole or
 *     in recognisable part.
 * (c) Source-like text keeps the identifier bypass, and redaction never hangs
 *     on large or adversarial input.
 */

/** Mixed case and digits: key material by any test, but also an identifier. */
const ALNUM = 'aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xYfake';
const HEX = 'abcdef0123456789abcdef0123456789';
const LOWER = 'qwertyuiopasdfghjklzxcvbnmfake';
const SLUGGED = 'fake-tkn-qzx-wvy-plm';

/** Any 8-char run of `secret` in `text`: what a reader could recognise it by. */
const shows = (text: string, secret: string) =>
  Array.from({ length: secret.length - 7 }, (_, i) => secret.slice(i, i + 8)).some((piece) => text.includes(piece));

describe('bar (b): a value assigned with a colon and left unquoted, in agent text', () => {
  // A CLI that prints its settings as YAML, or an HTTP debug log of its request headers.
  const cases: Array<[string, string, string]> = [
    ['a *_API_KEY in YAML', `env:\n  MISTRAL_API_KEY: ${ALNUM}\n`, ALNUM],
    ['an x-api-key header line', `> x-api-key: ${HEX}`, HEX],
    ['an api-key header line', `api-key: ${ALNUM}`, ALNUM],
    ['an X-Goog-Api-Key header line', `X-Goog-Api-Key: ${ALNUM}`, ALNUM],
    ['a harness login token, letters only', `ANTHROPIC_AUTH_TOKEN: ${LOWER}`, LOWER],
    ['a *_TOKEN shaped like a slug', `GITHUB_TOKEN: ${SLUGGED}`, SLUGGED],
    ['an Authorization header with the Token scheme', `> Authorization: Token ${HEX}`, HEX],
    ['an Authorization header with a letters-only Bearer token', `> Authorization: Bearer ${LOWER}`, LOWER],
    ['the same inside a curl line', `curl -H "Authorization: Bearer ${LOWER}" https://api.example.com/v1`, LOWER],
  ];

  for (const [label, text, secret] of cases) {
    it(`redacts ${label}`, () => {
      const out = redactAgentText(text);
      expect(shows(out, secret), out).toBe(false);
      expect(out).toContain('[REDACTED');
    });
  }

  it('redacts a credential flag given its value after a space', () => {
    const out = redactAgentText(`spawn cline --api-key ${ALNUM} --verbose`);
    expect(shows(out, ALNUM), out).toBe(false);
  });

  it('still leaves prose under a credential word alone (control, passes today)', () => {
    for (const text of ['password: required', 'Error: token expired, run `login` again']) {
      expect(redactAgentText(text)).toBe(text);
    }
  });
});

describe('bar (b): a private key in forms the line rules miss, in both modes', () => {
  const BODY = [
    'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7FAKEFAKEFAKE',
    'p9QrS1tU3vW5xY7zA9bC1dE3fG5hI7jK9lM1nO3pQ5rS7tU9vW1xY3zA5bC7dE9f',
    'q8PrR0sT2uV4wX6yZ8aB0cD2eF4gH6iJ8kL0mN2oP4qR6sT8uV0wX2yZ4aB6cD8',
  ];
  const leaked = (out: string) => BODY.some((line) => shows(out, line));

  for (const [mode, redact] of [['source', redactSourceText], ['agent', redactAgentText]] as const) {
    it(`redacts a CRLF key cut before its END (${mode})`, () => {
      const out = redact(`ssh: loading key\r\n-----BEGIN PRIVATE KEY-----\r\n${BODY.join('\r\n')}\r\n`);
      expect(leaked(out), JSON.stringify(out)).toBe(false);
    });

    it(`redacts a CRLF key with its END (${mode}) (control, passes today)`, () => {
      const out = redact(`-----BEGIN PRIVATE KEY-----\r\n${BODY.join('\r\n')}\r\n-----END PRIVATE KEY-----\r\nnext\r\n`);
      expect(leaked(out), JSON.stringify(out)).toBe(false);
    });

    it(`redacts a key flattened with spaces whose BEGIN was cut off (${mode})`, () => {
      const out = redact(`Invalid PEM in KEY_MATERIAL: …${BODY.join(' ')} -----END PRIVATE KEY-----`);
      expect(leaked(out), out).toBe(false);
    });

    it(`redacts a key whose every line a log prefix opens (${mode})`, () => {
      const pem = ['-----BEGIN PRIVATE KEY-----', ...BODY, '-----END PRIVATE KEY-----'];
      const out = redact(pem.map((line) => `[2026-11-05 10:00:00] ${line}`).join('\n'));
      expect(leaked(out), out).toBe(false);
    });

    it(`redacts the body of a prefixed key whose BEGIN was cut off (${mode})`, () => {
      const out = redact([...BODY, '-----END PRIVATE KEY-----'].map((line) => `[cline] ${line}`).join('\n'));
      expect(leaked(out), out).toBe(false);
    });
  }
});

describe('bar (c): redaction stays fast on adversarial input', () => {
  /** One call's wall time, in ms. */
  const timed = (redact: (text: string) => string, text: string) => {
    const started = performance.now();
    redact(text);
    return performance.now() - started;
  };
  // A linear pass over these sizes takes a few ms; the bound leaves a slow machine room.
  const BOUND_MS = 500;
  const LONG = 60_000;

  it('NAMED_CREDENTIAL on a run of credential words (8,000 chars; a stderr line may be 16,000)', () => {
    expect(timed(redactSourceText, '-token'.repeat(1334))).toBeLessThan(BOUND_MS);
  }, LONG);

  it('NAMED_CREDENTIAL on a run of `.apikey` (8,000 chars)', () => {
    expect(timed(redactSourceText, '.apikey'.repeat(1143))).toBeLessThan(BOUND_MS);
  }, LONG);

  it('NAMED_CREDENTIAL on a dotted run with no credential word (128,000 chars, as a minified read_file line)', () => {
    expect(timed(redactSourceText, 'a.'.repeat(64_000))).toBeLessThan(BOUND_MS);
  }, LONG);

  it('ASSIGNED_NAME on a hyphenated run, in agent text (64,000 chars, as a JSON-RPC message)', () => {
    expect(timed(redactAgentText, 'a-'.repeat(32_000))).toBeLessThan(BOUND_MS);
  }, LONG);

  it('INLINE_PEM on a BEGIN line and a run of backslashes (64,000 chars)', () => {
    expect(timed(redactSourceText, `-----BEGIN PRIVATE KEY----- ${'\\'.repeat(64_000)}!`)).toBeLessThan(BOUND_MS);
  }, LONG);

  it('ESCAPED_PEM_END on a run of backslashes (64,000 chars)', () => {
    expect(timed(redactSourceText, `PRIVATE KEY ${'\\'.repeat(64_000)}`)).toBeLessThan(BOUND_MS);
  }, LONG);

  it('DOTENV_CREDENTIAL on a line of repeated TOKEN_ (128,000 chars)', () => {
    expect(timed(redactSourceText, 'TOKEN_'.repeat(21_334))).toBeLessThan(BOUND_MS);
  }, LONG);

  it('stays fast on ordinary long text (control, passes today)', () => {
    expect(timed(redactAgentText, `${'lorem ipsum dolor sit amet '.repeat(4000)}\n`.repeat(4))).toBeLessThan(BOUND_MS);
  }, LONG);
});

describe('bar (c): source text keeps the identifier bypass', () => {
  // redactSourceText's own doc names the first: "A value that reads as code
  // (`password: passwordField`) is left as it is." The `value.length >= 12`
  // branch for an unambiguous name runs before the IDENTIFIER bypass.
  for (const line of [
    'password: passwordField',
    'password = passwordField',
    "password: 'passwordInput'",
    'secret: secretManagerName',
    'privateKey: privateKeyBuffer,',
    'credentials: credentialStore',
    'passphrase: passphraseInput',
    'password: hashedPassword',
  ]) {
    it(`leaves untouched: ${line}`, () => {
      expect(redactSourceText(line)).toBe(line);
    });
  }

  for (const line of [
    'const apiKey: string = config.apiKey;',
    "vscodeApiKeyKey: 'qwenApiKey',",
    'headers: { Authorization: `Bearer ${token}` }',
    'const password = passwordField.value;',
  ]) {
    it(`leaves untouched: ${line} (control, passes today)`, () => {
      expect(redactSourceText(line)).toBe(line);
    });
  }
});
