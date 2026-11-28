import {afterEach,expect,it,vi} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startIpcServer,type IpcServerHandle} from '../src/core/dashboard-ipc-server.js';
import {readProcessStartIdentity} from '../src/utils/process-identity.js';
import {writeSessionIdentity} from '../src/core/cli-identity.js';
import {trackTurnIdentityPublication} from '../src/core/turn-cli-identity.js';
import {config} from '../src/config.js';
import {markBytedcliStrictSession} from '../src/core/bytedcli-broker-containment.js';
let ipc:IpcServerHandle|undefined;let previous='';const roots:string[]=[];
afterEach(async()=>{await ipc?.close();ipc=undefined;if(previous){config.session.dataDir=previous;previous='';}vi.restoreAllMocks();for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
async function setup(){
 const root=mkdtempSync(join(tmpdir(),'broker-export-'));roots.push(root);previous=config.session.dataDir;config.session.dataDir=root;
 const ds:any={session:{sessionId:'s-export',status:'active',backendType:'pty'},larkAppId:'cli_export',chatId:'oc_export',workerGeneration:7,worker:{pid:process.pid,killed:false},
  reportedIdentityModel:{model:'proven',sandboxEngaged:false,loopbackShared:true,workerPid:process.pid,workerGeneration:7,reportedAt:1},
  localProcessAttestation:{backendType:'pty',workerGeneration:7,cliPid:process.pid,cliProcStart:readProcessStartIdentity(process.pid)},
  managedTurnOrigin:{capability:'ca'.repeat(32),turnId:'current',callerOpenId:'ou_actor',preexistingProcessIdentities:[`${process.pid}:${readProcessStartIdentity(process.pid)}`]}};
 const bot:any={config:{larkAppId:'cli_export',larkToolBinding:true,backendType:'pty',triggerUserAuth:{enabled:true,tools:['bytedcli'],credentialSource:'local'}}};
 vi.spyOn(await import('../src/core/worker-pool.js'),'findActiveBySessionId').mockReturnValue(ds);
 vi.spyOn(await import('../src/bot-registry.js'),'getBot').mockReturnValue(bot);
 ipc=await startIpcServer({port:0,host:'127.0.0.1',authRequired:true});
 return {ds,bot,root};
}
const post=()=>fetch(`http://127.0.0.1:${ipc!.port}/api/current-execution-identity`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({sessionId:'s-export',tool:'bytedcli'})});
it('closes a pending legacy ByteCloud export when live policy becomes strict',async()=>{
 const f=await setup();let release!:()=>void;const publication=new Promise<void>(resolve=>release=resolve);
 void trackTurnIdentityPublication(f.root,'s-export',publication);
 const pending=post();await new Promise(r=>setTimeout(r,100));
 f.bot.config.triggerUserAuth={...f.bot.config.triggerUserAuth,bytecloudExecution:'read-machine-write-actor'};
 writeSessionIdentity(f.root,'s-export',{tool:'bytedcli',cloudJwt:'test-only-secret',turnId:'current',openId:'ou_actor'},'proven');release();
 const response=await pending;expect(response.status).toBe(403);expect(await response.json()).toMatchObject({reason:'broker_export_disabled'});
});
it('never reopens a strict session export after the live policy is disabled',async()=>{
 const f=await setup();markBytedcliStrictSession(f.ds);f.bot.config.triggerUserAuth={enabled:false,tools:[]};
 writeSessionIdentity(f.root,'s-export',{tool:'bytedcli',cloudJwt:'test-only-secret',turnId:'current',openId:'ou_actor'},'proven');
 expect((await post()).status).toBe(403);
});
