import { createHash } from 'crypto';
import { helperArgs, parseContainerSettings, type ContainerSettings } from './containerSettings';
import { SpawnedDockerCli, type DockerCli, type DockerResult } from './dockerCli';
import { MIRROR_ROOT } from './taskWorkspace';

/** The label every container, network and task volume of a lease carries: all a session delete has left to find them by. */
export const TREE_LABEL = 'ordewell.tree';

/** What a surface's check carries. It belongs to no tree, so this is all a clean-up has to find it by. */
export const CHECK_LABEL = 'ordewell.probe=1';

/** A prune takes only what is unused, and this age keeps it off a network a live check has made and not yet joined. */
const LEFT_BY_A_CHECK = ['--filter', `label=${CHECK_LABEL}`, '--filter', 'until=1h'];

/** Where a tree's pins sit in a mirror: its own folder of refs, since a mirror serves every session of a project. */
export const treePins = (tree: string): string => createHash('sha256').update(tree).digest('hex').slice(0, 16);

/**
 * Takes one tree's pins out of every repository of a mirror. Says `mine` for
 * each repository it held pins in, `left` for each pin of another tree's, and
 * `hollow` for a volume with nothing in it at all.
 */
export const UNPIN_SCRIPT = String.raw`set -eu
[ -n "$(ls -A ${MIRROR_ROOT})" ] || echo hollow
for mirror in ${MIRROR_ROOT}/*.git; do
  [ -d "$mirror" ] || continue
  mine=$(git -C "$mirror" for-each-ref --format='delete %(refname)' "refs/ordewell/pins/$ORDEWELL_TREE")
  [ -z "$mine" ] || { echo mine; printf '%s\n' "$mine" | git -C "$mirror" update-ref --stdin; }
  git -C "$mirror" for-each-ref --format='left %(refname)' refs/ordewell/pins
done
`;

const names = (stdout: string): string[] => stdout.split('\n').map((line) => line.trim()).filter(Boolean);

/** A container's `--rm` is done a moment after its `rm -f` is answered, and until then its volumes are in use. */
const VOLUME_TRIES = 5;
const VOLUME_WAIT_MS = 200;
/** How many times over a mirror is tried, each after asking again what it holds. */
const MIRROR_ROUNDS = 3;

/** What stopped it, or null once it has gone. */
async function tryVolume(cli: DockerCli, volume: string): Promise<string | null> {
  for (let tried = 1; ; tried += 1) {
    const removed = await cli.call(['volume', 'rm', '-f', volume]);
    if (removed.code === 0) return null;
    if (tried === VOLUME_TRIES) return removed.stderr.trim();
    await new Promise((resolve) => { setTimeout(resolve, VOLUME_WAIT_MS); });
  }
}

async function removeVolume(cli: DockerCli, volume: string, tell: (text: string) => void): Promise<void> {
  const refused = await tryVolume(cli, volume);
  if (refused !== null) tell(`Could not remove the volume ${volume}: ${refused}`);
}

const leansOn = (said: readonly string[]): boolean => said.some((line) => line.startsWith('left '));

/**
 * Every clean-up mounts every mirror, so one that overlaps this holds a mirror for
 * a moment, and a mirror it missed is lost: no later clean-up takes one it held no
 * pin in. Asking again between rounds is what keeps the wait safe, since what holds
 * the mirror may instead be a new session's first push, and the removal that
 * follows that push would take its pin.
 */
async function removeEmptied(cli: DockerCli, mirror: string, read: () => Promise<DockerResult>, tell: (text: string) => void): Promise<boolean> {
  for (let round = 1; ; round += 1) {
    const refused = await tryVolume(cli, mirror);
    if (refused === null) return true;
    if (round === MIRROR_ROUNDS) {
      tell(`Could not remove the volume ${mirror}, and no later clean-up will: ${refused}`);
      return false;
    }
    const ran = await read();
    if (ran.code !== 0 || leansOn(names(ran.stdout))) return false;
  }
}

/**
 * What a tree leaves in the engine (ADR-0059 L6): whatever a host that died left
 * running, its networks, its task volumes, and its pins in each mirror, and, with
 * them, whatever a check of any surface left when its host died. Every
 * mirror is read, since a landed task's pin outlives its volume and nothing else
 * names it, and one this took its last pin from goes whole, with any cache volume
 * an earlier build left for its project, the one time nothing leans on either: a
 * mirror is never pruned under a pin. One it held none in stays, however empty,
 * as a project of another session's, unless it holds nothing at all: then it is
 * what a helper made by naming a mirror another clean-up had just taken, and one
 * try takes it, since nothing can be lost and a push that needs it makes it again.
 * A person's own sign-in is theirs, and is not touched. A clean-up that cannot
 * finish leaves what is left for the next one and says so: a stale volume is no
 * reason to fail one.
 */
export async function reclaimTree(tree: string, cli: DockerCli, settings: ContainerSettings | null, tell: (text: string) => void): Promise<void> {
  const label = `label=${TREE_LABEL}=${tree}`;
  const list = async (args: readonly string[]): Promise<string[] | null> => {
    const listed = await cli.call(args);
    return listed.code === 0 ? names(listed.stdout) : null;
  };
  const containers = await cli.call(['container', 'ls', '-aq', '--filter', label]);
  if (containers.code !== 0) {
    tell(`Could not clear what this session left in Docker: ${containers.stderr.trim() || 'it does not answer'}.`);
    return;
  }
  for (const container of names(containers.stdout)) await cli.call(['rm', '-f', container]);
  for (const network of await list(['network', 'ls', '-q', '--filter', label]) ?? []) await cli.call(['network', 'rm', network]);
  for (const kind of ['container', 'network']) await cli.call([kind, 'prune', '-f', ...LEFT_BY_A_CHECK]);
  for (const volume of await list(['volume', 'ls', '-q', '--filter', label]) ?? []) await removeVolume(cli, volume, tell);
  if (settings) await unpin(tree, cli, settings, tell, list);
}

async function unpin(tree: string, cli: DockerCli, settings: ContainerSettings, tell: (text: string) => void, list: (args: readonly string[]) => Promise<string[] | null>): Promise<void> {
  for (const mirror of await list(['volume', 'ls', '-q', '--filter', 'name=ordewell-mirror-']) ?? []) {
    const helper = helperArgs(settings, [`${mirror}:${MIRROR_ROOT}`], { ORDEWELL_TREE: treePins(tree) });
    const read = () => cli.call([...helper.args, 'sh', '-c', UNPIN_SCRIPT], { env: helper.env });
    const ran = await read();
    if (ran.code !== 0) {
      tell(`Could not take this session's pins out of ${mirror}, so it stays: ${ran.stderr.trim()}`);
      continue;
    }
    const said = names(ran.stdout);
    if (said.includes('hollow')) {
      await cli.call(['volume', 'rm', '-f', mirror]);
      continue;
    }
    if (!said.includes('mine') || leansOn(said)) continue;
    const project = mirror.slice('ordewell-mirror-'.length);
    const caches = await list(['volume', 'ls', '-q', '--filter', `name=ordewell-cache-${project}-`]) ?? [];
    if (!await removeEmptied(cli, mirror, read, tell)) continue;
    for (const volume of caches) await removeVolume(cli, volume, tell);
  }
}

/**
 * A session delete's half of it, which has no Session or backend to ask. Without
 * the setting nothing has been put in an engine, and Docker is not asked: a user
 * of local worktrees may have none (ADR-0059 L4). Under a setting it cannot use
 * it clears what it can find by label, and the pins wait for one it can.
 */
export async function reclaimContainers(tree: string, raw: unknown, { cli = new SpawnedDockerCli(), tell = (text) => console.warn(`[container] ${text}`) }: { cli?: DockerCli; tell?: (text: string) => void } = {}): Promise<void> {
  if (raw === undefined) return;
  const settings = parseContainerSettings(raw);
  await reclaimTree(tree, cli, 'refused' in settings ? null : settings, tell);
}
