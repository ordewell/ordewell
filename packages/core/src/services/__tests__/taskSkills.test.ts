import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createTask, keepExecutionState } from '../../models/Task';
import { createSkillsService } from '../SkillsService';
import { checkOpSkills, checkPlanSkills, resolveTaskSkills, TaskSkillsError } from '../taskSkills';
import { parsePlanJson } from '../PlanValidator';
import { applyTaskOps } from '../TaskOps';
import { PlanStore } from '../PlanStore';
import { serializeTask } from '../SessionMessage';

let home = '';
let workspace = '';
let worktree = '';

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => home };
});

const h = vi.hoisted(() => ({ builtinDir: '' }));
vi.mock('../builtinSkills', () => ({ builtinSkillsDir: () => h.builtinDir }));

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

  it('names every missing skill and both directories it searched', () => {
    writeSkill(globalSkills(), 'tdd', 'task', 'RED, GREEN.');

    expect(() => resolveTaskSkills({ title: 'Ship', skills: ['tdd', 'a', 'b'] }, createSkillsService(worktree))).toThrow(
      `Task "Ship" did not start: skills "a" and "b" not found in ${globalSkills()} or ${skillsOf(worktree)}.`,
    );
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

describe('checking a plan\'s skills against the catalog', () => {
  it('warns about a name not found yet and refuses a planner skill', () => {
    writeSkill(globalSkills(), 'tdd', 'task', 'x');
    writeSkill(globalSkills(), 'grilling', 'planner', 'x');
    const lookup = createSkillsService(workspace);
    const tasks = [
      createTask({ id: 'a', title: 'A', skills: ['tdd', 'later'] }),
      createTask({ id: 'b', title: 'B', subtasks: [createTask({ id: 'b1', title: 'B1', skills: ['grilling'] })] }),
    ];

    const result = checkPlanSkills(tasks, lookup);

    expect(result.warnings).toEqual([expect.stringMatching(/^Task "A": skill "later" not found; it must exist in the task's worktree/)]);
    expect(result.errors).toEqual([{ taskId: 'b1', message: expect.stringMatching(/^Task "B1": "grilling" is a planner skill/) }]);
  });

  it('checks the skills an edit batch attaches, by op', () => {
    writeSkill(globalSkills(), 'grilling', 'planner', 'x');
    const result = checkOpSkills([
      { op: 'update', taskId: '#1', changes: { title: 'no skills here' } },
      { op: 'split', taskId: '#2', parts: [{ title: 'P1' }, { title: 'P2', skills: ['grilling', 'later'] }] },
    ], createSkillsService(workspace));

    expect(result.errors.map((e) => e.message)).toEqual([expect.stringMatching(/^op 2 \(split\): "grilling" is a planner skill/)]);
    expect(result.warnings).toEqual([expect.stringMatching(/^op 2 \(split\): skill "later" not found/)]);
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
