import { ensureDaemon, ApiClient, resolvePort } from '../daemonClient';

const USAGE = `Usage:
  ordewell allowlist set <runner> <id1,id2,…>    Set allowlist for a runner
  ordewell allowlist clear <runner>              Clear allowlist for a runner
  ordewell allowlist show [<runner>]             Show allowlists (default)
  ordewell allowlist                             Same as "show"`;

export async function handleAllowlist(subArgs: string[], _api?: ApiClient): Promise<void> {
  const api = _api ?? new ApiClient(await ensureDaemon(resolvePort(subArgs)));
  const sub = subArgs[0];

  if (!sub || sub === 'show') {
    await handleShow(subArgs.slice(1), api);
    return;
  }

  if (sub === 'set') {
    return handleSet(subArgs.slice(1), api);
  }

  if (sub === 'clear') {
    return handleClear(subArgs.slice(1), api);
  }

  console.error(`Unknown subcommand: ${sub}`);
  console.error(USAGE);
  process.exit(1);
}

async function handleSet(args: string[], api: ApiClient): Promise<void> {
  const runner = args[0];
  const idsRaw = args[1];
  if (!runner || !idsRaw) {
    console.error('Usage: ordewell allowlist set <runner> <id1,id2,…>');
    process.exit(1);
  }
  const ids = idsRaw.split(',').map((s) => s.trim()).filter(Boolean);
  if (ids.length === 0) {
    console.error('Usage: ordewell allowlist set <runner> <id1,id2,…>');
    process.exit(1);
  }
  await rejectStrayIds(runner, ids, api);
  const result = await api.updateSettings({ modelAllowlist: { [runner]: ids } });
  const allowlist = (result.modelAllowlist as Record<string, string[] | undefined>)?.[runner];
  console.log(`Allowlist set for ${runner}: ${(allowlist ?? ids).join(', ')}`);
}

/**
 * Refuse ids the runner was never discovered with. Model ids are scoped to the
 * agent that lists them, so allowlisting an OpenRouter slug for Claude Code
 * limits it to a model it cannot spawn — and the failure only surfaces once a
 * task is already running. A runner with no discovered models says nothing
 * about the ids, so it is left alone (discovery may simply be cold).
 *
 * Stricter than the planner-side rule in `effectiveAllowlist`, deliberately:
 * there the user is absent and a tolerated id costs one unfiltered catalog,
 * here they are present and can be told which id was wrong.
 */
async function rejectStrayIds(runner: string, ids: string[], api: ApiClient): Promise<void> {
  let discovered: string[] = [];
  try {
    const { modelsByRunner } = await api.getModels();
    discovered = (modelsByRunner?.[runner] ?? []).map((m: any) => String(m.modelId ?? m.id));
  } catch {
    return;
  }
  if (discovered.length === 0) return;
  const stray = ids.filter((id) => !discovered.includes(id));
  if (stray.length === 0) return;
  console.error(`Not discovered for ${runner}: ${stray.join(', ')}`);
  console.error('Run "ordewell models" to see what each runner offers.');
  process.exit(1);
}

async function handleClear(args: string[], api: ApiClient): Promise<void> {
  const runner = args[0];
  if (!runner) {
    console.error('Usage: ordewell allowlist clear <runner>');
    process.exit(1);
  }
  await api.updateSettings({ modelAllowlist: { [runner]: [] } });
  console.log(`Allowlist cleared for ${runner}`);
}

async function handleShow(args: string[], api: ApiClient): Promise<void> {
  const settings = await api.getSettings();
  const allowlist = settings.modelAllowlist as Record<string, string[] | undefined> | undefined;
  const filterRunner = args[0];

  if (!allowlist || Object.keys(allowlist).length === 0) {
    console.log('No allowlists configured.');
    return;
  }

  const entries: Array<[string, string[] | undefined]> = filterRunner
    ? (allowlist[filterRunner] !== undefined ? [[filterRunner, allowlist[filterRunner]]] : [])
    : Object.entries(allowlist);

  if (entries.length === 0) {
    console.log(`No allowlist configured for ${filterRunner}.`);
    return;
  }

  for (const [runner, ids] of entries) {
    if (!ids || ids.length === 0) {
      console.log(`${runner}: no restriction`);
    } else {
      console.log(`${runner}: ${ids.join(', ')}`);
    }
  }
}
