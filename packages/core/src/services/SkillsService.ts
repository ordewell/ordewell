import * as fs from 'fs';
import * as path from 'path';
import { globalDataDir } from '../utils/globalDataDir';
import { builtinSkillsDir } from './builtinSkills';

export const BUILTIN_SKILL_NAMES = ['grilling', 'to-spec', 'improve-codebase-architecture'] as const;

/** Built-in skills that were renamed/removed; their stale seeds are pruned from ~/.ordewell/skills. */
export const RETIRED_BUILTIN_SKILL_NAMES = ['grill-me'] as const;

export interface SkillMetadata {
  name: string;
  description: string;
  disableModelInvocation?: boolean;
}

export interface SkillInfo {
  name: string;
  description: string;
  metadata: SkillMetadata;
  /** Full content of SKILL.md with frontmatter stripped */
  content: string;
  /** Absolute path to the SKILL.md file */
  path: string;
  /** Whether this came from global (~/.ordewell/skills/) or local (.ordewell/skills/) */
  source: 'global' | 'local';
}

interface Frontmatter {
  name?: string;
  description?: string;
  'disable-model-invocation'?: boolean;
}

function parseSkillFile(filePath: string, name: string, source: 'global' | 'local'): SkillInfo | undefined {
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
        const value = line.slice(idx + 1).trim();
        if (key === 'disable-model-invocation') {
          frontmatter[key] = value === 'true';
        } else if (key === 'name' || key === 'description') {
          frontmatter[key] = value.replace(/^"|"$/g, '');
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

  return { name, description: metadata.description, metadata, content, path: filePath, source };
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

function readDir(dir: string, source: 'global' | 'local'): SkillInfo[] {
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

  private localDir(): string | undefined {
    return this.workspaceRoot ? path.join(this.workspaceRoot, '.ordewell', 'skills') : undefined;
  }

  private globalDir(): string {
    return path.join(globalDataDir(), 'skills');
  }

  private seed(name: string): boolean {
    const dest = path.join(this.globalDir(), name);
    if (fs.existsSync(dest)) return false;
    let srcDir: string;
    try {
      srcDir = path.join(builtinSkillsDir(), name);
    } catch (err) {
      console.warn(`Could not locate built-in skills dir: ${String(err)}`);
      return false;
    }
    if (!fs.existsSync(srcDir)) {
      console.warn(`Built-in skill not found in package: ${name}`);
      return false;
    }
    copyDirSync(srcDir, dest);
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
    const localDir = this.localDir();
    if (localDir) {
      const localFile = path.join(localDir, name, 'SKILL.md');
      if (fs.existsSync(localFile)) return parseSkillFile(localFile, name, 'local');
    }
    const globalFile = path.join(this.globalDir(), name, 'SKILL.md');
    if (fs.existsSync(globalFile)) return parseSkillFile(globalFile, name, 'global');
    return undefined;
  }

  listSkills(): SkillInfo[] {
    this.pruneRetired();
    for (const name of BUILTIN_SKILL_NAMES) this.seed(name);
    const byName = new Map<string, SkillInfo>();
    for (const skill of readDir(this.globalDir(), 'global')) {
      byName.set(skill.name, skill);
    }
    const localDir = this.localDir();
    if (localDir) {
      for (const skill of readDir(localDir, 'local')) {
        byName.set(skill.name, skill);
      }
    }
    return [...byName.values()];
  }

  getSkillContent(name: string): string | undefined {
    return this.findSkill(name)?.content;
  }
}

export function createSkillsService(workspaceRoot?: string): SkillsService {
  return new SkillsService(workspaceRoot);
}
