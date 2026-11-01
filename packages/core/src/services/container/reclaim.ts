import { createHash } from 'crypto';
import { helperArgs, parseContainerSettings, type ContainerSettings } from './containerSettings';
import { SpawnedDockerCli, type DockerCli } from './dockerCli';
import { MIRROR_ROOT } from './taskWorkspace';

/** The label every container, network and task volume of a lease carries: all a session delete has left to find them by. */
export const TREE_LABEL = 'ordewell.tree';

/** Where a tree's pins sit in a mirror: its own folder of refs, since a mirror serves every session of a project. */
export const treePins = (tree: string): string => createHash('sha256').update(tree).digest('hex').slice(0, 16);

/**
 * Takes one tree's pins out of every repository of a mirror. Says `mine` for
 * each repository it held pins in, and `left` for each pin of another tree's.
 */
export const UNPIN_SCRIPT = String.raw`set -eu
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

async function removeVolume(cli: DockerCli, volume: string, tell: (text: string) => void): Promise<void> {
  for (let tried = 1; ; tried += 1) {
    const removed = await cli.call(['volume', 'rm', '-f', volume]);
    if (removed.code === 0) return;
    if (tried === VOLUME_TRIES) {
      tell(`Could not remove the volume ${volume}: ${removed.stderr.trim()}`);
      return;
    }
    await new Promise((resolve) => { setTimeout(resolve, VOLUME_WAIT_MS); });
  }
}

/**
 * What a tree leaves in the engine (ADR-0059 L6): whatever a host that died left
 * running, its networks, its task volumes, and its pins in each mirror. Every
 * mirror is read, since a landed task's pin outlives its volume and nothing else
 * names it, and one this took its last pin from goes whole with its project's
 * caches, the one time nothing leans on either: a mirror is never pruned under a
 * pin. One it held none in stays, however empty, as a project of another
 * session's. A person's own sign-in is theirs, and is not touched. A clean-up that
 * cannot finish leaves what is left for the next one and says so: a stale volume
 * is no reason to fail one.
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
  for (const volume of await list(['volume', 'ls', '-q', '--filter', label]) ?? []) await removeVolume(cli, volume, tell);
  if (settings) await unpin(tree, cli, settings, tell, list);
}

async function unpin(tree: string, cli: DockerCli, settings: ContainerSettings, tell: (text: string) => void, list: (args: readonly string[]) => Promise<string[] | null>): Promise<void> {
  for (const mirror of await list(['volume', 'ls', '-q', '--filter', 'name=ordewell-mirror-']) ?? []) {
    const ran = await cli.call([...helperArgs(settings, [`${mirror}:${MIRROR_ROOT}`], { ORDEWELL_TREE: treePins(tree) }), 'sh', '-c', UNPIN_SCRIPT]);
    if (ran.code !== 0) {
      tell(`Could not take this session's pins out of ${mirror}, so it stays: ${ran.stderr.trim()}`);
      continue;
    }
    const said = names(ran.stdout);
    if (!said.includes('mine') || said.some((line) => line.startsWith('left '))) continue;
    const project = mirror.slice('ordewell-mirror-'.length);
    const caches = await list(['volume', 'ls', '-q', '--filter', `name=ordewell-cache-${project}-`]) ?? [];
    for (const volume of [mirror, ...caches]) await removeVolume(cli, volume, tell);
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
