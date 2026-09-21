import { z } from 'zod';

export const invocationRequest = z.object({
  requestId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  prompt: z.string().min(1).max(512_000),
  model: z.string().trim().min(1).max(200),
  reasoningEffort: z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']).optional(),
  deadlineMs: z.number().int().min(100).max(300_000),
  outputSchema: z.record(z.unknown()),
  maxOutputTokens: z.number().int().min(1).max(128_000).optional(),
}).strict();
export type InvocationRequest = z.infer<typeof invocationRequest>;
export type JsonSchema = Record<string, unknown>;
export type InvocationState = 'running' | 'completed' | 'failed' | 'cancelled' | 'timed_out';
export interface InvocationResult {
  requestId: string;
  state: InvocationState;
  output: unknown | null;
  error: string | null;
  startedAt: string;
  durationMs: number | null;
  startupMs: number | null;
  configuredModel: string | null;
  actualModel: string | null;
  reasoningEffort: string | null;
  usage: { inputTokens: number; outputTokens: number; cachedInputTokens: number | null; cacheWriteInputTokens: number | null } | null;
  usageSource: 'native_thread_total' | 'native_result' | null;
}

/** Deliberately bounded JSON Schema subset. Unknown keywords never silently pass. */
export function checkSchema(schema: JsonSchema, depth = 0): void {
  if (depth > 12) throw new Error('schema_too_deep');
  const allowed = new Set(['type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'description']);
  if (Object.keys(schema).some(key => !allowed.has(key))) throw new Error('unsupported_schema_keyword');
  if (!['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'].includes(String(schema.type))) throw new Error('unsupported_schema_type');
  if (schema.description !== undefined && typeof schema.description !== 'string') throw new Error('invalid_schema_description');
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || !schema.enum.length || schema.enum.some(x => x !== null && !['string', 'number', 'boolean'].includes(typeof x)))) throw new Error('invalid_schema_enum');
  if (schema.type === 'object') {
    if (!isObject(schema.properties) || schema.additionalProperties !== false || !Array.isArray(schema.required)) throw new Error('schema_requires_closed_object');
    const keys = Object.keys(schema.properties);
    if (keys.length > 100 || new Set(schema.required).size !== keys.length || schema.required.some(key => typeof key !== 'string' || !Object.hasOwn(schema.properties as object, key))) throw new Error('schema_requires_all_properties');
    for (const value of Object.values(schema.properties)) {
      if (!isObject(value)) throw new Error('invalid_property_schema');
      checkSchema(value, depth + 1);
    }
  } else if (schema.properties !== undefined || schema.required !== undefined || schema.additionalProperties !== undefined) throw new Error('invalid_object_keywords');
  if (schema.type === 'array') {
    if (!isObject(schema.items)) throw new Error('schema_requires_items');
    checkSchema(schema.items, depth + 1);
  } else if (schema.items !== undefined) throw new Error('invalid_array_keywords');
}
export function isObject(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
export function matchesSchema(value: unknown, schema: JsonSchema): boolean {
  if (schema.enum && !(schema.enum as unknown[]).some(item => item === value)) return false;
  switch (schema.type) {
    case 'null': return value === null;
    case 'string': return typeof value === 'string';
    case 'boolean': return typeof value === 'boolean';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'integer': return typeof value === 'number' && Number.isSafeInteger(value);
    case 'array': return Array.isArray(value) && value.every(item => matchesSchema(item, schema.items as JsonSchema));
    case 'object': {
      if (!isObject(value)) return false;
      const properties = schema.properties as Record<string, JsonSchema>;
      return Object.keys(value).every(key => Object.hasOwn(properties, key))
        && Object.entries(properties).every(([key, child]) => Object.hasOwn(value, key) && matchesSchema(value[key], child));
    }
    default: return false;
  }
}
export function parseInvocation(value: unknown): InvocationRequest {
  const result = invocationRequest.parse(value);
  if (JSON.stringify(result.outputSchema).length > 32_000) throw new Error('schema_too_large');
  checkSchema(result.outputSchema);
  return result;
}
