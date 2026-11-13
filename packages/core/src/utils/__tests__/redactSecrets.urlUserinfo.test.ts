import { describe, expect, it } from 'vitest';
import { redactAgentText, redactSourceText } from '../redactSecrets';

/** Every value is fake; the secrets are assembled at runtime so no literal credential sits in the source. */
const MODES: Array<[string, (text: string) => string]> = [
  ['source', redactSourceText],
  ['agent', redactAgentText],
];

describe.each(MODES)('URL userinfo password (%s mode)', (_name, redact) => {
  it('masks a password holding an @ up to the last @, leaving no tail behind', () => {
    const tail = ['2Secret', '99'].join('');
    const out = redact(`error: https://alice:Hunter@${tail}@github.com/x.git`);
    expect(out).not.toContain(tail);
    expect(out).not.toContain('Hunter');
    expect(out).toContain('@github.com/x.git');
    expect(out).toContain('https://alice:');
  });

  it('masks a password holding several @', () => {
    const out = redact(`git clone https://bob:${['a@b', 'c@d'].join('')}@host.example/r.git`);
    expect(out).not.toMatch(/a@bc@d|c@d/);
    expect(out).toContain('@host.example/r.git');
  });

  it('does not take the @ of a later email in the same JSON for a userinfo', () => {
    const json = '{"url":"http://localhost:8080","email":"bob@example.com"}';
    expect(redact(json)).toBe(json);
  });

  it('stops at a quote, a backtick and angle brackets', () => {
    for (const text of [
      "['http://localhost:8080','bob@example.com']",
      '`http://localhost:8080`,`bob@example.com`',
      '<http://localhost:8080>,<bob@example.com>',
    ]) {
      expect(redact(text)).toBe(text);
    }
  });

  it('still masks a plain password and keeps the host', () => {
    const out = redact(`postgres://app:${['s3cr', 'etPw'].join('')}@db.internal:5432/app`);
    expect(out).not.toContain('s3cretPw');
    expect(out).toContain('postgres://app:');
    expect(out).toContain('@db.internal:5432/app');
  });

  it('still masks a password holding a comma', () => {
    const out = redact(`redis://u:${['ab', 'cd'].join(',')}@cache:6379`);
    expect(out).not.toContain('ab,cd');
    expect(out).toContain('@cache:6379');
  });

  it('leaves a placeholder alone', () => {
    const text = 'postgres://app:${DB_PASS}@db.internal/app';
    expect(redact(text)).toBe(text);
  });
});

describe('URL userinfo stays linear on 64k of one motif', () => {
  const N = 64 * 1024;
  const fill = (motif: string) => motif.repeat(Math.ceil(N / motif.length)).slice(0, N);
  const ms = (run: () => void) => {
    const started = performance.now();
    run();
    return performance.now() - started;
  };
  const MOTIFS = ['://a:', '://a:b@', ':@', '://a:@@', 'x://a:b@c ', '://a:b:', '://:', '@://a:b'];
  for (const motif of MOTIFS) {
    const text = fill(motif);
    for (const [name, redact] of MODES) {
      it(`${motif} in ${name} mode`, () => {
        expect(ms(() => redact(text))).toBeLessThan(1000);
      });
    }
  }
  it('a long password run with no closing @ in both modes', () => {
    const text = `://a:${'p@ss'.repeat(N / 4)}`;
    for (const [, redact] of MODES) expect(ms(() => redact(text))).toBeLessThan(1000);
    const unclosed = `://a:${'x'.repeat(N)}`;
    for (const [, redact] of MODES) expect(ms(() => redact(unclosed))).toBeLessThan(1000);
  });
});
