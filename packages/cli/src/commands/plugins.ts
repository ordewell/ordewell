import { RunnerRegistry } from '@ordewell/core';

export function handlePlugins(subArgs: string[]): void {
  const registry = new RunnerRegistry();
  registry.loadUserPlugins();

  const sub = subArgs[0];

  if (sub === 'list' || !sub) {
    const plugins = registry.list();
    if (plugins.length === 0) {
      console.log('No plugins installed.');
      return;
    }
    const nameWidth = Math.max(...plugins.map((p: { manifest: { name: string, version: string }, source: string }) => p.manifest.name.length), 4);
    const versionWidth = Math.max(...plugins.map((p: { manifest: { name: string, version: string }, source: string }) => p.manifest.version.length), 7);
    const sourceWidth = Math.max(...plugins.map((p: { manifest: { name: string, version: string }, source: string }) => p.source.length), 6);

    console.log(`\n${plugins.length} plugin(s):\n`);
    console.log(
      `${'Name'.padEnd(nameWidth)}  ${'Version'.padEnd(versionWidth)}  ${'Source'.padEnd(sourceWidth)}  Description`,
    );
    console.log(
      `${'-'.repeat(nameWidth)}  ${'-'.repeat(versionWidth)}  ${'-'.repeat(sourceWidth)}  ${'-'.repeat(20)}`,
    );
    for (const p of plugins) {
      const status = p.source === 'builtin' ? '(built-in)' : 'user';
      console.log(
        `${p.manifest.name.padEnd(nameWidth)}  ${p.manifest.version.padEnd(versionWidth)}  ${status.padEnd(sourceWidth)}  ${p.manifest.description}`,
      );
    }
    return;
  }

  if (sub === 'install') {
    const source = subArgs[1];
    if (!source) {
      console.error('Usage: ordewell plugins install <path|github:user/repo|name>');
      process.exit(1);
    }
    try {
      let manifest;
      if (
        source.startsWith('github:') ||
        source.startsWith('https://github.com/')
      ) {
        const url = source.startsWith('github:')
          ? `https://github.com/${source.slice(7)}.git`
          : source;
        manifest = registry.installFromGit(url);
      } else {
        manifest = registry.installFromPath(source);
      }
      console.log(`Installed plugin: ${manifest.name} v${manifest.version}`);
    } catch (err) {
      console.error(`Install failed: ${(err as Error).message}`);
      process.exit(1);
    }
    return;
  }

  if (sub === 'remove') {
    const name = subArgs[1];
    if (!name) {
      console.error('Usage: ordewell plugins remove <name>');
      process.exit(1);
    }
    try {
      registry.remove(name);
      console.log(`Removed plugin: ${name}`);
    } catch (err) {
      console.error(`Remove failed: ${(err as Error).message}`);
      process.exit(1);
    }
    return;
  }

  if (sub === 'create') {
    const name = subArgs[1];
    if (!name) {
      console.error('Usage: ordewell plugins create <name>');
      process.exit(1);
    }
    const dir = registry.createSkeleton(name, process.cwd());
    console.log(`Created plugin skeleton: ${dir}`);
    console.log(`  Edit ${dir}/manifest.json to configure your runner`);
    console.log(`  Then install with: ordewell plugins install ${dir}`);
    return;
  }

  console.error(`Unknown plugins subcommand: ${sub}`);
  console.error('Available: list, install <source>, remove <name>, create <name>');
  process.exit(1);
}
