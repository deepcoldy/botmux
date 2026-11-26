import {
  BYTEDCLI_EXEC_LIMITS, decodeBytedcliBase64, parseBytedcliExecInputs, validateBytedcliArgv,
  type BytedcliExecInputs,
} from '../cli/bytedcli-exec-protocol.js';

export const BYTEDCLI_AUDITED_RELEASE = '0.199.0' as const;
export const BYTEDCLI_OPERATION_CATALOG_VERSION = '2026-11-26.1' as const;
export type BytedcliOperationEffect = 'read' | 'write' | 'auth' | 'help';
/** Only CN was reviewed. Never substitute a default partition for a missing lease. */
export type BytedcliOperationRegion = 'cn';
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
interface Flag {
  name: string; aliases?: readonly string[]; arity: 'value' | 'flag' | 'optional-boolean';
  valid: Validator; repeat?: boolean;
}
interface Entry {
  id: string; path: readonly string[]; aliases?: readonly (readonly string[])[];
  effect: BytedcliOperationEffect; flags: readonly Flag[];
  positional?: 'repo' | 'mr'; selector?: boolean; repo?: boolean;
  required?: readonly string[]; changes?: readonly string[];
}
const matches = (pattern: RegExp): Validator => value => pattern.test(value);
const bounded = (max: number): Validator => value => value.length > 0 && value.trim() === value && Buffer.byteLength(value) <= max;
const integer = (min: number, max: number): Validator => value => /^(?:0|[1-9]\d*)$/.test(value)
  && Number.isSafeInteger(Number(value)) && Number(value) >= min && Number(value) <= max;
const choice = (...values: string[]): Validator => value => values.includes(value);
const numericId = integer(1, Number.MAX_SAFE_INTEGER);
const repoPath = matches(/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_.-]+)+$/);
const branch: Validator = value => bounded(255)(value) && /^[A-Za-z0-9_][A-Za-z0-9_./-]*$/.test(value)
  && !value.includes('..') && !value.includes('//') && !value.endsWith('/') && !value.endsWith('.lock');
const value = (name: string, valid: Validator, aliases?: readonly string[], repeat = false): Flag =>
  ({ name, valid, aliases, repeat, arity: 'value' });
const flag = (name: string, aliases?: readonly string[]): Flag => ({ name, aliases, arity: 'flag', valid: choice('true') });
const boolean = choice('true', 'false');
const common = [flag('--json', ['-j']), value('--site', choice('cn')), flag('--help', ['-h']), flag('--version', ['-V'])];
const repoFlags = [value('--repo', repoPath, ['-R', '--repo-name']), value('--repo-id', numericId)];
const mrId = value('--mr-id', numericId);
const mrSelector = value('--mr', numericId);
const version = value('--version', integer(1, 10_000));
const pagination = [value('--page', integer(1, 10_000), ['--page-num']), value('--page-size', integer(1, 100), ['-L', '--limit'])];
const mrFilters = [value('--head', branch, ['-H', '--source-branch']), value('--base', branch, ['-B', '--target-branch']),
  value('--author', bounded(128)), value('--reviewer', bounded(128)), value('--title', bounded(1024)),
  value('--milestone-id', numericId, undefined, true), value('--commit', matches(/^[a-fA-F0-9]{7,40}$/)),
  value('--draft', boolean), value('--wip', boolean), value('--review-status', choice('unreviewed', 'approved', 'rejected'))];
const bodyFlags = [value('--body', bounded(32 * 1024), ['--description']),
  value('--body-file', matches(/^(?:-|[A-Za-z0-9][A-Za-z0-9_-]{0,63})$/), ['-F'])];
const entries: readonly Entry[] = [
  { id: 'codebase.repo.get', path: ['codebase', 'repo', 'get'], aliases: [['codebase', 'repo', 'view']],
    effect: 'read', flags: [...repoFlags, flag('--languages')], positional: 'repo', repo: true },
  { id: 'codebase.repo.list', path: ['codebase', 'repo', 'list'], effect: 'read', flags: [
    value('--query', bounded(1024)), value('--page', integer(1, 10_000), ['--page-number']),
    value('--page-size', integer(1, 100)), value('--namespace-id', numericId),
    value('--statuses', value => value.split(',').every(choice('created', 'archived'))),
    value('--sort-by', choice('LastActivityAt', 'Path')), value('--sort-order', choice('Asc', 'Desc')), flag('--has-wiki')] },
  { id: 'codebase.mr.get', path: ['codebase', 'mr', 'get'], aliases: [['codebase', 'mr', 'view']],
    effect: 'read', flags: [...repoFlags, mrId, mrSelector, version], positional: 'mr', selector: true, repo: true },
  { id: 'codebase.mr.list', path: ['codebase', 'mr', 'list'], effect: 'read', repo: true, flags: [
    ...repoFlags, ...mrFilters, ...pagination, value('--state', choice('open', 'merged', 'closed', 'all'), ['-s', '--status']),
    value('--attention', bounded(128)), value('--label', bounded(128), undefined, true),
    value('--sort-by', choice('CreatedAt', 'UpdatedAt')), value('--sort-order', choice('Asc', 'Desc'))] },
  { id: 'codebase.mr.count', path: ['codebase', 'mr', 'count'], effect: 'read', repo: true, flags: [...repoFlags, ...mrFilters] },
  { id: 'codebase.mr.diff', path: ['codebase', 'mr', 'diff'], effect: 'read', repo: true, selector: true, positional: 'mr',
    flags: [...repoFlags, mrId, mrSelector, version,
      value('--file', value => bounded(1024)(value) && !value.startsWith('/') && !value.split('/').includes('..'), undefined, true),
      value('--context', integer(0, 100)), value('--max-patch-bytes', integer(1, 1024 * 1024)), flag('--ignore-whitespace')] },
  { id: 'codebase.mr.files', path: ['codebase', 'mr', 'files'], effect: 'read', repo: true, selector: true, positional: 'mr',
    flags: [...repoFlags, mrId, mrSelector, version] },
  { id: 'codebase.mr.status', path: ['codebase', 'mr', 'status'], effect: 'read', repo: true, selector: true, positional: 'mr',
    flags: [...repoFlags, mrId, mrSelector, value('--page-size', integer(1, 100))] },
  { id: 'codebase.mr.create', path: ['codebase', 'mr', 'create'], effect: 'write', repo: true,
    required: ['--head', '--base', '--title'], flags: [...repoFlags, value('--head', branch, ['--source']),
      value('--base', branch, ['--target']), value('--title', bounded(1024)), ...bodyFlags,
      value('--merge-method', choice('merge_commit', 'rebase_merge')), flag('--draft'), flag('--squash-commits'),
      { name: '--remove-source-branch', arity: 'optional-boolean', valid: boolean },
      value('--merge-commit-message', bounded(4096)), value('--squash-commit-message', bounded(4096)),
      value('--reviewer-ids', value => numericId(value) || matches(/^[A-Za-z0-9_.-]{1,128}$/)(value), undefined, true),
      flag('--no-auto-invite-reviewers')] },
  { id: 'codebase.mr.update', path: ['codebase', 'mr', 'update'], aliases: [['codebase', 'mr', 'edit']],
    effect: 'write', repo: true, selector: true, positional: 'mr',
    changes: ['--title', '--body', '--body-file', '--base', '--draft', '--ready'],
    flags: [...repoFlags, mrId, value('--mr', numericId, ['--number']), value('--title', bounded(1024)),
      ...bodyFlags, value('--base', branch, ['--target']), flag('--draft'), flag('--ready')] },
  ...(['close', 'reopen'] as const).map(action => ({ id: `codebase.mr.${action}`, path: ['codebase', 'mr', action],
    effect: 'write' as const, repo: true, selector: true, positional: 'mr' as const, flags: [...repoFlags, mrId, mrSelector] })),
  { id: 'bits.develop.list', path: ['bits', 'develop', 'list'], effect: 'read', required: ['--space-id'],
    flags: [value('--space-id', numericId), value('--page', integer(1, 10_000)), value('--page-size', integer(1, 100)),
      value('--title', bounded(1024)), value('--about-user', matches(/^[A-Za-z0-9_.-]{1,128}$/)),
      value('--sort', choice('created-at-asc', 'created-at-desc')),
      value('--state', choice('initial', 'opened', 'closed', 'finished'), undefined, true)] },
  { id: 'log.search-log-matchers', path: ['log', 'search-log-matchers'], effect: 'read', required: ['--psm'],
    flags: [value('--psm', matches(/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+){2,}$/)), value('--id', numericId),
      value('--vregion', choice('China-North', 'China-North6')), value('--output', choice('console'))] },
  ...(['status', 'userinfo', 'login', 'logout'] as const).map(action => ({
    id: `auth.${action}`, path: ['auth', action], effect: 'auth' as const, flags: [] })),
];

export interface BytedcliOperationCatalogEntry {
  readonly id: string; readonly path: readonly string[]; readonly aliases: readonly (readonly string[])[];
  readonly effect: BytedcliOperationEffect; readonly allowedFlags: readonly string[];
  readonly cliVersion: typeof BYTEDCLI_AUDITED_RELEASE;
}
/** Informational support catalog. The parser is the authoritative validation. */
export const BYTEDCLI_OPERATION_CATALOG: readonly BytedcliOperationCatalogEntry[] = Object.freeze(entries.map(entry => Object.freeze({
  id: entry.id, path: Object.freeze([...entry.path]),
  aliases: Object.freeze(paths(entry).slice(1).map(path => Object.freeze([...path]))),
  effect: entry.effect, allowedFlags: Object.freeze([...entry.flags.map(f => f.name), '--json', '--site', '--help']),
  cliVersion: BYTEDCLI_AUDITED_RELEASE,
})));

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
  const base = [entry.path, ...(entry.aliases ?? [])];
  // `pr` is a separately registered legacy group using the same handlers.
  return [...base, ...base.filter(path => path[0] === 'codebase' && path[1] === 'mr')
    .map(path => ['codebase', 'pr', ...path.slice(2)])];
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
    const valid = entry.positional === 'repo' ? repoPath : numericId;
    if (!valid(rest[0]!) || values.has(key)) deny(); values.set(key, [rest[0]!]);
  }
  const first = (key: string) => values.get(key)?.[0];
  if (entry.repo && Number(values.has('--repo')) + Number(values.has('--repo-id')) !== 1) deny();
  if (entry.selector && Number(values.has('--mr')) + Number(values.has('--mr-id')) !== 1) deny();
  if (entry.required?.some(key => !values.has(key))) deny();
  if (entry.changes && !entry.changes.some(key => values.has(key))) deny();
  if (values.has('--body') && values.has('--body-file')) deny();
  if (values.has('--draft') && values.has('--ready')) deny();
  const resources: Record<string, string> = {};
  for (const [key, name] of [['--repo', 'repo'], ['--repo-id', 'repoId'], ['--mr', 'mr'], ['--mr-id', 'mrId'],
    ['--dev-id', 'devId'], ['--space-id', 'spaceId'], ['--pipeline-id', 'pipelineId'], ['--psm', 'psm'],
    ['--head', 'head'], ['--base', 'base']] as const) {
    const selected = first(key); if (selected !== undefined) resources[name] = selected;
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
  // Repo get's positional selector has a canonical reviewed flag as well.
  if (entry.id === 'log.search-log-matchers' && !values.has('--output')) argv.push('--output', 'console');
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
  const groups = [[], ['codebase'], ['codebase', 'repo'], ['codebase', 'mr'], ['codebase', 'pr'],
    ['bits'], ['bits', 'develop'], ['log'], ['auth']];
  const parsed = parseTokens(args, { id: 'help', path: [], effect: 'help', flags: [] });
  const group = groups.find(path => path.length === parsed.words.length && path.every((word, index) => parsed.words[index] === word));
  if (!group || Object.keys(snapshots).length || [...parsed.values.keys()].some(key => !['--help', '--version', '--json', '--site'].includes(key))) deny();
  if (parsed.values.has('--version') && group.length > 0) deny();
  const canonicalGroup = group.map(word => word === 'pr' ? 'mr' : word);
  return result(parsed.values.has('--version') ? 'help.version' : `help.${canonicalGroup.join('.') || 'root'}`,
    'help', parsed.values.has('--version') ? ['--version'] : [...canonicalGroup, '--help'], {});
}
