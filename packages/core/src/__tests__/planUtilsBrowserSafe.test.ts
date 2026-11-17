import { builtinModules } from 'node:module';
import { join, relative } from 'node:path';
import { build, type Plugin } from 'esbuild';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..');

/** Each module the entry reaches that imports a Node built-in, as `<file> -> <built-in>`. */
async function builtinsReached(entry: string): Promise<string[]> {
  const reached = new Set<string>();
  const builtins = new Set(builtinModules);
  const record: Plugin = {
    name: 'record-builtins',
    setup(on) {
      on.onResolve({ filter: /^(node:)?[a-z_]+$/ }, (args) => {
        const name = args.path.replace(/^node:/, '');
        if (!builtins.has(name)) return undefined;
        reached.add(`${relative(SRC, args.importer).split('\\').join('/')} -> ${name}`);
        return { path: args.path, external: true };
      });
    },
  };
  await build({ entryPoints: [join(SRC, entry)], bundle: true, platform: 'browser', format: 'esm', write: false, logLevel: 'silent', external: ['uuid'], plugins: [record] });
  return [...reached].sort();
}

// The webviews bundle `@ordewell/core/plan-utils` for a browser, where Vite
// stands an empty module in for a Node built-in: a named import from one (a
// settings file read, a lock's `randomUUID`) fails the VS Code and desktop
// builds, long after core's own tests passed.
describe('the browser-safe entry, plan-utils', () => {
  it('reaches no Node built-in but the path namespace a landing record reads only on the host', async () => {
    expect(await builtinsReached('plan-utils.ts')).toEqual(['services/isolationRecord.ts -> path']);
  });
});
