import { ensureDaemon, ApiClient, resolvePort } from '../daemonClient';

export async function handleTdd(subArgs: string[]): Promise<void> {
  const action = subArgs[0];
  const port = await ensureDaemon(resolvePort(subArgs));
  const api = new ApiClient(port);

  if (action === 'on' || action === 'off') {
    const result = await api.sendCommand('tdd', { action });
    const state = result.settings?.tdd as { enabled: boolean } | undefined;
    console.log(`TDD mode: ${state?.enabled ? 'ON' : 'OFF'}`);
  } else {
    const settings = await api.getSettings();
    const tdd = settings.tdd as { enabled: boolean } | undefined;
    console.log(`TDD mode: ${tdd?.enabled ? 'ON' : 'OFF'}`);
    console.log('Usage: ordewell tdd [on|off]');
  }
}
