import type { ModelsResponse, RunnersResponse, SettingsResponse } from '@ordewell/core';
import { DELEGATION_OFFERED, RUNNER_LABELS } from '@ordewell/core/plan-utils';
import type { HostToWebview, RunnerMeta } from '@ordewell/ui/protocol';
import { callDaemon, messageOf } from './daemon';
import { plannerBackendsFor } from './plannerBackends';

/**
 * Long enough for a daemon to probe every agent's CLI and its login on a
 * loaded machine; past it the chat says detection failed and offers Retry
 * rather than drawing "Detecting coding agents…" for good.
 */
export const DETECTION_TIMEOUT_MS = 20_000;

function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`the daemon did not list ${what} within ${Math.round(ms / 1000)} s`)), ms);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

function isRunners(data: unknown): data is RunnersResponse {
  return typeof data === 'object' && data !== null && Array.isArray(Reflect.get(data, 'runners'));
}

function runnerMeta(data: RunnersResponse): RunnerMeta[] {
  return data.runners.map((entry) => ({
    id: entry.id,
    displayName: entry.name || RUNNER_LABELS[entry.id] || entry.id,
    enabled: entry.enabled !== false,
  }));
}

/**
 * Which coding agents and planners this machine has, read from the app's own
 * daemon. It belongs to the workspace, not to a session: a held, joined or
 * reconnecting session changes nothing about which agents are installed, so
 * each detection resolves, within {@link DETECTION_TIMEOUT_MS}, to the list or
 * to a failure the chat shows with Retry.
 *
 * The three reads land independently. The runner list alone decides who can
 * plan without a key, so the planners are drawn the moment it names a usable
 * agent; the model catalog, which waits on every agent listing its models,
 * names the configured vendors, and until it has answered a list with no
 * agent is held back rather than drawn as "nothing can plan".
 */
export class AgentDetection {
  private run = 0;
  /** Set while a failed detection waits for the daemon to be back, to try once more on its own. */
  private offStatus: (() => void) | null = null;

  constructor(
    private readonly workspace: string,
    private readonly emit: (msg: HostToWebview) => void,
    private readonly timeoutMs = DETECTION_TIMEOUT_MS,
    /** The session whose settings answer, so the Run block shows that session's values. */
    private readonly sessionId?: () => string,
  ) {}

  /** Detect again; a detection still under way is overtaken, its late answers dropped. */
  async detect(): Promise<void> {
    const run = ++this.run;
    const current = () => run === this.run;
    this.offStatus?.();
    this.offStatus = null;
    this.emit({ type: 'agentDetection', state: 'detecting' });
    const workspace = { workspace: this.workspace };
    const sessionId = this.sessionId?.();
    const settingsQuery = { workspace: this.workspace, ...(sessionId ? { sessionId } : {}) };
    let runners: RunnersResponse | null = null;
    let providers: ModelsResponse['providers'] = [];
    let settings: SettingsResponse | null = null;
    let catalogSettled = false;
    const publish = () => {
      if (!runners || !current()) return;
      const backends = plannerBackendsFor(runners.runners, providers);
      if (!catalogSettled && !backends.some((b) => b.usable)) return;
      this.emit({ type: 'setConfiguredProviders', providers });
      this.emit({
        type: 'setPlannerBackends',
        backends,
        provider: settings?.aiProvider ?? '',
        ...(settings?.plannerThinkingEffort ? { effort: settings.plannerThinkingEffort } : {}),
      });
    };

    const listed = within(callDaemon('runners.list', workspace), this.timeoutMs, 'its coding agents')
      .then((answer) => {
        if (!isRunners(answer)) throw new Error('the daemon answered without a runner list');
        const data = answer;
        if (!current()) return;
        runners = data;
        this.emit({ type: 'setRunners', runners: runnerMeta(data) });
        publish();
      });
    const catalog = within(callDaemon('models.list', workspace) as Promise<ModelsResponse>, this.timeoutMs, 'its models')
      .then((models) => {
        if (!current()) return;
        providers = models.providers;
        this.emit({ type: 'setModels', models: models.models });
        this.emit({ type: 'setModelsByRunner', modelsByRunner: models.modelsByRunner });
        this.emit({ type: 'setModesByRunner', modesByRunner: models.modesByRunner });
        this.emit({ type: 'setModelConfig', modelConfig: { orchestrator: models.orchestratorModel } });
        this.emit({
          type: 'setModelDiscoveryErrors',
          errors: models.providerErrors ?? {},
          runnerErrors: models.runnerErrors ?? {},
        });
      })
      .finally(() => { catalogSettled = true; publish(); });
    const chosen = within(callDaemon('settings.get', settingsQuery) as Promise<SettingsResponse>, this.timeoutMs, 'its settings')
      .then((data) => {
        if (!current()) return;
        settings = data;
        // The chat's Settings panel draws its Run block from this: the open
        // session answers with its own values, and a daemon that answers
        // without a run (an old fake) leaves the block closed.
        if (data.run && typeof data.run === 'object') {
          this.emit({
            type: 'setRunSettings',
            autonomous: data.autonomousMode,
            run: data.run,
            maxParallel: data.maxParallel,
            delegationOffered: DELEGATION_OFFERED,
          });
        }
        publish();
      });

    const [found] = await Promise.allSettled([listed, catalog, chosen]);
    if (!current()) return;
    if (found.status === 'rejected') {
      // The chat leaves "Loading…" on this, to show the failure.
      this.emit({ type: 'setConfiguredProviders', providers });
      this.emit({ type: 'agentDetection', state: 'failed', error: messageOf(found.reason) });
      // A daemon that was away or restarting is the common cause: once main
      // says it is connected again the answer is likely there, so the person
      // need not find Retry for it.
      this.offStatus = window.ordewell.daemon.onStatus((status) => {
        if (status.state === 'connected' && run === this.run) void this.detect();
      });
    }
  }
}
