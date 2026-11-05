import { describe, expect, it } from 'vitest';
import type { IRunnerSession } from '../../interfaces/IRunner';
import { BufferedTaskOutputSource } from '../BufferedTaskOutputSource';
import { LineTail } from '../../utils/lineTail';
import { redactAgentText } from '../../utils/redactSecrets';

/**
 * A rule that hides a secret in the whole text hides it in what any cut
 * keeps (ADR-0061, C1). Each case here is redacted whole first, as the
 * control; then the cut is moved over every offset of the text, at each cut
 * site that bounds runner output, and nothing of the secret may show. Every
 * value is fake.
 */
const shows = (text: string, secret: string) =>
  Array.from({ length: secret.length - 7 }, (_, i) => secret.slice(i, i + 8)).some((piece) => text.includes(piece));

const BODY = [
  'MIIEowIBAAKCAQEAfakeKeyBodyLineOneAbCdEfGhIjKlMnOpQrStUvWxYz0123',
  'fakeKeyBodyLineTwoAbCdEfGhIjKlMnOpQrStUvWxYz0123456789+/AbCdEfGh',
  'fakeKeyBodyLineThreeAbCdEfGhIjKlMnOpQrStUvWxYz0123456789+/AbCdEf',
];
const DB_PASSWORD = 'Zq8fakeDbValue77WmPx';
const CLIENT_SECRET = 'cS3fakeClientValue9QwErTy';
const DEPLOY_TOKEN = 'dT5fakeDeployValue8ZxCvBn';
const BLOCK = ['bL1fakeBlockLineOneQwErTyUi', 'bL2fakeBlockLineTwoAsDfGhJk'];

const CASES: Array<{ name: string; text: string; secrets: string[] }> = [
  {
    name: 'a key cut short of its END',
    text: ['$ head -n 4 id_rsa', '-----BEGIN RSA PRIVATE KEY-----', ...BODY, '$ next step', ''].join('\n'),
    secrets: BODY,
  },
  {
    name: 'a whole key',
    text: ['$ cat id_rsa', '-----BEGIN RSA PRIVATE KEY-----', ...BODY, '-----END RSA PRIVATE KEY-----', 'done', ''].join('\n'),
    secrets: BODY,
  },
  {
    name: 'a key numbered as a file viewer shows it, cut short of its END',
    text: [
      '⏺ Read(id_rsa)',
      ...['-----BEGIN RSA PRIVATE KEY-----', ...BODY].map((line, i) => `${String(i + 9).padStart(6)}→${line}`),
      '⏺ next step',
      '',
    ].join('\n'),
    secrets: BODY,
  },
  {
    name: 'a dotenv credential',
    text: ['$ cat .env', 'NODE_ENV=production', `DB_PASSWORD=${DB_PASSWORD}`, 'PORT=8080', ''].join('\n'),
    secrets: [DB_PASSWORD],
  },
  {
    name: 'a JSON credential',
    text: ['$ cat config.json', '{', `  "client_secret": "${CLIENT_SECRET}",`, '  "region": "eu-west-1"', '}', ''].join('\n'),
    secrets: [CLIENT_SECRET],
  },
  {
    name: 'a YAML block scalar under a credential name',
    text: ['$ cat values.yaml', 'secrets:', '  SIGNING_SECRET: |', ...BLOCK.map((line) => `    ${line}`), 'replicas: 2', ''].join('\n'),
    secrets: BLOCK,
  },
  {
    name: 'a credential on the line below its name',
    text: ['$ cat ci.yml', 'env:', '  DEPLOY_TOKEN:', `    ${DEPLOY_TOKEN}`, '  REGION: eu-west-1', ''].join('\n'),
    secrets: [DEPLOY_TOKEN],
  },
  {
    name: 'a credential named by a sibling field',
    text: ['$ kubectl get pod -o yaml', 'env:', '  - name: DEPLOY_TOKEN', `    value: ${DEPLOY_TOKEN}`, '  - name: REGION', '    value: eu-west-1', ''].join('\n'),
    secrets: [DEPLOY_TOKEN],
  },
];

const anyShown = (text: string, secrets: string[]) => secrets.some((secret) => shows(text, secret));

function fakeSession() {
  const outputs: Array<(text: string) => void> = [];
  const session = {
    onOutput: (cb: (text: string) => void) => outputs.push(cb),
    onExit: () => {}, onEvent: () => {}, onTaskComplete: () => {}, onScriptExit: () => {},
  } as unknown as IRunnerSession;
  return { session, write: (text: string) => { for (const cb of outputs) cb(text); } };
}

/** The text in one chunk, then one chunk a line: the cut runs after each append. */
const CHUNKINGS: Array<{ name: string; split: (text: string) => string[] }> = [
  { name: 'in one chunk', split: (text) => [text] },
  { name: 'a line a chunk', split: (text) => text.split(/(?<=\n)/) },
];

describe.each(CASES)('$name, cut at every offset', ({ text, secrets }) => {
  it('control: the whole text, redacted, shows none of it', () => {
    expect(anyShown(redactAgentText(text), secrets)).toBe(false);
  });

  it.each(CHUNKINGS)('the live buffer’s cut, $name', ({ split }) => {
    for (let offset = 1; offset < text.length; offset++) {
      const source = new BufferedTaskOutputSource({ maxBufferChars: text.length - offset });
      const { session, write } = fakeSession();
      source.attach('t1', session);
      for (const chunk of split(text)) write(chunk);
      const tail = source.liveTail('t1', { maxLines: 1000 })?.text ?? '';
      expect({ offset, shown: anyShown(tail, secrets) }).toEqual({ offset, shown: false });
      expect({ offset, shown: anyShown(source.finalText('t1'), secrets) }).toEqual({ offset, shown: false });
    }
  });

  it('a live read that resumes after each chunk', () => {
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

  it('an ended attempt’s tail', () => {
    const ended = 16 * 1024;
    const filler = `${'build output\n'.repeat(Math.ceil(ended / 13))}`;
    for (let offset = 1; offset < text.length; offset++) {
      // The ended tail keeps the newest 16k: the filler after the case sets where in the case its cut falls.
      const after = filler.slice(0, ended - (text.length - offset));
      const source = new BufferedTaskOutputSource();
      const { session, write } = fakeSession();
      source.attach('t1', session);
      write(text);
      write(after.slice(0, after.lastIndexOf('\n') + 1));
      source.detach('t1');
      const tail = source.liveTail('t1', { maxLines: 2000 })?.text ?? '';
      expect({ offset, shown: anyShown(tail, secrets) }).toEqual({ offset, shown: false });
      expect({ offset, shown: anyShown(source.finalText('t1'), secrets) }).toEqual({ offset, shown: false });
    }
  });

  it.each(CHUNKINGS)('a stderr tail’s cut, $name', ({ split }) => {
    for (let offset = 1; offset < text.length; offset++) {
      const keepChars = text.length - offset;
      const tail = new LineTail({ keepChars, showChars: keepChars });
      for (const chunk of split(text)) tail.append(chunk);
      expect({ offset, shown: anyShown(tail.read(redactAgentText), secrets) }).toEqual({ offset, shown: false });
    }
  });
});
