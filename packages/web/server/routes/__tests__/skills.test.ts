import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { skillsRoute } from '../skills';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function skill(root: string, name: string, front: string): void {
  const dir = path.join(root, '.ordewell', 'skills', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} does a thing\n${front}---\nSECRET-BODY\n`);
}

describe('GET /api/skills', () => {
  it('lists the workspace\'s skills without their bodies', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'skills-route-'));
    dirs.push(root);
    skill(root, 'zz-route-open', '');
    skill(root, 'zz-route-quiet', 'user-invocable: false\n');
    const app = new Hono().route('/api/skills', skillsRoute());

    const res = await app.request(`/api/skills?workspace=${encodeURIComponent(root)}`);
    const text = await res.text();

    expect(res.status).toBe(200);
    expect(text).not.toContain('SECRET-BODY');
    const { skills } = JSON.parse(text) as { skills: { name: string; description: string; appliesTo: string; userInvocable: boolean }[] };
    expect(skills.find((s) => s.name === 'zz-route-open')).toEqual({ name: 'zz-route-open', description: 'zz-route-open does a thing', appliesTo: 'planner', userInvocable: true });
    expect(skills.find((s) => s.name === 'zz-route-quiet')?.userInvocable).toBe(false);
  });

  it('refuses a workspace that is not there', async () => {
    const app = new Hono().route('/api/skills', skillsRoute());
    const res = await app.request('/api/skills?workspace=/no/such/dir-xyz');
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});
