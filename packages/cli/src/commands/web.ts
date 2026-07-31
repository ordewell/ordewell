import { existsSync } from 'fs';
import { startDaemon, resolvePort } from '../daemonClient';
import { spawn } from 'child_process';
import { resolve } from 'path';
export async function handleWeb(subArgs: string[]): Promise<void> {
  const port = resolvePort(subArgs);

  if (subArgs.includes('--daemon')) {
    await startDaemon(port);
  } else {

    const serverPath = resolve(__dirname, '..', '..', 'web', 'dist', 'server', 'main.js');
    if (!existsSync(serverPath)) {
      console.error(`Web server not found at ${serverPath}. Run: npm run build -w packages/web`);
      process.exit(1);
    }

    const child = spawn(process.execPath, [serverPath, '--port', String(port)], {
      stdio: 'inherit',
      env: { ...process.env },
    });

    child.on('exit', (code: number | null) => process.exit(code ?? 0));
  }
}
