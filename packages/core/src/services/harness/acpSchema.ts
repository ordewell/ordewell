import { z } from 'zod';

/**
 * The Agent Client Protocol, version 1, as a client sees it: what Ordewell
 * sends an agent and what the agent sends back.
 *
 * Vendored rather than imported from `@agentclientprotocol/sdk`: that package
 * is ESM-only and core also ships CommonJS, so a runtime import would break
 * `require('@ordewell/core')`.
 *
 * Agents differ from the specification and from each other, and a newer agent
 * adds fields and kinds. So every object passes unknown fields through, an
 * enum-like field (a tool's kind or status, a stop reason) is any string, and
 * a message is checked with `safeParse` — one that does not fit is reported,
 * never thrown. The one hard rule is a field the specification requires and
 * Ordewell reads.
 */

export const ACP_PROTOCOL_VERSION = 1;

export const ACP_ERROR = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
  /** `session/new` or `session/prompt` before the agent is signed in. */
  authRequired: -32000,
  resourceNotFound: -32002,
  requestCancelled: -32800,
} as const;

export interface AcpRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export function isAuthRequired(error: Partial<AcpRpcError> | undefined): boolean {
  return error?.code === ACP_ERROR.authRequired;
}

const obj = <T extends z.ZodRawShape>(shape: T) => z.object(shape).passthrough();
const meta = z.record(z.unknown()).nullish();
/** `{}` when supported, absent or null when not. */
const capability = z.object({}).passthrough().nullish();

export type AcpParse<T> = { ok: true; value: T } | { ok: false; error: string };

export function parseAcp<S extends z.ZodTypeAny>(schema: S, raw: unknown): AcpParse<z.output<S>> {
  const result = schema.safeParse(raw);
  if (result.success) return { ok: true, value: result.data };
  const issue = result.error.issues[0];
  const where = issue.path.join('.');
  return { ok: false, error: where ? `${where}: ${issue.message}` : issue.message };
}

// --- content ----------------------------------------------------------------

/**
 * One block of content. `text` and `resource_link` are the two every agent
 * must support; an image, audio or embedded resource passes through whole.
 */
export const contentBlockSchema = obj({
  type: z.string(),
  text: z.string().optional(),
  uri: z.string().optional(),
  name: z.string().optional(),
});
export type AcpContentBlock = z.output<typeof contentBlockSchema>;

export const toolCallContentSchema = obj({
  /** `content`, `diff` or `terminal`. */
  type: z.string(),
  content: contentBlockSchema.optional(),
  path: z.string().optional(),
  newText: z.string().optional(),
  oldText: z.string().nullish(),
  terminalId: z.string().optional(),
});
export type AcpToolCallContent = z.output<typeof toolCallContentSchema>;

const toolCallLocationSchema = obj({ path: z.string(), line: z.number().nullish() });

// --- session updates ----------------------------------------------------------

const toolCallFields = {
  toolCallId: z.string(),
  /** `read`, `edit`, `delete`, `move`, `search`, `execute`, `think`, `fetch`, `switch_mode` or `other`. */
  kind: z.string().nullish(),
  /** `pending`, `in_progress`, `completed` or `failed`. */
  status: z.string().nullish(),
  content: z.array(toolCallContentSchema).nullish(),
  locations: z.array(toolCallLocationSchema).nullish(),
  name: z.string().nullish(),
  rawInput: z.unknown().optional(),
  rawOutput: z.unknown().optional(),
  /** An agent's own annotations: Qwen Code names an MCP tool's native name in `_meta.toolName`, which its title (the call's arguments) cannot be trusted to. */
  _meta: meta,
};

/** What a permission request names its tool call by: a tool call whose every field but its id may be absent. */
export const toolCallSchema = obj({ ...toolCallFields, title: z.string().nullish() });
export type AcpToolCall = z.output<typeof toolCallSchema>;

const selectOptionSchema = obj({
  value: z.string().optional(),
  group: z.string().optional(),
  name: z.string(),
  description: z.string().nullish(),
  options: z.array(obj({ value: z.string(), name: z.string(), description: z.string().nullish() })).optional(),
});

/**
 * A session setting an agent offers. Only `select` and `boolean` are defined;
 * a type this code does not know keeps its `currentValue` as it came.
 */
export const configOptionSchema = obj({
  id: z.string(),
  name: z.string(),
  description: z.string().nullish(),
  /** `mode`, `model`, `model_config`, `thought_level` or `other`: a hint for a user interface, nothing more. */
  category: z.string().nullish(),
  type: z.string(),
  currentValue: z.unknown().optional(),
  options: z.array(selectOptionSchema).optional(),
});
export type AcpConfigOption = z.output<typeof configOptionSchema>;

const availableCommandSchema = obj({
  name: z.string(),
  description: z.string(),
  input: obj({ hint: z.string() }).nullish(),
});

const usageCostSchema = obj({ amount: z.number().optional(), currency: z.string().optional() });

const chunk = obj({ content: contentBlockSchema, messageId: z.string().nullish() });

const updateSchemas = {
  agent_message_chunk: chunk,
  agent_thought_chunk: chunk,
  user_message_chunk: chunk,
  tool_call: obj({ ...toolCallFields, title: z.string() }),
  tool_call_update: obj({ ...toolCallFields, title: z.string().nullish() }),
  plan: obj({ entries: z.array(obj({ content: z.string(), priority: z.string(), status: z.string() })) }),
  available_commands_update: obj({ availableCommands: z.array(availableCommandSchema) }),
  current_mode_update: obj({ currentModeId: z.string() }),
  config_option_update: obj({ configOptions: z.array(configOptionSchema) }),
  usage_update: obj({ used: z.number(), size: z.number(), cost: usageCostSchema.nullish() }),
} as const;

type UpdateSchemas = typeof updateSchemas;
export type AcpSessionUpdateKind = keyof UpdateSchemas;

export type AcpKnownUpdate = {
  [K in AcpSessionUpdateKind]: { sessionUpdate: K } & z.output<UpdateSchemas[K]>;
}[AcpSessionUpdateKind];

/** An update of a kind this code does not know, or of a known kind that did not fit its schema. */
export interface AcpUnknownUpdate {
  sessionUpdate: 'unknown';
  /** What the agent called it, when it called it anything. */
  kind?: string;
  raw: unknown;
}

export type AcpSessionUpdate = AcpKnownUpdate | AcpUnknownUpdate;

function isKnownKind(kind: string): kind is AcpSessionUpdateKind {
  return Object.prototype.hasOwnProperty.call(updateSchemas, kind);
}

/**
 * Read the `update` of a `session/update` notification. Never throws: a kind
 * added after this was written, and a known one that arrives malformed, both
 * come back as `unknown` for the caller to skip.
 */
export function parseSessionUpdate(raw: unknown): AcpSessionUpdate {
  const kind = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as { sessionUpdate?: unknown }).sessionUpdate : undefined;
  if (typeof kind !== 'string') return { sessionUpdate: 'unknown', raw };
  if (!isKnownKind(kind)) return { sessionUpdate: 'unknown', kind, raw };
  const parsed = updateSchemas[kind].safeParse(raw);
  if (!parsed.success) return { sessionUpdate: 'unknown', kind, raw };
  return parsed.data as AcpKnownUpdate;
}

export const sessionNotificationSchema = obj({ sessionId: z.string(), update: z.unknown() });

// --- initialize ---------------------------------------------------------------

export const initializeRequestSchema = obj({
  protocolVersion: z.number(),
  clientCapabilities: obj({
    fs: obj({ readTextFile: z.boolean().optional(), writeTextFile: z.boolean().optional() }).optional(),
    terminal: z.boolean().optional(),
  }).optional(),
  clientInfo: obj({ name: z.string(), version: z.string(), title: z.string().nullish() }).nullish(),
});

/** What Ordewell says in `initialize`, shared by every client of an agent so discovery and a task introduce it alike. */
export const ACP_INITIALIZE_PARAMS = {
  protocolVersion: ACP_PROTOCOL_VERSION,
  clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
  clientInfo: { name: 'ordewell', title: 'Ordewell', version: '0.1.0' },
};

export const initializeResponseSchema = obj({
  protocolVersion: z.number(),
  agentCapabilities: obj({
    loadSession: z.boolean().optional(),
    promptCapabilities: obj({ image: z.boolean().optional(), audio: z.boolean().optional(), embeddedContext: z.boolean().optional() }).optional(),
    mcpCapabilities: obj({ http: z.boolean().optional(), sse: z.boolean().optional() }).optional(),
    sessionCapabilities: obj({ resume: capability, close: capability, list: capability, delete: capability }).optional(),
  }).optional(),
  agentInfo: obj({ name: z.string(), version: z.string(), title: z.string().nullish() }).nullish(),
  authMethods: z.array(obj({ id: z.string(), name: z.string(), type: z.string().optional(), description: z.string().nullish() })).optional(),
});
export type AcpInitializeResponse = z.output<typeof initializeResponseSchema>;

// --- sessions -----------------------------------------------------------------

const httpHeaderSchema = obj({ name: z.string(), value: z.string() });

export const mcpServerSchema = z.union([
  obj({ type: z.literal('http'), name: z.string(), url: z.string(), headers: z.array(httpHeaderSchema) }),
  obj({ type: z.literal('sse'), name: z.string(), url: z.string(), headers: z.array(httpHeaderSchema) }),
  obj({ name: z.string(), command: z.string(), args: z.array(z.string()), env: z.array(httpHeaderSchema) }),
]);

export const newSessionRequestSchema = obj({ cwd: z.string(), mcpServers: z.array(mcpServerSchema) });
export const loadSessionRequestSchema = obj({ sessionId: z.string(), cwd: z.string(), mcpServers: z.array(mcpServerSchema) });
/** `mcpServers` is not required on a resume. */
export const resumeSessionRequestSchema = obj({ sessionId: z.string(), cwd: z.string(), mcpServers: z.array(mcpServerSchema).optional() });
export const closeSessionRequestSchema = obj({ sessionId: z.string() });

const sessionModesSchema = obj({
  currentModeId: z.string(),
  availableModes: z.array(obj({ id: z.string(), name: z.string(), description: z.string().nullish() })),
});

/** The state `session/new` hands back; `session/load` and `session/resume` answer the same, without an id. */
export const newSessionResponseSchema = obj({
  sessionId: z.string().optional(),
  configOptions: z.array(configOptionSchema).nullish(),
  modes: sessionModesSchema.nullish(),
  /** The pre-config-option model list, which some agents still send. */
  models: obj({
    currentModelId: z.string(),
    availableModels: z.array(obj({ modelId: z.string(), name: z.string(), description: z.string().nullish() })),
  }).nullish(),
  _meta: meta,
});
export type AcpSessionState = z.output<typeof newSessionResponseSchema>;

export const setModeRequestSchema = obj({ sessionId: z.string(), modeId: z.string() });

export const setConfigOptionRequestSchema = obj({
  sessionId: z.string(),
  configId: z.string(),
  /** `boolean` for a switch; absent for a choice among values. */
  type: z.string().optional(),
  value: z.union([z.string(), z.boolean()]),
});

/** The complete list of options after the change, not only the one changed. */
export const setConfigOptionResponseSchema = obj({ configOptions: z.array(configOptionSchema) });

// --- turns --------------------------------------------------------------------

export const promptRequestSchema = obj({ sessionId: z.string(), prompt: z.array(contentBlockSchema) });

const tokenUsageSchema = obj({
  totalTokens: z.number().optional(),
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
  thoughtTokens: z.number().nullish(),
  cachedReadTokens: z.number().nullish(),
  cachedWriteTokens: z.number().nullish(),
});
export type AcpTokenUsage = z.output<typeof tokenUsageSchema>;

export const promptResponseSchema = obj({
  /** `end_turn`, `max_tokens`, `max_turn_requests`, `refusal` or `cancelled`. */
  stopReason: z.string(),
  usage: tokenUsageSchema.nullish(),
});
export type AcpPromptResponse = z.output<typeof promptResponseSchema>;

export const cancelNotificationSchema = obj({ sessionId: z.string() });

// --- permission ---------------------------------------------------------------

export const permissionOptionSchema = obj({
  optionId: z.string(),
  name: z.string(),
  /** `allow_once`, `allow_always`, `reject_once` or `reject_always`. */
  kind: z.string(),
});
export type AcpPermissionOption = z.output<typeof permissionOptionSchema>;

export const requestPermissionRequestSchema = obj({
  sessionId: z.string(),
  toolCall: toolCallSchema,
  options: z.array(permissionOptionSchema),
});
export type AcpPermissionRequest = z.output<typeof requestPermissionRequestSchema>;

export const requestPermissionResponseSchema = obj({
  outcome: z.union([
    obj({ outcome: z.literal('cancelled') }),
    obj({ outcome: z.literal('selected'), optionId: z.string() }),
  ]),
});
