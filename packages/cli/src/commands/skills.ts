import { abbreviateHome, createSkillsService, EnvConfig, type SkillInfo } from '@ordewell/core';
import { resolve } from 'path';
import { flag, hasFlag, positionals } from '../utils';
import { fail } from './shared';

function invocation(skill: SkillInfo): string {
  if (skill.userInvocable && skill.modelInvocable) return 'both';
  if (skill.userInvocable) return 'user';
  if (skill.modelInvocable) return 'model';
  return 'none';
}

export function handleSkills(subArgs: string[]): void {
  if (positionals(subArgs).length > 0) {
    fail('Usage: ordewell skills [--workspace /path] [--json]');
  }
  const workspace = resolve(flag(subArgs, '--workspace') || process.cwd());
  const catalog = createSkillsService(workspace, new EnvConfig().workspaceRepos).readCatalog();
  const skills = catalog.skills.map((skill) => ({
    name: skill.name,
    scope: skill.source,
    appliesTo: skill.appliesTo,
    invocation: invocation(skill),
    path: abbreviateHome(skill.path),
  }));
  const shadowed = catalog.shadowed.map(({ skill, shadowedBy }) => ({
    name: skill.name,
    path: abbreviateHome(skill.path),
    shadowedBy: shadowedBy.source,
  }));
  const invalid = catalog.invalid.map((skill) => ({
    name: skill.name,
    path: abbreviateHome(skill.path),
    reason: skill.reason,
  }));

  if (hasFlag(subArgs, '--json')) {
    console.log(JSON.stringify({ skills, shadowed, invalid }, null, 2));
    return;
  }
  const skipped = [
    ...shadowed.map((skill) => `workspace skill "${skill.name}" shadowed by ${skill.shadowedBy} · ${skill.path}`),
    ...invalid.map((skill) => `skill folder "${skill.name}" skipped: ${skill.reason} · ${skill.path}`),
  ];
  if (skills.length === 0) {
    console.log('No skills installed.');
    for (const line of skipped) console.log(line);
    return;
  }

  const headers = ['Name', 'Scope', 'Applies-to', 'Invocation', 'SKILL.md'];
  const rows = skills.map((skill) => [skill.name, skill.scope, skill.appliesTo, skill.invocation, skill.path]);
  const widths = headers.map((header, i) => Math.max(header.length, ...rows.map((row) => row[i].length)));
  const format = (row: string[]) => row.map((cell, i) => i === row.length - 1 ? cell : cell.padEnd(widths[i])).join('  ');
  console.log(format(headers));
  for (const row of rows) console.log(format(row));
  if (skipped.length > 0) {
    console.log('');
    for (const line of skipped) console.log(line);
  }
}
