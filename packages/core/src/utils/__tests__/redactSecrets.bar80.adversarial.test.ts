import { describe, expect, it } from 'vitest';
import type { IRunnerSession } from '../../interfaces/IRunner';
import { BufferedTaskOutputSource } from '../../services/BufferedTaskOutputSource';
import { LineTail } from '../lineTail';
import { redactAgentText, redactSourceText } from '../redactSecrets';

/** Task #80. Every value is fake. The bar is an eight-character part of the secret. */
const shows = (text: string, secret: string) =>
  Array.from({ length: secret.length - 7 }, (_, i) => secret.slice(i, i + 8)).some((piece) => text.includes(piece));
const anyShown = (text: string, secrets: string[]) => secrets.some((secret) => shows(text, secret));

const DEPLOY_TOKEN = 'dT5fakeDeployValue8ZxCvBn';

/**
 * Bar (b): ADR-0061 lists "A naming field with its sibling value" (JSON and
 * ACP `{"name", "value"}`, YAML `- name:` / `value:`, XML `name= value=`). Each
 * is hidden when plain, and stays hidden when every line is prefixed with a
 * markdown quote, as an agent quotes command output it read: the sibling
 * search reads each line past the quote its name line opens with.
 */
const SIBLINGS: Array<{ name: string; lines: string[] }> = [
  { name: 'YAML `- name:` / `value:`', lines: ['$ kubectl get pod -o yaml', 'env:', '  - name: DEPLOY_TOKEN', `    value: ${DEPLOY_TOKEN}`, '  - name: REGION', '    value: eu-west-1'] },
  { name: 'JSON `{"name", "value"}` over lines', lines: ['$ kubectl get pod -o json', '"env": [', '  {', '    "name": "DEPLOY_TOKEN",', `    "value": "${DEPLOY_TOKEN}"`, '  }', ']'] },
  { name: 'XML `key=` / `value=` over lines', lines: ['$ cat web.config', '<appSettings>', '  <add key="DEPLOY_TOKEN"', `       value="${DEPLOY_TOKEN}" />`, '</appSettings>'] },
];
const QUOTES: Array<{ name: string; prefix: string }> = [
  { name: 'a markdown quote `> `', prefix: '> ' },
  { name: 'a nested markdown quote `>> `', prefix: '>> ' },
];

describe.each(SIBLINGS)('bar80 (b): $name, prefixed with a quote', ({ lines }) => {
  it('control: plain, the value is hidden', () => {
    expect(shows(redactAgentText(lines.join('\n')), DEPLOY_TOKEN)).toBe(false);
  });
  it('control: under a file viewer’s numbered gutter, the value is hidden', () => {
    expect(shows(redactAgentText(lines.map((l, i) => `${String(i + 9).padStart(6)}→${l}`).join('\n')), DEPLOY_TOKEN)).toBe(false);
  });
  it.each(QUOTES)('under $name, the value is hidden', ({ prefix }) => {
    const text = lines.map((l) => `${prefix}${l}`).join('\n');
    expect(redactAgentText(text)).not.toContain(DEPLOY_TOKEN);
    expect(shows(redactAgentText(text), DEPLOY_TOKEN)).toBe(false);
  });
});

/**
 * Bar (b): a key cut short of its END, as `head -n 4 id_rsa` prints it, is
 * hidden at every cut when plain (redactionAtEveryCut.test.ts). With its
 * BEGIN line coloured, or ended by an erase-line escape as CI logs end lines,
 * it is hidden whole, and a cut keeps the BEGIN line as its head: the
 * escape after `-----BEGIN RSA PRIVATE KEY-----` (`\x1b[0m`, `\x1b[K`) is no
 * body, so the key is still open where the cut falls.
 */
const BODY = [
  'MIIEowIBAAKCAQEAfakeKeyBodyLineOneAbCdEfGhIjKlMnOpQrStUvWxYz0123',
  'fakeKeyBodyLineTwoAbCdEfGhIjKlMnOpQrStUvWxYz0123456789+/AbCdEfGh',
  'fakeKeyBodyLineThreeAbCdEfGhIjKlMnOpQrStUvWxYz0123456789+/AbCdEf',
];
const KEY = ['$ head -n 4 id_rsa', '-----BEGIN RSA PRIVATE KEY-----', ...BODY, '$ next step'];
const COLOURS: Array<{ name: string; wrap: (line: string) => string }> = [
  { name: 'its BEGIN line in bold', wrap: (l) => (l.startsWith('-----BEGIN') ? `\x1b[1m${l}\x1b[0m` : l) },
  { name: 'every line in green', wrap: (l) => `\x1b[32m${l}\x1b[0m` },
  { name: 'every line ended by an erase-line escape', wrap: (l) => `${l}\x1b[K` },
];

function fakeSession() {
  const outputs: Array<(text: string) => void> = [];
  const session = {
    onOutput: (cb: (text: string) => void) => outputs.push(cb),
    onExit: () => {}, onEvent: () => {}, onTaskComplete: () => {}, onScriptExit: () => {},
  } as unknown as IRunnerSession;
  return { session, write: (text: string) => { for (const cb of outputs) cb(text); } };
}

describe.each(COLOURS)('bar80 (b): a key cut short of its END, $name, cut past its BEGIN line', ({ wrap }) => {
  const text = `${KEY.map(wrap).join('\n')}\n`;
  // The cut that drops the command line and the BEGIN line, and keeps the body.
  const keep = text.length - text.indexOf('\n', text.indexOf('-----BEGIN')) - 1;

  it('control: whole, the body is hidden', () => {
    expect(anyShown(redactAgentText(text), BODY)).toBe(false);
  });

  it('control: plain, the same cut hides the body', () => {
    const plain = `${KEY.join('\n')}\n`;
    const plainKeep = plain.length - plain.indexOf('\n', plain.indexOf('-----BEGIN')) - 1;
    const source = new BufferedTaskOutputSource({ maxBufferChars: plainKeep });
    const { session, write } = fakeSession();
    source.attach('t1', session);
    write(plain);
    expect(anyShown(source.liveTail('t1', { maxLines: 1000 })?.text ?? '', BODY)).toBe(false);
  });

  it('the live buffer’s tail and final text hide the body', () => {
    const source = new BufferedTaskOutputSource({ maxBufferChars: keep });
    const { session, write } = fakeSession();
    source.attach('t1', session);
    write(text);
    expect(anyShown(source.liveTail('t1', { maxLines: 1000 })?.text ?? '', BODY)).toBe(false);
    expect(anyShown(source.finalText('t1'), BODY)).toBe(false);
  });

  it('an ended attempt’s 16k tail hides the body', () => {
    const ended = 16 * 1024;
    const filler = 'build output\n'.repeat(Math.ceil(ended / 13)).slice(0, ended - keep);
    const source = new BufferedTaskOutputSource();
    const { session, write } = fakeSession();
    source.attach('t1', session);
    write(text);
    write(filler.slice(0, filler.lastIndexOf('\n') + 1));
    source.detach('t1');
    expect(anyShown(source.liveTail('t1', { maxLines: 2000 })?.text ?? '', BODY)).toBe(false);
    expect(anyShown(source.finalText('t1'), BODY)).toBe(false);
  });

  it('a stderr LineTail (a start error, a script’s error tail) hides the body', () => {
    const tail = new LineTail({ keepChars: keep, showChars: keep });
    tail.append(text);
    expect(anyShown(tail.read(redactAgentText), BODY)).toBe(false);
  });
});

describe('bar80 (c): the controls are kept', () => {
  it('source mode keeps `password: passwordField`', () => {
    expect(redactSourceText('password: passwordField')).toBe('password: passwordField');
  });
  it.each(['password: required', 'apiKey: string,', 'Authorization: required'])('agent mode keeps `%s`', (control) => {
    expect(redactAgentText(control)).toBe(control);
  });
});
