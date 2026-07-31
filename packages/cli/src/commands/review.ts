import { ensureDaemon, ApiClient, resolvePort } from '../daemonClient';

export async function handleReview(subArgs: string[], api?: ApiClient): Promise<void> {
  const action = subArgs[0];
  const port = api ? undefined : await ensureDaemon(resolvePort(subArgs));
  const client = api || new ApiClient(port);

  if (action === 'on' || action === 'off') {
    const result = await client.sendCommand('review', { action });
    const state = result.settings?.review as { enabled: boolean } | undefined;
    console.log(`Review mode: ${state?.enabled ? 'ON' : 'OFF'}`);
  } else {
    const settings = await client.getSettings();
    const review = settings.review as { enabled: boolean } | undefined;
    console.log(`Review mode: ${review?.enabled ? 'ON' : 'OFF'}`);
    console.log('Usage: ordewell review [on|off]');
  }
}
