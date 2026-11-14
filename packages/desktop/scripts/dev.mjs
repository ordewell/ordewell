// `npm run desktop:dev`: core, ui and web rebuilt (workspace-builds.mjs), the
// renderer from Vite with hot reload, main and the preload built once by tsup,
// and Electron pointed at the dev server. The dev URL is read only by an
// unpackaged app (src/main/index.ts).
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { buildWorkspaces } from './workspace-builds.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);

const failed = buildWorkspaces();
if (failed) {
  console.error(failed);
  process.exit(1);
}

const tsup = spawn(process.execPath, [require.resolve('tsup/dist/cli-default.js')], { cwd: root, stdio: 'inherit' });
const built = await new Promise((resolve) => tsup.on('exit', (code) => resolve(code === 0)));
if (!built) process.exit(1);

const server = await createServer({ configFile: fileURLToPath(new URL('../vite.config.mts', import.meta.url)) });
await server.listen();
const url = server.resolvedUrls?.local[0];
if (!url) {
  console.error('Vite did not report a local URL.');
  await server.close();
  process.exit(1);
}

// `electron` resolves to the path of its binary when required from Node.
const electronBinary = require('electron');
const env = { ...process.env, ORDEWELL_DESKTOP_DEV_URL: new URL('index.html', url).href };
delete env.ELECTRON_RUN_AS_NODE;
// Arguments after `--` go to Electron, e.g. `--remote-debugging-port=9333`.
const electron = spawn(electronBinary, [root, ...process.argv.slice(2)], { cwd: root, stdio: 'inherit', env });

const stop = async (code) => {
  await server.close();
  process.exit(code ?? 0);
};
electron.on('exit', (code) => { void stop(code); });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { electron.kill(signal); });
