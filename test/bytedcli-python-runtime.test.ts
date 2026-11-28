import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { discoverBytedcliPythonRuntime } from '../src/core/bytedcli-python-runtime.js';
import { BytedcliExecutor } from '../src/core/bytedcli-executor.js';
import { parseBytedcliOperation } from '../src/core/bytedcli-operation-policy.js';
import { parseBytedcliOperationPolicy } from '../src/core/bytedcli-operation-policy-config.js';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
describe.skipIf(process.platform !== 'linux')('MindAI distro Python isolation', () => {
  it('passes the selected lease and frozen image to Python, hides host data and rejects changed or missing runtime before leasing', async () => {
    const python = discoverBytedcliPythonRuntime();
    expect(python, 'Linux isolation verification requires the supported distro Python runtime').toBeDefined();
    if (!python) throw new Error('Python isolation was not exercised');
    const root = mkdtempSync(join(tmpdir(), 'bytedcli-python-')); roots.push(root);
    const install = join(root, 'install'); mkdirSync(install);
    const script = join(install, 'cli.cjs'), secret = join(root, 'private.png'); writeFileSync(secret, 'host-private');
    const source = `import importlib.util,json,os,pathlib,ssl,sys\np=pathlib.Path(sys.argv[1]);secret=pathlib.Path(${JSON.stringify(secret)})\nhome=pathlib.Path(os.environ["HOME"]);module=home/"fixturemod.py";module.write_text("answer=42")\nspec=importlib.util.spec_from_file_location("fixturemod",module);loaded=importlib.util.module_from_spec(spec);spec.loader.exec_module(loaded)\nprint(json.dumps(dict(bytecode=(home/"__pycache__").exists(),selected=sys.stdin.read()=='fixture-machine-jwt',image=p.read_bytes().hex(),suffix=p.suffix,host=secret.exists(),noUserSite=os.environ.get('PYTHONNOUSERSITE'))))`;
    writeFileSync(script, `const fs=require('node:fs'),cp=require('node:child_process'),a=process.argv.slice(2);const jwt=fs.readFileSync(a[a.indexOf('--bytecloud-user-jwt-file')+1],'utf8');const p=cp.spawnSync(process.env.BYTEDCLI_MINDAI_PYTHON,['-c',${JSON.stringify(source)},a[a.indexOf('--attachment')+1]],{env:process.env,input:jwt,encoding:'utf8'});process.stdout.write(p.stdout||'');process.stderr.write(p.stderr||'');process.exit(p.status??1);`);
    const node = realpathSync(process.versions.bun ? '/usr/bin/node' : process.execPath);
    const operation = parseBytedcliOperation(['--json','mindai','chart','update','--task-id','task-1','--prompt','draw','--attachment','input0-png'], {files:[{id:'input0-png',dataBase64:'AP8='}]});
    const botPolicy = parseBytedcliOperationPolicy({schema:'botmux.bytedcli-operation-policy.v2',cliVersion:operation.cliVersion,catalogVersion:operation.catalogVersion,rules:{[operation.id]:'machine'}});
    const authority = {daemonBootId:'boot',botAppId:'app',sessionId:'session',turnId:'turn',workerGeneration:1,dispatchAttempt:1,policyFingerprint:'p',executionIdentity:'machine' as const,operationPolicy:Object.freeze({globalRevision:'test',botPolicy}),recheck:async()=>undefined};
    let current = true, leases = 0; const audit: any[] = [];
    const dependencies = {privateRoot:join(root,'requests'),pythonRuntime:{...python,stillCurrent:()=>current&&python.stillCurrent()},trustedCli:async()=>({executable:node,prefixArgs:[script],path:dirname(node),protectedPaths:[install,node],version:'0.199.0',stillCurrent:()=>true}),
      leases:{machine:async()=>{leases++;return {kind:'machine' as const,source:'machine' as const,region:'cn' as const,jwt:'fixture-machine-jwt',expiresAt:Date.now()+60_000,accountFingerprint:'sha256:machine',stillCurrent:async()=>undefined};},actor:async()=>{throw new Error('actor must not be selected');}},audit:{append:async(row:any)=>{audit.push(row);}}};
    const executor = new BytedcliExecutor(dependencies);
    try {
      const result = await executor.execute({operation,authority,requestId:'python-first'});
      expect(result.outcome,JSON.stringify(result)).toBe('completed');
      expect(JSON.parse(Buffer.from(result.stdoutBase64,'base64').toString())).toEqual({bytecode:false,selected:true,image:'00ff',suffix:'.png',host:false,noUserSite:'1'});
      expect(audit.map(row=>[row.phase,row.effect,row.source])).toEqual([['intent','write','machine'],['result','write','machine']]);
      current=false;
      expect((await executor.execute({operation,authority,requestId:'python-changed'})).errorCode).toBe('executor_unavailable');
      expect(leases).toBe(1);
    } finally {await executor.close();}
    const missing = new BytedcliExecutor({...dependencies,pythonRuntime:undefined});
    try {expect((await missing.execute({operation,authority,requestId:'python-missing'})).errorCode).toBe('executor_unavailable');expect(leases).toBe(1);}
    finally {await missing.close();}
  });
});
