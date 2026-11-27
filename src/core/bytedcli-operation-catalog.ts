import packagedCatalog from './bytedcli-operation-catalog.json' with { type: 'json' };

export const BYTEDCLI_AUDITED_RELEASE = '0.199.0' as const;
export const BYTEDCLI_OPERATION_CATALOG_VERSION = '2026-11-26.1' as const;
export type BytedcliOperationEffect = 'read' | 'write' | 'auth' | 'help';
/** Only CN was reviewed. Never substitute a default partition for a missing lease. */
export type BytedcliOperationRegion = 'cn';

export type BytedcliFlagValidator =
  | { readonly kind: 'bounded' | 'branch' | 'relative-resource'; readonly maxBytes: number }
  | { readonly kind: 'integer'; readonly min: number; readonly max: number }
  | { readonly kind: 'choice'; readonly values: readonly string[] }
  | { readonly kind: 'pattern'; readonly source: string }
  | { readonly kind: 'all' | 'any'; readonly validators: readonly BytedcliFlagValidator[] }
  | { readonly kind: 'split'; readonly separator: string; readonly validator: BytedcliFlagValidator };
export interface BytedcliGrammarFlag {
  readonly name: string;
  readonly aliases?: readonly string[];
  readonly arity: 'value' | 'flag' | 'optional-boolean';
  readonly validator: string;
  readonly repeat?: boolean;
}
export interface BytedcliGrammarEntry {
  readonly id: string;
  readonly path: readonly string[];
  readonly aliases: readonly (readonly string[])[];
  readonly effect: BytedcliOperationEffect;
  readonly flags: readonly BytedcliGrammarFlag[];
  readonly positional?: 'repo' | 'mr';
  readonly selector?: boolean;
  readonly repo?: boolean;
  readonly required?: readonly string[];
  readonly changes?: readonly string[];
  readonly defaults?: readonly { readonly flag: string; readonly value: string }[];
}
interface BytedcliOperationGrammar {
  readonly schema: 'botmux.bytedcli-operation-catalog.v1';
  readonly cliVersion: typeof BYTEDCLI_AUDITED_RELEASE;
  readonly catalogVersion: typeof BYTEDCLI_OPERATION_CATALOG_VERSION;
  readonly validators: Readonly<Record<string, BytedcliFlagValidator>>;
  readonly commonFlags: readonly BytedcliGrammarFlag[];
  readonly entries: readonly BytedcliGrammarEntry[];
  readonly positionalValidators: Readonly<Record<'repo' | 'mr', string>>;
  readonly resourceSelectors: Readonly<Record<'repo' | 'mr', readonly string[]>>;
  readonly resources: readonly { readonly flag: string; readonly name: string }[];
  readonly exclusiveFlags: readonly (readonly string[])[];
  readonly helpGroups: readonly { readonly path: readonly string[]; readonly canonicalPath: readonly string[] }[];
}
export interface BytedcliOperationCatalogEntry {
  readonly id: string;
  readonly path: readonly string[];
  readonly aliases: readonly (readonly string[])[];
  readonly effect: BytedcliOperationEffect;
  readonly allowedFlags: readonly string[];
  readonly cliVersion: typeof BYTEDCLI_AUDITED_RELEASE;
}

function invalid(): never { throw new Error('Invalid packaged bytedcli operation catalog'); }
function object(raw: unknown, allowed: readonly string[], required: readonly string[] = allowed): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) invalid();
  const rec = raw as Record<string, unknown>;
  if (Object.keys(rec).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(rec, key))) invalid();
  return rec;
}
function strings(raw: unknown, pattern: RegExp, min = 1): string[] {
  if (!Array.isArray(raw) || raw.length < min || raw.length > 256
    || raw.some(value => typeof value !== 'string' || value.length > 1024 || !pattern.test(value))) invalid();
  return raw;
}
const option = /^--[a-z][a-z0-9-]*$/;
const optionAlias = /^(?:--[a-z][a-z0-9-]*|-[A-Za-z])$/;
const word = /^[a-z][a-z0-9-]*$/;
function validateValidator(raw: unknown, depth = 0): void {
  if (depth > 8) invalid();
  const rec = object(raw, ['kind', 'maxBytes', 'min', 'max', 'values', 'source', 'validators', 'separator', 'validator'], ['kind']);
  const closed = (keys: string[]) => object(rec, ['kind', ...keys]);
  switch (rec.kind) {
    case 'bounded': case 'branch': case 'relative-resource':
      closed(['maxBytes']);
      if (!Number.isSafeInteger(rec.maxBytes) || Number(rec.maxBytes) < 1 || Number(rec.maxBytes) > 2 * 1024 * 1024) invalid();
      break;
    case 'integer':
      closed(['min', 'max']);
      if (!Number.isSafeInteger(rec.min) || !Number.isSafeInteger(rec.max) || Number(rec.min) < 0 || Number(rec.max) < Number(rec.min)) invalid();
      break;
    case 'choice': closed(['values']); strings(rec.values, /^[\s\S]+$/); break;
    case 'pattern':
      closed(['source']);
      if (typeof rec.source !== 'string' || rec.source.length > 1024) invalid();
      try { new RegExp(rec.source); } catch { invalid(); }
      break;
    case 'all': case 'any':
      closed(['validators']);
      if (!Array.isArray(rec.validators) || rec.validators.length === 0 || rec.validators.length > 16) invalid();
      rec.validators.forEach(value => validateValidator(value, depth + 1)); break;
    case 'split':
      closed(['separator', 'validator']);
      if (typeof rec.separator !== 'string' || rec.separator.length !== 1) invalid();
      validateValidator(rec.validator, depth + 1); break;
    default: invalid();
  }
}
function validateFlags(raw: unknown, validators: Record<string, unknown>): BytedcliGrammarFlag[] {
  if (!Array.isArray(raw) || raw.length > 64) invalid();
  const names = new Set<string>();
  for (const value of raw) {
    const rec = object(value, ['name', 'aliases', 'arity', 'validator', 'repeat'], ['name', 'arity', 'validator']);
    if (typeof rec.name !== 'string' || !option.test(rec.name)
      || typeof rec.arity !== 'string' || !['value', 'flag', 'optional-boolean'].includes(rec.arity)
      || typeof rec.validator !== 'string' || !Object.hasOwn(validators, rec.validator)
      || (rec.repeat !== undefined && typeof rec.repeat !== 'boolean')) invalid();
    const aliases = rec.aliases === undefined ? [] : strings(rec.aliases, optionAlias);
    for (const name of [rec.name, ...aliases]) { if (names.has(name)) invalid(); names.add(name); }
  }
  return raw as BytedcliGrammarFlag[];
}
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}
/** Only the packaged, reviewed data is accepted; there is no runtime catalog loader. */
function validateCatalog(raw: unknown): BytedcliOperationGrammar {
  const rec = object(raw, ['schema', 'cliVersion', 'catalogVersion', 'validators', 'commonFlags', 'entries',
    'positionalValidators', 'resourceSelectors', 'resources', 'exclusiveFlags', 'helpGroups']);
  if (rec.schema !== 'botmux.bytedcli-operation-catalog.v1' || rec.cliVersion !== BYTEDCLI_AUDITED_RELEASE
    || rec.catalogVersion !== BYTEDCLI_OPERATION_CATALOG_VERSION) invalid();
  if (!rec.validators || typeof rec.validators !== 'object' || Array.isArray(rec.validators)) invalid();
  const validators = rec.validators as Record<string, unknown>;
  if (Object.keys(validators).length === 0 || Object.keys(validators).length > 128
    || Object.keys(validators).some(key => !/^[a-z][a-z0-9-]*$/.test(key))) invalid();
  Object.values(validators).forEach(value => validateValidator(value));
  validateFlags(rec.commonFlags, validators);
  if (!Array.isArray(rec.entries) || rec.entries.length === 0 || rec.entries.length > 64) invalid();
  const ids = new Set<string>(); const paths = new Set<string>();
  for (const rawEntry of rec.entries) {
    const entry = object(rawEntry, ['id', 'path', 'aliases', 'effect', 'flags', 'positional', 'selector', 'repo', 'required', 'changes', 'defaults'],
      ['id', 'path', 'aliases', 'effect', 'flags']);
    if (typeof entry.id !== 'string' || !/^[a-z][a-z0-9.-]{1,127}$/.test(entry.id) || ids.has(entry.id)
      || typeof entry.effect !== 'string' || !['read', 'write', 'auth', 'help'].includes(entry.effect)) invalid();
    ids.add(entry.id);
    const canonical = strings(entry.path, word);
    if (canonical.join('.') !== entry.id || !Array.isArray(entry.aliases) || entry.aliases.length > 16) invalid();
    for (const path of [canonical, ...entry.aliases.map(alias => strings(alias, word))]) {
      const key = path.join('.'); if (paths.has(key)) invalid(); paths.add(key);
    }
    const flags = validateFlags(entry.flags, validators);
    if (entry.positional !== undefined && (typeof entry.positional !== 'string' || !['repo', 'mr'].includes(entry.positional))) invalid();
    for (const key of ['repo', 'selector']) if (entry[key] !== undefined && typeof entry[key] !== 'boolean') invalid();
    for (const key of ['required', 'changes']) {
      if (entry[key] !== undefined && strings(entry[key], option).some(name => !flags.some(flag => flag.name === name))) invalid();
    }
    if (entry.defaults !== undefined) {
      if (!Array.isArray(entry.defaults) || entry.defaults.length > 16) invalid();
      for (const rawDefault of entry.defaults) {
        const item = object(rawDefault, ['flag', 'value']);
        if (typeof item.value !== 'string' || item.value.length > 1024 || !flags.some(flag => flag.name === item.flag)) invalid();
      }
    }
  }
  const positional = object(rec.positionalValidators, ['repo', 'mr']);
  for (const key of Object.values(positional)) if (typeof key !== 'string' || !Object.hasOwn(validators, key)) invalid();
  const selectors = object(rec.resourceSelectors, ['repo', 'mr']);
  Object.values(selectors).forEach(value => strings(value, option));
  if (!Array.isArray(rec.resources) || rec.resources.length > 64) invalid();
  for (const value of rec.resources) {
    const item = object(value, ['flag', 'name']);
    if (typeof item.flag !== 'string' || !option.test(item.flag) || typeof item.name !== 'string' || !/^[A-Za-z][A-Za-z0-9]*$/.test(item.name)) invalid();
  }
  if (!Array.isArray(rec.exclusiveFlags) || rec.exclusiveFlags.length > 64) invalid();
  rec.exclusiveFlags.forEach(value => strings(value, option, 2));
  if (!Array.isArray(rec.helpGroups) || rec.helpGroups.length > 64) invalid();
  for (const value of rec.helpGroups) {
    const item = object(value, ['path', 'canonicalPath']); strings(item.path, word, 0); strings(item.canonicalPath, word, 0);
  }
  return deepFreeze(raw as BytedcliOperationGrammar);
}

export const BYTEDCLI_OPERATION_GRAMMAR = validateCatalog(packagedCatalog);
/** Informational support catalog, derived from the parser's validated grammar. */
export const BYTEDCLI_OPERATION_CATALOG: readonly BytedcliOperationCatalogEntry[] = deepFreeze(
  BYTEDCLI_OPERATION_GRAMMAR.entries.map(entry => ({ id: entry.id, path: entry.path, aliases: entry.aliases,
    effect: entry.effect, allowedFlags: [...entry.flags.map(flag => flag.name), '--json', '--site', '--help'],
    cliVersion: BYTEDCLI_AUDITED_RELEASE })),
);
