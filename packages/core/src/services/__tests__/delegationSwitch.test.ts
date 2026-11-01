import { describe, it, expect } from 'vitest';
import { containersOffered, delegationSwitchedOn, DELEGATION_OFFERED, type DelegationPlace } from '../runSettingsText';

/** ADR-0055 D21: on only with the variable, and only in a build run from a git checkout. */

const CHECKOUT = '/home/me/src/ordewell';
const atCheckout = (moduleDir: string, files = [`${CHECKOUT}/.git`, `${CHECKOUT}/packages/core/package.json`]): Omit<DelegationPlace, 'env'> => ({
  moduleDir, exists: (path) => files.includes(path),
});

describe('the delegation switch', () => {
  it('is off in a checkout until the variable says 1', () => {
    const place = atCheckout(`${CHECKOUT}/packages/core/dist`);
    expect(delegationSwitchedOn({ ...place, env: undefined })).toBe(false);
    expect(delegationSwitchedOn({ ...place, env: '0' })).toBe(false);
    expect(delegationSwitchedOn({ ...place, env: 'true' })).toBe(false);
    expect(delegationSwitchedOn({ ...place, env: '1' })).toBe(true);
  });

  it('reads every package of a checkout, a bundled leaf included, and from a worktree, whose .git is a file', () => {
    expect(delegationSwitchedOn({ ...atCheckout(`${CHECKOUT}/packages/core/src/services`), env: '1' })).toBe(true);
    expect(delegationSwitchedOn({ ...atCheckout(`${CHECKOUT}/packages/vscode/dist`), env: '1' })).toBe(true);
  });

  it('ignores the variable in a published package, even in a project kept in git', () => {
    const project = '/home/me/app';
    const files = [`${project}/.git`, `${project}/packages/core/package.json`];
    expect(delegationSwitchedOn({ moduleDir: `${project}/node_modules/@ordewell/core/dist`, env: '1', exists: (p) => files.includes(p) })).toBe(false);
    expect(delegationSwitchedOn({ moduleDir: `${project}/packages/app/node_modules/@ordewell/core/dist`, env: '1', exists: (p) => files.includes(p) })).toBe(false);
  });

  it('ignores it in a packaged extension, and anywhere with no checkout above', () => {
    expect(delegationSwitchedOn({ moduleDir: '/home/me/.vscode/extensions/ordewell-0.12.0/dist', env: '1', exists: () => true })).toBe(false);
    expect(delegationSwitchedOn({ ...atCheckout(`${CHECKOUT}/packages/core/dist`, []), env: '1' })).toBe(false);
  });

  it('ignores it where nothing can say where it runs, as in a webview', () => {
    expect(delegationSwitchedOn({ moduleDir: null, env: '1', exists: () => true })).toBe(false);
  });

  it('is off as these tests run: the variable is not set for them', () => {
    expect(process.env.ORDEWELL_DELEGATION).toBeUndefined();
    expect(DELEGATION_OFFERED).toBe(false);
  });
});

/** ADR-0059 L5: containers are held to the same test, with their own variable, until the container review's findings are closed. */
describe('the containers switch', () => {
  it('is on only with ORDEWELL_CONTAINERS=1, in a checkout', () => {
    const place = atCheckout(`${CHECKOUT}/packages/core/dist`);
    expect(containersOffered({ ...place, env: undefined })).toBe(false);
    expect(containersOffered({ ...place, env: 'true' })).toBe(false);
    expect(containersOffered({ ...place, env: '1' })).toBe(true);
  });

  it('ignores the variable in a published package and in a packaged extension', () => {
    const project = '/home/me/app';
    const files = [`${project}/.git`, `${project}/packages/core/package.json`];
    expect(containersOffered({ moduleDir: `${project}/node_modules/@ordewell/core/dist`, env: '1', exists: (p) => files.includes(p) })).toBe(false);
    expect(containersOffered({ moduleDir: '/home/me/.vscode/extensions/ordewell-0.12.0/dist', env: '1', exists: () => true })).toBe(false);
  });

  it('is off as these tests run: the variable is not set for them', () => {
    expect(process.env.ORDEWELL_CONTAINERS).toBeUndefined();
    expect(containersOffered()).toBe(false);
  });
});
