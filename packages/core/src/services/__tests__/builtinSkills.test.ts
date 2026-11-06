import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { builtinSkillsDir } from '../builtinSkills';
import { fakeSea } from '../../testing';

describe('builtinSkillsDir', () => {
  let dataDir: string;
  beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), 'ordewell-builtin-skills-')); });
  afterEach(() => { rmSync(dataDir, { recursive: true, force: true }); });

  it('is the skills folder beside the module\'s own folder outside a binary', () => {
    const dir = builtinSkillsDir({ sea: null });
    // One level up from the module: the package root from dist/, src/ when run from source.
    expect(resolve(dir)).toBe(resolve(__dirname, '..', '..', 'skills'));
    expect(builtinSkillsDir()).toBe(dir);
  });

  it('is the extracted skills folder inside a binary', () => {
    const sea = fakeSea('7.0.0', { 'skills/tdd/SKILL.md': '# tdd from the binary\n' });
    const dir = builtinSkillsDir({ sea, dataDir });
    expect(dir).toBe(join(dataDir, 'runtime', '7.0.0', 'skills'));
    expect(readFileSync(join(dir, 'tdd', 'SKILL.md'), 'utf8')).toBe('# tdd from the binary\n');
  });
});
