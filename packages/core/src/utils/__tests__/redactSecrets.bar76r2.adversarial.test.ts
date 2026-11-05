import { describe, it, expect } from 'vitest';
import { redactSourceText, redactAgentText } from '../redactSecrets';

/**
 * Task #76, round 2: redaction checked against the fixed bar after #81's
 * fix. Every value here is fake.
 *
 * (b) In agent text, a value under a credential-named key (`*_API_KEY`,
 *     `*_TOKEN`, `Authorization`, `api-key`, isCredentialVariable names), of
 *     any shape, a Bearer token, a PEM private key in any form, is never shown
 *     in whole or in recognisable part.
 * (c) Redaction never hangs on large or adversarial input.
 */

/** Mixed case and digits, yet an IDENTIFIER: the bypass keeps it once no agent rule took it. */
const ALNUM = 'aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xYfake';
/** Hex that opens with a letter: an IDENTIFIER too. */
const HEX = 'dbcdef0123456789abcdef0123456789';
const LOWER = 'qwertyuiopasdfghjklzxcvbnmfake';
const SLUGGED = 'fake-tkn-qzx-wvy-plm';

/** Any 8-char run of `secret` in `text`: what a reader could recognise it by. */
const shows = (text: string, secret: string) =>
  Array.from({ length: secret.length - 7 }, (_, i) => secret.slice(i, i + 8)).some((piece) => text.includes(piece));

describe('bar (c), round 2: redaction stays fast on adversarial input', () => {
  /** One call's wall time, in ms. */
  const timed = (redact: (text: string) => string, text: string) => {
    const started = performance.now();
    redact(text);
    return performance.now() - started;
  };
  // A linear pass over 64,000 chars takes a few ms; the bound leaves a slow machine room.
  const BOUND_MS = 500;
  const LONG = 60_000;

  // ASSIGNED_NAME's lookbehind (redactSecrets.ts:300) lets a name start after two
  // non-name chars (`--`, `.-`, `..`), and each start scans to the end of the run.
  for (const unit of ['x--', 'x.-', 'x..']) {
    it(`ASSIGNED_NAME on a run of \`${unit}\`, in agent text (64,000 chars, as a JSON-RPC message)`, () => {
      expect(timed(redactAgentText, unit.repeat(21_334))).toBeLessThan(BOUND_MS);
    }, LONG);
  }

  // LINE_PREFIX's bracket groups (redactSecrets.ts:61), inside DOTENV_CREDENTIAL (96):
  // every count of `[a]` groups is tried, and at each `[^\s:]*:\d+:` scans the rest of the line.
  for (const [mode, redact] of [['source', redactSourceText], ['agent', redactAgentText]] as const) {
    it(`DOTENV_CREDENTIAL on a line of \`[a]\` groups (${mode}, 64,000 chars)`, () => {
      expect(timed(redact, '[a]'.repeat(21_334))).toBeLessThan(BOUND_MS);
    }, LONG);
  }

  it('stays fast on a hyphenated run, as round 1 fixed (control, passes today)', () => {
    expect(timed(redactAgentText, 'a-'.repeat(32_000))).toBeLessThan(BOUND_MS);
  }, LONG);
});

describe('bar (b), round 2: a value under a credential name, in agent text', () => {
  const cases: Array<[string, string, string]> = [
    // A JSON-encoded stderr or log line: ASSIGNED_NAME's lookbehind refuses a name after `\`,
    // DOTENV needs a line start, and NAMED_CREDENTIAL's IDENTIFIER bypass keeps the value.
    ['an env line inside a JSON string, after an escaped newline', `{"error":"spawn failed:\\nMISTRAL_API_KEY=${ALNUM}\\nHOME=/home/u"}`, ALNUM],
    ['an env line inside a JSON string, after an escaped tab', `{"stderr":"\\tOPENAI_API_KEY=${ALNUM}"}`, ALNUM],
    ['a header line inside a JSON string', `{"stderr":"request headers\\nX-Api-Key: ${HEX}\\n"}`, HEX],
    // `Authorization` has no `_` or `-`, so its bare colon value is not taken (DUMPED_NAME, 315),
    // CREDENTIAL_WORD's `auth(?![a-z])` misses it, and AUTH_SCHEME needs a scheme word.
    ['an Authorization header with no scheme', `> Authorization: ${HEX}`, HEX],
    ['a lower-case authorization header with no scheme', `< authorization: ${ALNUM}`, ALNUM],
    // camelCase names are credentialNamed, but a bare colon value needs `_` or `-` in the name.
    ['a camelCase apiKey in YAML', `provider:\n  apiKey: ${HEX}\n`, HEX],
    ['a camelCase authToken in YAML', `authToken: ${HEX}`, HEX],
    ["a Go struct printed with %+v", `config: {BaseURL:https://api.mistral.ai APIKey:${ALNUM} Timeout:30s}`, ALNUM],
  ];

  for (const [label, text, secret] of cases) {
    it(`redacts ${label}`, () => {
      const out = redactAgentText(text);
      expect(shows(out, secret), out).toBe(false);
    });
  }

  // A bare `=` value ends at BARE_VALUE_END (317), so the agent rule marks its head and
  // leaves the rest, and the marker's spaces then keep DOTENV from taking the line.
  // Source mode redacts the same lines whole.
  for (const [text, secret, sourceRedacts] of [
    ['DB_PASSWORD=hunter2,correct-horse-battery-staple', 'hunter2,correct-horse-battery-staple', true],
    ['MYSQL_PWD=Tr0ub4dor;xtra-long-tail-of-pass', 'Tr0ub4dor;xtra-long-tail-of-pass', false],
    ['SECRET_KEY=abc)defghijklmnopqrstu', 'abc)defghijklmnopqrstu', true],
  ] as const) {
    it(`redacts the whole of an unquoted value with a separator in it: ${text.split('=')[0]}`, () => {
      const out = redactAgentText(text);
      expect(shows(out, secret), out).toBe(false);
    });

    // MYSQL_PWD is an isCredentialVariable name only, so source mode, with no agent rules, has no control for it.
    if (sourceRedacts) {
      it(`source mode already redacts it whole: ${text.split('=')[0]} (control, passes today)`, () => {
        const out = redactSourceText(text);
        expect(shows(out, secret), out).toBe(false);
      });
    }
  }

  it('still leaves prose and code under a credential word alone (control, passes today)', () => {
    for (const text of ['password: required', 'Error: token expired, run `login` again', 'apiKey: string,', 'Authorization: required']) {
      expect(redactAgentText(text)).toBe(text);
    }
  });
});

describe('bar (b), round 2: a credential name with a number or suffix after it, in agent text', () => {
  // credentialNamed (321) tests isCredentialVariable and CREDENTIAL_KEY_SUFFIX (319), which ends
  // at API_KEY, TOKEN or SECRET: `_0`, `_2`, `_BACKUP`, `_v2` or a plural after it fail both, and
  // NAMED_CREDENTIAL's IDENTIFIER bypass (505) keeps a value that opens with a letter.
  /** An MCP token's shape, randomBytes(32).toString('base64url'), with no `-`: an IDENTIFIER. */
  const TOK = 'Qx7fakeTok3nB64urlAbCdEfGhIjKlMnOpQrStUvW9z';
  const cases: Array<[string, string, string]> = [
    ["a Codex attempt's MCP token variable in a JSON env dump", `{"PATH":"/usr/bin","ORDEWELL_MCP_TOKEN_0":"${TOK}"}`, TOK],
    ['the same on a command line', `ORDEWELL_MCP_TOKEN_0=${TOK} codex exec --json`, TOK],
    ['a numbered *_API_KEY in YAML', `MISTRAL_API_KEY_2: ${ALNUM}`, ALNUM],
    ['a *_API_KEY_BACKUP in JSON', `{"OPENAI_API_KEY_BACKUP": "${ALNUM}"}`, ALNUM],
    ['a numbered *_TOKEN in JSON', `{"GITHUB_TOKEN_1": "${ALNUM}"}`, ALNUM],
    ['a versioned api_key in JSON', `{"api_key_v2": "${ALNUM}"}`, ALNUM],
    ['a plural apiKeys in JSON', `{"apiKeys": ["${ALNUM}"]}`, ALNUM],
  ];

  for (const [label, text, secret] of cases) {
    it(`redacts ${label}`, () => {
      const out = redactAgentText(text);
      expect(shows(out, secret), out).toBe(false);
    });
  }

  it('redacts the unnumbered name (control, passes today)', () => {
    const out = redactAgentText(`{"PATH":"/usr/bin","GITHUB_TOKEN":"${ALNUM}"}`);
    expect(shows(out, ALNUM), out).toBe(false);
  });
});

describe('bar (b), round 2: a credential name and its value laid out as a table or element', () => {
  // An agent's report or a CLI listing that pairs the name and the value without `=` or `:`.
  const cases: Array<[string, string, string]> = [
    ['a markdown table row', `| Name | Value |\n|---|---|\n| GITHUB_TOKEN | ${SLUGGED} |`, SLUGGED],
    ['an XML element', `<GITHUB_TOKEN>${SLUGGED}</GITHUB_TOKEN>`, SLUGGED],
    ['a settings.xml password', `<server><id>repo</id><password>${ALNUM}</password></server>`, ALNUM],
  ];

  for (const [label, text, secret] of cases) {
    it(`redacts ${label}`, () => {
      const out = redactAgentText(text);
      expect(shows(out, secret), out).toBe(false);
    });
  }
});

describe('bar (b), round 2: a Bearer token outside a header', () => {
  // looksLikeToken (291) wants a digit, mixed case or `+/=`; a token of one case and no digit is shown.
  for (const [label, text, secret] of [
    ['a letters-only token', `retrying with Bearer ${LOWER}`, LOWER],
    ['a hyphenated letters-only token', `using Bearer abcdefgh-ijklmnop-qrstuvwx`, 'abcdefgh-ijklmnop-qrstuvwx'],
  ]) {
    it(`redacts ${label}`, () => {
      const out = redactAgentText(text);
      expect(shows(out, secret), out).toBe(false);
    });
  }

  it('leaves the scheme word in prose alone (control, passes today)', () => {
    for (const text of ['Bearer authentication is required', 'send a Bearer token in the header']) {
      expect(redactAgentText(text)).toBe(text);
    }
  });
});

describe('bar (b), round 2: a private key behind a line prefix PEM_BODY_LINE refuses', () => {
  const BODY = [
    'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7FAKEFAKEFAKE',
    'p9QrS1tU3vW5xY7zA9bC1dE3fG5hI7jK9lM1nO3pQ5rS7tU9vW1xY3zA5bC7dE9f',
    'q8PrR0sT2uV4wX6yZ8aB0cD2eF4gH6iJ8kL0mN2oP4qR6sT8uV0wX2yZ4aB6cD8',
  ];
  const PEM = ['-----BEGIN PRIVATE KEY-----', ...BODY, '-----END PRIVATE KEY-----'];
  const leaked = (out: string) => BODY.some((line) => shows(out, line));

  for (const [mode, redact] of [['source', redactSourceText], ['agent', redactAgentText]] as const) {
    it(`redacts a key in docker compose logs, every line behind \`app-1  | \` (${mode})`, () => {
      const out = redact(PEM.map((line) => `app-1  | ${line}`).join('\n'));
      expect(leaked(out), out).toBe(false);
    });

    it(`redacts a key quoted in markdown, every line behind \`> \` (${mode})`, () => {
      const out = redact(PEM.map((line) => `> ${line}`).join('\n'));
      expect(leaked(out), out).toBe(false);
    });

    it(`redacts a key behind a \`[cline] \` prefix (${mode}) (control, passes today)`, () => {
      const out = redact(PEM.map((line) => `[cline] ${line}`).join('\n'));
      expect(leaked(out), out).toBe(false);
    });
  }
});
