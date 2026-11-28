import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BytedcliExecutor } from '../src/core/bytedcli-executor.js';
import { parseBytedcliOperation } from '../src/core/bytedcli-operation-policy.js';
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
function setup(options: any = {}) {
  const root = mkdtempSync(join(tmpdir(), 'skill-executor-')); roots.push(root);
  const calls: any[] = [], audits: any[] = [];
  const lease = { jwt: 'lease-secret', kind: 'actor', source: 'local', region: 'cn', expiresAt: Date.now() + 100000, accountFingerprint: 'sha256:actor', stillCurrent: async () => undefined };
  const executor = new BytedcliExecutor({ privateRoot: root, trustedCli: async () => { throw new Error('host API cannot run native discovery'); },
    leases: { realm: options.realm, machine: async () => ({ ...lease, kind: 'machine', source: 'machine' }), actor: async () => lease } as any,
    audit: { append: async row => { audits.push(row); if (options.failAudit === row.phase) throw new Error('disk'); } },
    hostApi: async (input: any) => { calls.push(input); input.onDispatch(); if (options.fail) throw new Error('unknown');
      return { stdout: Buffer.from('{"status":"success","data":{"token":"lease-secret","value":"ok"}}'), stderr: Buffer.alloc(0), exitCode: 0 }; },
  } as any);
  const authority: any = { daemonBootId: 'boot', botAppId: 'app', sessionId: 'session', turnId: 'turn', workerGeneration: 1, dispatchAttempt: 1, policyFingerprint: 'policy',
    actor: { verifiedEmail: 'actor@example.test', credentialOpenId: 'ou_actor', source: 'local' }, recheck: async () => undefined };
  const operation = parseBytedcliOperation(['--json', 'skill-api', 'bits.release.owner.update', '--request', JSON.stringify({ ticketId: '123', version: '1', releaseApprovers: ['alice'] })]);
  return { calls, audits, executor, request: { requestId: 'test', operation, authority } };
}
it('host API uses actual executor intent, lease, redaction and dedup without native discovery', async () => {
  const s = setup(); const result = await s.executor.execute(s.request);
  expect(result).toMatchObject({ outcome: 'completed', operationEffect: 'write', effectiveIdentity: { kind: 'actor' } });
  expect(s.audits.map(row => [row.phase, row.effect])).toEqual([['intent', 'write'], ['result', 'write']]);
  expect(s.calls).toHaveLength(1); expect(s.calls[0].lease.jwt).toBe('lease-secret');
  expect(Buffer.from(result.stdoutBase64, 'base64').toString()).not.toContain('lease-secret');
  expect(await s.executor.execute(s.request)).toEqual(result); expect(s.calls).toHaveLength(1);
});
it.each(['intent', 'result'])('host API preserves %s audit failure semantics', async phase => {
  const s = setup({ failAudit: phase }); const result = await s.executor.execute(s.request);
  expect(result).toMatchObject({ outcome: phase === 'intent' ? 'rejected' : 'write_outcome_unknown' });
  expect(s.calls).toHaveLength(phase === 'intent' ? 0 : 1);
});
it('transport failure after dispatch is unknown, retained without retry', async () => {
  const s = setup({ fail: true }); expect(await s.executor.execute(s.request)).toMatchObject({ outcome: 'write_outcome_unknown' });
  await s.executor.execute(s.request); expect(s.calls).toHaveLength(1);
});

it('migrates only frozen previous v2 IDs, never newly added host API authority', async () => {
 const {parseBytedcliOperationPolicy}=await import('../src/core/bytedcli-operation-policy-config.js');
 const old={schema:'botmux.bytedcli-operation-policy.v2',cliVersion:'0.199.0',catalogVersion:'2026-11-27.1'};
 expect(parseBytedcliOperationPolicy({...old,rules:{'tos.upload-object.c4-report':'machine'}})?.catalogVersion).toBe('2026-11-27.2');
 expect(()=>parseBytedcliOperationPolicy({...old,rules:{'skill-api.bits.release.owner.update':'machine'}})).toThrow();
});

it('exact preset proves host machine write; global actor floor refuses the same claim', async () => {
 const {parseBytedcliOperationPolicy}=await import('../src/core/bytedcli-operation-policy-config.js');
 const preset=parseBytedcliOperationPolicy({schema:'botmux.bytedcli-operation-policy.v2',cliVersion:'0.199.0',catalogVersion:'2026-11-27.2',rules:{'skill-api.bits.release.owner.update':'machine'}})!;
 const s=setup();s.request.authority={...s.request.authority,executionIdentity:'machine',operationPolicy:Object.freeze({globalRevision:'fixture',botPolicy:preset})};
 expect(await s.executor.execute(s.request)).toMatchObject({outcome:'completed',effectiveIdentity:{kind:'machine'}});
 const t=setup();t.request.authority={...s.request.authority,operationPolicy:Object.freeze({globalRevision:'floor',botPolicy:preset,globalPolicy:parseBytedcliOperationPolicy({...preset,rules:{'skill-api.bits.release.owner.update':'actor'}})})};
 expect(await t.executor.execute(t.request)).toMatchObject({outcome:'rejected'});expect(t.calls).toHaveLength(0);
});
it('staged MindAI API reaches the same executor as immutable parsed bytes',async()=>{
 const s=setup(),body={name:'chart.png',mimeType:'image/png',dataBase64:Buffer.alloc(90000,1).toString('base64')};
 s.request.operation=parseBytedcliOperation(['skill-api','mindai.attachment.upload','--body-file','input0'],{files:[{id:'input0',dataBase64:Buffer.from(JSON.stringify(body)).toString('base64')}]});
 expect(await s.executor.execute(s.request)).toMatchObject({outcome:'completed',operationEffect:'write'});
 expect(s.calls[0].descriptor.body.attachment.content).toBe('data:image/png;base64,'+body.dataBase64);
 expect(s.audits[0].phase).toBe('intent');
});
it.each(['machine','actor'])('ES resolves only GDPR realm for %s without ByteCloud substitution',async kind=>{
 let realms:any[]=[];const esArgs=()=>['es','search','--psm','byte.es.market_pick','--idc','lf','--index','udc_picko_record','--method','GET','--size','0','--query',JSON.stringify({size:0,query:{bool:{filter:[{term:{entity_status:6}},{range:{entity_end_time:{gt:1800000000}}}]}},aggs:{field:{terms:{field:'is_gift',size:20}}}})];
 const s=setup({realm:async(realm:any,selected:any)=>{realms.push([realm,selected]);if(selected==='actor')throw new Error('no proved personal realm');return {realm:'gdpr',kind:'machine',source:'machine',region:'cn',jwt:'gdpr-only',expiresAt:Date.now()+100000,accountFingerprint:'sha256:gdpr',stillCurrent:async()=>undefined};}});
 s.request.operation=parseBytedcliOperation(esArgs());s.request.authority={...s.request.authority,executionIdentity:kind};
 const result=await s.executor.execute(s.request);expect(realms).toEqual([['gdpr',kind]]);
 expect(result).toMatchObject({outcome:kind==='machine'?'completed':'rejected'});
 expect(s.calls).toHaveLength(kind==='machine'?1:0);
 if(kind==='machine')expect(result.effectiveIdentity).toEqual({kind:'machine',accountFingerprint:'sha256:gdpr'});
});
