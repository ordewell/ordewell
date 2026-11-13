import { describe, expect, it } from 'vitest';
import { redactAgentText, redactSourceText } from '../redactSecrets';

/**
 * Task #28 round 1: a 64k line of one repeated motif finishes under ADR-0061's
 * one second in both modes, and a URL's userinfo password is masked. Every value
 * is fake.
 */
const N = 64 * 1024;
const fill = (motif: string) => motif.repeat(Math.ceil(N / motif.length)).slice(0, N);
const ms = (run: () => void) => {
  const started = performance.now();
  run();
  return performance.now() - started;
};

describe('64k of one motif redacts in under a second', () => {
  const MOTIFS: Array<[string, string]> = [
    ['F1: _eyJ', '_eyJ'],
    ['F1: -eyJ', '-eyJ'],
    ['F2: token:/', 'token:/'],
    ['F2: /secret:', '/secret:'],
    ['F2: token->/', 'token->/'],
    ['F2: password:/', 'password:/'],
    ['F2: aAPI_KEY->$', 'aAPI_KEY->$'],
    ['F3: /ENV ', '/ENV '],
    ['F3: set NAME ', 'set TOKEN '],
  ];
  for (const [name, motif] of MOTIFS) {
    const text = fill(motif);
    it(`${name} in source mode`, () => {
      expect(ms(() => redactSourceText(text))).toBeLessThan(1000);
    });
    it(`${name} in agent mode`, () => {
      expect(ms(() => redactAgentText(text))).toBeLessThan(1000);
    });
  }

  it('still redacts a JWT that follows an underscore-joined run', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmYWtlVXNlciJ9.fakeSignature123456';
    for (const redact of [redactSourceText, redactAgentText]) {
      expect(redact(`x ${jwt} y`)).not.toContain('fakeSignature123456');
      expect(redact(`${fill('_eyJ').slice(0, 2000)} ${jwt}`)).not.toContain('fakeSignature123456');
    }
  });

  it('masks the same JWTs the three-segment pattern did, on random chains', () => {
    const OLD = /(?<![A-Za-z0-9])eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;
    const PIECES = ['eyJ', 'eyJabcdefgh', 'ab', 'Z9', '_', '-', '.', '.', ' ', 'x'];
    let seed = 7;
    const next = (n: number) => (seed = (seed * 1103515245 + 12345) % 2147483648) % n;
    for (let i = 0; i < 3000; i++) {
      const text = Array.from({ length: 4 + next(14) }, () => PIECES[next(PIECES.length)]).join('');
      const expected = text.replace(OLD, (hit) => `[${hit.length}]`);
      const got = redactSourceText(text).replace(/\[REDACTED api key: (\d+) chars\]/g, '[$1]');
      expect(got).toBe(expected);
    }
  });

  it('still redacts a value after a credential name past a long path-like run', () => {
    const out = redactAgentText(`${fill('token:/').slice(0, 5000)}\nDB_PASSWORD=fakeHunter2Secret99`);
    expect(out).not.toContain('fakeHunter2Secret99');
  });
});

describe('F4: a URL userinfo password', () => {
  const CASES: Array<[string, string, string]> = [
    ['https', 'fatal: could not read from https://alice:Hunter2Secret99@git.example.com/repo.git', 'Hunter2Secret99'],
    ['postgres', 'postgres://admin:S3cretPassw0rd@db.internal:5432/app', 'S3cretPassw0rd'],
    ['scheme with +', 'jdbc+mysql://root:r00tFakePass!@10.0.0.1/db', 'r00tFakePass'],
    ['percent-encoded', 'redis://default:p%40ssFake99@cache:6379', 'p%40ssFake99'],
  ];
  for (const [name, text, secret] of CASES) {
    for (const [mode, redact] of [['source', redactSourceText], ['agent', redactAgentText]] as const) {
      it(`${name} in ${mode} mode`, () => {
        const out = redact(text);
        expect(out).not.toContain(secret);
        expect(out).toMatch(/@/);
      });
    }
  }

  it('keeps the user and host readable', () => {
    const out = redactAgentText('git clone https://alice:Hunter2Secret99@git.example.com/repo.git');
    expect(out).toContain('alice');
    expect(out).toContain('@git.example.com/repo.git');
  });

  it('leaves a URL without a password, and a port, alone', () => {
    const text = 'see https://git.example.com:8443/repo.git and ssh://git@host/x and mailto:a@b.c at http://localhost:3000/a@b';
    expect(redactAgentText(text)).toBe(text);
    expect(redactSourceText(text)).toBe(text);
  });

  it('finishes quickly on a long run of scheme-like text', () => {
    expect(ms(() => redactAgentText(fill('a:/b://c:d'))) ).toBeLessThan(1000);
    expect(ms(() => redactSourceText(fill('://:@'))) ).toBeLessThan(1000);
    expect(ms(() => redactSourceText(fill('a://u:'))) ).toBeLessThan(1000);
  });
});
