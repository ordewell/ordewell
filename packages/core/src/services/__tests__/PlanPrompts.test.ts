import { forbiddenFields } from '../../models/TaskKind';
import { describe, it, expect } from 'vitest';
import { buildConflictRepairPrompt, buildConflictResolutionPrompt, buildConversationSystemPrompt, buildPlanWithResults, buildResearchPrompt, buildResearchToolsPrompt, buildSubagentSystemPrompt, inTurnAgents, NATIVE_SHELL_GUIDE, PARALLELISM_RULE, whoExploresSection } from '../PlanPrompts';
import type { RepoGroupLayout } from '../../interfaces/IWorktreeIsolation';
import { createTask, type DiscoveredModel, type RunnerId } from '../../models/Task';

import { DEFAULT_PLANNER_MODES, type PlannerModes } from '../plannerModes';
import { validatePlanTasks } from '../PlanValidator';
import { taskOpsProtocol } from '../TaskOps';
import type { SkillInfo } from '../SkillsService';

const modes = (over: Partial<PlannerModes> = {}): PlannerModes => ({ ...DEFAULT_PLANNER_MODES, ...over });

describe('model-invocable planner skill catalog', () => {
  const skill = (name: string, extra: Partial<SkillInfo> = {}): SkillInfo => ({
    name, description: `${name} description`, content: 'SECRET BODY', metadata: { name, description: '' },
    source: 'global', path: `/skills/${name}/SKILL.md`, appliesTo: 'planner', modelInvocable: true, userInvocable: false, ...extra,
  });
  const skills = [skill('review-plan'), skill('task-only', { appliesTo: 'task' }), skill('user-only', { modelInvocable: false })];
  const prompt = (harness: boolean, plannerSkills = skills) => buildConversationSystemPrompt(
    'goal', '', {}, ['claude-code'], undefined, { harness, skills: plannerSkills },
  );

  it('advertises only loadable names and descriptions to a harness planner', () => {
    const text = prompt(true);
    expect(text).toContain('ORDEWELL PLANNER SKILLS:');
    expect(text).toContain('- review-plan: review-plan description');
    expect(text).toContain('Ordewell skills load only through load_skill');
    expect(text).not.toMatch(/user-only|SECRET BODY|\/skills\/[a-z-]+\/SKILL\.md/);
    expect(text.split('ORDEWELL PLANNER SKILLS:')[1].split('\n\n')[0]).not.toContain('task-only');
  });

  it('omits the catalog and tool instructions for an API planner, which has no tools', () => {
    expect(prompt(false)).not.toMatch(/ORDEWELL PLANNER SKILLS|review-plan|load_skill/);
  });

  it('omits the catalog when no model-invocable planner skills exist', () => {
    expect(prompt(true, skills.slice(1))).not.toContain('ORDEWELL PLANNER SKILLS:');
    expect(prompt(true, [])).not.toContain('ORDEWELL PLANNER SKILLS:');
  });
});

describe('task skill catalog', () => {
  const skill = (name: string, extra: Partial<SkillInfo> = {}): SkillInfo => ({
    name, description: `${name} description`, content: 'SECRET BODY', metadata: { name, description: '' },
    source: 'global', path: `/skills/${name}/SKILL.md`, appliesTo: 'task', modelInvocable: true, userInvocable: true, ...extra,
  });
  const prompt = (plannerSkills: SkillInfo[], plannerTools = true) => buildConversationSystemPrompt(
    'goal', '', {}, ['claude-code'], undefined, { harness: plannerTools, skills: plannerSkills },
  );

  it('lists model-invocable task skills with a never-blanket-attach instruction', () => {
    const text = prompt([skill('pr-style'), skill('tdd', { modelInvocable: false }), skill('review', { appliesTo: 'planner' })]);
    expect(text).toContain('- pr-style: pr-style description');
    expect(text).toContain('only where its description says it applies');
    expect(text).toContain('Never attach a skill to every task');
    const catalog = text.slice(text.indexOf('Task skills you may attach:'), text.indexOf('DEPENDENCY & PARALLELISM:'));
    expect(catalog).not.toMatch(/tdd|review|SECRET BODY/);
  });

  it('omits the catalog when no task skill is model-invocable', () => {
    for (const text of [prompt([]), prompt([skill('tdd', { modelInvocable: false })]), prompt([])]) {
      expect(text).not.toContain('Task skills you may attach:');
    }
  });

  it('documents the skills field, and a dependency creating the skill, with or without a catalog', () => {
    for (const text of [prompt([]), prompt([], false), prompt([skill('pr-style')])]) {
      expect(text).toContain('"skills": ["task-skill-name"]');
      expect(text).toContain('a task it depends on creates');
      expect(text).toContain('accepted with a warning');
    }
  });
});

describe('the one-shot prompts, per transport', () => {
  const prompts = (tools: boolean) => [
    buildPlanWithResults('goal', '', '', {}, ['claude-code'], undefined, DEFAULT_PLANNER_MODES, tools),
  ];

  it.each([false, true])('includes research and skills in the shared plan example (tools: %s)', (tools) => {
    for (const prompt of prompts(tools)) {
      expect(prompt).toContain('"research": false');
      expect(prompt).toContain('"skills": ["task-skill-name"]');
    }
  });

  it('ask a coding agent for submit_plan and never for JSON in its reply', () => {
    for (const prompt of prompts(true)) {
      expect(prompt).toContain('Submit the plan ONLY through submit_plan. Never write the plan as JSON in your reply.');
      expect(prompt).not.toMatch(/as JSON\.|as a JSON object|Output ONLY the JSON object|JSON format/);
    }
  });

  it('ask an API planner for the JSON envelope and never for submit_plan', () => {
    for (const prompt of prompts(false)) {
      expect(prompt).toContain('Output ONLY the JSON object.');
      expect(prompt).not.toContain('submit_plan');
    }
  });
});

describe('buildConversationSystemPrompt slice rules', () => {
  it('sizes slices to a fresh context window, prefactors first, and allows expand-contract for wide refactors', () => {
    const p = buildConversationSystemPrompt('goal', '', {}, ['claude-code']);
    expect(p).toMatch(/Size each slice to fit a single fresh agent session's context window/i);
    expect(p).toMatch(/make the change easy, then make the easy change/i);
    expect(p).toContain('EXPAND-CONTRACT');
  });
});

describe('buildConversationSystemPrompt on Windows', () => {
  // A coding agent there expects PowerShell; run_command runs Git Bash, or cmd.exe without it (ADR-0010).
  const harness = (researchShell?: 'git-bash' | 'cmd') => buildConversationSystemPrompt('goal', '', {}, ['codex'], undefined, { harness: true, runner: 'codex', ...(researchShell ? { researchShell } : {}) });

  it('names the shell run_command runs, and changes nothing where none is named', () => {
    expect(harness('git-bash')).toContain('run_command runs Git Bash, a POSIX shell: read with cat, ls, grep and find, not PowerShell cmdlets');
    expect(harness('cmd')).toContain('run_command runs cmd.exe: read with type, dir and findstr');
    expect(harness()).not.toContain('On this Windows machine');
    expect(harness('git-bash').replace(/^- On this Windows machine.*\n/m, '')).toBe(harness());
  });

  it('says nothing of it to an API planner, whose tool is named bash', () => {
    expect(buildConversationSystemPrompt('goal', '', {}, ['codex'], undefined, { researchShell: 'cmd' })).not.toContain('On this Windows machine');
  });
});

describe('buildResearchPrompt model catalog', () => {
  it('lists every discovered runner provider and each model\'s variants for the planner', () => {
    const modelsByRunner: Partial<Record<RunnerId, DiscoveredModel[]>> = {
      opencode: [
        { modelId: 'opencode/deepseek-v4-pro', modelLabel: 'DeepSeek V4 Pro', runnerProvider: 'opencode', variants: [{ id: 'low', label: 'Low' }, { id: 'high', label: 'High' }] },
        { modelId: 'opencode/claude-sonnet-4', modelLabel: 'Claude Sonnet 4', runnerProvider: 'opencode', variants: [] },
      ],
      'opencode-go': [
        { modelId: 'opencode-go/deepseek-v4-pro', modelLabel: 'DeepSeek V4 Pro (Go)', runnerProvider: 'opencode-go', variants: [{ id: 'low', label: 'Low' }] },
      ],
      openrouter: [
        { modelId: 'openrouter/~anthropic/claude-sonnet-latest', modelLabel: 'Claude Sonnet', runnerProvider: 'openrouter', variants: [] },
      ],
    };
    const p = buildResearchPrompt('goal', '', modelsByRunner, ['opencode'], undefined, modes());

    expect(p).toContain('opencode/deepseek-v4-pro');
    expect(p).toContain('"id": "low"');
    expect(p).toContain('"id": "high"');

    const pAll = buildResearchPrompt('goal', '', modelsByRunner, ['opencode', 'opencode-go', 'openrouter'], undefined, modes());
    expect(pAll).toContain('opencode-go/deepseek-v4-pro');
    expect(pAll).toContain('openrouter/~anthropic/claude-sonnet-latest');
  });
});

describe('research subagent prompts', () => {
  it('tools prompt always mentions spawn_research_agent', () => {
    const on = buildResearchToolsPrompt();
    expect(on).toContain('spawn_research_agent');
    // Concurrency guidance (opencode-style): batch spawn calls in one reply.
    expect(on).toMatch(/concurrent/i);
    // Small repos should not be pushed into fan-out.
    expect(on).toMatch(/small|single-subsystem/i);
  });

  it('subagent system prompt pins the read-only digest contract', () => {
    const p = buildSubagentSystemPrompt();
    expect(p).toMatch(/read-only/i);
    expect(p).toMatch(/digest/i);
    expect(p).toMatch(/file paths/i);
    // A subagent reports to the planner, not the user, and must not plan.
    expect(p).not.toContain('"tasks"');
  });
});

describe('buildConversationSystemPrompt harness variant (ADR-0009)', () => {
  function variant(harnessMode: boolean) {
    return buildConversationSystemPrompt(
      'build a task planner',
      'PROJECT CONTEXT HERE',
      { 'claude-code': [{ modelId: 'sonnet', modelLabel: 'Sonnet', variants: [{ id: 'high', label: 'High' }] }] },
      ['claude-code'],
      undefined,
      { harness: harnessMode },
    );
  }

  it('drops the Ordewell tool names — a coding agent does not have them', () => {
    const harness = variant(true);
    expect(harness).not.toContain('list_dir');
    expect(harness).not.toContain('glob and grep');
    // The API variant still names them, because Ordewell is the one running them.
    expect(variant(false)).toContain('list_dir');
  });

  it('tells the harness planner in so many words that it must not touch the workspace', () => {
    const harness = variant(true);
    expect(harness).toMatch(/edit, create or delete no file, and run no command that changes the workspace/);
  });

  // Whether a process has the shell is known only when it is spawned, so the
  // conversation prompt never says it; the spawn adds NATIVE_SHELL_GUIDE (ADR-0036 N1).
  it('never offers the harness\'s own shell in the conversation prompt itself', () => {
    const prompt = buildConversationSystemPrompt('goal', '', {}, ['claude-code'], undefined, { harness: true });
    expect(prompt).not.toMatch(/your own shell is available/i);
    expect(prompt).toContain('not a shell of your own');
  });

  it('tells a planner given its own shell what it cannot reach from it', () => {
    expect(NATIVE_SHELL_GUIDE).toContain('workspace read-only');
    expect(NATIVE_SHELL_GUIDE).toContain('localhost');
    expect(NATIVE_SHELL_GUIDE).toContain('run_command');
  });

  // A harness planner that backgrounds its exploration agents ends its turn on
  // "I'll report back once they land" — and the report, arriving after the turn
  // closed, reaches no one. The API planner runs its own agents inside the turn
  // and has nothing to be told.
  it('tells the harness planner to await its own agents inside the turn', () => {
    expect(variant(true)).toMatch(/and wait for its results inside this reply, never in the background: once your turn ends, nothing you say reaches the user\./);
    expect(variant(false)).not.toMatch(/wait for its results inside this reply/);
  });

  // An OpenCode planner's subagents are withheld (ADR-0026): there is nothing to await.
  it('tells a planner with no agents of its own nothing about awaiting them', () => {
    const opencode = buildConversationSystemPrompt('goal', '', {}, ['opencode'], undefined, { harness: true, runner: 'opencode' });
    expect(opencode).not.toMatch(/wait for its results inside this reply/);
  });

  it('keeps the plan schema and runner vocabulary, reading the model catalog through list_models', () => {
    const harness = variant(true);
    expect(harness).not.toContain('Sonnet');
    expect(harness).toContain('list_models');
    expect(variant(false)).toContain('Sonnet');
    for (const shared of ['"tasks"', 'assignedRunner', 'assignedModel', 'sliceType', 'BUILD PLANS:', 'VERTICAL TRACER-BULLET SLICE', 'STRATEGY:', 'DEFAULTS:', 'WHO EXPLORES:', 'PROJECT CONTEXT HERE',
      // A subtask is a full task object with the same required fields. Dropping
      // this from one variant is exactly how the requirement went unstated.
      'at every depth']) {
      expect(harness).toContain(shared);
    }
  });

  it('teaches the API planner the task-query envelope, and the harness planner the task_query tool', () => {
    const api = variant(false);
    expect(api).toContain('"taskQuery"');
    expect(api).toContain('"catalog"');
    expect(api).toContain('"fields"');
    const harness = variant(true);
    expect(harness).toContain('task_query');
    for (const prompt of [api, harness]) {
      expect(prompt).toContain('task_output');
      expect(prompt).toContain('task_diff');
      expect(prompt).toContain('attempt');
      expect(prompt).toContain('kinds');
      expect(prompt).toContain('nextOffset');
    }
    expect(harness).not.toContain('"taskQuery"');
  });
  it('submits through submit_plan where the API variant emits the JSON envelope', () => {
    expect(variant(true)).toContain('Submit the plan only through submit_plan');
    expect(variant(false)).toContain('When committing the plan, output only the JSON object, with no markdown code block around it');
    expect(variant(false)).not.toContain('submit_plan');
  });
});

const LONE_REPO: RepoGroupLayout = { repos: ['.'], shared: [] };

function conversation(isolatedExecution: false | RepoGroupLayout) {
  return buildConversationSystemPrompt('goal', '', {}, ['claude-code'], undefined, { isolatedExecution });
}

function oneShot(isolatedExecution: false | RepoGroupLayout) {
  return buildResearchPrompt('goal', '', {}, ['claude-code'], undefined, modes({ isolatedExecution }));
}

describe('read-only guidance (ADR-0031, ADR-0046)', () => {
  it('lets read-only tasks run anything sealed and try changes in a throwaway worktree, and keeps ops tasks separate', () => {
    for (const p of [conversation(false), oneShot(LONE_REPO)]) {
      expect(p).toMatch(/"readOnly".*land nothing.*run_command.*runs anything sealed: tests, scripts, builds, loops.*Never on an ops task/i);
      expect(p).toMatch(/Sealed means no network, no home directory or credentials/);
      expect(p).toMatch(/throwaway worktree.*edit files to try a fix, or add a failing test and run the suite on it\. None of that lands/);
      expect(p).toMatch(/its task_complete report is its result/);
    }
  });

  it('says a read-only task reads the web through Ordewell fetch and web_search, without anyone asked', () => {
    for (const p of [conversation(false), oneShot(LONE_REPO)]) {
      expect(p).toMatch(/It reads the web only through Ordewell fetch and web_search, which the session's web-read settings decide without asking anyone, within a web-read budget of its own; a read those settings would only allow after asking is refused, and the task reports the gap\./);
    }
  });

  it('says a sealed run has no worktree to write where the run does not isolate', () => {
    expect(conversation(false)).toMatch(/throwaway worktree, where the run isolates/);
  });
});

describe('research tasks (ADR-0037)', () => {
  const prompt = (harness: boolean) => buildConversationSystemPrompt('goal', '', {}, ['claude-code'], undefined, { harness });
  const section = (p: string, header: string) => {
    const at = p.indexOf(`\n${header}\n`);
    expect(at).toBeGreaterThan(-1);
    return p.slice(at + 1, p.indexOf('\n\n', at + 1));
  };

  it.each([false, true])('teaches when to use one, and that its report wakes the planner (harness: %s)', (harness) => {
    const guide = section(prompt(harness), 'READ-ONLY TASKS:');
    expect(guide).toMatch(/Add "research": true to a read-only top-level AI task whose report should come back to you, as WHO EXPLORES says\./);
    expect(guide).toMatch(/which wakes you when the task ends \(passes, fails or is blocked\), at every supervisor level, while you keep talking with the user/);
    expect(guide).not.toMatch(/outlive this turn|in the background/);
    expect(guide).toMatch(/Never on a subtask, an ops task or a loop's body/);
  });

  it.each([false, true])('asks for a self-contained brief and says what a research task may do (harness: %s)', (harness) => {
    const guide = section(prompt(harness), 'READ-ONLY TASKS:');
    // A research task is a read-only task, so what the guide says of one (sealed runs, a throwaway worktree, nothing lands) is not restated.
    expect(guide).toMatch(/runs anything sealed.*throwaway worktree.*None of that lands/);
    expect(guide).toMatch(/Brief a research task as WHO EXPLORES says, asking a report of the evidence for and against, with file:line references and what it ran and what happened/);
    expect(section(prompt(harness), 'WHO EXPLORES:')).toMatch(/self-contained brief, since a task never sees this conversation: its goal, its inputs, what to report back, and how its result will be checked/);
  });

  it.each([false, true])('says the planner decides how many, bounded by Parallel (harness: %s)', (harness) => {
    const p = prompt(harness);
    expect(section(p, 'READ-ONLY TASKS:')).toMatch(/Start one research task for each independent question; the run's Parallel limit bounds what runs at once/);
    expect(section(p, 'READ-ONLY TASKS:')).toMatch(/In a report turn, start another only when the report opens a genuinely new question/);
    expect(section(p, 'DEFAULTS:')).not.toMatch(/Parallel limit/);
  });

  it.each([false, true])('shows "research" in PLAN FORMAT, with an example the plan\'s own rules accept (harness: %s)', (harness) => {
    const p = prompt(harness);
    const format = p.slice(p.indexOf('\nPLAN FORMAT:\n'), p.indexOf('\nSLICE CLASSIFICATION:\n'));
    expect(format).toContain('"research": false,');
    const example = JSON.parse(p.split('\n').find((line) => line.startsWith('{ "id": "scout-1"'))!);
    expect(example).toMatchObject({ readOnly: true, research: true, type: 'ai' });
    expect(example.prompt).toMatch(/Start at .*Report: .*the command you ran with its result/);
  });

  it('sends the failure to explain and the open problem to research tasks', () => {
    const strategy = section(prompt(true), 'STRATEGY:');
    expect(strategy).toMatch(/reproduce it first, investigate competing hypotheses in parallel, then fix/);
    expect(strategy).toMatch(/When one sealed command settles a hypothesis, test it yourself this turn\. Give each other hypothesis a research task of its own that reports the evidence for and against it \(WHO EXPLORES\)/);
    expect(strategy).toMatch(/An open problem with no known path: a search \(WHO EXPLORES\)\. Plan only the first round of exploration, as research tasks that each report on one question\. Their reports wake you/);
  });

  it('is in the conversation prompt only, not the one-shot planner\'s', () => {
    expect(oneShot(LONE_REPO)).not.toMatch(/research task/);
    expect(oneShot(LONE_REPO)).toContain('"research": false');
  });
});

describe('who explores: three tiers, search (ADR-0037 R5)', () => {
  const awaited = (agents: string) => new RegExp(`Use ${agents} and wait for its results inside this reply, never in the background: once your turn ends, nothing you say reaches the user\\.`);
  const backends = [
    { name: 'an API planner', harness: false, runner: undefined, inTurn: /- An agent, awaited: .*Use spawn_research_agent, whose agents return within your tool round\./ },
    { name: 'Claude Code', harness: true, runner: 'claude-code', inTurn: awaited('your Agent tool') },
    { name: 'Codex', harness: true, runner: 'codex', inTurn: awaited('your own subagents, if this session has them,?') },
    { name: 'OpenCode', harness: true, runner: 'opencode', inTurn: /- Your own reads, past that: you have no agents of your own here, so a wider question you need this turn .* is yours to read too\./ },
    { name: 'an unnamed harness', harness: true, runner: undefined, inTurn: awaited('your own agents, if you have any,?') },
  ] as const;
  const prompt = (harness: boolean, runner?: RunnerId) => buildConversationSystemPrompt('goal', '', {}, ['claude-code'], undefined, { harness, runner });
  const section = (p: string, header: string) => {
    const at = p.indexOf(`\n${header}\n`);
    expect(at).toBeGreaterThan(-1);
    return p.slice(at + 1, p.indexOf('\n\n', at + 1));
  };
  const count = (p: string, text: string) => p.split(text).length - 1;

  it.each(backends)('states the rule once, as its own section, for $name', ({ harness, runner, inTurn }) => {
    const p = prompt(harness, runner);
    const rule = section(p, 'WHO EXPLORES:');
    expect(rule).toBe(whoExploresSection(inTurnAgents(harness, runner)).join('\n'));
    expect(rule).toMatch(/by what the result is, never by how long it may take/);
    expect(rule).toMatch(/- Read it yourself: the project's own guides .*, a map of its directories, and targeted lookups .* whose detail decides your next step or question\. Stop when you can decide the next step/);
    expect(rule).toMatch(inTurn);
    expect(rule).toMatch(/- A task: when finding out needs a worktree \(reproduce, build, prototype\), another runner or model's judgement, or the user's sight and power to stop it, or when a later task will act on its findings\./);
    expect(rule).toMatch(/That later task depends on it and gets the findings in its handoff: do not retell them in its brief/);
    expect(rule).toMatch(/A loop's fix may depend on it only when the check does: make the check depend on it, and the fix reads the report with `read`\./);
    expect(rule).toMatch(/- Search: a problem that needs rounds of branching.* is the explore skill/);
    for (const text of ['WHO EXPLORES:', '- Read it yourself:', '- A task:', '- Search:', 'no pasted file bodies', 'The test:', 'A first plan may be research tasks alone', 'pull its full report with task_output', 'Keep the session fresh']) {
      expect(count(p, text)).toBeLessThanOrEqual(1);
    }
    expect(p).not.toMatch(/should outlive this turn|otherwise run in the background|worth running in the background|Delegate when a piece is independent|parallel read-only scouts/);
  });

  // A planner that re-typed its agents' results into twelve briefs had no test to tell evidence from orientation, and saw no plan it could submit before the evidence was in.
  it.each(backends)('gives a test it can apply on the spot, and a research-only first plan, for $name', ({ harness, runner }) => {
    const rule = section(prompt(harness, runner), 'WHO EXPLORES:');
    expect(rule).toMatch(/The test: if the finding a later task acts on would end up in its brief, a task finds it; if it only decides what you say or ask the user, it stays in your turn\./);
    expect(rule).toMatch(/Make it a research task only when you must decide something on its report; otherwise a read-only task its readers depend on\./);
    expect(rule).toMatch(/Take in a research task's summary, and pull its full report with task_output only where the plan rests on the detail\./);
    expect(rule).toMatch(/- A first plan may be research tasks alone, when the plan cannot be outlined without their evidence: the outline is a line per task saying what it asks, and you plan the rest when their reports wake you\./);
    expect(rule).toMatch(/A vague goal the user can clarify is not one: ask first\./);
  });

  // The procedure is the explore skill's; the rule only points at it, so a planner that explores knows the prototype survives.
  it.each(backends)('points a search between approaches at save_patch and apply_patch, for $name', ({ harness, runner }) => {
    const rule = section(prompt(harness, runner), 'WHO EXPLORES:');
    expect(rule).toMatch(/explorers save their prototypes with save_patch, choose on a check fixed beforehand, and has the build task depend on the chosen explorer and apply its patch with apply_patch/);
    expect(section(prompt(harness, runner), 'READ-ONLY TASKS:')).toMatch(/unless it keeps a prototype with save_patch, which a change task that depends on it applies with apply_patch/);
  });

  it.each(backends)('asks for a digest, one agent per independent question, only where there are agents to brief, for $name', ({ harness, runner }) => {
    const rule = section(prompt(harness, runner), 'WHO EXPLORES:');
    if (runner === 'opencode') {
      expect(rule).not.toMatch(/digest|An agent, awaited/);
      return;
    }
    expect(rule).toMatch(/One agent per independent question, several in parallel; a question whose parts depend on each other stays with one\./);
    expect(rule).toMatch(/One agent for a fact, two to four for a comparison, more only for broad research\./);
    expect(rule).toMatch(/Each returns a digest of about 1-2k tokens: conclusion first, file:line references, decisions found, what is uncertain; no pasted file bodies\./);
  });

  it.each(backends)('keeps the session fresh, naming the turn block by its header and no command, for $name', ({ harness, runner }) => {
    const rule = section(prompt(harness, runner), 'WHO EXPLORES:');
    expect(rule).toMatch(/when you replan, say explicitly what the new plan replaces/);
    expect(rule).toMatch(/before a major decision, restate the current goal, the decisions agreed with the user and the plan/);
    expect(rule).toMatch(/CONTEXT AND BUDGETS shows how full your context is and what remains of your reads/);
    expect(rule).toMatch(/past 40% of its window, suggest compacting at a quiet moment, with no task report pending, using the control your SURFACE AND SETTINGS facts list/);
    expect(rule).not.toMatch(/\/compact|\/clear/);
  });

  it.each(backends)('has every section that delegates refer to the rule instead of restating it, for $name', ({ harness, runner }) => {
    const p = prompt(harness, runner);
    expect(section(p, 'WORKFLOW:')).toMatch(/Orient yourself as WHO EXPLORES says: read only what decides your next step or question, and delegate the rest/);
    expect(section(p, 'STRATEGY:')).toMatch(/research task of its own .*\(WHO EXPLORES\)/);
    expect(section(p, 'STRATEGY:')).toMatch(/An open problem with no known path: a search \(WHO EXPLORES\)/);
    expect(section(p, 'READ-ONLY TASKS:')).toMatch(/whose report should come back to you, as WHO EXPLORES says/);
    expect(section(p, 'RESEARCH PHASE:')).not.toMatch(/WHO EXPLORES|wait for/i);
  });

  it('sits after the defaults and the strategy, and before the reference material', () => {
    const p = prompt(true, 'claude-code');
    const at = (header: string) => p.indexOf(`\n${header}\n`);
    expect(at('DEFAULTS:')).toBeGreaterThan(-1);
    expect(at('DEFAULTS:')).toBeLessThan(at('WORKFLOW:'));
    expect(at('WORKFLOW:')).toBeLessThan(at('STRATEGY:'));
    expect(at('STRATEGY:')).toBeLessThan(at('WHO EXPLORES:'));
    expect(at('WHO EXPLORES:')).toBeLessThan(at('RESEARCH PHASE:'));
    expect(at('WHO EXPLORES:')).toBeLessThan(at('PLAN FORMAT:'));
    expect(p.indexOf('\nUSER GOAL:')).toBeGreaterThan(at('READ-ONLY TASKS:'));
  });

  // The rule is written to be included unchanged in another planner's prompt (#33, #112).
  it('names no section of the prompt around it', () => {
    for (const agents of [inTurnAgents(false), inTurnAgents(true, 'claude-code'), inTurnAgents(true, 'opencode')]) {
      const rule = whoExploresSection(agents).join('\n');
      expect(rule).not.toMatch(/\b(?:DEFAULTS|WORKFLOW|STRATEGY|YOUR CONTEXT|READ-ONLY TASKS|RESEARCH PHASE|LOOPS|BUILD PLANS|RULES)\b/);
    }
  });

  it('tells an API planner whose service has no research subagents to read itself', () => {
    const p = buildConversationSystemPrompt('goal', '', {}, ['gemini'], undefined, { subagents: false });
    const rule = section(p, 'WHO EXPLORES:');
    expect(rule).toMatch(/you have no agents of your own here/);
    expect(rule).not.toContain('spawn_research_agent');
    expect(section(p, 'DEFAULTS:')).not.toMatch(/agents/);
  });

  it('frames spawn_research_agent as orientation, with no research-task text for the one-shot planner it also reaches', () => {
    const tools = buildResearchToolsPrompt();
    expect(tools).toMatch(/Use it for orientation: a subsystem to map, or a "how does X work here" question, when only the conclusion matters to you/);
    expect(tools).toMatch(/the conclusion and file:line references, no pasted file bodies, a few lines per point/);
    expect(tools).not.toMatch(/research task|WHO EXPLORES/);
    expect(oneShot(LONE_REPO)).not.toMatch(/WHO EXPLORES|research task/);
    expect(buildResearchToolsPrompt(false)).not.toContain('spawn_research_agent');
  });
});

describe('the coordinator role and its defaults (#5)', () => {
  const words = (p: string) => p.split(/\s+/).filter(Boolean).length;
  const backends = [
    { harness: false, runner: undefined },
    { harness: true, runner: 'claude-code' },
    { harness: true, runner: 'opencode' },
  ] as const;

  it.each(backends)('casts the planner as the coordinator, not the main worker (harness: $harness, $runner)', ({ harness, runner }) => {
    const p = buildConversationSystemPrompt('goal', '', {}, ['claude-code'], undefined, { harness, runner });
    expect(p).toMatch(/^You are Ordewell's project planner: the coordinator of a run, not its main worker\./);
    expect(p).toMatch(/Your own context is for the whole picture and for integration\./);
  });

  // Users had to append "parallelize as much as possible" and "keep your context clear" to every goal.
  it.each(backends)('defaults to parallel work and delegated evidence, each with its reason (harness: $harness, $runner)', ({ harness, runner }) => {
    const p = buildConversationSystemPrompt('goal', '', {}, ['claude-code'], undefined, { harness, runner });
    const defaults = p.slice(p.indexOf('\nDEFAULTS:\n') + 1, p.indexOf('\n\n', p.indexOf('\nDEFAULTS:\n') + 1));
    expect(defaults).toMatch(/- Run independent work in parallel without being asked: .*running in turn what nothing orders only takes longer\./);
    expect(defaults).toMatch(/- Send evidence-gathering to .*research tasks, so only their digests reach you: raw file bodies would crowd the decisions out of your context\./);
    expect(p.indexOf('\nDEFAULTS:\n')).toBeLessThan(p.indexOf('\nWHO EXPLORES:\n'));
  });

  // The planner orients from guides, a map and targeted lookups, never by reading the codebase through.
  it.each(backends)('never tells the planner to explore the repository until it understands its architecture (harness: $harness, $runner)', ({ harness, runner }) => {
    const p = buildConversationSystemPrompt('goal', '', {}, ['claude-code'], undefined, { harness, runner });
    expect(p).not.toContain('Explore the repository with your own tools');
    expect(p).not.toContain('until you understand its architecture');
    expect(p).not.toMatch(/Read key source files to understand architecture|depth=2-3/);
  });

  it('gives the one-shot planner the same parallelism rule as the conversation', () => {
    for (const p of [oneShot(false), oneShot(LONE_REPO), conversation(false)]) {
      for (const line of PARALLELISM_RULE) expect(p).toContain(line);
    }
  });

  // Every line of the system prompt is paid for on each turn; the rewrite had to fit in what was there.
  it('keeps the harness prompt within its word budget', () => {
    const p = buildConversationSystemPrompt('goal', '', {}, ['claude-code'], undefined, {
      harness: true, runner: 'claude-code', autorun: true, execution: true, isolatedExecution: { repos: ['.'], shared: [] },
    });
    expect(words(p)).toBeLessThanOrEqual(5210);
  });
});

describe('sealed runs for the planner itself (ADR-0036)', () => {
  const research = (p: string) => p.slice(p.indexOf('\nRESEARCH PHASE:\n'), p.indexOf('\n\n', p.indexOf('\nRESEARCH PHASE:\n') + 1));

  it('says what run_command with "sealed": true is for, and what a sealed run lacks, for the harness planner', () => {
    const phase = research(buildConversationSystemPrompt('goal', '', {}, ['claude-code'], undefined, { harness: true }));
    expect(phase).toMatch(/run_command with "sealed": true runs a command without asking anyone, for local computation over the workspace: a loop over files, a script, a pipe into an interpreter/);
    expect(phase).toMatch(/no network, the workspace read-only, and no home directory or credentials/);
    expect(phase).toMatch(/would be refused for being a loop, a here-document or a pipe into an interpreter runs sealed on its own where this machine has a sandbox/);
    expect(phase).toMatch(/Never seal a command that needs the network or the user's accounts/);
  });

  it('says the same of bash for the API planner', () => {
    const phase = research(buildConversationSystemPrompt('goal', '', {}, ['claude-code'], undefined, { harness: false }));
    expect(phase).toMatch(/bash with "sealed": true runs a command without asking anyone/);
    expect(phase).not.toContain('run_command');
  });
});

describe('planner parallelism rules under worktree isolation (ADR-0013)', () => {
  const OVERLAP_RULE = '- For parallel tasks, specify different target files to avoid merge conflicts.';

  it('keeps today\'s overlap-avoidance text verbatim when tasks share the workspace', () => {
    expect(conversation(false)).toContain([
      'DEPENDENCY & PARALLELISM:',
      ...PARALLELISM_RULE,
      '- Only add dependencies when a slice truly depends on artifacts another slice creates.',
    ].join('\n'));
    expect(conversation(false)).toContain(OVERLAP_RULE);

    const p = oneShot(false);
    for (const line of PARALLELISM_RULE) expect(p).toContain(line);
    expect(p).toContain('- Slices that touch different areas of the codebase are naturally parallel.');
    expect(p).toContain(OVERLAP_RULE);
  });

  const SHARED_APPEND_FILE_RULE =
    '- Tasks that run in parallel must not each append to the same shared file (changelogs, registries, index lists) — give that edit to the final task, or to one task the others depend on.';

  it('tells the planner not to give parallel tasks the same shared append file', () => {
    for (const p of [conversation(false), conversation(LONE_REPO), oneShot(false), oneShot(LONE_REPO)]) {
      expect(p).toContain(SHARED_APPEND_FILE_RULE);
    }
  });

  it('has task prompts name files from the workspace root, never by absolute path, when every task gets its own worktree', () => {
    for (const p of [conversation(LONE_REPO), oneShot(LONE_REPO)]) {
      expect(p).toMatch(/path from the workspace root, never by an absolute path/i);
      expect(p).toMatch(/absolute path .*user's own checkout/i);
    }
    for (const p of [conversation(false), oneShot(false)]) expect(p).not.toMatch(/never by an absolute path/i);
  });

  it('stops asking for different files or file-overlap dependencies when every task gets its own worktree', () => {
    for (const p of [conversation(LONE_REPO), oneShot(LONE_REPO)]) {
      expect(p).not.toContain(OVERLAP_RULE);
      expect(p).not.toContain('no shared files/modules');
      expect(p).toMatch(/own git worktree/i);
      expect(p).toMatch(/never add a dependency just because two tasks touch the same file/i);
    }
  });

  it('still asks for dependencies that reflect genuine ordering', () => {
    expect(conversation(LONE_REPO)).toContain('- Only add dependencies when a slice truly depends on artifacts another slice creates.');
    expect(oneShot(LONE_REPO)).toContain('- Only add dependencies when the second slice truly depends on artifacts (files, APIs) that the first slice creates.');
  });
});

describe('planner rules for a repo group (ADR-0014)', () => {
  const GROUP: RepoGroupLayout = { repos: ['api', 'web'], shared: ['NOTES.md', 'design'] };
  const builders = { conversation, oneShot };

  /** The prompt with its repo-group section cut out, line for line. */
  function withoutGroupSection(prompt: string): string {
    const lines = prompt.split('\n');
    const at = lines.indexOf('REPO GROUP:');
    let end = at + 1;
    while (lines[end]?.startsWith('- ')) end++;
    return [...lines.slice(0, at - 1), ...lines.slice(end)].join('\n');
  }

  it.each(Object.entries(builders))('tells the %s planner the repos, the shared paths, and what a task sees and lands', (_name, build) => {
    const p = build(GROUP);

    expect(p).toContain('\n\nREPO GROUP:\n');
    expect(p).toContain('- The workspace is a folder of git repositories isolated together: api, web (paths relative to the workspace).');
    expect(p).toMatch(/every task sees all of them at these same relative paths/i);
    expect(p).toMatch(/lands atomically: its changes to every repository it touched are merged together, or none are/i);
    expect(p).toContain('NOTES.md, design');
    expect(p).toMatch(/shared paths are live[^\n]*two tasks that edit the same shared path must not run in parallel/i);
  });

  it.each(Object.entries(builders))('otherwise gives the %s planner exactly the prompt a lone repository gets', (_name, build) => {
    expect(build(LONE_REPO)).not.toContain('REPO GROUP');
    expect(withoutGroupSection(build(GROUP))).toBe(build(LONE_REPO));
  });

  it('says nothing about shared paths when there are none', () => {
    const p = conversation({ repos: ['api', 'web'], shared: [] });
    expect(p).toContain('REPO GROUP:');
    expect(p).not.toMatch(/shared path/i);
  });

  it('tells the planner about repositories nested in a lone repository, linked live', () => {
    const nested: RepoGroupLayout = { repos: ['.'], shared: ['services/billing'] };
    const p = conversation(nested);
    expect(p).toContain('\n\nNESTED REPOSITORIES:\n');
    expect(p).toContain('services/billing');
    expect(p).toMatch(/two tasks that edit the same one must not run in parallel/i);
  });

  it('says nothing extra for a lone repository with no nested repositories', () => {
    for (const build of Object.values(builders)) {
      expect(build(LONE_REPO)).not.toMatch(/NESTED REPOSITORIES|REPO GROUP/);
    }
  });

  it('never tells a planner whose tasks share the workspace root about a group', () => {
    for (const build of Object.values(builders)) expect(build(false)).not.toContain('REPO GROUP');
  });
});

describe('the resolver task prompt', () => {
  const conflicted = createTask({ id: 't1', order: 3, title: 'Edit both', prompt: 'change the API and its client' });

  it('reads as it always has for a repository that is the whole workspace, its merge named for the task', () => {
    expect(buildConflictResolutionPrompt(conflicted, { branch: 'ordewell/r1/3-edit-both', message: 'Merge: Edit both (resolve conflicts with integration)', repos: ['.'], conflictRepo: '.' }, 'ordewell/r1/integration')).toBe([
      'Task #3 "Edit both" passed, but merging its branch `ordewell/r1/3-edit-both` into `ordewell/r1/integration` conflicted.',
      'This working tree starts at the tip of `ordewell/r1/integration`. Run `git merge --no-ff -m \'Merge: Edit both (resolve conflicts with integration)\' ordewell/r1/3-edit-both` here and resolve every conflict so that both sides\' intent survives: keep the work already integrated and add what the task contributed. Do not drop either side wholesale.',
      'Build and test the result the way this project does, then commit the merge with `git commit --no-edit --cleanup=strip`.',
      '',
      'What the task was asked to do:\nchange the API and its client',
    ].join('\n'));
  });

  it('has the branch merged in every repository the task changed, since none of it landed, and names where it conflicted', () => {
    const p = buildConflictResolutionPrompt(conflicted, { branch: 'ordewell/r1/3-edit-both', message: 'Merge: Edit both (resolve conflicts with integration)', repos: ['api', 'web'], conflictRepo: 'web' }, 'ordewell/r1/integration');

    expect(p).toContain('conflicted in web');
    expect(p).toMatch(/lands in every repository it changed or in none/);
    expect(p).toContain('In each repository the task changed — api, web — run `git merge --no-ff -m \'Merge: Edit both (resolve conflicts with integration)\' ordewell/r1/3-edit-both` inside that repository');
    expect(p).toContain('commit the merge in each repository with `git commit --no-edit --cleanup=strip`');
    expect(p).toContain('change the API and its client');
  });
});

describe('a landing-conflict prompt for a subtask', () => {
  const subtask = createTask({ id: 's1', order: 1, title: 'Edit both', prompt: 'change the API and its client' });
  const plan = [
    createTask({ id: 't1', order: 1, title: 'Setup' }),
    createTask({ id: 'p2', order: 2, title: 'Parent', subtasks: [subtask] }),
  ];

  it('names the subtask by its dotted reference against the plan tree', () => {
    const p = buildConflictResolutionPrompt(subtask, { branch: 'ordewell/r1/2.1-edit-both', message: 'Merge: Edit both (resolve conflicts with integration)', repos: ['.'], conflictRepo: '.' }, 'ordewell/r1/integration', plan);

    expect(p.split('\n')[0]).toBe('Task #2.1 "Edit both" passed, but merging its branch `ordewell/r1/2.1-edit-both` into `ordewell/r1/integration` conflicted.');
  });
});

describe('the conflict repair prompt', () => {
  const conflicted = createTask({ id: 't1', order: 3, title: 'Edit both', prompt: 'change the API and its client' });

  it('has a repository that is the whole workspace merge the integration tip into the task\'s own worktree', () => {
    const conflict = { branch: 'ordewell/r1/3-edit-both', message: 'Merge: Edit both (resolve conflicts with integration)', repos: ['.'], conflictRepo: '.', conflictFiles: ['src/api.ts', 'src/client.ts'] };
    expect(buildConflictRepairPrompt(conflicted, conflict, 'ordewell/r1/integration')).toBe([
      'Task #3 "Edit both" passed, but merging its branch `ordewell/r1/3-edit-both` into `ordewell/r1/integration` conflicted in src/api.ts, src/client.ts. None of its work has landed yet.',
      'This is the task\'s own worktree, on `ordewell/r1/3-edit-both`, with its work committed. Run `git merge --no-edit -m \'Merge: Edit both (resolve conflicts with integration)\' ordewell/r1/integration` here and resolve every conflict so that both sides\' intent survives: keep the work already integrated and add what the task contributed. Never drop either side wholesale, and never abort the merge or reset it away.',
      'Build and test the result the way this project does, commit the merge with `git commit --no-edit --cleanup=strip`, and only then call `task_complete`.',
      '',
      'What the task was asked to do:\nchange the API and its client',
    ].join('\n'));
  });

  it('reads plainly when git named no files', () => {
    const p = buildConflictRepairPrompt(conflicted, { branch: 'ordewell/r1/3-edit-both', message: 'Merge: Edit both (resolve conflicts with integration)', repos: ['.'] }, 'ordewell/r1/integration');
    expect(p.split('\n')[0]).toBe('Task #3 "Edit both" passed, but merging its branch `ordewell/r1/3-edit-both` into `ordewell/r1/integration` conflicted. None of its work has landed yet.');
  });

  it('has the tip merged in every repository the task changed, naming the one that conflicted and its files', () => {
    const conflict = { branch: 'ordewell/r1/3-edit-both', message: 'Merge: Edit both (resolve conflicts with integration)', repos: ['api', 'web'], conflictRepo: 'web', conflictFiles: ['web.txt'] };
    const p = buildConflictRepairPrompt(conflicted, conflict, 'ordewell/r1/integration');

    expect(p).toContain('landing its branch `ordewell/r1/3-edit-both` on `ordewell/r1/integration` conflicted in web (web.txt)');
    expect(p).toMatch(/lands in every repository it changed or in none/);
    expect(p).toContain('In each repository the task changed — api, web — run `git merge --no-edit -m \'Merge: Edit both (resolve conflicts with integration)\' ordewell/r1/integration` inside that repository\'s directory');
    expect(p).toMatch(/Never drop either side wholesale, and never abort a merge or reset it away/);
    expect(p).toContain('commit the merge in each repository with `git commit --no-edit --cleanup=strip`, and only then call `task_complete`');
    expect(p).toContain('What the task was asked to do:\nchange the API and its client');
  });
});

describe('planner rules for change and ops tasks (ADR-0020)', () => {
  it('gives every planner the one test, the field, the split and the ordering of colliding git operations', () => {
    for (const p of [conversation(false), conversation(LONE_REPO), oneShot(false), oneShot(LONE_REPO)]) {
      expect(p).toContain('CHANGE AND OPS TASKS:');
      expect(p).toContain('is the task\'s result a change to files in the repository?');
      expect(p).toContain('"ops": true');
      expect(p).toMatch(/bump the version and redeploy/);
      expect(p).toMatch(/a push and a reword of the same branch\) must not run in parallel — make one depend on the other/);
    }
  });

  it('tells only the conversation planner that a question is not a task', () => {
    expect(conversation(LONE_REPO)).toContain('A question is not a task');
    expect(oneShot(LONE_REPO)).not.toContain('A question is not a task');
  });
});

describe('the outline gate and autorun (ADR-0030)', () => {
  const prompt = (harness: boolean, autorun?: boolean) =>
    buildConversationSystemPrompt('goal', '', {}, ['claude-code'], undefined, { harness, autorun });

  it.each([true, false])('waits for the outline to be confirmed with autorun off (harness: %s)', (harness) => {
    const p = prompt(harness, false);
    expect(p).toContain('After the user confirms the outline');
    expect(p).toMatch(/Do not skip the outline/);
  });

  it.each([true, false])('with autorun on, writes the outline as the summary and submits without waiting, still asking what is unclear (harness: %s)', (harness) => {
    const p = prompt(harness, true);
    expect(p).not.toContain('After the user confirms the outline');
    expect(p).not.toMatch(/Do not skip the outline/);
    expect(p).toMatch(/AUTORUN is on/);
    expect(p).toMatch(/do not wait for the user to confirm it/i);
    expect(p).toMatch(/ask the user before planning rather than assume/);
  });
});

describe('the strategy step and the context rules (#108)', () => {
  const prompt = (harness: boolean, extra: { execution?: boolean; autorun?: boolean } = {}) =>
    buildConversationSystemPrompt('goal', '', {}, ['claude-code'], undefined, { harness, ...extra });
  const variants = [false, true].flatMap((harness) => [false, true].map((execution) => ({ harness, execution })));

  /** One section's text: from its header to the blank line that ends it. */
  function section(p: string, header: string): string {
    const at = p.indexOf(`\n${header}\n`);
    expect(at).toBeGreaterThan(-1);
    const end = p.indexOf('\n\n', at + 1);
    return p.slice(at + 1, end === -1 ? undefined : end);
  }

  it.each(variants)('chooses a strategy before the outline (%o)', ({ harness, execution }) => {
    const p = prompt(harness, { execution });
    expect(p.indexOf('\nSTRATEGY:\n')).toBeLessThan(p.indexOf('\nOUTLINE PHASE:\n'));
    expect(p).toMatch(/3\. Choose a strategy for the goal \(STRATEGY below\)/);
    expect(p).toMatch(/4\. When the strategy calls for a plan/);
  });

  it.each(variants)('teaches each kind of goal (%o)', ({ harness, execution }) => {
    const strategy = section(prompt(harness, { execution }), 'STRATEGY:');
    expect(strategy).toMatch(/- A question your research can answer: answer it here, in your reply\. No plan\./);
    expect(strategy).toMatch(/- A small effect you can state as exact commands: one script task\b/);
    expect(strategy).toMatch(/An effect that needs judgment is an ops task\./);
    expect(strategy).toMatch(/- A build with known steps: a plan of vertical slices, under BUILD PLANS below\./);
    expect(strategy).toMatch(/- A failure to explain: reproduce it first, investigate competing hypotheses in parallel, then fix\./);
    expect(strategy).toMatch(/failing test or a command that fails is the reproduction, and what the fix is checked against/);
    expect(strategy).toMatch(/Plan the fix once the reports name the cause/);
    expect(strategy).toMatch(/- An open problem with no known path: a search \(WHO EXPLORES\)\. Plan only the first round of exploration, as research tasks/);
    expect(strategy).toMatch(/extend the plan with the next round/);
  });

  it('offers run_script for an exact effect only where the execution tools are', () => {
    for (const harness of [false, true]) {
      expect(section(prompt(harness, { execution: true }), 'STRATEGY:')).toMatch(/In the user's turn, run it with run_script/);
      const without = section(prompt(harness), 'STRATEGY:');
      expect(without).not.toContain('run_script');
      expect(without).toMatch(/one script task, in a plan of its own/);
    }
  });

  it.each(variants)('tells the planner how to spend its context (%o)', ({ harness, execution }) => {
    const p = prompt(harness, { execution });
    expect(p).toMatch(/Your own context is for the whole picture and for integration\./);
    const rules = section(p, 'WHO EXPLORES:');
    expect(rules).toMatch(/Stop when you can decide the next step, not when you understand the whole architecture/);
    expect(rules).toMatch(/self-contained brief, since a task never sees this conversation: its goal, its inputs, what to report back, and how its result will be checked/);
    expect(rules).toMatch(/Plan the integration step/);
    expect(rules).toMatch(/prefer evidence you can check .* over a task's own word/);
    expect(rules).toMatch(/how full your context is and what remains of your reads/);
    expect(p).not.toContain('\nYOUR CONTEXT:\n');
  });

  it('keeps every slicing rule under BUILD PLANS, and nowhere a non-build goal would read it as its own', () => {
    for (const isolated of [false, LONE_REPO] as const) {
      for (const harness of [false, true]) {
        const p = buildConversationSystemPrompt('goal', '', {}, ['claude-code'], undefined, { harness, isolatedExecution: isolated });
        const build = section(p, 'BUILD PLANS:');
        expect(build).toMatch(/^BUILD PLANS:\nWhen the strategy is a build, these rules apply as well\. No other strategy is planned as vertical slices\./);
        const buildOnly = [
          'VERTICAL TRACER-BULLET SLICE',
          'Size each slice to fit a single fresh agent session',
          'make the change easy, then make the easy change',
          'EXPAND-CONTRACT',
          '"userStoriesCovered" links a slice to the user stories it delivers',
          'Reference specific files and patterns from your research in task prompts.',
          'must not each append to the same shared file',
          ...(isolated ? [] : ['specify different target files to avoid merge conflicts']),
        ];
        for (const rule of buildOnly) {
          expect(build).toContain(rule);
          expect(p.split(rule)).toHaveLength(2);
        }
      }
    }
  });

  it('keeps the rules every plan needs outside BUILD PLANS', () => {
    const p = buildConversationSystemPrompt('goal', '', {}, ['claude-code'], undefined, { isolatedExecution: LONE_REPO });
    const build = section(p, 'BUILD PLANS:');
    for (const general of ['never by an absolute path', 'Never add a dependency just because two tasks touch the same file', 'CHANGE AND OPS TASKS:', '"sliceType" is required on every task']) {
      expect(p).toContain(general);
      expect(build).not.toContain(general);
    }
  });

  it('shows the outline example as a build\'s, not as the shape of every outline', () => {
    const p = prompt(false);
    expect(p).toContain('a numbered list of the plan\'s tasks in order');
    expect(p).toContain('For a build, each item is a vertical tracer-bullet slice');
    expect(p).toContain('- Example, for a build: "1. Set up database schema');
  });
});

describe('script tasks in the conversation prompt (ADR-0035)', () => {
  const prompt = (harness: boolean) => buildConversationSystemPrompt('goal', '', {}, ['claude-code'], undefined, { harness });

  it.each([false, true])('teaches the plan JSON for a script task (harness: %s)', (harness) => {
    const p = prompt(harness);
    expect(p).toContain('"type": "ai|user|script"');
    expect(p).toContain('"type": "script", "dependencies": ["task-2"], "commands": [["git", "push", "origin", "release"]], "sliceType": "AFK"');
    expect(p).toMatch(/"commands" is a list of argument vectors, run in order with no shell, stopping at the first that fails/);
    expect(p).toMatch(/give "script" instead.*Give exactly one of the two/);
    expect(p).toMatch(/"timeoutMs" is its time limit in milliseconds; ten minutes when left out/);
    expect(p).toContain('Only a top-level task can be one. Leave out ' + forbiddenFields('script').map((f) => `"${f}"`).join(', ') + '.');
  });

  it('shows an example the plan\'s own rules accept', () => {
    const example = prompt(true).split('\n').find((line) => line.includes('"type": "script"'));
    const dependency = { id: 'task-2', title: 'Fix', type: 'ai', prompt: 'fix it', assignedRunner: 'claude-code', autonomy: 'AFK', sliceType: 'AFK' };
    const result = validatePlanTasks({ tasks: [dependency, JSON.parse(example ?? '')] }, ['claude-code']);
    expect(result).toMatchObject({ ok: true });
  });

  it('points a refused command in the harness planner\'s research at a script task or an ops task', () => {
    expect(prompt(true)).toContain('add it to the plan instead: a script task when you can state the exact commands, an ops task when it needs judgment');
  });

  it('gives the conversation planner the three shapes of a change to the world, and the one-shot planner none of it', () => {
    const p = conversation(LONE_REPO);
    expect(p).toMatch(/A script task when you can state the exact commands.*An ops task when the work needs judgment.*A change task for files\./);
    expect(p).toMatch(/A script task is an ops task in where and when it runs/);
    expect(oneShot(LONE_REPO)).not.toMatch(/script task/i);
  });
});

describe('loops in the conversation prompt (ADR-0045)', () => {
  const prompt = (harness: boolean, extra: { execution?: boolean } = {}) =>
    buildConversationSystemPrompt('goal', '', {}, ['claude-code'], undefined, { harness, ...extra });
  const variants = [false, true].flatMap((harness) => [false, true].map((execution) => ({ harness, execution })));

  function section(p: string, header: string): string {
    const at = p.indexOf(`\n${header}\n`);
    expect(at).toBeGreaterThan(-1);
    const end = p.indexOf('\n\n', at + 1);
    return p.slice(at + 1, end === -1 ? undefined : end);
  }

  it.each(variants)('places loops under the build and the failure to explain, and as a kind of goal of their own (%o)', ({ harness, execution }) => {
    const strategy = section(prompt(harness, { execution }), 'STRATEGY:');
    expect(strategy).toMatch(/- A build with known steps:.*Its tests, type checks and self-review belong inside its implementation tasks\./);
    expect(strategy).toMatch(/- A failure to explain:.*A simple fix reproduces and validates its regression within its own task\./);
    expect(strategy).not.toMatch(/end it with a loop|make it the check of a loop/);
    expect(strategy).toMatch(/- A goal the user states as done only when something passes \("until the tests pass", "review and fix until there are no confirmed issues"\): a loop, under LOOPS below\./);
  });

  it.each(variants)('teaches the loop field, its check and its body (%o)', ({ harness, execution }) => {
    const p = prompt(harness, { execution });
    expect(p.indexOf('\nLOOPS:\n')).toBeGreaterThan(p.indexOf('\nBUILD PLANS:\n'));
    const loops = section(p, 'LOOPS:');
    expect(loops).toMatch(/Ordewell runs the rounds itself, with no turn of yours in between/);
    expect(loops).toMatch(/Use one only for an explicit iterate-until goal or a specific acceptance condition that needs independent repeated checking and fixing: tests that exist, a command that can be rerun or code that changed never make a loop\. When you infer a loop the user did not ask for, give its reason in the outline\./);
    expect(loops).not.toMatch(/a plan without such a bar/);
    expect(loops).toContain('"loop": { "body": ["fix-id", ...], "maxRounds": 3 }');
    expect(loops).toMatch(/Each depends on the check, and otherwise only on what the check depends on or on other tasks of the body/);
    // The research-dependency rule is stated once, in WHO EXPLORES.
    expect(section(p, 'WHO EXPLORES:')).toMatch(/A loop's fix may depend on it only when the check does: make the check depend on it, and the fix reads the report with `read`\./);
    expect(loops).toMatch(/Whatever comes after the loop depends on the check, never on a body task/);
    expect(loops).toMatch(/top-level AI or script task with no subtasks/);
    expect(loops).toMatch(/never a manual task/);
  });

  it('teaches the three ops that add a loop with edit_plan, in order', () => {
    for (const harness of [false, true]) {
      const loops = section(prompt(harness), 'LOOPS:');
      expect(loops).toMatch(/(?:with edit_plan|in a task-ops reply), takes three ops in this order, since a handle cannot be referenced before the op that defines it: add the check without "loop", with a "handle"; add each body task, depending on the check's handle.*then update the check, by its handle, with "loop": \{"body": \[the body handles\]/);
      expect(loops).toMatch(/(?:submit_plan|A whole plan) names ids directly, so it needs no handles/);
    }
  });

  it('prefers a script check, and has an AI check report failed with its findings and done without any', () => {
    const loops = section(prompt(true), 'LOOPS:');
    expect(loops).toMatch(/Make the check test the acceptance condition itself, such as a test written against the spec, not merely that the suite is green, and write that test apart from the fix where you can, in a task before the loop, so the fix cannot bend it\./);
    expect(loops).toMatch(/Prefer a script task as the check wherever a command can judge the work: its exit status is evidence you can check, 0 passes and anything else fails and starts a round/);
    expect(loops).toMatch(/confirms each problem by reproducing it \(a failing test, a command and its output, or a file:line with the input that breaks it\) and drops what it cannot reproduce/);
    expect(loops).toMatch(/adversarial review.*task_complete with status "failed" and every confirmed problem in its report when it finds any, and "done" when it confirms none/);
    expect(loops).toMatch(/Only a "failed" report starts a round: "blocked".*start none/);
  });

  it('hands the body the check\'s report and has the planner choose the rounds', () => {
    const loops = section(prompt(false), 'LOOPS:');
    expect(loops).toMatch(/given the check's latest report as its prior task output, told which round it is from/);
    expect(loops).toMatch(/Choose "maxRounds" deliberately, from 1 to 10; it is 3 when left out/);
    expect(loops).toMatch(/A check that fails its last round fails, and the tasks after it are blocked/);
  });

  it.each([false, true])('teaches the plan JSON for a loop in PLAN FORMAT (harness: %s)', (harness) => {
    const p = prompt(harness);
    const format = p.slice(p.indexOf('\nPLAN FORMAT:\n'), p.indexOf('\nSLICE CLASSIFICATION:\n'));
    expect(format).toContain('"loop": { "body": ["fix-1"], "maxRounds": 3 }');
    expect(format).toContain('"loop": { "body": ["fix-2"] }');
    expect(format).toContain('"readOnly": true');
  });

  it('shows examples the plan\'s own rules accept', () => {
    const lines = prompt(true).split('\n').filter((line) => /^\{ "id": "(tests-1|fix-1|review-1)"/.test(line)).map((line) => JSON.parse(line));
    expect(lines.map((t) => t.id)).toEqual(['tests-1', 'fix-1', 'review-1']);
    const ai = (id: string, over: Record<string, unknown> = {}) => ({ id, title: id, type: 'ai', prompt: 'do it', assignedRunner: 'claude-code', autonomy: 'AFK', sliceType: 'AFK', dependencies: [], ...over });
    const [tests, fix, review] = lines;
    expect(review.prompt).toMatch(/Confirm each problem by reproducing it: a failing test, a command and its output, or a file:line with the input that breaks it\. Drop what you cannot reproduce\./);
    expect(validatePlanTasks({ tasks: [ai('task-3'), tests, fix] }, ['claude-code'])).toMatchObject({ ok: true });
    expect(validatePlanTasks({ tasks: [ai('task-3'), review, ai('fix-2', { dependencies: ['review-1'] })] }, ['claude-code'])).toMatchObject({ ok: true });
  });

  it('is in the conversation prompt only, not the one-shot planner\'s', () => {
    expect(oneShot(LONE_REPO)).not.toMatch(/\bLOOPS:|"loop"/);
  });
});

describe('the edit protocol explains loop and research (ADR-0045, ADR-0037)', () => {
  it.each([false, true])('explains the loop field and the order of the ops that add one (tools: %s)', (tools) => {
    const protocol = taskOpsProtocol('', tools).join('\n');
    expect(protocol).toMatch(/"loop" makes a task the check of a loop .*\{"body": \["<id, #order or handle>", \.\.\.\], "maxRounds"\?: 1 to 10\}; null drops the loop/);
    expect(protocol).toMatch(/adding a loop takes three ops in this order: "add" the check without "loop", with a "handle"; "add" each body task, depending on the check's handle.*then "update" the check, by its handle, with "loop": \{"body": \[the body handles\]\}/);
  });

  it('lists research on an added task and explains it', () => {
    const protocol = taskOpsProtocol('', true).join('\n');
    expect(protocol).toContain('"readOnly"?,"research"?,"ops"?');
    expect(protocol).toMatch(/"research": true on a read-only top-level AI task makes it a research task, whose task_complete report wakes you/);
  });
});

describe('delegation in the planner prompt (ADR-0055 D4, D21)', () => {
  const modes = { 'claude-code': [{ id: 'plan', label: 'Plan', description: '', readOnly: true }, { id: 'build', label: 'Build', description: '' }] };
  const base = { harness: true, runner: 'claude-code', execution: true, autorun: true, isolatedExecution: { repos: ['.'], shared: [] } };
  const prompt = (variant: Parameters<typeof buildConversationSystemPrompt>[5] = {}) => buildConversationSystemPrompt('The goal', 'context', {}, ['claude-code'], modes, { ...base, ...variant });
  const delegation = { tokens: 3_000_000, delegatedTasks: 8, grantable: ['research', 'delegate'] };
  const brief = { protectedPaths: ['tests/', 'package.json'], readOnly: false, runner: 'claude-code' as const };

  it('says nothing of delegation when it is off, and adds one section when it is on: nothing else moves', () => {
    const off = prompt();
    const on = prompt({ delegation });
    expect(off).not.toMatch(/"delegated"|DELEGATED TASKS/);
    const section = on.slice(on.indexOf('DELEGATED TASKS:'), on.indexOf('RULES:'));
    expect(section).toContain('"type": "delegated"');
    expect(section).toContain('this plan has 3000000 tokens left');
    expect(section).toMatch(/budgets of its delegated tasks still to run cannot together pass that/);
    expect(on.replace(section, '')).toBe(off);
  });

  it('teaches a flat plan as the default, a separable subdomain, a budget, the paths and a check', () => {
    const on = prompt({ delegation });
    expect(on).toMatch(/flat plan stays the default: delegate only a separable subdomain/);
    expect(on).toMatch(/One coherent feature, or a change with cross-cutting invariants, stays flat/);
    expect(on).toMatch(/"protectedPaths" is required unless "readOnly"/);
    expect(on).toMatch(/from the repository's root, whatever their case/);
    expect(on).toMatch(/Every delegated task needs a check/);
  });

  it('names no user to a subplanner, who has none, save the words of a plan\'s fields', () => {
    const lines = prompt({ subplanner: brief }).split('\n');
    const naming = lines.filter((line) => /\buser\b/i.test(line.replace(/"type": "ai\|user\|script"|"userSteps"|userSteps|"userStoriesCovered"|user stories|user story|"user"|users and sessions|user steps/g, '')));
    expect(naming).toEqual([]);
  });

  it('tells a subplanner how it ends, what it may not change, and that nobody answers it', () => {
    const text = prompt({ subplanner: brief });
    expect(text.startsWith('You are a subplanner')).toBe(true);
    expect(text).toMatch(/You end this one way: call task_complete/);
    expect(text).toContain('These paths may not change: tests/, package.json.');
    expect(text).toMatch(/nobody answers a question/);
    expect(text).toMatch(/Ops tasks and manual tasks do not exist here/);
    expect(text).toMatch(/YOUR GOAL: The goal/);
    expect(text).not.toMatch(/plan_complete|ask_parent/);
  });

  it('asks a read-only subplanner for no change and names no paths', () => {
    const text = prompt({ subplanner: { protectedPaths: [], readOnly: true, runner: 'claude-code' } });
    expect(text).toMatch(/This task lands nothing/);
    expect(text).not.toMatch(/These paths may not change/);
  });

  it('tells a subplanner its own runner and models, so a plan takes no call to read them', () => {
    const models = { 'claude-code': [{ modelId: 'haiku', modelLabel: 'Haiku', variants: [{ id: 'low', label: 'Low' }, { id: 'high', label: 'High' }] }, { modelId: 'sonnet', modelLabel: 'Sonnet', variants: [] }] };
    const text = buildConversationSystemPrompt('The goal', 'context', models, ['claude-code'], modes, { ...base, subplanner: brief });
    expect(text).toContain('You plan on "claude-code". Its models: haiku (low, high), sonnet.');
    expect(text).toMatch(/Call list_runners and list_models only to assign another runner/);
    expect(text).not.toMatch(/Call list_runners: the enabled runners|Read them just before you submit|then call list_runners and list_models/);
  });

  it('sends a subplanner to list_models when it has no list to be told', () => {
    expect(prompt({ subplanner: brief })).toContain('You plan on "claude-code". Call list_models before you assign a model.');
  });

  it('asks a subplanner for no outline: nobody reads one', () => {
    const text = prompt({ subplanner: brief });
    expect(text).not.toMatch(/prose outline|the outline in your reply/);
    expect(text).toMatch(/end your reply with one line/);
  });

  it('leaves out what does not exist below the root', () => {
    const text = prompt({ subplanner: brief });
    expect(text).not.toContain('CHANGE AND OPS TASKS:');
    expect(text).toContain('BUILD PLANS:');
    expect(prompt()).toContain('CHANGE AND OPS TASKS:');
  });

  it('teaches a planner the catalog and the outline as before', () => {
    const text = prompt();
    expect(text).toContain('1. Call list_runners: the enabled runners');
    expect(text).toMatch(/outline/);
  });

  it('teaches a subplanner that holds `delegate` too', () => {
    const text = prompt({ subplanner: brief, delegation });
    expect(text).toContain('DELEGATED TASKS:');
    expect(text.startsWith('You are a subplanner')).toBe(true);
  });
});
