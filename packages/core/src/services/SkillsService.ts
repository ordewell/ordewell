import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { STATE_DIR } from '../utils/fsHelpers';
import { SELF_REPO } from './isolationRecord';
import { globalDataDir } from '../utils/globalDataDir';
import { builtinSkillsDir } from './builtinSkills';
import { isSkillName } from '../models/Task';
import { workspaceRepoGroup } from './repoGroup';

export const BUILTIN_SKILL_NAMES = ['grilling', 'to-spec', 'improve-codebase-architecture', 'tdd'] as const;

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

/** `global` is ~/.ordewell/skills/ (built-in seeds included); `workspace` is a `.ordewell/skills/` of the workspace's (see {@link workspaceSkillRoots}). */
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

/** A workspace skill hidden because a global skill, or a workspace one read before it, has the same name. */
export interface ShadowedSkill {
  skill: SkillInfo;
  shadowedBy: SkillInfo;
}

/** A skill folder no name can reach — `/name`, a plan and a spawn all use the folder name — so it is listed nowhere. */
export interface InvalidSkill {
  name: string;
  /** Absolute path to the folder's SKILL.md. */
  path: string;
  source: SkillSource;
  reason: string;
}

export const INVALID_SKILL_NAME_REASON = 'not a valid skill name: lowercase letters, digits, "-" and "_", starting with a letter or digit';

/** A skills folder's catalog: what wins, what a winner hides, and the folders skipped for their name. */
export interface SkillCatalog {
  skills: SkillInfo[];
  shadowed: ShadowedSkill[];
  invalid: InvalidSkill[];
}

interface Frontmatter {
  name?: string;
  description?: string;
  'disable-model-invocation'?: boolean;
  'user-invocable'?: boolean;
  'applies-to'?: string;
}

/**
 * A SKILL.md's text with what an editor or a checkout may add stripped: a
 * UTF-8 BOM, and the CRLF line ends git's autocrlf gives a committed skill on
 * Windows — either one would hide the frontmatter.
 */
function readSkillText(filePath: string): string {
  return fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
}

/**
 * A frontmatter scalar as YAML reads the common cases: a quoted value is
 * what is inside its quotes, `''` and `\"` unescaped, and an unquoted one
 * ends before ` # comment`.
 */
function scalar(raw: string): string {
  const value = raw.trim();
  const single = /^'((?:[^']|'')*)'/.exec(value);
  if (single) return single[1].replace(/''/g, "'");
  const double = /^"((?:[^"\\]|\\.)*)"/.exec(value);
  if (double) return double[1].replace(/\\(["\\])/g, '$1');
  return value.replace(/\s+#.*$/, '');
}

/** YAML 1.1's spellings of a boolean, any case; undefined for anything else. */
function boolean(value: string): boolean | undefined {
  const lower = value.toLowerCase();
  if (lower === 'true' || lower === 'yes' || lower === 'on') return true;
  if (lower === 'false' || lower === 'no' || lower === 'off') return false;
  return undefined;
}

/** The frontmatter's `key: value` lines and the body after it; null when the file has none. */
function splitFrontmatter(raw: string): { fields: Map<string, string>; body: string } | null {
  if (!raw.startsWith('---\n')) return null;
  const end = raw.indexOf('\n---', 4);
  if (end === -1) return null;
  const fields = new Map<string, string>();
  for (const line of raw.slice(4, end).split('\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    fields.set(line.slice(0, idx).trim(), scalar(line.slice(idx + 1)));
  }
  return { fields, body: raw.slice(end + 4).replace(/^\n+/, '') };
}

function parseSkillFile(filePath: string, name: string, source: SkillSource): SkillInfo | undefined {
  const raw = readSkillText(filePath);
  const split = splitFrontmatter(raw);
  const frontmatter: Frontmatter = {};
  if (split) {
    const { fields } = split;
    for (const key of ['name', 'description', 'applies-to'] as const) {
      const value = fields.get(key);
      if (value !== undefined) frontmatter[key] = value;
    }
    for (const key of ['disable-model-invocation', 'user-invocable'] as const) {
      const value = fields.get(key);
      const flag = value === undefined ? undefined : boolean(value);
      if (flag !== undefined) frontmatter[key] = flag;
    }
  }
  const content = split ? split.body : raw;

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
    appliesTo: frontmatter['applies-to']?.toLowerCase() === 'task' ? 'task' : 'planner',
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

function readDir(dir: string, source: SkillSource): { skills: SkillInfo[]; invalid: InvalidSkill[] } {
  const skills: SkillInfo[] = [];
  const invalid: InvalidSkill[] = [];
  if (!fs.existsSync(dir)) return { skills, invalid };
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const skillFile = path.join(dir, entry.name, 'SKILL.md');
    if (!fs.existsSync(skillFile)) continue;
    if (!isSkillName(entry.name)) {
      invalid.push({ name: entry.name, path: skillFile, source, reason: INVALID_SKILL_NAME_REASON });
      continue;
    }
    const parsed = parseSkillFile(skillFile, entry.name, source);
    if (parsed) skills.push(parsed);
  }
  return { skills, invalid };
}

/**
 * `name`'s SKILL.md in `dir`, matched against the folder names as listed: a
 * case-insensitive filesystem would open `TDD/` for `tdd`, a folder
 * {@link readDir} reports as invalid, and lookup must agree with the catalog.
 */
function skillFileIn(dir: string, name: string): string | undefined {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return undefined;
  }
  if (!entries.some((entry) => entry.isDirectory() && entry.name === name)) return undefined;
  const skillFile = path.join(dir, name, 'SKILL.md');
  return fs.existsSync(skillFile) ? skillFile : undefined;
}

export function skillsDirOf(root: string): string {
  return path.join(root, STATE_DIR, 'skills');
}

/**
 * The roots whose `.ordewell/skills/` hold a workspace's skills, in the order
 * they win (global wins over all of them). A workspace that is one repository
 * (`.`) reads its own, as checked out at `checkout`. A repo group (ADR-0014)
 * has no repository at its root: the group root's own folder comes first —
 * the user writes it, it is in no repo, so it is always read from the main
 * checkout — then each repo's committed folder as checked out under
 * `checkout`, in layout order.
 */
export function workspaceSkillRoots(workspaceRoot: string, repos: readonly string[], checkout = workspaceRoot): string[] {
  if (repos.length === 0 || repos.includes(SELF_REPO)) return [checkout];
  return [workspaceRoot, ...repos.map((repo) => path.join(checkout, repo))];
}

export class SkillsService {
  private readonly workspaceRoots: readonly string[];

  /** `workspaceRoots` in the order they win, as {@link workspaceSkillRoots} gives them. */
  constructor(workspaceRoots?: string | readonly string[]) {
    this.workspaceRoots = workspaceRoots === undefined ? [] : typeof workspaceRoots === 'string' ? [workspaceRoots] : [...workspaceRoots];
  }

  /**
   * The same global skills, with the workspace ones read from `roots` instead —
   * a task's worktrees, whose `.ordewell/skills/` are their own committed copies.
   */
  forRoot(roots: string | readonly string[]): SkillsService {
    return new SkillsService(roots);
  }

  /** Where {@link findSkill} looks, in the order it looks — global first. */
  searchedDirs(): string[] {
    return [this.globalDir(), ...this.workspaceDirs()];
  }

  private workspaceDirs(): string[] {
    return this.workspaceRoots.map(skillsDirOf);
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
      raw = readSkillText(path.join(dir, 'SKILL.md'));
    } catch {
      return false;
    }
    return splitFrontmatter(raw)?.fields.get('name') === expectedName;
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

  /** A name no skill could have resolves to nothing: it is joined into a path, so `../x` would read outside the skill dirs. */
  findSkill(name: string): SkillInfo | undefined {
    if (!isSkillName(name)) return undefined;
    this.pruneRetired();
    if ((BUILTIN_SKILL_NAMES as readonly string[]).includes(name)) this.seed(name);
    const globalFile = skillFileIn(this.globalDir(), name);
    if (globalFile) return parseSkillFile(globalFile, name, 'global');
    for (const workspaceDir of this.workspaceDirs()) {
      const workspaceFile = skillFileIn(workspaceDir, name);
      if (workspaceFile) return parseSkillFile(workspaceFile, name, 'workspace');
    }
    return undefined;
  }

  listSkills(): SkillInfo[] {
    return this.catalog().skills;
  }

  /** Workspace skills skipped by `listSkills` and `findSkill` because one that wins has the same name. */
  listShadowed(): ShadowedSkill[] {
    return this.catalog().shadowed;
  }

  /**
   * Global wins a name clash: a repository's committed skill must not be able
   * to silently replace one the user installed, built-ins included. Among
   * workspace folders the first read wins, the same way.
   */
  private catalog(): SkillCatalog {
    this.pruneRetired();
    for (const name of BUILTIN_SKILL_NAMES) this.seed(name);
    return this.readCatalog();
  }

  /** Inspect installed skills without seeding, refreshing or pruning global files. */
  readCatalog(): SkillCatalog {
    const byName = new Map<string, SkillInfo>();
    const global = readDir(this.globalDir(), 'global');
    for (const skill of global.skills) {
      byName.set(skill.name, skill);
    }
    const shadowed: ShadowedSkill[] = [];
    const invalid = [...global.invalid];
    for (const workspaceDir of this.workspaceDirs()) {
      const read = readDir(workspaceDir, 'workspace');
      invalid.push(...read.invalid);
      for (const skill of read.skills) {
        const winner = byName.get(skill.name);
        if (winner) shadowed.push({ skill, shadowedBy: winner });
        else byName.set(skill.name, skill);
      }
    }
    return { skills: [...byName.values()], shadowed, invalid };
  }

  getSkillContent(name: string): string | undefined {
    return this.findSkill(name)?.content;
  }
}

/**
 * The skills a workspace sees outside any task — every listing, picker and
 * catalog before a task worktree exists: global, then the folders a spawn
 * reads (see {@link workspaceSkillRoots}), each repo's as checked out in the
 * workspace. `workspaceRepos` is the setting that names a repo group.
 */
export function createSkillsService(workspaceRoot?: string, workspaceRepos: readonly string[] = []): SkillsService {
  if (workspaceRoot === undefined) return new SkillsService();
  return new SkillsService(workspaceSkillRoots(workspaceRoot, workspaceRepoGroup(workspaceRoot, workspaceRepos)));
}
