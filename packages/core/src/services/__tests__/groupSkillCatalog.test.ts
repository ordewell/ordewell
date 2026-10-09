import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';
import { createTask, type LegacyPlanState } from '../../models/Task';
import type { ConversationRequest } from '../AiService';
import type { SessionNotice } from '../SessionMessage';
import { fakeConfig, makeSession, taskOf } from './sessionTestKit';

let home = '';
let workspace = '';

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => home };
});

const h = vi.hoisted(() => ({ builtinDir: '' }));
vi.mock('../builtinSkills', () => ({ builtinSkillsDir: () => h.builtinDir }));

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

function writeSkill(root: string, name: string, appliesTo: 'planner' | 'task'): string {
  const dir = path.join(root, '.ordewell', 'skills', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} description\napplies-to: ${appliesTo}\n---\n\n${name} body`);
  return path.join(dir, 'SKILL.md');
}

function repo(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q');
  git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');
}

function commit(dir: string, file: string): void {
  git(dir, 'add', '-f', file);
  git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'skill');
}

function savedPlan(): LegacyPlanState {
  const at = '2026-01-01T00:00:00Z';
  return {
    tasks: [createTask({ id: 't1', order: 1, title: 'Build', prompt: 'p', assignedRunner: 'claude-code' })],
    generatedAt: at, status: 'draft', runners: ['claude-code'], lastUpdated: at,
    conversationHistory: [{ role: 'user', content: 'build it', timestamp: at }],
  };
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-group-home-'));
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-group-ws-'));
  h.builtinDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-group-builtin-'));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  repo(path.join(workspace, 'api'));
  repo(path.join(workspace, 'web'));
  writeSkill(path.join(workspace, 'api'), 'api-check', 'task');
  commit(path.join(workspace, 'api'), '.ordewell/skills/api-check/SKILL.md');
  writeSkill(path.join(workspace, 'web'), 'web-plan', 'planner');
  commit(path.join(workspace, 'web'), '.ordewell/skills/web-plan/SKILL.md');
  writeSkill(path.join(workspace, 'web'), 'web-draft', 'task');
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of [home, workspace, h.builtinDir]) fs.rmSync(dir, { recursive: true, force: true });
});

describe('a repo group\'s skill catalog, before any task runs', () => {
  it('shows the planner a skill committed inside a repo, and /name loads it', async () => {
    const ai = {
      startConversation: vi.fn().mockResolvedValue({ kind: 'message', text: 'ok', researchLog: [] }),
      hasActiveConversation: () => true,
      reset: vi.fn(),
    };
    const session = makeSession({ workspaceRoot: () => workspace, aiService: ai });

    await session.startPlanning('/api-check /web-plan build it', ['claude-code']);

    const request = ai.startConversation.mock.calls[0][0] as ConversationRequest;
    expect(request.skills?.map((s) => s.name)).toEqual(expect.arrayContaining(['api-check', 'web-plan', 'web-draft']));
    expect(session.planState?.conversationHistory?.filter((m) => m.kind === 'skill_load').map((m) => m.skill?.name)).toEqual(['api-check', 'web-plan']);
    expect(request.goal).toContain('web-plan body');
    expect(request.goal).toContain('The user asks to use task skill "api-check"');
  });

  it('checks a chip edit on a restored session against the repos from the first edit, the commit check included', async () => {
    const onNotice = vi.fn<(notice: SessionNotice) => void>();
    const session = makeSession({ workspaceRoot: () => workspace, onNotice, config: fakeConfig({ worktreeIsolation: true }) });
    session.loadPlan(savedPlan(), 'build it', workspace, { persist: false });

    await session.updateTask('t1', { skills: ['api-check', 'web-draft', 'PR.Review'] });

    expect(taskOf(session, 't1')?.skills).toEqual(['api-check', 'web-draft']);
    expect(onNotice.mock.calls.map(([n]) => [n.level, n.message])).toEqual([
      ['warn', 'Task "Build": "PR.Review" is not a valid skill name (lowercase letters, digits, "-" and "_", starting with a letter or digit), so it was not attached.'],
      ['warn', 'Task "Build": skill "web-draft" is not committed; commit web/.ordewell/skills/web-draft so task worktrees receive it.'],
    ]);
  });
});
