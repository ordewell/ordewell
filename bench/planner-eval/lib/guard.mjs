/**
 * The user's own Ordewell settings stay theirs. Each run points the planner
 * at a settings file of its own through ORDEWELL_SETTINGS_PATH, but the token
 * and `.env` live in `~/.ordewell/` with no override, so the files a run could
 * still touch are copied first and put back on any exit: a normal one, an
 * interrupt, a termination or a crash.
 */
import fs from 'node:fs';

function read(file) {
  try {
    return fs.readFileSync(file);
  } catch {
    return null;
  }
}

/** Snapshot `files` now; the returned `restore` puts back each one that changed, and removes one that did not exist. */
export function snapshot(files) {
  const saved = files.map((file) => ({ file, bytes: read(file) }));
  return {
    saved,
    restore() {
      const restored = [];
      for (const { file, bytes } of saved) {
        const now = read(file);
        if (bytes === null && now !== null) {
          fs.rmSync(file, { force: true });
          restored.push(file);
        } else if (bytes !== null && (now === null || !now.equals(bytes))) {
          fs.writeFileSync(file, bytes);
          restored.push(file);
        }
      }
      return restored;
    },
  };
}

/**
 * Snapshot `files` and restore them however the process ends. `onRestore` is
 * told which files it had to put back, which means a run changed them.
 */
export function guardFiles(files, { onRestore = () => {}, proc = process } = {}) {
  const snap = snapshot(files);
  let done = false;
  const restore = () => {
    if (done) return [];
    done = true;
    const restored = snap.restore();
    if (restored.length) onRestore(restored);
    return restored;
  };
  const onSignal = (signal) => {
    restore();
    proc.exit(signal === 'SIGINT' ? 130 : 143);
  };
  const onCrash = (error) => {
    restore();
    proc.stderr?.write?.(`${error?.stack ?? error}\n`);
    proc.exit(1);
  };
  proc.on('exit', restore);
  proc.on('SIGINT', onSignal);
  proc.on('SIGTERM', onSignal);
  proc.on('uncaughtException', onCrash);
  proc.on('unhandledRejection', onCrash);
  return {
    restore,
    release() {
      restore();
      proc.off('exit', restore);
      proc.off('SIGINT', onSignal);
      proc.off('SIGTERM', onSignal);
      proc.off('uncaughtException', onCrash);
      proc.off('unhandledRejection', onCrash);
    },
  };
}
