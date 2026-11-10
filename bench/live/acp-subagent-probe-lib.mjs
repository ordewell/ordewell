import fs from 'node:fs';
import path from 'node:path';

/**
 * A planner that has no file-read tool of its own (Cline's) reads only through
 * Ordewell's run_command, which the probe stubs. A plain read of the marker
 * file is answered with the file's content, so the control can pass; any other
 * command keeps the stub, so the delegation attempts judge what they did.
 * Shell syntax (a pipe, a redirect, a substitution) is never answered: the
 * answer must not become a way to run anything.
 */
const READERS = /^\s*(?:cat|head|tail|less|more|nl|bat|type)\b(?:\s+-{1,2}[\w=-]+(?:\s+\d+)?)*\s+(?:"([^"]+)"|'([^']+)'|([^\s"';&|<>`$()]+))\s*$/;

export function markerRead(command, workspace, marker) {
  const m = READERS.exec(String(command ?? ''));
  if (!m) return null;
  const asked = m[1] ?? m[2] ?? m[3];
  const want = fs.realpathSync.native(marker);
  try {
    return fs.realpathSync.native(path.resolve(workspace, asked)) === want ? fs.readFileSync(marker, 'utf8') : null;
  } catch {
    return null;
  }
}

/** The text the stub answers a run_command with: the marker's content for a plain read of it, else the stub's line. */
export function runCommandStub(args, workspace, marker) {
  return markerRead(args?.command, workspace, marker) ?? 'The probe records this call and does nothing else.';
}

function newest(dir, extensions, best = { mtimeMs: 0, file: null }) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') newest(p, extensions, best);
    } else if (extensions.some((e) => entry.name.endsWith(e))) {
      const { mtimeMs } = fs.statSync(p);
      if (mtimeMs > best.mtimeMs) { best.mtimeMs = mtimeMs; best.file = p; }
    }
  }
  return best;
}

/**
 * Why a built core cannot be trusted, or null: the probe drives the shipped
 * adapter and profiles from dist/, so a dist older than their sources judges
 * code that is no longer there.
 */
export function staleCore(dist, srcDir) {
  if (!fs.existsSync(dist)) return `${dist} is missing`;
  const built = fs.statSync(dist).mtimeMs;
  const src = newest(srcDir, ['.ts', '.tsx', '.json']);
  if (src.file && src.mtimeMs > built) return `${path.relative(path.dirname(srcDir), src.file)} is newer than the build (${dist})`;
  return null;
}
