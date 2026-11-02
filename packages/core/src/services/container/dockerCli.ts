import { spawn, type ChildProcess } from 'child_process';
import { createWriteStream } from 'fs';
import { augmentedPath, withPath } from '../../utils/shellPath';
import { cleanEnv } from '../gitExec';

/** How one `docker` command ended; `code` is -1 for a CLI that could not start. */
export interface DockerResult {
  code: number;
  stdout: string;
  stderr: string;
  /** Its stdout passed {@link DockerCall.stdoutTo}'s limit, and it was killed for it. */
  overflowed?: true;
}

export interface DockerCall {
  input?: string | Buffer;
  /** Over this host's, for the CLI: what `-e NAME` hands over, so a secret never sits in an argument (ADR-0022 A5). */
  env?: Readonly<Record<string, string>>;
  timeoutMs?: number;
  /** Stdout to a file rather than to memory, for a bundle of any size up to `maxBytes`. */
  stdoutTo?: { file: string; maxBytes: number };
}

/**
 * The Docker API through the docker CLI (ADR-0059 L5): one code path for any
 * local engine that speaks it. `inspectEngine` is what holds it to a local one.
 */
export interface DockerCli {
  call(args: readonly string[], opts?: DockerCall): Promise<DockerResult>;
  /** A command that runs for as long as a container does, with its stdio left open. */
  entry(args: readonly string[]): Promise<ChildProcess>;
}

const CALL_TIMEOUT_MS = 120_000;
const KILLED = 137;

export class SpawnedDockerCli implements DockerCli {
  constructor(private readonly resolvePath: () => Promise<string> = augmentedPath) {}

  private async environment(env: Readonly<Record<string, string>> = {}): Promise<NodeJS.ProcessEnv> {
    return { ...withPath(cleanEnv(), await this.resolvePath()), ...env };
  }

  async call(args: readonly string[], { input, env, timeoutMs = CALL_TIMEOUT_MS, stdoutTo }: DockerCall = {}): Promise<DockerResult> {
    const child = spawn('docker', [...args], { env: await this.environment(env), stdio: ['pipe', 'pipe', 'pipe'] });
    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let written = 0;
      let overflowed = false;
      const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
      timer.unref?.();
      const sink = stdoutTo ? createWriteStream(stdoutTo.file, { mode: 0o600 }) : null;
      child.stdout.on('data', (chunk: Buffer) => {
        if (!sink) {
          stdout += chunk.toString();
          return;
        }
        written += chunk.length;
        if (written > stdoutTo!.maxBytes) {
          overflowed = true;
          child.kill('SIGKILL');
        } else sink.write(chunk);
      });
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
      child.stdin.on('error', () => undefined);
      child.stdin.end(input);
      const finish = (code: number) => {
        clearTimeout(timer);
        const done = () => resolve({ code, stdout, stderr, ...(overflowed ? { overflowed: true as const } : {}) });
        if (sink) sink.end(done);
        else done();
      };
      child.once('error', (err) => {
        stderr += err.message;
        finish(-1);
      });
      // A signal is how a timeout ends it, and that CLI did start: the shell's own number for it, not -1.
      child.once('close', (code) => finish(code ?? KILLED));
    });
  }

  async entry(args: readonly string[]): Promise<ChildProcess> {
    return spawn('docker', [...args], { env: await this.environment(), stdio: ['pipe', 'pipe', 'pipe'] });
  }
}
