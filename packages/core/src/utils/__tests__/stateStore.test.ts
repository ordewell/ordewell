import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadState } from '../stateStore';

describe('loadState', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-state-')); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('brings an ADR-0013 isolation record to the repo-group shape', () => {
    fs.mkdirSync(path.join(tmpDir, '.ordewell'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.ordewell', 'state.json'), JSON.stringify({
      tasks: [], runners: ['claude-code'], status: 'approved', generatedAt: '', lastUpdated: '',
      isolation: {
        run: { id: 'r1', workspaceRoot: '/work/app', baseRef: 'abc', integrationBranch: 'ordewell/r1/integration', tasks: {} },
        resolvers: { r: 'c' },
      },
    }));

    expect(loadState(tmpDir)!.isolation).toEqual({
      run: {
        id: 'r1', workspaceRoot: '/work/app', shared: [], sharedRepos: [], tasks: {},
        repos: [{ path: '.', root: '/work/app', baseRef: 'abc', integrationBranch: 'ordewell/r1/integration' }],
      },
      resolvers: { r: 'c' },
    });
  });
});
