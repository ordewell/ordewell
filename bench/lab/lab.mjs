#!/usr/bin/env node
/**
 * Runner-detection lab: a throwaway HOME and a shim bin dir that decide, for
 * one run, which coding-agent CLIs the host appears to have installed.
 *
 * The install probe resolves `<command> --version` through an augmented PATH
 * that starts with the process's own PATH, so a shim placed first decides the
 * verdict: a script that prints a version reads as installed, one that exits
 * non-zero reads as absent even when a real binary sits later in PATH. That is
 * what lets a machine with Claude Code installed still test the "nothing here"
 * first run.
 *
 * Zero dependencies, pure Node. `lab.mjs --scenario <name>` builds a lab and
 * prints the environment to drive the TUI or the VS Code extension;
 * `--root <dir>` builds it at a fixed path instead of a fresh temp dir, for a
 * standing configuration such as the launch configuration in
 * ../../.vscode/launch.json. `lab.test.mjs` runs the real probe against one.
 * See ../README.md.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** The built-in runners, in manifest/picker order. */
export const RUNNERS = ['claude-code', 'codex', 'opencode'];

const COMMANDS = { 'claude-code': 'claude', codex: 'codex', opencode: 'opencode' };

/** The command the install probe runs `<command> --version` against. */
export function commandFor(runner) {
  return COMMANDS[runner];
}

/** Scenario name -> the runners that read as installed. */
export const SCENARIOS = {
  none: [],
  'claude-only': ['claude-code'],
  'codex-only': ['codex'],
  'opencode-only': ['opencode'],
  'claude+opencode': ['claude-code', 'opencode'],
  all: [...RUNNERS],
};

/** A scratch HOME, shim bin dir and workspace. `root` defaults to a fresh temp dir. */
export function makeLab({ root, prefix = 'ordewell-lab-' } = {}) {
  const dir = root ?? fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const lab = {
    root: dir,
    home: path.join(dir, 'home'),
    bin: path.join(dir, 'bin'),
    ws: path.join(dir, 'ws'),
  };
  for (const at of [lab.home, lab.bin, lab.ws]) fs.mkdirSync(at, { recursive: true });
  return lab;
}

const WINDOWS = process.platform === 'win32';

/**
 * What a lab sets for one run. The probe's augmented PATH ends in well-known
 * per-user bin dirs, found from the home on POSIX and, on Windows, from the
 * profile and the folders installers write to (npm's prefix under APPDATA,
 * WinGet's links under LOCALAPPDATA, Chocolatey's under ProgramData). Each is
 * pointed into the lab, so a real CLI there is not found and "none" means none.
 */
export function labEnv(lab) {
  if (!WINDOWS) return { HOME: lab.home };
  return {
    HOME: lab.home,
    USERPROFILE: lab.home,
    APPDATA: path.join(lab.home, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(lab.home, 'AppData', 'Local'),
    ProgramData: path.join(lab.home, 'ProgramData'),
    SCOOP: undefined,
    SCOOP_GLOBAL: undefined,
  };
}

/** A shell script on POSIX; on Windows a batch file, which is what an npm install leaves. */
function shimFile(lab, runner) {
  return path.join(lab.bin, WINDOWS ? `${commandFor(runner)}.cmd` : commandFor(runner));
}

/** Write one shim: a version prints it (installed), no version exits 1 (absent). */
export function writeShim(lab, runner, { version } = {}) {
  const file = shimFile(lab, runner);
  if (WINDOWS) {
    fs.writeFileSync(file, version ? `@echo ${version}\r\n` : '@exit /b 1\r\n');
    return;
  }
  fs.writeFileSync(file, version ? `#!/bin/sh\necho "${version}"\n` : '#!/bin/sh\nexit 1\n');
  fs.chmodSync(file, 0o755);
}

/** Make exactly `installed` read as present and every other runner as absent. */
export function installOnly(lab, installed) {
  for (const runner of RUNNERS) {
    writeShim(lab, runner, { version: installed.includes(runner) ? '0.0.0-lab' : undefined });
  }
}

/** Remove a shim, so a real CLI further down PATH (or nothing) is found. */
export function removeShim(lab, runner) {
  fs.rmSync(shimFile(lab, runner), { force: true });
}

/** A throwaway git repo the TUI/extension can open as a workspace. */
export function makeWorkspace(lab) {
  run('git', ['init', '-q', lab.ws]);
  fs.writeFileSync(path.join(lab.ws, 'README.md'), '# lab\n');
  const who = ['-c', 'user.email=lab@local', '-c', 'user.name=lab'];
  run('git', ['-C', lab.ws, ...who, 'add', '.']);
  run('git', ['-C', lab.ws, ...who, 'commit', '-qm', 'init']);
  return lab.ws;
}

function run(cmd, args) {
  // A missing git is not fatal: the workspace still exists, and detection does
  // not read it. Only version-control-dependent checks (isolation) would miss.
  try {
    execFileSync(cmd, args, { stdio: 'ignore' });
  } catch { /* optional */ }
}

export function cleanLab(lab) {
  fs.rmSync(lab.root, { recursive: true, force: true });
}

function flag(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function main() {
  const scenario = flag('--scenario') ?? 'none';
  const installed = SCENARIOS[scenario];
  if (!installed) {
    console.error(`Unknown scenario: ${scenario}. Known: ${Object.keys(SCENARIOS).join(', ')}`);
    process.exit(2);
  }

  const root = flag('--root');
  if (root) {
    // A fixed root is for pointing a standing configuration at (the launch
    // configuration in ../../.vscode/launch.json), so it is rebuilt from
    // scratch: a previous run's HOME state or workspace would otherwise
    // survive and quietly turn the "first run" into a later one.
    if (root === '/' || root === os.homedir()) {
      console.error(`Refusing to wipe ${root}.`);
      process.exit(2);
    }
    fs.rmSync(root, { recursive: true, force: true });
  }

  const lab = makeLab({ root });
  installOnly(lab, installed);
  makeWorkspace(lab);

  console.log(`# lab: ${lab.root}`);
  console.log(`# installed: ${installed.join(', ') || '(none)'}\n`);
  if (WINDOWS) {
    // PowerShell has no `env -i`: these change this window's environment, so
    // run them in a window of their own.
    console.log('# PowerShell, in a window of its own');
    for (const [key, value] of Object.entries(labEnv(lab))) {
      console.log(value === undefined ? `Remove-Item Env:${key} -ErrorAction SilentlyContinue` : `$env:${key} = '${value}'`);
    }
    console.log(`$env:Path = '${lab.bin};' + $env:Path\n`);
    console.log('# TUI');
    console.log(`node packages/cli/dist/main.js tui --workspace '${lab.ws}'\n`);
    console.log('# VS Code  (then press F5 in the dev host)');
    console.log(`code --user-data-dir='${path.join(lab.root, 'vscode')}' --extensions-dir='${path.join(lab.root, 'ext')}' '${lab.ws}'`);
    return;
  }

  // The shim dir is first, so it wins; the caller's PATH follows only so that
  // `node` and `code` themselves resolve. `env -i` keeps every API key out.
  const prefix = `env -i HOME=${lab.home} PATH=${lab.bin}:$PATH SHELL=/usr/bin/true TERM=$TERM LANG=$LANG`;
  console.log('# TUI');
  console.log(`${prefix} \\`);
  console.log(`  node packages/cli/dist/main.js tui --workspace ${lab.ws}\n`);
  console.log('# VS Code  (then press F5 in the dev host)');
  console.log(`env -i HOME=${lab.home} PATH=${lab.bin}:$PATH SHELL=/usr/bin/true \\`);
  console.log(`  code --user-data-dir=${lab.root}/vscode --extensions-dir=${lab.root}/ext ${lab.ws}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
