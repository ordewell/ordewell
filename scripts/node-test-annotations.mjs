// A node:test reporter that writes each failing test as a GitHub Actions error
// annotation, so its name reaches the run's summary rather than only the log.
// CI's bench steps add it beside spec through NODE_OPTIONS; a local
// `npm run test:bench` never loads it. Vitest has the same built in.
import { relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// Failures that only echo another one: a suite whose subtest failed, and the
// siblings cancelled because of it.
const ECHOES = new Set(['subtestsFailed', 'cancelledByParent']);

const escapeData = (text) => text.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const escapeProperty = (text) => escapeData(text).replace(/:/g, '%3A').replace(/,/g, '%2C');

/** The annotation for one `test:fail` event's data, or nothing when it only echoes another failure. */
export function annotation(data, cwd = process.cwd()) {
  const error = data.details?.error;
  if (ECHOES.has(error?.failureType)) return undefined;
  const cause = error?.cause ?? error;
  const message = (cause instanceof Error ? cause.message : String(cause ?? 'failed')).slice(0, 2000);
  const properties = [];
  if (data.file) {
    const file = data.file.startsWith('file:') ? fileURLToPath(data.file) : data.file;
    properties.push(`file=${escapeProperty(relative(cwd, file).split(sep).join('/'))}`);
    if (data.line) properties.push(`line=${data.line}`);
  }
  properties.push(`title=${escapeProperty(data.name)}`);
  return `::error ${properties.join(',')}::${escapeData(message)}\n`;
}

export default async function* githubAnnotations(source) {
  for await (const event of source) {
    if (event.type !== 'test:fail') continue;
    const line = annotation(event.data);
    if (line) yield line;
  }
}
