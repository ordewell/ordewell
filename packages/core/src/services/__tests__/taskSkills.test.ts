import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';
import { createTask, keepExecutionState, skillNames } from '../../models/Task';
import { createSkillsService } from '../SkillsService';
import { checkOpSkills, checkPlanSkills, checkTaskSkillsEdit, plannedSkillLookup, resolveTaskSkills, TaskSkillsError } from '../taskSkills';
import { parsePlanJson } from '../PlanValidator';
import { applyTaskOps } from '../TaskOps';
import { PlanStore } from '../PlanStore';
import { serializeTask } from '../SessionMessage';
import type { GitExecFn } from '../gitExec';

let home = '';
let workspace = '';
let worktree = '';

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => home };
});

const h = vi.hoisted(() => ({ builtinDir: '', gitCalls: [] as string[][] }));
vi.mock('../builtinSkills', () => ({ builtinSkillsDir: () => h.builtinDir }));
vi.mock('../gitExec', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../gitExec')>();
  const execFileWithTimeout = (ms: number): GitExecFn => {
    const run = actual.execFileWithTimeout(ms);
    return (file, args, opts) => {
      h.gitCalls.push(args);
      return run(file, args, opts);
    };
  };
  return { ...actual, execFileWithTimeout };
});

function writeSkill(root: string, name: string, appliesTo: string | null, body: string): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'SKILL.md');
  fs.writeFileSync(file, `---\nname: ${name}\ndescription: ${name}\n${appliesTo ? `applies-to: ${appliesTo}\n` : ''}---\n\n${body}`);
  return file;
}

const globalSkills = () => path.join(home, '.ordewell', 'skills');
const skillsOf = (root: string) => path.join(root, '.ordewell', 'skills');

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-taskskills-home-'));
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-taskskills-ws-'));
  worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-taskskills-wt-'));
  h.builtinDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-taskskills-builtin-'));
  h.gitCalls = [];
});

describe('resolveTaskSkills', () => {
  it('reads a skill committed only in the task\'s worktree, never the workspace root\'s', () => {
    const file = writeSkill(skillsOf(worktree), 'deploy-checklist', 'task', 'Check the pipeline.\n');
    const atRoot = createSkillsService(workspace);

    expect(() => resolveTaskSkills({ title: 'Ship', skills: ['deploy-checklist'] }, atRoot)).toThrow(TaskSkillsError);
    expect(resolveTaskSkills({ title: 'Ship', skills: ['deploy-checklist'] }, atRoot.forRoot(worktree))).toEqual([
      { name: 'deploy-checklist', source: 'workspace', path: file, content: 'Check the pipeline.\n' },
    ]);
  });

  it('takes the global skill when the worktree has one of the same name', () => {
    const file = writeSkill(globalSkills(), 'deploy-checklist', 'task', 'Global.');
    writeSkill(skillsOf(worktree), 'deploy-checklist', 'task', 'Committed.');

    const [resolved] = resolveTaskSkills({ title: 'Ship', skills: ['deploy-checklist'] }, createSkillsService(worktree));

    expect(resolved).toMatchObject({ source: 'global', path: file, content: 'Global.' });
  });

  it('names every missing skill and both directories it searched, with no word of commits outside a worktree', () => {
    writeSkill(globalSkills(), 'tdd', 'task', 'RED, GREEN.');

    expect(() => resolveTaskSkills({ title: 'Ship', skills: ['tdd', 'a', 'b'] }, createSkillsService(worktree))).toThrow(
      `Task "Ship" did not start: skills "a" and "b" not found in ${globalSkills()} or ${skillsOf(worktree)}.`,
    );
  });

  it('in a worktree, says to commit only the missing names the main checkout has', () => {
    const inMainCheckout = (name: string) => (name === 'draft' ? '.ordewell/skills/draft' : undefined);

    expect(() => resolveTaskSkills({ title: 'Ship', skills: ['draft', 'nowhere'] }, createSkillsService(worktree), inMainCheckout)).toThrow(
      `Task "Ship" did not start: skills "draft" and "nowhere" not found in ${globalSkills()} or ${skillsOf(worktree)}`
      + ' (a workspace skill reaches a task\'s worktree only once committed: commit .ordewell/skills/draft so task worktrees receive it).',
    );
    expect(() => resolveTaskSkills({ title: 'Ship', skills: ['nowhere'] }, createSkillsService(worktree), inMainCheckout)).toThrow(/not found in [^(]*\.$/);
  });

  it('refuses a planner skill, which a frontmatter without applies-to is', () => {
    const file = writeSkill(skillsOf(worktree), 'interview', null, 'Ask.');

    expect(() => resolveTaskSkills({ title: 'Ship', skills: ['interview'] }, createSkillsService(worktree))).toThrow(
      `Task "Ship" did not start: "interview" is a planner skill (applies-to: planner, ${file}), not a task skill.`,
    );
  });
});

describe('the built-in tdd skill', () => {
  it('ships as a user-only task skill carrying the test-first workflow', () => {
    h.builtinDir = path.resolve(__dirname, '..', '..', '..', 'skills');

    const tdd = createSkillsService(workspace).findSkill('tdd');

    expect(tdd).toMatchObject({ name: 'tdd', source: 'global', appliesTo: 'task', modelInvocable: false });
    expect(tdd?.description).toMatch(/not to verification-only, docs or ops tasks/);
    expect(tdd?.content).toContain('RED: Write ONE failing test');
    expect(fs.existsSync(path.join(globalSkills(), 'tdd', 'SKILL.md'))).toBe(true);
  });
});

describe('finding a skill by name', () => {
  it('never reads outside the skill dirs, whatever the name', () => {
    writeSkill(home, 'outside', 'task', 'x');
    fs.mkdirSync(globalSkills(), { recursive: true });
    const lookup = createSkillsService(workspace);

    expect(lookup.findSkill('../../outside')).toBeUndefined();
    expect(lookup.findSkill('../../../' + path.basename(home) + '/outside')).toBeUndefined();
    expect(lookup.findSkill(path.join(home, 'outside'))).toBeUndefined();
  });
});

describe('checking a plan\'s skills against the catalog', () => {
  it('warns about a name not found yet and refuses a planner skill', async () => {
    writeSkill(globalSkills(), 'tdd', 'task', 'x');
    writeSkill(globalSkills(), 'grilling', 'planner', 'x');
    const lookup = createSkillsService(workspace);
    const tasks = [
      createTask({ id: 'a', title: 'A', skills: ['tdd', 'later'] }),
      createTask({ id: 'b', title: 'B', subtasks: [createTask({ id: 'b1', title: 'B1', skills: ['grilling'] })] }),
    ];

    const result = await checkPlanSkills(tasks, lookup);

    expect(result.warnings).toEqual([expect.stringMatching(/^Task "A": skill "later" not found; it must exist in the task's worktree/)]);
    expect(result.errors).toEqual([{ taskId: 'b1', message: expect.stringMatching(/^Task "B1": "grilling" is a planner skill/) }]);
  });

  it('checks the skills an edit batch attaches, by op', async () => {
    writeSkill(globalSkills(), 'grilling', 'planner', 'x');
    const result = await checkOpSkills([
      { op: 'update', taskId: '#1', changes: { title: 'no skills here' } },
      { op: 'split', taskId: '#2', parts: [{ title: 'P1' }, { title: 'P2', skills: ['grilling', 'later'] }] },
    ], createSkillsService(workspace));

    expect(result.errors.map((e) => e.message)).toEqual([expect.stringMatching(/^op 2 \(split\): "grilling" is a planner skill/)]);
    expect(result.warnings).toEqual([expect.stringMatching(/^op 2 \(split\): skill "later" not found/)]);
  });
});

describe('checking the subtasks an edit adds', () => {
  it('refuses a planner skill on an added task\'s subtask, naming the subtask', async () => {
    writeSkill(globalSkills(), 'grilling', 'planner', 'x');
    const result = await checkOpSkills([
      { op: 'add', task: { title: 'Parent', subtasks: [{ title: 'Child', skills: ['grilling'], subtasks: [] }] as never } },
    ], createSkillsService(workspace));

    expect(result.errors.map((e) => e.message)).toEqual([expect.stringMatching(/^op 1 \(add\): subtask "Child": "grilling" is a planner skill/)]);
  });

  it('reaches every depth, and warns about a descendant\'s missing and malformed names as written', async () => {
    writeSkill(globalSkills(), 'grilling', 'planner', 'x');
    writeSkill(globalSkills(), 'tdd', 'task', 'x');
    const result = await checkOpSkills([
      {
        op: 'add',
        task: {
          title: 'Parent',
          skills: ['tdd'],
          subtasks: [{ title: 'Child', skills: ['Bad Name!', 'later'], subtasks: [{ skills: ['grilling'] }] }],
        } as never,
      },
    ], createSkillsService(workspace));

    expect(result.errors.map((e) => e.message)).toEqual([expect.stringMatching(/^op 1 \(add\): subtask "Child" > #1: "grilling" is a planner skill/)]);
    expect(result.warnings).toEqual([
      'op 1 (add): subtask "Child": "Bad Name!" is not a valid skill name (lowercase letters, digits, "-" and "_", starting with a letter or digit), so it was not attached.',
      expect.stringMatching(/^op 1 \(add\): subtask "Child": skill "later" not found/),
    ]);
  });

  it('holds a parent and its subtasks to their own lists', async () => {
    writeSkill(globalSkills(), 'grilling', 'planner', 'x');
    writeSkill(globalSkills(), 'tdd', 'task', 'x');
    const result = await checkOpSkills([
      { op: 'add', task: { title: 'Parent', skills: ['grilling'], subtasks: [{ title: 'Child', skills: ['tdd'] }, { title: 'Bare' }] as never } },
    ], createSkillsService(workspace));

    expect(result.errors.map((e) => e.message)).toEqual([expect.stringMatching(/^op 1 \(add\): "grilling" is a planner skill/)]);
    expect(result.warnings).toEqual([]);
  });
});

describe('checking a plan against the folders its tasks will read', () => {
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore' });
  const repo = (dir: string) => {
    fs.mkdirSync(dir, { recursive: true });
    git(dir, 'init', '-q');
    git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');
  };
  const commit = (dir: string, file: string) => {
    git(dir, 'add', '-f', file);
    git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'skill');
  };
  const at = (roots: readonly string[]) => createSkillsService(workspace).forRoot(roots);
  const plan = (...skills: string[]) => [createTask({ id: 'a', title: 'A', skills })];

  it('warns that an uncommitted workspace skill will not reach task worktrees, and not about a committed one', async () => {
    repo(workspace);
    writeSkill(skillsOf(workspace), 'draft', 'task', 'x');
    writeSkill(skillsOf(workspace), 'staged', 'task', 'x');
    writeSkill(skillsOf(workspace), 'kept', 'task', 'x');
    commit(workspace, '.ordewell/skills/kept/SKILL.md');
    git(workspace, 'add', '-f', '.ordewell/skills/staged/SKILL.md');

    const result = await checkPlanSkills(plan('draft', 'staged', 'kept'), plannedSkillLookup(at, workspace, { repos: ['.'], worktrees: true }));

    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([
      'Task "A": skill "draft" is not committed; commit .ordewell/skills/draft so task worktrees receive it.',
      'Task "A": skill "staged" is not committed; commit .ordewell/skills/staged so task worktrees receive it.',
    ]);
    expect(h.gitCalls.filter((args) => args[0] === 'ls-tree')).toHaveLength(1);
  });

  it('warns about a git-ignored workspace skill, and about one in an edit batch', async () => {
    repo(workspace);
    fs.writeFileSync(path.join(workspace, '.gitignore'), '.ordewell/\n');
    writeSkill(skillsOf(workspace), 'ignored', 'task', 'x');

    const result = await checkOpSkills([{ op: 'update', taskId: '#1', changes: { skills: ['ignored'] } }], plannedSkillLookup(at, workspace, { repos: ['.'], worktrees: true }));

    expect(result.warnings).toEqual(['op 1 (update): skill "ignored" is not committed; commit .ordewell/skills/ignored so task worktrees receive it.']);
  });

  it('says nothing about commits when tasks run in the workspace itself', async () => {
    repo(workspace);
    writeSkill(skillsOf(workspace), 'draft', 'task', 'x');

    expect(await checkPlanSkills(plan('draft'), plannedSkillLookup(at, workspace, { repos: ['.'], worktrees: false }))).toEqual({ errors: [], warnings: [] });
  });

  it('says nothing about a global skill', async () => {
    repo(workspace);
    writeSkill(globalSkills(), 'tdd', 'task', 'x');

    expect((await checkPlanSkills(plan('tdd'), plannedSkillLookup(at, workspace, { repos: ['.'], worktrees: true }))).warnings).toEqual([]);
  });

  it('in a repo group, finds a repo\'s skill and names the folder to commit in that repo; the group root\'s own needs none', async () => {
    repo(path.join(workspace, 'api'));
    repo(path.join(workspace, 'web'));
    writeSkill(skillsOf(workspace), 'root-skill', 'task', 'x');
    writeSkill(skillsOf(path.join(workspace, 'web')), 'web-draft', 'task', 'x');
    writeSkill(skillsOf(path.join(workspace, 'api')), 'api-kept', 'task', 'x');
    commit(path.join(workspace, 'api'), '.ordewell/skills/api-kept/SKILL.md');
    const layout = { repos: ['api', 'web'], worktrees: true };

    const result = await checkPlanSkills(plan('root-skill', 'web-draft', 'api-kept', 'later'), plannedSkillLookup(at, workspace, layout));

    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([
      'Task "A": skill "web-draft" is not committed; commit web/.ordewell/skills/web-draft so task worktrees receive it.',
      expect.stringMatching(/^Task "A": skill "later" not found/),
    ]);
    expect(h.gitCalls.filter((args) => args[0] === 'ls-tree')).toHaveLength(2);
  });

  it('in a repo group run in the workspace, reads each repo\'s folder there, as a spawn there does, and asks for no commit', async () => {
    repo(path.join(workspace, 'api'));
    writeSkill(skillsOf(path.join(workspace, 'api')), 'api-skill', 'task', 'x');

    const lookup = plannedSkillLookup(at, workspace, { repos: ['api'], worktrees: false });

    expect(lookup.findSkill('api-skill')?.path).toBe(path.join(skillsOf(path.join(workspace, 'api')), 'api-skill', 'SKILL.md'));
    expect(lookup.listSkills().map((s) => s.name)).toContain('api-skill');
    expect(lookup.searchedDirs()).toEqual([globalSkills(), skillsOf(workspace), skillsOf(path.join(workspace, 'api'))]);
    expect(await checkPlanSkills(plan('api-skill'), lookup)).toEqual({ errors: [], warnings: [] });
  });
});

describe('the skills field', () => {
  it('is parsed per task, a subtask keeping its own and never inheriting its parent\'s', () => {
    const [task] = parsePlanJson(JSON.stringify({
      tasks: [{
        id: 'a', title: 'A', sliceType: 'AFK', autonomy: 'AFK', skills: [' tdd ', 'tdd', 7, ''],
        subtasks: [{ id: 'a1', title: 'A1', sliceType: 'AFK', autonomy: 'AFK' }, { id: 'a2', title: 'A2', sliceType: 'AFK', autonomy: 'AFK', skills: ['deploy'] }],
      }],
    }), ['claude-code']);

    expect(task.skills).toEqual(['tdd']);
    expect(task.subtasks[0].skills).toBeUndefined();
    expect(task.subtasks[1].skills).toEqual(['deploy']);
  });

  it('keeps what parsing dropped for the plan check to warn about, subtasks included, and nothing for a task made in code', async () => {
    const tasks = parsePlanJson(JSON.stringify({
      tasks: [{
        id: 'a', title: 'A', sliceType: 'AFK', autonomy: 'AFK', skills: ['Bad Name!', 'tdd'],
        subtasks: [{ id: 'a1', title: 'A1', sliceType: 'AFK', autonomy: 'AFK', skills: ['ok_1', '-no', 7] }],
      }],
    }), ['claude-code']);
    const lookup = { findSkill: () => undefined, searchedDirs: () => [] };

    const { warnings } = await checkPlanSkills(tasks, lookup);
    const fromCode = await checkPlanSkills([createTask({ id: 'b', title: 'B', skills: ['tdd'] })], lookup);

    expect(warnings).toEqual([
      expect.stringContaining('Task "A": "Bad Name!" is not a valid skill name'),
      expect.stringContaining('Task "A": skill "tdd" not found'),
      expect.stringContaining('Task "A1": "-no" is not a valid skill name'),
      expect.stringContaining('Task "A1": skill "ok_1" not found'),
    ]);
    expect(tasks[0].subtasks[0].skills).toEqual(['ok_1']);
    expect(fromCode.warnings).toEqual([expect.stringContaining('skill "tdd" not found')]);
  });

  it('is changed, cleared, merged and split by plan edits', () => {
    const plan = [
      createTask({ id: 'a', order: 1, title: 'A', prompt: 'a', skills: ['tdd'] }),
      createTask({ id: 'b', order: 2, title: 'B', prompt: 'b', skills: ['deploy'] }),
    ];

    const updated = applyTaskOps(plan, [{ op: 'update', taskId: '#1', changes: { skills: ['tdd', 'docs'] } }], ['claude-code']);
    const cleared = applyTaskOps(plan, [{ op: 'update', taskId: '#1', changes: { skills: [] } }], ['claude-code']);
    const merged = applyTaskOps(plan, [{ op: 'merge', taskIds: ['#1', '#2'], merged: { title: 'AB' } }], ['claude-code']);
    const split = applyTaskOps(plan, [{ op: 'split', taskId: '#2', parts: [{ title: 'B1' }, { title: 'B2', skills: ['tdd'] }] }], ['claude-code']);

    expect(updated.tasks[0].skills).toEqual(['tdd', 'docs']);
    expect(cleared.tasks[0].skills).toBeUndefined();
    expect(merged.tasks[0].skills).toEqual(['tdd', 'deploy']);
    expect(split.tasks.map((t) => [t.title, t.skills])).toEqual([['A', ['tdd']], ['B1', ['deploy']], ['B2', ['tdd']]]);
  });

  it('keeps what a merge or split inherits unless the edit names skills or clears them with []', () => {
    const plan = [
      createTask({ id: 'a', order: 1, title: 'A', prompt: 'a', skills: ['tdd'] }),
      createTask({ id: 'b', order: 2, title: 'B', prompt: 'b', skills: ['deploy'] }),
    ];
    const merged = (skills: unknown) => applyTaskOps(plan, [{ op: 'merge', taskIds: ['#1', '#2'], merged: { title: 'AB', skills } as never }], ['claude-code']).tasks[0].skills;
    const split = (skills: unknown) => applyTaskOps(plan, [{ op: 'split', taskId: '#2', parts: [{ title: 'B1', skills } as never, { title: 'B2' }] }], ['claude-code']).tasks[1].skills;
    const store = new PlanStore();
    store.load(plan, ['claude-code']);
    store.split('b', [{ title: 'B1', skills: 'deploy' as never }, { title: 'B2', skills: [] }]);

    expect([merged('tdd'), merged([7]), merged([]), merged(['docs'])]).toEqual([['tdd', 'deploy'], ['tdd', 'deploy'], undefined, ['docs']]);
    expect([split('tdd'), split({}), split([]), split(['docs'])]).toEqual([['deploy'], ['deploy'], undefined, ['docs']]);
    expect(store.planTasks.map((t) => t.skills)).toEqual([['tdd'], ['deploy'], undefined]);
  });

  it('keeps only names a skill could have, lower-cased as /name parses them', () => {
    expect(skillNames(['TDD', '../../etc', '/abs', 'a/b', '..', '.hidden', 'pr_style-2', ' Docs '])).toEqual(['tdd', 'pr_style-2', 'docs']);
    expect(skillNames(['../x'])).toBeUndefined();
  });

  it('survives a reload of the saved plan and travels on the wire', () => {
    const task = createTask({ id: 'a', title: 'A', skills: ['tdd'], subtasks: [createTask({ id: 'a1', title: 'A1', skills: ['deploy'] })] });
    const store = new PlanStore();
    store.load(JSON.parse(JSON.stringify([task])), ['claude-code']);

    expect(store.get('a')?.skills).toEqual(['tdd']);
    expect(store.get('a1')?.skills).toEqual(['deploy']);
    expect(serializeTask(task)).toMatchObject({ skills: ['tdd'], subtasks: [{ skills: ['deploy'] }] });
    expect(serializeTask(createTask({ id: 'b' }))).not.toHaveProperty('skills');
  });

  it('keeps what an attempt was given when a planner rewrite restates the task', () => {
    const snapshot = [{ name: 'tdd', source: 'global' as const, path: '/g/tdd/SKILL.md', content: 'x' }];
    const ran = { ...createTask({ id: 'a', title: 'A', status: 'failed', skills: ['tdd'] }), attemptSkills: snapshot };

    const [rewritten] = keepExecutionState([ran], [createTask({ id: 'a', title: 'A again', skills: ['tdd'] })]);

    expect(rewritten.attemptSkills).toEqual(snapshot);
  });
});

describe('a name dropped as no skill\'s', () => {
  const lookup = { findSkill: () => undefined, searchedDirs: () => [] };

  it('is never dropped silently from a planner\'s edit: each one is a warning, the valid names still checked', async () => {
    const result = await checkOpSkills([
      { op: 'update', taskId: '#1', changes: { skills: ['pr.review', ' PR/x ', 'later', 7, ''] as never } },
      { op: 'add', task: { title: 'C', skills: ['../up'] } },
    ], lookup);

    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([
      'op 1 (update): "pr.review" is not a valid skill name (lowercase letters, digits, "-" and "_", starting with a letter or digit), so it was not attached.',
      'op 1 (update): "PR/x" is not a valid skill name (lowercase letters, digits, "-" and "_", starting with a letter or digit), so it was not attached.',
      expect.stringMatching(/^op 1 \(update\): skill "later" not found/),
      'op 2 (add): "../up" is not a valid skill name (lowercase letters, digits, "-" and "_", starting with a letter or digit), so it was not attached.',
    ]);
  });

  it('is never dropped silently from a hand-set list either', async () => {
    expect((await checkTaskSkillsEdit({ id: 'a', title: 'A' }, ['Pr.Review'], lookup)).warnings).toEqual([
      'Task "A": "Pr.Review" is not a valid skill name (lowercase letters, digits, "-" and "_", starting with a letter or digit), so it was not attached.',
    ]);
  });
});
