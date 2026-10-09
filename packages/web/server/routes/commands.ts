import { Hono } from 'hono';
import type { CommandDescriptor, CommandResponse, CommandsResponse } from '@ordewell/core';
import type { OrchestratorPool } from '../pool/orchestratorPool';
import { refuse } from './errors';

const COMMANDS: CommandDescriptor[] = [
  { name: 'tdd', description: 'Toggle Test-Driven Development mode (on|off|status)' },
];

/** Commands whose on/off writes a single boolean settings block, keyed by the command name. */
const BOOLEAN_TOGGLES: Record<string, 'tdd'> = { tdd: 'tdd' };

export function commandsRoute(pool: OrchestratorPool) {
  const router = new Hono();

  router.get('/', (c) => {
    return c.json({ commands: COMMANDS } satisfies CommandsResponse);
  });

  router.post('/:name', async (c) => {
    const name = c.req.param('name');
    const body = await c.req.json().catch(() => ({}));
    const args: Record<string, string> = body?.args || {};

    const command = COMMANDS.find((cmd) => cmd.name === name);
    if (!command) {
      return refuse(c, 404, `Unknown command: ${name}`);
    }

    const toggle = BOOLEAN_TOGGLES[name];
    if (toggle) {
      const action = args.action || 'status';
      if (action === 'on') {
        pool.updateSettings({ [toggle]: { enabled: true } });
      } else if (action === 'off') {
        pool.updateSettings({ [toggle]: { enabled: false } });
      }
      return c.json({ ok: true, settings: pool.getSettings() } satisfies CommandResponse);
    }

    return refuse(c, 404, `Unknown command: ${name}`);
  });

  return router;
}
