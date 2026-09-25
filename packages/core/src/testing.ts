import type { IConfig } from './interfaces/IConfig';
import type { IFileSystem, ToolOutcome } from './interfaces/IFileSystem';
import type { ITerminalSession } from './interfaces/ITerminalRunner';
import type {
  IsolationAvailability,
  IsolationHandoff,
  IsolationMergeResult,
  IsolationOutcome,
  IsolationRun,
  PreparedTask,
  IWorktreeIsolation,
} from './interfaces/IWorktreeIsolation';
import type { Task } from './models/Task';
import { handoffOf, integrationBranchFor, SELF_REPO } from './services/isolationRecord';

export function fakeConfig(overrides: Partial<IConfig> = {}): IConfig {
  return {
    aiProvider: 'openrouter',
    apiKey: 'sk-test',
    planningModel: 'test-model',
    enabledRunners: ['claude-code'],
    maxParallelSessions: 3,
    researchEnabled: false,
    researchMaxSteps: 10,
    researchMaxFileSize: 100_000,
    openAiBaseUrl: 'https://api.openai.com/v1',
    openAiApiKey: '',
    openrouterKey: '',
    geminiKey: '',
    openaiCompatibleBaseUrl: '',
    openaiCompatibleApiKey: '',
    orchestratorModel: '',
    researchSubagentModel: '',
    geminiModel: '',
    planMapEnabled: true,
    autonomousMode: true,
    // Off so an orchestrator built without an injected isolation never runs
    // real git against whatever repository the tests happen to run in.
    worktreeIsolation: false,
    workspaceRepos: [],
    worktreeLinks: [],
    approvalMode: 'ask',
    approvalPreApproved: [],
    setProviderModelLists: () => {},
    getProviderBaseUrl: () => '',
    getProviderApiKey: () => '',
    ...overrides,
  };
}

const EMPTY_OUTCOME: ToolOutcome = { success: false, output: '', truncated: false };

/**
 * A complete {@link IFileSystem} stub. Lives here rather than in each package's
 * test folder so adding a tool to the interface is one edit, not one per suite.
 */
export function fakeFileSystem(overrides: Partial<IFileSystem> = {}): IFileSystem {
  return {
    readFile: async () => EMPTY_OUTCOME,
    readFiles: async () => EMPTY_OUTCOME,
    glob: async () => EMPTY_OUTCOME,
    grep: async () => EMPTY_OUTCOME,
    findSymbol: async () => EMPTY_OUTCOME,
    listDir: async () => EMPTY_OUTCOME,
    bash: async () => EMPTY_OUTCOME,
    getWorkspaceRoot: () => '/workspace',
    ...overrides,
  };
}

export class FakeTerminalSession implements ITerminalSession {
  private outputCbs: Array<(text: string) => void> = [];
  private exitCbs: Array<(code: number) => void> = [];
  output = '';
  written: string[] = [];
  killed = false;

  constructor(public id = 's1', public taskId = 't1') {}

  onOutput(cb: (text: string) => void): void { this.outputCbs.push(cb); }
  onExit(cb: (code: number) => void): void { this.exitCbs.push(cb); }
  kill(): void { this.killed = true; }
  getOutput(): string { return this.output; }
  write(text: string): void { this.written.push(text); }

  emitOutput(text: string): void {
    this.output += text;
    for (const cb of this.outputCbs) cb(text);
  }
  emitExit(code: number): void {
    for (const cb of this.exitCbs) cb(code);
  }
}

export type FakeIsolationCall =
  | { op: 'isActive'; workspaceRoot: string }
  | { op: 'stash'; workspaceRoot: string }
  | { op: 'startRun'; workspaceRoot: string }
  | { op: 'prepare'; taskId: string }
  | { op: 'integrate'; taskId: string }
  | { op: 'release'; taskId: string; keep: boolean }
  | { op: 'handoff' | 'pruneOrphans' | 'reviewDiff' | 'mergeIntoCheckedOut' }
  | { op: 'discard'; keepIntegration: boolean };

/**
 * An in-memory {@link IWorktreeIsolation} for scheduling tests: no git, no
 * filesystem. Every call is logged in `calls`; `prepare` hands back a
 * deterministic fake cwd. Set `availability` to exercise the fallbacks, `outcomes`
 * to script a conflict, and `holdIntegration` to keep a task un-integrated so a
 * test can observe that its dependents wait. `repos` makes the run a group of
 * several; `changes` and `stopsIn` say which of them a task changes and where
 * its landing stops.
 */
export class FakeWorktreeIsolation implements IWorktreeIsolation {
  availability: IsolationAvailability = { active: true };
  /** The repo paths `startRun` groups: a group of one at `.` unless set. */
  repos: string[] = [SELF_REPO];
  /** Per task id, the repos it changes; every repo of the group when not listed. */
  changes = new Map<string, string[]>();
  /** Per task id, the repo its landing stops in when its outcome is not `merged`; its first changed repo when not listed. */
  stopsIn = new Map<string, string>();
  /** What `mergeIntoCheckedOut` answers. */
  mergeResult: IsolationMergeResult = { outcome: 'merged' };
  /** What `startRun` shares and `prepare` copies, to exercise their notices. */
  shared: string[] = [];
  sharedRepos: string[] = [];
  copied: string[] = [];
  /** Set to make `startRun` throw, as git does when no repo of the group can be isolated. */
  startRunError: Error | null = null;
  /** Per task id; a task not listed integrates as `merged`. */
  outcomes = new Map<string, IsolationOutcome>();
  calls: FakeIsolationCall[] = [];
  private holds = new Map<string, Promise<void>>();
  private runCount = 0;

  private log(call: FakeIsolationCall): void { this.calls.push(call); }

  /** Task ids in the order `op` was called for them. */
  taskIdsFor(op: 'prepare' | 'integrate' | 'release'): string[] {
    return this.calls.flatMap((c) => (c.op === op && 'taskId' in c ? [c.taskId] : []));
  }

  /** Make `integrate` for this task wait until the returned function is called. */
  holdIntegration(taskId: string): () => void {
    let open!: () => void;
    this.holds.set(taskId, new Promise<void>((resolve) => { open = resolve; }));
    return open;
  }

  async isActive(workspaceRoot: string): Promise<IsolationAvailability> {
    this.log({ op: 'isActive', workspaceRoot });
    return this.availability;
  }

  /** Like git: once the tracked changes are stashed, the tree is no longer dirty. */
  async stash(workspaceRoot: string): Promise<void> {
    this.log({ op: 'stash', workspaceRoot });
    if (!this.availability.active && this.availability.reason === 'dirty') this.availability = { active: true };
  }

  async startRun(workspaceRoot: string): Promise<IsolationRun> {
    this.log({ op: 'startRun', workspaceRoot });
    if (this.startRunError) throw this.startRunError;
    const id = `run${++this.runCount}`;
    return {
      id,
      workspaceRoot,
      repos: this.repos.map((repo) => ({
        path: repo, root: `${workspaceRoot}/${repo}`.replace(/\/\.$/, ''), baseRef: 'base0000', baseBranch: 'main', integrationBranch: integrationBranchFor(id),
      })),
      shared: [...this.shared],
      sharedRepos: [...this.sharedRepos],
      tasks: {},
    };
  }

  async prepare(task: Task, run: IsolationRun): Promise<PreparedTask> {
    this.log({ op: 'prepare', taskId: task.id });
    const name = `${task.order}-${task.id}`;
    const cwd = `/fake-worktrees/${run.id}/${name}`;
    const branch = `ordewell/${run.id}/${name}`;
    run.tasks[task.id] = {
      taskId: task.id, order: task.order, title: task.title, branch, workspace: cwd, status: 'active',
      repos: Object.fromEntries(run.repos.map((r) => [r.path, { worktree: r.path === SELF_REPO ? cwd : `${cwd}/${r.path}`, linked: [] }])),
    };
    return { cwd, branch, copied: [...this.copied] };
  }

  /** Like git: the landing is recorded and persisted before the (held) merge, and cleared once it settles. */
  async integrate(task: Task, run: IsolationRun, persist: () => void = () => undefined): Promise<IsolationOutcome> {
    this.log({ op: 'integrate', taskId: task.id });
    const record = run.tasks[task.id];
    if (!record) return 'failed';
    const changed = this.changes.get(task.id) ?? run.repos.map((r) => r.path);
    for (const [repo, entry] of Object.entries(record.repos)) entry.changed = changed.includes(repo) || (entry.changed ?? false);
    if (changed.length > 0) {
      run.landing = { taskId: task.id, tips: Object.fromEntries(changed.map((repo) => [repo, `tip-${repo}`])) };
      persist();
    }
    await this.holds.get(task.id);
    delete run.landing;
    const outcome = this.outcomes.get(task.id) ?? 'merged';
    record.status = outcome;
    if (outcome === 'merged') delete record.conflictRepo;
    else record.conflictRepo = this.stopsIn.get(task.id) ?? changed[0] ?? SELF_REPO;
    return outcome;
  }

  async release(run: IsolationRun, taskId: string, opts: { keep: boolean }): Promise<void> {
    this.log({ op: 'release', taskId, keep: opts.keep });
    const record = run.tasks[taskId];
    if (!opts.keep) delete run.tasks[taskId];
    else if (record?.status === 'active') record.status = 'kept';
  }

  async handoff(run: IsolationRun): Promise<IsolationHandoff> {
    this.log({ op: 'handoff' });
    return handoffOf(run);
  }

  async pruneOrphans(): Promise<void> { this.log({ op: 'pruneOrphans' }); }
  async reviewDiff(): Promise<string> { this.log({ op: 'reviewDiff' }); return ''; }
  async mergeIntoCheckedOut(): Promise<IsolationMergeResult> { this.log({ op: 'mergeIntoCheckedOut' }); return this.mergeResult; }
  async discard(_run: IsolationRun, opts: { keepIntegration: boolean }): Promise<void> {
    this.log({ op: 'discard', keepIntegration: opts.keepIntegration });
  }
}
