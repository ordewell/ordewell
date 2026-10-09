import { Hono } from 'hono';
import type { CommandDescriptor, CommandsResponse } from '@ordewell/core';
import { refuse } from './errors';

// Every command this route ran was a mode toggle, and none is left; the
// route stays so a client listing commands still gets an answer.
const COMMANDS: CommandDescriptor[] = [];

export function commandsRoute() {
  const router = new Hono();

  router.get('/', (c) => {
    return c.json({ commands: COMMANDS } satisfies CommandsResponse);
  });

  router.post('/:name', (c) => {
    const name = c.req.param('name');
    return refuse(c, 404, `Unknown command: ${name}`);
  });

  return router;
}
