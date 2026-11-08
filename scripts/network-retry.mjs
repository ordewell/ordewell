// A command that downloads as it builds (electron-builder's toolsets, a docker
// build's apt and npm installs) can fail because a mirror or CDN dropped one
// fetch, which is no verdict on the change. Such a command is run here: its
// output streams through as it would, and a failure whose output names a
// network fault gets another try after a pause that grows. Any other failure
// is the command's own and ends the first try.
import { spawn } from 'node:child_process';

const NETWORK_FAULTS = [
  // got's HTTPError, as electron-builder prints it ("Response code 504 (Gateway Time-out)").
  /Response code 5\d\d\b/,
  /\b(502 Bad Gateway|503 Service (Temporarily )?Unavailable|504 Gateway Time-?out)\b/i,
  /\b(ETIMEDOUT|ECONNRESET|EAI_AGAIN|ENOTFOUND|ENETUNREACH|ESOCKETTIMEDOUT)\b/,
  /socket hang up/i,
  /Temporary failure (resolving|in name resolution)/i,
  /Could not resolve (host|'[^']+')/i,
  /TLS handshake timeout|i\/o timeout/i,
  // npm's own report of a failed fetch, as a `RUN npm install` prints it.
  /npm (ERR!|error) network\b/,
  // apt's, as a `RUN apt-get install` prints it.
  /Failed to fetch https?:\/\/|Unable to fetch some archives/,
];

/** Whether a failed command's output names a fault of the network rather than of the command. */
export function isNetworkFault(output) {
  return NETWORK_FAULTS.some((fault) => fault.test(output));
}

/** The last bytes of output kept to judge a failure by: a fault is near the end. */
const TAIL = 256 * 1024;

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function runOnce(file, args, { cwd, env, input, stdout, stderr }) {
  return new Promise((resolve) => {
    let tail = '';
    const keep = (chunk) => { tail = (tail + chunk.toString()).slice(-TAIL); };
    const child = spawn(file, args, { cwd, env, stdio: [input === undefined ? 'inherit' : 'pipe', 'pipe', 'pipe'] });
    child.stdout.on('data', (chunk) => { stdout.write(chunk); keep(chunk); });
    child.stderr.on('data', (chunk) => { stderr.write(chunk); keep(chunk); });
    if (input !== undefined) child.stdin.end(input);
    child.on('error', (error) => resolve({ status: null, signal: null, error, tail }));
    child.on('close', (status, signal) => resolve({ status, signal, tail }));
  });
}

/**
 * Runs a command until it succeeds, fails on its own account, or has failed on
 * the network `tries` times. Resolves to its last exit: `{ status, signal, error }`.
 */
export async function runRetryingNetwork(file, args, {
  cwd, env, input, tries = 4, delay = (attempt) => attempt * 15_000, sleep = pause,
  stdout = process.stdout, stderr = process.stderr, log = console.warn,
} = {}) {
  for (let attempt = 1; ; attempt++) {
    const result = await runOnce(file, args, { cwd, env, input, stdout, stderr });
    if (result.status === 0 || attempt === tries || !isNetworkFault(result.tail)) {
      return { status: result.status, signal: result.signal, error: result.error };
    }
    const wait = delay(attempt);
    log(`${process.env.GITHUB_ACTIONS ? '::warning::' : ''}${[file, ...args].join(' ')} failed on the network (try ${attempt} of ${tries}); trying again in ${Math.round(wait / 1000)}s.`);
    await sleep(wait);
  }
}
