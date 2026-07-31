import * as fs from 'fs';
import * as path from 'path';

const PRD_BLOCK_RE = /<!--\s*ORDEWELL_PRD_START\s+slug="([^"]+)"\s*-->\s*([\s\S]*?)\s*<!--\s*ORDEWELL_PRD_END\s*-->/;

export interface PrdBlock {
  slug: string;
  markdown: string;
}

/**
 * Detect a full markdown PRD in a planner message. The markers are the only
 * structured artifact left in the conversation loop — they exist so the PRD
 * can be saved to disk, not to drive any state machine.
 */
export function extractPrdBlock(text: string): PrdBlock | null {
  const match = PRD_BLOCK_RE.exec(text);
  if (!match) return null;
  const slug = sanitizeSlug(match[1]);
  const markdown = match[2].trim();
  if (!slug || !markdown) return null;
  return { slug, markdown };
}

/** Kebab-case, path-safe feature slug. */
export function sanitizeSlug(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

/** Save the PRD to `<workspace>/.scratch/<slug>/PRD.md` (to-prd native convention). */
export function savePrdMarkdown(workspace: string, slug: string, markdown: string): string {
  const dir = path.join(workspace, '.scratch', sanitizeSlug(slug));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'PRD.md');
  fs.writeFileSync(file, markdown.endsWith('\n') ? markdown : markdown + '\n', 'utf8');
  return file;
}
