import { describe, it, expect } from 'vitest';
import { loadedSkillTokens, skillTokens } from '../skillTokens';

describe('skillTokens', () => {
  it('finds the first token per name, spanning the slash and name but not trailing punctuation', () => {
    const text = '/Grilling this, then /to-spec, and /grilling again';
    expect(skillTokens(text)).toEqual([
      { name: 'grilling', start: 0, end: 9 },
      { name: 'to-spec', start: 21, end: 29 },
    ]);
    expect(text.slice(21, 29)).toBe('/to-spec');
  });

  it('ignores a slash inside a word', () => {
    expect(skillTokens('see src/grilling and a/b')).toEqual([]);
  });
});

describe('loadedSkillTokens', () => {
  it('keeps only the tokens that loaded a skill', () => {
    expect(loadedSkillTokens('/grilling and /nope', ['grilling']).map((t) => t.name)).toEqual(['grilling']);
  });
});
