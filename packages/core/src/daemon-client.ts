/**
 * Node entry point for a client of the local daemon that is not itself a
 * host: the desktop app's main process (ADR-0060 H1). It reaches the daemon's
 * files and handshake without loading the main barrel, which brings the
 * planner, the runners and every AI service with it.
 */
export {
  DEFAULT_DAEMON_PORT,
  DAEMON_CONTRACT,
  daemonPidFilePath,
  legacyDaemonPidFilePath,
  daemonLogPath,
  readPidFile,
  resolveDaemonPort,
  isConnectionRefused,
  daemonHttpGet,
  isDaemonRunning,
  probeDaemon,
  stopDaemonAt,
} from './utils/daemonProcess';
export type { DaemonHttpResponse, DaemonIdentity, DaemonProbe, DaemonStopOutcome } from './utils/daemonProcess';
export {
  daemonTokenPath,
  readDaemonToken,
  bearerHeaderValue,
  tokenSubprotocols,
  DAEMON_SUBPROTOCOL,
} from './utils/daemonToken';
export { augmentedPath, withPath } from './utils/shellPath';
export { globalDataDir } from './utils/globalDataDir';
export { compareVersions } from './utils/version';
export { readLiveHolder, LEASE_STALE_MS } from './utils/leaseRecord';
export type { LeaseHostKind, SessionLeaseRecord, LiveHolderProbes } from './utils/leaseRecord';
