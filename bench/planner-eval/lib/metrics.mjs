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
  let agentCalls = 0;
  const subagents = new Set();
  for (const entry of researchLog ?? []) {
    if (entry?.type === 'subagent') {
      subagents.add(entry.subagentId ?? entry.id);
      continue;
    }
    if (entry?.type !== undefined || typeof entry?.tool !== 'string') continue;
    if (entry.subagentId) continue;
    if (entry.tool === 'spawn_research_agent' || (entry.tool === 'agent_tool' && AGENT_TOOL_LABELS.test(String(entry.toolLabel ?? '')))) {
      agentCalls++;
    } else if (OWN_READ_TOOLS.has(entry.tool)) {
      ownReads++;
      ownReadBytes += byteLength(entry.result);
    }
  }
  return { ownReads, ownReadBytes, agentsSpawned: Math.max(agentCalls, subagents.size) };
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

/** Inline code and quoted strings: a planner quoting the text a task must change is not telling the user to press anything. */
function unquoted(text) {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/"[^"\n]*"/g, ' ')
    .replace(/“[^”\n]*”/g, ' ')
    .replace(/(^|[\s(])'[^'\n]+'(?=[\s.,;:!?)]|$)/g, '$1 ');
}

function sentences(text) {
  return text.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
}

// VS Code's webview and the desktop app do have cards and buttons, and a goal may be about them
// (G1's usage shows on the VS Code task card), so a sentence naming one of those surfaces is exempt.
const OTHER_SURFACE = /\b(vs ?code|webview|desktop)\b/i;

const WORDING_RULES = [
  { rule: 'names a button', pattern: /\bbuttons?\b/i, exempt: OTHER_SURFACE },
  { rule: 'names a card', pattern: /\bcards?\b/i, exempt: OTHER_SURFACE },
  { rule: "says 'press'", pattern: /\bpress(es|ed|ing)?\b/i },
  { rule: "says 'Execute plan'", pattern: /\bexecute plan\b/i },
  { rule: "says 'Merge all'", pattern: /\bmerge all\b/i },
];

// A sentence that puts merging on the user: addressed to them, an imperative opening, or a merge command.
const ASKS_TO_MERGE = /\bmerg(e|ing)\b/i;
const ADDRESSES_USER = /\b(you|your|yourself|please)\b|^(then\s+|and\s+)?merge\b|\/merge\b|\/handoff merge\b/i;

/**
 * What the planner told the user about controls it has no business naming on
 * the terminal UI: a button or card, 'press', 'Execute plan', 'Merge all', or a
 * request to merge while the run merges by itself. Read off the assistant's
 * chat only, with code and quotations removed.
 */
export function wordingViolations(history, { autoMerge }) {
  const found = [];
  for (const message of history ?? []) {
    if (message?.role !== 'assistant' || typeof message.content !== 'string') continue;
    for (const sentence of sentences(unquoted(message.content))) {
      for (const { rule, pattern, exempt } of WORDING_RULES) {
        if (pattern.test(sentence) && !exempt?.test(sentence)) found.push({ rule, quote: sentence.slice(0, 240) });
      }
      if (autoMerge && ASKS_TO_MERGE.test(sentence) && ADDRESSES_USER.test(sentence)) {
        found.push({ rule: 'asks the user to merge while automatic merging is on', quote: sentence.slice(0, 240) });
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
 * its turns, wall time and how it stopped.
 */
export function runMetrics(session, { researchLog, driver = {}, autoMerge = true } = {}) {
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
    wordingViolations: wordingViolations(parts.history, { autoMerge: autoMergeOn }),
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
