import { afterEach, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverSkillMcpRuntime, createSkillMcpRunner } from '../src/core/bytedcli-skill-mcp.js';
import { BytedcliExecutor } from '../src/core/bytedcli-executor.js';
import { parseBytedcliOperation } from '../src/core/bytedcli-operation-policy.js';
const roots:string[]=[];afterEach(()=>roots.splice(0).forEach(root=>rmSync(root,{recursive:true,force:true})));
it('fixed MCP fake runs under native isolation through actual executor with selected lease only',async()=>{
 const root=mkdtempSync(join(tmpdir(),'skill-mcp-'));roots.push(root);
 const pkg=join(root,'proxy'),entry=join(pkg,'dist/index.js');mkdirSync(join(pkg,'dist'),{recursive:true});
 writeFileSync(join(pkg,'package.json'),JSON.stringify({name:'@byted/mcp-proxy',version:'1.3.21',type:'module',bin:{'mcp-proxy':'dist/index.js'}}));
 writeFileSync(entry,`import{createInterface}from'node:readline';import{existsSync}from'node:fs';const r=createInterface({input:process.stdin});r.on('line',line=>{const q=JSON.parse(line);if(!q.id)return;const result=q.id===1?{protocolVersion:'2024-11-05',capabilities:{},serverInfo:{name:'fake',version:'1'}}:{content:[{type:'text',text:JSON.stringify({tool:q.params.name,args:q.params.arguments,credential:process.env.USER_JWT_TOKEN,psm:process.env.MCP_SERVER_PSM,region:process.env.MCP_GATEWAY_REGION,hostVisible:existsSync(${JSON.stringify(join(root,'secret'))})})}]};console.log(JSON.stringify({jsonrpc:'2.0',id:q.id,result}));});`);
 writeFileSync(join(root,'secret'),'host fake secret');
 const runtime=discoverSkillMcpRuntime(pkg,process.execPath);expect(runtime).toBeDefined();
 const lease:any={jwt:'fake-selected-lease',kind:'actor',region:'cn',source:'local',expiresAt:Date.now()+120000,accountFingerprint:'sha256:actor',stillCurrent:async()=>undefined};
 const executor=new BytedcliExecutor({privateRoot:join(root,'private'),trustedCli:async()=>{throw new Error('native CLI not used');},leases:{actor:async()=>lease,machine:async()=>lease},audit:{append:async()=>{}},hostApi:createSkillMcpRunner(runtime,{})});
 try {
  const operation=parseBytedcliOperation(['--json','skill-api','oncall.knowledge.search','--request','{"query":"fake","directory":69}']);
  const result=await executor.execute({requestId:'mcp',operation,authority:{daemonBootId:'b',botAppId:'a',sessionId:'s',turnId:'t',workerGeneration:1,dispatchAttempt:1,policyFingerprint:'p',executionIdentity:'actor',actor:{verifiedEmail:'a@fake.test',credentialOpenId:'ou_a',source:'local'},recheck:async()=>undefined}});
  expect(result.outcome).toBe('completed');const payload=JSON.parse(Buffer.from(result.stdoutBase64,'base64').toString());
  const data=JSON.parse(payload.data.content[0].text);expect(data).toMatchObject({hostVisible:false,credential:'[REDACTED]',psm:'bytedance.mcp.ecom_marketing_rd_platform',region:'CN',tool:'ecom_marketing_rd_platform_retrieval_knowledge',args:{search_condition:{space_ids:[12],leaf_directory_ids:[69],status:[4]}}});
  writeFileSync(entry,readFileSync(entry,'utf8')+'\n// changed');expect(runtime!.stillCurrent()).toBe(false);
 }finally{await executor.close();}
});
