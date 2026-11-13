import { existsSync } from 'fs';
import { daemonCommand, startDaemon, resolvePort } from '../daemon';
import { spawn } from 'child_process';
import { constants } from 'os';
import { resolve } from 'path';
export async function handleWeb(subArgs: string[]): Promise<void> {
  const port = resolvePort(subArgs);

  if (subArgs.includes('--daemon')) {
    await startDaemon(port);
  } else {

    const command = daemonCommand(['--port', String(port)], () => {
      const serverPath = resolve(__dirname, '..', '..', 'web', 'dist', 'server', 'main.js');
      if (!existsSync(serverPath)) {
        console.error(`Web server not found at ${serverPath}. Run: npm run build -w packages/web`);
        process.exit(1);
      }
      return serverPath;
    });

    const child = spawn(command.file, command.args, {
      stdio: 'inherit',
      env: { ...process.env },
    });

    // The child shares this process's group but a signal sent to this pid
    // alone would otherwise kill the wrapper and leave the server on its port.
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
      process.on(signal, () => { child.kill(signal); });
    }

    child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      // A signal-killed child has no code; the shell convention is 128 + n,
      // not a success.
      process.exit(code ?? (signal ? 128 + (constants.signals[signal] ?? 0) : 0));
    });
  }
}
