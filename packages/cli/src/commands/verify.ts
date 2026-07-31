import { ensureDaemon, ApiClient, resolvePort } from '../daemonClient';

export async function handleVerify(subArgs: string[], api?: ApiClient): Promise<void> {
  const action = subArgs[0];
  const port = api ? undefined : await ensureDaemon(resolvePort(subArgs));
  const client = api || new ApiClient(port);

  if (action === 'on' || action === 'off') {
    const result = await client.sendCommand('verify', { action });
    const state = result.settings?.verification as { enabled: boolean } | undefined;
    console.log(`Verification mode: ${state?.enabled ? 'ON' : 'OFF'}`);
  } else {
    const settings = await client.getSettings();
    const verification = settings.verification as { enabled: boolean } | undefined;
    console.log(`Verification mode: ${verification?.enabled ? 'ON' : 'OFF'}`);
    console.log('Usage: ordewell verify [on|off]');
  }
}
