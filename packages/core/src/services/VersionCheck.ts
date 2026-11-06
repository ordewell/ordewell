import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { globalDataDir } from '../utils/globalDataDir';
import { writePrivateFile } from '../utils/privateFile';
import { upgradeCommand } from '../utils/seaRuntime';

/**
 * The daily version check (ADR-0048): one ping a day that counts installs
 * under an install ID replaced every 30 days, and may answer with a newer
 * version, which the state file keeps until an answer says otherwise.
 */

export const VERSION_CHECK_URL = 'https://ordewell.ai/api/v1/ping';

export const VERSION_CHECK_NOTICE =
  'Ordewell checks for a new version once a day, sending its version and a random install ID that is replaced every 30 days. '
  + 'Like any server, ordewell.ai sees your IP address. '
  + 'Set ORDEWELL_NO_VERSION_CHECK=1 to turn this off. Details: https://ordewell.ai/docs#version-check';

/** Shared by every surface on the machine, so the machine is one install. */
const STATE_FILE = 'version-check.json';
const TIMEOUT_MS = 3_000;
const DAY_MS = 24 * 60 * 60 * 1000;
/**
 * How long an install ID lives. A month is long enough to count a machine as
 * one install and short enough that no ID outlives the counts around it: the
 * dataset keeps three months, and an ID that never changed would join all of
 * them into one machine's history.
 */
const INSTALL_ID_TTL_MS = 30 * DAY_MS;
/**
 * How often a running process asks whether the day is up. Not a day: the file
 * is shared, so the clock that matters is whichever surface checked last.
 */
const RECHECK_MS = 60 * 60 * 1000;

/** The slice of `fetch` the check uses; the platform `fetch` satisfies it. */
export type PingFetch = (
  url: string,
  init: { method: 'GET'; signal: AbortSignal; redirect: 'manual' },
) => Promise<{ status: number; text(): Promise<string> }>;

export interface VersionCheckOptions {
  /** The running version, sent as `v` and compared against the answer. */
  version: string;
  /** The one-time notice, on the first start on a machine. */
  onNotice(text: string): void;
  /** A newer version is out; `text` is the line to show. Without it no line is shown, and none recorded. */
  onUpdate?(text: string, latest: string): void;
  /**
   * How often the update line is shown: on every start, as the TUI's notice
   * is, or at most once a day across the machine, for a headless command that
   * may run many times a day.
   */
  updateLine?: 'every-start' | 'daily';
  /**
   * How the update line tells the user to update; the npm upgrade by default,
   * so only a caller that knows it was installed another way names one.
   */
  howToUpdate?: string;
  /** False turns the whole check off, as the off-switch variables do. */
  telemetryEnabled?: boolean;
  env?: Record<string, string | undefined>;
  /** Where the state file lives; `globalDataDir()` by default. */
  stateDir?: string;
  fetch?: PingFetch;
  now?: () => number;
}

export interface VersionCheck {
  /** Settles once no ping is in flight. Never rejects. */
  settled(): Promise<void>;
  /** Stops the daily re-check. */
  stop(): void;
}

interface State {
  installId?: string;
  /** When {@link State.installId} was minted; absent means its age is unknown. */
  installIdAt?: string;
  noticeShownAt?: string;
  lastCheckAt?: string;
  /**
   * The newer version the last answer named, kept so that every start can
   * name it, not just the one start a day that pings. Cleared by an answer
   * that names none.
   */
  latest?: string;
  /** When {@link State.latest} was learned. */
  latestAt?: string;
  /** When a once-a-day update line was last shown. */
  updateShownAt?: string;
}

const isDate = (value: unknown): value is string => typeof value === 'string' && !Number.isNaN(Date.parse(value));

function readState(file: string): State {
  try {
    const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (!raw || typeof raw !== 'object') return {};
    const { installId, installIdAt, noticeShownAt, lastCheckAt, latest, latestAt, updateShownAt } = raw as Record<string, unknown>;
    return {
      ...(typeof installId === 'string' && installId ? { installId } : {}),
      ...(isDate(installIdAt) ? { installIdAt } : {}),
      ...(isDate(noticeShownAt) ? { noticeShownAt } : {}),
      ...(isDate(lastCheckAt) ? { lastCheckAt } : {}),
      ...(typeof latest === 'string' && SEMVER.test(latest) ? { latest } : {}),
      ...(isDate(latestAt) ? { latestAt } : {}),
      ...(isDate(updateShownAt) ? { updateShownAt } : {}),
    };
  } catch {
    return {};
  }
}

function writeState(file: string, state: State): boolean {
  try {
    writePrivateFile(file, `${JSON.stringify(state, null, 2)}\n`);
    return true;
  } catch {
    return false;
  }
}

/**
 * The state with an install ID young enough to send. An ID whose age is unknown,
 * or whose timestamp is in the future, is replaced: an ID of unknown age could
 * already be older than the counts it stands for.
 *
 * A failed write keeps the old state, and a start that cannot write the state
 * does not ping either, so a read-only home never sends an aged ID.
 */
function rotateInstallId(file: string, state: State, at: number): State {
  if (!state.installId) return state;
  const since = state.installIdAt ? at - Date.parse(state.installIdAt) : null;
  if (since !== null && since >= 0 && since < INSTALL_ID_TTL_MS) return state;
  const rotated: State = { ...state, installId: randomUUID(), installIdAt: new Date(at).toISOString() };
  return writeState(file, rotated) ? rotated : state;
}

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/;

/** Semver precedence: positive when `a` is newer. Null when either is not a version. */
function compareVersions(a: string, b: string): number | null {
  const ma = SEMVER.exec(a);
  const mb = SEMVER.exec(b);
  if (!ma || !mb) return null;
  for (let i = 1; i <= 3; i++) {
    const diff = Number(ma[i]) - Number(mb[i]);
    if (diff !== 0) return diff;
  }
  const pa = ma[4]?.split('.');
  const pb = mb[4]?.split('.');
  if (!pa || !pb) return pa ? -1 : pb ? 1 : 0;
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if (pa[i] === undefined) return -1;
    if (pb[i] === undefined) return 1;
    const na = /^\d+$/.test(pa[i]);
    const nb = /^\d+$/.test(pb[i]);
    if (na && nb) {
      const diff = Number(pa[i]) - Number(pb[i]);
      if (diff !== 0) return diff;
    } else if (na !== nb) {
      return na ? -1 : 1;
    } else if (pa[i] !== pb[i]) {
      return pa[i] < pb[i] ? -1 : 1;
    }
  }
  return 0;
}

const isNewer = (latest: string, version: string): boolean => (compareVersions(latest, version) ?? 0) > 0;

/**
 * What an answer says: a newer version, or null for no news, which a 204 is
 * and so is a 200 whose JSON object names nothing newer. Undefined for no
 * answer at all (any other status, or a body that is not a JSON object),
 * which leaves the version already known as it was.
 */
async function readAnswer(response: Awaited<ReturnType<PingFetch>>, version: string): Promise<string | null | undefined> {
  if (response.status === 204) return null;
  if (response.status !== 200) return undefined;
  const body: unknown = JSON.parse(await response.text());
  if (!body || typeof body !== 'object') return undefined;
  const { latest } = body as { latest?: unknown };
  return typeof latest === 'string' && isNewer(latest, version) ? latest : null;
}

const truthy = (value: string | undefined): boolean => /^(1|true|yes)$/i.test(value?.trim() ?? '');

const OFF: VersionCheck = { settled: async () => {}, stop: () => {} };

/**
 * Starts the check for this process: the one-time notice on the first start
 * on a machine; otherwise the update line for a newer version an earlier
 * answer named, a ping if a day has passed since the last one, and the same
 * test again on an unref'd timer for as long as the process lives. Never
 * throws and never waits on the network.
 */
export function startVersionCheck(options: VersionCheckOptions): VersionCheck {
  const env = options.env ?? process.env;
  // Off means off: not even the file, so nothing on disk says Ordewell ran here.
  if (options.telemetryEnabled === false || truthy(env.ORDEWELL_NO_VERSION_CHECK) || truthy(env.DO_NOT_TRACK)) return OFF;
  const now = options.now ?? Date.now;
  const fetchImpl: PingFetch = options.fetch ?? fetch;
  const file = join(options.stateDir ?? globalDataDir(), STATE_FILE);
  let inFlight: Promise<void> = Promise.resolve();
  let pinging = false;

  /** The version this process last named, so that a ping repeating it does not repeat the line. */
  let named: string | undefined;
  const lessThanADayAgo = (at: string | undefined): boolean => {
    if (!at) return false;
    const since = now() - Date.parse(at);
    // A time in the future is a clock that went back; waiting it out could
    // silence the check for as long as the clock was wrong.
    return since >= 0 && since < DAY_MS;
  };

  const showUpdate = (latest: string): void => {
    if (!options.onUpdate || latest === named) return;
    if (options.updateLine === 'daily') {
      const state = readState(file);
      // As for the notice: a line that cannot be recorded would be shown on every start.
      if (lessThanADayAgo(state.updateShownAt) || !writeState(file, { ...state, updateShownAt: new Date(now()).toISOString() })) return;
    }
    named = latest;
    try {
      options.onUpdate(`Ordewell ${latest} is out (you have ${options.version}) — ${options.howToUpdate ?? upgradeCommand('npm')}`, latest);
    } catch {
      // As for the notice: a closed stderr does not fail the caller's start.
    }
  };

  const ping = async (version: string, installId: string): Promise<void> => {
    const query = new URLSearchParams({ v: version, id: installId });
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
    timer.unref?.();
    try {
      // `manual`, so the install ID goes to this one URL and never on to
      // wherever a redirect points; a 3xx is just another answer to ignore.
      const response = await fetchImpl(`${VERSION_CHECK_URL}?${query}`, {
        method: 'GET',
        signal: abort.signal,
        redirect: 'manual',
      });
      const latest = await readAnswer(response, version);
      if (latest === undefined) return;
      // Read again: another process may have written the file while this ping was out.
      const state = readState(file);
      delete state.latest;
      delete state.latestAt;
      writeState(file, latest ? { ...state, latest, latestAt: new Date(now()).toISOString() } : state);
      if (latest) showUpdate(latest);
    } finally {
      clearTimeout(timer);
    }
  };

  const check = (): void => {
    if (pinging) return;
    const state = readState(file);
    if (!state.installId) return;
    if (lessThanADayAgo(state.lastCheckAt)) return;
    // Recorded before the ping, and no ping without it: a write that fails
    // would otherwise let every start ping.
    if (!writeState(file, { ...state, lastCheckAt: new Date(now()).toISOString() })) return;
    pinging = true;
    inFlight = ping(options.version, state.installId).catch(() => {}).finally(() => { pinging = false; });
  };

  const state = rotateInstallId(file, readState(file), now());
  // A notice without an install ID starts over too: no ID means no ping, so
  // keeping the notice would leave the check off for good.
  if (!state.noticeShownAt || !state.installId) {
    // A notice that cannot be recorded would be shown on every start; nothing
    // is ever sent from such a machine, so there is nothing to tell. No
    // `lastCheckAt` either: kept, it could hold the next start's ping back a day.
    const installId = state.installId ?? randomUUID();
    const recorded = writeState(file, {
      installId,
      // A fresh ID starts its 30 days now; a kept one keeps the date it was minted.
      installIdAt: state.installId && state.installIdAt ? state.installIdAt : new Date(now()).toISOString(),
      noticeShownAt: new Date(now()).toISOString(),
    });
    // Nothing is sent from this process, timer included: the off switches are
    // read once at start, so only a later start can honour one the notice
    // just told the user about.
    try {
      if (recorded) options.onNotice(VERSION_CHECK_NOTICE);
    } catch {
      // A closed stderr is the caller's problem, not a reason to fail its start.
    }
    return OFF;
  }
  if (state.latest && isNewer(state.latest, options.version)) showUpdate(state.latest);
  check();
  const timer = setInterval(check, RECHECK_MS);
  timer.unref?.();
  return { settled: () => inFlight, stop: () => clearInterval(timer) };
}
