import { ensureDaemon, ApiClient, resolvePort } from '../daemonClient';

export async function handlePrd(subArgs: string[]): Promise<void> {
  const action = subArgs[0];
  const port = await ensureDaemon(resolvePort(subArgs));
  const api = new ApiClient(port);

  if (action === 'on' || action === 'off') {
    const result = await api.sendCommand('prd', { action });
    const state = result.settings?.prd as { enabled: boolean } | undefined;
    console.log(`PRD mode: ${state?.enabled ? 'ON' : 'OFF'}`);
  } else {
    const settings = await api.getSettings();
    const prd = settings.prd as { enabled: boolean } | undefined;
    console.log(`PRD mode: ${prd?.enabled ? 'ON' : 'OFF'}`);
    console.log('Usage: ordewell prd [on|off]');
    console.log('When ON, the planner previews and writes a markdown PRD (saved to .scratch/<slug>/PRD.md) before the task plan.');
  }
}
