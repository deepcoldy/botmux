import { describe, expect, it } from 'vitest';
import { parseBytedcliOperation as parse } from '../src/core/bytedcli-operation-policy.js';
import { parseBytedcliOperationPolicy, resolveBytedcliOperationRule } from '../src/core/bytedcli-operation-policy-config.js';
describe('unknown business operations', () => {
  it.each(['--yes','--debug','-d','--nomask','--color','--no-color','--tls1.2','--http-debug','--all-help','--unrecognized'])('never falls back after an interleaved unapproved boolean %s on a registered path',flag=>{
    for(const group of ['mr','pr'])for(const index of [0,1,2,3]){
      const argv=['codebase',group,'close','1','-R','org/repo'];argv.splice(index,0,flag);
      expect(()=>parse(argv),JSON.stringify(argv)).toThrow();
    }
  });
  it('keeps valid global and resource aliases bound to the denied registered operation',()=>{
    const policy=parseBytedcliOperationPolicy({schema:'botmux.bytedcli-operation-policy.v2',cliVersion:'0.199.0',catalogVersion:'2026-11-27.1',rules:{'codebase.mr.close':'deny'}});
    for(const argv of [['--no-auto-upgrade','codebase','-j','pr','close','1','-R','org/repo'],['--site','cn','codebase','mr','--no-auto-upgrade','--repo-name=org/repo','close','1']]){
      const operation=parse(argv);expect(operation.id).toBe('codebase.mr.close');expect(resolveBytedcliOperationRule(operation.id,policy).enabled).toBe(false);
    }
  });
  it.each([['codebase','--unrecognized','value','mr','close','1','-R','org/repo'],['codebase','mr','--draft','close','1','-R','org/repo']])('rejects ambiguous invalid registered parameters instead of treating their command words as values: %j',(...argv)=>{
    expect(()=>parse(argv as string[])).toThrow();
  });
  it.each([['new-business', 'inspect', '123'], ['api-test', 'rpc-call', 'other.service.api', 'Debug', '--body', '{"scene":"x"}'],
    ['cache', 'execute-command', '--service-id', '15479', '--command', 'HSET', '--args', 'key field value'],
    ['new-business', 'mutate', '--force'], ['new-business', 'mutate', '--force', '--dry-run'],
    ['new-business', 'inspect', '-f', '123'],
    ['tcc', 'config', 'get', 'other.psm.service', 'other-config']])('uses unknown actor with opaque stable ID for %j', (...argv) => {
    const op = parse(argv as string[]);
    expect(op).toMatchObject({ effect: 'unknown', execution: 'isolated-native', resources: {} });
    expect(op.id).toMatch(/^unknown\.[a-f0-9]{64}$/);
    expect(parse(op.argv)).toEqual(op);
    expect(resolveBytedcliOperationRule(op.id)).toMatchObject({ identity: 'actor', effect: 'unknown' });
    expect(() => parseBytedcliOperationPolicy({ schema: 'botmux.bytedcli-operation-policy.v2', cliVersion: op.cliVersion,
      catalogVersion: op.catalogVersion, rules: { [op.id]: 'machine' } })).toThrow();
  });
  it.each([['auth', 'get-bytecloud-jwt-token'], ['profile', 'get'], ['self', 'update'], ['plugin', 'install', 'evil'],
    ['upgrade'], ['db', '+update'], ['mcp', 'serve'], ['new-business', '--profile', 'other'], ['new-business', '--as=app'],
    ['new-business', '--bytecloud-user-jwt-file', '/host'], ['new-business', '--http-header', 'Authorization: secret'],
    ['new-business', '--http-proxy', 'https://evil'], ['new-business', '--jq', '.'],
    ['new-business', '--access-token', 'evil'], ['new-business', '--authorization', 'evil'], ['new-business', '--token-file', 'evil'],
    ['xpa', '--region', 'cn', 'auth', 'get-token'],
    ['codebase', 'mr', 'close', '1', '--repo', 'org/repo', '--profile', 'other'],
    ['codebase', 'mr', 'close', '1', '--repo', 'org/repo', '--unknown'],
  ])('rejects controls or invalid registered parameters: %j', (...argv) => { expect(() => parse(argv as string[])).toThrow(); });
});
