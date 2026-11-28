/** Reviewed business signatures for bytedcli 0.199.0. This module is also
 * consumed by the browser: no host I/O, credentials or runtime catalog loads. */
type Check = (value: string) => boolean;
type Fields = Readonly<Record<string, Check | true>>;
interface Tokens { readonly words: readonly string[]; readonly values: ReadonlyMap<string, string> }
export interface BytedcliBusinessCommand {
  readonly id: string; readonly path: readonly string[]; readonly aliases: readonly (readonly string[])[];
  readonly effect: 'read' | 'write'; readonly execution: 'isolated-native';
  readonly flags: Fields; readonly required: readonly string[]; readonly positional: readonly Check[];
  readonly matches?: (tokens: Tokens) => boolean; readonly validate?: (tokens: Tokens) => boolean;
  readonly condition: string; readonly inputFlags: readonly string[];
  readonly requiredRuntime?: 'db-cli';
}
const text: Check = value => value.length > 0 && value.length <= 16_384 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
const name: Check = value => /^[A-Za-z0-9][A-Za-z0-9_./:-]{0,255}$/.test(value) && !value.includes('..');
const id: Check = value => /^[1-9]\d{0,19}$/.test(value);
const positive: Check = value => id(value) && Number.isSafeInteger(Number(value));
const count = (max: number): Check => value => positive(value) && Number(value) <= max;
const one = (...values: string[]): Check => value => values.includes(value);
const jsonObject = (value: string): Record<string, unknown> | undefined => {
  try { const parsed: unknown = JSON.parse(value); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined; }
  catch { return undefined; }
};
const object: Check = value => value.length <= 65_536 && !!jsonObject(value);
const exactObject = (raw: string, fields: Record<string, (v: unknown) => boolean>): boolean => {
  const parsed = jsonObject(raw);
  return !!parsed && Object.keys(parsed).length === Object.keys(fields).length
    && Object.entries(fields).every(([key, check]) => Object.hasOwn(parsed, key) && check(parsed[key]));
};
const jsonId = (value: unknown) => typeof value === 'string' && id(value);
const jsonNumber = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const jsonInt64Id = (value: unknown) => jsonId(value) && BigInt(value as string) <= 9223372036854775807n;

/** The RPC transport needs JSON integer tokens for Thrift i64 fields. Preserve
 * their decimal text before JSON.parse can round it; ordinary fields and quoted
 * strings still go through strict JSON parsing and the closed signature below. */
type PickoInt64RpcKind = 'membership' | 'package-info';
function parsePickoInt64RpcBody(raw: string, kind: PickoInt64RpcKind): Record<string, unknown> | undefined {
  if (raw.length > 65_536) return undefined;
  let lossless = '';
  for (let i = 0; i < raw.length;) {
    if (raw[i] === '"') {
      let end = i + 1;
      while (end < raw.length) {
        if (raw[end] === '\\') end += 2;
        else if (raw[end++] === '"') break;
      }
      lossless += raw.slice(i, end); i = end;
    } else if (raw[i] === '-' || /[0-9]/.test(raw[i]!)) {
      const token = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(raw.slice(i))?.[0];
      if (!token) return undefined;
      // Fractional/exponential tokens must stay visible to the ID validator:
      // even a non-integer such as 1.0000000000000001 can round to integer 1.
      lossless += /[.eE]/.test(token) || /^[1-9]\d{15,}$/.test(token) ? JSON.stringify(token) : token;
      i += token.length;
    } else lossless += raw[i++];
  }
  const body = jsonObject(lossless);
  const target = kind === 'membership' ? body?.conditions : body;
  if (target && typeof target === 'object' && !Array.isArray(target)) {
    const fields = target as Record<string, unknown>;
    for (const key of kind === 'membership' ? ['entity_ids', 'picko_ids'] : ['pick_ids']) {
      const ids = fields[key];
      if (Array.isArray(ids)) fields[key] = ids.map(value => typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value);
    }
  }
  return body;
}
/** Called only after the complete reviewed RPC signature has validated its IDs. */
function serializePickoInt64RpcBody(body: Record<string, unknown>, kind: PickoInt64RpcKind): string {
  const conditions = body.conditions as { entity_ids: string[]; picko_ids: string[] };
  const rawIds = kind === 'membership'
    ? `{"entity_ids":[${conditions.entity_ids[0]}],"picko_ids":[${conditions.picko_ids[0]}]}`
    : `[${(body.pick_ids as string[])[0]}]`;
  const idKey = kind === 'membership' ? 'conditions' : 'pick_ids';
  return '{' + Object.entries(body).map(([key, value]) => `${JSON.stringify(key)}:${key === idKey ? rawIds : JSON.stringify(value)}`).join(',') + '}';
}

/** The audited Skill escapes JSON double quotes inside SQL single-quoted
 * strings. Remove only that redundant escape; all other backslashes fail. */
function normalizeSql(sql: string): string | undefined {
  let quote = ''; let result = '';
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i]!;
    if (c === '\\') {
      if (quote !== "'" || sql[i + 1] !== '"') return undefined;
      result += '"'; i++; continue;
    }
    result += c;
    if (quote) {
      if (c === quote) { if (sql[i + 1] === quote) { result += quote; i++; } else quote = ''; }
    } else if (c === "'" || c === '"') quote = c;
  }
  return quote ? undefined : result;
}

/** Conservative SELECT subset for the two reviewed databases. Strip quoted
 * literals, then reject statements, comments, variables and unreviewed calls.
 * Server-side read-only validation remains in the trusted CLI as a second gate. */
export function isBytedcliReadOnlySql(sql: string): boolean {
  const normalized = normalizeSql(sql); if (normalized === undefined) return false; sql = normalized;
  if (/[`\\]/.test(sql) || sql.length > 65_536 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(sql)) return false;
  let code = ''; let quote = '';
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i]!;
    if (quote) {
      if (c === '\\') { i++; continue; }
      if (c === quote) { if (sql[i + 1] === quote) i++; else { quote = ''; code += ' '; } }
    } else if (c === "'" || c === '"' || c === '`') { quote = c; code += '__LITERAL__'; }
    else code += c;
  }
  if (quote || /[^\x20-\x7e\t\r\n]/.test(code) || !/^\s*SELECT\b/i.test(code) || /--|\/\*|\*\/|#|@|:=|\\/.test(code)) return false;
  code = code.trim().replace(/;$/, '');
  if (code.includes(';') || /\b(?:INSERT|UPDATE|DELETE|REPLACE|MERGE|CREATE|ALTER|DROP|TRUNCATE|INTO|OUTFILE|DUMPFILE|LOAD|CALL|EXECUTE|DO|SET|LOCK|UNLOCK|GRANT|REVOKE|FOR|PROCEDURE|HANDLER)\b/i.test(code)) return false;
  const functions = new Set(['COUNT', 'SUM', 'MIN', 'MAX', 'AVG', 'IFNULL', 'COALESCE', 'JSON_EXTRACT', 'JSON_UNQUOTE', 'CAST', 'CONCAT', 'LOWER', 'UPPER', 'SUBSTRING', 'LENGTH', 'IN', 'NOT', 'EXISTS', 'AS', 'AND', 'OR']);
  // A schema-qualified name can select a stored function even when its leaf
  // matches an otherwise safe built-in, e.g. app.COUNT().
  if (/\.\s*[A-Za-z_][A-Za-z0-9_]*\s*\(/.test(code)) return false;
  // MySQL identifiers may start with digits and contain $. Match the entire
  // ASCII token so 123COUNT(), $COUNT() or business_mutator$() cannot be
  // reduced to a whitelisted suffix or skipped by the function scan.
  for (const match of code.matchAll(/([A-Za-z0-9_$]+)\s*\(/g)) if (!functions.has(match[1]!.toUpperCase())) return false;
  return true;
}
const rows: BytedcliBusinessCommand[] = [];
function add(id: string, path: string, effect: 'read' | 'write', flags: Fields = {}, required: readonly string[] = [],
  positional: readonly Check[] = [], extra: Partial<Pick<BytedcliBusinessCommand, 'aliases' | 'matches' | 'validate' | 'condition' | 'inputFlags' | 'requiredRuntime'>> = {}) {
  rows.push({ id, path: path.split(' '), aliases: [], effect, execution: 'isolated-native', flags, required, positional,
    condition: 'Closed arguments; CN; isolated native process', inputFlags: [], ...extra });
}
const get = (tokens: Tokens, flag: string) => tokens.values.get(flag) ?? '';
const bodyOf = (tokens: Tokens) => jsonObject(get(tokens, '--body'));
const route: Fields = { '--idc': one('lf'), '--env': one('prod'), '--cluster': one('default'), '--zone': one('CN') };
const routeRequired = Object.keys(route);
const ticket: Fields = { '--create-permission-ticket': true, '--permission-role': one('brn::iam:::role:ms.interface_tester_func.cn'), '--permission-reason': text };
const rpcFlags: Fields = { ...route, '--idl-source': one('bam', 'branch'), '--idl-version': name,
  '--body': object, '--request-timeout': one('60000'), '--connect-timeout': one('60000'), ...ticket };
function rpc(suffix: string, psm: string, method: string, sceneKey: string | undefined, scene: string | undefined,
  fields: Record<string, (v: unknown) => boolean>, effect: 'read' | 'write',
  idlSource: 'bam' | 'branch' = psm.endsWith('udc_picko_service') ? 'branch' : 'bam') {
  for (const withTicket of [false, true]) {
    add(`api-test.rpc-call.${suffix}${withTicket ? '-ticket' : ''}`, 'api-test rpc-call', withTicket ? 'write' : effect,
      rpcFlags, [...routeRequired, '--idl-source', '--idl-version', '--body', ...(withTicket ? Object.keys(ticket) : [])], [one(psm), one(method)], {
        matches: tokens => tokens.words[2] === psm && tokens.words[3] === method
          && (!sceneKey || !bodyOf(tokens) || bodyOf(tokens)?.[sceneKey] === undefined || bodyOf(tokens)?.[sceneKey] === scene)
          && tokens.values.has('--create-permission-ticket') === withTicket,
        validate: tokens => exactObject(get(tokens, '--body'), { ...fields, ...(sceneKey ? { [sceneKey]: value => value === scene } : {}) })
          && get(tokens, '--idl-source') === idlSource && (idlSource !== 'branch' || get(tokens, '--idl-version') === 'master')
          && (withTicket || !tokens.values.has('--permission-role') && !tokens.values.has('--permission-reason')),
        condition: `${psm}/${method}${scene ? `/${scene}` : ''}; closed JSON; lf/prod/default/CN; permission ticket ${withTicket ? 'required (write)' : 'forbidden'}`,
      });
  }
}
rpc('picko-troubleshoot', 'ecom.market.udc_dump', 'PickoTroubleShoot', 'scene', 'manual_check', { picko_id: jsonId, entity_id: jsonId }, 'write');
rpc('picko-size', 'ecom.market.udc_dump', 'Debug', 'debug_scene', 'picko_size', { picko_id: jsonId }, 'read');
rpc('picko-is-online', 'ecom.market.udc_dump', 'Debug', 'debug_scene', 'picko_is_online', { picko_id: jsonId }, 'read');
rpc('picko-export-pids', 'ecom.market.udc_dump', 'Debug', 'debug_scene', 'export_pids', { flush_id: jsonNumber }, 'read');
rpc('picko-user-email', 'ecom.market.udc_picko_service', 'Debug', 'debug_scene', 'get_lark_email_by_user_id', { record_id: jsonId }, 'read');
rpc('picko-membership', 'ecom.market.udc_picko_service', 'Search', undefined, undefined, {
  biz_code: value => value === 1000,
  entity_type: value => value === 3,
  search_type: value => value === 0,
  conditions: value => exactObject(JSON.stringify(value), {
    entity_ids: ids => Array.isArray(ids) && ids.length === 1 && jsonInt64Id(ids[0]),
    picko_ids: ids => Array.isArray(ids) && ids.length === 1 && jsonInt64Id(ids[0]),
  }),
  time_filter_type: value => value === 0,
  page_type: value => value === 0,
  page_size: value => jsonNumber(value) && (value as number) <= 100,
  page_num: value => jsonNumber(value) && (value as number) <= 1000,
  data_priority: value => value === 0,
  code_list: value => Array.isArray(value) && value.length > 0 && value.length <= 5 && new Set(value).size === value.length
    && value.every(field => ['pick_id', 'entity_id', 'record_id', 'entity_status', 'entity_end_time'].includes(field)),
}, 'read', 'bam');
rpc('picko-package-info', 'ecom.market.udc_picko_service', 'GetPicko', undefined, undefined, {
  pick_ids: ids => Array.isArray(ids) && ids.length === 1 && jsonInt64Id(ids[0]),
  page_size: value => value === 1,
  page_num: value => value === 1,
  no_need_entity_num: value => value === true,
  need_draft: value => value === false,
  biz_code: value => value === 1000,
}, 'read', 'bam');
rpc('assign-info', 'ecom.search.assign_manager', 'GetAssignInfo', undefined, undefined, { assign_id: jsonNumber }, 'read');
add('api-test.http-call.picko-tag-enum', 'api-test http-call', 'read', { ...route, '--http-path': one('/ecom/market/udc/picko/api/list_tag_enum_values'), '--http-method': one('POST'), '--body': object },
  [...routeRequired, '--http-path', '--http-method', '--body'], [one('ecom.market.udc_picko')], {
    matches: tokens => tokens.words[2] === 'ecom.market.udc_picko' && get(tokens, '--http-path') === '/ecom/market/udc/picko/api/list_tag_enum_values',
    validate: tokens => exactObject(get(tokens, '--body'), { tag_id: value => jsonId(value) || jsonNumber(value) }),
    condition: 'ecom.market.udc_picko; POST list_tag_enum_values; only tag_id; lf/prod/default/CN',
  });
add('api-test.http-call.picko-membership', 'api-test http-call', 'read', { ...route, '--http-path': one('/ecom/market/udc/picko/admin/search_from_picko'), '--http-method': one('POST'), '--body': object },
  [...routeRequired, '--http-path', '--http-method', '--body'], [one('ecom.market.udc_picko')], {
    matches: tokens => tokens.words[2] === 'ecom.market.udc_picko' && get(tokens, '--http-path') === '/ecom/market/udc/picko/admin/search_from_picko',
    validate: tokens => exactObject(get(tokens, '--body'), {
      picko_id: jsonInt64Id,
      page_size: value => jsonNumber(value) && (value as number) <= 100,
      page_num: value => jsonNumber(value) && (value as number) <= 1000,
      filter: value => exactObject(JSON.stringify(value), { entity_id: jsonInt64Id }),
    }),
    condition: 'ecom.market.udc_picko; POST search_from_picko; picko_id and one entity_id filter; positive int64 IDs; pages <= 1000, size <= 100; lf/prod/default/CN',
  });
add('tcc.config.get.picko-rules', 'tcc config get', 'read', { '--dir': one('/dump_v2'), '--region': one('CN'), '--env': one('prod') },
  ['--dir', '--region', '--env'], [one('ecom.market.udc_dump'), one('rule_list_config_PRODUCT_new')], {
    matches: tokens => tokens.words[3] === 'ecom.market.udc_dump' && tokens.words[4] === 'rule_list_config_PRODUCT_new',
    condition: 'ecom.market.udc_dump /dump_v2 rule_list_config_PRODUCT_new; CN/prod',
  });
add('rds.db.query', 'rds db query', 'read', { '--region': one('cn') }, ['--region'], [one('ecom_market_pick', 'ecom_search'), isBytedcliReadOnlySql], {
  requiredRuntime: 'db-cli',
  aliases: [['rds', 'query-db']], matches: tokens => ['ecom_market_pick', 'ecom_search'].includes(tokens.words[tokens.words[1] === 'query-db' ? 2 : 3] ?? ''),
  condition: 'ecom_market_pick or ecom_search; one restricted SELECT; cn',
});
add('cache.execute-command.picko-hget', 'cache execute-command', 'read', { '--service-id': one('15479'), '--command': one('HGET'), '--args': value => /^ecom_activity_product_[1-9]\d{0,19} [1-9]\d{0,19}$/.test(value) },
  ['--service-id', '--command', '--args'], [], { matches: tokens => Number(get(tokens, '--service-id')) === 15479 && get(tokens, '--command').toUpperCase() === 'HGET', condition: 'service 15479; HGET ecom_activity_product_<id> <assign_id>' });
add('bam.method.get', 'bam method get', 'read', { '--psm': name, '--method': name, '--ep-type': one('rpc'), '--cluster': one('default'), '--schema': one('ref') }, ['--psm', '--method', '--ep-type', '--cluster', '--schema']);
add('tce.service.get', 'tce service get', 'read', { '--psm': name }, ['--psm']);
add('tce.service.search', 'tce service search', 'read', { '--keyword': text }, ['--keyword']);
add('scm.repo.search', 'scm repo search', 'read', {}, [], [name]);
const vregion = one('China-North', 'China-North6', 'China-East');
const date: Check = value => /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value));
add('log.get-logid-log', 'log get-logid-log', 'read', { '--vregion': vregion }, ['--vregion'], [value => /^[A-Za-z0-9]{16,64}$/.test(value)]);
add('log.search-psm-log', 'log search-psm-log', 'read', { '--psm': name, '--start': date, '--end': date, '--keyword': text, '--max-logs': count(200), '--output': one('console'), '--vregion': vregion },
  ['--psm', '--start', '--end', '--keyword', '--max-logs', '--output'], [], { validate: tokens => {
    const duration = Date.parse(get(tokens, '--end')) - Date.parse(get(tokens, '--start')); return duration > 0 && duration <= 3600_000;
  }, condition: 'finite PSM/time window <= 1 hour; <= 200 logs; console only; CN vregions' });
for (const check of [true, false]) add(`iam.permission.apply.${check ? 'check-only' : 'submit'}`, 'iam permission apply', check ? 'read' : 'write', {
  '--permission': one('argos.streamlog.view'), '--psm': name, '--resource-type': one('psm'), '--resource-value': name,
  '--role': name, '--reason': text, '--check-only': true, '--yes': true,
}, check ? ['--check-only'] : ['--role', '--reason', '--yes'], [], {
  matches: tokens => tokens.values.has('--check-only') === check,
  validate: tokens => !(tokens.values.has('--check-only') && tokens.values.has('--yes'))
    && (get(tokens, '--permission') === 'argos.streamlog.view' && !!get(tokens, '--psm') && !tokens.values.has('--resource-type') && !tokens.values.has('--resource-value')
      || !tokens.values.has('--permission') && !tokens.values.has('--psm') && get(tokens, '--resource-type') === 'psm' && !!get(tokens, '--resource-value') && !!get(tokens, '--role')),
  condition: check ? 'permission argos.streamlog.view + PSM, or explicit PSM role; check-only; no ticket' : 'same PSM permission/role; explicit --yes and reason; creates ticket',
});
add('slardar.web.chat.check-auth', 'slardar web chat check-auth', 'read');
add('slardar.web.chat.get', 'slardar web chat get', 'read', { '--thread-id': name }, ['--thread-id']);
add('slardar.web.chat.send', 'slardar web chat send', 'write', { '--thread-id': name, '--input': text, '--stream': true }, ['--input']);
add('libra.layer.get', 'libra layer get', 'read', { '--layer-id': id }, ['--layer-id']);
add('libra.experiment.list', 'libra experiment list', 'read', { '--app-id': id, '--layer-id': id, '--page-size': count(100) }, ['--app-id', '--layer-id']);
add('libra.experiment.get-batch', 'libra experiment get-batch', 'read', { '--flight-id': id }, ['--flight-id']);
add('tos.upload-object.c4-report', 'tos upload-object', 'write', { '--bucket-id': one('20001326'), '--key': value => /^c4_config_checker_res\/[\p{L}\p{N}_.\/-]+$/u.test(value) && !value.split('/').includes('..'), '--file': value => /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value) || value === '-', '--timeout-ms': one('30000') },
  ['--bucket-id', '--key', '--file', '--timeout-ms'], [], { matches: tokens => Number(get(tokens, '--bucket-id')) === 20001326 && get(tokens, '--key').startsWith('c4_config_checker_res/'),
    condition: 'bucket 20001326; c4_config_checker_res/; Agent file snapshot only', inputFlags: ['--file'] });
add('bits.release.search', 'bits release search', 'read', { '--workspace-id': id, '--name': text, '--status': one('running', 'finished', 'cancel', 'all'), '--page': count(1000), '--page-size': count(100), '--about-me': true, '--raw': true }, ['--workspace-id']);
add('bits.pipeline', 'bits pipeline', 'read', { '--run-seq': id, '--show-ignored': true }, [], [id]);
add('bits.develop.get', 'bits develop get', 'read', { '--dev-id': id, '--space-id': id }, ['--dev-id', '--space-id'], [], {
  condition: 'explicit dev-id/space-id only; no pipeline-id, URL, stage or task, so initTaskIds is unreachable',
});
add('bits.pipelines.vars', 'bits pipelines vars', 'read', { '--pipeline-id': id }, ['--pipeline-id']);
add('bits.pipelines.run', 'bits pipelines run', 'write', { '--pipeline-id': id, '--vars': object, '--yes': true }, ['--pipeline-id', '--vars', '--yes']);
const slardarUrl: Check = value => { try { const url = new URL(value); return url.origin === 'https://slardar.bytedance.net' && !url.username && !url.password; } catch { return false; } };
add('slardar.web.analyze-url', 'slardar web analyze-url', 'read', { '--url': slardarUrl }, ['--url']);
const metrics = new Set(['timestamp', 'user_id', 'device_id', 'session_id', 'release', 'os', 'os_version', 'device_brand', 'device_model',
  'browser_brand', 'browser_version', 'network_type', 'isp', 'url', 'complete_url', 'source', 'context.aid']);
const metricList: Check = value => { try { const parsed: unknown = JSON.parse(value); return Array.isArray(parsed) && parsed.length > 0 && parsed.length <= metrics.size && parsed.every(key => typeof key === 'string' && metrics.has(key)); } catch { return false; } };
const profileFilter: Check = value => exactObject(value, { type: v => v === 'and', children: v => Array.isArray(v) && v.length === 1
  && exactObject(JSON.stringify(v[0]), { type: t => t === 'expression', field: f => f === 'user_id' || f === 'device_id', op: o => o === 'eq', values: ids => Array.isArray(ids) && ids.length === 1 && jsonId(ids[0]) }) });
add('slardar.web.data.list.mix-profile', 'slardar web data list', 'read', {
  '--origin': one('https://slardar.bytedance.net'), '--bid': one('mix_h5'), '--env': one('production'), '--site-type': one('web'), '--ev-type': one('view'),
  '--start-time': positive, '--end-time': positive, '--filter-conditions-json': profileFilter, '--metrics-json': metricList, '--page-size': count(20), '--order': one('asc'),
}, ['--origin', '--bid', '--env', '--site-type', '--ev-type', '--start-time', '--end-time', '--filter-conditions-json', '--metrics-json', '--page-size', '--order'], [], {
  matches: tokens => get(tokens, '--bid') === 'mix_h5' && get(tokens, '--ev-type') === 'view',
  validate: tokens => Number(get(tokens, '--end-time')) > Number(get(tokens, '--start-time')) && Number(get(tokens, '--end-time')) - Number(get(tokens, '--start-time')) <= 3600,
  condition: 'slardar.bytedance.net mix_h5 production web/view; one UID/DID filter; reviewed metrics; <= 1 hour / 20 rows',
});
const mixScope: Fields = { '--origin': one('https://slardar.bytedance.net'), '--bid': one('mix_h5'), '--env': one('production'), '--site-type': one('web') };
add('slardar.web.data.get.mix-profile', 'slardar web data get', 'read', { ...mixScope, '--ev-type': one('view', 'http', 'js_error', 'resource_error', 'custom'), '--dh-key': name },
  [...Object.keys(mixScope), '--ev-type', '--dh-key'], [], { matches: t => get(t, '--bid') === 'mix_h5', condition: 'mix_h5 production web; exact event dh_key; no request overrides' });
add('slardar.web.data.session-list.mix-profile', 'slardar web data session-list', 'read', { ...mixScope, '--session-id': name, '--start-time': positive, '--end-time': positive },
  [...Object.keys(mixScope), '--session-id', '--start-time', '--end-time'], [], { matches: t => get(t, '--bid') === 'mix_h5',
    validate: t => Number(get(t,'--end-time')) > Number(get(t,'--start-time')) && Number(get(t,'--end-time')) - Number(get(t,'--start-time')) <= 3600,
    condition: 'mix_h5 production web; explicit session and <=1 hour; no request overrides or unbounded pagination' });
add('bits.anywhere.share.get', 'bits anywhere share get', 'read', { '--url': value => {
  try { const url = new URL(value); return url.origin === 'https://bits.bytedance.net' && !url.username && !url.password && !url.hash
    && url.pathname === '/anywheredoor/proxy/share' && [...url.searchParams.keys()].length === 3
    && ['appId', '_proxy_share_item_id', 'env'].every(key => url.searchParams.getAll(key).length === 1 && /^\d+$/.test(url.searchParams.get(key)!)); } catch { return false; }
} }, ['--url'], [], { condition: 'fixed Bits Anywheredoor share URL; appId/item/env only; no device/mock actions' });
add('codebase.repo.file', 'codebase repo file', 'read', { '--repo': value => /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value), '--revision': name }, ['--repo', '--revision'],
  [value => name(value) && !value.startsWith('/') && !value.includes(':')]);

function freeze<T>(value: T): T { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
export const BYTEDCLI_BUSINESS_COMMAND_CATALOG: readonly BytedcliBusinessCommand[] = freeze(rows);
const aliases: Readonly<Record<string, string>> = { '-j': '--json', '-r': '--region', '-d': '--dir', '-k': '--keyword', '-R': '--repo' };
const booleans = new Set(['--json', '--no-auto-upgrade', '--help', ...rows.flatMap(row => Object.keys(row.flags).filter(flag => row.flags[flag] === true))]);
export function tokenizeBytedcliBusiness(argv: readonly string[]): Tokens {
  const words: string[] = []; const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]!;
    if (!token.startsWith('-')) { words.push(token); continue; }
    const equal = token.indexOf('='); const rawName = equal < 0 ? token : token.slice(0, equal); const key = aliases[rawName] ?? rawName;
    if (!/^(?:--[a-z][a-z0-9.-]*|-[A-Za-z])$/.test(key) || values.has(key)) throw new Error('unsupported_operation');
    let value: string;
    if (booleans.has(key)) { if (equal >= 0) throw new Error('unsupported_operation'); value = 'true'; }
    else if (equal >= 0) value = token.slice(equal + 1);
    else {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('-') && next !== '-') value = '';
      else { value = next; index++; }
    }
    values.set(key, value);
  }
  return { words, values };
}
export function matchBytedcliBusinessCommand(argv: readonly string[]): { readonly entry: BytedcliBusinessCommand; readonly argv: string[] } | undefined {
  let tokens = tokenizeBytedcliBusiness(argv);
  const candidates = rows.flatMap(entry => [entry.path, ...entry.aliases].filter(path => path.every((word, i) => tokens.words[i] === word))
    .map(path => ({ entry, path })));
  const selected = candidates.find(({ entry }) => !entry.matches || entry.matches(tokens));
  if (!selected) return undefined;
  const { entry, path } = selected;
  const fail = () => { throw new Error('unsupported_operation'); };
  const rpcKind = entry.id === 'api-test.rpc-call.picko-membership' || entry.id === 'api-test.rpc-call.picko-membership-ticket' ? 'membership'
    : entry.id === 'api-test.rpc-call.picko-package-info' || entry.id === 'api-test.rpc-call.picko-package-info-ticket' ? 'package-info' : undefined;
  let rpcBody: Record<string, unknown> | undefined;
  if (rpcKind) {
    rpcBody = parsePickoInt64RpcBody(get(tokens, '--body'), rpcKind) ?? fail();
    tokens = { words: tokens.words, values: new Map(tokens.values).set('--body', JSON.stringify(rpcBody)) };
  }
  if ([...tokens.values.keys()].some(key => !Object.hasOwn(entry.flags, key) && !['--json', '--site', '--no-auto-upgrade'].includes(key))
    || tokens.values.has('--site') && get(tokens, '--site') !== 'cn') fail();
  const positionals = tokens.words.slice(path.length);
  if (entry.id === 'rds.db.query' && positionals[1] !== undefined) positionals[1] = normalizeSql(positionals[1]) ?? fail();
  if (positionals.length !== entry.positional.length || positionals.some((value, i) => !entry.positional[i]!(value))
    || entry.required.some(flag => !tokens.values.has(flag)) || entry.validate && !entry.validate(tokens)) fail();
  const result = [...(tokens.values.has('--json') ? ['--json'] : []), '--site', 'cn', ...entry.path, ...positionals];
  for (const [flag, check] of Object.entries(entry.flags)) {
    if (!tokens.values.has(flag)) continue;
    const value = flag === '--body' && rpcBody && rpcKind ? serializePickoInt64RpcBody(rpcBody, rpcKind) : get(tokens, flag);
    if (check === true) result.push(flag);
    else { if (!check(value)) fail(); result.push(value.startsWith('-') && value !== '-' ? `${flag}=${value}` : flag); if (!value.startsWith('-') || value === '-') result.push(value); }
  }
  return { entry, argv: result };
}

export function matchBytedcliBusinessHelp(argv: readonly string[]): readonly string[] | undefined {
  const tokens = tokenizeBytedcliBusiness(argv);
  if (!tokens.values.has('--help') || [...tokens.values.keys()].some(key => !['--help', '--site', '--json'].includes(key))
    || tokens.values.has('--site') && get(tokens, '--site') !== 'cn') return undefined;
  return rows.some(entry => tokens.words.length > 0 && tokens.words.length <= entry.path.length && tokens.words.every((word, i) => word === entry.path[i])) ? tokens.words : undefined;
}
