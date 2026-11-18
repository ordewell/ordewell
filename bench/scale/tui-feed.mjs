/**
 * What a daemon sends a terminal client, in the shapes the client folds
 * (`SessionMessage`, `RunSnapshotFrame`, the saved transcript of a session):
 * a plan of N tasks of which D are settled, a conversation of T entries, then
 * a stream of seconds. Deterministic from `seed`, no clock of its own: the
 * caller passes the time as an ISO string.
 *
 * Sizes are the medians of this repository's own saved sessions as
 * `lib.mjs` records them (a finished task: a 3 KB prompt, a 1 KB usage ledger),
 * with a digest the plan keeps on each finished task.
 */
import fs from 'node:fs';

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = ('the planner reads module task plan change test runner session file route handler update review verify depends '
  + 'schema state reducer render frame pane scroll status verdict handoff worktree branch merge commit finding prompt model '
  + 'with from into after before while across inside keeps drops writes reads returns passes fails waits retries').split(' ');

export function makeFeed({ tasks = 300, settled = 280, entries = 400, seed = 1, running = 2, session = null } = {}) {
  const rand = mulberry32(seed);
  const pick = (list) => list[Math.floor(rand() * list.length)];
  const between = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));

  const sentence = () => {
    const words = Array.from({ length: between(7, 18) }, () => pick(WORDS));
    return `${words.join(' ').replace(/^./, (c) => c.toUpperCase())}.`;
  };
  const prose = (chars) => {
    let out = '';
    while (out.length < chars) out += `${sentence()} `;
    return out.slice(0, chars).trim();
  };
  /** Markdown the way a planner writes it: paragraphs, a list, a fence and some inline code. */
  const markdown = (chars) => {
    const parts = [prose(Math.floor(chars * 0.4)), `- ${prose(70)}\n- ${prose(60)} \`${pick(WORDS)}.ts\`\n- ${prose(80)}`, `\`\`\`ts\nexport function ${pick(WORDS)}(state: State) {\n  return ${pick(WORDS)}(state, ${between(1, 9)});\n}\n\`\`\``, prose(Math.floor(chars * 0.3))];
    return parts.join('\n\n');
  };
  const lines = (count, chars) => Array.from({ length: count }, (_, i) => `src/${pick(WORDS)}/${pick(WORDS)}.ts:${i + 1}: ${prose(chars)}`).join('\n');

  const id = (i) => `task-${i + 1}`;
  const at = (ms) => new Date(ms).toISOString();

  // ---------- the plan ----------

  const totals = { inputTokens: 324883, outputTokens: 2285, cachedInputTokens: 296379, reportedCost: { USD: 0.16 }, costProvenance: { USD: { kind: 'estimate', billing: 'subscription', basis: 'list' } } };
  const usageOf = (when) => [{
    attempt: 1, runner: 'claude-code', startedAt: when, wallTimeMs: 68987, endedAt: when, totals,
    byModel: [{ source: 'claude-code', model: 'claude-sonnet-5-5', totals }],
    sessionBilling: { type: 'subscription', plan: 'Claude Max' }, source: 'claude-code', lastPromptTokens: 41415, contextWindow: 1000000, model: 'claude-sonnet-5-5', sessionId: '2ae84370-a459-44c0-a0b9-60b9d8961b1a',
  }];
  const handoffOf = () => ({
    summary: markdown(1100),
    findings: [
      { id: 'F1', severity: 'minor', title: prose(70), detail: prose(300) },
      { id: 'F2', severity: 'info', title: prose(60), detail: prose(220) },
    ],
    findingCount: 2,
    attempt: 1,
  });

  /** Each task's fixed text, kept so a status and a plan agree on it across seconds. */
  const basis = [];
  const taskBasis = (i) => {
    basis[i] ??= { title: `Task ${i + 1}: ${prose(48)}`, description: prose(300), prompt: markdown(between(2400, 3600)), handoff: handoffOf() };
    return basis[i];
  };

  // Which are settled and running now; the order a planner writes is the order they run.
  const state = { settled: Math.min(settled, tasks), running: [], when: Date.now() };
  const refill = () => {
    state.running = state.running.filter((i) => i >= state.settled);
    let next = state.settled;
    while (state.running.length < Math.min(running, tasks - state.settled)) {
      while (state.running.includes(next)) next += 1;
      if (next >= tasks) break;
      state.running.push(next);
    }
  };
  refill();
  const statusOf = (i) => (i < state.settled ? 'completed' : state.running.includes(i) ? 'in_progress' : 'pending');
  const dependenciesOf = (i) => (i < 1 ? [] : [id(i - 1), ...(i > 20 && i % 3 === 0 ? [id(i - 20)] : [])]);

  const serializedTask = (i) => {
    const b = taskBasis(i);
    const status = statusOf(i);
    return {
      id: id(i), order: i + 1, title: b.title, type: 'ai', status, description: b.description,
      dependencies: dependenciesOf(i), assignedRunner: 'claude-code',
      assignedModel: { modelId: 'sonnet', modelLabel: 'Sonnet', thinkingEffort: 'medium', availableVariants: ['adaptive', 'low', 'medium', 'high', 'xhigh', 'max'] },
      taskMode: 'bypassPermissions', prompt: b.prompt, subtasks: [], sliceType: 'AFK',
      ...(status === 'pending' ? {} : { attempted: true }),
      ...(status === 'completed' ? { attemptUsage: usageOf(at(state.when)), handoff: b.handoff } : {}),
    };
  };
  const verdictOf = (i) => (i < state.settled ? { outcome: 'pass', reason: 'Verified: the runner reported completion through task_complete with status done.', checks: [{ name: 'task_complete', passed: true, skipped: false, detail: 'the runner called task_complete with status done' }] } : null);
  const taskStatus = (i) => {
    const status = statusOf(i);
    return {
      id: id(i), type: 'ai', status, verdict: verdictOf(i),
      ...(status === 'pending' ? {} : { attempted: true }),
      ...(status === 'completed' ? { attemptUsage: usageOf(at(state.when)), handoff: taskBasis(i).handoff } : {}),
      ...(status === 'in_progress' ? { idleSince: null } : {}),
    };
  };

  const runSettings = { autorun: true, supervisorLevel: 'act', mergeAtGatesAutomatically: false };
  const plan = (goal) => ({
    tasks: Array.from({ length: tasks }, (_, i) => serializedTask(i)),
    runners: ['claude-code'], generatedAt: at(state.when), status: 'approved', goal, runSettings,
    conversationHistory: [],
  });
  const runView = () => ({
    tasks: Array.from({ length: tasks }, (_, i) => ({ ...serializedTask(i), ...taskStatus(i), subtasks: [] })),
    runSettings, runMerge: null, handoff: null, mergeResult: null,
    activity: { starting: false, running: state.running.length > 0, scheduled: false, resumable: false, advancesOnItsOwn: true },
    escalations: [],
  });

  // ---------- the saved conversation ----------

  /** Messages in pairs, each reply followed by the research it did: about a fifth messages, the rest steps. */
  const transcript = (count, start) => {
    const history = [];
    const researchLog = [];
    let n = 0;
    let t = start - count * 40_000;
    while (n < count) {
      history.push({ role: 'user', content: prose(between(80, 320)), timestamp: at(t) });
      n += 1;
      t += 1000;
      const steps = Math.min(between(2, 5), count - n);
      for (let s = 0; s < steps; s += 1) {
        const tool = pick(['read_file', 'grep', 'glob', 'bash', 'task_query', 'list_dir']);
        researchLog.push({
          id: `r${researchLog.length + 1}`, tool, args: `${pick(WORDS)}/${pick(WORDS)}.ts ${prose(30)}`,
          result: tool === 'read_file' ? lines(between(40, 120), 70) : lines(between(4, 40), 60),
          success: true, outcome: 'success', timestamp: at(t),
        });
        n += 1;
        t += 2000;
      }
      if (n < count) {
        const content = markdown(between(700, 1800));
        history.push({ role: 'assistant', content, timestamp: at(t), runs: [{ segmentId: `s${history.length}`, text: content, startedAt: at(t) }] });
        n += 1;
        t += 4000;
      }
    }
    return { history, researchLog };
  };

  const feed = {
    goal: 'Move the whole service onto the new session store and keep every route working',
    taskIds: Array.from({ length: tasks }, (_, i) => id(i)),
    /** What opening the session reads: the saved transcript, the plan, the run, and the two frames a socket greets with. */
    load(now) {
      if (session) return fromSession(session);
      const { history, researchLog } = transcript(entries, now);
      const p = plan(feed.goal);
      p.conversationHistory = history;
      return {
        shape: { tasks, settled: state.settled, entries },
        goal: feed.goal,
        chat: { type: 'chatRestored', history, researchLog, plannerUsage: { totals } },
        plan: p,
        run: runView(),
        frames: {
          snapshot: JSON.stringify({ type: 'run_snapshot', sessionId: 'bench', view: runView(), approvals: [] }),
          wholePlan: JSON.stringify({ type: 'plan_generated', plan: { ...p, conversationHistory: undefined }, goal: feed.goal, runners: ['claude-code'] }),
        },
      };
    },
  };

  /** A saved session file, read and never echoed: `{ meta, plan }`, or the plan alone. */
  function fromSession(file) {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    const p = saved.plan ?? saved;
    const flat = Array.isArray(p.tasks) ? p.tasks : [...(p.executionLog ?? []), ...(p.pendingTasks ?? [])];
    const settledNow = flat.filter((t) => t.status === 'completed').length;
    const view = { ...p, tasks: flat };
    tasks = flat.length;
    state.settled = settledNow;
    state.running = flat.map((t, i) => (t.status === 'in_progress' ? i : -1)).filter((i) => i >= 0);
    feed.taskIds = flat.map((t) => String(t.id));
    realTasks = flat;
    const plainStatus = (t) => ({ id: String(t.id), type: t.type, status: t.status, verdict: t.verdict ?? null, ...(t.attempted ? { attempted: true } : {}), ...(t.attemptUsage ? { attemptUsage: t.attemptUsage } : {}), ...(t.handoff ? { handoff: t.handoff } : {}) });
    realStatus = plainStatus;
    return {
      shape: { tasks: flat.length, settled: settledNow, entries: (p.conversationHistory?.length ?? 0) + (p.researchLog?.length ?? 0) },
      goal: String(saved.meta?.goal ?? p.goal ?? feed.goal),
      chat: { type: 'chatRestored', history: p.conversationHistory ?? [], researchLog: p.researchLog ?? [], ...(p.plannerUsage ? { plannerUsage: p.plannerUsage } : {}), ...(p.pendingTurns ? { pendingTurns: p.pendingTurns } : {}) },
      plan: view,
      run: null,
      frames: null,
    };
  }
  let realTasks = null;
  let realStatus = null;

  // ---------- the stream ----------

  let turn = null;
  let turnNo = 0;

  /**
   * One second of what a daemon sends, as `{ at: ms into the second, frame }`
   * with each frame a JSON string: the client parses what it is sent.
   * `opts.turnEvery` / `turnLen` seconds, `delta` text pieces a second in a turn,
   * `rotate` seconds a task runs, `mutateEvery` seconds between plan mutations.
   */
  feed.second = (s, nowMs, { turnEvery = 40, turnLen = 20, delta = 30, rotate = 60, mutateEvery = 30, logTasks = 2 } = {}) => {
    state.when = nowMs;
    const out = [];
    const send = (offset, frame) => out.push({ at: offset, frame: JSON.stringify(frame) });

    // A task finishes and the next starts: a running task is a settled one a minute later.
    if (s > 0 && s % rotate === 0 && state.running.length > 0 && state.settled < tasks) {
      const done = state.running.shift();
      state.settled = Math.max(state.settled, done + 1);
      refill();
      for (const i of state.running) send(10, { type: 'task_started', taskId: feed.taskIds[i], order: i + 1, title: taskBasis(i).title, runner: 'claude-code', modelId: 'sonnet' });
    }

    const statusTasks = realTasks
      ? realTasks.map(realStatus)
      : Array.from({ length: tasks }, (_, i) => taskStatus(i));
    send(0, {
      type: 'status_update', tasks: statusTasks, runMerge: undefined,
      usage: { totals }, activity: { starting: false, running: state.running.length > 0, scheduled: false, resumable: false, advancesOnItsOwn: true }, escalations: [],
    });

    for (const [k, i] of state.running.slice(0, logTasks).entries()) {
      const taskId = feed.taskIds[i];
      const events = [{ type: 'text_delta', text: `${prose(40)} ` }, { type: 'thinking_delta', text: prose(60) }];
      if (s % 3 === k) {
        events.push({ type: 'tool_call', id: `c${s}`, name: 'Bash', args: JSON.stringify({ command: `npm test -- ${pick(WORDS)}` }) });
        events.push({ type: 'tool_result', id: `c${s}`, output: lines(between(10, 60), 70), success: true });
      }
      send(250 + k * 200, { type: 'task_log', taskId, attempt: 1, events });
    }

    if (s > 0 && s % mutateEvery === 0 && state.running.length > 0) {
      const i = state.running[0];
      send(600, { type: 'task_updated', taskId: feed.taskIds[i], changes: { title: `Task ${i + 1}: ${prose(48)}` } });
      if ((s / mutateEvery) % 4 === 0) {
        const p = realTasks ? { tasks: realTasks, runners: ['claude-code'], generatedAt: at(nowMs), status: 'approved' } : plan(feed.goal);
        send(650, { type: 'plan_generated', plan: { ...p, conversationHistory: undefined }, goal: feed.goal, runners: ['claude-code'] });
      }
    }

    // A planner turn: thinking, research, then the reply streamed as text.
    const phase = s % turnEvery;
    if (phase === 0) {
      turnNo += 1;
      turn = { id: `turn-${turnNo}`, text: '', started: nowMs, steps: 0 };
      send(20, { type: 'planner_turn_started', turnId: turn.id, prompt: prose(between(80, 240)), startedAt: at(nowMs) });
    }
    if (turn && phase < turnLen) {
      const thinkingUntil = Math.floor(turnLen * 0.25);
      const researchUntil = Math.floor(turnLen * 0.5);
      for (let d = 0; d < delta; d += 1) {
        const offset = 40 + Math.floor((d * 900) / delta);
        if (phase < thinkingUntil) {
          send(offset, { type: 'planner_thinking_delta', turnId: turn.id, segmentId: 'think', text: `${prose(14)} ` });
        } else if (phase >= researchUntil) {
          const text = `${prose(14)} `;
          turn.text += text;
          send(offset, { type: 'planner_text_delta', turnId: turn.id, segmentId: 'reply', text });
        }
      }
      if (phase >= thinkingUntil && phase < researchUntil && phase % 2 === 0) {
        turn.steps += 1;
        const tool = pick(['read_file', 'grep', 'bash']);
        const toolCallId = `tc${turnNo}-${turn.steps}`;
        send(100, { type: 'research_step', tool, args: `${pick(WORDS)}/${pick(WORDS)}.ts`, toolCallId, turnId: turn.id });
        send(500, {
          type: 'research_step_done', turnId: turn.id,
          step: { id: toolCallId, tool, args: `${pick(WORDS)}/${pick(WORDS)}.ts`, result: lines(between(8, 60), 70), success: true, outcome: 'success', toolCallId, timestamp: at(nowMs) },
        });
      }
    }
    if (turn && phase === turnLen) {
      const content = turn.text || markdown(1200);
      send(100, { type: 'planner_message', content, timestamp: at(nowMs), turnId: turn.id, runs: [{ segmentId: 'reply', text: content, startedAt: at(turn.started) }] });
      send(150, { type: 'planner_usage', turnId: turn.id, totals });
      send(200, { type: 'planner_turn_ended', turnId: turn.id, outcome: 'message' });
      turn = null;
    }
    return out.sort((a, b) => a.at - b.at);
  };

  return feed;
}
