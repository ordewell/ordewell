import { describe, it, expect } from 'vitest';
import { redactSourceText, redactAgentText } from '../redactSecrets';
import { fakeSecret } from '../../services/__tests__/fakeSecret';

/**
 * Two halves, and the second matters as much as the first: a planner reading a
 * config file must not leak its credentials, and a planner reading ordinary
 * source code — which is full of the words `token` and `key` — must get that
 * code back byte for byte. Agent text — what a runner writes to stderr or
 * answers over JSON-RPC — is never source code, so it gives up that second
 * half for credential-named keys: their value goes whatever it looks like.
 */

const PEM = [
  '-----BEGIN RSA PRIVATE KEY-----',
  'MIIEogIBAAKCAQEAyq8Hn0aJ5rW1kXQ0mF7pB2vN9sT4uL6cD8eG1hI3jK5lM7nO',
  'p9QrS1tU3vW5xY7zA9bC1dE3fG5hI7jK9lM1nO3pQ5rS7tU9vW1xY3zA5bC7dE9f',
  '-----END RSA PRIVATE KEY-----',
].join('\n');

describe('redactSourceText — credential material', () => {
  it('redacts a named credential variable in a dotenv file', () => {
    const out = redactSourceText('DATABASE_PASSWORD=hunter2\nDEBUG=true\n');

    expect(out).not.toContain('hunter2');
    expect(out).toContain('DATABASE_PASSWORD=[REDACTED credential: 7 chars]');
    expect(out).toContain('DEBUG=true');
  });

  it('redacts a named credential in JSON, keeping the key visible', () => {
    const out = redactSourceText(`{ "apiKey": "${fakeSecret('google')}" }`);

    expect(out).not.toContain('AIzaSyD');
    expect(out).toContain('"apiKey": "[REDACTED');
  });

  it('redacts provider key prefixes wherever they appear', () => {
    const secrets = [
      fakeSecret('openai'),
      fakeSecret('anthropic'),
      fakeSecret('github'),
      fakeSecret('slack'),
      fakeSecret('stripeRestricted'),
      fakeSecret('jwt'),
    ];

    for (const secret of secrets) {
      const out = redactSourceText(`the value is ${secret} — rotate it`);
      expect(out, secret).not.toContain(secret);
      expect(out, secret).toContain('[REDACTED api key');
      expect(out, secret).toContain('rotate it');
    }
  });

  it('redacts a cloud access key identifier printed on its own', () => {
    const out = redactSourceText(`User: arn:aws:iam::123456789012:user/dev (${fakeSecret('aws')})`);

    expect(out).not.toContain(fakeSecret('aws'));
    expect(out).toContain('[REDACTED access key id: 20 chars]');
  });

  it('drops a private key body but keeps the block headers', () => {
    const out = redactSourceText(PEM);

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

    const out = redactSourceText(truncated);

    expect(out).not.toContain('b3BlbnNzaC1rZXktdjEA');
    expect(out).toContain('[REDACTED private key');
    expect(out).toContain('(File has more lines — use offset=2000 to read beyond line 2000)');
  });

  it('redacts through the line prefixes read_file and grep add', () => {
    const numbered = redactSourceText(`  12|STRIPE_SECRET_KEY=${fakeSecret('stripeLive')}`);
    expect(numbered).not.toContain('sk_live_a1b2c3');
    expect(numbered).toContain('  12|STRIPE_SECRET_KEY=');

    const grepped = redactSourceText(`config/.env:3:export GITHUB_TOKEN=${fakeSecret('github')}`);
    expect(grepped).not.toContain('ghp_a1b2c3');
    expect(grepped).toContain('config/.env:3:export GITHUB_TOKEN=');
  });

  it('marks the length of what it removed rather than deleting it', () => {
    const out = redactSourceText('API_KEY=abcdefghij0123456789');

    expect(out).toMatch(/\[REDACTED credential: 20 chars\]/);
  });

  // An unambiguous credential name — `password`, `secret`, `privateKey` — means
  // the value itself is claimed to *be* the secret, not a reference to one. The
  // identifier-shaped bypass exists for values like `cohereKey` (a setting
  // naming another setting), which never carry a digit; a value that mixes
  // letters and a digit is not that shape, so it should not get the benefit of
  // the doubt just because it starts with a letter.
  it('redacts a named credential whose value merely looks like an identifier', () => {
    const out = redactSourceText('password: "TopSecretValue123"');

    expect(out).not.toContain('TopSecretValue123');
    expect(out).toContain('password: "[REDACTED credential');
  });

  it('redacts the same shape from a YAML-style config line, not only dotenv', () => {
    const out = redactSourceText('  secret: mySecretPass99\n  name: app\n');

    expect(out).not.toContain('mySecretPass99');
    expect(out).toContain('secret: [REDACTED credential');
    expect(out).toContain('name: app');
  });

  // A long, plain-word value under an unambiguous name — no digit, no mixed
  // case, no punctuation — is a real secret, not a reference. Length is the
  // signal that separates it from a short settings-reference like `cohereKey`.
  it('redacts a long no-digit value under an unambiguous name (name+length floor)', () => {
    const leaked: Array<[string, string]> = [
      ['password: "batterystaple"', 'batterystaple'],
      ['secret: "correcthorsebatterystaple"', 'correcthorsebatterystaple'],
    ];
    for (const [input, secret] of leaked) {
      const out = redactSourceText(input);
      expect(out).not.toContain(secret);
      expect(out).toContain('[REDACTED credential');
    }
  });

  // But a short plain-word value under the same name is a settings-reference
  // (`secretStoreKey: 'cohereKey'`), not key material — keep the length floor
  // from rewriting config-shaped code.
  it('does not rewrite a short no-digit value that is a settings reference', () => {
    const input = "{ secretStoreKey: 'cohereKey' }";
    expect(redactSourceText(input)).toBe(input);
  });
});

describe('redactSourceText — ordinary source code', () => {
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
      expect(redactSourceText(line)).toBe(line);
    });
  }

  it('returns empty and secret-free text unchanged', () => {
    expect(redactSourceText('')).toBe('');
    expect(redactSourceText('nothing to see here')).toBe('nothing to see here');
  });
});

const ALNUM = 'aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xYfake';
const credential = (secret: string) => `[REDACTED credential: ${secret.length} chars]`;

describe('redactAgentText — any value under a credential name', () => {
  const echoed: Array<[string, string, string]> = [
    ['an env-var name in JSON', `{"env":{"MISTRAL_API_KEY":"${ALNUM}"}}`, ALNUM],
    ['a _TOKEN name', `{"X_TOKEN":"${ALNUM}"}`, ALNUM],
    ['a _SECRET name', `{"CLIENT_SECRET": "${ALNUM}"}`, ALNUM],
    ['a name the harness logs in with', `{"ANTHROPIC_API_KEY":"${ALNUM}"}`, ALNUM],
    ['an Authorization header value', `{"headers":{"Authorization":"Bearer ${ALNUM}"}}`, `Bearer ${ALNUM}`],
    ['x-api-key', `{"x-api-key":"${ALNUM}"}`, ALNUM],
    ['api-key in single quotes', `{'api-key': '${ALNUM}'}`, ALNUM],
    ['a camelCase key', `settings: { apiKey: "${ALNUM}" }`, ALNUM],
    ['a camelCase acronym', `{ openAIApiKey: \`${ALNUM}\` }`, ALNUM],
    ['a password', `"password": "${ALNUM}"`, ALNUM],
    ['an assignment', `MISTRAL_API_KEY=${ALNUM} node server.js`, ALNUM],
    ['a command-line flag', `spawn agent --api-key=${ALNUM} --verbose`, ALNUM],
    ['a query string', `GET /v1/models?api_key=${ALNUM}&limit=5`, ALNUM],
    ['a Ruby hash', `{ :access_token => "${ALNUM}" }`, ALNUM],
    ['letters only', '{"OPENROUTER_API_KEY":"abcdefghijklmnopqrstuvwxyz"}', 'abcdefghijklmnopqrstuvwxyz'],
    ['a short value', '{"X_TOKEN":"abc"}', 'abc'],
    ['a value with a quote escaped in it', String.raw`{"X_TOKEN":"ab\"cd${ALNUM}"}`, String.raw`ab\"cd${ALNUM}`],
    ['a value cut before its closing quote', `{"X_TOKEN":"${ALNUM}`, ALNUM],
  ];

  for (const [label, text, secret] of echoed) {
    it(label, () => {
      const out = redactAgentText(text);
      expect(out).not.toContain(secret);
      expect(out).toContain(credential(secret));
    });
  }

  it('reaches into JSON escaped once and twice', () => {
    const once = JSON.stringify(JSON.stringify({ env: { MISTRAL_API_KEY: ALNUM } }));
    const twice = JSON.stringify(once);
    for (const text of [once, twice]) {
      const out = redactAgentText(text);
      expect(out, text).not.toContain(ALNUM.slice(0, 12));
      expect(out, text).toContain(credential(ALNUM));
    }
  });

  it('keeps the key, the quotes and what follows', () => {
    expect(redactAgentText(`{"env":{"X_TOKEN":"${ALNUM}","DEBUG":"1"}}`))
      .toBe(`{"env":{"X_TOKEN":"${credential(ALNUM)}","DEBUG":"1"}}`);
  });

  it('redacts a value the source rules keep because it reads as a name', () => {
    const line = "const other = { ...CONTEXT, token: 'a-different-daemons-token' };";
    expect(redactSourceText(line)).toBe(line);
    expect(redactAgentText(line)).not.toContain('a-different-daemons-token');
  });

  it('leaves a held secret marked as held', () => {
    const out = redactAgentText(`{"OPENAI_API_KEY":"${ALNUM}"}`, [ALNUM]);
    expect(out).toBe(`{"OPENAI_API_KEY":"[REDACTED secret: ${ALNUM.length} chars]"}`);
  });

  const untouched = [
    '{"model":"gpt-4o","max_tokens":"1000","input_tokens":12}',
    '{"key":"value","type":"service_account"}',
    'Error: token expired, run `login` again',
    'password: required',
    'the api key is invalid',
    '{"tokenizer":"cl100k_base"}',
    'if (token == "abc") return',
    'OPENAI_BASE_URL=https://api.example.com/v1',
  ];
  for (const text of untouched) {
    it(`leaves untouched: ${text.slice(0, 48)}`, () => {
      expect(redactAgentText(text)).toBe(text);
    });
  }
});

describe('a Bearer or Basic credential, in both modes', () => {
  const BEARER = 'zX9cV7bN5mQ3wE1rT9yU7iO5pA3sD1fGfake';
  const BASIC = Buffer.from('fake-user:fake-pass-1234').toString('base64');
  const token = (value: string) => `[REDACTED token: ${value.length} chars]`;

  for (const [mode, redact] of [['source', redactSourceText], ['agent', redactAgentText]] as const) {
    it(`redacts a Bearer token after its header name (${mode})`, () => {
      expect(redact(`Authorization: Bearer ${BEARER}`)).toBe(`Authorization: Bearer ${token(BEARER)}`);
    });

    it(`redacts a Basic credential in a curl line (${mode})`, () => {
      expect(redact(`curl -H "authorization: basic ${BASIC}" https://api.example.com`))
        .toBe(`curl -H "authorization: basic ${token(BASIC)}" https://api.example.com`);
    });

    it(`redacts a Bearer token in prose (${mode})`, () => {
      expect(redact(`retrying with Bearer ${BEARER}.`)).not.toContain(BEARER.slice(0, 12));
    });

    for (const text of [
      'Basic authentication is disabled for this endpoint',
      'Bearer tokens expire after an hour',
      'const header = "Basic " + encoded;',
    ]) {
      it(`leaves untouched (${mode}): ${text.slice(0, 40)}`, () => {
        expect(redact(text)).toBe(text);
      });
    }
  }
});

describe('a private key in every form, in both modes', () => {
  const BODY = PEM.split('\n').slice(1, -1);
  const bodyChars = BODY.join('').length;
  const removed = `[REDACTED private key: ${bodyChars} chars]`;
  const END = '-----END RSA PRIVATE KEY-----';

  for (const [mode, redact] of [['source', redactSourceText], ['agent', redactAgentText]] as const) {
    it(`redacts body lines above an END line whose BEGIN is gone (${mode})`, () => {
      const text = ['debug: loading extension manifest', ...BODY, END, 'debug: done'].join('\n');
      expect(redact(text)).toBe(['debug: loading extension manifest', removed, END, 'debug: done'].join('\n'));
    });

    it(`redacts body lines above an END line through read_file's line numbers (${mode})`, () => {
      const text = [...BODY, END].map((line, i) => `${String(i + 40).padStart(6)}|${line}`).join('\n');
      const out = redact(text);
      for (const line of BODY) expect(out).not.toContain(line.slice(0, 16));
      expect(out).toContain(removed);
      expect(out).toContain(END);
    });

    it(`redacts a key escaped onto one line, as a service-account file holds it (${mode})`, () => {
      const file = JSON.stringify({ type: 'service_account', private_key_id: 'abc123', key_material: `${PEM}\n`, client_email: 'bot@example.iam.gserviceaccount.com' }, null, 2);
      const out = redact(file);
      for (const line of BODY) expect(out).not.toContain(line.slice(0, 16));
      expect(out).toContain(`"key_material": "-----BEGIN RSA PRIVATE KEY-----\\n${removed}\\n${END}\\n"`);
      expect(out).toContain('"client_email": "bot@example.iam.gserviceaccount.com"');
    });

    it(`redacts a key escaped twice (${mode})`, () => {
      const out = redact(JSON.stringify(JSON.stringify({ key_material: PEM })));
      for (const line of BODY) expect(out).not.toContain(line.slice(0, 16));
      expect(out).toContain(removed);
    });

    it(`redacts an escaped key whose END was cut off (${mode})`, () => {
      const escaped = JSON.stringify({ key_material: PEM });
      const out = redact(escaped.slice(0, escaped.indexOf(BODY[1]) + 20));
      expect(out).not.toContain(BODY[0].slice(0, 16));
      expect(out).not.toContain(BODY[1].slice(0, 16));
      expect(out).toContain('[REDACTED private key');
    });

    it(`redacts an escaped key whose BEGIN was cut off (${mode})`, () => {
      const escaped = JSON.stringify({ key_material: PEM, after: 'kept' });
      const out = redact(escaped.slice(escaped.indexOf(BODY[0]) + 10));
      expect(out).not.toContain(BODY[0].slice(10, 26));
      expect(out).not.toContain(BODY[1].slice(0, 16));
      expect(out).toContain(`\\n${END}`);
      expect(out).toContain('"after":"kept"');
    });

    it(`redacts a key flattened onto one line with spaces (${mode})`, () => {
      const out = redact(`KEY_MATERIAL="${PEM.replace(/\n/g, ' ')}"`);
      for (const line of BODY) expect(out).not.toContain(line.slice(0, 16));
    });

    it(`keeps a one-word line above an END line that is not key material (${mode})`, () => {
      const text = ['Warning', ...BODY.slice(-1), END].join('\n');
      expect(redact(text)).toBe(['Warning', `[REDACTED private key: ${BODY[BODY.length - 1].length} chars]`, END].join('\n'));
    });
  }
});
