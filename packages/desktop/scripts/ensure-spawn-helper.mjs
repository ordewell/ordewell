// node-pty spawns every shell through a small `spawn-helper` binary and the
// prebuilt ones it publishes carry no executable bit in their tarball, so a
// checkout that never ran a package build cannot open a terminal (every pty
// spawn answers "posix_spawnp failed"). Packaging rebuilds node-pty from
// source, which is why the gap only shows up before the first package or on a
// fresh install. Windows has no helper, and a source build writes its own, so
// this only ever repairs what npm unpacked.
import { chmodSync, existsSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const ptyDir = join(require.resolve('node-pty/package.json'), '..');

const candidates = [];
const prebuilds = join(ptyDir, 'prebuilds');
if (existsSync(prebuilds)) {
  for (const platform of readdirSync(prebuilds)) candidates.push(join(prebuilds, platform, 'spawn-helper'));
}
candidates.push(join(ptyDir, 'build', 'Release', 'spawn-helper'));

for (const helper of candidates) {
  if (!existsSync(helper)) continue;
  if ((statSync(helper).mode & 0o111) !== 0) continue;
  chmodSync(helper, 0o755);
  console.log(`Made ${helper} executable, so a terminal can start before the app is packaged.`);
}
