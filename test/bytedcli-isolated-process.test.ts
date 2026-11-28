import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createServer } from 'node:http';
import { BytedcliExecutor } from '../src/core/bytedcli-executor.js';
import { BytedcliBroker } from '../src/core/bytedcli-broker.js';
import { resolveBytedcliAuthority } from '../src/core/bytedcli-broker-authority.js';
import { runBytedcliExecClient } from '../src/cli/bytedcli-exec.js';
import { readProcessStartIdentity } from '../src/utils/process-identity.js';
import { parseBytedcliOperation } from '../src/core/bytedcli-operation-policy.js';
import { parseBytedcliOperationPolicy } from '../src/core/bytedcli-operation-policy-config.js';
import { isolateBytedcliInvocation } from '../src/core/bytedcli-isolated-process.js';
import * as systemBwrap from '../src/core/system-bwrap.js';
import { discoverBytedcliDbRuntime } from '../src/core/bytedcli-broker-process.js';
const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe.skipIf(process.platform !== 'linux')('real Linux business isolation', () => {
  it.each([false, true])('passes selected lease and SQL to a frozen DB fixture (hardlinked=%s), rejects tamper before another lease', async hardlinked => {
    const root=mkdtempSync(join(tmpdir(),'bytedcli-db-isolation-'));roots.push(root);
    const install=join(root,'install');mkdirSync(install);const native=join(install,'cli.cjs'),db=join(root,'db-cli'),secret=join(root,'host-secret');
    const node=realpathSync(process.versions.bun?'/usr/bin/node':process.execPath);writeFileSync(secret,'fixture-private');
    writeFileSync(db,`#!${node}\nconst fs=require('node:fs');let visible=false,writable=false;try{fs.readFileSync(${JSON.stringify(secret)});visible=true}catch{}try{fs.writeFileSync(__filename,'tamper');writable=true}catch{}
console.log(JSON.stringify({argv:process.argv.slice(2),selectedLease:process.env.BYTEDCLI_USER_CLOUD_JWT==='fixture-db-jwt',visible,writable,sourceVisible:fs.existsSync(${JSON.stringify(db)}),noUpdate:process.env.BYTEDCLI_DB_NO_AUTO_UPDATE}));`);chmodSync(db,0o700);
    writeFileSync(native,`const fs=require('node:fs'),cp=require('node:child_process'),args=process.argv.slice(2),i=args.indexOf('query');
const jwt=fs.readFileSync(args[args.indexOf('--bytecloud-user-jwt-file')+1],'utf8');
const result=cp.spawnSync(process.env.DB_CLI_BINARY,['sql','execute','--database',args[i+1],'--sql',args[i+2]],{env:{...process.env,BYTEDCLI_USER_CLOUD_JWT:jwt},encoding:'utf8'});
process.stdout.write(result.stdout||'');process.stderr.write(result.stderr||'');process.exit(result.status??1);`);
    const alias=join(root,'package-cache-alias');if(hardlinked)linkSync(db,alias);
    const dbRuntime=discoverBytedcliDbRuntime(db,join(root,'private-code'))!;let leases=0,discoveries=0;
    const executor=new BytedcliExecutor({privateRoot:join(root,'requests'),dbRuntime,trustedCli:async()=>{discoveries++;return {executable:node,prefixArgs:[native],path:dirname(node),protectedPaths:[install,node],version:'0.199.0',stillCurrent:()=>true};},
      leases:{machine:async()=>{leases++;return {kind:'machine',source:'machine',region:'cn',jwt:'fixture-db-jwt',expiresAt:Date.now()+60_000,accountFingerprint:'sha256:db',stillCurrent:async()=>undefined};},actor:async()=>{throw new Error('wrong identity');}},audit:{append:async()=>{}}});
    const operation=parseBytedcliOperation(['rds','query-db','ecom_market_pick','SELECT COUNT(*) FROM pick_package','--region','cn']);
    const authority={daemonBootId:'boot',botAppId:'app',sessionId:'session',turnId:'turn',workerGeneration:1,dispatchAttempt:1,policyFingerprint:'p',recheck:async()=>undefined};
    try {
      const result=await executor.execute({operation,authority,requestId:'db-first'});expect(result.outcome,JSON.stringify(result)).toBe('completed');
      expect(JSON.parse(Buffer.from(result.stdoutBase64,'base64').toString())).toEqual({argv:['sql','execute','--database','ecom_market_pick','--sql','SELECT COUNT(*) FROM pick_package'],selectedLease:true,visible:false,writable:false,sourceVisible:!hardlinked,noUpdate:'1'});
      writeFileSync(hardlinked?alias:db,'changed');expect((await executor.execute({operation,authority,requestId:'db-after-tamper'})).errorCode).toBe('executor_unavailable');
      expect(leases).toBe(1);expect(discoveries).toBe(1);
    } finally {await executor.close();}
  });
  it('refuses missing distro isolation without invoking a bare native runner', () => {
    vi.spyOn(systemBwrap, 'systemBwrapPath').mockReturnValue(undefined);
    expect(() => isolateBytedcliInvocation({ executable: '/usr/bin/true', argv: [], cwd: '/request/cwd', env: { HOME: '/request/home' },
      signal: new AbortController().signal, timeoutMs: 1000, outputLimitBytes: 1000 },
    { executable: '/usr/bin/true', path: '/usr/bin', version: '0.199.0', stillCurrent: () => true }, '/request'))
      .toThrow('executor_unavailable');
  });
  it.each(['actor-unknown', 'machine-write'] as const)('%s sees its own staged bytes but no host or sibling secrets and cannot modify trusted files', async kind => {
    const root = mkdtempSync(join(tmpdir(), 'bytedcli-isolation-')); roots.push(root);
    const install = join(root, 'install'); mkdirSync(install); const privateRoot = join(root, 'requests'); mkdirSync(privateRoot, { mode: 0o700 });
    const secret = join(root, 'host-secret'), sibling = join(privateRoot, 'other-request');
    const policy = join(root, 'host-policy'), fixture = join(install, 'cli.cjs');
    writeFileSync(secret, 'host-secret-DO-NOT-EXPOSE'); writeFileSync(sibling, 'other-request-secret'); writeFileSync(policy, 'policy-original');
    writeFileSync(fixture, `const fs=require('node:fs'); const targets=JSON.parse(process.argv[2]);
const readable=p=>{try{fs.readFileSync(p);return true}catch{return false}};
const writable=p=>{try{fs.writeFileSync(p,'modified');return true}catch{return false}};
const input=process.argv[process.argv.indexOf('--file')+1];
console.log(JSON.stringify({host:readable(targets.secret),sibling:readable(targets.sibling),policy:readable(targets.policy),
hostWrite:writable(targets.secret),policyWrite:writable(targets.policy),installWrite:writable(__filename),
hostProc:readable('/proc/'+targets.pid+'/cmdline'),procRoot:readable('/proc/1/root'+targets.secret),
input:input&&input!=='--site'?fs.readFileSync(input).toString('base64'):null,homeWrite:writable(process.env.HOME+'/scratch')}));`);
    chmodSync(fixture, 0o600);
    const node = realpathSync(process.versions.bun ? '/usr/bin/node' : process.execPath);
    const audit: any[] = []; const providers: string[] = [];
    const lease = (identity: 'machine' | 'actor') => { providers.push(identity); return { kind: identity, source: identity === 'machine' ? 'machine' as const : 'local' as const,
      region: 'cn' as const, jwt: 'fixture-lease-only', expiresAt: Date.now() + 60_000, accountFingerprint: 'sha256:fixture', stillCurrent: async () => undefined }; };
    const executor = new BytedcliExecutor({ privateRoot, trustedCli: async () => ({ executable: node, prefixArgs: [fixture,
      JSON.stringify({ secret, sibling, policy, pid: process.pid })], protectedPaths: [install, join(root, 'absent-node_modules'), node, dirname(node)],
      path: dirname(node), version: '0.199.0', stillCurrent: () => true }),
      leases: { machine: async () => lease('machine'), actor: async () => lease('actor') }, audit: { append: async row => { audit.push(row); } } });
    const argv = kind === 'machine-write' ? ['tos', 'upload-object', '--bucket-id', '20001326', '--key', 'c4_config_checker_res/result.bin', '--file', 'fixture-input', '--timeout-ms', '30000']
      : ['new-business', 'inspect', '--file', 'fixture-input'];
    const operation = parseBytedcliOperation(argv, { files: [{ id: 'fixture-input', dataBase64: 'AP9h' }] });
    const botPolicy = kind === 'machine-write' ? parseBytedcliOperationPolicy({
        schema: 'botmux.bytedcli-operation-policy.v2', cliVersion: operation.cliVersion, catalogVersion: operation.catalogVersion, rules: { [operation.id]: 'machine' },
      }) : undefined;
    const start = readProcessStartIdentity(process.pid)!;
    const ds: any = { session: { sessionId: 'session', status: 'active', backendType: 'pty' }, larkAppId: 'app', chatId: 'chat', workerGeneration: 1,
      worker: { pid: process.pid, killed: false }, localProcessAttestation: { backendType: 'pty', workerGeneration: 1, cliPid: process.pid, cliProcStart: start },
      managedTurnOrigin: { capability: 'ca'.repeat(32), turnId: 'turn', identityTurnId: 'turn', trustedCaller: { senderType: 'user', requestUserOpenId: 'ou_actor' }, preexistingProcessIdentities: [`${process.pid}:${start}`] } };
    let wire: any, lookups = 0;
    const broker = new BytedcliBroker({ authority: (sessionId, peer, op, context) => resolveBytedcliAuthority({ daemonBootId: 'boot', dataDir: root,
      findSession: id => id === 'session' ? ds : undefined, policy: () => ({ enabled: true, tools: ['bytedcli'], bytecloudExecution: 'read-machine-write-actor', credentialSource: 'local', bytedcliOperationPolicy: botPolicy }),
      contains: () => true, canTalk: () => true, identity: async (_app, id) => { lookups++; return { openId: id, type: 'user', email: 'actor@example.test' }; }, unionIdentity: async () => undefined,
      schedule: () => undefined, authEpoch: () => 0, bindingKey: () => undefined }, sessionId, peer, op, context),
      executor: { execute: async request => wire = await executor.execute(request), retireSession: async id => executor.retireSession(id), close: async () => executor.close() } });
    const server = createServer((request, response) => { void broker.handle(request, response); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const inputFile = join(root, 'agent-input'); writeFileSync(inputFile, Buffer.from('AP9h', 'base64'));
    try {
      let stdout = '', stderr = '';
      const code = await runBytedcliExecClient({ sessionId: 'session', requestId: kind, port: (server.address() as { port: number }).port,
        argv: argv.map(value => value === 'fixture-input' ? inputFile : value), stdout: bytes => stdout += bytes, stderr: bytes => stderr += bytes });
      expect(code, stderr).toBe(0);
      expect(wire).toMatchObject({ outcome: 'completed', operationEffect: operation.effect, effectiveIdentity: { kind: kind === 'machine-write' ? 'machine' : 'actor' } });
      expect(JSON.parse(stdout)).toEqual({ host: false, sibling: false, policy: false,
        hostWrite: false, policyWrite: false, installWrite: false, hostProc: false, procRoot: false, input: 'AP9h', homeWrite: true });
      expect(readFileSync(secret, 'utf8')).toBe('host-secret-DO-NOT-EXPOSE'); expect(readFileSync(policy, 'utf8')).toBe('policy-original');
      expect(providers).toEqual([kind === 'machine-write' ? 'machine' : 'actor']);
      expect(audit.map(row => [row.phase, row.effect])).toEqual([['intent', operation.effect], ['result', operation.effect]]);
      expect(lookups > 0).toBe(kind === 'actor-unknown');
    } finally { await broker.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});
