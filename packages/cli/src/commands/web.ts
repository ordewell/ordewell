import { existsSync } from 'fs';
import { daemonCommand, startDaemon, resolvePort } from '../daemon';
import { spawn } from 'child_process';
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

    child.on('exit', (code: number | null) => process.exit(code ?? 0));
  }
}
