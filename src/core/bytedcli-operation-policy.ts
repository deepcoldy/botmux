import {
  BYTEDCLI_EXEC_LIMITS, decodeBytedcliBase64, parseBytedcliExecInputs, validateBytedcliArgv,
  type BytedcliExecInputs,
} from '../cli/bytedcli-exec-protocol.js';

import {
  BYTEDCLI_AUDITED_RELEASE, BYTEDCLI_OPERATION_CATALOG_VERSION, BYTEDCLI_OPERATION_GRAMMAR,
  type BytedcliFlagValidator, type BytedcliGrammarFlag, type BytedcliGrammarEntry,
  type BytedcliOperationEffect, type BytedcliOperationRegion,
} from './bytedcli-operation-catalog.js';
export {
  BYTEDCLI_AUDITED_RELEASE, BYTEDCLI_OPERATION_CATALOG_VERSION, BYTEDCLI_OPERATION_CATALOG,
  type BytedcliOperationCatalogEntry, type BytedcliOperationEffect, type BytedcliOperationRegion,
} from './bytedcli-operation-catalog.js';

export interface BytedcliStagedInput {
  readonly id: string;
  readonly flag: '--body-file';
  readonly argvIndex: number;
  readonly dataBase64: string;
  readonly encoding: 'utf8';
}
export interface BytedcliOperation {
  readonly id: string;
  readonly effect: BytedcliOperationEffect;
  readonly argv: readonly string[];
  readonly region: BytedcliOperationRegion;
  readonly resources: Readonly<Record<string, string>>;
  readonly stagedInputs: readonly BytedcliStagedInput[];
  readonly cliVersion: typeof BYTEDCLI_AUDITED_RELEASE;
  readonly catalogVersion: typeof BYTEDCLI_OPERATION_CATALOG_VERSION;
  readonly timeoutMs: number;
  readonly outputLimitBytes: number;
  readonly inputLimitBytes: number;
  readonly outputPolicy: 'credential-redaction';
}
export class BytedcliOperationPolicyError extends Error {
  readonly code: 'unsupported_operation' | 'unsupported_cli_version';
  constructor(code: 'unsupported_operation' | 'unsupported_cli_version' = 'unsupported_operation') {
    super(code === 'unsupported_cli_version' ? 'Unaudited bytedcli release' : 'Operation or argument combination is not audited');
    this.name = 'BytedcliOperationPolicyError'; this.code = code;
  }
}
function deny(): never { throw new BytedcliOperationPolicyError(); }
export function assertBytedcliAuditedRelease(release: string): void {
  if (release !== BYTEDCLI_AUDITED_RELEASE) throw new BytedcliOperationPolicyError('unsupported_cli_version');
}

type Validator = (value: string) => boolean;
interface Flag extends BytedcliGrammarFlag { readonly valid: Validator }
interface Entry extends Omit<BytedcliGrammarEntry, 'flags'> { readonly flags: readonly Flag[] }
function compileValidator(spec: BytedcliFlagValidator): Validator {
  const bounded = (max: number): Validator => value => value.length > 0 && value.trim() === value && Buffer.byteLength(value) <= max;
  switch (spec.kind) {
    case 'bounded': return bounded(spec.maxBytes);
    case 'integer': return value => /^(?:0|[1-9]\d*)$/.test(value) && Number.isSafeInteger(Number(value))
      && Number(value) >= spec.min && Number(value) <= spec.max;
    case 'choice': return value => spec.values.includes(value);
    case 'pattern': { const pattern = new RegExp(spec.source); return value => pattern.test(value); }
    case 'branch': { const withinLimit = bounded(spec.maxBytes);
      return value => withinLimit(value) && /^[A-Za-z0-9_][A-Za-z0-9_./-]*$/.test(value)
        && !value.includes('..') && !value.includes('//') && !value.endsWith('/') && !value.endsWith('.lock'); }
    case 'relative-resource': { const withinLimit = bounded(spec.maxBytes);
      return value => withinLimit(value) && !value.startsWith('/') && !value.split('/').includes('..'); }
    case 'all': { const validators = spec.validators.map(compileValidator); return value => validators.every(valid => valid(value)); }
    case 'any': { const validators = spec.validators.map(compileValidator); return value => validators.some(valid => valid(value)); }
    case 'split': { const valid = compileValidator(spec.validator); return value => value.split(spec.separator).every(valid); }
  }
}
const compileFlag = (flag: BytedcliGrammarFlag): Flag => ({ ...flag, valid: compileValidator(BYTEDCLI_OPERATION_GRAMMAR.validators[flag.validator]!) });
const entries: readonly Entry[] = BYTEDCLI_OPERATION_GRAMMAR.entries.map(entry => ({ ...entry, flags: entry.flags.map(compileFlag) }));
const common = BYTEDCLI_OPERATION_GRAMMAR.commonFlags.map(compileFlag);
const positionalValidators = {
  repo: compileValidator(BYTEDCLI_OPERATION_GRAMMAR.validators[BYTEDCLI_OPERATION_GRAMMAR.positionalValidators.repo]!),
  mr: compileValidator(BYTEDCLI_OPERATION_GRAMMAR.validators[BYTEDCLI_OPERATION_GRAMMAR.positionalValidators.mr]!),
};
const boolean: Validator = value => value === 'true' || value === 'false';

interface Parsed { words: string[]; values: Map<string, string[]>; flags: readonly Flag[] }
function parseTokens(argv: readonly string[], entry: Entry): Parsed {
  // A command-local --version takes precedence over the root version flag.
  const flags = [...entry.flags, ...common.filter(global => !entry.flags.some(local => local.name === global.name))];
  const values = new Map<string, string[]>(); const words: string[] = [];
  let separator = false;
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]!;
    if (!separator && token === '--') { separator = true; continue; }
    if (separator || !token.startsWith('-')) { words.push(token); continue; }
    const equal = token.indexOf('='); const name = equal < 0 ? token : token.slice(0, equal);
    const spec = flags.find(f => f.name === name || f.aliases?.includes(name));
    if (!spec) deny();
    if (values.has(spec.name) && !spec.repeat) deny();
    let raw: string;
    if (spec.arity === 'flag') {
      if (equal >= 0) deny(); raw = 'true';
    } else if (equal >= 0) raw = token.slice(equal + 1);
    else if (spec.arity === 'optional-boolean') {
      const next = argv[index + 1];
      if (next !== undefined && boolean(next)) { raw = next; index++; } else raw = 'true';
    } else {
      const next = argv[++index];
      if (next === undefined || (next.startsWith('-') && !(spec.name === '--body-file' && next === '-'))) deny();
      raw = next;
    }
    const list = spec.repeat ? raw.split(',').map(part => part.trim()) : [raw];
    if (list.some(item => !spec.valid(item))) deny();
    values.set(spec.name, [...(values.get(spec.name) ?? []), ...list]);
  }
  return { words, values, flags };
}
function paths(entry: Entry): readonly (readonly string[])[] {
  return [entry.path, ...entry.aliases];
}
function result(id: string, effect: BytedcliOperationEffect, argv: string[], resources: Record<string, string>,
  stagedInputs: BytedcliStagedInput[] = []): BytedcliOperation {
  return Object.freeze({ id, effect, argv: Object.freeze(argv), region: 'cn', resources: Object.freeze(resources),
    stagedInputs: Object.freeze(stagedInputs.map(input => Object.freeze(input))), cliVersion: BYTEDCLI_AUDITED_RELEASE,
    catalogVersion: BYTEDCLI_OPERATION_CATALOG_VERSION, timeoutMs: BYTEDCLI_EXEC_LIMITS.defaultTimeoutMs,
    outputLimitBytes: BYTEDCLI_EXEC_LIMITS.outputBytes, inputLimitBytes: BYTEDCLI_EXEC_LIMITS.inputBytes,
    outputPolicy: 'credential-redaction' });
}
function buildOperation(entry: Entry, parsed: Parsed, rest: string[], inputs: BytedcliExecInputs): BytedcliOperation {
  const values = parsed.values;
  if (rest.length > (entry.positional ? 1 : 0)) deny();
  if (rest.length) {
    const key = entry.positional === 'repo' ? '--repo' : '--mr';
    const valid = positionalValidators[entry.positional!];
    if (!valid(rest[0]!) || values.has(key)) deny(); values.set(key, [rest[0]!]);
  }
  const first = (key: string) => values.get(key)?.[0];
  if (entry.repo && BYTEDCLI_OPERATION_GRAMMAR.resourceSelectors.repo.filter(key => values.has(key)).length !== 1) deny();
  if (entry.selector && BYTEDCLI_OPERATION_GRAMMAR.resourceSelectors.mr.filter(key => values.has(key)).length !== 1) deny();
  if (entry.required?.some(key => !values.has(key))) deny();
  if (entry.changes && !entry.changes.some(key => values.has(key))) deny();
  if (BYTEDCLI_OPERATION_GRAMMAR.exclusiveFlags.some(flags => flags.filter(key => values.has(key)).length > 1)) deny();
  const resources: Record<string, string> = {};
  for (const { flag, name } of BYTEDCLI_OPERATION_GRAMMAR.resources) {
    const selected = first(flag); if (selected !== undefined) resources[name] = selected;
  }
  // Fresh argv from validated fields only; no original token is passed through.
  const argv = [...(values.has('--json') ? ['--json'] : []), '--site', 'cn', ...entry.path];
  if (entry.selector && first('--mr')) argv.push(first('--mr')!);
  for (const spec of entry.flags) {
    if (spec.name === '--mr' && entry.selector) continue;
    for (const item of values.get(spec.name) ?? []) {
      if (spec.arity === 'flag') argv.push(spec.name);
      else if (spec.arity === 'optional-boolean' || (item.startsWith('-') && spec.name !== '--body-file')) argv.push(`${spec.name}=${item}`);
      else argv.push(spec.name, item);
    }
  }
  for (const item of entry.defaults ?? []) if (!values.has(item.flag)) argv.push(item.flag, item.value);
  const stagedInputs: BytedcliStagedInput[] = [];
  const fileId = first('--body-file');
  if (fileId !== undefined) {
    const dataBase64 = fileId === '-' ? inputs.stdinBase64 : inputs.files?.find(file => file.id === fileId)?.dataBase64;
    if (dataBase64 === undefined) deny();
    const bytes = decodeBytedcliBase64(dataBase64, BYTEDCLI_EXEC_LIMITS.inputBytes);
    try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { deny(); }
    if (bytes.includes(0)) deny();
    // Stdin is staged as an ordinary immutable file too; never feed a credential
    // file and description through the same stdin stream.
    stagedInputs.push({ id: fileId === '-' ? 'stdin' : fileId, flag: '--body-file',
      argvIndex: argv.indexOf('--body-file') + 1, dataBase64, encoding: 'utf8' });
  }
  if (inputs.stdinBase64 !== undefined && fileId !== '-') deny();
  if (inputs.files?.some(file => file.id !== fileId)) deny();
  return result(entry.id, entry.effect, argv, resources, stagedInputs);
}

/** Closed schema for the reviewed release. Snapshots are base64 wire bytes,
 * never host paths. Auth/help descriptors must use their host adapters rather
 * than generic business CLI execution. */
export function parseBytedcliOperation(argv: readonly string[], inputs?: BytedcliExecInputs): BytedcliOperation {
  const args = validateBytedcliArgv(argv);
  const snapshots = inputs === undefined ? {} : parseBytedcliExecInputs(inputs);
  for (const entry of entries) {
    let parsed: Parsed;
    try { parsed = parseTokens(args, entry); } catch (error) {
      if (error instanceof BytedcliOperationPolicyError) continue; throw error;
    }
    const matched = paths(entry).find(path => path.every((word, index) => parsed.words[index] === word));
    if (!matched) continue;
    if (parsed.values.has('--version') && !entry.flags.some(f => f.name === '--version')) deny();
    if (parsed.values.has('--help')) {
      if (Object.keys(snapshots).length || parsed.words.length !== matched.length) deny();
      return result(`help.${entry.id}`, 'help', [...entry.path, '--help'], {});
    }
    return buildOperation(entry, parsed, parsed.words.slice(matched.length), snapshots);
  }
  const parsed = parseTokens(args, { id: 'help', path: [], aliases: [], effect: 'help', flags: [] });
  const group = BYTEDCLI_OPERATION_GRAMMAR.helpGroups.find(({ path }) => path.length === parsed.words.length && path.every((word, index) => parsed.words[index] === word));
  if (!group || Object.keys(snapshots).length || [...parsed.values.keys()].some(key => !['--help', '--version', '--json', '--site'].includes(key))) deny();
  if (parsed.values.has('--version') && group.path.length > 0) deny();
  const canonicalGroup = group.canonicalPath;
  return result(parsed.values.has('--version') ? 'help.version' : `help.${canonicalGroup.join('.') || 'root'}`,
    'help', parsed.values.has('--version') ? ['--version'] : [...canonicalGroup, '--help'], {});
}
