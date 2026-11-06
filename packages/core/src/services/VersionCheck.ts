import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { globalDataDir } from '../utils/globalDataDir';
import { writePrivateFile } from '../utils/privateFile';
import { upgradeCommand } from '../utils/seaRuntime';

/**
 * The daily version check (ADR-0048): one ping a day that counts installs
 * under an install ID replaced every 30 days, and may answer with a newer
 * version.
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
  /** A newer version is out; `text` is the line to show. */
  onUpdate(text: string, latest: string): void;
  /**
   * What the update line tells the user to run; the npm upgrade by default,
   * so only a caller that knows it was installed another way names one.
   */
  upgradeCommand?: string;
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
}

function readState(file: string): State {
  try {
    const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (!raw || typeof raw !== 'object') return {};
    const { installId, installIdAt, noticeShownAt, lastCheckAt } = raw as Record<string, unknown>;
    return {
      ...(typeof installId === 'string' && installId ? { installId } : {}),
      ...(typeof installIdAt === 'string' && !Number.isNaN(Date.parse(installIdAt)) ? { installIdAt } : {}),
      ...(typeof noticeShownAt === 'string' && !Number.isNaN(Date.parse(noticeShownAt)) ? { noticeShownAt } : {}),
      ...(typeof lastCheckAt === 'string' && !Number.isNaN(Date.parse(lastCheckAt)) ? { lastCheckAt } : {}),
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

/** The `latest` of a 200 answer, if it is newer than `version`; anything else is no news. */
async function newerVersion(response: Awaited<ReturnType<PingFetch>>, version: string): Promise<string | null> {
  if (response.status !== 200) return null;
  const body: unknown = JSON.parse(await response.text());
  const latest = body && typeof body === 'object' ? (body as { latest?: unknown }).latest : undefined;
  if (typeof latest !== 'string') return null;
  return (compareVersions(latest, version) ?? 0) > 0 ? latest : null;
}

const truthy = (value: string | undefined): boolean => /^(1|true|yes)$/i.test(value?.trim() ?? '');

const OFF: VersionCheck = { settled: async () => {}, stop: () => {} };

/**
 * Starts the check for this process: the one-time notice on the first start
 * on a machine, otherwise a ping if a day has passed since the last one, and
 * the same test again on an unref'd timer for as long as the process lives.
 * Never throws and never waits on the network.
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
      const latest = await newerVersion(response, version);
      if (latest) options.onUpdate(`Ordewell ${latest} is out — ${options.upgradeCommand ?? upgradeCommand('npm')}`, latest);
    } finally {
      clearTimeout(timer);
    }
  };

  const check = (): void => {
    if (pinging) return;
    const state = readState(file);
    if (!state.installId) return;
    if (state.lastCheckAt) {
      const since = now() - Date.parse(state.lastCheckAt);
      // A last check in the future is a clock that went back; waiting it out
      // could silence the check for as long as the clock was wrong.
      if (since >= 0 && since < DAY_MS) return;
    }
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
  check();
  const timer = setInterval(check, RECHECK_MS);
  timer.unref?.();
  return { settled: () => inFlight, stop: () => clearInterval(timer) };
}
