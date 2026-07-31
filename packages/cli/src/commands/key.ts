import { ALL_PROVIDERS, PROVIDER_PRIORITY, type AiProvider } from '@ordewell/core';
import type { ApiClient } from '../daemonClient';
import { positionals } from '../utils';
import { connect, fail, fetchCatalog, persistEnv } from './shared';

const USAGE = 'Usage: ordewell key [list | set <provider> <key>]';

export async function handleKey(subArgs: string[], injectedApi?: ApiClient): Promise<void> {
  const [action, provider, ...keyParts] = positionals(subArgs);

  if (action && action !== 'list' && action !== 'set') {
    fail(`Unknown key action: "${action}"`, USAGE);
  }

  const api = await connect(subArgs, injectedApi);

  if (action !== 'set') {
    const catalog = await fetchCatalog(api);
    console.log('\nAPI provider keys\n');
    for (const id of PROVIDER_PRIORITY) {
      const meta = ALL_PROVIDERS[id];
      const configured = catalog.providers.includes(id);
      console.log(`  ${configured ? '✓' : ' '} ${id.padEnd(14)} ${meta.apiKeyEnvVar.padEnd(28)} ${meta.label}`);
    }
    console.log(`\n  ✓ = a working key was found. ${USAGE}`);
    return;
  }

  if (!provider) fail(USAGE);
  const id = provider.toLowerCase() as AiProvider;
  const meta = ALL_PROVIDERS[id];
  if (!meta) {
    fail(`Unknown provider: ${provider}`, 'Run `ordewell key` to see the list.');
  }

  // Joined rather than taken as one token so an unquoted key with spaces still
  // arrives whole; a truncated key fails at the provider, not here.
  const key = keyParts.join(' ').trim();
  if (!key) fail(`Usage: ordewell key set ${id} <key>`);

  await persistEnv(api, { [meta.apiKeyEnvVar]: key });
  // Deliberately reports the provider and the variable, never the key itself —
  // this line ends up in scrollback and in CI logs.
  console.log(`${meta.label} key saved to ${meta.apiKeyEnvVar}.`);
}
