import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseCsv } from '../src/csv.mjs';

describe('parseCsv', () => {
  it('splits records and fields', () => {
    assert.deepEqual(parseCsv('a,b\nc,d'), [['a', 'b'], ['c', 'd']]);
    assert.deepEqual(parseCsv('a,b\r\nc,d\r\n'), [['a', 'b'], ['c', 'd']]);
  });

  it('keeps a comma, a line break and a doubled quote inside quotes', () => {
    assert.deepEqual(parseCsv('a,"b,c"\n"say ""hi""",d'), [['a', 'b,c'], ['say "hi"', 'd']]);
    assert.deepEqual(parseCsv('"two\nlines",x'), [['two\nlines', 'x']]);
  });

  it('skips empty lines and trims nothing', () => {
    assert.deepEqual(parseCsv('\n a , b \n\n'), [[' a ', ' b ']]);
    assert.deepEqual(parseCsv(''), []);
    assert.deepEqual(parseCsv('a,,b'), [['a', '', 'b']]);
  });

  it('refuses a quoted field left open', () => {
    assert.throws(() => parseCsv('a,"b'), SyntaxError);
  });
});
