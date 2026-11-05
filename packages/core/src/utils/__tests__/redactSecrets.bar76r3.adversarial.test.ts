import { describe, expect, it } from 'vitest';
import { redactAgentText, redactSourceText } from '../redactSecrets';
import { LineTail } from '../lineTail';

/**
 * Task #76, round 3: agent-text redaction after #81's fix. Every value here
 * is fake.
 *
 * (b) In agent text, a value under a credential-named key of any shape, or a
 *     PEM private key in any form, is never shown, in whole or recognisable part.
 * (c) Source-like text keeps the identifier bypass, and redaction never throws
 *     or hangs on large or adversarial input.
 */
/** Mixed case and digits, yet an IDENTIFIER: nothing but its name marks it. */
const V = 'aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xYfake';

const shows = (text: string, secret: string) =>
  Array.from({ length: secret.length - 7 }, (_, i) => secret.slice(i, i + 8)).some((piece) => text.includes(piece));

describe('bar (b), round 3: assignment operators ASSIGNED_NAME reads as `:` then a value', () => {
  it.each([
    ['Makefile / Go `:=`', `GITHUB_TOKEN := ${V}`],
    ['Go short declaration, quoted', `apiKey := "${V}"`],
    ['Makefile `?=`', `MISTRAL_API_KEY ?= ${V}`],
    ['Makefile `+=`', `MISTRAL_API_KEY += ${V}`],
    ['Makefile `::=`', `MISTRAL_API_KEY ::= ${V}`],
  ])('redacts the value of %s', (_label, text) => {
    expect(shows(redactAgentText(text), V)).toBe(false);
  });
});

describe('bar (b), round 3: a credential name given as a value, its value beside it', () => {
  it.each([
    ['ACP / k8s / ECS env entry, JSON', `{"name":"GITHUB_TOKEN","value":"${V}"}`],
    ['the same, spaced', `{ "name": "GITHUB_TOKEN", "value": "${V}" }`],
    ['k8s env entry, YAML', `env:\n  - name: GITHUB_TOKEN\n    value: ${V}`],
    ['k8s env entry, YAML quoted', `env:\n  - name: GITHUB_TOKEN\n    value: "${V}"`],
    ['XML env element', `<env name="GITHUB_TOKEN" value="${V}"/>`],
    ['.NET appSettings', `<add key="ApiKey" value="${V}" />`],
    ['nested value object', `{"GITHUB_TOKEN":{"value":"${V}"}}`],
  ])('redacts the value of %s', (_label, text) => {
    expect(shows(redactAgentText(text), V)).toBe(false);
  });
});

describe('bar (b), round 3: a credential name in markdown emphasis', () => {
  it.each([
    ['bold label', `**GITHUB_TOKEN**: ${V}`],
    ['bold label, code value', `**GITHUB_TOKEN**: \`${V}\``],
    ['bold label in a list', `- **GITHUB_TOKEN**: ${V}`],
    ['bold name in a table', `| Name | Value |\n|---|---|\n| **GITHUB_TOKEN** | ${V} |`],
  ])('redacts the value of a %s', (_label, text) => {
    expect(shows(redactAgentText(text), V)).toBe(false);
  });
});

describe('bar (b), round 3: commands that set a credential name to the next word', () => {
  it.each([
    ['Windows setx', `setx MISTRAL_API_KEY ${V}`],
    ['Windows setx, quoted', `setx MISTRAL_API_KEY "${V}"`],
    ['Dockerfile legacy ENV', `ENV MISTRAL_API_KEY ${V}`],
    ['fish set -gx', `set -gx GITHUB_TOKEN ${V}`],
    ['launchctl setenv', `launchctl setenv GITHUB_TOKEN ${V}`],
    ['gh secret set', `gh secret set GITHUB_TOKEN --body ${V}`],
  ])('redacts the value of %s', (_label, text) => {
    expect(shows(redactAgentText(text), V)).toBe(false);
  });
});

describe('bar (b), round 3: a credential name as a subscript or call argument', () => {
  it.each([
    ['os.environ subscript', `os.environ["GITHUB_TOKEN"] = "${V}"`],
    ['process.env subscript', `process.env["GITHUB_TOKEN"]="${V}"`],
    ['Ruby ENV subscript', `ENV["GITHUB_TOKEN"] = "${V}"`],
    ['headers subscript', `headers["Authorization"] = "${V}"`],
    ['headers.set call', `headers.set("Authorization", "${V}")`],
    ['setHeader call', `setHeader('api-key', '${V}')`],
    ['Go os.Setenv', `os.Setenv("GITHUB_TOKEN", "${V}")`],
    ['.NET SetEnvironmentVariable', `[Environment]::SetEnvironmentVariable("GITHUB_TOKEN", "${V}", "User")`],
  ])('redacts the value of %s', (_label, text) => {
    expect(shows(redactAgentText(text), V)).toBe(false);
  });
});

describe('bar (b), round 3: a YAML value on the lines below its credential name', () => {
  it.each([
    ['literal block', `GITHUB_TOKEN: |\n  ${V}`],
    ['folded block', `GITHUB_TOKEN: >-\n  ${V}`],
    ['plain scalar on the next line', `GITHUB_TOKEN:\n  ${V}`],
  ])('redacts the value of a %s', (_label, text) => {
    expect(shows(redactAgentText(text), V)).toBe(false);
  });
});

describe('bar (b), round 3: a credential name an arrow points from', () => {
  it('redacts `NAME -> value`', () => {
    expect(shows(redactAgentText(`GITHUB_TOKEN -> ${V}`), V)).toBe(false);
  });
});

describe('bar (b), round 3: a credential name in colour, as a stderr tail keeps it raw', () => {
  it.each([
    ['bold name, `=`', `\x1b[1mGITHUB_TOKEN\x1b[0m=${V}`],
    ['green name, `:`', `\x1b[32mGITHUB_TOKEN\x1b[39m: ${V}`],
  ])('redacts the value after a %s', (_label, text) => {
    expect(shows(redactAgentText(text), V)).toBe(false);
  });
});

const BEGIN = '-----BEGIN RSA PRIVATE KEY-----';
const END = '-----END RSA PRIVATE KEY-----';
const BODY = [
  'MIIEowIBAAKCAQEAfakeKeyBodyLineOneAbCdEfGhIjKlMnOpQrStUvWxYz0123',
  'fakeKeyBodyLineTwoAbCdEfGhIjKlMnOpQrStUvWxYz0123456789+/AbCdEfGh',
  'fakeKeyBodyLineThreeAbCdEfGhIjKlMnOpQrStUvWxYz0123456789+/AbCdEf',
];
const bodyShown = (text: string) => BODY.some((line) => shows(text, line));
const prefixed = (prefix: string, lines: string[]) => lines.map((line) => prefix + line).join('\n');

describe('bar (b), round 3: a key truncated before BEGIN, under a prefix LINE_PREFIX does not know', () => {
  it('control: the same key with no prefix is redacted', () => {
    expect(bodyShown(redactAgentText([...BODY, END].join('\n')))).toBe(false);
  });
  it('control: under a compose prefix, with its BEGIN line, it is redacted', () => {
    expect(bodyShown(redactAgentText(prefixed('app-1  | ', [BEGIN, ...BODY, END])))).toBe(false);
  });
  it.each([
    ['docker compose logs', 'app-1  | '],
    ['a markdown quote', '> '],
  ])('redacts the body above END under a %s prefix', (_label, prefix) => {
    expect(bodyShown(redactAgentText(prefixed(prefix, [...BODY, END])))).toBe(false);
  });
  it.each([
    ['`cat -n`', (line: string, n: number) => `     ${n}\t${line}`],
    ['`nl`', (line: string, n: number) => `${String(n).padStart(6)}  ${line}`],
    ['`grep -n` on one file', (line: string, n: number) => `${n}:${line}`],
  ])('redacts the body above END numbered by %s', (_label, numbered) => {
    expect(bodyShown(redactAgentText([...BODY, END].map((line, i) => numbered(line, i + 2)).join('\n')))).toBe(false);
  });
});

describe('bar (b), round 3: a whole key, BEGIN and all, numbered as a file viewer shows it', () => {
  const KEY = [BEGIN, ...BODY, END];
  it('control: numbered by `cat -n`, the whole key is redacted', () => {
    expect(bodyShown(redactAgentText(KEY.map((line, i) => `     ${i + 1}\t${line}`).join('\n')))).toBe(false);
  });
  it.each([
    ['Claude Code’s Read tool (`     1→`)', (line: string, n: number) => `${String(n).padStart(6)}→${line}`],
    ['an arrow with no padding (`1→`)', (line: string, n: number) => `${n}→${line}`],
    ['a box-drawing gutter (`  1│ `), as bat prints', (line: string, n: number) => `${String(n).padStart(3)}│ ${line}`],
  ])('redacts the body numbered by %s', (_label, numbered) => {
    const shown = redactAgentText(KEY.map((line, i) => numbered(line, i + 1)).join('\n'));
    expect(bodyShown(shown)).toBe(false);
  });
});

describe('bar (b), round 3: a stderr tail (LineTail) cuts raw lines before it redacts', () => {
  // RunnerProcess.withStderrTail (runnerProcess.ts:263), leaseRelay.lastWords and the
  // egress sidecar's start error all read a LineTail through redactAgentText.
  const HEAD_OF_KEY = `${[BEGIN, ...BODY].join('\n')}\n`;
  it('control: with its BEGIN line kept, a truncated key’s body is redacted', () => {
    const tail = new LineTail({ keepChars: 10_000, showChars: 4_000 });
    tail.append(`${HEAD_OF_KEY}error: bad key\n`);
    expect(bodyShown(tail.read(redactAgentText))).toBe(false);
  });
  it('keeps the body out when dropOldestLines drops only the BEGIN line', () => {
    const text = `${HEAD_OF_KEY}error: bad key\n`;
    const tail = new LineTail({ keepChars: text.length - 5, showChars: 4_000 });
    tail.append(text);
    const read = tail.read(redactAgentText);
    expect(read).not.toContain('BEGIN');
    expect(bodyShown(read)).toBe(false);
  });
  it('keeps a value under a coloured credential name out, as stderr is kept with its colour', () => {
    const tail = new LineTail({ keepChars: 10_000, showChars: 4_000 });
    tail.append(`\x1b[1mGITHUB_TOKEN\x1b[0m=${V}\nerror: auth failed\n`);
    expect(shows(tail.read(redactAgentText), V)).toBe(false);
  });
});

describe('bar (c), round 3: controls that must stay as they are', () => {
  it.each([
    'password: required',
    'Error: token expired, run login again',
    'apiKey: string,',
    'Authorization: required',
  ])('agent text leaves %j unchanged', (text) => {
    expect(redactAgentText(text)).toBe(text);
  });
  it('source text keeps `password: passwordField`', () => {
    expect(redactSourceText('password: passwordField')).toBe('password: passwordField');
  });
  it('source text still redacts `password: "batterystaple"`', () => {
    expect(redactSourceText('password: "batterystaple"')).not.toContain('batterystaple');
  });
});

describe('bar (c), round 3: no rule backtracks on long adversarial input', () => {
  const N = 64 * 1024;
  it.each([
    ['name chars, no separator', 'a.'.repeat(N / 2)],
    ['separators without names', ': '.repeat(N / 2)],
    ['an unclosed quote after a name', `GITHUB_TOKEN: "${'\\"'.repeat(N / 2)}`],
    ['an unclosed list after a name', `GITHUB_TOKEN: [${'"a", '.repeat(N / 5)}`],
    ['table pipes', `| GITHUB_TOKEN ${'| '.repeat(N / 2)}`],
    ['an element left open', `<GITHUB_TOKEN>${'<a>'.repeat(N / 3)}`],
    ['dashes around a BEGIN', `-----BEGIN ${'-'.repeat(N)}`],
    ['body lines with no END', `${BEGIN}\n${'QUJD\n'.repeat(N / 5)}`],
    ['nested quotes and escapes', `"\\\\"${'\\\\"'.repeat(N / 3)}`],
    ['camel names', `${'aB'.repeat(N / 2)}: x`],
    ['padding after a separator', `:${' '.repeat(N)}x`],
    ['emphasis runs', `${'*'.repeat(N)}GITHUB_TOKEN: x`],
    ['escape runs', `${'\\'.repeat(N)}"GITHUB_TOKEN": x`],
    ['naming fields with no value', 'name: GITHUB_TOKEN '.repeat(N / 19)],
    ['naming fields a line each', 'name: GITHUB_TOKEN\n'.repeat(N / 19)],
    ['nested names left open', 'GITHUB_TOKEN: {'.repeat(N / 15)],
    ['names ending every line', 'GITHUB_TOKEN:\n'.repeat(N / 14)],
    ['block openers on every line', 'GITHUB_TOKEN: |\n'.repeat(N / 16)],
    ['one long block', `GITHUB_TOKEN: |\n${'  abcdefgh\n'.repeat(N / 11)}`],
    ['padding under a name', `GITHUB_TOKEN:\n${' '.repeat(N)}`],
    ['list dashes before a name', `${'- '.repeat(N / 2)}GITHUB_TOKEN:`],
    ['numbers before a name', `${'1 2 3 4 5 '.repeat(N / 10)}GITHUB_TOKEN:\n  x`],
    ['quoted subscripts', '["GITHUB_TOKEN"'.repeat(N / 15)],
    ['quoted arguments', '("GITHUB_TOKEN", '.repeat(N / 17)],
    ['set commands', 'setx GITHUB_TOKEN '.repeat(N / 18)],
  ])('redacts %s within a second', (_label, text) => {
    const started = Date.now();
    expect(() => redactAgentText(text)).not.toThrow();
    expect(() => redactSourceText(text)).not.toThrow();
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe('bar (c), round 3: the lines below a credential name that are not its value', () => {
  it.each([
    ['a Python condition', 'if api_key:\n    return api_key'],
    ['a method', 'def token(self):\n    return self._token'],
    ['a nested mapping', 'token:\n  required: true'],
    ['a list', 'password:\n  - a'],
    ['a CI expression', 'GITHUB_TOKEN:\n  ${{ secrets.GITHUB_TOKEN }}'],
    ['a schema', 'api_key:\n    type: string'],
    ['a value taken from elsewhere', '- name: GITHUB_TOKEN\n  valueFrom:\n    secretKeyRef:\n      name: gh'],
    ['a sibling of a name that is no credential', '{"name": "region", "value": "eu-west-1"}'],
    ['a case label', 'case token:\n  return x'],
  ])('agent text leaves %s unchanged', (_label, text) => {
    expect(redactAgentText(text)).toBe(text);
  });
});
