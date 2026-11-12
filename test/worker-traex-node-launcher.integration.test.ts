/**
 * An npm-style TRAE install leaves an ordinary Node launcher alive above the
 * native CLI. Only the native CLI holds the rollout fd. This is deliberately
 * NOT a wrapperCli / Forge / bwrap test: treating only those shapes as launchers
 * strands the fresh worker on the Node pid and loses the native final.
 *
 * One copied Node image named "traex" gives the fixtures a real OS comm on
 * Linux and macOS; process.title / argv spoofing would not test that contract.
 * The copy is shared by both cases, not repeated for every worker.
 */
import { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmodSync, constants, copyFileSync, existsSync, mkdirSync, mkdtempSync,
  readFileSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readCmdline, readComm } from '../src/core/session-discovery.js';
import { listProcessOpenFiles } from '../src/utils/process-open-files.js';
import type { DaemonToWorker, WorkerToDaemon } from '../src/types.js';
import { killProcessTree } from './helpers/process-tree.js';
import { resolveNodeExecutable, spawnNodeTsScript } from './helpers/ts-runner.js';

const REPO = resolve(import.meta.dirname, '..');
const WAIT_MS = 20_000;
const TEST_MS = 70_000;
const POLLER_SETTLE_MS = 2_200;
const PROMPT = 'only-this-fake-traex-node-launcher-turn';
const REPLY = 'OWN NATIVE TRAE FINAL';
const SUBAGENT_REPLY = 'DO NOT DELIVER THE TRAE SUBAGENT FINAL';
const TURN_ID = 'om_traex_node_launcher';
const sleep = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
const shellQuote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;

type Final = Extract<WorkerToDaemon, { type: 'final_output' }>;
type Attestation = Extract<WorkerToDaemon, { type: 'local_process_attestation' }>;
interface Receipt { text: string; pid: number; argv: string[] }

function readJson<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined;
  // Fixture publications use rename; never admit a partially written receipt.
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

/**
 * A PTY can outlive a worker which exited unexpectedly. The worker's live tree
 * is killed with the shared helper first; these exact, fixture-owned roots
 * cover already-reparented launcher/native/subagent processes too.
 *
 * ChildProcess is just a handle here: killProcessTree signals its numeric pid
 * via process.kill, and its bounded wait does not require a waitpid relationship.
 * Check argv membership before touching a recorded pid, to reject PID reuse.
 * ps's tokenised argv fallback is used ONLY for cleanup on macOS; neither
 * native ownership nor transcript binding ever uses it.
 */
async function killFixtureRoot(pid: number, fixtureRoot: string): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 0) return;
  const argv = readCmdline(pid);
  if (!argv.some(arg => arg.startsWith(`${fixtureRoot}/`))) return;
  const handle = new ChildProcess();
  Object.assign(handle, { pid });
  await killProcessTree(handle, 100);
  handle.removeAllListeners();
}

const suite = process.platform === 'linux' || process.platform === 'darwin'
  ? describe.sequential : describe.skip;

suite('Worker + PTY: ordinary Node TRAE launcher ownership', () => {
    let imageRoot: string;
    let nativeImage: string;
    let node: string;

    beforeAll(() => {
      const executable = resolveNodeExecutable();
      if (!executable) throw new Error('This real-PTY regression requires Node on PATH (also under Bun).');
      node = realpathSync(executable);
      // Canonicalise /var -> /private/var on macOS so lsof paths compare exactly.
      imageRoot = realpathSync(mkdtempSync(join(tmpdir(), 'bmx-traex-node-image-')));
      nativeImage = join(imageRoot, 'traex');
      copyFileSync(node, nativeImage, constants.COPYFILE_FICLONE);
      chmodSync(nativeImage, 0o700);
    }, WAIT_MS);

    afterAll(() => {
      if (imageRoot) rmSync(imageRoot, { recursive: true, force: true });
    }, WAIT_MS);

    async function runScenario(mode: 'node-launcher' | 'direct-native'): Promise<void> {
      const root = realpathSync(mkdtempSync(join(tmpdir(), `bmx-traex-${mode}-`)));
      const home = join(root, 'home');
      const dataDir = join(home, '.botmux', 'data');
      const work = join(root, 'work');
      const traeHome = join(home, '.trae');
      const sessions = join(traeHome, 'cli', 'sessions', '2026', '11', '12');
      const bin = join(root, 'bin');
      const runtime = join(root, 'runtime');
      const temp = join(root, 'tmp');
      const nativeId = randomUUID();
      const subagentId = randomUUID();
      const sessionId = randomUUID();
      const rollout = join(sessions, `rollout-2026-11-12T00-00-00-${nativeId}.jsonl`);
      const subagentRollout = join(sessions, `rollout-2026-11-12T00-00-01-${subagentId}.jsonl`);
      const history = join(traeHome, 'cli', 'history.jsonl');
      const nativeScript = join(root, 'fake-native.cjs');
      const launcher = join(root, 'node-launcher');
      const direct = join(root, 'direct-native');
      const nativePidFile = join(root, 'native-pid.json');
      const launcherPidFile = join(root, 'launcher-pid.json');
      const subagentPidFile = join(root, 'subagent-pid.json');
      const loadedFile = join(root, 'loaded.json');
      const readyFile = join(root, 'release-ready');
      const receiptFile = join(root, 'receipt.json');
      const replayFile = join(root, 'replay-terminal');
      const replayedFile = join(root, 'replayed.json');
      const messages: WorkerToDaemon[] = [];
      const logs: string[] = [];
      let worker: ChildProcess | undefined;
      let workerError: Error | undefined;

      const waitFor = async (what: string, predicate: () => boolean, timeoutMs = WAIT_MS) => {
        const deadline = Date.now() + timeoutMs;
        while (!predicate()) {
          if (workerError || (worker && (worker.exitCode !== null || worker.signalCode !== null))
            || Date.now() >= deadline) {
            throw new Error(`${mode}: waiting for ${what}; ${workerError?.message ?? 'worker did not satisfy the assertion'}\n${logs.join('')}`);
          }
          await sleep(25);
        }
      };
      const finals = (): Final[] => messages.filter((m): m is Final => m.type === 'final_output');
      const attestations = (): Attestation[] =>
        messages.filter((m): m is Attestation => m.type === 'local_process_attestation');

      try {
        for (const dir of [dataDir, work, sessions, bin, runtime, temp]) mkdirSync(dir, { recursive: true });
        chmodSync(home, 0o700);
        // No plugin registry, auth.json, tokens, or inherited global config.
        writeFileSync(join(home, '.botmux', 'config.json'), JSON.stringify({
          dashboard: { codexRpcInput: false, autoUpgradeCodexSessions: false },
        }));
        writeFileSync(join(traeHome, '.coco-migrated'), '');
        writeFileSync(join(traeHome, '.coco-rollouts-migrated'), '');
        writeFileSync(history, '');
        // Fail closed if a future worker adds a service/backend capability
        // probe. These nonacting fixture commands cannot contact host servers.
        for (const name of ['systemd-run', 'systemctl', 'busctl', 'tmux']) {
          writeFileSync(join(bin, name), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
        }

        const fixture = {
          mode, nativeImage, nativeId, subagentId, rollout, subagentRollout, history,
          nativePidFile, subagentPidFile, loadedFile, readyFile, receiptFile,
          replayFile, replayedFile,
        };
        writeFileSync(nativeScript, `
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const cfg = ${JSON.stringify(fixture)};
const publish = (file, value) => {
  fs.writeFileSync(file + '.tmp', JSON.stringify(value));
  fs.renameSync(file + '.tmp', file);
};
const event = (type, payload) =>
  JSON.stringify({ timestamp: new Date().toISOString(), type, payload }) + '\\n';
const subagent = process.argv[2] === '--fixture-subagent';
publish(subagent ? cfg.subagentPidFile : cfg.nativePidFile, process.pid);
const sid = subagent ? cfg.subagentId : cfg.nativeId;
const fd = fs.openSync(subagent ? cfg.subagentRollout : cfg.rollout, 'a');
fs.writeSync(fd, event('session_meta', {
  id: sid, cwd: process.cwd(), thread_source: subagent ? 'subagent' : 'user',
  timestamp: new Date().toISOString(),
}));
const turn = 'native-' + sid + '-1';
const reply = subagent ? ${JSON.stringify(SUBAGENT_REPLY)} : ${JSON.stringify(REPLY)};
const terminal = () => event('event_msg', {
  type: 'task_complete', turn_id: turn, last_agent_message: reply, error: null,
});
const finish = text => {
  // TRAE legacy event_msg dialect, NOT a top-level response_item/user record.
  // Match the native turn id on both records so the real drainer/queue own it.
  fs.writeSync(fd, event('event_msg', {
    type: 'user_message', turn_id: turn, message: text, images: [], local_images: [],
  }) + terminal());
};
if (subagent) {
  let answered = false;
  setInterval(() => {
    if (answered || !fs.existsSync(cfg.receiptFile)) return;
    answered = true;
    finish(JSON.parse(fs.readFileSync(cfg.receiptFile, 'utf8')).text);
  }, 25);
} else {
  let descendant;
  if (cfg.mode === 'direct-native') {
    // Same real comm, different fd: unconditional BFS must not retarget a
    // direct native process to a deeper TRAE subagent.
    descendant = spawn(cfg.nativeImage, [__filename, '--fixture-subagent'], { stdio: 'ignore' });
    descendant.on('error', error => { console.error(error); process.exit(1); });
  }
  process.stdin.setRawMode(true);
  process.stdin.resume();
  const frame = model => model === 'loading'
    ? '\\x1b[2J\\x1b[HPreparing the native runtime...'
    : '\\x1b[2J\\x1b[H' + [
    'TraeCode CLI (v0.213.1)',
    '──────────────────────────────────────────────────────────',
    '❯ Ask TRAE CLI to do anything',
    '──────────────────────────────────────────────────────────',
    '  ' + model + ' · ' + process.cwd() + ' · Context 100% left',
    '  ? for shortcuts',
  ].map((row, index) => '\\x1b[' + (index + 1) + ';1H' + row).join('');
  process.stdout.write('\\x1b[?2004h' + frame('loading'));
  let loaded = false, ready = false, input = '', submits = 0, replayed = false;
  setInterval(() => {
    if (!loaded && (!descendant || fs.existsSync(cfg.subagentPidFile))) {
      loaded = true;
      publish(cfg.loadedFile, { pid: process.pid, ppid: process.ppid });
    }
    if (!ready && loaded && fs.existsSync(cfg.readyFile)) {
      ready = true;
      process.stdout.write(frame('fixture-model'));
    }
    if (submits && !replayed && fs.existsSync(cfg.replayFile)) {
      replayed = true;
      fs.writeSync(fd, terminal());
      publish(cfg.replayedFile, true);
    }
  }, 25);
  process.stdin.on('data', chunk => {
    input += chunk.toString();
    for (;;) {
      const match = /\\x1b\\[200~([\\s\\S]*?)\\x1b\\[201~[^\\x1b]*\\r/.exec(input);
      if (!match) return;
      input = input.slice(match.index + match[0].length);
      submits++;
      if (submits > 1) { console.error('duplicate native submit'); process.exit(2); }
      if (!ready) { console.error('submit before composer release'); process.exit(3); }
      const text = match[1];
      fs.appendFileSync(cfg.history, JSON.stringify({
        session_id: cfg.nativeId, text, ts: Date.now() / 1000,
      }) + '\\n');
      publish(cfg.receiptFile, { text, pid: process.pid, argv: process.argv.slice(2) });
      finish(text);
      // The desired reply never appears in PTY bytes: only the owned JSONL
      // bridge, not screen scraping, can produce final_output.
      process.stdout.write(frame('fixture-model'));
    }
  });
}
`);
        // env execs Node itself, so Linux does not retain the script basename
        // as comm (the parent must be an observable Node process on both OSes).
        writeFileSync(launcher, `#!/usr/bin/env node
const fs = require('node:fs');
const { spawn } = require('node:child_process');
fs.writeFileSync(${JSON.stringify(launcherPidFile)} + '.tmp', JSON.stringify(process.pid));
fs.renameSync(${JSON.stringify(launcherPidFile)} + '.tmp', ${JSON.stringify(launcherPidFile)});
// Ordinary persistent Node parent; acceleration/remote/RPC/wrapper modes absent.
const native = spawn(${JSON.stringify(nativeImage)},
  [${JSON.stringify(nativeScript)}, ...process.argv.slice(2)], { stdio: 'inherit' });
native.on('error', error => { console.error(error); process.exit(1); });
native.on('exit', (code, signal) => {
  console.error('fake native exited', code, signal);
  process.exit(code ?? 1);
});
`, { mode: 0o700 });
        // exec preserves the pane payload pid: no persistent launcher in this
        // arm. The shell exists only long enough to prepend the fixture script.
        writeFileSync(direct, `#!/bin/sh\nexec ${shellQuote(nativeImage)} ${shellQuote(nativeScript)} "$@"\n`, { mode: 0o700 });

        // Allowlist, not {...process.env}: no real Lark/native credentials,
        // NODE_OPTIONS preloads, plugin bindings, or user-home pointers.
        const env: NodeJS.ProcessEnv = {
          PATH: `${bin}${delimiter}${process.env.PATH ?? '/usr/bin:/bin'}`,
          HOME: home, USERPROFILE: home, TRAE_HOME: traeHome, TRAECLI_HOME: join(traeHome, 'cli'),
          SESSION_DATA_DIR: dataDir, BOTMUX_SESSION_ID: sessionId,
          BOTMUX_GLOBAL_CONFIG_FILE: join(home, '.botmux', 'config.json'),
          BOTMUX_PLUGIN_TEST_HOME: join(home, '.botmux'),
          XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local', 'share'),
          XDG_STATE_HOME: join(home, '.local', 'state'), XDG_CACHE_HOME: join(home, '.cache'),
          XDG_RUNTIME_DIR: runtime, DBUS_SESSION_BUS_ADDRESS: `unix:path=${join(runtime, 'absent-bus')}`,
          BOTMUX_FENCED_RUN: '1', BOTMUX_TIME_SCALE: '1', BACKEND_TYPE: 'pty',
          TMPDIR: temp, TMP: temp, TEMP: temp, TERM: 'xterm-256color', LANG: 'en_US.UTF-8',
          CLI_EXTRA_ARGS: '', LARK_APP_ID: 'app_test', LARK_APP_SECRET: 'synthetic-fixture-only',
        };
        worker = spawnNodeTsScript(resolve(REPO, 'src/worker.ts'), [], {
          cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        });
        worker.on('error', error => { workerError = error; });
        worker.on('message', m => messages.push(m as WorkerToDaemon));
        worker.stdout?.on('data', chunk => logs.push(chunk.toString()));
        worker.stderr?.on('data', chunk => logs.push(chunk.toString()));
        worker.send({
          type: 'init', sessionId, chatId: 'oc_test', rootMessageId: 'om_test',
          workingDir: work, cliId: 'traex',
          cliPathOverride: mode === 'node-launcher' ? launcher : direct,
          cliVersion: '0.213.1', backendType: 'pty', sandbox: 'off', readIsolation: false,
          codexRpcInput: false, larkToolBinding: false, apiOnly: true,
          promptInjection: 'none', replyDelivery: 'transcript',
          prompt: PROMPT, turnId: TURN_ID,
          larkAppId: 'app_test', larkAppSecret: 'synthetic-fixture-only',
        } satisfies DaemonToWorker);

        await waitFor('the native process holding its rollout', () => existsSync(loadedFile));
        const nativePid = readJson<number>(nativePidFile)!;
        expect(readComm(nativePid), 'fixture must have an actual native TRAE comm').toBe('traex');
        // A missing lsof/procfs capability is an explicit probe failure, never a
        // silent skip or a reason to accept history/cwd/global session fallback.
        await waitFor('OS enumeration of the native rollout fd (procfs/lsof)',
          () => listProcessOpenFiles(nativePid)?.includes(rollout) === true, 5_000);
        const subagentPid = readJson<number>(subagentPidFile);
        if (mode === 'node-launcher') {
          const launcherPid = readJson<number>(launcherPidFile)!;
          expect(readComm(launcherPid)).toBe('node');
          expect(launcherPid).not.toBe(nativePid);
          expect(readJson<{ ppid: number }>(loadedFile)?.ppid).toBe(launcherPid);
          const launcherFiles = listProcessOpenFiles(launcherPid);
          expect(launcherFiles, 'launcher fd enumeration must be available').toBeDefined();
          expect(launcherFiles).not.toContain(rollout);
        } else {
          expect(subagentPid).toBeGreaterThan(0);
          expect(subagentPid).not.toBe(nativePid);
          expect(readComm(subagentPid!)).toBe('traex');
          await waitFor('the deeper subagent holding its separate rollout fd',
            () => listProcessOpenFiles(subagentPid!)?.includes(subagentRollout) === true, 5_000);
          // Cross two 500ms launcher-resolver ticks with the child already
          // present; a naive always-descend fix cannot win a startup race here.
          await sleep(1_100);
        }
        expect(existsSync(receiptFile), 'loading composer must not consume input').toBe(false);
        writeFileSync(readyFile, 'release the initialized composer');
        await waitFor('one native submit receipt', () => existsSync(receiptFile));
        expect(readJson<Receipt>(receiptFile)).toMatchObject({ text: PROMPT, pid: nativePid });
        await waitFor('the exact native final_output', () =>
          finals().some(m => m.turnId === TURN_ID && m.content === REPLY));
        await waitFor('the native process attestation', () =>
          attestations().some(m => m.cliPid === nativePid));
        await waitFor('the owned native cli_session_id', () =>
          messages.some(m => m.type === 'cli_session_id' && m.cliSessionId === nativeId));

        // Exercise both fs.watch and the poller, including a repeated terminal
        // with the same native turn id, before asserting exactly-once delivery.
        writeFileSync(replayFile, 'replay the same native terminal');
        await waitFor('the duplicate terminal publication', () => existsSync(replayedFile));
        await sleep(POLLER_SETTLE_MS);
        expect(finals(), logs.join('')).toEqual([
          expect.objectContaining({ sessionId, turnId: TURN_ID, content: REPLY }),
        ]);
        expect(attestations().at(-1)?.cliPid).toBe(nativePid);
        const boundSessions = messages
          .filter((m): m is Extract<WorkerToDaemon, { type: 'cli_session_id' }> => m.type === 'cli_session_id')
          .map(m => m.cliSessionId);
        expect(new Set(boundSessions)).toEqual(new Set([nativeId]));
        if (subagentPid) {
          expect(attestations().map(m => m.cliPid)).not.toContain(subagentPid);
          expect(finals().map(m => m.content)).not.toContain(SUBAGENT_REPLY);
        }
        expect(worker.exitCode).toBeNull();
        expect(worker.signalCode).toBeNull();
        expect(messages.filter(m => m.type === 'user_notify'), logs.join('')).toEqual([]);
      } finally {
        if (worker) await killProcessTree(worker);
        for (const path of [launcherPidFile, nativePidFile, subagentPidFile]) {
          const pid = readJson<number>(path);
          if (pid) await killFixtureRoot(pid, root);
        }
        // Only after every fixture process/tree has been killed.
        rmSync(root, { recursive: true, force: true });
      }
    }

    it('collects one owned native final below an ordinary persistent Node launcher (acceleration off)',
      () => runScenario('node-launcher'), TEST_MS);
    it('keeps a direct native TRAE pid instead of retargeting to its TRAE subagent',
      () => runScenario('direct-native'), TEST_MS);
  });
