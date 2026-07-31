import { createInterface } from 'readline';
import { flag, flags, hasFlag, saveLastSession } from '../utils';
import { ensureDaemon, ApiClient, resolvePort } from '../daemonClient';
import { createApprovalHandler } from '../approvals';
import { formatStepLine, isTransient } from './researchLog';
import type { SerializedPlan, SerializedTask, DiscoveredModel } from '@ordewell/core';
import type { WsEvent } from '../apiClient';

function planTasks(plan: SerializedPlan): SerializedTask[] {
  return plan?.tasks || [];
}

/** The planner committed once it has actual tasks; before that it's still talking. */
function hasCommittedPlan(plan: SerializedPlan): boolean {
  return planTasks(plan).length > 0;
}

function lastPlannerMessage(plan: SerializedPlan): string {
  const history = plan?.conversationHistory || [];
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === 'assistant') return history[i].content;
  }
  return '(the planner returned no plan and no message)';
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

function printPlan(plan: SerializedPlan, sessionId: string, runners: string[], models: DiscoveredModel[]): void {
  const tasks = planTasks(plan);
  const aiCount = tasks.filter((t: SerializedTask) => t.type !== 'user').length;
  const manCount = tasks.filter((t: SerializedTask) => t.type === 'user').length;

  console.log(`\nPlan: ${tasks.length} tasks (${aiCount} AI, ${manCount} Manual) — ${(plan.runners || runners).join(', ')}`);
  console.log(`Session: ${sessionId}\n`);

  for (const t of tasks) {
    const typeIcon = t.type === 'user' ? '[MAN]' : '[ AI]';
    let model = '';
    if (t.assignedModel) {
      const found = models.find((m: DiscoveredModel) => m.modelId === t.assignedModel?.modelId);
      const rp = found?.runnerProvider;
      const label = rp ? rp.split('-').map((w: string) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ') : '';
      model = rp
        ? ` (${t.assignedModel.modelLabel} · ${label})`
        : ` (${t.assignedModel.modelLabel})`;
    }
    const deps = t.dependencies?.length ? ` ← ${t.dependencies.join(', ')}` : '';
    console.log(`  ${String(t.order).padStart(2)}. ${typeIcon} ${t.title}${model}${deps}`);
  }

  if (manCount > 0) {
    console.log('\n  [MAN] = manual step — run `ordewell tui` to work through it');
  }
}

/**
 * Planner settings this CLI documents as environment variables. The daemon
 * reads them from *its* environment, inherited once when it was spawned, so
 * `AI_PROVIDER=codex ordewell plan …` — the invocation `ordewell --help` prints —
 * did nothing at all against a daemon that was already running: the variable
 * was set on a client process that only speaks HTTP. Forwarding them is what
 * makes the documented form mean what it says.
 */
const PLANNER_ENV = ['AI_PROVIDER', 'ORCHESTRATOR_MODEL', 'ORDEWELL_PLANNER_EFFORT'] as const;

async function forwardPlannerEnv(api: ApiClient): Promise<void> {
  const env: Record<string, string> = {};
  for (const key of PLANNER_ENV) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  if (Object.keys(env).length === 0) return;
  await api.updateSettings({ env });
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
  const workspace = flag(subArgs, '--workspace') || process.cwd();
  const oneShot = hasFlag(subArgs, '--no-chat');
  const autoApprove = hasFlag(subArgs, '--yes');
  const verbose = hasFlag(subArgs, '--verbose');

  const port = injectedApi ? resolvePort(subArgs) : await ensureDaemon(resolvePort(subArgs));
  const api = injectedApi || new ApiClient(port);
  await forwardPlannerEnv(api);

  const state = await api.getRunners();
  const enabledIds = state.runners.filter(r => r.enabled).map(r => r.id);

  let runners: string[];
  if (runnerFlags.length === 0) {
    runners = enabledIds;
  } else {
    for (const r of runnerFlags) {
      if (!enabledIds.includes(r)) {
        console.error(`Unknown runner: "${r}". Enabled runners: ${enabledIds.join(', ')}`);
        process.exit(1);
      }
    }
    runners = runnerFlags;
  }

  console.error(`Generating plan for: "${goal}"...`);

  const sessionId = `session-${Date.now()}`;
  const isTty = !!process.stderr.isTTY;
  let lastLineLength = 0;

  function renderStep(event: WsEvent): void {
    const line = formatStepLine(event, { verbose });
    if (line === null) return;
    if (isTty) {
      // The in-flight call owns the status line; everything settled scrolls
      // above it, so completed calls and their outcomes stay on screen.
      process.stderr.write(`\r\x1b[2K${line}`);
      if (isTransient(event)) {
        lastLineLength = line.length;
      } else {
        process.stderr.write('\n');
        lastLineLength = 0;
      }
    } else {
      process.stderr.write(`${line}\n`);
    }
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
    void handleApproval(event);
  });

  try {
    let plan: SerializedPlan | undefined;
    let models: DiscoveredModel[] = [];

    if (oneShot) {
      const result = await withSpinner('Researching codebase and building task plan', () =>
        api.generatePlan(goal, runners, workspace, sessionId),
      );
      plan = result.plan;
      models = result.models ?? [];
    } else {
      plan = await withSpinner('Researching codebase and building task plan', () =>
        api.startConversation(sessionId, goal, runners, workspace),
      );

      // Grill-me / PRD / review turns land here: the planner asked something
      // instead of committing, so answer it and hand the reply back.
      while (!hasCommittedPlan(plan)) {
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
    }

    stream.close();
    if (isTty && lastLineLength > 0) process.stderr.write('\r\x1b[2K');
    process.stderr.write('\n');

    printPlan(plan, sessionId, runners, models);
    saveLastSession(sessionId, goal, plan.runners || runners, workspace);
    console.log(`\n  Run 'ordewell run' to execute, 'ordewell status' to inspect, or 'ordewell tui' for the full UI.`);
  } catch (err) {
    reader?.close();
    stream.close();
    if (isTty && lastLineLength > 0) process.stderr.write('\r\x1b[2K');
    process.stderr.write('\n');
    console.error(`Plan generation failed: ${err instanceof Error ? (err as Error).message : String(err)}`);
    process.exit(1);
  }
}
