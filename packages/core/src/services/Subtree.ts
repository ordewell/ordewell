import { flattenTasks, type Task } from '../models/Task';
import { checkHandoff, handoffReferenceText, pinReference, type BelowPlan, type FindingSeverity, type Handoff, type HandoffCheck, type HandoffDigest, type HandoffEvidence, type HandoffFinding, type HandoffPins, type ReportItem, type SubtreeReport, type TaskEvidence } from '../models/Handoff';
import { onOneLine } from '../models/lineBreaks';
import { isWithin, ROOT_NODE, type NodePath } from '../models/TreeEvent';
import { handoffAttempt, handoffLogs, loggedHandoff, type TaskLogReader } from './readTask';
import { taskRefOf } from './TaskRefs';

/** One node as a tree's log names it (ADR-0058 S3). */
export interface SubtreeNode {
  path: NodePath;
  sessionId: string;
  /** The delegated task of the plan above it. */
  taskId?: string;
}

/** A plan of the tree, read afresh: its tasks, and the logs of its attempts. */
export interface NodePlan {
  node: NodePath;
  tasks: readonly Task[];
  logs: TaskLogReader;
}

export interface SubtreeSource {
  /** The node reading: what is below it is what this reads. */
  here: NodePath;
  /** Every node ever opened below `here`, closed ones too: a reference outlives the child it names (ADR-0057 R1). */
  nodes(): readonly SubtreeNode[];
  /** What a node's session file holds of its plan, which is read only when asked for (ADR-0055 D17). */
  plan(node: SubtreeNode): readonly Task[] | undefined;
  logs(node: SubtreeNode): TaskLogReader;
}

/** The first segment below `here`: the child a deeper node hangs from. */
function topChild(path: NodePath, here: NodePath): NodePath {
  return path.split('/').slice(0, here.split('/').length + 1).join('/');
}

/**
 * The plans below one node, as a reference reads them (ADR-0057 R1): a
 * reader's reach goes down and never up, or sideways, so a child's tools see
 * nothing of the plan that holds its check (ADR-0055 D8).
 */
export class Subtree {
  constructor(private readonly source: SubtreeSource, private readonly reach?: ReadonlySet<string>) {}

  /** What a task reads: only what hangs from a delegated task its readable set holds. */
  reachedBy(readable: ReadonlySet<string>): Subtree {
    return new Subtree(this.source, readable);
  }

  private nodes(): readonly SubtreeNode[] {
    const { reach } = this;
    const nodes = this.source.nodes();
    if (!reach) return nodes;
    const here = this.source.here;
    const roots = new Map(nodes.map((node) => [node.path, node]));
    return nodes.filter(({ path }) => {
      const top = roots.get(topChild(path, here));
      return top?.taskId !== undefined && reach.has(top.taskId);
    });
  }

  private planOf(node: SubtreeNode): NodePlan | undefined {
    const tasks = this.source.plan(node);
    return tasks && { node: node.path, tasks, logs: this.source.logs(node) };
  }

  /** Every plan below that has been saved, nearest first, each once: a Continue opens a new node for the same child and its one plan (ADR-0055 D17). */
  plans(): NodePlan[] {
    const latest = new Map(this.nodes().map((node) => [node.sessionId, node]));
    return [...latest.values()].flatMap((node) => this.planOf(node) ?? []);
  }

  /** The plan a pinned reference names, whichever of a child's nodes it was pinned against. */
  planAt(path: NodePath): NodePlan | undefined {
    const node = this.nodes().find((one) => one.path === path);
    return node && this.planOf(node);
  }

  /**
   * The plan a written path names. A report shows a path from the root and an
   * author writes one from its own plan, so a path that starts at this node
   * and goes on is read as shown; anything else is read from here.
   */
  at(path: string): NodePlan | undefined {
    const { here } = this.source;
    const absolute = `${ROOT_NODE}/${path}`;
    const relative = `${here}/${path}`;
    const nodes = this.nodes();
    const found = (absolute !== here && isWithin(absolute, here) ? nodes.find((node) => node.path === absolute) : undefined)
      ?? nodes.find((node) => node.path === relative);
    return found && this.planOf(found);
  }

  /** The same as a reference is pinned against it. */
  readonly below = (path: string): BelowPlan | undefined => {
    const plan = this.at(path);
    return plan && { node: plan.node, tasks: plan.tasks, logs: handoffLogs(plan.logs) };
  };
}

/** The handoff `attempt` of a task ended with: its log's, or the plan's digest for the attempt that digest is from. */
function handoffOf(plan: NodePlan, taskId: string, attempt: number | undefined): HandoffDigest | undefined {
  const task = flattenTasks(plan.tasks).find((t) => t.id === taskId);
  const reached = attempt ?? handoffAttempt(task, plan.logs.attempts(taskId));
  const logged = reached === undefined ? undefined : loggedHandoff(plan.logs.events(taskId, reached));
  return logged ?? (task?.handoff && (attempt === undefined || task.handoff.attempt === attempt) ? task.handoff : undefined);
}

/** A finding as it leaves its plan: what its evidence cites keeps the name that plan gave it, since no reader above has that plan to name it from. */
function crossed(finding: HandoffFinding, plan: NodePlan): HandoffFinding {
  const cross = (ref: HandoffEvidence): HandoffEvidence => (ref.kind === 'task' && ref.label === undefined
    ? { ...ref, node: ref.node ?? plan.node, label: taskRefOf(plan.tasks, ref.task) ?? ref.task } : ref);
  return { ...finding, ...(finding.evidence ? { evidence: finding.evidence.map(cross) } : {}) };
}

function countsOf(plans: readonly NodePlan[], tokens: number): Pick<SubtreeReport, 'counts' | 'findings'> {
  const counts = { done: 0, failed: 0, blocked: 0, skipped: 0, commits: 0, tokens };
  const findings: Record<FindingSeverity, number> = { blocker: 0, major: 0, minor: 0, info: 0 };
  for (const plan of plans) {
    for (const task of flattenTasks(plan.tasks)) {
      if (task.status === 'completed') {
        counts.done += 1;
        if (task.handoff?.commit) counts.commits += 1;
      } else if (task.status === 'failed') counts.failed += 1;
      else if (task.status === 'skipped') counts.skipped += 1;
      else counts.blocked += 1;
      for (const finding of handoffOf(plan, task.id, undefined)?.findings ?? []) findings[finding.severity] += 1;
    }
  }
  return { counts, findings };
}

export interface ReportInput {
  /** The subplanner's own plan. */
  plan: NodePlan;
  /** The plans below it; null with nothing delegated. */
  subtree: Subtree | null;
  /** What Ordewell counts as spent, the subtree's included. */
  tokens: number;
}

const OWN_FINDING = /^F[1-9][0-9]*$/;

/**
 * A subplanner's report, held to its own plan and subtree (ADR-0057 R1, R2):
 * its references pinned, and each it passes up read verbatim, so what its
 * parent reads is what the author wrote. The producer, the delegated task, is
 * in none of these plans, so nothing here names it.
 */
export function takeReport<H extends Handoff & { promote?: string[]; open?: string[] }>(report: H, { plan, subtree, tokens }: ReportInput): HandoffCheck<H> {
  const all = new Set(flattenTasks(plan.tasks).map((t) => t.id));
  const pins: HandoffPins = { logs: handoffLogs(plan.logs), node: plan.node, readable: all, crossing: true, ...(subtree ? { below: subtree.below } : {}) };
  const checked = checkHandoff(report, '', plan.tasks, pins);
  if (!checked.ok) return checked;
  const below = subtree?.plans() ?? [];
  const refusals: string[] = [];
  const pin = (written: string, field: string): ReportItem | undefined => {
    const ref = pinReference(plan.tasks, '', pins, { kind: 'task', task: written }, field, 0, (why) => refusals.push(why));
    if (!ref) return undefined;
    if (ref.finding === undefined) {
      refusals.push(`${field}: ${JSON.stringify(written)} names no finding: give one, as "#4/F3".`);
      return undefined;
    }
    const from = ref.node === plan.node ? plan : below.find((one) => one.node === ref.node) ?? (ref.node ? subtree?.planAt(ref.node) : undefined);
    const finding = from && handoffOf(from, ref.task, ref.attempt)?.findings.find((f) => f.id === ref.finding);
    if (!from || !finding) {
      refusals.push(`${field}: ${JSON.stringify(written)} cannot be read: neither its attempt's log nor the plan keeps that finding's words.`);
      return undefined;
    }
    return { ref: ref as TaskEvidence, finding: crossed(finding, from) };
  };
  const own = (written: string, field: string): ReportItem | undefined => {
    const index = Number(written.slice(1)) - 1;
    const finding = checked.handoff.findings?.[index];
    if (!finding) refusals.push(`${field}: ${JSON.stringify(written)} is not a finding of this handoff: it has ${checked.handoff.findings?.length ?? 0}.`);
    return finding && { finding: { id: written, ...finding } };
  };
  const promoted = (report.promote ?? []).flatMap((written, i) => pin(written, `promote[${i}]`) ?? []);
  const open = (report.open ?? []).flatMap((written, i) => (OWN_FINDING.test(written) ? own(written, `open[${i}]`) : pin(written, `open[${i}]`)) ?? []);
  if (refusals.length > 0) return { ok: false, refusal: [...refusals, 'Fix or drop each reference named, then call task_complete again; nothing was recorded.'].join('\n') };
  return { ok: true, handoff: { ...checked.handoff, subtree: { node: plan.node, ...countsOf([plan, ...below], tokens), open, promoted } } };
}

/** How many findings a listing holds before it counts the rest. */
const LISTED_MAX = 100;

/**
 * What a report left out, each by its reference (ADR-0057 R2): every finding
 * of the subtree it did not show, so a reader can pull the one it wants.
 */
export function subtreeListing(subtree: SubtreeReport, plans: readonly NodePlan[]): string[] {
  const shown = new Set([...subtree.open, ...subtree.promoted].flatMap((item) => (item.ref ? [handoffReferenceText(item.ref)] : [])));
  const listed: string[] = [];
  for (const plan of plans.filter(({ node }) => isWithin(node, subtree.node))) {
    for (const task of flattenTasks(plan.tasks)) {
      const handoff = handoffOf(plan, task.id, undefined);
      const label = taskRefOf(plan.tasks, task.id) ?? task.id;
      for (const finding of handoff?.findings ?? []) {
        const ref = handoffReferenceText({ kind: 'task', node: plan.node, task: task.id, label, ...(handoff?.attempt !== undefined ? { attempt: handoff.attempt } : {}), finding: finding.id });
        if (!shown.has(ref)) listed.push(`- ${ref} [${finding.severity}] ${onOneLine(finding.title)}`);
      }
    }
  }
  if (listed.length === 0) return [];
  const more = listed.length - LISTED_MAX;
  return ['', 'The rest of its subtree (each in its author\'s words):', ...listed.slice(0, LISTED_MAX), ...(more > 0 ? [`+${more} more`] : [])];
}
