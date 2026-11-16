import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { nodeTsRunnerPrefix, spawnNodeTsScript } from './helpers/ts-runner.js';
import { privateTmuxEnv } from './helpers/private-tmux-env.js';
import { fenceHomeRootedEnv } from './helpers/fence-home-env.js';
import { workerTmuxArgs } from './helpers/worker-tmux-session.js';
import { execFileSync } from 'node:child_process';
import type { DaemonToWorker, WorkerToDaemon } from '../src/types.js';
import { readJsonLines } from './helpers/read-json-lines.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
const delay = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
const hasTmux = (() => {
  try { execFileSync('tmux', ['-V'], { stdio: 'ignore' }); return true; } catch { return false; }
})();

async function fixture(opts: { native?: boolean; auto?: boolean; backend?: 'pty' | 'tmux'; merge?: boolean } = {}) {
  const root = mkdtempSync('/tmp/bmx-first-');
  const data = join(root, 'data');
  const home = join(root, '.trae');
  const sessionId = randomUUID();
  const nativeId = randomUUID();
  const rolloutDir = join(home, 'cli', 'sessions', '2026', '11', '16');
  for (const dir of [data, rolloutDir, join(root, 'tmux')]) mkdirSync(dir, { recursive: true });
  const history = join(home, 'cli', 'history.jsonl');
  const rollout = join(rolloutDir, `rollout-2026-11-16T00-00-00-${nativeId}.jsonl`);
  const launches = join(root, 'launches.jsonl');
  const writes = join(root, 'writes.jsonl');
  const submissions = join(root, 'submissions.jsonl');
  const initialized = join(root, 'initialized');
  const receiptReady = join(root, 'receipt-ready');
  const release = join(root, 'complete');
  const fake = join(root, opts.native === false ? 'unverified-launcher' : 'traecli');
  for (const path of [history, rollout, launches, writes, submissions]) writeFileSync(path, '');
  writeFileSync(fake, `#!${nodeTsRunnerPrefix().command}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('traecli 0.215.0'); process.exit(0); }
if (args[0] === 'debug') { console.log(JSON.stringify({models:[]})); process.exit(0); }
if (args[0] === 'app-server') {
 let buffer = '';
 process.stdin.on('data', chunk => {
  buffer += chunk;
  while (buffer.includes('\\n')) {
   const end = buffer.indexOf('\\n'), msg = JSON.parse(buffer.slice(0,end)); buffer = buffer.slice(end+1);
   if (msg.method === 'initialize') console.log(JSON.stringify({id:msg.id,result:{}}));
   if (msg.method === 'model/list') console.log(JSON.stringify({id:msg.id,result:{data:[
     {id:'core',businessMetadata:{load:{load_percent:180}}},
     {id:'backup',businessMetadata:{load:{load_percent:10}}}
   ],nextCursor:null}}));
  }
 }); return;
}
const model = args[args.indexOf('--model')+1];
const sid = ${JSON.stringify(nativeId)};
const history = ${JSON.stringify(history)}, rollout = ${JSON.stringify(rollout)};
const rolloutFd = fs.openSync(rollout,'a');
if (!args.includes('resume')) fs.writeSync(rolloutFd, JSON.stringify({type:'session_meta',payload:{id:sid,cwd:process.cwd()}})+'\\n');
fs.appendFileSync(${JSON.stringify(launches)}, JSON.stringify({args,model})+'\\n');
process.stdin.setRawMode?.(true); process.stdin.setEncoding('utf8');
process.stdout.write('\\x1b[?2004h');
let ready = false, first, count = 0, completed = false, input = '', pasted = '', savedReceipt = false;
function event(payload) { fs.writeSync(rolloutFd,JSON.stringify({timestamp:new Date().toISOString(),type:'event_msg',payload})+'\\n'); }
function idle() { process.stdout.write('\\x1b[2J\\x1b[H❯ Ask TRAE CLI to do anything\\n───────────────────────────────────────\\n  '+(ready ? model+' xhigh · ~ · Context 99% left\\n  ☢ Full Access · ' : '')+'? for shortcuts\\n'); }
function submit(text) {
 count++;
 const turn = ${!!opts.merge} && first ? first.turn : 'native-'+count;
 fs.appendFileSync(${JSON.stringify(submissions)},JSON.stringify({text,turn,model})+'\\n');
 if (!first) first = {text,turn};
 else fs.appendFileSync(history,JSON.stringify({session_id:sid,text})+'\\n');
 if (!${!!opts.merge} || count === 1) event({type:'task_started',turn_id:turn});
 if (${!!opts.merge}) event({type:'item_completed',turn_id:turn,item:{type:'UserMessage',id:'user-'+count,content:[{type:'text',text,text_elements:[]}]}});
 else event({type:'user_message',message:text,turn_id:turn,images:[],local_images:[],text_elements:[]});
 process.stdout.write('\\x1b[2J\\x1b[H◆ Working… (1s • esc to interrupt)\\nContext 99% left\\n');
 if (count > 1) { event({type:'task_complete',turn_id:turn,last_agent_message:'FOLLOWUP_OK'}); idle(); }
}
idle();
process.stdin.on('data', chunk => {
 fs.appendFileSync(${JSON.stringify(writes)},JSON.stringify({chunk,ready})+'\\n');
 input += chunk;
 const start=input.indexOf('\\x1b[200~'), end=input.indexOf('\\x1b[201~',start+6);
 if(start>=0 && end>=0){pasted=input.slice(start+6,end);input=input.slice(end+6);}
 if(pasted && /[\\r\\n]/.test(input)) { if(ready){const text=pasted;pasted='';input='';submit(text);} else input=''; }
});
setInterval(() => {
 if (!ready && fs.existsSync(${JSON.stringify(initialized)})) {
  ready=true; idle();
  const separator=args.indexOf('--');
  if(separator>=0 && args[separator+1]) submit(args[separator+1]);
 }
 if(first && !savedReceipt && fs.existsSync(${JSON.stringify(receiptReady)})) {
  savedReceipt=true; fs.appendFileSync(history,JSON.stringify({session_id:sid,text:first.text})+'\\n');
 }
 if(first && !completed && !${!!opts.merge} && fs.existsSync(${JSON.stringify(release)})) {
  completed=true;event({type:'task_complete',turn_id:first.turn,last_agent_message:'FIRST_OK'});idle();
 }
},25);
`);
  chmodSync(fake, 0o755);
  const env = privateTmuxEnv(join(root, 'tmux'), { HOME: root, USERPROFILE: root, SHELL: '/bin/bash' });
  fenceHomeRootedEnv(root, env);
  Object.assign(env, { TRAE_HOME: home, SESSION_DATA_DIR: data, BOTMUX_SESSION_ID: sessionId,
    BOTMUX_TIME_SCALE: '0.01', CLI_EXTRA_ARGS: '', LARK_APP_ID: 'app_test', LARK_APP_SECRET: 'test' });
  const options: SpawnOptions = { cwd: resolve('.'), env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] };
  const children: ChildProcess[] = [];
  const logs: string[] = [];
  const messages: WorkerToDaemon[] = [];
  const init: Extract<DaemonToWorker, { type: 'init' }> = {
    type: 'init', sessionId, chatId: 'oc_test', rootMessageId: 'om_first', workingDir: data,
    cliId: 'traex', cliPathOverride: fake, model: 'core', backendType: opts.backend ?? 'pty',
    prompt: '-first\n中文 "quote" $(literal)', turnId: 'om_first',
    larkAppId: 'app_test', larkAppSecret: 'test', locale: 'zh',
    ...(opts.auto ? { traexAutoModel: { enabled: true, models: ['core', 'backup'],
      preflightLoadCheck: true, overloadThresholdPercent: 100, preflightTimeoutMs: 3000,
      unknownLoadPolicy: 'skip', allOverloadedPolicy: 'lowest_load',
      queueTimeoutMs: 5000, switchCooldownMs: 5000 } } : {}),
  };
  function launch() {
    const binary = process.env.BOTMUX_TEST_WORKER_BINARY;
    const child = binary ? spawn(binary, ['__worker'], options) : spawnNodeTsScript(resolve('src/worker.ts'), [], options);
    children.push(child);
    child.stdout?.on('data', chunk => logs.push(chunk.toString()));
    child.stderr?.on('data', chunk => logs.push(chunk.toString()));
    child.on('message', message => messages.push(message as WorkerToDaemon));
    child.send({ ...init });
    return child;
  }
  cleanups.push(async () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise(done => child.once('exit', done));
        child.kill('SIGKILL'); await Promise.race([exited, delay(2000)]);
      }
    }
    try { execFileSync('tmux', [...workerTmuxArgs(['kill-server'])], { env, stdio: 'ignore', timeout: 3000 }); } catch {}
    rmSync(root, { recursive: true, force: true });
  });
  let child = launch();
  async function wait(predicate: () => boolean, label: string, timeout = 20000) {
    const end = Date.now() + timeout;
    while (!predicate()) {
      if (Date.now() >= end || child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`${label}\n${logs.join('')}\n${JSON.stringify(messages.slice(-15))}`);
      }
      await delay(25);
    }
  }
  async function restart() {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(done => child.once('exit', done));
      child.kill('SIGKILL'); await exited;
    }
    messages.splice(0); child = launch();
  }
  return { wait, restart, logs, messages, init, initialized, receiptReady, release, launches, submissions, writes,
    history, nativeId, receipt: join(data, 'turn-marks', `${sessionId}.traex-initial.json`),
    send: (content: string, turnId: string) => child.send({ type: 'message', content, turnId }) };
}

describe('TRAE native first input through the complete worker', () => {
  for (const backend of ['pty', 'tmux'] as const) {
  it.skipIf(backend === 'tmux' && !hasTmux)(`holds slow initialization and late receipts on ${backend}`, async () => {
    const f = await fixture({ native: true, auto: true, backend });
    await f.wait(() => readJsonLines(f.launches).length === 1, 'CLI launched', 60000);
    const launch = readJsonLines(f.launches)[0];
    expect(launch.model).toBe('backup');
    expect(launch.args.slice(-2)).toEqual(['--', expect.stringContaining(f.init.prompt)]);
    expect(JSON.parse(readFileSync(f.receipt, 'utf8')).state).toBe('dispatched');
    f.send('second input', 'om_second');
    // Longer than the old, time-scaled Enter retry budget.
    await delay(3500);
    expect(readJsonLines(f.writes)).toHaveLength(0);
    expect(f.messages.some(m => m.type === 'turn_input_committed' && m.turnId === 'om_first')).toBe(false);
    writeFileSync(f.initialized, '1');
    await f.wait(() => readJsonLines(f.submissions).length === 1, 'native initial submitted');
    // Same text without the per-delivery identity is not our receipt.
    appendFileSync(f.history, `${JSON.stringify({ session_id: randomUUID(), text: f.init.prompt })}\n`);
    await delay(1500);
    expect(readJsonLines(f.writes)).toHaveLength(0);
    expect(JSON.parse(readFileSync(f.receipt, 'utf8')).state).toBe('dispatched');
    writeFileSync(f.receiptReady, '1');
    writeFileSync(f.release, '1');
    await f.wait(() => f.messages.some(m => m.type === 'turn_input_committed' && m.turnId === 'om_first'), 'native receipt acknowledged');
    await f.wait(() => readJsonLines(f.submissions).length === 2, 'follow-up submitted');
    await f.wait(() => f.messages.some(m => m.type === 'final_output' && m.turnId === 'om_second'), 'follow-up attributed');
    expect(readJsonLines(f.submissions).map(r => r.text)).toEqual([launch.args.at(-1), 'second input']);
    expect(f.messages.some(m => m.type === 'final_output' && m.turnId === 'om_first' && m.content === 'FIRST_OK')).toBe(true);
    expect(f.logs.join('')).not.toContain(f.init.prompt);
    expect(JSON.parse(readFileSync(f.receipt, 'utf8')).cliSessionId).toBe(f.nativeId);
  }, 90000);
  }

  for (const backend of ['pty', 'tmux'] as const) {
  it.skipIf(backend === 'tmux' && !hasTmux)(`delivers a successor when the first final precedes its receipt on ${backend}`, async () => {
    const f = await fixture({ native: true, auto: true, backend });
    await f.wait(() => readJsonLines(f.launches).length === 1, 'CLI launched', 60000);
    f.send('second input', 'om_second');
    writeFileSync(f.initialized, '1');
    await f.wait(() => readJsonLines(f.submissions).length === 1, 'native initial submitted');
    writeFileSync(f.release, '1');
    await f.wait(() => f.messages.some(m => m.type === 'final_output' && m.turnId === 'om_first'),
      'first final before history receipt');
    await delay(1500);
    expect(readJsonLines(f.writes)).toHaveLength(0);
    expect(JSON.parse(readFileSync(f.receipt, 'utf8')).state).toBe('dispatched');
    writeFileSync(f.receiptReady, '1');
    await f.wait(() => readJsonLines(f.submissions).length === 2, 'follow-up after late history');
    await f.wait(() => f.messages.some(m => m.type === 'final_output' && m.turnId === 'om_second'),
      'follow-up attributed after late history');
    expect(readJsonLines(f.submissions).filter(row => row.text === 'second input')).toHaveLength(1);
    expect(JSON.parse(readFileSync(f.receipt, 'utf8')).cliSessionId).toBe(f.nativeId);
  }, 90000);
  }

  it('attributes one native merged completion to the queued follow-up', async () => {
    const f = await fixture({ merge: true });
    await f.wait(() => readJsonLines(f.launches).length === 1, 'CLI launched', 60000);
    f.send('second input', 'om_second');
    writeFileSync(f.initialized, '1');
    await f.wait(() => readJsonLines(f.submissions).length === 1, 'native first accepted');
    expect(readJsonLines(f.writes)).toHaveLength(0);
    writeFileSync(f.receiptReady, '1');
    await f.wait(() => f.messages.some(m => m.type === 'final_output' && m.turnId === 'om_second'), 'merged task completed');
    expect(readJsonLines(f.submissions).map(row => row.turn)).toEqual(['native-1', 'native-1']);
    expect(f.messages.filter(m => m.type === 'final_output')).toEqual([
      expect.objectContaining({ turnId: 'om_second', content: 'FOLLOWUP_OK' }),
    ]);
  }, 90000);

  it('keeps an unverified launcher queued across the hard timeout and resumes observing', async () => {
    const f = await fixture({ native: false });
    await f.wait(() => readJsonLines(f.launches).length === 1, 'CLI launched', 60000);
    expect(readJsonLines(f.launches)[0].args).not.toContain(f.init.prompt);
    expect(existsSync(f.receipt)).toBe(false);
    await f.wait(() => f.messages.some(m => m.type === 'user_notify' && m.kind === 'input_not_submitted'),
      'hard timeout reports queued input without writing', 110000);
    expect(readJsonLines(f.writes)).toHaveLength(0);
    writeFileSync(f.receiptReady, '1');
    writeFileSync(f.initialized, '1');
    await f.wait(() => readJsonLines(f.submissions).length === 1, 'queued initial submitted after readiness');
    expect(readJsonLines(f.submissions)[0].text).toBe(f.init.prompt);
    expect(readJsonLines(f.writes).every(row => row.ready)).toBe(true);
  }, 150000);

  it('refuses replay across a worker crash, then recovers the exact late receipt', async () => {
    const f = await fixture();
    await f.wait(() => readJsonLines(f.launches).length === 1, 'first launch', 60000);
    writeFileSync(f.initialized, '1');
    await f.wait(() => readJsonLines(f.submissions).length === 1, 'native submitted without history');
    const original = readJsonLines(f.submissions)[0].text;
    await f.restart();
    await f.wait(() => f.messages.some(m => m.type === 'error'), 'unconfirmed restart refused', 60000);
    expect(readJsonLines(f.launches)).toHaveLength(1);
    expect(readJsonLines(f.submissions)).toHaveLength(1);
    expect(JSON.parse(readFileSync(f.receipt, 'utf8')).state).toBe('unknown');
    appendFileSync(f.history, `${JSON.stringify({ session_id: f.nativeId, text: original })}\n`);
    await f.restart();
    await f.wait(() => readJsonLines(f.launches).length === 2, 'confirmed exact resume', 60000);
    await f.wait(() => f.messages.some(m => m.type === 'turn_input_committed' && m.turnId === 'om_first'), 'recovered input acknowledged');
    const args = readJsonLines(f.launches)[1].args;
    expect(args).toContain('resume');
    expect(args).toContain(f.nativeId);
    expect(args).not.toContain(original);
    expect(readJsonLines(f.submissions)).toHaveLength(1);
  }, 90000);
});
