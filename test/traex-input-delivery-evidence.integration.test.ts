import { execFileSync, spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { WorkerToDaemon } from '../src/types.js';
import { createBracketedPasteCollector } from './helpers/bracketed-paste-collector.js';
import { fenceHomeRootedEnv } from './helpers/fence-home-env.js';
import { privateTmuxEnv } from './helpers/private-tmux-env.js';
import { spawnNodeTsScript } from './helpers/ts-runner.js';
import { workerTmuxArgs } from './helpers/worker-tmux-session.js';

const delay = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
type Submission = { text: string; nativeTurnId: string };

describe('TraeX input delivery evidence ordering', () => {
  it.each(['early-terminal', 'early-send', 'late-terminal', 'history', 'unknown'] as const)(
    'delivers successors exactly once with %s evidence',
    async mode => {
      // Keep the UNIX socket path short on macOS (104-byte socket limit).
      // To reproduce under a long inherited TMPDIR, run with TMPDIR=/tmp.
      // Every CLI/home and tmux
      // server belongs to this fixture; inherited fleet pointers are removed.
      const root = mkdtempSync(join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'bmx-rcpt-'));
      const dataDir = join(root, 'session');
      const traeHome = join(root, '.trae');
      const socketRoot = join(root, 'tmux');
      const nativeSessionId = randomUUID();
      const sessionId = randomUUID();
      const date = new Date().toISOString().slice(0, 10);
      const rolloutDir = join(traeHome, 'cli', 'sessions', ...date.split('-'));
      const sendDir = join(dataDir, 'turn-sends');
      for (const dir of [dataDir, socketRoot, rolloutDir, sendDir]) mkdirSync(dir, { recursive: true });
      const rollout = join(rolloutDir, `rollout-${date}T00-00-00-${nativeSessionId}.jsonl`);
      const history = join(traeHome, 'cli', 'history.jsonl');
      const submissions = join(root, 'submissions.jsonl');
      const release = join(root, 'release');
      const sendMarker = join(sendDir, `${sessionId}.jsonl`);
      for (const file of [rollout, history, submissions]) writeFileSync(file, '');
      const fake = join(root, 'fake-traex');
      writeFileSync(fake, `#!/usr/bin/env node
const fs = require('node:fs');
const crypto = require('node:crypto');
const rollout = ${JSON.stringify(rollout)};
const history = ${JSON.stringify(history)};
const submissions = ${JSON.stringify(submissions)};
const release = ${JSON.stringify(release)};
const mode = ${JSON.stringify(mode)};
const sid = ${JSON.stringify(nativeSessionId)};
const sendMarker = ${JSON.stringify(sendMarker)};
let count = 0, firstId, completed = false;
process.stdin.setRawMode?.(true);
process.stdin.setEncoding('utf8');
process.stdout.write('\\x1b[?2004h');
function line(payload) {
  fs.appendFileSync(rollout, JSON.stringify({timestamp:new Date().toISOString(),type:'event_msg',payload})+'\\n');
}
function idle() {
  process.stdout.write('\\x1b[2J\\x1b[H╭──────────────────────────────────────────╮\\n│ model: GPT-6-Astra xhigh /model to change │\\n│ directory: ${dataDir} │\\n╰──────────────────────────────────────────╯\\n❯ Ask TraeCode CLI to do anything\\n  GPT-6-Astra xhigh · Context 99% left\\n');
}
function complete(id) {
  line({type:'task_complete',turn_id:id,last_agent_message:'VERSION_EXECUTED_AND_REPLIED',duration_ms:300});
  idle();
}
idle();
for (const ms of [500,1000]) setTimeout(() => { if (!count) idle(); }, ms);
const collect = (${createBracketedPasteCollector.toString()})(text => {
  count++;
  const id = crypto.randomUUID();
  fs.appendFileSync(submissions,JSON.stringify({text,nativeTurnId:id})+'\\n');
  if (count > 1 || mode === 'history') {
    fs.appendFileSync(history,JSON.stringify({session_id:sid,ts:Date.now()/1000,text})+'\\n');
  }
  if (count > 1 || !['early-send','unknown'].includes(mode)) {
    line({type:'task_started',turn_id:id,root_turn_id:id});
    line({type:'user_message',message:text,turn_id:id,images:[],local_images:[],text_elements:[]});
  }
  process.stdout.write('\\x1b[2J\\x1b[H◆ Working… (1s • esc to interrupt)\\nContext 99% left\\n');
  if (count === 1) {
    firstId = id;
    if (mode === 'early-send') setTimeout(() => {
      fs.appendFileSync(sendMarker,JSON.stringify({sentAtMs:Date.now(),turnId:'om_first',deliveryKind:'explicit_reply',chatId:'oc_test',messageId:'om_reply'})+'\\n');
      idle();
    },300);
    else if (mode === 'unknown') setTimeout(idle,300);
    else if (mode !== 'late-terminal') setTimeout(() => complete(id),300);
  } else setTimeout(() => complete(id),300);
});
process.stdin.on('data',collect);
setInterval(() => {
  if (!completed && firstId && fs.existsSync(release)) {completed=true;complete(firstId);}
},25);
`);
      chmodSync(fake, 0o755);
      const env = privateTmuxEnv(socketRoot, { HOME: root, USERPROFILE: root, SHELL: '/bin/bash' });
      fenceHomeRootedEnv(root, env);
      Object.assign(env, {
        TRAE_HOME: traeHome, SESSION_DATA_DIR: dataDir, BOTMUX_SESSION_ID: sessionId,
        BOTMUX_TIME_SCALE: '1', LARK_APP_ID: 'app_test', LARK_APP_SECRET: 'dummy_test_secret',
      });
      delete env.CLI_EXTRA_ARGS;
      delete env.BOTMUX_GOAL_PATH;
      delete env.BOTMUX_V3_GOAL;
      const messages: WorkerToDaemon[] = [];
      const logs: string[] = [];
      const options: SpawnOptions = { cwd: resolve('.'), env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] };
      const binary = process.env.BOTMUX_TEST_WORKER_BINARY;
      const child: ChildProcess = binary
        ? spawn(binary, ['__worker'], options)
        : spawnNodeTsScript(resolve('src/worker.ts'), [], options);
      child.on('message', message => messages.push(message as WorkerToDaemon));
      child.stdout?.on('data', chunk => logs.push(chunk.toString()));
      child.stderr?.on('data', chunk => logs.push(chunk.toString()));
      const sent = (content: string, turnId: string) => child.send({ type: 'message', content, turnId });
      const received = (): Submission[] => readFileSync(submissions, 'utf8')
        .split('\n').filter(Boolean).map(line => JSON.parse(line));
      const wait = async (predicate: () => boolean, label: string, timeout = 12_000) => {
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) {
          if (predicate()) return;
          if (child.exitCode !== null || child.signalCode !== null) throw new Error(`worker exited: ${label}\n${logs.join('')}`);
          await delay(25);
        }
        throw new Error(`timeout: ${label}\n${logs.join('')}`);
      };
      const nativeEvent = (payload: unknown) => appendFileSync(rollout,
        `${JSON.stringify({ timestamp: new Date().toISOString(), type: 'event_msg', payload })}\n`);
      try {
        child.send({
          type: 'init', sessionId, chatId: 'oc_test', rootMessageId: 'om_root', workingDir: dataDir,
          cliId: 'traex', cliPathOverride: fake, cliSessionId: nativeSessionId, resume: true,
          backendType: 'tmux', prompt: '', larkAppId: 'app_test', larkAppSecret: 'dummy_test_secret', locale: 'zh',
        });
        await wait(() => messages.some(m => m.type === 'prompt_ready'), 'initial readiness', 30_000);
        sent('check version', 'om_first');
        await wait(() => received().length === 1, 'first input received');
        if (mode === 'early-terminal' || mode === 'history') {
          await wait(() => messages.some(m => m.type === 'turn_terminal'
            && m.turnId === 'om_first' && m.status === 'completed'), 'native completion before adapter receipt');
          expect(messages.some(m => m.type === 'final_output' && m.turnId === 'om_first'
            && m.content === 'VERSION_EXECUTED_AND_REPLIED')).toBe(true);
        }
        if (mode === 'early-send') await wait(() => existsSync(sendMarker), 'send during adapter wait');
        if (mode !== 'history' && mode !== 'early-terminal') {
          await wait(() => logs.join('').includes('deferred 20000ms recheck queued'), 'adapter receipt exhausted');
        }
        sent('diagnose one', 'om_follow_one');
        sent('diagnose two', 'om_follow_two');
        if (mode === 'late-terminal' || mode === 'unknown') {
          await wait(() => logs.join('').includes('Holding 2 pending message(s) behind unconfirmed input delivery'),
            'unknown input holds successors');
          expect(received()).toHaveLength(1);
          if (mode === 'unknown') {
            // A quiet composer and another native turn's terminal must not
            // unlock this generation or replay the ambiguous first input.
            nativeEvent({ type: 'task_complete', turn_id: randomUUID(), last_agent_message: 'unrelated completion' });
            await delay(1_000);
            expect(received()).toHaveLength(1);
            expect(logs.join('')).not.toContain('Released input-delivery quarantine');
            nativeEvent({
              type: 'user_message', message: received()[0]!.text, turn_id: received()[0]!.nativeTurnId,
              images: [], local_images: [], text_elements: [],
            });
          }
          writeFileSync(release, 'complete');
        }
        await wait(() => received().length === 3, 'two successors delivered', mode === 'early-send' ? 55_000 : 12_000);
        await wait(() => messages.some(m => m.type === 'turn_terminal'
          && m.turnId === 'om_follow_two' && m.status === 'completed'), 'successors completed',
        mode === 'early-send' ? 35_000 : 12_000);
        expect(received()[0]!.text.startsWith('check version')).toBe(true);
        expect(received().slice(1).map(row => row.text)).toEqual(['diagnose one', 'diagnose two']);
        expect(messages.some(m => (m.type === 'user_notify' && m.kind === 'input_not_submitted')
          || (m.type === 'turn_terminal' && m.errorCode === 'submit_unconfirmed'))).toBe(false);
        expect(messages.filter(m => m.type === 'user_notify')).toEqual([]);
        if (mode === 'early-terminal' || mode === 'history') {
          expect(logs.join('')).not.toContain('Quarantined input delivery');
        } else {
          expect(logs.join('')).toContain('Released input-delivery quarantine');
        }
      } finally {
        const evidenceRoot = process.env.BOTMUX_ISOLATION_EVIDENCE;
        if (evidenceRoot) {
          mkdirSync(evidenceRoot, { recursive: true });
          writeFileSync(join(evidenceRoot, `${mode}.json`), JSON.stringify({
            mode, binary: binary ?? 'source-node-tsx', submissions: received(), messages,
            logs: logs.join(''), rollout: readFileSync(rollout, 'utf8'),
            sendMarkers: existsSync(sendMarker) ? readFileSync(sendMarker, 'utf8') : '',
          }, null, 2));
        }
        if (child.exitCode === null && child.signalCode === null) {
          const exited = new Promise<void>(done => child.once('exit', () => done()));
          child.kill('SIGKILL');
          await Promise.race([exited, delay(2_000)]);
        }
        // Only the private TMUX_TMPDIR is reachable; never touch host servers.
        for (const prefix of [[], workerTmuxArgs(env)]) {
          try { execFileSync('tmux', [...prefix, 'kill-server'], { env, stdio: 'ignore', timeout: 2_000 }); } catch { /* already gone */ }
        }
        rmSync(root, { recursive: true, force: true });
      }
    },
    80_000,
  );
});
