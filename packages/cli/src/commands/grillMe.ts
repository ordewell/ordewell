import { ensureDaemon, ApiClient, resolvePort } from '../daemonClient';

export async function handleGrillMe(subArgs: string[]): Promise<void> {
  const action = subArgs[0];
  const port = await ensureDaemon(resolvePort(subArgs));
  const api = new ApiClient(port);

  if (action === 'on' || action === 'off') {
    const result = await api.sendCommand('grill-me', { action });
    const state = result.settings?.grillMe as { enabled: boolean } | undefined;
    console.log(`Grill-Me: ${state?.enabled ? 'ON' : 'OFF'}`);
  } else {
    const settings = await api.getSettings();
    const grillMe = settings.grillMe as { enabled: boolean } | undefined;
    console.log(`Grill-Me: ${grillMe?.enabled ? 'ON' : 'OFF'}`);
    console.log('Usage: ordewell grill-me [on|off]');
  }
}
