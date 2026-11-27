import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
const harness=vi.hoisted(()=>({socket:undefined as any}));
vi.mock('../src/im/wecom/protocol/transport.js', async importOriginal => {
  const actual=await importOriginal<typeof import('../src/im/wecom/protocol/transport.js')>();
  return {...actual,WecomTransport:class extends actual.WecomTransport {
    constructor(options:any){ super({...options,socketFactory:()=>harness.socket}); }
  }};
});
vi.mock('../src/utils/file-lock.js',()=>({withFileLock:async(_path:string,fn:()=>Promise<unknown>)=>fn()}));
import { runWecomCommand } from '../src/im/wecom/gateway/command.js';
class Socket extends EventEmitter {
  sent: any[]=[];
  send(data:string,cb?:(error?:Error)=>void) { const frame=JSON.parse(data); this.sent.push(frame); cb?.(); queueMicrotask(()=>this.emit('message',Buffer.from(JSON.stringify({headers:frame.headers,errcode:0})))); }
  terminate(){this.emit('close')}
}
afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();vi.useRealTimers()});
const flush=async()=>{for(let n=0;n<40;n++)await Promise.resolve()};
it('stops the gateway dispatch loop when the server replaces its authenticated connection',async()=>{
  vi.useFakeTimers(); const root=mkdtempSync(join(tmpdir(),'wecom-lifecycle-')); harness.socket=new Socket();
  const file=join(root,'config.json');writeFileSync(file,JSON.stringify({botId:'acceptance-lifecycle',secretEnv:'ACCEPTANCE_WECOM_SECRET',coreUrl:'http://127.0.0.1:12345',allowedUsers:['alice'],stateDir:root}));
  vi.stubEnv('ACCEPTANCE_WECOM_SECRET','fake-secret');
  const request=vi.fn(async(url:string)=>Response.json(url.endsWith('/api/trigger')?{ok:true,triggerId:'t',target:{kind:'turn',sessionId:'s'}}:{ok:true,state:'running'}));vi.stubGlobal('fetch',request);
  let exited=false; const running=runWecomCommand(['--config',file]).then(code=>{exited=true;return code});
  try {
    await flush();expect(harness.socket.listenerCount('open')).toBe(1);harness.socket.emit('open');await flush();
    harness.socket.emit('message',Buffer.from(JSON.stringify({cmd:'aibot_msg_callback',headers:{req_id:'callback'},body:{msgid:'m',chattype:'single',from:{userid:'alice'},msgtype:'text',text:{content:'task'}}})));await flush();
    expect(harness.socket.sent.some((frame:any)=>frame.cmd==='aibot_respond_msg')).toBe(true);
    harness.socket.emit('message',Buffer.from(JSON.stringify({cmd:'aibot_event_callback',body:{event:{eventtype:'disconnected_event'}}})));await flush();
    await vi.advanceTimersByTimeAsync(2100);expect(request).not.toHaveBeenCalled();expect(exited).toBe(true);expect(await running).not.toBe(0);
  } finally {process.emit('SIGTERM','SIGTERM');await running;rmSync(root,{recursive:true,force:true})}
});
