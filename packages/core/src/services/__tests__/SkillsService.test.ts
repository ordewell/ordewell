import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createSkillsService } from '../SkillsService';

let home = '';
let workspaceRoot = '';

const h = vi.hoisted(() => ({ builtinDir: '' }));

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => home };
});

vi.mock('../builtinSkills', () => ({
  builtinSkillsDir: () => h.builtinDir,
}));

function writeSkill(sourceDir: string, name: string, frontmatter: Record<string, unknown>, body: string): string {
  const dir = path.join(sourceDir, name);
  fs.mkdirSync(dir, { recursive: true });
  const fm = Object.entries(frontmatter)
    .map(([k, v]) => `${k}: ${typeof v === 'string' ? JSON.stringify(v) : v}`)
    .join('\n');
  const file = path.join(dir, 'SKILL.md');
  fs.writeFileSync(file, `---\n${fm}\n---\n\n${body}`);
  return file;
}

function builtinFixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-builtin-'));
  writeSkill(dir, 'grilling', { name: 'grilling', description: 'Builtin G' }, 'Builtin grilling body.');
  writeSkill(dir, 'to-spec', { name: 'to-spec', description: 'Builtin S' }, 'Builtin spec body.');
  writeSkill(dir, 'improve-codebase-architecture', { name: 'improve-codebase-architecture', description: 'Builtin A' }, 'Builtin architecture body.');
  return dir;
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-skills-global-'));
  workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-skills-local-'));
  h.builtinDir = builtinFixture();
});

describe('SkillsService', () => {
  describe('findSkill', () => {
    it('finds a skill from the global dir (~/.ordewell/skills)', () => {
      writeSkill(path.join(home, '.ordewell', 'skills'), 'grilling', {
        name: 'grilling',
        description: 'Stress-test a plan',
        'disable-model-invocation': true,
      }, '# Grilling\n\nSome body.');
      const svc = createSkillsService(workspaceRoot);
      const skill = svc.findSkill('grilling');
      expect(skill).toBeDefined();
      expect(skill!.name).toBe('grilling');
      expect(skill!.description).toBe('Stress-test a plan');
      expect(skill!.source).toBe('global');
    });

    it('local .ordewell/skills overrides a global skill with the same name', () => {
      writeSkill(path.join(home, '.ordewell', 'skills'), 'grilling', {
        name: 'grilling',
        description: 'Global',
      }, 'Global body.');
      writeSkill(path.join(workspaceRoot, '.ordewell', 'skills'), 'grilling', {
        name: 'grilling',
        description: 'Local',
      }, 'Local body.');
      const svc = createSkillsService(workspaceRoot);
      const skill = svc.findSkill('grilling');
      expect(skill).toBeDefined();
      expect(skill!.description).toBe('Local');
      expect(skill!.source).toBe('local');
      expect(skill!.content).toBe('Local body.');
    });

    it('returns undefined for a missing skill', () => {
      writeSkill(path.join(home, '.ordewell', 'skills'), 'grilling', {
        name: 'grilling',
      }, 'Body.');
      const svc = createSkillsService(workspaceRoot);
      expect(svc.findSkill('nope')).toBeUndefined();
    });

    it('parses disable-model-invocation as a boolean', () => {
      writeSkill(path.join(home, '.ordewell', 'skills'), 'to-spec', {
        name: 'to-spec',
        description: 'Spec',
        'disable-model-invocation': true,
      }, 'Body.');
      const svc = createSkillsService(workspaceRoot);
      expect(svc.findSkill('to-spec')!.metadata.disableModelInvocation).toBe(true);
    });
  });

  describe('listSkills', () => {
    it('lists skills from both global and local dirs', () => {
      writeSkill(path.join(home, '.ordewell', 'skills'), 'grilling', { name: 'grilling', description: 'G' }, 'Global.');
      writeSkill(path.join(home, '.ordewell', 'skills'), 'to-spec', { name: 'to-spec', description: 'S' }, 'Global spec.');
      writeSkill(path.join(workspaceRoot, '.ordewell', 'skills'), 'local-only', { name: 'local-only', description: 'L' }, 'Local.');
      const svc = createSkillsService(workspaceRoot);
      const names = svc.listSkills().map((s) => s.name).sort();
      expect(names).toEqual(['grilling', 'improve-codebase-architecture', 'local-only', 'to-spec']);
    });

    it('seeds built-in skills into the global dir when no user skills exist', () => {
      const svc = createSkillsService(workspaceRoot);
      const names = svc.listSkills().map((s) => s.name).sort();
      expect(names).toEqual(['grilling', 'improve-codebase-architecture', 'to-spec']);
    });

    it('prunes a stale grill-me seed left by an older build', () => {
      writeSkill(path.join(home, '.ordewell', 'skills'), 'grill-me', {
        name: 'grill-me',
        description: 'Old builtin',
      }, 'Old grill-me body.');
      const svc = createSkillsService(workspaceRoot);
      const names = svc.listSkills().map((s) => s.name).sort();
      expect(names).toEqual(['grilling', 'improve-codebase-architecture', 'to-spec']);
      expect(fs.existsSync(path.join(home, '.ordewell', 'skills', 'grill-me'))).toBe(false);
    });

    it('preserves a user-authored grill-me with a different frontmatter name', () => {
      writeSkill(path.join(home, '.ordewell', 'skills'), 'grill-me', {
        name: 'my-custom-skill',
        description: 'User owned',
      }, 'Custom body.');
      const svc = createSkillsService(workspaceRoot);
      const skills = svc.listSkills();
      const grillMe = skills.find((s) => s.name === 'grill-me');
      expect(grillMe).toBeDefined();
      expect(grillMe!.metadata.name).toBe('my-custom-skill');
      expect(fs.existsSync(path.join(home, '.ordewell', 'skills', 'grill-me', 'SKILL.md'))).toBe(true);
    });

    it('preserves a grill-me directory containing extra files', () => {
      const dir = path.join(home, '.ordewell', 'skills', 'grill-me');
      writeSkill(path.join(home, '.ordewell', 'skills'), 'grill-me', {
        name: 'grill-me',
        description: 'Old builtin',
      }, 'Old grill-me body.');
      fs.writeFileSync(path.join(dir, 'notes.txt'), 'user notes');
      const svc = createSkillsService(workspaceRoot);
      svc.listSkills();
      expect(fs.existsSync(path.join(dir, 'SKILL.md'))).toBe(true);
      expect(fs.existsSync(path.join(dir, 'notes.txt'))).toBe(true);
    });

    it('never removes an unrelated user skill', () => {
      writeSkill(path.join(home, '.ordewell', 'skills'), 'my-skill', {
        name: 'my-skill',
        description: 'Mine',
      }, 'My body.');
      const svc = createSkillsService(workspaceRoot);
      const names = svc.listSkills().map((s) => s.name).sort();
      expect(names).toEqual(['grilling', 'improve-codebase-architecture', 'my-skill', 'to-spec']);
    });

    it('does not prune a retired-name skill vendored locally', () => {
      writeSkill(path.join(workspaceRoot, '.ordewell', 'skills'), 'grill-me', {
        name: 'grill-me',
        description: 'Vendored locally',
      }, 'Local body.');
      const svc = createSkillsService(workspaceRoot);
      const names = svc.listSkills().map((s) => s.name).sort();
      expect(names).toContain('grill-me');
      expect(fs.existsSync(path.join(workspaceRoot, '.ordewell', 'skills', 'grill-me', 'SKILL.md'))).toBe(true);
    });
  });

  describe('seedBuiltinSkill', () => {
    it('copies a built-in skill into the global dir and returns true', () => {
      const svc = createSkillsService(workspaceRoot);
      expect(svc.seedBuiltinSkill('grilling')).toBe(true);
      const dest = path.join(home, '.ordewell', 'skills', 'grilling', 'SKILL.md');
      expect(fs.existsSync(dest)).toBe(true);
      expect(fs.readFileSync(dest, 'utf8')).toContain('Builtin grilling body.');
      const skill = svc.findSkill('grilling');
      expect(skill).toBeDefined();
      expect(skill!.source).toBe('global');
    });

    it('does not overwrite an already-existing skill', () => {
      const customFile = writeSkill(path.join(home, '.ordewell', 'skills'), 'grilling', {
        name: 'grilling',
        description: 'Custom',
      }, 'Custom body.');
      const before = fs.readFileSync(customFile, 'utf8');
      const svc = createSkillsService(workspaceRoot);
      expect(svc.seedBuiltinSkill('grilling')).toBe(false);
      expect(fs.readFileSync(customFile, 'utf8')).toBe(before);
    });

    it('returns false without crashing when the package skills dir is missing', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      h.builtinDir = path.join(os.tmpdir(), 'ordewell-missing-' + Date.now());
      const svc = createSkillsService(workspaceRoot);
      expect(svc.seedBuiltinSkill('grilling')).toBe(false);
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
    });
  });

  describe('getSkillContent', () => {
    it('returns the body with frontmatter stripped', () => {
      writeSkill(path.join(home, '.ordewell', 'skills'), 'grilling', {
        name: 'grilling',
        description: 'G',
      }, '# Grilling\n\nIntro paragraph.\n\n## Section\n\nMore.');
      const svc = createSkillsService(workspaceRoot);
      expect(svc.getSkillContent('grilling')).toBe('# Grilling\n\nIntro paragraph.\n\n## Section\n\nMore.');
    });

    it('returns undefined for a missing skill', () => {
      const svc = createSkillsService(workspaceRoot);
      expect(svc.getSkillContent('nope')).toBeUndefined();
    });
  });
});
