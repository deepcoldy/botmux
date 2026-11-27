import { afterEach, expect, it, vi } from 'vitest';
import { createServer, request as httpRequest } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BytedcliExecutor } from '../src/core/bytedcli-executor.js';
import { createBytedcliHostApiRunner } from '../src/core/bytedcli-skill-api-transport.js';
import { parseBytedcliOperation } from '../src/core/bytedcli-operation-policy.js';
const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });
it.each(['success', 'redirect', 'too-large', 'stale'])('fixed HTTP fake traverses actual executor boundaries: %s', async mode => {
 const seen: any[] = [], audits: any[] = []; let current = true;
 const server = createServer((req,res) => {
  let body='';req.on('data', chunk=>body+=chunk);req.on('end',()=>{
   seen.push({method:req.method,path:req.url,headers:req.headers,body:JSON.parse(body)});
   if(mode==='redirect'){res.writeHead(302,{location:'https://untrusted.invalid'});res.end();}
   else if(mode==='too-large')res.end('x'.repeat(8192));
   else {if(mode==='stale')current=false;res.end(JSON.stringify({code:0,data:{value:'lease-secret',authorization:'unsafe'}}));}
  });
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const port=(server.address() as any).port;
 const root=mkdtempSync(join(tmpdir(),'skill-http-'));roots.push(root);
 const urls:string[]=[], proxies:string[]=[];
 const transport:any=(url:string,options:any,callback:any)=>{urls.push(url);proxies.push(options.agent.getProxyForUrl(url));
  return httpRequest({hostname:'127.0.0.1',port,path:new URL(url).pathname,method:options.method,headers:options.headers,signal:options.signal},callback);};
 const hostApi=createBytedcliHostApiRunner({HTTPS_PROXY:'http://frozen.test:8080'},()=>current,transport);
 vi.stubEnv('HTTPS_PROXY','http://evil.test:9');
 const lease:any={jwt:'lease-secret',kind:'actor',region:'cn',source:'local',accountFingerprint:'sha256:actor',expiresAt:Date.now()+120000,stillCurrent:async()=>undefined};
 const executor=new BytedcliExecutor({privateRoot:root,trustedCli:async()=>{throw new Error('native forbidden');},leases:{actor:async()=>lease,machine:async()=>lease},audit:{append:async row=>{audits.push(row);}},hostApi});
 try {
  const parsed=parseBytedcliOperation(['--json','skill-api','bits.release.owner.update','--request','{"ticketId":"123","version":"1","releaseApprovers":["alice"]}']);
  const operation={...parsed,outputLimitBytes:4096};
  const request:any={requestId:'request',operation,authority:{daemonBootId:'b',botAppId:'a',sessionId:'s',turnId:'t',workerGeneration:1,dispatchAttempt:1,policyFingerprint:'p',actor:{verifiedEmail:'a@fake.test',credentialOpenId:'ou_a',source:'local'},recheck:async()=>undefined}};
  const result=await executor.execute(request);
  expect(result.outcome).toBe(mode==='success'?'completed':'write_outcome_unknown');
  expect(audits[0]).toMatchObject({phase:'intent',effect:'write'});
  expect(seen).toHaveLength(1);expect(seen[0]).toMatchObject({method:'PUT',path:'/api/v1/cd/release_ticket/123',body:{version:'1',releaseApprovers:['alice']}});
  expect(urls).toEqual(['https://bits.bytedance.net/api/v1/cd/release_ticket/123']);expect(proxies).toEqual(['http://frozen.test:8080']);
  expect(Buffer.from(result.stdoutBase64,'base64').toString()).not.toContain('lease-secret');
  await executor.execute(request);expect(seen).toHaveLength(1);
 }finally{await executor.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
