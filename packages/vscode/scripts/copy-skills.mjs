// Built-in skills (grilling, to-spec) are markdown, not code, so tsup never
// bundles them into dist/extension.js. The .vsix ships no node_modules (see
// .vscodeignore), so this copies them to packages/vscode/skills/ — a sibling
// of dist/ — where builtinSkillsDir() in @ordewell/core expects to find them
// at runtime (`<extension-root>/dist/../skills`).
import { createRequire } from 'node:module';
import { cpSync, existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

// Resolved through the @ordewell/core package (not a relative ../../core/skills
// path) so this works identically against the workspace symlink in the
// monorepo and against a real installed dependency in a clean checkout —
// the published package is the source of truth either way.
const corePackageJson = require.resolve('@ordewell/core/package.json');
const sourceDir = join(dirname(corePackageJson), 'skills');

const destDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills');

if (!existsSync(sourceDir)) {
  console.error(`copy-skills: source dir not found: ${sourceDir}`);
  process.exit(1);
}

rmSync(destDir, { recursive: true, force: true });
cpSync(sourceDir, destDir, { recursive: true });

console.log(`copy-skills: copied ${sourceDir} -> ${destDir}`);
