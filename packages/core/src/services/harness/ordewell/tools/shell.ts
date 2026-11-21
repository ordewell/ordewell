import { spawn } from 'node:child_process';
import { resolveResearchShell } from '../../../researchShell';
import { killTree, spawnInOwnGroup } from '../../../../utils/processTree';
import { buildToolEnv } from './shellEnv';
import type { OrdewellTool } from './types';
import { waitRefusal } from './waitGuard';

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
/** What is held in memory of a chatty command; the wrapper's cap and saved file see this much, tail first. */
const MAX_CAPTURE_BYTES = 16 * 1024 * 1024;

export const shellTool: OrdewellTool = {
  name: 'shell',
  description: 'Run one command line in the worktree with the platform shell (bash, or cmd.exe where Git Bash is missing on Windows). Returns the combined output and the exit code. Output beyond 2000 lines or 50 KiB keeps its end; the full text is saved to a file you can read. The environment is minimal: it holds no API keys or tokens.',
  effect: 'exec',
  // A failing build or test says why at the end.
  keep: 'tail',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The command line to run.' },
      timeout: { type: 'number', description: `Milliseconds to wait before the command is killed. Default ${DEFAULT_TIMEOUT_MS}, at most ${MAX_TIMEOUT_MS}.` },
    },
    required: ['command'],
    additionalProperties: false,
  },
  async execute(args, context) {
    const command = String(args.command);
    const waits = context.waits ? waitRefusal(command, { parks: context.waits.parks === true }) : null;
    if (waits) return { text: waits, isError: true, details: { exitCode: null, refused: 'wait' } };
    const requested = typeof args.timeout === 'number' && Number.isFinite(args.timeout) && args.timeout > 0 ? args.timeout : DEFAULT_TIMEOUT_MS;
    const timeoutMs = Math.min(requested, MAX_TIMEOUT_MS);
    const shell = resolveResearchShell();
    const env = buildToolEnv(context.env, shell);

    const child = spawnInOwnGroup((detached) =>
      shell.file === null
        ? spawn(command, { shell: true, cwd: context.worktree, env, detached, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
        : spawn(shell.file, [...shell.args, command], { cwd: context.worktree, env, detached, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }),
    );

    const chunks: Buffer[] = [];
    let held = 0;
    let dropped = false;
    const collect = (chunk: Buffer): void => {
      chunks.push(chunk);
      held += chunk.length;
      while (held > MAX_CAPTURE_BYTES && chunks.length > 1) {
        held -= chunks.shift()!.length;
        dropped = true;
      }
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);

    let timedOut = false;
    let aborted = false;
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs);
    const onAbort = (): void => { aborted = true; killTree(child); };
    context.signal.addEventListener('abort', onAbort, { once: true });
    if (context.signal.aborted) onAbort();

    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; spawnError?: Error }>((resolve) => {
      child.once('error', (spawnError) => resolve({ code: null, signal: null, spawnError }));
      // 'close', not 'exit': the output is complete only once the pipes have ended.
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    clearTimeout(timer);
    context.signal.removeEventListener('abort', onAbort);

    // runTool turns an abort into a rethrow; there is no result worth returning.
    if (aborted) context.signal.throwIfAborted();
    if (exit.spawnError) return { text: `Could not start the shell: ${exit.spawnError.message}`, isError: true, details: { exitCode: null } };

    const output = (dropped ? '[earlier output dropped]\n' : '') + Buffer.concat(chunks).toString('utf8');
    const body = output === '' || output.endsWith('\n') ? output : `${output}\n`;
    const status = timedOut
      ? `[timed out after ${timeoutMs} ms and was killed]`
      : exit.signal
        ? `[killed by ${exit.signal}]`
        : `[exit code ${exit.code}]`;
    return {
      text: `${body}${status}`,
      isError: timedOut || exit.code !== 0,
      details: { exitCode: exit.code, signal: exit.signal, timedOut },
    };
  },
};
