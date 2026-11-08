import { DAEMON_ROUTES } from '@ordewell/core';
import { describe, expect, it } from 'vitest';
import { routePath, routeRequest, sessionOf, socketPath } from '../routeRequest';

describe('routeRequest', () => {
  it('takes the method, path and turn flag from the route\'s row', () => {
    expect(routeRequest('plans.converseMessage', { params: { sessionId: 's1' }, body: { message: 'hi' } })).toEqual({
      method: 'POST',
      path: '/api/plans/s1/converse/message',
      body: { message: 'hi' },
      turn: true,
    });
    expect(routeRequest('sessions.list', {})).toEqual({ method: 'GET', path: '/api/sessions', turn: false });
  });

  it('writes each parameter as one segment, however much it holds', () => {
    expect(routePath('r', DAEMON_ROUTES['sessions.taskLog'], { id: 'a#b', taskId: 'x/y?z' })).toBe('/api/sessions/a%23b/tasks/x%2Fy%3Fz/log');
    expect(routePath('r', DAEMON_ROUTES['sessions.get'], { id: '100%' })).toBe('/api/sessions/100%25');
  });

  it.each(['', '.', '..'])('refuses %j as a segment, which a URL parser would resolve away', (value) => {
    expect(() => routePath('r', DAEMON_ROUTES['sessions.get'], { id: value })).toThrow(TypeError);
  });

  it('refuses a path parameter it was not given', () => {
    expect(() => routePath('r', DAEMON_ROUTES['sessions.get'], {})).toThrow(/id is missing/);
  });

  it('writes the query in the order given, leaving out what is undefined', () => {
    expect(routePath('r', DAEMON_ROUTES['git.log'], {}, { workspace: '/ws a', ref: undefined, limit: '5' })).toBe('/api/git/log?workspace=%2Fws%20a&limit=5');
    expect(routePath('r', DAEMON_ROUTES['git.log'], {}, { ref: undefined })).toBe('/api/git/log');
  });

  it('refuses a query parameter the row does not list', () => {
    expect(() => routePath('r', DAEMON_ROUTES['runners.setEnabled'], { id: 'claude-code' }, { workspace: '/ws' })).toThrow(/not a query parameter/);
  });

  it('sends a live row with the workspace it is asked from, so another project\'s copy of the id is refused', () => {
    expect(routeRequest('plans.execute', { params: { sessionId: 's1' } }, '/b').path).toBe('/api/plans/s1/execute?workspace=%2Fb');
    expect(routeRequest('children.get', { params: { id: 'root', childId: 'c1' } }, '/b').path).toBe('/api/sessions/root/children/c1?workspace=%2Fb');
    expect(routeRequest('approvals.decide', { params: { sessionId: 's1', approvalId: 'a1' }, body: { granted: true } }, '/b').path).toBe('/api/approvals/s1/a1?workspace=%2Fb');
    // The body's own workspace is the one a start means, and an explicit query stands.
    expect(routeRequest('plans.converseStart', { params: { sessionId: 's1' }, body: { goal: 'g', workspace: '/a' } }, '/b').path).toBe('/api/plans/s1/converse/start?workspace=%2Fa');
    expect(routeRequest('plans.execute', { params: { sessionId: 's1' }, query: { workspace: '/a' } }, '/b').path).toBe('/api/plans/s1/execute?workspace=%2Fa');
    // A row that reaches no live session is sent as it is called.
    expect(routeRequest('runners.setEnabled', { params: { id: 'claude-code' }, body: { enabled: true } }, '/b').path).toBe('/api/runners/claude-code');
  });

  it('opens a session socket naming its workspace', () => {
    expect(socketPath('s#1', undefined, '/b')).toBe('/ws/session/s%231?workspace=%2Fb');
    expect(socketPath('root', 'c1', '/b')).toBe('/ws/session/root/child/c1?workspace=%2Fb');
    expect(socketPath('root')).toBe('/ws/session/root');
  });

  it('names the session of a session-scoped route by its own parameter', () => {
    expect(sessionOf('plans.execute', { sessionId: 's1' })).toBe('s1');
    expect(sessionOf('children.get', { id: 'root', childId: 'c1' })).toBe('root');
    expect(sessionOf('approvals.decide', { sessionId: 's1', approvalId: 'a1' })).toBeUndefined();
    expect(sessionOf('runners.setEnabled', { id: 'claude-code' })).toBeUndefined();
  });
});
