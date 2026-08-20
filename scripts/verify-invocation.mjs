#!/usr/bin/env node

let failures = 0;
function check(cond, message) {
  if (cond) {
    console.log(`  ok  ${message}`);
  } else {
    failures += 1;
    console.error(`FAIL  ${message}`);
  }
}

const skillsService = {
  findSkill: (name) =>
    name === 'grilling'
      ? { content: '# Grilling\n\nBody.' }
      : name === 'to-spec'
        ? { content: '# To Spec\n\nBody.' }
        : undefined,
  listSkills: () => [{ name: 'grilling' }, { name: 'to-spec' }],
};

const { resolveSkillInvocation } = await import('@ordewell/core');

const grilled = resolveSkillInvocation('/grilling', skillsService);
check(grilled === '# Grilling\n\nBody.', '/grilling is replaced with the skill content');
check(!grilled.includes('/grilling'), 'substituted result does not contain the literal "/grilling"');

const specd = resolveSkillInvocation('/to-spec', skillsService);
check(specd === '# To Spec\n\nBody.', '/to-spec is replaced with the skill content');
check(!specd.includes('/to-spec'), 'substituted result does not contain the literal "/to-spec"');

const unknown = resolveSkillInvocation('/unknown', skillsService);
check(unknown.includes('Unknown skill'), 'an unknown skill becomes an Unknown-skill notice');
check(!unknown.includes('/unknown'), 'unknown notice does not contain the bare "/unknown" token');

const plain = 'just a normal question';
check(resolveSkillInvocation(plain, skillsService) === plain, 'plain text passes through unchanged');

const multiword = 'please grill my plan';
check(resolveSkillInvocation(multiword, skillsService) === multiword, 'multi-word non-invocation text passes through unchanged');

if (failures > 0) {
  console.error(`\nverify-invocation: ${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nverify-invocation: all checks passed');
process.exit(0);
