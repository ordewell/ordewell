// The .vsix ships no node_modules, so any bare require left in the bundle that
// the host cannot resolve kills activation with "Cannot find module" and the
// panel never renders. 0.4.0 shipped that way with require('uuid'). This runs
// on every build, so the publish path cannot skip it.
import { builtinModules } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const BUNDLE = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'extension.js');

// Provided by the extension host, never bundled.
const HOST_PROVIDED = new Set(['vscode']);

// Optional deps behind a try/catch, absent by design. node-fetch only reaches
// `encoding` for non-UTF-8 charsets and swallows the failure.
const OPTIONAL = new Set(['encoding']);

const source = readFileSync(BUNDLE, 'utf8');
const builtins = new Set(builtinModules);

const specifiers = new Set(
  [...source.matchAll(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]),
);

const unresolvable = [...specifiers].filter((id) => {
  const bare = id.startsWith('node:') ? id.slice(5) : id;
  return (
    !builtins.has(bare) &&
    !HOST_PROVIDED.has(id) &&
    !OPTIONAL.has(id) &&
    !id.startsWith('.') &&
    !id.startsWith('/')
  );
});

if (unresolvable.length > 0) {
  console.error(
    `verify-bundle: ${unresolvable.length} module(s) left external but not shipped:\n` +
      unresolvable.map((id) => `  require('${id}')`).join('\n') +
      `\n\nAdd them to noExternal in tsup.config.ts, or to OPTIONAL here if the\n` +
      `require is genuinely guarded and the module is meant to be absent.\n`,
  );
  process.exit(1);
}

console.log(
  `verify-bundle: ok — ${specifiers.size} require(s), all builtins, host-provided or guarded.`,
);
