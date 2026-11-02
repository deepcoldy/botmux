import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSyncTsEvalWithRepoImports } from './helpers/ts-runner.js';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));

// Give the real OS homedir() the isolated HOME at process birth. Changing HOME
// only inside a Vitest body can leave session-temp's backing root absent and
// make cleanup return early; the child asserts the scratch was really removed.
function probe(body: string): void {
  const root = mkdtempSync(join(tmpdir(), 'background-home-')); roots.push(root);
  const home = join(root, 'home'); const tmp = join(root, 'tmp');
  mkdirSync(home); mkdirSync(tmp);
  const child = spawnSyncTsEvalWithRepoImports(`
    import assert from 'node:assert/strict';
    import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
    import { dirname, join, sep } from 'node:path';
    import { homedir } from 'node:os';
    import { execFileSync, spawn } from 'node:child_process';
    import { once } from 'node:events';
    import { randomUUID } from 'node:crypto';
    import * as identity from './src/core/cli-identity.js';
    import * as scratch from './src/core/session-temp.js';
    import { BYTEDCLI_HOME_ROOT, BACKGROUND_JOBS_HOME_ROOT, backgroundJobHome } from './src/services/bytedcli-home.js';
    import { ScheduleAuthorityStore } from './src/services/schedule-authority-store.js';
    import * as scheduler from './src/core/scheduler.js';
    import { backgroundAuthorityKey, backgroundCredentialPolicyKey } from './src/core/background-execution-policy.js';
    import { readLinuxBootIdentity, readProcessStartIdentity } from './src/utils/process-identity.js';
    import { enumerateScratchSecretPaths } from './src/adapters/backend/scratch-credentials.js';
    const data = join(homedir(), 'custom-state'); const session = 'background-home-session';
    const id = randomUUID(); const turn = 'background:' + id;
    const grant = { tool:'bytedcli', cloudJwt:'job-jwt', openId:'ou_background', turnId:turn };
    const publish = (jobId = id) => {
      identity.writeSessionIdentity(data, session, { ...grant, turnId:'background:' + jobId }, 'proven');
      const env = identity.recallProvenIdentityContent(data, session, 'background:' + jobId, 'bytedcli');
      return /BOTMUX_IDENTITY_HOME='([^']+)'/.exec(env)[1];
    };
    ${body}
    process.stdout.write('BACKGROUND_HOME_OK');
  `, { cwd: process.cwd(), env: { ...process.env, HOME: home, USERPROFILE: home, TMPDIR: tmp, TMP: tmp, TEMP: tmp },
    encoding: 'utf8', timeout: 30_000 });
  expect({ status: child.status, stderr: String(child.stderr) }).toEqual({ status: 0, stderr: String(child.stderr) });
  expect(String(child.stdout)).toContain('BACKGROUND_HOME_OK');
}

describe.skipIf(process.platform !== 'linux')('registered background HOME lifecycle', () => {
  it('survives real worker-exit scratch cleanup and keeps the same person and state at the wrapper exec', () => probe(`
    const path = scratch.ensureSessionTempDir(data, session);
    const canonicalScratch = realpathSync(path);
    writeFileSync(join(path, 'cleanup-sentinel'), 'must disappear');
    const jobHome = publish();
    assert.equal(jobHome, join(dirname(BYTEDCLI_HOME_ROOT), 'background-jobs', id));
    assert.equal(jobHome, backgroundJobHome(id));
    assert.equal(BACKGROUND_JOBS_HOME_ROOT, dirname(jobHome));
    assert.equal(statSync(jobHome).mode & 0o777, 0o700);
    assert(!realpathSync(jobHome).startsWith(canonicalScratch + sep));
    assert(!canonicalScratch.startsWith(realpathSync(jobHome) + sep));
    const state = join(jobHome, '.local/share/bytedcli/userinfo.json');
    mkdirSync(dirname(state), { recursive:true }); writeFileSync(state, 'original-person');
    let cleanupError;
    scratch.cleanupSessionTempDirAfterExit(data, session, undefined, e => cleanupError = e);
    for (let i=0; i<200 && existsSync(canonicalScratch); i++) await new Promise(r => setTimeout(r,5));
    assert.equal(cleanupError, undefined);
    assert.equal(existsSync(canonicalScratch), false, 'cleanup must execute, not silently no-op');
    assert.equal(readFileSync(state, 'utf8'), 'original-person');
    assert.equal(publish(), jobHome);
    const tool=join(homedir(),'tool');
    writeFileSync(tool, '#!/bin/sh\\ncat "$HOME/.local/share/bytedcli/userinfo.json"\\nprintf "|%s|%s" "$BYTEDCLI_USER_CLOUD_JWT" "$HOME"\\n');
    chmodSync(tool, 0o755);
    const wrapper=join(homedir(),'wrapper');
    writeFileSync(wrapper, identity.renderIdentityWrapper('bytedcli', tool, 'single'));
    identity.writeSessionIdentity(data, session, grant, 'single');
    assert.equal(execFileSync('/bin/sh',[wrapper], {encoding:'utf8',env:{PATH:process.env.PATH,HOME:homedir(),SESSION_DATA_DIR:data,BOTMUX_SESSION_ID:session}}), 'original-person|job-jwt|' + jobHome);
  `));

  it.each(['revoke', 'expiry', 'dead-root', 'pause', 'task-revoke'])(
    'cleans only the retired job HOME on %s and leaves another live job intact', change => probe(`
      const store = ScheduleAuthorityStore.open(data); store.initializeApp('cli_background', []);
      const task = { id:'abcd1234', name:'job', schedule:'every 30m', parsed:{kind:'interval',minutes:30,display:'every 30m'},
        larkAppId:'cli_background', chatId:'oc_background', ownerOpenId:'ou_background', ownerUnionId:'on_background',
        enabled:true, prompt:'work', workingDir:'/repo', createdAt:new Date().toISOString() };
      store.createDirect(task);
      const secondTask = {...task, id:'efgh5678'}; store.createDirect(secondTask);
      const children=[];
      try {
        const newJob=async (t, jobId) => {
          const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); children.push(child);
          await once(child,'spawn');
          const job={id:jobId,appId:'cli_background',sessionId:session,taskId:t.id,turnId:'schedule:'+t.id+':'+randomUUID(),
            root:{pid:child.pid,procStart:readProcessStartIdentity(child.pid)},bootId:readLinuxBootIdentity(),uid:process.getuid(),
            openId:'ou_background',unionId:'on_background',authEpoch:0,authorityKey:backgroundAuthorityKey(t),credentialPolicyKey:backgroundCredentialPolicyKey({}),expiresAt:Date.now()+(jobId===id?60000:120000)};
          store.registerBackgroundExecution(job); return job;
        };
        const one=await newJob(task,id), two=await newJob(secondTask,randomUUID());
        const home1=publish(one.id), home2=publish(two.id);
        writeFileSync(join(home1,'marker'),'one'); writeFileSync(join(home2,'marker'),'two');
        const change=${JSON.stringify(change)};
        if(change==='revoke') store.revokeBackgroundExecution(one.id);
        if(change==='expiry') {const originalNow=Date.now; Date.now=()=>one.expiresAt+1; try {store.backgroundExecutions('cli_background',session);} finally {Date.now=originalNow;}}
        if(change==='dead-root') {const end=once(children[0],'exit');children[0].kill('SIGKILL');await end;store.backgroundExecutions('cli_background',session);}
        if(change==='pause') store.updateTask('cli_background',task.id,t=>({...t,enabled:false}));
        if(change==='task-revoke') store.revoke('cli_background',task.id);
        assert.equal(existsSync(home1),false);
        // Expiry is one lease only, not a whole-root collection.
        assert.equal(readFileSync(join(home2,'marker'),'utf8'),'two');
      } finally {
        for(const child of children) if(child.exitCode===null&&child.signalCode===null){const end=once(child,'exit');child.kill('SIGKILL');await end;}
        store.close();
      }
    `));

  it.each(['core-only', 'custom'])('masks its absolute root with %s state routing, even before creation', mode => probe(`
    const state=${JSON.stringify(mode)}==='core-only'?join(homedir(),'.botmux/core-only/cli_probe/data'):join(homedir(),'some-other-state');
    assert.equal(existsSync(BACKGROUND_JOBS_HOME_ROOT),false);
    const masks=enumerateScratchSecretPaths({botmuxHomes:[],dataDirs:[state],homeDir:homedir()});
    assert(masks.denyPaths.includes(BACKGROUND_JOBS_HOME_ROOT));
    assert(!masks.readOnlyCarvePaths.some(p=>p.startsWith(BACKGROUND_JOBS_HOME_ROOT)));
  `));

  it('keeps runtime materialization valid through the real scheduler authority path', () => probe(`
    const store=ScheduleAuthorityStore.open(data); store.initializeApp('cli_background',[]);
    const task={id:'abcd1234',name:'job',schedule:'every 30m',parsed:{kind:'interval',minutes:30,display:'every 30m'},
      larkAppId:'cli_background',chatId:'oc_background',ownerOpenId:'ou_background',ownerUnionId:'on_background',enabled:true,
      prompt:'work',workingDir:'/repo',executionPosition:'task',createdAt:new Date().toISOString()};
    store.createDirect(task);
    store.registerBackgroundExecution({id,appId:'cli_background',sessionId:session,taskId:task.id,turnId:'schedule:'+task.id+':'+randomUUID(),
      root:{pid:process.pid,procStart:readProcessStartIdentity(process.pid)},bootId:readLinuxBootIdentity(),uid:process.getuid(),
      openId:'ou_background',unionId:'on_background',authEpoch:0,authorityKey:backgroundAuthorityKey(task),credentialPolicyKey:backgroundCredentialPolicyKey({}),expiresAt:Date.now()+60000});
    scheduler.setScheduleAuthorityStore(store);
    try {
      scheduler.updateRuntimeTaskState(task.id,{lastRunAt:new Date().toISOString(),nextRunAt:'2031-01-01T00:00:00Z'},'cli_background');
      scheduler.updateRuntimeTaskState(task.id,{rootMessageId:'om_materialized_after_turn'},'cli_background');
      assert.equal(store.backgroundExecutions('cli_background',session).length,1);
      assert.equal(backgroundAuthorityKey(store.getRecord('cli_background',task.id).task),backgroundAuthorityKey(task));
      store.updateTask('cli_background',task.id,t=>({...t,prompt:'different-work'}));
      assert.equal(store.backgroundExecutions('cli_background',session).length,0);
    } finally {scheduler.setScheduleAuthorityStore(null);store.close();}
  `));
});
