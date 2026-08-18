import { Hono } from 'hono';
import type { OrchestratorPool } from '../pool/orchestratorPool';

interface CommandDescriptor {
  name: string;
  description: string;
}

const COMMANDS: CommandDescriptor[] = [
  { name: 'grill-me', description: 'Toggle Grill-Me challenge mode (on|off|status)' },
  { name: 'tdd', description: 'Toggle Test-Driven Development mode (on|off|status)' },
  { name: 'prd', description: 'Toggle PRD mode — planner writes a markdown PRD before the plan (on|off|status)' },
  { name: 'verify', description: 'Toggle verification mode — adds a final evidence-based verification task that runs the full suite (on|off|status)' },
  { name: 'research-subagents', description: 'Toggle parallel research subagents — the planner may fan out read-only research agents during planning (on|off|status)' },
];

export function commandsRoute(pool: OrchestratorPool) {
  const router = new Hono();

  router.get('/', (c) => {
    return c.json({ commands: COMMANDS });
  });

  router.post('/:name', async (c) => {
    const name = c.req.param('name');
    const body = await c.req.json().catch(() => ({}));
    const args: Record<string, string> = body?.args || {};

    const command = COMMANDS.find((cmd) => cmd.name === name);
    if (!command) {
      return c.json({ error: `Unknown command: ${name}` }, 404);
    }

    if (name === 'grill-me') {
      const action = args.action || 'status';
      if (action === 'on') {
        pool.updateSettings({ grillMe: { enabled: true } });
      } else if (action === 'off') {
        pool.updateSettings({ grillMe: { enabled: false } });
      }
      return c.json({ ok: true, settings: pool.getSettings() });
    }

    if (name === 'tdd') {
      const action = args.action || 'status';
      if (action === 'on') {
        pool.updateSettings({ tdd: { enabled: true } });
      } else if (action === 'off') {
        pool.updateSettings({ tdd: { enabled: false } });
      }
      return c.json({ ok: true, settings: pool.getSettings() });
    }

    if (name === 'prd') {
      const action = args.action || 'status';
      if (action === 'on') {
        pool.updateSettings({ prd: { enabled: true } });
      } else if (action === 'off') {
        pool.updateSettings({ prd: { enabled: false } });
      }
      return c.json({ ok: true, settings: pool.getSettings() });
    }

    if (name === 'verify') {
      const action = args.action || 'status';
      if (action === 'on') {
        pool.updateSettings({ verification: { enabled: true } });
      } else if (action === 'off') {
        pool.updateSettings({ verification: { enabled: false } });
      }
      return c.json({ ok: true, settings: pool.getSettings() });
    }

    if (name === 'research-subagents') {
      const action = args.action || 'status';
      if (action === 'on') {
        pool.updateSettings({ researchSubagents: { enabled: true } });
      } else if (action === 'off') {
        pool.updateSettings({ researchSubagents: { enabled: false } });
      }
      return c.json({ ok: true, settings: pool.getSettings() });
    }

    return c.json({ error: `Unknown command: ${name}` }, 404);
  });

  return router;
}
