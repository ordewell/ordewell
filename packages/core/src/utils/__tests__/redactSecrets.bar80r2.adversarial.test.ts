import { describe, expect, it } from 'vitest';
import type { IRunnerSession } from '../../interfaces/IRunner';
import { BufferedTaskOutputSource } from '../../services/BufferedTaskOutputSource';
import { LineTail } from '../lineTail';
import { redactAgentText, redactSourceText } from '../redactSecrets';

/** Task #80 round 2: the variants of #85's F2 and F3 fixes, cut at every offset. Every value is fake. */
const shows = (text: string, secret: string) =>
  Array.from({ length: secret.length - 7 }, (_, i) => secret.slice(i, i + 8)).some((piece) => text.includes(piece));
const anyShown = (text: string, secrets: string[]) => secrets.some((secret) => shows(text, secret));

const BODY = [
  'MIIEowIBAAKCAQEAfakeKeyBodyLineOneAbCdEfGhIjKlMnOpQrStUvWxYz0123',
  'fakeKeyBodyLineTwoAbCdEfGhIjKlMnOpQrStUvWxYz0123456789+/AbCdEfGh',
  'fakeKeyBodyLineThreeAbCdEfGhIjKlMnOpQrStUvWxYz0123456789+/AbCdEf',
];
const DEPLOY_TOKEN = 'dT5fakeDeployValue8ZxCvBn';
const KEY = ['$ head -n 4 id_rsa', '-----BEGIN RSA PRIVATE KEY-----', ...BODY, '$ next step'];
const POD = ['$ kubectl get pod -o yaml', 'env:', '  - name: DEPLOY_TOKEN', `    value: ${DEPLOY_TOKEN}`, '  - name: REGION', '    value: eu-west-1'];
const JSONPOD = ['$ kubectl get pod -o json', '"env": [', '  {', '    "name": "DEPLOY_TOKEN",', `    "value": "${DEPLOY_TOKEN}"`, '  }', ']'];

const CASES: Array<{ name: string; text: string; secrets: string[] }> = [
  { name: 'F2: a key cut short of its END, CRLF lines', text: KEY.join('\r\n') + '\r\n', secrets: BODY },
  { name: 'F2: a key whose BEGIN line follows an OSC title', text: KEY.map((l) => (l.startsWith('-----BEGIN') ? `\x1b]0;ssh\x07${l}` : l)).join('\n') + '\n', secrets: BODY },
  { name: 'F2: a key whose BEGIN line is in truecolor', text: KEY.map((l) => (l.startsWith('-----BEGIN') ? `\x1b[38;2;200;100;50m${l}\x1b[0m` : l)).join('\n') + '\n', secrets: BODY },
  { name: 'F2: a key whose BEGIN line ends `\\x1b[0m\\x1b[K` and CRLF', text: KEY.map((l) => `${l}\x1b[0m\x1b[K`).join('\r\n') + '\r\n', secrets: BODY },
  { name: 'F2: a key under a numbered gutter, every line green', text: ['⏺ Read(id_rsa)', ...['-----BEGIN RSA PRIVATE KEY-----', ...BODY].map((l, i) => `${String(i + 9).padStart(6)}→\x1b[32m${l}\x1b[0m`), '⏺ next step', ''].join('\n'), secrets: BODY },
  { name: 'F2: a key under a `> ` quote', text: KEY.map((l) => `> ${l}`).join('\n') + '\n', secrets: BODY },
  { name: 'F3: YAML siblings under `> > `', text: POD.map((l) => `> > ${l}`).join('\n') + '\n', secrets: [DEPLOY_TOKEN] },
  { name: 'F3: YAML siblings under `>\\t`', text: POD.map((l) => `>\t${l}`).join('\n') + '\n', secrets: [DEPLOY_TOKEN] },
  { name: 'F3: YAML siblings under ` > `', text: POD.map((l) => ` > ${l}`).join('\n') + '\n', secrets: [DEPLOY_TOKEN] },
  { name: 'F3: YAML siblings under `>` (no space)', text: POD.map((l) => `>${l}`).join('\n') + '\n', secrets: [DEPLOY_TOKEN] },
  { name: 'F3: JSON siblings under `> `, CRLF', text: JSONPOD.map((l) => `> ${l}`).join('\r\n') + '\r\n', secrets: [DEPLOY_TOKEN] },
  { name: 'F3: YAML siblings under `> `, coloured names', text: POD.map((l) => `> ${l.replace(/(name|value):/, '\x1b[36m$1\x1b[0m:')}`).join('\n') + '\n', secrets: [DEPLOY_TOKEN] },
  { name: 'F3: YAML siblings under a numbered gutter', text: POD.map((l, i) => `${String(i + 9).padStart(6)}→${l}`).join('\n') + '\n', secrets: [DEPLOY_TOKEN] },
  { name: 'F3: gutter then `> `, YAML siblings', text: POD.map((l, i) => `${String(i + 9).padStart(6)}→> ${l}`).join('\n') + '\n', secrets: [DEPLOY_TOKEN] },
  { name: 'F3: JSON siblings under ` > `', text: JSONPOD.map((l) => ` > ${l}`).join('\n') + '\n', secrets: [DEPLOY_TOKEN] },
  { name: 'C1: a next-line value under ` > `', text: ['$ cat ci.yml', 'env:', '  DEPLOY_TOKEN:', `    ${DEPLOY_TOKEN}`, '  REGION: eu-west-1'].map((l) => ` > ${l}`).join('\n') + '\n', secrets: [DEPLOY_TOKEN] },
  { name: 'C1: a YAML block under ` > `', text: ['$ cat values.yaml', 'secrets:', '  SIGNING_SECRET: |', '    bL1fakeBlockLineOneQwErTyUi', '    bL2fakeBlockLineTwoAsDfGhJk', 'replicas: 2'].map((l) => ` > ${l}`).join('\n') + '\n', secrets: ['bL1fakeBlockLineOneQwErTyUi', 'bL2fakeBlockLineTwoAsDfGhJk'] },
  { name: 'F2: a key under a ` > ` quote', text: KEY.map((l) => ` > ${l}`).join('\n') + '\n', secrets: BODY },
];

function fakeSession() {
  const outputs: Array<(text: string) => void> = [];
  const session = {
    onOutput: (cb: (text: string) => void) => outputs.push(cb),
    onExit: () => {}, onEvent: () => {}, onTaskComplete: () => {}, onScriptExit: () => {},
  } as unknown as IRunnerSession;
  return { session, write: (text: string) => { for (const cb of outputs) cb(text); } };
}

describe.each(CASES)('bar80r2 (b): $name, cut at every offset', ({ text, secrets }) => {
  it('control: the whole text, redacted, shows none of it', () => {
    expect(anyShown(redactAgentText(text), secrets)).toBe(false);
  });

  it('the live buffer’s cut, in one chunk and a line a chunk', () => {
    for (const chunks of [[text], text.split(/(?<=\n)/)]) {
      for (let offset = 1; offset < text.length; offset++) {
        const source = new BufferedTaskOutputSource({ maxBufferChars: text.length - offset });
        const { session, write } = fakeSession();
        source.attach('t1', session);
        for (const chunk of chunks) write(chunk);
        expect({ offset, shown: anyShown(source.liveTail('t1', { maxLines: 1000 })?.text ?? '', secrets) }).toEqual({ offset, shown: false });
        expect({ offset, shown: anyShown(source.finalText('t1'), secrets) }).toEqual({ offset, shown: false });
      }
    }
  });

  it('a live read that resumes after each line', () => {
    for (let offset = 1; offset < text.length; offset++) {
      const source = new BufferedTaskOutputSource({ maxBufferChars: text.length - offset });
      const { session, write } = fakeSession();
      source.attach('t1', session);
      let read = '';
      let sinceOffset = 0;
      for (const chunk of text.split(/(?<=\n)/)) {
        write(chunk);
        const tail = source.liveTail('t1', { maxLines: 1000, sinceOffset });
        read += `${tail?.text ?? ''}\n`;
        sinceOffset = tail?.nextOffset ?? 0;
      }
      expect({ offset, shown: anyShown(read, secrets) }).toEqual({ offset, shown: false });
    }
  });

  it('an ended attempt’s 16k tail', () => {
    const ended = 16 * 1024;
    const filler = 'build output\n'.repeat(Math.ceil(ended / 13));
    for (let offset = 1; offset < text.length; offset++) {
      const after = filler.slice(0, ended - (text.length - offset));
      const source = new BufferedTaskOutputSource();
      const { session, write } = fakeSession();
      source.attach('t1', session);
      write(text);
      write(after.slice(0, after.lastIndexOf('\n') + 1));
      source.detach('t1');
      expect({ offset, shown: anyShown(source.liveTail('t1', { maxLines: 2000 })?.text ?? '', secrets) }).toEqual({ offset, shown: false });
      expect({ offset, shown: anyShown(source.finalText('t1'), secrets) }).toEqual({ offset, shown: false });
    }
  });

  it('a stderr LineTail’s cut, in one chunk and a line a chunk', () => {
    for (const chunks of [[text], text.split(/(?<=\n)/)]) {
      for (let offset = 1; offset < text.length; offset++) {
        const keepChars = text.length - offset;
        const tail = new LineTail({ keepChars, showChars: keepChars });
        for (const chunk of chunks) tail.append(chunk);
        expect({ offset, shown: anyShown(tail.read(redactAgentText), secrets) }).toEqual({ offset, shown: false });
      }
    }
  });
});

describe('bar80r2 (c): the controls are kept, the 64k inputs are under 1 s', () => {
  it('source mode keeps `password: passwordField`', () => {
    expect(redactSourceText('password: passwordField')).toBe('password: passwordField');
  });
  it.each(['password: required', 'apiKey: string,', 'Authorization: required'])('agent mode keeps `%s`', (control) => {
    expect(redactAgentText(control)).toBe(control);
  });
  const INPUTS: Array<{ name: string; text: string }> = [
    { name: '64k of `> ` quote lines under a name', text: '> - name: DEPLOY_TOKEN\n' + '> \n'.repeat(21_000) },
    { name: '64k of `> >` prefixes on one line', text: '- name: X\n' + '> '.repeat(32_000) },
    { name: 'a BEGIN line then 64k of escapes', text: '-----BEGIN RSA PRIVATE KEY-----' + '\x1b[0m'.repeat(16_000) },
    { name: 'a BEGIN line then 64k of OSC openers', text: '-----BEGIN RSA PRIVATE KEY-----\n' + '\x1b]0;'.repeat(16_000) },
    { name: '64k of BEGIN lines', text: '-----BEGIN RSA PRIVATE KEY-----\n'.repeat(2000) },
    { name: '64k of name lines, each with a quoted value below', text: '> - name: TOKEN_A\n>   value: x\n'.repeat(2100) },
  ];
  it.each(INPUTS)('$name, both modes and every cut site', ({ text }) => {
    for (const redact of [redactAgentText, redactSourceText]) {
      const started = performance.now();
      redact(text);
      expect(performance.now() - started).toBeLessThan(1000);
    }
    const started = performance.now();
    const source = new BufferedTaskOutputSource({ maxBufferChars: 4096 });
    const { session, write } = fakeSession();
    source.attach('t1', session);
    for (let at = 0; at < text.length; at += 4096) write(text.slice(at, at + 4096));
    source.liveTail('t1', { maxLines: 1000 });
    source.detach('t1');
    source.finalText('t1');
    const tail = new LineTail({ keepChars: 4096, showChars: 4096 });
    for (let at = 0; at < text.length; at += 4096) tail.append(text.slice(at, at + 4096));
    tail.read(redactAgentText);
    expect(performance.now() - started).toBeLessThan(1000);
  }, 120_000);
});

/**
 * The sibling search (siblingValue, redactSecrets.ts:794-811) measures the
 * name line's lead from the start of the line, gutter and all, and needs each
 * line after it padded as far. A numbered gutter pads its number to a width
 * (`     9→`, `    10→`): where the number gains a digit between the name and
 * its value, the value line is padded one less, and the search gives up. A
 * quote after the gutter (`    11→> `) is not the quote the line opens with,
 * so its `>` ends the search as an element's end. Whole text, no cut.
 */
const gutterRead = (lines: string[], from: number, after = '') => lines.map((l, i) => `${String(from + i).padStart(6)}→${after}${l}`).join('\n') + '\n';
const gutterCatN = (lines: string[], from: number) => lines.map((l, i) => `${String(from + i).padStart(6)}\t${l}`).join('\n') + '\n';
const YAML_ENTRY = ['  - name: DEPLOY_TOKEN', `    value: ${DEPLOY_TOKEN}`, '  - name: REGION', '    value: eu-west-1'];
const JSON_ENTRY = ['  {', '    "name": "DEPLOY_TOKEN",', `    "value": "${DEPLOY_TOKEN}"`, '  },'];
const XML_ENTRY = ['  <add key="DEPLOY_TOKEN"', `       value="${DEPLOY_TOKEN}" />`, '</appSettings>'];

describe('bar80r2 (b): a sibling value under a numbered gutter, whole text', () => {
  it('control: plain, each form is hidden', () => {
    for (const lines of [YAML_ENTRY, JSON_ENTRY, XML_ENTRY]) expect(shows(redactAgentText(lines.join('\n') + '\n'), DEPLOY_TOKEN), lines[1]).toBe(false);
  });
  it('control: the gutter’s number keeps its width (lines 11, 12), each form is hidden', () => {
    for (const lines of [YAML_ENTRY, JSON_ENTRY.slice(1), XML_ENTRY]) {
      expect(shows(redactAgentText(gutterRead(lines, 11)), DEPLOY_TOKEN), lines[0]).toBe(false);
      expect(shows(redactAgentText(gutterCatN(lines, 11)), DEPLOY_TOKEN), lines[0]).toBe(false);
    }
  });
  it.each([
    ['YAML `- name:` / `value:`, a file viewer’s gutter, lines 9 and 10', gutterRead(YAML_ENTRY, 9)],
    ['YAML `- name:` / `value:`, `cat -n`, lines 9 and 10', gutterCatN(YAML_ENTRY, 9)],
    ['YAML `- name:` / `value:`, a file viewer’s gutter, lines 99 and 100', gutterRead(YAML_ENTRY, 99)],
    ['JSON `"name"` / `"value"`, a file viewer’s gutter, lines 9 and 10', gutterRead(JSON_ENTRY.slice(1), 9)],
    ['XML `key=` / `value=`, a file viewer’s gutter, lines 9 and 10', gutterRead(XML_ENTRY, 9)],
  ])('%s: the value is hidden', (_name, text) => {
    expect(shows(redactAgentText(text), DEPLOY_TOKEN)).toBe(false);
  });
  it.each([
    ['YAML, a file viewer’s gutter then `> ` (lines 11, 12)', gutterRead(YAML_ENTRY, 11, '> ')],
    ['XML, a file viewer’s gutter then `> ` (lines 11, 12)', gutterRead(XML_ENTRY, 11, '> ')],
  ])('%s: the value is hidden', (_name, text) => {
    expect(shows(redactAgentText(text), DEPLOY_TOKEN)).toBe(false);
  });
});
