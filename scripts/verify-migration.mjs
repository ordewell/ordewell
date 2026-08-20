#!/usr/bin/env node
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let failures = 0;
function check(cond, message) {
  if (cond) {
    console.log(`  ok  ${message}`);
  } else {
    failures += 1;
    console.error(`FAIL  ${message}`);
  }
}

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-migration-'));
process.env.HOME = home;

const settingsContent = '{"tddEnabled":true,"verificationEnabled":false,"model":"claude-sonnet-4-5"}';
const oldDir = path.join(home, '.config', 'ordewell');
fs.mkdirSync(oldDir, { recursive: true });
fs.writeFileSync(path.join(oldDir, 'settings.json'), settingsContent);

const newDir = path.join(home, '.ordewell');
check(!fs.existsSync(newDir), '~/.ordewell/ does not exist before migration');

const { migrateOldConfigDir } = await import('@ordewell/core');
migrateOldConfigDir();

check(fs.existsSync(path.join(newDir, 'settings.json')), '~/.ordewell/settings.json exists after migration');
check(
  fs.readFileSync(path.join(newDir, 'settings.json'), 'utf8') === settingsContent,
  '~/.ordewell/settings.json content matches the original',
);
check(
  fs.readFileSync(path.join(oldDir, 'settings.json'), 'utf8') === settingsContent,
  'legacy ~/.config/ordewell/settings.json is preserved (copied, not moved)',
);

if (failures > 0) {
  console.error(`\nverify-migration: ${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nverify-migration: all checks passed');
process.exit(0);
