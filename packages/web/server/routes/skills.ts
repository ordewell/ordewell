import { Hono } from 'hono';
import { assertWorkspaceExists, createSkillsService, type SkillsResponse } from '@ordewell/core';
import { WebConfig } from '../adapters/WebConfig';
import { failure } from './errors';

/**
 * The skills a composer lists for the workspace: global, the workspace's own
 * and, in a folder of several repositories, each one's. Name, description,
 * what it applies to and whether a person may invoke it: never the body
 * (plans.skillBodies.test.ts says why).
 */
export function skillsRoute() {
  const router = new Hono();

  router.get('/', (c) => {
    try {
      const workspace = c.req.query('workspace') || process.cwd();
      assertWorkspaceExists(workspace);
      // The daemon's own config names a repo group, as its `/name` lookup reads it.
      const skills = createSkillsService(workspace, new WebConfig().workspaceRepos).listSkills();
      return c.json({
        skills: skills.map((s) => ({ name: s.name, description: s.description, appliesTo: s.appliesTo, userInvocable: s.userInvocable })),
      } satisfies SkillsResponse);
    } catch (err) {
      return failure(c, err, 'list skills');
    }
  });

  return router;
}
