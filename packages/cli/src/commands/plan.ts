import { createInterface } from 'readline';
import { allTasksOf, flag, flags, hasFlag, saveLastSession, workspaceOf } from '../utils';
import { ensureDaemon, resolvePort } from '../daemon';
import { ApiClient } from '../apiClient';
import { createApprovalHandler } from '../approvals';
import { createStepLog, type LogLine } from './researchLog';
import type { SerializedTask, DiscoveredModel } from '@ordewell/core';
import { loopRowParts, mintSessionId, scriptTaskText, taskOrderLabel, taskRowView } from '@ordewell/core';
import type { PlanBody, WsEvent } from '../apiClient';
import { fail, headlessPlannerRefusal, headlessSignedOut, lostReplyHint } from './shared';

// The one-shot endpoint answers with the stored plan state (`pendingTasks`),
// the conversation with the wire plan (`tasks`); read as `tasks` alone, a
// one-shot plan printed as "Plan: 0 tasks" over the tasks it had just made.
function planTasks(plan: PlanBody): SerializedTask[] {
  return plan ? allTasksOf(plan as unknown as Record<string, unknown>) as unknown as SerializedTask[] : [];
}

/** The runners a plan names; a plan still in its planning phase names none, so the request's stand in. */
function runnersOf(plan: PlanBody, requested: string[]): string[] {
  return ('runners' in plan && plan.runners) || requested;
}

/** The planner committed once it has actual tasks; before that it's still talking. */
function hasCommittedPlan(plan: PlanBody): boolean {
  return planTasks(plan).length > 0;
}

function lastPlannerMessage(plan: PlanBody): string {
  const history = ('conversationHistory' in plan && plan.conversationHistory) || [];
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === 'assistant' && history[i].kind !== 'skill_load') return history[i].content;
  }
  return '(the planner returned no plan and no message)';
}

/** The host's notes on the plan the conversation committed last, a skill check's warnings among them. */
function commitNotes(plan: PlanBody): string[] {
  const history = ('conversationHistory' in plan && plan.conversationHistory) || [];
  const marker = history.map((e) => e.kind).lastIndexOf('plan_generated');
  return marker < 0 ? [] : history.slice(marker + 1).filter((e) => e.kind === 'system').map((e) => e.content);
}

/**
 * What the user does with the plan now. Autorun (ADR-0030) starts a plan the
 * planner submits once its reply ends, and its start approves the plan before
 * the reply reaches this command — so "run it" is said only of a plan nobody
 * has approved or started, and a running one is pointed at, not run again.
 */
async function nextStep(api: ApiClient, plan: PlanBody, sessionId: string): Promise<string> {
  const approved = 'approved' in plan && plan.approved === true;
  // A submitted task reads `approved` before anything has run it.
  const moving = planTasks(plan).some((t) => t.status !== undefined && t.status !== 'pending' && t.status !== 'approved');
  if (!approved && !moving) return `Run 'ordewell run' to execute, 'ordewell status' to inspect, or 'ordewell tui' for the full UI.`;
  const follow = `Follow it with 'ordewell status', or 'ordewell tui' for the full UI.`;
  // The session's own copy decided whether this plan started, not the file a
  // second surface may have moved since.
  const autorun = await api.getSettings(sessionId).then((settings) => settings.run?.autorun === true, () => false);
  return autorun ? `Autorun started the plan. ${follow}` : `The plan is running. ${follow}`;
}

/** Answers for planner questions. `null` means stdin is exhausted — no answer is coming. */
export interface Reader {
  ask(question: string): Promise<string | null>;
  close(): void;
}

/**
 * One readline over stdin for the whole dialogue. Works for a terminal and for
 * piped answers alike; EOF surfaces as `null` rather than a hang, so
 * `printf 'a\nb\n' | ordewell plan …` is a supported way to drive the planner.
 *
 * Lines are buffered rather than read via `rl.question`: a piped stdin drains
 * and closes while we're waiting on the planner's HTTP round-trip, so anything
 * not captured by a live 'line' listener would be lost.
 */
export function stdinReader(input: NodeJS.ReadableStream = process.stdin): Reader {
  const rl = createInterface({ input, output: process.stderr });
  const buffered: string[] = [];
  let waiting: ((answer: string | null) => void) | null = null;
  let ended = false;

  const settle = (answer: string | null): boolean => {
    if (!waiting) return false;
    const resolve = waiting;
    waiting = null;
    resolve(answer);
    return true;
  };

  rl.on('line', (line) => { if (!settle(line)) buffered.push(line); });
  rl.on('close', () => { ended = true; settle(null); });

  return {
    ask(question) {
      if (buffered.length > 0) return Promise.resolve(buffered.shift()!);
      if (ended) return Promise.resolve(null);
      rl.setPrompt(question);
      rl.prompt();
      return new Promise((resolve) => { waiting = resolve; });
    },
    close() {
      if (!ended) rl.close();
    },
  };
}

async function withSpinner<T>(label: string, work: () => Promise<T>): Promise<T> {
  process.stderr.write(label);
  const spinner = setInterval(() => process.stderr.write('.'), 800);
  try {
    return await work();
  } finally {
    clearInterval(spinner);
    process.stderr.write('\n');
  }
}

function printPlan(plan: PlanBody, sessionId: string, runners: string[], models: DiscoveredModel[]): void {
  const tasks = planTasks(plan);
  const aiCount = tasks.filter((t: SerializedTask) => t.type !== 'user' && t.type !== 'script').length;
  const manCount = tasks.filter((t: SerializedTask) => t.type === 'user').length;
  const scriptCount = tasks.filter((t: SerializedTask) => t.type === 'script').length;

  const modelSuffix = (task: SerializedTask): string => {
    if (!task.assignedModel) return '';
    const found = models.find((m: DiscoveredModel) => m.modelId === task.assignedModel?.modelId);
    const rp = found?.runnerProvider;
    const label = rp ? rp.split('-').map((w: string) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ') : '';
    return rp
      ? ` (${task.assignedModel.modelLabel} · ${label})`
      : ` (${task.assignedModel.modelLabel})`;
  };

  console.log(`\nPlan: ${tasks.length} task${tasks.length === 1 ? '' : 's'} (${aiCount} AI${scriptCount > 0 ? `, ${scriptCount} Script` : ''}, ${manCount} Manual): ${runnersOf(plan, runners).join(', ')}`);
  console.log(`Session: ${sessionId}\n`);

  for (const t of tasks) {
    const typeIcon = t.type === 'user' ? '[MAN]' : t.type === 'script' ? '[SCR]' : t.ops ? '[OPS]' : t.research ? '[RES]' : '[ AI]';
    const deps = t.dependencies?.length ? ` ← ${t.dependencies.join(', ')}` : '';
    console.log(`  ${taskOrderLabel(t).padStart(2)}. ${typeIcon} ${t.title}${modelSuffix(t)}${deps}`);
    // What the user approves and what runs: the body as the plan holds it, not a summary.
    if (t.type === 'script') {
      for (const line of scriptTaskText({ ...t, type: 'script' }).split('\n')) console.log(line ? `        ${line.replace(/\t/g, '    ')}` : '');
    }
    const loop = taskRowView({ id: t.id, order: t.order, status: t.status ?? 'pending', type: t.type === 'user' || t.type === 'script' ? t.type : 'ai', dependencies: t.dependencies ?? [], loop: t.loop, loopRound: t.loopRound }, { tasks }).loop;
    if (loop) console.log(`        ↻ ${loopRowParts(loop).join(' · ')}`);
    for (const sub of t.subtasks || []) {
      const subTypeIcon = sub.type === 'user' ? '[MAN]' : '[ AI]';
      const subDeps = sub.dependencies?.length ? ` ← ${sub.dependencies.join(', ')}` : '';
      console.log(`    ${taskOrderLabel(sub, t)}. ${subTypeIcon} ${sub.title}${modelSuffix(sub)}${subDeps}`);
    }
  }

  if (manCount > 0) {
    console.log('\n  [MAN] = manual step: run `ordewell tui` to work through it');
  }
  if (tasks.some((t) => t.ops)) {
    console.log('  [OPS] = ops task: runs in your checkout once the work it depends on is merged (`ordewell handoff merge`)');
  }
  if (tasks.some((t) => t.research)) {
    console.log('  [RES] = research task: read-only, lands nothing; its report wakes the planner when it ends');
  }
  if (scriptCount > 0) {
    console.log('  [SCR] = script task: runs the commands shown, with no model, in your checkout once the work it depends on is merged; the planner writes them, and you approve each');
  }
}

/**
 * Planner settings this CLI documents as environment variables. The daemon
 * reads them from *its* environment, inherited once when it was spawned, so
 * `AI_PROVIDER=<runner> ordewell plan …` — the invocation `ordewell --help` prints —
 * did nothing at all against a daemon that was already running: the variable
 * was set on a client process that only speaks HTTP. Forwarding them is what
 * makes the documented form mean what it says.
 *
 * AI_PROVIDER names a planner, so it goes as a switch. The model and effort
 * are only what this process inherited — the shell, or `.env` — so they go
 * marked as that: sent as a pick, a model left from an old OpenRouter setup
 * was saved as the detected agent's own and then spawned with it.
 */
const INHERITED_PLANNER_ENV = ['ORCHESTRATOR_MODEL', 'ORDEWELL_PLANNER_EFFORT'] as const;

async function forwardPlannerEnv(api: ApiClient): Promise<void> {
  const provider = process.env.AI_PROVIDER;
  if (provider) await api.updateSettings({ env: { AI_PROVIDER: provider } });
  const env: Record<string, string> = {};
  for (const key of INHERITED_PLANNER_ENV) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  // After the switch, as one write did before: the command line's model
  // still outranks the one the switch recalled. A vendor's slug left for a
  // coding agent does not; the daemon reads past it to the agent's own pick.
  if (Object.keys(env).length > 0) await api.updateSettings({ env, inherited: true });
}

export async function handlePlan(
  subArgs: string[],
  deps: { api?: ApiClient; reader?: Reader } = {},
): Promise<void> {
  const injectedApi = deps.api;
  const goal = flag(subArgs, '--goal');
  if (!goal) {
    console.error('Usage: ordewell plan --goal "Your task description" [--runner <id> ...] [--workspace /path] [--port N] [--no-chat] [--verbose]');
    process.exit(1);
  }

  const runnerFlags = flags(subArgs, '--runner').filter(Boolean) as string[];
  const workspace = workspaceOf(subArgs);
  const oneShot = hasFlag(subArgs, '--no-chat');
  const autoApprove = hasFlag(subArgs, '--yes');
  const verbose = hasFlag(subArgs, '--verbose');

  const port = injectedApi ? resolvePort(subArgs) : await ensureDaemon(resolvePort(subArgs));
  const api = injectedApi || new ApiClient(port, workspace);
  await forwardPlannerEnv(api);

  const state = await api.getRunners(workspace);
  const enabledIds = state.runners.filter(r => r.enabled).map(r => r.id);

  // The list is every installed runner, enabled or not. One that is installed
  // but off is refused with the command that turns it on, as `ordewell runners`
  // is where the enabled set is chosen; `--runner` picks among it.
  const enableHint = (id: string) => `Enable it with: ordewell runners ${id} on`;
  let runners: string[];
  if (runnerFlags.length === 0) {
    if (enabledIds.length === 0) {
      const installed = state.runners.map((r) => r.id);
      fail(
        'No runner is enabled.',
        installed.length > 0
          ? `Installed: ${installed.join(', ')}. ${enableHint(installed[0])}`
          : 'No supported coding agent is installed or on PATH.',
      );
    }
    runners = enabledIds;
  } else {
    for (const r of runnerFlags) {
      if (enabledIds.includes(r)) continue;
      if (state.runners.some((known) => known.id === r)) fail(`${r} is installed but not enabled. ${enableHint(r)}`);
      fail(`Unknown runner: "${r}". Enabled runners: ${enabledIds.join(', ')}`);
    }
    runners = runnerFlags;
  }

  console.error(`Generating plan for: "${goal}"...`);

  const sessionId = mintSessionId();
  const isTty = !!process.stderr.isTTY;
  let lastLineLength = 0;

  const stepLog = createStepLog({ verbose });

  function renderLine({ text, transient }: LogLine): void {
    if (isTty) {
      // The in-flight call owns the status line; everything settled scrolls
      // above it, so completed calls and their outcomes stay on screen.
      process.stderr.write(`\r\x1b[2K${text}`);
      if (transient) {
        lastLineLength = text.length;
      } else {
        process.stderr.write('\n');
        lastLineLength = 0;
      }
    } else {
      process.stderr.write(`${text}\n`);
    }
  }

  function renderStep(event: WsEvent): void {
    stepLog.push(event).forEach(renderLine);
  }

  function closeStream(): void {
    stream.close();
    stepLog.flush().forEach(renderLine);
  }

  // Opened only if the planner actually asks something.
  let reader = deps.reader;

  // Approval prompts arrive on the same socket as research steps. The reader is
  // created on demand so a run that never triggers one still needs no stdin.
  const handleApproval = createApprovalHandler(sessionId, {
    respond: (sessionId, approvalId, granted) => api.respondToApproval(sessionId, approvalId, granted),
    ask: async (question) => {
      reader = reader || stdinReader();
      return (await reader.ask(question)) ?? '';
    },
    write: (text) => process.stderr.write(text),
    autoApprove,
    interactive: !oneShot && !!process.stdin.isTTY,
  });

  const stream = api.streamPlanning(sessionId, (event) => {
    renderStep(event);
    // A run snapshot or a child list is not a planner message; this stream ignores them.
    if (event.type !== 'run_snapshot' && event.type !== 'account_limits' && event.type !== 'child_tree') void handleApproval(event);
  });

  try {
    await stream.ready;
    let plan: PlanBody;
    let models: DiscoveredModel[] = [];
    let notes: string[] = [];

    if (oneShot) {
      const result = await withSpinner('Researching codebase and building task plan', () =>
        api.generatePlan(goal, runners, workspace, sessionId),
      );
      plan = result.plan;
      models = result.models ?? [];
      notes = result.notes ?? [];
    } else {
      plan = await withSpinner('Researching codebase and building task plan', () =>
        api.startConversation(sessionId, goal, runners, workspace),
      );

      // A clarifying turn lands here: the planner asked something
      // instead of committing, so answer it and hand the reply back.
      while (!hasCommittedPlan(plan)) {
        stepLog.flush().forEach(renderLine);
        console.log(`\n${lastPlannerMessage(plan)}\n`);

        reader = reader || stdinReader();
        let reply = '';
        while (!reply.trim()) {
          const answer = await reader.ask('> ');
          if (answer === null) {
            reader.close();
            console.error(
              'The planner asked a question but stdin has no more input. ' +
              'Answer interactively, pipe answers on stdin, or use `--no-chat` for a one-shot plan.',
            );
            process.exit(1);
          }
          reply = answer!;
          if (reply.trim() === '/quit') {
            reader.close();
            console.error('Planning aborted.');
            process.exit(1);
          }
        }

        plan = await withSpinner('Thinking', () => api.sendConversationMessage(sessionId, reply));
      }
      reader?.close();
      notes = commitNotes(plan);
    }

    closeStream();
    if (isTty && lastLineLength > 0) process.stderr.write('\r\x1b[2K');
    process.stderr.write('\n');

    printPlan(plan, sessionId, runners, models);
    for (const note of notes) console.log(`\n${note}`);
    saveLastSession(sessionId, goal, runnersOf(plan, runners), workspace);
    console.log(`\n  ${await nextStep(api, plan, sessionId)}`);
  } catch (err) {
    reader?.close();
    closeStream();
    if (isTty && lastLineLength > 0) process.stderr.write('\r\x1b[2K');
    process.stderr.write('\n');
    const refusal = headlessPlannerRefusal(err);
    if (refusal) {
      console.error(refusal);
    } else {
      console.error(`Plan generation failed: ${err instanceof Error ? headlessSignedOut((err as Error).message) : String(err)}`);
      const hint = lostReplyHint(err, sessionId);
      if (hint) console.error(hint);
    }
    process.exit(1);
  }
}
