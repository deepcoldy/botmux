import { isObject } from '../constrained-invocation/contract.js';

/** The public schema is kept verbatim in the prompt. It is NOT rewritten to the
 * native closed/all-required output-schema subset. Only this explicit subset
 * is accepted; optional properties and open objects retain their meanings. */
export function checkToolSchema(schema: unknown, depth = 0): asserts schema is Record<string, any> {
  if (!isObject(schema) || depth > 12) throw new Error('unsupported_schema');
  const allowed = ['type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'description',
    'title', 'minimum', 'maximum', 'minItems', 'maxItems', 'minLength', 'maxLength'];
  if (Object.keys(schema).some(k => !allowed.includes(k))) throw new Error('unsupported_schema_keyword');
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (!types.length || new Set(types).size !== types.length || types.some(t => !['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'].includes(t))) throw new Error('unsupported_schema_type');
  for (const k of ['description', 'title']) if (schema[k] !== undefined && typeof schema[k] !== 'string') throw new Error('invalid_schema');
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || !schema.enum.length || schema.enum.some((x: unknown) => x !== null && !['string', 'number', 'boolean'].includes(typeof x)))) throw new Error('unsupported_schema_enum');
  if (types.includes('object')) {
    if (schema.properties !== undefined && !isObject(schema.properties)) throw new Error('invalid_schema');
    const props = schema.properties ?? {};
    if (Object.keys(props).length > 100) throw new Error('schema_too_large');
    if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.some((k: unknown) => typeof k !== 'string' || !Object.hasOwn(props, k)) || new Set(schema.required).size !== schema.required.length)) throw new Error('invalid_schema');
    if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== 'boolean') throw new Error('unsupported_schema');
    for (const child of Object.values(props)) checkToolSchema(child, depth + 1);
  } else if (['properties', 'required', 'additionalProperties'].some(k => k in schema)) throw new Error('invalid_schema');
  if (types.includes('array')) checkToolSchema(schema.items, depth + 1);
  else if ('items' in schema) throw new Error('invalid_schema');
  for (const [keys, applicable] of [
    [['minimum', 'maximum'], types.includes('number') || types.includes('integer')],
    [['minLength', 'maxLength'], types.includes('string')],
    [['minItems', 'maxItems'], types.includes('array')],
  ] as const) {
    for (const k of keys) if (schema[k] !== undefined && (!applicable || !Number.isFinite(schema[k]) || (k !== 'minimum' && k !== 'maximum' && (!Number.isSafeInteger(schema[k]) || schema[k] < 0)))) throw new Error('invalid_schema');
    if (schema[keys[0]] !== undefined && schema[keys[1]] !== undefined && schema[keys[0]] > schema[keys[1]]) throw new Error('invalid_schema');
  }
}

export function matchesToolSchema(value: unknown, schema: Record<string, any>): boolean {
  if (schema.enum && !schema.enum.some((v: unknown) => v === value)) return false;
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  return types.some((type: string) => {
    switch (type) {
      case 'null': return value === null;
      case 'boolean': return typeof value === 'boolean';
      case 'string': return typeof value === 'string' && [...value].length >= (schema.minLength ?? 0) && [...value].length <= (schema.maxLength ?? Infinity);
      case 'number': case 'integer': return typeof value === 'number' && Number.isFinite(value) && (type !== 'integer' || Number.isInteger(value)) && value >= (schema.minimum ?? -Infinity) && value <= (schema.maximum ?? Infinity);
      case 'array': return Array.isArray(value) && value.length >= (schema.minItems ?? 0) && value.length <= (schema.maxItems ?? Infinity) && value.every(x => matchesToolSchema(x, schema.items));
      case 'object': {
        if (!isObject(value)) return false;
        const props = schema.properties ?? {};
        return (schema.required ?? []).every((k: string) => Object.hasOwn(value, k))
          && Object.entries(value).every(([k, v]) => Object.hasOwn(props, k) ? matchesToolSchema(v, props[k]) : schema.additionalProperties !== false);
      }
      default: return false;
    }
  });
}
