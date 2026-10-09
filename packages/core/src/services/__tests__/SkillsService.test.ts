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

// Verbatim pre-fix built-in (db4dc59): its hash is in PRIOR_BUILTIN_HASHES.
const LEGACY_GRILLING = `---
name: grilling
description: Grill the user relentlessly about a plan, decision, or idea. Use when the user wants to stress-test their thinking, or uses any 'grill' trigger phrases.
disable-model-invocation: true
---

Interview the user relentlessly until you reach a shared understanding. Map this as a **design tree**: every decision branches into the decisions that hang off it.

Work the tree in **rounds**. The **frontier** is every decision whose prerequisites are already settled: the questions you can ask _now_ without guessing at answers you haven't heard yet. Ask the whole frontier in one round: number each question and give your recommended answer. Then wait for the user's answers before the next round.

Format a round like so:


❓ **Q1** - **<question title>**: <question body, might be multiple paragraphs, including multiple choices>

➡️ <your recommended answer>

---

❓ **Q2** - **<question title>**: <question body, might be multiple paragraphs, including multiple choices>

➡️ <your recommended answer>


Each round the user answers reshapes the tree: settled decisions push the frontier outward and unblock questions that depended on them. Recompute the frontier and ask the next round. A question whose answer depends on another question still open in this round belongs to a _later_ round, not this one.

Finding _facts_ is your job, never the user's. When a frontier question needs a fact from the environment, explore the workspace yourself with your own read-only tools, and, where a research subagent is available to you, delegate exploration to it instead of reading everything inline. Don't block on it: a running exploration is an unsettled prerequisite, so only the questions downstream of it wait for it to report back; ask the rest of the frontier now. The _decisions_ are the user's — put each to them and wait.

The goal is a shared understanding sharp enough to decompose into independently demoable slices: questions about slice boundaries, dependencies between slices, and what's out of scope are legitimate branches of the design tree, not distractions from it.

The session is done when the frontier is empty: every branch of the design tree visited, nothing left silently assumed. An empty frontier doesn't end the session — it means you now propose a prose outline of vertical tracer-bullet slices, the same outline-before-JSON step you'd reach at the end of any research phase. Do not emit the task plan JSON until the user has confirmed that outline.
`;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-skills-global-'));
  workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-skills-workspace-'));
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

    it('a global skill wins over a workspace skill with the same name', () => {
      writeSkill(path.join(home, '.ordewell', 'skills'), 'grilling', {
        name: 'grilling',
        description: 'Global',
      }, 'Global body.');
      writeSkill(path.join(workspaceRoot, '.ordewell', 'skills'), 'grilling', {
        name: 'grilling',
        description: 'Workspace',
      }, 'Workspace body.');
      const svc = createSkillsService(workspaceRoot);
      const skill = svc.findSkill('grilling');
      expect(skill).toBeDefined();
      expect(skill!.description).toBe('Global');
      expect(skill!.source).toBe('global');
      expect(skill!.content).toBe('Global body.');
    });

    it('finds a workspace-only skill', () => {
      writeSkill(path.join(workspaceRoot, '.ordewell', 'skills'), 'mine', { name: 'mine' }, 'Mine.');
      const skill = createSkillsService(workspaceRoot).findSkill('mine');
      expect(skill!.source).toBe('workspace');
      expect(skill!.content).toBe('Mine.');
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

  describe('frontmatter', () => {
    const find = (fm: Record<string, unknown>) => {
      writeSkill(path.join(workspaceRoot, '.ordewell', 'skills'), 'probe', { name: 'probe', ...fm }, 'Body.');
      return createSkillsService(workspaceRoot).findSkill('probe')!;
    };

    it('defaults to a planner skill both the user and the model may invoke', () => {
      const skill = find({});
      expect(skill.appliesTo).toBe('planner');
      expect(skill.modelInvocable).toBe(true);
      expect(skill.userInvocable).toBe(true);
    });

    it('reads applies-to: task', () => {
      expect(find({ 'applies-to': 'task' }).appliesTo).toBe('task');
      expect(find({ 'applies-to': 'planner' }).appliesTo).toBe('planner');
    });

    it('treats an unknown applies-to as planner', () => {
      expect(find({ 'applies-to': 'everything' }).appliesTo).toBe('planner');
    });

    it('disable-model-invocation: true makes a skill user-only', () => {
      const skill = find({ 'disable-model-invocation': true });
      expect(skill.modelInvocable).toBe(false);
      expect(skill.userInvocable).toBe(true);
    });

    it('user-invocable: false makes a skill model-only', () => {
      const skill = find({ 'user-invocable': false });
      expect(skill.userInvocable).toBe(false);
      expect(skill.modelInvocable).toBe(true);
    });

    it('accepts quoted values', () => {
      const skill = find({ 'applies-to': 'task', 'user-invocable': 'false' });
      expect(skill.appliesTo).toBe('task');
      expect(skill.userInvocable).toBe(false);
    });
  });

  describe('listSkills', () => {
    it('lists skills from both global and workspace dirs', () => {
      writeSkill(path.join(home, '.ordewell', 'skills'), 'grilling', { name: 'grilling', description: 'G' }, 'Global.');
      writeSkill(path.join(home, '.ordewell', 'skills'), 'to-spec', { name: 'to-spec', description: 'S' }, 'Global spec.');
      writeSkill(path.join(workspaceRoot, '.ordewell', 'skills'), 'workspace-only', { name: 'workspace-only', description: 'W' }, 'Workspace.');
      const svc = createSkillsService(workspaceRoot);
      const names = svc.listSkills().map((s) => s.name).sort();
      expect(names).toEqual(['grilling', 'improve-codebase-architecture', 'to-spec', 'workspace-only']);
    });

    it('skips a workspace skill a global one shadows and reports it', () => {
      const globalFile = writeSkill(path.join(home, '.ordewell', 'skills'), 'mine', { name: 'mine', description: 'Global' }, 'Global.');
      const workspaceFile = writeSkill(path.join(workspaceRoot, '.ordewell', 'skills'), 'mine', { name: 'mine', description: 'Workspace' }, 'Workspace.');
      const svc = createSkillsService(workspaceRoot);
      const mine = svc.listSkills().filter((s) => s.name === 'mine');
      expect(mine.map((s) => [s.source, s.path])).toEqual([['global', globalFile]]);
      const shadowed = svc.listShadowed();
      expect(shadowed.map((s) => [s.skill.name, s.skill.source, s.skill.path, s.shadowedBy.path])).toEqual([
        ['mine', 'workspace', workspaceFile, globalFile],
      ]);
    });

    it('a workspace copy of a built-in is shadowed by the seeded global one', () => {
      writeSkill(path.join(workspaceRoot, '.ordewell', 'skills'), 'grilling', { name: 'grilling', description: 'Vendored' }, 'Vendored.');
      const svc = createSkillsService(workspaceRoot);
      expect(svc.listSkills().find((s) => s.name === 'grilling')!.source).toBe('global');
      expect(svc.listShadowed().map((s) => s.skill.name)).toEqual(['grilling']);
    });

    it('reports nothing shadowed without a clash', () => {
      writeSkill(path.join(workspaceRoot, '.ordewell', 'skills'), 'mine', { name: 'mine' }, 'Mine.');
      expect(createSkillsService(workspaceRoot).listShadowed()).toEqual([]);
      expect(createSkillsService().listShadowed()).toEqual([]);
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

    it('does not prune a retired-name skill vendored in the workspace', () => {
      writeSkill(path.join(workspaceRoot, '.ordewell', 'skills'), 'grill-me', {
        name: 'grill-me',
        description: 'Vendored in the workspace',
      }, 'Workspace body.');
      const svc = createSkillsService(workspaceRoot);
      const names = svc.listSkills().map((s) => s.name).sort();
      expect(names).toContain('grill-me');
      expect(fs.existsSync(path.join(workspaceRoot, '.ordewell', 'skills', 'grill-me', 'SKILL.md'))).toBe(true);
    });
  });

  describe('forRoot', () => {
    it('reads workspace skills from the given root, keeping the global ones', () => {
      const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-skills-worktree-'));
      writeSkill(path.join(home, '.ordewell', 'skills'), 'shared', { name: 'shared' }, 'Global.');
      writeSkill(path.join(workspaceRoot, '.ordewell', 'skills'), 'main-only', { name: 'main-only' }, 'Main.');
      const worktreeFile = writeSkill(path.join(worktree, '.ordewell', 'skills'), 'task-only', { name: 'task-only', 'applies-to': 'task' }, 'Task.');
      writeSkill(path.join(worktree, '.ordewell', 'skills'), 'shared', { name: 'shared' }, 'Shadowed.');

      const scoped = createSkillsService(workspaceRoot).forRoot(worktree);
      const names = scoped.listSkills().map((s) => s.name);
      expect(names).toContain('task-only');
      expect(names).toContain('shared');
      expect(names).not.toContain('main-only');
      expect(scoped.findSkill('task-only')!.path).toBe(worktreeFile);
      expect(scoped.findSkill('task-only')!.appliesTo).toBe('task');
      expect(scoped.findSkill('main-only')).toBeUndefined();
      expect(scoped.findSkill('shared')!.content).toBe('Global.');
      expect(scoped.listShadowed().map((s) => s.skill.name)).toEqual(['shared']);
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

    it('refreshes an unedited seed when the built-in changes', () => {
      const svc = createSkillsService(workspaceRoot);
      svc.seedBuiltinSkill('grilling');
      writeSkill(h.builtinDir, 'grilling', { name: 'grilling', description: 'Builtin G' }, 'Revised grilling body.');
      expect(svc.seedBuiltinSkill('grilling')).toBe(true);
      expect(svc.findSkill('grilling')!.content).toContain('Revised grilling body.');
    });

    it('keeps a user-edited seed when the built-in changes', () => {
      const svc = createSkillsService(workspaceRoot);
      svc.seedBuiltinSkill('grilling');
      const file = path.join(home, '.ordewell', 'skills', 'grilling', 'SKILL.md');
      fs.appendFileSync(file, '\nMy own rule.\n');
      writeSkill(h.builtinDir, 'grilling', { name: 'grilling', description: 'Builtin G' }, 'Revised grilling body.');
      expect(svc.seedBuiltinSkill('grilling')).toBe(false);
      expect(fs.readFileSync(file, 'utf8')).toContain('My own rule.');
    });

    it('refreshes a known superseded seed that predates the manifest', () => {
      const file = path.join(home, '.ordewell', 'skills', 'grilling', 'SKILL.md');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      // The pre-fix grilling shipped with the "whole frontier" batching rule.
      fs.writeFileSync(file, LEGACY_GRILLING);
      const svc = createSkillsService(workspaceRoot);
      expect(svc.seedBuiltinSkill('grilling')).toBe(true);
      expect(fs.readFileSync(file, 'utf8')).toContain('Builtin grilling body.');
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
