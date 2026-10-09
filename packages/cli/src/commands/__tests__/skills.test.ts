import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { createHash } from 'crypto';
import { join } from 'path';
import { handleSkills } from '../skills';
import { COMMANDS } from '../registry';
import { printHelp } from '../../help';

let scratch: string;
let home: string;
let workspace: string;
let logs: string[];

function writeSkill(root: string, name: string, frontmatter = ''): string {
  const dir = join(root, '.ordewell', 'skills', name);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'SKILL.md');
  writeFileSync(file, `---\nname: ${name}\n${frontmatter}---\n\nSkill body.\n`);
  return file;
}

function snapshot(root: string): Record<string, string> {
  return Object.fromEntries(readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const file = join(entry.parentPath, entry.name);
      return [file, readFileSync(file, 'utf8')];
    }));
}

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'ordewell-cli-skills-'));
  home = join(scratch, 'home');
  workspace = join(scratch, 'workspace');
  mkdirSync(home);
  mkdirSync(workspace);
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  vi.spyOn(process, 'cwd').mockReturnValue(workspace);
  logs = [];
  vi.spyOn(console, 'log').mockImplementation((message: string) => { logs.push(message); });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(scratch, { recursive: true, force: true });
});

describe('ordewell skills', () => {
  it('lists resolved skills with their scope, applies-to, invocation and abbreviated path', () => {
    writeSkill(home, 'shared');
    const shadowedPath = writeSkill(workspace, 'shared', 'applies-to: task\n');
    const taskPath = writeSkill(workspace, 'task-only', 'applies-to: task\ndisable-model-invocation: true\n');
    writeSkill(home, 'model-only', 'user-invocable: false\n');
    writeSkill(home, 'disabled', 'user-invocable: false\ndisable-model-invocation: true\n');

    handleSkills([]);

    expect(logs[0]).toMatch(/Name\s+Scope\s+Applies-to\s+Invocation\s+SKILL.md/);
    expect(logs).toContainEqual(expect.stringMatching(/^shared\s+global\s+planner\s+both\s+~\/\.ordewell\/skills\/shared\/SKILL.md$/));
    expect(logs).toContainEqual(expect.stringMatching(/^model-only\s+global\s+planner\s+model\s+/));
    expect(logs).toContainEqual(expect.stringMatching(/^disabled\s+global\s+planner\s+none\s+/));
    expect(logs.find((line) => line.startsWith('task-only'))).toMatch(/^task-only\s+workspace\s+task\s+user\s+/);
    expect(logs.find((line) => line.startsWith('task-only'))).toContain(taskPath);
    expect(logs).toContain(`workspace skill "shared" shadowed by global · ${shadowedPath}`);
    expect(logs.filter((line) => line.startsWith('shared'))).toHaveLength(1);
  });

  it('uses --workspace instead of cwd and emits only catalog metadata as JSON', () => {
    const selected = join(scratch, 'selected');
    const skillPath = writeSkill(selected, 'selected-only', 'applies-to: task\n');
    writeSkill(workspace, 'cwd-only');
    writeSkill(home, 'shared');
    const duplicatePath = writeSkill(selected, 'shared');

    handleSkills(['--workspace', selected, '--json']);

    expect(logs).toHaveLength(1);
    expect(JSON.parse(logs[0])).toEqual({
      skills: [
        { name: 'shared', scope: 'global', appliesTo: 'planner', invocation: 'both', path: '~/.ordewell/skills/shared/SKILL.md' },
        { name: 'selected-only', scope: 'workspace', appliesTo: 'task', invocation: 'both', path: skillPath },
      ],
      shadowed: [{ name: 'shared', path: duplicatePath, shadowedBy: 'global' }],
      invalid: [],
    });
  });

  it('in a repo group, lists a skill committed inside a repo after the group root\'s own, the root winning a clash', () => {
    for (const repo of ['api', 'web']) mkdirSync(join(workspace, repo, '.git'), { recursive: true });
    const rootPath = writeSkill(workspace, 'deploy', 'applies-to: task\n');
    const apiPath = writeSkill(join(workspace, 'api'), 'api-check', 'applies-to: task\n');
    const shadowedPath = writeSkill(join(workspace, 'web'), 'deploy', 'applies-to: task\n');

    handleSkills(['--json']);

    const listed = JSON.parse(logs[0]);
    expect(listed.skills.map((s: { name: string; path: string }) => [s.name, s.path])).toEqual([['deploy', rootPath], ['api-check', apiPath]]);
    expect(listed.shadowed).toEqual([{ name: 'deploy', path: shadowedPath, shadowedBy: 'workspace' }]);
  });

  it('reports a skill folder whose name no skill can have, with the reason, and lists it nowhere else', () => {
    const dotted = writeSkill(workspace, 'pr.review', 'applies-to: task\n');
    writeSkill(home, 'PR-Review');
    writeSkill(workspace, 'kept');

    handleSkills([]);

    const skipped = (name: string) => logs.find((line) => line.startsWith(`skill folder "${name}" skipped: not a valid skill name`));
    expect(logs.filter((line) => /^(pr\.review|PR-Review)\s/.test(line))).toEqual([]);
    expect(skipped('pr.review')?.endsWith(` · ${dotted}`)).toBe(true);
    expect(skipped('PR-Review')?.endsWith(' · ~/.ordewell/skills/PR-Review/SKILL.md')).toBe(true);

    handleSkills(['--json']);
    const listed = JSON.parse(logs[logs.length - 1]);
    expect(listed.skills.map((s: { name: string }) => s.name)).toEqual(['kept']);
    expect(listed.invalid).toEqual([
      { name: 'PR-Review', path: '~/.ordewell/skills/PR-Review/SKILL.md', reason: expect.stringMatching(/^not a valid skill name/) },
      { name: 'pr.review', path: dotted, reason: expect.stringMatching(/^not a valid skill name/) },
    ]);
  });

  it('does not abbreviate a directory that merely shares the home prefix', () => {
    const otherWorkspace = home + '-other';
    const file = writeSkill(otherWorkspace, 'mine');
    handleSkills(['--workspace', otherWorkspace, '--json']);
    expect(JSON.parse(logs[0]).skills[0].path).toBe(file);
  });

  it('does not seed, refresh, prune or write a manifest while listing', () => {
    writeSkill(home, 'grill-me');
    const seeded = writeSkill(home, 'grilling');
    const manifest = join(home, '.ordewell', 'skills', '.seeded.json');
    writeFileSync(manifest, JSON.stringify({ grilling: createHash('sha256').update(readFileSync(seeded)).digest('hex') }));
    const before = snapshot(scratch);

    handleSkills([]);
    handleSkills(['--json']);

    expect(snapshot(scratch)).toEqual(before);
    expect(existsSync(join(home, '.ordewell', 'skills', 'to-spec'))).toBe(false);
  });

  it('handles an empty installation without creating directories', () => {
    handleSkills([]);
    expect(logs).toEqual(['No skills installed.']);
    handleSkills(['--json']);
    expect(JSON.parse(logs[1])).toEqual({ skills: [], shadowed: [], invalid: [] });
    expect(readdirSync(home)).toEqual([]);
    expect(readdirSync(workspace)).toEqual([]);
  });

  it('rejects scaffold subcommands without writing files', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
    expect(() => handleSkills(['new', 'mine'])).toThrow('exit');
    expect(error).toHaveBeenCalledWith('Usage: ordewell skills [--workspace /path] [--json]');
    expect(readdirSync(home)).toEqual([]);
    expect(readdirSync(workspace)).toEqual([]);
  });

  it('is registered and documented in help', () => {
    expect(COMMANDS.skills).toBe(handleSkills);
    printHelp();
    expect(logs[0]).toContain('ordewell skills');
    expect(logs[0]).toContain('Skills options:');
  });
});
