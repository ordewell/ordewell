import { describe, it, expect } from 'vitest';
import {
  ACP_ERROR,
  ACP_PROTOCOL_VERSION,
  isAuthRequired,
  parseAcp,
  parseSessionUpdate,
  initializeRequestSchema,
  initializeResponseSchema,
  newSessionRequestSchema,
  newSessionResponseSchema,
  loadSessionRequestSchema,
  resumeSessionRequestSchema,
  closeSessionRequestSchema,
  promptRequestSchema,
  promptResponseSchema,
  cancelNotificationSchema,
  requestPermissionRequestSchema,
  requestPermissionResponseSchema,
  setModeRequestSchema,
  setConfigOptionRequestSchema,
  setConfigOptionResponseSchema,
  sessionNotificationSchema,
} from '../harness/acpSchema';

/**
 * The literals below are the examples in the ACP v1 specification
 * (agentclientprotocol.com/protocol/v1), not output of this code.
 */

describe('the update kinds of session/update', () => {
  const kinds: Array<[string, Record<string, unknown>]> = [
    ['agent_message_chunk', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } }],
    ['agent_thought_chunk', { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'hm' } }],
    ['user_message_chunk', { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'go' } }],
    ['tool_call', { sessionUpdate: 'tool_call', toolCallId: 'call_001', title: 'Reading file', kind: 'read', status: 'pending' }],
    ['tool_call_update', { sessionUpdate: 'tool_call_update', toolCallId: 'call_001', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'ok' } }] }],
    ['plan', { sessionUpdate: 'plan', entries: [{ content: 'Check', priority: 'high', status: 'pending' }] }],
    ['available_commands_update', { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'web', description: 'Search', input: { hint: 'query' } }] }],
    ['current_mode_update', { sessionUpdate: 'current_mode_update', currentModeId: 'code' }],
    ['config_option_update', { sessionUpdate: 'config_option_update', configOptions: [{ id: 'model', name: 'Model', type: 'select', currentValue: 'a', options: [{ value: 'a', name: 'A' }] }] }],
    ['usage_update', { sessionUpdate: 'usage_update', used: 53000, size: 200000, cost: { amount: 0.045, currency: 'USD' } }],
  ];

  it.each(kinds)('recognises %s', (kind, raw) => {
    const parsed = parseSessionUpdate(raw);

    expect(parsed.sessionUpdate).toBe(kind);
  });

  it('narrows each kind to its own fields', () => {
    const tool = parseSessionUpdate(kinds[3][1]);
    const usage = parseSessionUpdate(kinds[9][1]);

    expect(tool.sessionUpdate === 'tool_call' && tool.toolCallId).toBe('call_001');
    expect(usage.sessionUpdate === 'usage_update' && [usage.used, usage.size]).toEqual([53000, 200000]);
  });

  it('reports a kind it does not know as unknown, with its name and the raw update, and does not throw', () => {
    const raw = { sessionUpdate: 'session_info_update', title: 'x' };

    expect(parseSessionUpdate(raw)).toEqual({ sessionUpdate: 'unknown', kind: 'session_info_update', raw });
  });

  it('reports a known kind missing a field it needs as unknown, rather than guessing', () => {
    const parsed = parseSessionUpdate({ sessionUpdate: 'tool_call', title: 'no id' });

    expect(parsed.sessionUpdate).toBe('unknown');
  });

  it.each([null, 'text', 7, [], {}])('reports %j, which is no update at all, as unknown', (raw) => {
    expect(parseSessionUpdate(raw).sessionUpdate).toBe('unknown');
  });

  it('passes fields the schema does not name through, nested ones too', () => {
    const parsed = parseSessionUpdate({
      sessionUpdate: 'tool_call', toolCallId: 'c', title: 't', _meta: { vendor: 1 }, future: true,
      content: [{ type: 'diff', path: '/a', newText: 'b', extra: 1 }],
    });

    expect(parsed).toMatchObject({ _meta: { vendor: 1 }, future: true, content: [{ type: 'diff', extra: 1 }] });
  });

  it('keeps a tool kind or status it does not know, since agents add them', () => {
    const parsed = parseSessionUpdate({ sessionUpdate: 'tool_call', toolCallId: 'c', title: 't', kind: 'teleport', status: 'queued' });

    expect(parsed).toMatchObject({ sessionUpdate: 'tool_call', kind: 'teleport', status: 'queued' });
  });

  it('accepts a boolean config option beside a select with grouped options', () => {
    const parsed = parseSessionUpdate({
      sessionUpdate: 'config_option_update',
      configOptions: [
        { id: 'think', name: 'Think', type: 'boolean', currentValue: true },
        { id: 'model', name: 'Model', type: 'select', category: 'model', currentValue: 'a', options: [{ group: 'g', name: 'G', options: [{ value: 'a', name: 'A' }] }] },
      ],
    });

    expect(parsed.sessionUpdate).toBe('config_option_update');
  });
});

describe('the messages a client sends', () => {
  it('accepts initialize as the specification shows it', () => {
    const request = { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: 'ordewell', version: '1.0.0' } };

    expect(ACP_PROTOCOL_VERSION).toBe(1);
    expect(parseAcp(initializeRequestSchema, request)).toEqual({ ok: true, value: request });
  });

  it('requires a protocol version and a session id where the specification does', () => {
    expect(parseAcp(initializeRequestSchema, {}).ok).toBe(false);
    expect(parseAcp(initializeRequestSchema, 7)).toMatchObject({ ok: false, error: expect.stringMatching(/object/i) });
    expect(parseAcp(promptRequestSchema, { prompt: [] }).ok).toBe(false);
    expect(parseAcp(cancelNotificationSchema, {}).ok).toBe(false);
    expect(parseAcp(closeSessionRequestSchema, {}).ok).toBe(false);
    expect(parseAcp(setModeRequestSchema, { sessionId: 's' }).ok).toBe(false);
  });

  it('accepts session/new with an http MCP server whose token rides in a header', () => {
    const request = { cwd: '/repo', mcpServers: [{ type: 'http', name: 'ordewell', url: 'http://127.0.0.1:1/mcp', headers: [{ name: 'Authorization', value: 'Bearer t' }] }] };

    expect(parseAcp(newSessionRequestSchema, request)).toEqual({ ok: true, value: request });
  });

  it('accepts a stdio MCP server, which has no type, and an sse one', () => {
    const stdio = { name: 'fs', command: '/bin/fs', args: [], env: [{ name: 'A', value: 'b' }] };
    const sse = { type: 'sse', name: 's', url: 'http://x', headers: [] };

    expect(parseAcp(newSessionRequestSchema, { cwd: '/r', mcpServers: [stdio, sse] }).ok).toBe(true);
  });

  it('requires session/new to say its working directory and its MCP servers', () => {
    expect(parseAcp(newSessionRequestSchema, { cwd: '/r' }).ok).toBe(false);
    expect(parseAcp(newSessionRequestSchema, { mcpServers: [] }).ok).toBe(false);
  });

  it('accepts session/load and session/resume, which name a session', () => {
    expect(parseAcp(loadSessionRequestSchema, { sessionId: 's', cwd: '/r', mcpServers: [] }).ok).toBe(true);
    expect(parseAcp(resumeSessionRequestSchema, { sessionId: 's', cwd: '/r' }).ok).toBe(true);
    expect(parseAcp(loadSessionRequestSchema, { cwd: '/r', mcpServers: [] }).ok).toBe(false);
  });

  it('accepts session/prompt with text and resource_link blocks', () => {
    const request = { sessionId: 's', prompt: [{ type: 'text', text: 'go' }, { type: 'resource_link', name: 'a', uri: 'file:///a' }] };

    expect(parseAcp(promptRequestSchema, request).ok).toBe(true);
  });

  it('accepts session/set_mode and both forms of session/set_config_option', () => {
    expect(parseAcp(setModeRequestSchema, { sessionId: 's', modeId: 'code' }).ok).toBe(true);
    expect(parseAcp(setConfigOptionRequestSchema, { sessionId: 's', configId: 'model', value: 'a' }).ok).toBe(true);
    expect(parseAcp(setConfigOptionRequestSchema, { sessionId: 's', configId: 'think', type: 'boolean', value: true }).ok).toBe(true);
    expect(parseAcp(setConfigOptionRequestSchema, { sessionId: 's', value: 'a' }).ok).toBe(false);
  });

  it('accepts both outcomes of a permission request, and requires an option id on a selection', () => {
    expect(parseAcp(requestPermissionResponseSchema, { outcome: { outcome: 'cancelled' } }).ok).toBe(true);
    expect(parseAcp(requestPermissionResponseSchema, { outcome: { outcome: 'selected', optionId: 'allow-once' } }).ok).toBe(true);
    expect(parseAcp(requestPermissionResponseSchema, { outcome: { outcome: 'selected' } }).ok).toBe(false);
  });
});

describe('the messages a client receives', () => {
  it('reads initialize, keeping what the agent added', () => {
    const response = {
      protocolVersion: 1,
      agentCapabilities: { loadSession: true, promptCapabilities: { image: true }, mcpCapabilities: { http: true, sse: false }, sessionCapabilities: { resume: {}, close: {} }, vendor: 1 },
      agentInfo: { name: 'copilot', title: 'Copilot', version: '1.2.3' },
      authMethods: [{ id: 'login', name: 'Log in' }, { type: 'terminal', id: 't', name: 'Terminal', args: ['login'] }],
    };

    const parsed = parseAcp(initializeResponseSchema, response);

    expect(parsed).toEqual({ ok: true, value: response });
  });

  it('reads an initialize that says little, since every capability defaults to off', () => {
    expect(parseAcp(initializeResponseSchema, { protocolVersion: 1 }).ok).toBe(true);
  });

  it('reads session/new with its config options, modes and the legacy model list', () => {
    const response = {
      sessionId: 'sess_1',
      configOptions: [{ id: 'mode', name: 'Mode', category: 'mode', type: 'select', currentValue: 'ask', options: [{ value: 'ask', name: 'Ask', description: null }] }],
      modes: { currentModeId: 'ask', availableModes: [{ id: 'ask', name: 'Ask' }] },
      models: { currentModelId: 'm1', availableModels: [{ modelId: 'm1', name: 'M1' }] },
    };

    expect(parseAcp(newSessionResponseSchema, response)).toEqual({ ok: true, value: response });
  });

  it('reads a null config option list and null modes, which the specification allows', () => {
    expect(parseAcp(newSessionResponseSchema, { sessionId: 's', configOptions: null, modes: null }).ok).toBe(true);
  });

  it('reads the prompt response with a stop reason, and the usage when there is one', () => {
    const response = { stopReason: 'end_turn', usage: { totalTokens: 53, inputTokens: 35, outputTokens: 18, thoughtTokens: 5, cachedReadTokens: 3 } };

    expect(parseAcp(promptResponseSchema, response)).toEqual({ ok: true, value: response });
    expect(parseAcp(promptResponseSchema, { stopReason: 'end_turn', usage: null }).ok).toBe(true);
    expect(parseAcp(promptResponseSchema, {}).ok).toBe(false);
  });

  it('keeps a stop reason it does not know, to be reported rather than dropped', () => {
    expect(parseAcp(promptResponseSchema, { stopReason: 'exhausted' })).toEqual({ ok: true, value: { stopReason: 'exhausted' } });
  });

  it('reads a permission request: the tool call it is for and the options it offers', () => {
    const request = {
      sessionId: 's',
      toolCall: { toolCallId: 'call_001', title: 'Edit a.ts', kind: 'edit', locations: [{ path: '/repo/a.ts', line: 3 }] },
      options: [
        { optionId: 'allow-once', name: 'Allow', kind: 'allow_once' },
        { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
      ],
    };

    expect(parseAcp(requestPermissionRequestSchema, request)).toEqual({ ok: true, value: request });
  });

  it('reads the notification that wraps an update', () => {
    const wrapped = { sessionId: 's', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'x' } } };

    expect(parseAcp(sessionNotificationSchema, wrapped).ok).toBe(true);
    expect(parseAcp(sessionNotificationSchema, { update: {} }).ok).toBe(false);
  });

  it('reads the full option list that set_config_option answers with', () => {
    expect(parseAcp(setConfigOptionResponseSchema, { configOptions: [] })).toEqual({ ok: true, value: { configOptions: [] } });
    expect(parseAcp(setConfigOptionResponseSchema, {}).ok).toBe(false);
  });

  it('says why a message did not parse, in words', () => {
    const parsed = parseAcp(promptResponseSchema, { stopReason: 7 });

    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.error).toContain('stopReason');
  });
});

describe('the error codes', () => {
  it('has the codes the specification names', () => {
    expect(ACP_ERROR).toMatchObject({ authRequired: -32000, resourceNotFound: -32002, requestCancelled: -32800, methodNotFound: -32601, invalidParams: -32602 });
  });

  it('reads -32000 as signed out and nothing else', () => {
    expect(isAuthRequired({ code: -32000, message: 'Authentication required' })).toBe(true);
    expect(isAuthRequired({ code: -32603, message: 'x' })).toBe(false);
    expect(isAuthRequired(undefined)).toBe(false);
  });
});
