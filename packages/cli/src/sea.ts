/**
 * The entry of the standalone `ordewell` binary, a Node single executable
 * application built by `scripts/sea/build.mjs` (ADR-0065). It is not a tsup
 * entry, so the npm package never contains it.
 *
 * A SEA runs its one script with `process.argv` as `[binary, binary, ...args]`,
 * the same shape as `node main.js ...args`, so `main.ts` reads its arguments
 * unchanged. The binary has no Node and no server file beside it to spawn a
 * daemon with, so it is its own daemon: `startDaemon` runs it as
 * `<binary> __daemon --port N --pid-file F [--watch-parent PID]`, the arguments
 * `packages/web/server/main.ts` takes.
 *
 * Each side is imported only when chosen: both run on import, and a daemon must
 * not evaluate the CLI's modules, nor a CLI command the server's.
 */
if (process.argv[2] === '__daemon') {
  void import('../../web/server/daemon').then(({ runDaemon }) => runDaemon(process.argv.slice(3)));
} else {
  void import('./main');
}
