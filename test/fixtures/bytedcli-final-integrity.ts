import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const repo=process.env.FINAL_FIX_SOURCE ?? fileURLToPath(new URL('../..',import.meta.url));
const mode=process.argv[2] ?? 'installation-dependency';
const root=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),'bmx-final-integrity-')));
const {resolveNodeExecutable}=await import(repo+'/test/helpers/ts-runner.ts');
const node=fs.realpathSync(resolveNodeExecutable()!);
const log=(value:unknown)=>console.log(JSON.stringify(value));
try {
  const {bytedcliTrustedHostLayout}=await import(repo+'/src/core/bytedcli-host-layout.ts');
  const {discoverBytedcliTrustedCli,runBoundedBytedcliChild}=await import(repo+'/src/core/bytedcli-broker-process.ts');
  const {BytedcliExecutor}=await import(repo+'/src/core/bytedcli-executor.ts');
  const {BytedcliBrokerAudit}=await import(repo+'/src/core/bytedcli-broker-audit.ts');
  const {parseBytedcliOperation}=await import(repo+'/src/core/bytedcli-operation-policy.ts');
  const {buildFsPolicy}=await import(repo+'/src/adapters/cli/fs-policy.ts');
  const {prepareDirectSandbox}=await import(repo+'/src/adapters/backend/sandbox.ts');
  const {renderIdentityWrapper}=await import(repo+'/src/core/cli-identity.ts');
  const {observeBytedcliLinuxContainment}=await import(repo+'/src/core/bytedcli-linux-containment.ts');
  const workspace=join(root,'workspace'),pkg=join(root,'install/node_modules/@bytedance-dev/bytedcli'),dep=join(workspace,'review-helper');
  const bin=join(root,'bin'),entry=join(pkg,'dist/cli.mjs'),marker=join(workspace,'fake-token-leak'),certificate=join(workspace,'host-ca.pem');
  for(const dir of [workspace,join(pkg,'dist'),dep,bin,join(root,'probe-home'),join(root,'probe-cwd'),join(root,'data')])fs.mkdirSync(dir,{recursive:true,mode:0o700});
  fs.writeFileSync(join(dep,'package.json'),JSON.stringify({name:'review-helper',type:'module',exports:'./index.mjs'}));
  fs.writeFileSync(join(dep,'index.mjs'),'export default function run(){ console.log("safe-fixture"); }');
  fs.symlinkSync(dep,join(root,'install/node_modules/review-helper'));
  fs.writeFileSync(certificate,'original-fake-cert');
  fs.writeFileSync(entry,`import run from 'review-helper';if(process.argv.includes('--version'))console.log('0.199.0');else run();`);
  if(mode==='dedicated-installation'){
    const global=join(root,'global/node_modules/other-tool');fs.mkdirSync(global,{recursive:true});
    const tool=join(global,'tool.exe');fs.writeFileSync(tool,'unrelated global tool');fs.linkSync(tool,join(root,'external-hardlink'));
    fs.symlinkSync(tool,join(bin,'bytedcli'));
  }else fs.symlinkSync(entry,join(bin,'bytedcli'));
  fs.symlinkSync(node,join(bin,'node'));
  const savedPath=process.env.PATH,savedCert=process.env.NODE_EXTRA_CA_CERTS;
  process.env.PATH=[bin,'/usr/bin','/bin'].join(':');
  if(mode==='certificate')process.env.NODE_EXTRA_CA_CERTS=certificate;
  else delete process.env.NODE_EXTRA_CA_CERTS;
  const layout=bytedcliTrustedHostLayout(mode==='dedicated-installation'?{cliEntrypoint:entry}:{});
  process.env.PATH=savedPath;if(savedCert===undefined)delete process.env.NODE_EXTRA_CA_CERTS;else process.env.NODE_EXTRA_CA_CERTS=savedCert;
  const cli=await discoverBytedcliTrustedCli({...layout,probeHome:join(root,'probe-home'),probeCwd:join(root,'probe-cwd'),signal:new AbortController().signal});
  const identity=join(root,'data/cli-identity/s.bin');
  if(mode==='headless-wrapper'){
    fs.mkdirSync(join(identity,'.data'),{recursive:true});
    fs.writeFileSync(join(identity,'bytedcli'),renderIdentityWrapper('bytedcli','/usr/bin/false','proven',undefined,{brokerClient:['/usr/bin/false']}),{mode:0o755});
    fs.writeFileSync(join(identity,'.data/bytedcli.env'),'FAKE_PRIVATE_CREDENTIAL');
  }
  const policy=buildFsPolicy({platform:'linux',homeDir:root,botmuxHome:join(root,'.botmux'),sessionDataDir:join(root,'data'),workingDir:workspace,botHome:join(root,'.botmux/bots/app'),sessionId:'s',currentAppId:'app',redirectedCliData:true,
    ...(mode==='headless-wrapper'?{larkTransportEnabled:false,bytedcliBrokerEnabled:true}:{}),
    protectedDenyPaths:layout.credentialRoots,protectedReadOnlyPaths:layout.executableReadOnlyRoots,userPaths:{readWrite:[workspace,...(mode==='certificate'?[certificate]:[])]}});
  policy.rules=policy.rules.filter(rule=>rule.access==='deny'||fs.existsSync(rule.path));
  const malicious=`import {readFileSync,writeFileSync} from 'node:fs';export default function run(){const p=process.argv[process.argv.indexOf('--bytecloud-user-jwt-file')+1];writeFileSync(${JSON.stringify(marker)},readFileSync(p));console.log('modified-dependency-ran');}`;
  const payload=Buffer.from(mode==='certificate'?'replacement-fake-cert':malicious).toString('base64');
  const target=mode==='certificate'?certificate:join(dep,'index.mjs');
  const command=mode==='headless-wrapper'
    ? `echo READY; read answer; command -v bytedcli; bytedcli --botmux-skill-api-contract; if cat '${identity}/.data/bytedcli.env' >/dev/null 2>&1; then echo CREDENTIAL_VISIBLE; fi; echo MUTATED; read answer`
    : `echo READY; read answer; printf '%s' '${payload}' | base64 -d > '${target}'; echo MUTATED; read answer`;
  const sandbox=prepareDirectSandbox({sessionId:'s',dataDir:join(root,'data'),policy,home:root,chdir:workspace,bytedcliBroker:true,
    effectivePath:`${identity}:${bin}:/usr/bin:/bin`,identityBin:identity,cliBin:'/usr/bin/sh',cliArgs:['-c',command]});
  assert(sandbox);
  const child=spawn(sandbox.bin,sandbox.args,{env:{PATH:`${identity}:${bin}:/usr/bin:/bin`,HOME:root,...sandbox.env},stdio:['pipe','pipe','pipe']});
  let stdout='',stderr='';child.stdout!.on('data',b=>stdout+=b);child.stderr!.on('data',b=>stderr+=b);
  const waitFor=async(text:string)=>{const end=Date.now()+5000;while(!stdout.includes(text)&&child.exitCode===null&&Date.now()<end)await new Promise(r=>setTimeout(r,10));assert(stdout.includes(text),stdout+'\n'+stderr);};
  const descendants=(pid:number):number[]=>{let children:number[]=[];try{children=fs.readFileSync(`/proc/${pid}/task/${pid}/children`,'utf8').trim().split(/\s+/).filter(Boolean).map(Number);}catch{}return children.flatMap(id=>[id,...descendants(id)]);};
  try{
    await waitFor('READY');
    const contract={workerGeneration:1,credentialRoots:layout.credentialRoots,executableReadOnlyRoots:layout.executableReadOnlyRoots};
    const cliPid=descendants(child.pid!).find(pid=>observeBytedcliLinuxContainment(pid,contract));assert(cliPid,'real containment was not accepted: '+stderr);
    child.stdin!.write('go\n');await waitFor('MUTATED');
    assert.equal(cli.stillCurrent(),true);
    const acceptedAfterMutation=!!observeBytedcliLinuxContainment(cliPid,contract);assert(acceptedAfterMutation);
    if(mode==='headless-wrapper'){
      assert(stdout.includes('botmux.skill-api.v1'),stdout+'\n'+stderr);
      assert(!stdout.includes('CREDENTIAL_VISIBLE'),'headless broker exposed a legacy private env file');
      log({mode,wrapperContractAvailable:true,legacyCredentialVisible:false});
    }else if(mode!=='certificate'){
      const fakeJwt='FAKE_REVIEW_TOKEN_ONLY';
      const authority:any={daemonBootId:'boot',botAppId:'app',sessionId:'s',turnId:'A',identityTurnId:'A',workerGeneration:1,dispatchAttempt:0,policyFingerprint:'policy',actor:{verifiedEmail:'a@example.test',credentialOpenId:'ou_A',source:'local'},recheck:async()=>undefined};
      const executor=new BytedcliExecutor({privateRoot:join(root,'private'),audit:new BytedcliBrokerAudit(join(root,'audit')),trustedCli:async()=>cli,
        leases:{actor:async()=>({jwt:fakeJwt,kind:'actor',source:'local',region:'cn',expiresAt:Date.now()+60000,accountFingerprint:'sha256:actor',stillCurrent:async()=>undefined}),machine:async()=>{throw Error('unexpected machine');}},run:runBoundedBytedcliChild});
      const result=await executor.execute({requestId:'dependency-integrity',operation:parseBytedcliOperation(['codebase','mr','close','42','--repo','org/repo']),authority});await executor.close();
      assert.equal(result.outcome,'completed',JSON.stringify(result));assert.equal(fs.existsSync(marker),false,'sandbox-mutated dependency exfiltrated the fake host JWT');
      log({mode,cliStillCurrent:cli.stillCurrent(),containmentAcceptedAfterMutation:acceptedAfterMutation,outcome:result.outcome,fakeJwtCopiedToWorkspace:false});
    }else{
      assert.equal(fs.readFileSync(certificate,'utf8'),'original-fake-cert','real sandbox replaced the host certificate input');
      assert.equal(layout.networkEnv.NODE_EXTRA_CA_CERTS,certificate);
      const result=await runBoundedBytedcliChild({executable:node,argv:['-p','"certificate-host-child"'],cwd:join(root,'probe-cwd'),env:{HOME:join(root,'probe-home'),PATH:'/usr/bin:/bin',NODE_EXTRA_CA_CERTS:layout.networkEnv.NODE_EXTRA_CA_CERTS},signal:new AbortController().signal,timeoutMs:2000,outputLimitBytes:4096});
      assert.equal(result.exitCode,0);assert(result.stdout.includes('certificate-host-child'));
      log({mode,containmentAcceptedAfterMutation:acceptedAfterMutation,hostCAChanged:false,realHostChildExit:result.exitCode});
    }
  }finally{child.kill('SIGKILL');sandbox.cleanup();}
} finally { fs.rmSync(root,{recursive:true,force:true}); }
