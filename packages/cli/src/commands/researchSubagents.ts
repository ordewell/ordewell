import { ensureDaemon, ApiClient } from '../daemonClient';

export async function handleResearchSubagents(subArgs: string[], api?: ApiClient): Promise<void> {
  const action = subArgs[0];
  const port = api ? undefined : await ensureDaemon();
  const client = api || new ApiClient(port);

  if (action === 'on' || action === 'off') {
    const result = await client.sendCommand('research-subagents', { action });
    const state = result.settings?.researchSubagents as { enabled: boolean } | undefined;
    console.log(`Research subagents: ${state?.enabled ? 'ON' : 'OFF'}`);
  } else {
    const settings = await client.getSettings();
    const researchSubagents = settings.researchSubagents as { enabled: boolean } | undefined;
    console.log(`Research subagents: ${researchSubagents?.enabled ? 'ON' : 'OFF'}`);
    console.log('Usage: ordewell research-subagents [on|off]');
  }
}
