/**
 * The mechanical metrics of one planning run, read from what the daemon
 * served for the session once the driver stopped. Pure: no file, process or
 * clock, so `planner-eval.test.mjs` proves every number on a hand-built session.
 *
 * Width and critical path are taken over the top-level tasks: a subtask runs
 * inside its parent, so it widens nothing the scheduler sees.
 */

/** Tools the planner runs itself to see the code, as `ResearchToolType` names them (packages/core/src/models/Task.ts). */
export const OWN_READ_TOOLS = new Set([
  'read_file', 'read_files', 'glob', 'grep', 'find_symbol', 'list_dir', 'bash', 'fetch', 'web_search',
  'task_query', 'task_output', 'task_diff',
]);

/**
 * Task modes that runners tag read-only. The tag is per runner (TaskEdit.ts
 * `isReadOnly` asks the catalog), and a session file carries no catalog, so
 * these are the names the built-in runners use.
 */
export const READ_ONLY_MODES = new Set(['plan', 'read-only', 'readonly', 'read_only', 'ask']);

/** A harness planner's own in-turn agent tool, by the name it reports (Claude Code's `Agent`/`Task`, OpenCode's `task`). */
const AGENT_TOOL_LABELS = /^(agent|task|subagent|spawn_?agent)$/i;

/**
 * Ordewell's research agent as a harness reports an MCP tool: Claude Code
 * `mcp__ordewell__spawn_research_agent`, OpenCode `ordewell_spawn_research_agent`
 * (server name, one underscore), both with or without the prefix.
 */
const RESEARCH_AGENT_TOOL = /^(?:(?:mcp__)?ordewell_{1,2})?spawn_research_agent$/i;

/** The session pieces every metric reads, from a `GET /api/sessions/:id` body or a saved session file. */
export function sessionParts(session, researchLog) {
  const plan = session?.plan ?? {};
  const conversation = session?.conversation ?? {};
  return {
    // The daemon serves the phase-tagged plan, whose tasks before approval are `pendingTasks`; a saved file's are `tasks`.
    tasks: [plan.pendingTasks, plan.tasks].find(Array.isArray) ?? [],
    history: conversation.conversationHistory ?? plan.conversationHistory ?? [],
    researchLog: researchLog ?? conversation.researchLog ?? plan.researchLog ?? [],
    usage: conversation.plannerUsage ?? plan.plannerUsage ?? null,
    runSettings: plan.runSettings ?? {},
  };
}

export function flatten(tasks) {
  const out = [];
  for (const task of tasks ?? []) {
    out.push(task);
    if (Array.isArray(task.subtasks)) out.push(...flatten(task.subtasks));
  }
  return out;
}

/** For each task id, every task id reachable through its dependencies. Unknown ids are ignored; a cycle terminates. */
export function ancestors(tasks) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const memo = new Map();
  const visit = (id, seen) => {
    if (memo.has(id)) return memo.get(id);
    const found = new Set();
    for (const dep of byId.get(id)?.dependencies ?? []) {
      if (!byId.has(dep) || seen.has(dep)) continue;
      found.add(dep);
      for (const up of visit(dep, new Set([...seen, dep]))) found.add(up);
    }
    memo.set(id, found);
    return found;
  };
  return new Map(tasks.map((t) => [t.id, visit(t.id, new Set([t.id]))]));
}

/**
 * The largest set of tasks no two of which are ordered: by Dilworth, the task
 * count less a maximum matching in the transitive closure's bipartite graph.
 */
export function width(tasks, subset) {
  const up = ancestors(tasks);
  // A subset keeps the whole plan's order: two of its tasks ordered through one outside it are still ordered.
  const ids = subset ?? tasks.map((t) => t.id);
  if (ids.length === 0) return 0;
  // Edge u→v when u must finish before v.
  const after = new Map(ids.map((u) => [u, ids.filter((v) => v !== u && up.get(v).has(u))]));
  const matchOf = new Map();
  const augment = (u, seen) => {
    for (const v of after.get(u)) {
      if (seen.has(v)) continue;
      seen.add(v);
      if (!matchOf.has(v) || augment(matchOf.get(v), seen)) {
        matchOf.set(v, u);
        return true;
      }
    }
    return false;
  };
  let matched = 0;
  for (const u of ids) if (augment(u, new Set())) matched++;
  return ids.length - matched;
}

/** The longest dependency chain, counted in tasks; null when the dependencies hold a cycle. */
export function criticalPath(tasks) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const memo = new Map();
  const onStack = new Set();
  let cyclic = false;
  const depth = (id) => {
    if (memo.has(id)) return memo.get(id);
    if (onStack.has(id)) {
      cyclic = true;
      return 0;
    }
    onStack.add(id);
    let best = 0;
    for (const dep of byId.get(id)?.dependencies ?? []) if (byId.has(dep)) best = Math.max(best, depth(dep));
    onStack.delete(id);
    memo.set(id, best + 1);
    return best + 1;
  };
  let longest = 0;
  for (const t of tasks) longest = Math.max(longest, depth(t.id));
  return cyclic ? null : longest;
}

export const isResearch = (task) => task.research === true;
export const isReadOnly = (task) => isResearch(task) || READ_ONLY_MODES.has(String(task.taskMode ?? '').toLowerCase());
export const isLoop = (task) => task.loop !== undefined && task.loop !== null;

function byteLength(value) {
  return typeof value === 'string' ? Buffer.byteLength(value, 'utf8') : 0;
}

/**
 * What the planner read itself and what it handed to agents. A step a research
 * subagent ran carries its `subagentId` and is that agent's read, not the
 * planner's. Agents are counted as the larger of the spawn calls and the
 * distinct subagents logged, since a harness planner's own `Agent` call logs no
 * subagent entry and Ordewell's `spawn_research_agent` logs both.
 */
export function readMeter(researchLog) {
  let ownReads = 0;
  let ownReadBytes = 0;
  const subagents = new Set();
  for (const entry of researchLog ?? []) {
    if (entry?.type === 'subagent') {
      subagents.add(entry.subagentId ?? entry.id);
      continue;
    }
    if (!isOwnStep(entry) || isAgentCall(entry)) continue;
    if (OWN_READ_TOOLS.has(entry.tool)) {
      ownReads++;
      ownReadBytes += byteLength(entry.result);
    }
  }
  return { ownReads, ownReadBytes, agentsSpawned: Math.max(agentCalls(researchLog).length, subagents.size) };
}

const isOwnStep = (entry) => entry?.type === undefined && typeof entry?.tool === 'string' && !entry.subagentId;
const isAgentCall = (entry) => RESEARCH_AGENT_TOOL.test(String(entry.tool ?? '')) || (entry.tool === 'agent_tool' && (AGENT_TOOL_LABELS.test(String(entry.toolLabel ?? '')) || RESEARCH_AGENT_TOOL.test(String(entry.toolLabel ?? ''))));

/** What the planner handed an agent, one brief per spawn call, as its arguments hold it. */
export function agentCalls(researchLog) {
  return (researchLog ?? []).filter((e) => isOwnStep(e) && isAgentCall(e)).map((e) => (typeof e.args === 'string' ? e.args : JSON.stringify(e.args ?? '')));
}

/**
 * The share of the planner's look at the code that it did itself: own reads
 * over own reads plus agents spawned plus research tasks added. Null when it
 * looked at nothing, which no share describes.
 */
export function ownReadShare({ ownReads, agentsSpawned, researchTasks }) {
  const all = ownReads + agentsSpawned + researchTasks;
  return all === 0 ? null : ownReads / all;
}

// Where a planner's chat quotes text or names code, the placeholder keeps the sentence's shape: "press `Enter`" still reads as a key.
const QUOTED = 'QUOTED';

/** Inline code, quoted strings and code identifiers: a planner quoting what a task must change is not telling the user to press anything. */
function unquoted(text) {
  return text
    .replace(/`[^`\n]*`/g, QUOTED)
    .replace(/"[^"\n]*"/g, QUOTED)
    .replace(/“[^”\n]*”/g, QUOTED)
    .replace(/(^|[\s(])'[^'\n]+'(?=[\s.,;:!?)]|$)/g, `$1${QUOTED}`)
    // camelCase or PascalCase with an inner capital, snake_case, a path, a file name.
    .replace(/\b[A-Za-z]+[a-z0-9][A-Z]\w*\b|\b\w+_\w+\b|[\w.-]*\/[\w./-]+|\b[\w-]+\.(?:tsx?|jsx?|mjs|json|md|css|ya?ml)\b/g, QUOTED);
}

function sentences(text) {
  return text.replace(/```[\s\S]*?```/g, '\n').split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
}

// VS Code's webview and the desktop app do have cards and buttons, and a goal may be about them
// (G1's usage shows on the VS Code task card), so a sentence naming one of those surfaces is exempt.
const OTHER_SURFACE = /\b(vs ?code|webview|desktop)\b/i;

/** A sentence that tells the user to do something: it addresses them, or opens with an imperative. */
const ADDRESSES_USER = /\b(you|your|yourself|please)\b/i;
const IMPERATIVE = /^(?:(?:then|and|now|just|simply|so)\s+)?(press|click|tap|hit|use|open|select|choose|approve|merge|run|type|start|execute|go)\b/i;
const instructs = (sentence) => ADDRESSES_USER.test(sentence) || IMPERATIVE.test(sentence);

/**
 * Controls the terminal UI does not have. `press` is allowed with a key
 * (press Enter, press `a`): the terminal is driven by keys.
 */
const WORDING_RULES = [
  { rule: 'names a button', pattern: /\bbuttons?\b/i, exempt: OTHER_SURFACE },
  { rule: 'names a card', pattern: /\bcards?\b/i, exempt: OTHER_SURFACE },
  { rule: "says 'click'", pattern: /\b(click|tap)(s|ed|ing)?\b/i, exempt: OTHER_SURFACE },
  {
    rule: "says 'press' without a key",
    pattern: /\bpress(es|ed|ing)?\b(?!\s+(?:the\s+)?(?:QUOTED|enter|return|esc(?:ape)?|tab|space|ctrl|shift|alt|cmd|[a-z0-9]\b|[a-z]-|key))/i,
  },
  { rule: "says 'Execute plan'", pattern: /\bexecute plan\b/i },
  { rule: "says 'Merge all'", pattern: /\bmerge all\b/i },
];

// The user as the one merging: "you can merge", "please merge", or "merge" opening a clause as an imperative.
const USER_MERGES = /\b(?:you|please)(?:'\w+)?(?:\s+(?:can|could|should|need|must|will|would|may|might|then|just|now|to|have|want|go|ahead|and|also|still|only|simply))*\s+merge\b|(^|[,;:]\s*)(?:(?:then|and|now|just|simply|so)\s+)?merge\b/i;
const MERGE_COMMAND = /(^|[\s`])\/(handoff\s+)?merge\b/i;
const BY_ITSELF = /\bautomatic(ally)?\b|\bby itself\b|\bon its own\b/i;

/** The chat after the plan was handed back: what the planner told the user to do with it. */
function handBack(history) {
  const at = (history ?? []).findIndex((m) => m?.kind === 'plan_generated');
  return at < 0 ? [] : history.slice(at + 1).filter((m) => m?.role === 'assistant' && typeof m.content === 'string');
}

/**
 * What the planner, handing the plan back, told the user to do with a control
 * the terminal UI does not have (a button or card, 'click', 'press' without a
 * key, 'Execute plan', 'Merge all'), or to merge while the run merges by
 * itself. Only instructions to the user count: a sentence describing the code,
 * or quoting it, is not one. A term the goal itself uses is the goal's, so a
 * rule whose pattern the goal matches is not applied.
 */
export function wordingViolations(history, { autoMerge, goalText = '' } = {}) {
  const found = [];
  const rules = WORDING_RULES.filter(({ pattern }) => !pattern.test(goalText));
  for (const message of handBack(history)) {
    for (const raw of sentences(message.content)) {
      const sentence = unquoted(raw);
      const quote = raw.slice(0, 240);
      if (instructs(sentence)) {
        for (const { rule, pattern, exempt } of rules) {
          if (pattern.test(sentence) && !exempt?.test(sentence)) found.push({ rule, quote });
        }
      }
      // The command may be quoted ("Type `/handoff merge`"), but only a sentence that addresses
      // the user asks for it: one that quotes it as text a task writes, as the goal's own hint does, describes code.
      const asksToMerge = instructs(sentence) && (MERGE_COMMAND.test(raw) || USER_MERGES.test(sentence));
      if (autoMerge && asksToMerge && !BY_ITSELF.test(raw)) {
        found.push({ rule: 'asks the user to merge while automatic merging is on', quote });
      }
    }
  }
  return found;
}

/** Whether submit_plan landed: the plan holds tasks, or the history records a generated plan. */
export function planSubmitted({ tasks, history }) {
  return tasks.length > 0 || (history ?? []).some((m) => m?.kind === 'plan_generated');
}

function usageNumbers(usage) {
  const totals = usage?.totals ?? {};
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return {
    contextTokensAtSubmit: num(usage?.lastPromptTokens),
    inputTokens: num(totals.inputTokens),
    outputTokens: num(totals.outputTokens),
    cachedInputTokens: num(totals.cachedInputTokens),
  };
}

/**
 * Every mechanical number for one run. `driver` is what the driver recorded:
 * its turns, wall time and how it stopped. `goalText` is what the planner was
 * asked, whose terms its wording may repeat. `budget` is the budget blocks
 * recorded from its turn input (budget.mjs), where this bench could see them.
 */
export function runMetrics(session, { researchLog, driver = {}, autoMerge = true, goalText = '', budget = null } = {}) {
  const parts = sessionParts(session, researchLog);
  const all = flatten(parts.tasks);
  const top = parts.tasks;
  const submitted = planSubmitted(parts);
  const meter = readMeter(parts.researchLog);
  const researchTasks = all.filter(isResearch).length;
  const autoMergeOn = parts.runSettings.mergeAtGatesAutomatically ?? autoMerge;
  return {
    submitted,
    taskCount: all.length,
    topLevelTasks: top.length,
    width: width(top),
    criticalPath: criticalPath(top),
    researchTasks,
    readOnlyTasks: all.filter(isReadOnly).length,
    loopTasks: all.filter(isLoop).length,
    ...usageNumbers(parts.usage),
    ...meter,
    ownReadShare: ownReadShare({ ...meter, researchTasks }),
    wordingViolations: wordingViolations(parts.history, { autoMerge: autoMergeOn, goalText }),
    budget,
    meterLines: budget ? budget.turns.filter((t) => t.meter).length : null,
    turns: driver.turns ?? null,
    wallMs: driver.wallMs ?? null,
    stopped: driver.stopped ?? null,
  };
}

/** The plan as the rubric reviewer and the report see it: ids, titles, dependencies, prompts. */
export function planDigest(tasks) {
  const digest = (t) => ({
    id: t.id,
    order: t.order,
    title: t.title,
    type: t.type,
    research: t.research === true,
    readOnly: isReadOnly(t),
    loop: isLoop(t),
    dependencies: t.dependencies ?? [],
    runner: t.assignedRunner,
    prompt: t.prompt ?? t.description ?? '',
    ...(Array.isArray(t.subtasks) && t.subtasks.length ? { subtasks: t.subtasks.map(digest) } : {}),
  });
  return (tasks ?? []).map(digest);
}
