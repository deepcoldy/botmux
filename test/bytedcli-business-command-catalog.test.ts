import { describe, expect, it } from 'vitest';
import { parseBytedcliOperation as parse, BYTEDCLI_OPERATION_CATALOG } from '../src/core/bytedcli-operation-policy.js';
import { parseBytedcliOperationPolicy, resolveBytedcliOperationRule } from '../src/core/bytedcli-operation-policy-config.js';

const rpc = (psm: string, method: string, body: object, ticket = false) => ['api-test', 'rpc-call', psm, method,
  '--idl-source', psm.endsWith('udc_picko_service') ? 'branch' : 'bam', '--idl-version', psm.endsWith('udc_picko_service') ? 'master' : '1.2.3',
  '--idc', 'lf', '--env', 'prod', '--cluster', 'default', '--zone', 'CN', '--body', JSON.stringify(body),
  ...(ticket ? ['--create-permission-ticket', '--permission-role', 'brn::iam:::role:ms.interface_tester_func.cn', '--permission-reason', '诊断'] : [])];

export const businessCases: [string, 'read' | 'write', string[]][] = [
  ['tcc.config.get.picko-rules', 'read', ['tcc', 'config', 'get', 'ecom.market.udc_dump', 'rule_list_config_PRODUCT_new', '--dir', '/dump_v2', '--region', 'CN', '--env', 'prod']],
  ['rds.db.query', 'read', ['rds', 'query-db', 'ecom_market_pick', 'SELECT COUNT(*) AS cnt FROM pick_package WHERE status = 1;', '-r', 'cn']],
  ['cache.execute-command.picko-hget', 'read', ['cache', 'execute-command', '--service-id', '15479', '--command', 'HGET', '--args', 'ecom_activity_product_123 456']],
  ['bam.method.get', 'read', ['bam', 'method', 'get', '--psm', 'ecom.market.udc_dump', '--method', 'Debug', '--ep-type', 'rpc', '--cluster', 'default', '--schema', 'ref']],
  ['api-test.rpc-call.picko-troubleshoot', 'write', rpc('ecom.market.udc_dump', 'PickoTroubleShoot', { scene: 'manual_check', picko_id: '123', entity_id: '456' })],
  ['api-test.rpc-call.picko-troubleshoot-ticket', 'write', rpc('ecom.market.udc_dump', 'PickoTroubleShoot', { scene: 'manual_check', picko_id: '123', entity_id: '456' }, true)],
  ['api-test.rpc-call.picko-size', 'read', rpc('ecom.market.udc_dump', 'Debug', { debug_scene: 'picko_size', picko_id: '123' })],
  ['api-test.rpc-call.picko-size-ticket', 'write', rpc('ecom.market.udc_dump', 'Debug', { debug_scene: 'picko_size', picko_id: '123' }, true)],
  ['api-test.rpc-call.picko-is-online', 'read', rpc('ecom.market.udc_dump', 'Debug', { debug_scene: 'picko_is_online', picko_id: '123' })],
  ['api-test.rpc-call.picko-export-pids', 'read', rpc('ecom.market.udc_dump', 'Debug', { debug_scene: 'export_pids', flush_id: 123 })],
  ['api-test.rpc-call.picko-user-email', 'read', rpc('ecom.market.udc_picko_service', 'Debug', { debug_scene: 'get_lark_email_by_user_id', record_id: '123' })],
  ['api-test.rpc-call.assign-info', 'read', rpc('ecom.search.assign_manager', 'GetAssignInfo', { assign_id: 123 })],
  ['api-test.http-call.picko-tag-enum', 'read', ['api-test', 'http-call', 'ecom.market.udc_picko', '--http-path', '/ecom/market/udc/picko/api/list_tag_enum_values', '--http-method', 'POST', '--env', 'prod', '--idc', 'lf', '--cluster', 'default', '--zone', 'CN', '--body', '{"tag_id":"123"}']],
  ['tce.service.get', 'read', ['tce', 'service', 'get', '--psm', 'ecom.market.udc_dump']],
  ['tce.service.search', 'read', ['tce', 'service', 'search', '-k', 'udc_dump']],
  ['scm.repo.search', 'read', ['scm', 'repo', 'search', 'market/udc_dump']],
  ['log.get-logid-log', 'read', ['log', 'get-logid-log', '202609051434209A7ACC2DD0F8D626C99C', '--vregion', 'China-North']],
  ['log.search-psm-log', 'read', ['log', 'search-psm-log', '--psm', 'ecom.market.udc_dump', '--start', '2026-11-27T10:00:00+08:00', '--end', '2026-11-27T10:05:00+08:00', '--keyword', '123', '--max-logs', '200', '--output', 'console']],
  ['iam.permission.apply.check-only', 'read', ['iam', 'permission', 'apply', '--permission', 'argos.streamlog.view', '--psm', 'ecom.market.udc_dump', '--reason', '诊断', '--check-only']],
  ['iam.permission.apply.submit', 'write', ['iam', 'permission', 'apply', '--permission', 'argos.streamlog.view', '--psm', 'ecom.market.udc_dump', '--role', 'argos.viewer.cn', '--reason', '诊断', '--yes']],
  ['slardar.web.chat.check-auth', 'read', ['slardar', 'web', 'chat', 'check-auth']],
  ['slardar.web.chat.get', 'read', ['slardar', 'web', 'chat', 'get', '--thread-id', 'thread-123']],
  ['slardar.web.chat.send', 'write', ['slardar', 'web', 'chat', 'send', '--input', '查询页面异常', '--stream']],
  ['libra.layer.get', 'read', ['libra', 'layer', 'get', '--layer-id', '123']],
  ['libra.experiment.list', 'read', ['libra', 'experiment', 'list', '--app-id', '123', '--layer-id', '456', '--page-size', '100']],
  ['libra.experiment.get-batch', 'read', ['libra', 'experiment', 'get-batch', '--flight-id', '123']],
  ['bits.release.search', 'read', ['bits', 'release', 'search', '--workspace-id', '123', '--name', '发布计划', '--page', '1', '--page-size', '20']],
  ['bits.pipeline', 'read', ['bits', 'pipeline', '123', '--run-seq', '2']],
  ['bits.develop.get', 'read', ['bits', 'develop', 'get', '--dev-id', '123', '--space-id', '456']],
  ['bits.pipelines.vars', 'read', ['bits', 'pipelines', 'vars', '--pipeline-id', '123']],
  ['bits.pipelines.run', 'write', ['bits', 'pipelines', 'run', '--pipeline-id', '123', '--vars', '{"branch":"master"}', '--yes']],
  ['slardar.web.data.list.mix-profile', 'read', ['slardar', 'web', 'data', 'list', '--origin', 'https://slardar.bytedance.net', '--bid', 'mix_h5', '--env', 'production', '--site-type', 'web', '--ev-type', 'view', '--start-time', '1795744800', '--end-time', '1795745100', '--filter-conditions-json', '{"type":"and","children":[{"type":"expression","field":"user_id","op":"eq","values":["123"]}]}', '--metrics-json', '["timestamp","user_id"]', '--page-size', '20', '--order', 'asc']],
  ['slardar.web.analyze-url', 'read', ['slardar', 'web', 'analyze-url', '--url', 'https://slardar.bytedance.net/node/web?bid=mix_h5']],
  ['bits.anywhere.share.get', 'read', ['bits', 'anywhere', 'share', 'get', '--url', 'https://bits.bytedance.net/anywheredoor/proxy/share?appId=123&_proxy_share_item_id=456&env=1']],
  ['codebase.repo.file', 'read', ['codebase', 'repo', 'file', 'src/main.ts', '-R', 'org/repo', '--revision', 'master']],
];
describe('selected business signatures', () => {
  it.each(businessCases)('%s preserves effect and canonical isolated execution', (id, effect, argv) => {
    const op = parse(argv);
    expect(op).toMatchObject({ id, effect, execution: 'isolated-native', stagedInputs: [] });
    expect(parse(op.argv)).toEqual(op);
    expect(BYTEDCLI_OPERATION_CATALOG.find(row => row.id === id)?.effect).toBe(effect);
    expect(resolveBytedcliOperationRule(id).identity).toBe(effect === 'read' ? 'machine' : 'actor');
  });
  it('preserves binary Agent input snapshots for TOS and never reads a host path', () => {
    const argv = ['tos', 'upload-object', '--bucket-id', '20001326', '--key', 'c4_config_checker_res/report.md', '--file', 'agent-file', '--timeout-ms', '30000'];
    const op = parse(argv, { files: [{ id: 'agent-file', dataBase64: 'AP8=' }] });
    expect(op).toMatchObject({ id: 'tos.upload-object.c4-report', effect: 'write', execution: 'isolated-native',
      stagedInputs: [{ flag: '--file', encoding: 'binary', dataBase64: 'AP8=' }] });
    expect(parse(op.argv, { files: [{ id: 'agent-file', dataBase64: 'AP8=' }] })).toEqual(op);
    expect(() => parse(argv)).toThrow();
    expect(() => parse(argv.map(v => v === 'agent-file' ? '/etc/passwd' : v))).toThrow();
  });
  it('rejects malformed recognized signatures without falling back', () => {
    const debug = businessCases.find(([id]) => id === 'api-test.rpc-call.picko-size')![2];
    for (const argv of [
      [...debug, '--http-header', 'X-Auth: bad'],
      debug.map(v => v.startsWith('{') ? '{"debug_scene":"picko_size","picko_id":"123","unexpected":1}' : v),
      debug.map(v => v === 'prod' ? 'ppe' : v),
      ['cache', 'execute-command', '--service-id', '15479', '--command', 'HGET', '--args', 'ecom_activity_product_123 456 extra'],
      ['cache', 'execute-command', '--service-id', '015479', '--command', 'HGET', '--args', 'ecom_activity_product_123 456'],
      ['iam', 'permission', 'apply', '--permission', 'argos.streamlog.view', '--psm', 'ecom.market.udc_dump', '--check-only', '--yes'],
      ['bits', 'pipelines', 'run', '--pipeline-id', '123', '--vars', '{}'],
    ]) expect(() => parse(argv)).toThrow();
  });
  it.each(['SELECT 1; DELETE FROM pick_package', 'SELECT 1 INTO OUTFILE "/tmp/x"', 'SELECT load_file("/etc/passwd")',
    'SELECT malicious_function()', 'SELECT `malicious_function`()', 'SELECT "malicious_function"()', 'SELECT unreviewed.COUNT()', 'SELECT unreviewed . IFNULL (1, 0)',
    'SELECT business_mutator$()', 'SELECT $COUNT()', 'SELECT 123COUNT()', 'SELECT 0xCOUNT()', 'SELECT a$b()',
    'SELECT @x:=1', 'SELECT 1 /*!50000 INTO OUTFILE "/tmp/x" */', 'SELECT 1 FOR UPDATE'])('rejects SQL with effects: %s', sql => {
    expect(() => parse(['rds', 'db', 'query', 'ecom_market_pick', sql, '--region', 'cn'])).toThrow();
  });
  it('keeps dollar and digit-prefixed function text harmless inside SQL literals',()=>{
    const operation=parse(['rds','query-db','ecom_market_pick',"SELECT COUNT(*) FROM pick_package WHERE description = '$COUNT() 123COUNT() business_mutator$()'",'--region','cn']);
    expect(operation).toMatchObject({id:'rds.db.query',effect:'read'});
  });
  it('normalizes only escaped JSON double quotes inside the Skill SQL single-quoted LIKE literal', () => {
    const sql = String.raw`SELECT COUNT(*) AS cnt FROM pick_package WHERE IFNULL(is_test_picko,0)=0 AND op_rules LIKE '%\"column_name\":\"field\"%'`;
    const op = parse(['rds', 'query-db', 'ecom_market_pick', sql, '--region', 'cn']);
    expect(op.effect).toBe('read'); expect(op.argv).toContain(sql.replaceAll('\\"', '"'));
    expect(op.argv).not.toContain(sql); expect(parse(op.argv)).toEqual(op);
    for (const bad of [String.raw`SELECT '\\'`, String.raw`SELECT '\''`, String.raw`SELECT 1 \"`, 'SELECT 未审核函数()']) {
      expect(() => parse(['rds', 'query-db', 'ecom_market_pick', bad, '--region', 'cn'])).toThrow();
    }
  });
  it('only migrates old catalog policies with IDs present in that reviewed catalog', () => {
    const old = { schema: 'botmux.bytedcli-operation-policy.v1', cliVersion: '0.199.0', catalogVersion: '2026-11-26.1', rules: { 'codebase.repo.get': 'machine' } };
    expect(parseBytedcliOperationPolicy(old)?.catalogVersion).toBe('2026-11-27.2');
    expect(() => parseBytedcliOperationPolicy({ ...old, rules: { 'bits.pipeline': 'machine' } })).toThrow();
    expect(() => parseBytedcliOperationPolicy({ ...old, rules: { 'codebase.mr.close': 'machine' } })).toThrow();
    expect(() => parseBytedcliOperationPolicy({ ...old, catalogVersion: '2026-01-01.1' })).toThrow();
  });
  it('projects new group help without executing business argv', () => {
    expect(parse(['api-test', 'rpc-call', '--help'])).toMatchObject({ effect: 'help', execution: 'host-api', id: 'help.api-test.rpc-call' });
    expect(parse(['slardar', 'web', '--help'])).toMatchObject({ effect: 'help', id: 'help.slardar.web' });
    expect(() => parse(['api-test', 'rpc-call', '--body', '{}', '--help'])).toThrow();
  });
});
