// The .vsix ships no node_modules, so any bare require left in the bundle that
// the host cannot resolve kills activation with "Cannot find module" and the
// panel never renders. 0.4.0 shipped that way with require('uuid'). This runs
// on every build, so the publish path cannot skip it.
import { builtinModules } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { BUILTIN_SKILL_NAMES } from '@ordewell/core';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BUNDLE = join(ROOT, 'dist', 'extension.js');

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

// SKILL.md files are data, not code — tsup never bundles them, so
// scripts/copy-skills.mjs must place them at packages/vscode/skills/ before
// this runs. Missing ones here mean the .vsix ships with an empty
// ~/.ordewell/skills seed after install.
const missingSkills = BUILTIN_SKILL_NAMES.filter(
  (name) => !existsSync(join(ROOT, 'skills', name, 'SKILL.md')),
);

if (missingSkills.length > 0) {
  console.error(
    `verify-bundle: ${missingSkills.length} built-in skill(s) missing from packages/vscode/skills:\n` +
      missingSkills.map((name) => `  skills/${name}/SKILL.md`).join('\n') +
      `\n\nRun scripts/copy-skills.mjs (part of the "build" script) before packaging.\n`,
  );
  process.exit(1);
}

console.log(`verify-bundle: ok — all ${BUILTIN_SKILL_NAMES.length} built-in skill(s) present.`);
