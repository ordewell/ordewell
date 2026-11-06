import { describe, expect, it } from 'vitest';
import { BUILTIN_MANIFESTS } from '../builtin';
import { CLI_PROVIDERS, PROVIDER_LABEL } from '../../services/ProviderRegistry';
import { RUNNER_CATALOG, RUNNER_INSTALL_DOCS, RUNNER_LABELS } from '../../services/runnerCatalog';
import { builtinPlannerBackends } from '../../services/plannerBackends';

// The catalog a renderer can read (the manifests carry Node-only readers) must
// say what every built-in manifest says, or a surface would offer a runner the
// host cannot start under another name.
describe('the built-in runner catalog', () => {
  it('names every harness planner, with its label and an https install page', () => {
    expect(CLI_PROVIDERS).toHaveLength(8);
    expect(RUNNER_CATALOG.map((runner) => runner.id)).toEqual(CLI_PROVIDERS);
    for (const id of CLI_PROVIDERS) {
      expect(RUNNER_LABELS[id]).toBe(PROVIDER_LABEL[id]);
      expect(RUNNER_INSTALL_DOCS[id]).toMatch(/^https:\/\/\S+$/);
    }
  });

  it('lists every one as a planner, a missing one greyed with its reason', () => {
    const backends = builtinPlannerBackends({}, []);
    expect(backends.map((backend) => backend.id)).toEqual(CLI_PROVIDERS);
    for (const backend of backends) {
      expect(backend.usable).toBe(false);
      expect(backend.reason).toBe('not available');
    }
  });

  it('agrees with the manifest that declares the runner', () => {
    for (const manifest of BUILTIN_MANIFESTS) {
      const entry = RUNNER_CATALOG.find((runner) => runner.id === manifest.name);
      expect(entry?.label, manifest.name).toBe(manifest.displayName);
      expect(entry?.installDocs, manifest.name).toMatch(/^https:\/\//);
    }
  });
});
