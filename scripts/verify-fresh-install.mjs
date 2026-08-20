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

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-fresh-'));
process.env.HOME = home;

check(!fs.existsSync(path.join(home, '.ordewell')), '~/.ordewell/ does not exist');
check(!fs.existsSync(path.join(home, '.config', 'ordewell')), '~/.config/ordewell/ does not exist');

const { createSkillsService } = await import('@ordewell/core');
const svc = createSkillsService();

const grilling = svc.findSkill('grilling');
check(grilling !== undefined, 'findSkill("grilling") returns the seeded skill');
check(grilling !== undefined && grilling.content.includes('design tree'), 'grilling seeded content is the built-in skill');
check(grilling !== undefined && grilling.source === 'global', 'grilling is seeded into ~/.ordewell/skills (global)');

const spec = svc.findSkill('to-spec');
check(spec !== undefined, 'findSkill("to-spec") returns the seeded skill');
check(spec !== undefined && spec.content.includes('spec'), 'to-spec seeded content is the built-in skill');
check(spec !== undefined && spec.source === 'global', 'to-spec is seeded into ~/.ordewell/skills (global)');

check(
  fs.existsSync(path.join(home, '.ordewell', 'skills', 'grilling', 'SKILL.md')) &&
    fs.existsSync(path.join(home, '.ordewell', 'skills', 'to-spec', 'SKILL.md')),
  'seeded skills are written to ~/.ordewell/skills on disk',
);

if (failures > 0) {
  console.error(`\nverify-fresh-install: ${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nverify-fresh-install: all checks passed');
process.exit(0);
