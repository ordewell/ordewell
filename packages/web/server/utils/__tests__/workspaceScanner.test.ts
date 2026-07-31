import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { scanWorkspacesImpl } from '../workspaceScanner';

let tmpDir: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-ws-'));
  fs.mkdirSync(path.join(tmpDir, 'project_a'));
  fs.mkdirSync(path.join(tmpDir, 'project_a', '.ordewell'));
  fs.mkdirSync(path.join(tmpDir, 'project_b'));
  // no .ordewell in project_b
  fs.writeFileSync(path.join(tmpDir, 'project_b', 'readme.md'), 'hello');
  fs.mkdirSync(path.join(tmpDir, 'project_c'));
  fs.mkdirSync(path.join(tmpDir, 'project_c', '.ordewell'));
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('scanWorkspacesImpl', () => {
  it('returns directories that contain .ordewell', () => {
    const results = scanWorkspacesImpl({
      fsModule: fs,
      pathModule: path,
      cwd: tmpDir,
      home: tmpDir,
      projectDir: path.join(tmpDir, 'ordewell-project'),
    });

    expect(results).toContain(path.join(tmpDir, 'project_a'));
    expect(results).toContain(path.join(tmpDir, 'project_c'));
    expect(results).not.toContain(path.join(tmpDir, 'project_b'));
  });

  it('filters out the project itself', () => {
    fs.mkdirSync(path.join(tmpDir, 'ordewell-project'));
    fs.mkdirSync(path.join(tmpDir, 'ordewell-project', '.ordewell'));

    const results = scanWorkspacesImpl({
      fsModule: fs,
      pathModule: path,
      cwd: tmpDir,
      home: tmpDir,
      projectDir: path.join(tmpDir, 'ordewell-project'),
    });

    expect(results).not.toContain(path.join(tmpDir, 'ordewell-project'));
  });

  it('returns sorted results', () => {
    const results = scanWorkspacesImpl({
      fsModule: fs,
      pathModule: path,
      cwd: tmpDir,
      home: tmpDir,
      projectDir: path.join(tmpDir, 'ordewell-project'),
    });

    const sorted = [...results].sort();
    expect(results).toEqual(sorted);
  });

  it('does not break when a root does not exist', () => {
    const results = scanWorkspacesImpl({
      fsModule: fs,
      pathModule: path,
      cwd: '/no/such/dir/abc123',
      home: '/no/such/home/abc123',
      projectDir: path.join(tmpDir, 'ordewell-project'),
    });

    expect(Array.isArray(results)).toBe(true);
  });
});
