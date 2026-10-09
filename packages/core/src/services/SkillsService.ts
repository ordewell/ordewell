import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { STATE_DIR } from '../utils/fsHelpers';
import { globalDataDir } from '../utils/globalDataDir';
import { builtinSkillsDir } from './builtinSkills';

export const BUILTIN_SKILL_NAMES = ['grilling', 'to-spec', 'improve-codebase-architecture'] as const;

/** Built-in skills that were renamed/removed; their stale seeds are pruned from ~/.ordewell/skills. */
export const RETIRED_BUILTIN_SKILL_NAMES = ['grill-me'] as const;

/**
 * SKILL.md hashes of superseded built-ins, for installs seeded before the
 * seed manifest existed: without a recorded hash, an unedited old seed is
 * indistinguishable from a user's edit. Seeds written from now on are tracked
 * by the manifest, so a new built-in revision never needs an entry here.
 */
const PRIOR_BUILTIN_HASHES: Readonly<Record<string, readonly string[]>> = {
  grilling: ['d5d4cb8589fbb4a0f3296bae15033f2297ef682aaf5615a3dee258451f96e5c3'],
  'improve-codebase-architecture': ['b5154b5e3baca9a5f244634453e83706d742011c31163648c2b8395a2524dd9c'],
};

const SEED_MANIFEST = '.seeded.json';

export interface SkillMetadata {
  name: string;
  description: string;
  disableModelInvocation?: boolean;
}

/** Who a skill is for: the planner's conversation, or a runner's task prompt. */
export type SkillAppliesTo = 'planner' | 'task';

/** `global` is ~/.ordewell/skills/ (built-in seeds included); `workspace` is <root>/.ordewell/skills/. */
export type SkillSource = 'global' | 'workspace';

export interface SkillInfo {
  name: string;
  description: string;
  metadata: SkillMetadata;
  /** Full content of SKILL.md with frontmatter stripped */
  content: string;
  /** Absolute path to the SKILL.md file */
  path: string;
  source: SkillSource;
  /** Frontmatter `applies-to`; absent or unrecognised reads as `planner`. */
  appliesTo: SkillAppliesTo;
  /** False when frontmatter sets `disable-model-invocation: true`. */
  modelInvocable: boolean;
  /** Frontmatter `user-invocable`; false makes the skill model-only. */
  userInvocable: boolean;
}

/** A workspace skill hidden because a global skill has the same name. */
export interface ShadowedSkill {
  skill: SkillInfo;
  shadowedBy: SkillInfo;
}

interface Frontmatter {
  name?: string;
  description?: string;
  'disable-model-invocation'?: boolean;
  'user-invocable'?: boolean;
  'applies-to'?: string;
}

function parseSkillFile(filePath: string, name: string, source: SkillSource): SkillInfo | undefined {
  const raw = fs.readFileSync(filePath, 'utf8');

  const frontmatter: Frontmatter = {};
  let content = raw;

  if (raw.startsWith('---\n')) {
    const end = raw.indexOf('\n---', 4);
    if (end !== -1) {
      const fmText = raw.slice(4, end);
      for (const line of fmText.split('\n')) {
        const idx = line.indexOf(':');
        if (idx === -1) continue;
        const key = line.slice(0, idx).trim();
        const value = line.slice(idx + 1).trim().replace(/^"|"$/g, '');
        if (key === 'disable-model-invocation') {
          frontmatter[key] = value === 'true';
        } else if (key === 'user-invocable') {
          frontmatter[key] = value !== 'false';
        } else if (key === 'name' || key === 'description' || key === 'applies-to') {
          frontmatter[key] = value;
        }
      }
      content = raw.slice(end + 4).replace(/^\n+/, '');
    }
  }

  const metadata: SkillMetadata = {
    name: frontmatter.name ?? name,
    description: frontmatter.description ?? '',
    ...(frontmatter['disable-model-invocation'] !== undefined
      ? { disableModelInvocation: frontmatter['disable-model-invocation'] }
      : {}),
  };

  return {
    name,
    description: metadata.description,
    metadata,
    content,
    path: filePath,
    source,
    appliesTo: frontmatter['applies-to'] === 'task' ? 'task' : 'planner',
    modelInvocable: frontmatter['disable-model-invocation'] !== true,
    userInvocable: frontmatter['user-invocable'] !== false,
  };
}

function copyDirSync(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDirSync(srcPath, destPath);
    else fs.copyFileSync(srcPath, destPath);
  }
}

function fileHash(file: string): string | undefined {
  try {
    return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  } catch {
    return undefined;
  }
}

function readDir(dir: string, source: SkillSource): SkillInfo[] {
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const skills: SkillInfo[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillFile = path.join(dir, entry.name, 'SKILL.md');
    if (!fs.existsSync(skillFile)) continue;
    const parsed = parseSkillFile(skillFile, entry.name, source);
    if (parsed) skills.push(parsed);
  }
  return skills;
}

export class SkillsService {
  constructor(private workspaceRoot?: string) {}

  /**
   * The same global skills, with the workspace ones read from `root` instead —
   * a task's worktree, whose `.ordewell/skills/` is its own committed copy.
   */
  forRoot(root: string): SkillsService {
    return new SkillsService(root);
  }

  private workspaceDir(): string | undefined {
    return this.workspaceRoot ? path.join(this.workspaceRoot, STATE_DIR, 'skills') : undefined;
  }

  private globalDir(): string {
    return path.join(globalDataDir(), 'skills');
  }

  private readSeedManifest(): Record<string, string> {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(path.join(this.globalDir(), SEED_MANIFEST), 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return Object.fromEntries(
          Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
        );
      }
    } catch {
      // Missing or corrupt: treated as "nothing recorded", which only makes refreshes more conservative.
    }
    return {};
  }

  private recordSeed(name: string, hash: string): void {
    const manifest = this.readSeedManifest();
    if (manifest[name] === hash) return;
    manifest[name] = hash;
    try {
      fs.mkdirSync(this.globalDir(), { recursive: true });
      fs.writeFileSync(path.join(this.globalDir(), SEED_MANIFEST), JSON.stringify(manifest, null, 2));
    } catch (err) {
      console.warn(`Could not record seeded skill ${name}: ${String(err)}`);
    }
  }

  /** A seed the user never edited: safe to replace with a newer built-in. */
  private isUntouchedSeed(name: string, currentHash: string | undefined): boolean {
    if (currentHash === undefined) return false;
    return this.readSeedManifest()[name] === currentHash || (PRIOR_BUILTIN_HASHES[name] ?? []).includes(currentHash);
  }

  private seed(name: string): boolean {
    const dest = path.join(this.globalDir(), name);
    const exists = fs.existsSync(dest);
    let srcDir: string;
    try {
      srcDir = path.join(builtinSkillsDir(), name);
    } catch (err) {
      if (!exists) console.warn(`Could not locate built-in skills dir: ${String(err)}`);
      return false;
    }
    if (!fs.existsSync(srcDir)) {
      if (!exists) console.warn(`Built-in skill not found in package: ${name}`);
      return false;
    }
    const srcHash = fileHash(path.join(srcDir, 'SKILL.md'));
    if (exists) {
      const currentHash = fileHash(path.join(dest, 'SKILL.md'));
      if (currentHash !== undefined && currentHash === srcHash) {
        this.recordSeed(name, currentHash);
        return false;
      }
      if (!this.isUntouchedSeed(name, currentHash)) return false;
    }
    copyDirSync(srcDir, dest);
    if (srcHash) this.recordSeed(name, srcHash);
    return true;
  }

  seedBuiltinSkill(name: string): boolean {
    return this.seed(name);
  }

  /** Removes a retired built-in's seed from the global dir, but only if it's untouched by the user. */
  private isUnmodifiedRetiredSeed(dir: string, expectedName: string): boolean {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    if (entries.length !== 1 || entries[0].name !== 'SKILL.md' || !entries[0].isFile()) return false;

    let raw: string;
    try {
      raw = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
    } catch {
      return false;
    }
    if (!raw.startsWith('---\n')) return false;
    const end = raw.indexOf('\n---', 4);
    if (end === -1) return false;
    for (const line of raw.slice(4, end).split('\n')) {
      const idx = line.indexOf(':');
      if (idx === -1) continue;
      const key = line.slice(0, idx).trim();
      if (key === 'name') return line.slice(idx + 1).trim().replace(/^"|"$/g, '') === expectedName;
    }
    return false;
  }

  private pruneRetired(): void {
    for (const name of RETIRED_BUILTIN_SKILL_NAMES) {
      const dest = path.join(this.globalDir(), name);
      if (!fs.existsSync(dest)) continue;
      if (!this.isUnmodifiedRetiredSeed(dest, name)) continue;
      try {
        fs.rmSync(dest, { recursive: true, force: true });
      } catch (err) {
        console.warn(`Could not prune retired skill ${name}: ${String(err)}`);
      }
    }
  }

  findSkill(name: string): SkillInfo | undefined {
    this.pruneRetired();
    if ((BUILTIN_SKILL_NAMES as readonly string[]).includes(name)) this.seed(name);
    const globalFile = path.join(this.globalDir(), name, 'SKILL.md');
    if (fs.existsSync(globalFile)) return parseSkillFile(globalFile, name, 'global');
    const workspaceDir = this.workspaceDir();
    if (workspaceDir) {
      const workspaceFile = path.join(workspaceDir, name, 'SKILL.md');
      if (fs.existsSync(workspaceFile)) return parseSkillFile(workspaceFile, name, 'workspace');
    }
    return undefined;
  }

  listSkills(): SkillInfo[] {
    return this.catalog().skills;
  }

  /** Workspace skills skipped by `listSkills` and `findSkill` because a global one has the same name. */
  listShadowed(): ShadowedSkill[] {
    return this.catalog().shadowed;
  }

  /**
   * Global wins a name clash: a repository's committed skill must not be able
   * to silently replace one the user installed, built-ins included.
   */
  private catalog(): { skills: SkillInfo[]; shadowed: ShadowedSkill[] } {
    this.pruneRetired();
    for (const name of BUILTIN_SKILL_NAMES) this.seed(name);
    const byName = new Map<string, SkillInfo>();
    for (const skill of readDir(this.globalDir(), 'global')) {
      byName.set(skill.name, skill);
    }
    const shadowed: ShadowedSkill[] = [];
    const workspaceDir = this.workspaceDir();
    if (workspaceDir) {
      for (const skill of readDir(workspaceDir, 'workspace')) {
        const global = byName.get(skill.name);
        if (global) shadowed.push({ skill, shadowedBy: global });
        else byName.set(skill.name, skill);
      }
    }
    return { skills: [...byName.values()], shadowed };
  }

  getSkillContent(name: string): string | undefined {
    return this.findSkill(name)?.content;
  }
}

export function createSkillsService(workspaceRoot?: string): SkillsService {
  return new SkillsService(workspaceRoot);
}
