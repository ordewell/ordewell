import { describe, it, expect } from 'vitest';
import { SecretStore } from '../SecretStore';

/** Minimal in-memory stand-in for vscode.SecretStorage. */
function fakeSecrets(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial));
  return {
    store,
    secrets: {
      async get(key: string) {
        return store.get(key);
      },
      async store(key: string, value: string) {
        store.set(key, value);
      },
      async delete(key: string) {
        store.delete(key);
      },
      onDidChange() {
        return { dispose() {} };
      },
    },
  };
}

describe('SecretStore', () => {
  it('load() reads stored keys into the cache for synchronous get()', async () => {
    const { secrets } = fakeSecrets({ openrouterKey: 'sk-or-123' });
    const store = new SecretStore(secrets as never);

    await store.load();

    expect(store.get('openrouterKey')).toBe('sk-or-123');
  });

  it('get() returns undefined for a key that was never stored', async () => {
    const { secrets } = fakeSecrets({ openrouterKey: 'sk-or-123' });
    const store = new SecretStore(secrets as never);
    await store.load();

    expect(store.get('geminiKey')).toBeUndefined();
  });

  it('set() persists to SecretStorage and updates the cache', async () => {
    const { store: backing, secrets } = fakeSecrets();
    const store = new SecretStore(secrets as never);
    await store.load();

    await store.set('openrouterKey', 'sk-or-new');

    expect(store.get('openrouterKey')).toBe('sk-or-new'); // cache
    expect(backing.get('openrouterKey')).toBe('sk-or-new'); // persisted
  });

  it('configuredProviders() lists only providers with a non-empty key', async () => {
    const noneStore = new SecretStore(fakeSecrets().secrets as never);
    await noneStore.load();
    expect(noneStore.configuredProviders()).toEqual([]);

    const orStore = new SecretStore(fakeSecrets({ openrouterKey: 'sk' }).secrets as never);
    await orStore.load();
    expect(orStore.configuredProviders()).toEqual(['openrouter']);

    const gemStore = new SecretStore(fakeSecrets({ geminiKey: 'g' }).secrets as never);
    await gemStore.load();
    expect(gemStore.configuredProviders()).toEqual(['google']);

    const bothStore = new SecretStore(fakeSecrets({ openrouterKey: 'sk', geminiKey: 'g' }).secrets as never);
    await bothStore.load();
    expect(bothStore.configuredProviders()).toEqual(['openrouter', 'google']);

    const compatStore = new SecretStore(fakeSecrets({ openaiCompatibleKey: 'sk-custom' }).secrets as unknown as import("vscode").SecretStorage);
    await compatStore.load();
    expect(compatStore.configuredProviders()).toEqual(['openai_compatible']);
  });
});
