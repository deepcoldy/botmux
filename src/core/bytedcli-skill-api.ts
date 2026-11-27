import { BYTEDCLI_EXEC_LIMITS, decodeBytedcliBase64, type BytedcliExecInputs } from '../cli/bytedcli-exec-protocol.js';
import { SERVICE_SKILL_OPERATIONS, describeServiceSkillApi } from './bytedcli-skill-api-services.js';
/** Packaged final API contracts. No caller-controlled URL, headers or credentials. */
export type SkillCredentialRealm = 'bytecloud' | 'gdpr';
export interface SkillApiDescriptor {
  readonly id: string; readonly effect: 'read' | 'write'; readonly realm: SkillCredentialRealm;
  readonly url: string; readonly method: 'GET' | 'POST' | 'PUT';
  readonly headers: Readonly<Record<string, string>>; readonly body?: unknown;
}
export function rejectSkillApi(): never { throw Object.assign(new Error('Unsupported managed Skill operation'), { code: 'unsupported_operation' }); }
export function closedRecord(value: unknown, keys: readonly string[], optional: readonly string[] = []): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) rejectSkillApi();
  const record = value as Record<string, any>;
  if (Object.keys(record).some(key => !keys.includes(key) && !optional.includes(key)) || keys.some(key => !Object.hasOwn(record, key))) rejectSkillApi();
  return record;
}
export function boundedText(value: unknown, max = 4096): value is string { return typeof value === 'string' && value.length > 0 && value.length <= max && !value.includes('\0'); }
export const positiveId = (value: unknown): value is string => typeof value === 'string' && /^[1-9][0-9]{0,24}$/.test(value);
export const integer = (value: unknown, min: number, max: number): value is number => Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;
const bits = 'https://bits.bytedance.net';
const kibana = 'https://kibana-bytees.bytedance.net';
export const SKILL_API_OPERATIONS = Object.freeze([
  ...SERVICE_SKILL_OPERATIONS,
  { id: 'skill-api.bits.release.get', effect: 'read' as const },
  { id: 'skill-api.bits.release.tasks.list', effect: 'read' as const },
  { id: 'skill-api.bits.release.owner.update', effect: 'write' as const },
  { id: 'es.search.picko-tag-distribution', effect: 'read' as const },
]);
export function validatePickoDistribution(value: unknown): unknown {
  const q = closedRecord(value, ['size', 'query', 'aggs']);
  if (q.size !== 0) rejectSkillApi();
  const filters = closedRecord(closedRecord(q.query, ['bool']).bool, ['filter']).filter;
  if (!Array.isArray(filters) || filters.length !== 2 || closedRecord(closedRecord(filters[0], ['term']).term, ['entity_status']).entity_status !== 6) rejectSkillApi();
  const timestamp = closedRecord(closedRecord(closedRecord(filters[1], ['range']).range, ['entity_end_time']).entity_end_time, ['gt']).gt;
  if (!integer(timestamp, 1, 99_999_999_999)) rejectSkillApi();
  const aggs = closedRecord(q.aggs, [], Object.keys(q.aggs ?? {}));
  const names = Object.keys(aggs);
  if (names.length !== 1 || !boundedText(names[0], 80) || ['__proto__', 'constructor', 'prototype'].includes(names[0]!)) rejectSkillApi();
  const terms = closedRecord(closedRecord(aggs[names[0]!], ['terms']).terms, ['field', 'size']);
  if (terms.size !== 20 || typeof terms.field !== 'string' || !/^[A-Za-z_][A-Za-z0-9_.]{0,127}$/.test(terms.field)) rejectSkillApi();
  return q;
}
export function describeSkillApi(id: string, value: unknown): SkillApiDescriptor {
  const service = describeServiceSkillApi(id, value); if (service) return service;
  const common = { id, realm: 'bytecloud' as const, headers: { accept: 'application/json', 'content-type': 'application/json', origin: bits, referer: `${bits}/` } };
  if (id === 'skill-api.bits.release.get') {
    const r = closedRecord(value, ['ticketId']); if (!positiveId(r.ticketId)) rejectSkillApi();
    return { ...common, effect: 'read', method: 'GET', url: `${bits}/api/v1/cd/release_ticket/${r.ticketId}` };
  }
  if (id === 'skill-api.bits.release.tasks.list') {
    const r = closedRecord(value, ['ticketId', 'workspaceId', 'page']);
    if (!positiveId(r.ticketId) || !positiveId(r.workspaceId) || !integer(r.page, 1, 10000)) rejectSkillApi();
    return { ...common, effect: 'read', method: 'POST', url: `${bits}/api/v1/dev/task/list`, body: {
      conditionGroup: { conditions: [
        { fieldKey: 'spaceId', operator: 'in', vals: [r.workspaceId], junction: 'and' },
        { fieldKey: 'releaseTicket', operator: 'in', vals: [r.ticketId], junction: 'and' },
      ], junction: 'and' },
      fieldKeys: ['title', 'releaseTicket', 'developers', 'state', 'creator', 'codebaseRepo', 'sourceBranch', 'targetBranch'], page: r.page, pageSize: 100,
    } };
  }
  if (id === 'skill-api.bits.release.owner.update') {
    const r = closedRecord(value, ['ticketId', 'version', 'releaseApprovers']);
    if (!positiveId(r.ticketId) || typeof r.version !== 'string' || !/^[0-9]{1,24}$/.test(r.version)
      || !Array.isArray(r.releaseApprovers) || r.releaseApprovers.length !== 1 || typeof r.releaseApprovers[0] !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(r.releaseApprovers[0])) rejectSkillApi();
    return { ...common, effect: 'write', method: 'PUT', url: `${bits}/api/v1/cd/release_ticket/${r.ticketId}`, body: { version: r.version, releaseApprovers: r.releaseApprovers } };
  }
  if (id === 'es.search.picko-tag-distribution') return { id, effect: 'read', realm: 'gdpr', method: 'POST',
    url: `${kibana}/kibana/byte.es.market_pick/lf/api/console/proxy?path=%2Fudc_picko_record%2F_search&method=GET`, body: validatePickoDistribution(value),
    headers: { accept: '*/*', 'content-type': 'application/json', origin: kibana, referer: `${kibana}/kibana/`, 'osd-version': '2.9.0', 'osd-xsrf': 'osd-fetch', 'kbn-xsrf': 'kbn-fetch' } };
  rejectSkillApi();
}
/** Strict JSON serialization gives reparse an immutable, input-bound contract. */
function canonicalJson(value: unknown): string {
  const sort = (v: any): any => Array.isArray(v) ? v.map(sort) : v && typeof v === 'object'
    ? Object.fromEntries(Object.keys(v).sort().map(key => [key, sort(v[key])])) : v;
  return JSON.stringify(sort(value));
}
export function matchSkillApi(rawArgv: readonly string[], inputs: BytedcliExecInputs = {}): { descriptor: SkillApiDescriptor; argv: string[]; stagedRequest?: {id:string;dataBase64:string} } | undefined {
  const argv = rawArgv.flatMap(arg => arg.startsWith('--') && arg.includes('=') ? [arg.slice(0,arg.indexOf('=')),arg.slice(arg.indexOf('=')+1)] : [arg]);
  let root = 0;
  while (root < argv.length) {
    if (['--json','-j','--no-auto-upgrade'].includes(argv[root]!)) root++;
    else if (argv[root] === '--site') root += 2;
    else break;
  }
  if (argv[root] !== 'skill-api' && !(argv[root] === 'es' && argv[root+1] === 'search')) return undefined;
  // Decide applicability before closed parsing; unrelated ES remains actor fallback.
  if (argv[root] === 'es' && (argv[argv.indexOf('--psm')+1] !== 'byte.es.market_pick' || argv[argv.indexOf('--index')+1] !== 'udc_picko_record')) return undefined;
  const words: string[] = []; const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--json' || arg === '-j' || arg === '--no-auto-upgrade') continue;
    if (!arg.startsWith('-')) { words.push(arg); continue; }
    if (!['--request', '--body-file', '--site', '--psm', '--idc', '--index', '--method', '--query', '--size'].includes(arg) || flags.has(arg) || !argv[i + 1]) rejectSkillApi();
    flags.set(arg, argv[++i]!);
  }
  if (flags.has('--site') && flags.get('--site') !== 'cn') rejectSkillApi();
  flags.delete('--site');
  let id: string, raw: string; let stagedRequest: {id:string;dataBase64:string} | undefined;
  if (words[0] === 'skill-api') {
    if (words.length !== 2 || flags.size !== 1 || !flags.has('--request') && !flags.has('--body-file')) rejectSkillApi();
    id = `skill-api.${words[1]}`;
    if (flags.has('--body-file')) {
      const fileId = flags.get('--body-file')!;
      const dataBase64 = fileId === '-' ? inputs.stdinBase64 : inputs.files?.find(file => file.id === fileId)?.dataBase64;
      if (dataBase64 === undefined || inputs.files?.some(file => file.id !== fileId) || fileId !== '-' && inputs.stdinBase64 !== undefined) rejectSkillApi();
      raw = decodeBytedcliBase64(dataBase64, BYTEDCLI_EXEC_LIMITS.inputBytes).toString('utf8');
      stagedRequest = {id:fileId,dataBase64};
    } else raw = flags.get('--request')!;
  } else {
    if (words.join(' ') !== 'es search') return undefined;
    // Other ES destinations retain unknown/actor. The selected destination is closed.
    if (flags.get('--psm') !== 'byte.es.market_pick' || flags.get('--index') !== 'udc_picko_record') return undefined;
    if (flags.size !== 6 || flags.get('--idc') !== 'lf' || flags.get('--method') !== 'GET' || flags.get('--size') !== '0' || !flags.has('--query')) rejectSkillApi();
    id = 'es.search.picko-tag-distribution'; raw = flags.get('--query')!;
  }
  if (!stagedRequest && Object.keys(inputs).length) rejectSkillApi();
  let value: unknown; try { value = JSON.parse(raw); } catch { rejectSkillApi(); }
  const descriptor = describeSkillApi(id, value);
  const args = id.startsWith('skill-api.') ? ['--json', '--site', 'cn', 'skill-api', id.slice(10), ...(stagedRequest ? ['--body-file',stagedRequest.id] : ['--request', canonicalJson(value)])]
    : ['--json', '--site', 'cn', 'es', 'search', '--psm', 'byte.es.market_pick', '--idc', 'lf', '--index', 'udc_picko_record', '--method', 'GET', '--query', canonicalJson(value), '--size', '0'];
  return { descriptor, argv: args, ...(stagedRequest ? {stagedRequest} : {}) };
}
