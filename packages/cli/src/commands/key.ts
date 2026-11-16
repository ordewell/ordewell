import { PROVIDER_PRIORITY, endpointUrlProblem, getProviderMeta, isApiProvider, type AiProvider } from '@ordewell/core';
import type { ApiClient } from '../apiClient';
import { positionals } from '../utils';
import { connect, fail, fetchCatalog, persistEnv } from './shared';

/** The provider whose endpoint, not a key, is what sets it up: a local server takes no key. */
const CUSTOM = 'openai_compatible' satisfies AiProvider;

const CUSTOM_USAGE = `Usage: ordewell key set ${CUSTOM} <base-url> [<key>]`;
const USAGE = `Usage: ordewell key [list | set <provider> <key> | set ${CUSTOM} <base-url> [<key>]]`;

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
      const meta = getProviderMeta(id);
      const configured = catalog.providers.includes(id);
      // Custom is named by its endpoint, which is what configures it.
      const variable = (id === CUSTOM ? meta.baseUrlEnvVar : undefined) ?? meta.apiKeyEnvVar;
      console.log(`  ${configured ? '✓' : ' '} ${id.padEnd(14)} ${variable.padEnd(28)} ${meta.label}`);
    }
    console.log(`\n  ✓ = a working key was found. ${USAGE}`);
    return;
  }

  if (!provider) fail(USAGE);
  const id = provider.toLowerCase();
  if (!isApiProvider(id)) {
    fail(`Unknown provider: ${provider}`, 'Run `ordewell key` to see the list.');
  }
  const meta = getProviderMeta(id);

  if (id === CUSTOM && meta.baseUrlEnvVar) {
    const [baseUrl = '', ...customKey] = keyParts;
    const problem = endpointUrlProblem(baseUrl);
    if (problem) fail(problem, CUSTOM_USAGE);
    const key = customKey.join(' ').trim();
    // Its key is optional, and none given takes away the one saved before
    // (`removesCredential`): kept, it would be sent to the new endpoint.
    await persistEnv(api, { [meta.baseUrlEnvVar]: baseUrl.trim(), [meta.apiKeyEnvVar]: key });
    console.log(key
      ? `${meta.label} endpoint and key saved to ${meta.baseUrlEnvVar} and ${meta.apiKeyEnvVar}.`
      : `${meta.label} endpoint saved to ${meta.baseUrlEnvVar}, with no key: ${meta.apiKeyEnvVar} is cleared.`);
    return;
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
