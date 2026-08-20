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

const globalHome = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-skills-global-'));
process.env.HOME = globalHome;

const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-skills-project-'));

const testMeBody = '# Test Me\n\nKnown test-me content.';
const overrideBody = '# Override Me\n\nKnown local override content.';

const globalSkillDir = path.join(globalHome, '.ordewell', 'skills', 'test-me');
fs.mkdirSync(globalSkillDir, { recursive: true });
fs.writeFileSync(path.join(globalSkillDir, 'SKILL.md'), testMeBody);

const localSkillDir = path.join(projectDir, '.ordewell', 'skills', 'override-me');
fs.mkdirSync(localSkillDir, { recursive: true });
fs.writeFileSync(path.join(localSkillDir, 'SKILL.md'), overrideBody);

const { SkillsService } = await import('@ordewell/core');
const svc = new SkillsService(projectDir);

const testMe = svc.findSkill('test-me');
check(testMe !== undefined, 'findSkill("test-me") returns a skill');
check(testMe && testMe.content === testMeBody, 'findSkill("test-me") content matches the file');
check(testMe && testMe.source === 'global', 'findSkill("test-me") reports global source');

const override = svc.findSkill('override-me');
check(override !== undefined, 'findSkill("override-me") returns a skill');
check(override && override.content === overrideBody, 'findSkill("override-me") returns the local content');
check(override && override.source === 'local', 'findSkill("override-me") reports local source');

check(svc.findSkill('nonexistent') === undefined, 'findSkill("nonexistent") returns undefined');

const names = svc.listSkills().map((s) => s.name);
check(names.includes('test-me'), 'listSkills() includes test-me');
check(names.includes('override-me'), 'listSkills() includes override-me');

if (failures > 0) {
  console.error(`\nverify-skills: ${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nverify-skills: all checks passed');
process.exit(0);
