import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { config } from '../src/config.js';
import { openDatabaseSyncOrThrow } from '../src/services/sqlite-compat.js';
import { ScheduleAuthorityStore } from '../src/services/schedule-authority-store.js';
import { backgroundJobHome } from '../src/services/bytedcli-home.js';
import { readProcessStartIdentity } from '../src/utils/process-identity.js';
import { runAutoCleanupTick } from '../src/dashboard/auto-cleanup.js';
import { cleanupSessionTempDirAfterExit, ensureSessionTempDir } from '../src/core/session-temp.js';
import { daemonIpcAuthHeaders } from '../src/core/daemon-ipc-auth.js';
import { setIpcAuthSecret, startIpcServer, type IpcServerHandle } from '../src/core/dashboard-ipc-server.js';
import { registerScheduledBackgroundExecution, resolveAuthorizedScheduledSession,
  resolveDetachedScheduledExecutionIdentity, resolveRegisteredBackgroundContext } from '../src/core/detached-scheduled-identity.js';
import * as identity from '../src/core/cli-identity.js';
import * as registry from '../src/bot-registry.js';
import * as access from '../src/im/lark/event-dispatcher.js';
import * as workerPool from '../src/core/worker-pool.js';
import * as sessionStore from '../src/services/session-store.js';
import * as scheduler from '../src/core/scheduler.js';
import * as publication from '../src/core/turn-cli-identity.js';
import * as platformCredentials from '../src/core/platform-credential-source.js';
import { spawnTsEval } from './helpers/ts-runner.js';

const app = 'cli_auto_cleanup_background';
const turnId = 'schedule:abcd1234:12345678-1234-1234-1234-123456789abc';
const capability = 'c'.repeat(64);
const hostSecret = 'auto-cleanup-background-test';
const previousDataDir = config.session.dataDir;
let root: string, store: ScheduleAuthorityStore, child: ChildProcess, ds: any, sessionId: string;
let ipc: IpcServerHandle | undefined;
const request = () => ({ sessionDataDir: root, sessionId,
  peer: { pid: child.pid!, procStart: readProcessStartIdentity(child.pid!)! } });
const context = () => resolveRegisteredBackgroundContext(request());
const record = () => sessionStore.getOwnedSession(sessionId)!;
const jwt = () => `e30.${Buffer.from(JSON.stringify({exp:Math.floor(Date.now()/1000)+7200})).toString('base64url')}.sig`;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'background-auto-cleanup-'));
  config.session.dataDir = root;
  vi.stubEnv('BOTMUX_COORDINATION_MODE', 'disabled');
  vi.spyOn(registry, 'getBot').mockReturnValue({config:{larkAppId:app,backendType:'pty'}} as any);
  vi.spyOn(access, 'canOperate').mockReturnValue(true);
  vi.spyOn(platformCredentials, 'noteSenderUnionId').mockImplementation(() => {});
  sessionStore.init(app);
  const session = sessionStore.createSession('oc_background', 'om_background', 'background', 'group', 'thread');
  Object.assign(session, {larkAppId:app,sandbox:'off',backendType:'pty'});
  sessionStore.updateSession(session); sessionId = session.sessionId;
  store = ScheduleAuthorityStore.open(root); store.initializeApp(app, []);
  store.createDirect({id:'abcd1234',larkAppId:app,chatId:'oc_background',enabled:true,
    ownerOpenId:'ou_background',ownerUnionId:'on_background',name:'background',prompt:'work',workingDir:root,
    parsed:{kind:'interval',minutes:30,display:'every 30m'},createdAt:new Date().toISOString()} as any);
  scheduler.setScheduleAuthorityStore(store);
  child = spawnTsEval('setInterval(()=>{},1000)', {stdio:'ignore'}); await once(child,'spawn');
  ds = {session,larkAppId:app,chatId:session.chatId,workerGeneration:1,
    worker:{pid:process.pid,connected:true,killed:false},reportedIdentityModel:{model:'proven'},
    localProcessAttestation:{workerGeneration:1,cliPid:process.pid,cliProcStart:readProcessStartIdentity(process.pid)},
    managedTurnOrigin:{turnId,callerOpenId:'ou_background',dispatchAttempt:1,capability,
      preexistingProcessIdentities:[`${process.pid}:${readProcessStartIdentity(process.pid)}`]}};
  vi.spyOn(workerPool, 'findActiveBySessionId').mockImplementation(id => id === sessionId ? ds : undefined);
  vi.spyOn(workerPool, 'identityStorageModelForDaemonSession').mockReturnValue('proven');
  vi.spyOn(publication, 'publishTurnCliIdentity').mockImplementation(async args => {
    identity.writeSessionIdentity(root, sessionId, {tool:'bytedcli',cloudJwt:jwt(),openId:args.senderOpenId!,turnId:args.turnId}, 'proven');
    return [];
  });
  const identityDir = identity.sessionIdentityDataDir(root,sessionId); mkdirSync(identityDir,{recursive:true});
  writeFileSync(join(identityDir,'identity-layout'),'proven-v1');
});
afterEach(async () => {
  vi.useRealTimers();
  if (ipc) await ipc.close(); ipc = undefined; setIpcAuthSecret(null);
  if (child?.exitCode === null && child.signalCode === null) {
    const exited = once(child,'exit'); child.kill('SIGKILL'); await exited;
  }
  scheduler.setScheduleAuthorityStore(null); store?.close();
  config.session.dataDir = previousDataDir;
  vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(root,{recursive:true,force:true});
});
function register() {
  const job = registerScheduledBackgroundExecution({...request(),ttlSeconds:7*86400});
  expect(job).not.toBeNull(); return job!;
}
function autoClose() { ds = undefined; sessionStore.closeSession(sessionId,{backgroundExecutionCleanup:true}); }
async function postClose(auth:'host'|'capability', source:'scheduled'|'manual') {
  setIpcAuthSecret(hostSecret);
  ipc ??= await startIpcServer({port:0,host:'127.0.0.1',authRequired:true});
  const path = `/api/sessions/${sessionId}/close`;
  const headers = auth === 'host' ? daemonIpcAuthHeaders({secret:hostSecret,port:ipc.port,method:'POST',path,
    headers:{'content-type':'application/json'}}) : {'content-type':'application/json'};
  return fetch(`http://127.0.0.1:${ipc.port}${path}`,{method:'POST',headers,
    body:JSON.stringify({idleCleanup:true,idleCleanupSource:source,...(auth==='capability'?{originCapability:capability}:{})})});
}

describe.skipIf(process.platform !== 'linux')('registered background identity through automatic cleanup', () => {
  it('keeps the same job HOME and principal through the automatic sweep, scratch removal and store restart', async () => {
    const job = register();
    const initial = await resolveDetachedScheduledExecutionIdentity({...request(),tool:'bytedcli'});
    expect(initial?.env).toContain("BOTMUX_IDENTITY_OPEN_ID='ou_background'");
    const home = backgroundJobHome(job.id);writeFileSync(join(home,'state'),'original-person');
    ensureSessionTempDir(root,sessionId);
    ds = undefined;
    const result = await runAutoCleanupTick({now:()=>Date.now(),readConfig:()=>({enabled:true,olderThanHours:24}),
      readLastRun:()=>undefined,writeLastRun:()=>{},getSessions:()=>[{sessionId,status:'dormant',lastMessageAt:Date.now()-25*3600000}],
      closeCandidate:async row=>{sessionStore.closeSession(row.sessionId,{backgroundExecutionCleanup:true});return {sessionId:row.sessionId,ok:true};}});
    expect(result?.closed).toBe(1);expect(record().status).toBe('closed');
    expect(record().backgroundExecutionCleanupClosedAt).toBe(record().closedAt);
    cleanupSessionTempDirAfterExit(root,sessionId);
    rmSync(identity.sessionIdentityDataDir(root,sessionId),{recursive:true,force:true});
    store.close();store=ScheduleAuthorityStore.open(root);scheduler.setScheduleAuthorityStore(store);sessionStore.init(app);
    expect(context()?.job.id).toBe(job.id);
    const restored = await resolveDetachedScheduledExecutionIdentity({...request(),tool:'bytedcli'});
    expect(restored?.env).toBe(initial?.env);
    expect(existsSync(join(home,'state'))).toBe(true);
    expect(record().status).toBe('closed');
  });

  it('does not admit a new scheduled execution from an automatically closed session', () => {
    const job = register();const oldDs=ds;autoClose();
    expect(context()?.job.id).toBe(job.id);
    expect(resolveAuthorizedScheduledSession(root,sessionId,turnId)).toBeNull();
    ds = oldDs;
    expect(registerScheduledBackgroundExecution(request())).toBeNull();
  });

  it.each(['direct','after-automatic','offline-host'] as const)('keeps %s manual close revoked across resume before the first credential lookup', mode => {
    register();ds=undefined;
    if(mode!=='direct') autoClose();
    if(mode==='offline-host') {
      const result=sessionStore.applySessionCommandUnowned({sessionId,larkAppId:app},{type:'close'},{dataDir:root,probeHolder:()=>undefined});
      expect(result.outcome).toBe('applied');sessionStore.init(app);
    } else sessionStore.closeSession(sessionId);
    expect(record().backgroundExecutionCleanupClosedAt).toBeUndefined();
    expect(sessionStore.reactivateClosedSession(sessionId).ok).toBe(true);
    // No credential read observed the closed row; durable epoch must still
    // prevent its old process root from becoming valid after resume.
    expect(context()).toBeNull();expect(store.backgroundExecutions(app,sessionId)).toEqual([]);
  });

  it('does not let a later automatic sweep promote a manually closed row', () => {
    register();ds=undefined;sessionStore.closeSession(sessionId);
    sessionStore.closeSession(sessionId,{backgroundExecutionCleanup:true});
    expect(record().backgroundExecutionCleanupClosedAt).toBeUndefined();expect(context()).toBeNull();
  });

  it('keeps the registered lease fixed through repeated automatic cleanup', () => {
    const job=register();autoClose();const closedAt=record().closedAt;
    vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(Date.now()+60000);
    sessionStore.closeSession(sessionId,{backgroundExecutionCleanup:true});
    expect(record().closedAt).toBe(closedAt);expect(context()?.job.expiresAt).toBe(job.expiresAt);
    expect(record().backgroundExecutionEpoch??0).toBe(job.sessionEpoch??0);
  });

  it.each(['automatic','manual'] as const)('does not publish %s close metadata before SQLite commits', mode => {
    const job=register();ds=undefined;
    if(mode==='manual') autoClose();
    const before=structuredClone(record());
    const db=openDatabaseSyncOrThrow(join(root,'session-stores',app,'sessions.db'));
    try {
      db.exec("CREATE TRIGGER reject_review_close BEFORE UPDATE ON sessions BEGIN SELECT RAISE(ABORT,'reject_close'); END;");
      expect(()=>sessionStore.closeSession(sessionId,mode==='automatic'?{backgroundExecutionCleanup:true}:{})).toThrow('reject_close');
      expect(record()).toEqual(before);
      const persisted=JSON.parse((db.prepare('SELECT row FROM sessions WHERE session_id = ?').get(sessionId) as {row:string}).row);
      expect(persisted.backgroundExecutionCleanupClosedAt).toBe(before.backgroundExecutionCleanupClosedAt);
      expect(persisted.backgroundExecutionEpoch).toBe(before.backgroundExecutionEpoch);
      expect(context()?.job.id).toBe(job.id);
    } finally {db.exec('DROP TRIGGER reject_review_close;');db.close();}
  });

  it.each(['pause','expiry','wrong-close-marker'] as const)('still rejects %s after automatic cleanup', change => {
    const job=register();autoClose();
    if(change==='pause') store.updateTask(app,'abcd1234',t=>({...t,enabled:false}));
    if(change==='expiry') {vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(job.expiresAt+1);}
    if(change==='wrong-close-marker') {const session=record();session.backgroundExecutionCleanupClosedAt='another-close';sessionStore.updateSession(session);}
    expect(context()).toBeNull();expect(store.backgroundExecutions(app,sessionId)).toEqual([]);
  });

  it.each([['host','scheduled',true],['host','manual',false],['capability','scheduled',false]] as const)(
    'preserves only trusted scheduled-close authority: %s/%s', async (auth,source,preserves) => {
      const job=register();
      const close=vi.spyOn(workerPool,'closeSession').mockImplementation(async (id,opts)=>{
        sessionStore.closeSession(id,{backgroundExecutionCleanup:opts?.backgroundExecutionCleanup});
        ds=undefined;return {ok:true,outcome:'closed',alreadyClosed:false};
      });
      const response=await postClose(auth,source);expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ok:true});
      expect(close).toHaveBeenCalledOnce();
      expect(record().backgroundExecutionCleanupClosedAt!==undefined).toBe(preserves);
      expect(context()?.job.id).toBe(preserves?job.id:undefined);
    });

  it('passes automatic intent through the real background closer and clears it on a manual re-close', async () => {
    const job=register();ds=undefined;
    expect((await workerPool.closeSessionForBackgroundCleanup(sessionId,'deferred-schedule settlement',{backgroundExecutionCleanup:true})).ok).toBe(true);
    expect(context()?.job.id).toBe(job.id);
    expect((await workerPool.closeSession(sessionId)).ok).toBe(true);
    expect(record().backgroundExecutionCleanupClosedAt).toBeUndefined();expect(context()).toBeNull();
  });

  it.each(['returned','threw','authority-unavailable'] as const)(
    'removes late provider HOME after its dead root was pruned: %s', async outcome => {
      const job=register();ds=undefined;
      const originalRequest=request();
      vi.useFakeTimers({toFake:['Date','setTimeout','clearTimeout']});
      vi.mocked(publication.publishTurnCliIdentity).mockImplementation(async args=>{
        await new Promise(resolve=>setTimeout(resolve,1000));
        identity.writeSessionIdentity(root,sessionId,{tool:'bytedcli',cloudJwt:jwt(),openId:args.senderOpenId!,turnId:args.turnId},'proven');
        writeFileSync(join(backgroundJobHome(job.id),'late-state'),'must be reclaimed');
        if(outcome==='threw') throw new Error('late-provider-failure');
        return [];
      });
      const pending=resolveDetachedScheduledExecutionIdentity({...originalRequest,tool:'bytedcli'})
        .then(value=>({value}),error=>({error}));
      await vi.advanceTimersByTimeAsync(100);
      const exited=once(child,'exit');child.kill('SIGKILL');await exited;
      const replacement=spawnTsEval('setInterval(()=>{},1000)',{stdio:'ignore'});await once(replacement,'spawn');
      try {
        store.registerBackgroundExecution({...job,id:randomUUID(),
          root:{pid:replacement.pid!,procStart:readProcessStartIdentity(replacement.pid!)!}});
        if(outcome==='authority-unavailable') {
          vi.spyOn(scheduler,'backgroundExecutions').mockImplementation(()=>{throw new Error('authority-unavailable');});
        }
        await vi.advanceTimersByTimeAsync(1100);
        const settled=await pending;
        if(outcome==='returned') expect(settled).toEqual({value:null});
        else expect(settled).toHaveProperty('error');
        expect(identity.recallProvenIdentityContent(root,sessionId,`background:${job.id}`,'bytedcli')).toBeUndefined();
        expect(existsSync(backgroundJobHome(job.id))).toBe(false);
      } finally {const exit=once(replacement,'exit');replacement.kill('SIGKILL');await exit;}
    });


  it('routes a manual re-close of an automatically closed row through durable revocation', async () => {
    const job=register();
    const close=vi.spyOn(workerPool,'closeSession').mockImplementation(async (id,opts)=>{
      sessionStore.closeSession(id,{backgroundExecutionCleanup:opts?.backgroundExecutionCleanup});
      ds=undefined;return {ok:true,outcome:'closed',alreadyClosed:false};
    });
    expect((await postClose('host','scheduled')).status).toBe(200);
    expect(context()?.job.id).toBe(job.id);
    expect((await postClose('host','manual')).status).toBe(200);
    expect(close).toHaveBeenCalledTimes(2);
    expect(record().backgroundExecutionCleanupClosedAt).toBeUndefined();
    expect(context()).toBeNull();
  });

  it('refuses local background authority when coordination moves to primary', () => {
    register();vi.stubEnv('BOTMUX_COORDINATION_MODE','primary');
    expect(registerScheduledBackgroundExecution(request())).toBeNull();
    expect(context()).toBeNull();
    vi.stubEnv('BOTMUX_COORDINATION_MODE','disabled');
    expect(context()).toBeNull();
  });

  it('keeps host SQLite background authority in shadow coordination mode', () => {
    vi.stubEnv('BOTMUX_COORDINATION_MODE','shadow');const job=register();autoClose();
    expect(context()?.job.id).toBe(job.id);
  });

});
