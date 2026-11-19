import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { probeHostCredentialIsolationMechanism } from '../src/adapters/backend/sandbox.js';
import { STRUCTURED_SUBMIT_START_GRACE_MS } from '../src/services/codex-bridge-queue.js';
import { spawnNodeTsScript } from './helpers/ts-runner.js';
import type { DaemonToWorker, WorkerToDaemon } from '../src/types.js';

// Real Linux worker + bwrap + PTY, no mocks of the adapter, procfs, history,
// transcript reader or emit path. The provider is a hermetic Python fixture:
// no model, network, credentials, or IM transport is involved.
const supported = process.platform === 'linux'
  && process.getuid?.() !== 0
  && probeHostCredentialIsolationMechanism().mechanism === 'bwrap';
const delayedFinalMs = STRUCTURED_SUBMIT_START_GRACE_MS + 4_000;

describe.skipIf(!supported)('Codex correlation in a real Linux sandbox', () => {
  it('collects an unreadable process\'s reply after the pre-start lease without a false notice', async () => {
    const root = mkdtempSync('/tmp/bmx-codex-sandbox-');
    const work = join(root, 'work');
    const data = join(root, '.botmux', 'data');
    mkdirSync(work, { recursive: true });
    mkdirSync(data, { recursive: true });
    const bots = join(root, '.botmux', 'bots.json');
    writeFileSync(bots, JSON.stringify([{ larkAppId: 'app_fixture', larkAppSecret: '', apiOnly: true, cliId: 'codex' }]));
    const bin = join(work, 'codex');
    writeFileSync(bin, `#!/usr/bin/python3
import ctypes, datetime, json, os, re, sys, time, tty
if '--version' in sys.argv:
 print('codex-cli 0.163.0'); sys.exit(0)
libc = ctypes.CDLL(None)
libc.prctl(15, b'codex', 0, 0, 0)
assert libc.prctl(4, 0, 0, 0, 0) == 0
home = os.environ['CODEX_HOME']
sid = '019dd80d-d922-7a11-8339-0208d8c5b4ee'
now = lambda: datetime.datetime.now(datetime.timezone.utc).isoformat()
directory = os.path.join(home, 'sessions', '2026', '10', '26')
os.makedirs(directory, exist_ok=True)
rollout = open(os.path.join(directory, 'rollout-2026-10-26T11-56-33-' + sid + '.jsonl'), 'a', buffering=1)
def emit(kind, payload):
 rollout.write(json.dumps(dict(timestamp=now(), type=kind, payload=payload)) + '\\n')
def report(event, **fields):
 with open(os.path.join(os.getcwd(), 'report.jsonl'), 'a') as f:
  f.write(json.dumps(dict(event=event, **fields)) + '\\n')
report('ready', namespace=os.readlink('/proc/self/ns/mnt'), dumpable=libc.prctl(3, 0, 0, 0, 0))
tty.setraw(0)
sys.stdout.write('\\x1b[?2004h╭──────────────────────────────╮\\r\\n│ >_ OpenAI Codex (v0.163.0)   │\\r\\n│ model: fixture              │\\r\\n│ directory: /work            │\\r\\n╰──────────────────────────────╯\\r\\n› ')
sys.stdout.flush()
pending = ''
while True:
 pending += os.read(0, 65536).decode()
 match = re.search('\\x1b\\[200~([\\s\\S]*?)\\x1b\\[201~[\\r\\n]', pending)
 if not match: continue
 text = match.group(1)
 pending = pending[match.end():]
 with open(os.path.join(home, 'history.jsonl'), 'a') as f:
  f.write(json.dumps(dict(session_id=sid, text=text, ts=int(time.time()))) + '\\n')
 emit('event_msg', dict(type='task_started', turn_id='native-fixture'))
 emit('response_item', dict(type='message', role='user', content=[dict(type='input_text', text=text)]))
 report('submitted', correlated='botmux_input_id:' in text)
 sys.stdout.write('\\r\\nWorking fixture (esc to interrupt)\\r\\n'); sys.stdout.flush()
 # Deliberately exceed the real attribution lease. A collector that
 # never attaches raises the incident's warning before this terminal arrives.
 time.sleep(${delayedFinalMs / 1_000})
 emit('event_msg', dict(type='task_complete', turn_id='native-fixture', last_agent_message='sandbox-correlation-verified'))
 report('completed')
 sys.stdout.write('\\r\\n› '); sys.stdout.flush()
`, { mode: 0o755 });

    const sessionId = randomUUID();
    const messages: WorkerToDaemon[] = [];
    const logs: string[] = [];
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: root, SHELL: '/bin/sh', SESSION_DATA_DIR: data,
      BOTS_CONFIG: bots, BOTMUX_NO_CLAIM: '1' };
    for (const key of Object.keys(env)) {
      if (key.startsWith('BOTMUX_') && key !== 'BOTMUX_NO_CLAIM') delete env[key];
    }
    const child = spawnNodeTsScript(resolve('src/worker.ts'), [], {
      cwd: resolve('.'), env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    child.on('message', raw => messages.push(raw as WorkerToDaemon));
    child.stdout?.on('data', chunk => logs.push(String(chunk)));
    child.stderr?.on('data', chunk => logs.push(String(chunk)));
    const reports = () => {
      try { return readFileSync(join(work, 'report.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)); }
      catch { return []; }
    };
    const waitFor = async (predicate: () => boolean, timeout = delayedFinalMs + 30_000) => {
      const end = Date.now() + timeout;
      while (!predicate()) {
        if (Date.now() > end || child.exitCode !== null || child.signalCode !== null) {
          throw new Error(`Worker did not complete\n${logs.join('')}\n${JSON.stringify(messages)}`);
        }
        await new Promise(done => setTimeout(done, 50));
      }
    };
    try {
      child.send({ type: 'init', sessionId, chatId: 'oc_fixture', rootMessageId: 'om_fixture',
        workingDir: work, cliId: 'codex', cliPathOverride: bin, backendType: 'pty',
        sandbox: 'oncall', sandboxNetwork: true, apiOnly: true,
        loadedBotsConfigPath: bots, loadedBotsConfigProvenance: 'loaded',
        prompt: '<user_message>Run the isolated fixture</user_message>', turnId: 'om_input',
        larkAppId: 'app_fixture', larkAppSecret: '',
      } satisfies DaemonToWorker);
      await waitFor(() => reports().some(row => row.event === 'submitted'));
      const started = reports().find(row => row.event === 'ready');
      expect(started.dumpable).toBe(0);
      expect(started.namespace).not.toBe(readlinkSync('/proc/self/ns/mnt'));
      const pid = Number(execFileSync('pgrep', ['-f', bin], { encoding: 'utf8' }).trim().split('\n')
        .find(value => {
          try { return readFileSync(`/proc/${value}/comm`, 'utf8').trim() === 'codex'; }
          catch { return false; }
        }));
      expect(pid).toBeGreaterThan(0);
      expect(() => readlinkSync(`/proc/${pid}/fd/0`)).toThrow();
      expect(reports().find(row => row.event === 'submitted').correlated).toBe(true);
      await waitFor(() => messages.some(message => message.type === 'final_output'));
      expect(messages.filter(message => message.type === 'final_output')).toMatchObject([
        { turnId: 'om_input', content: 'sandbox-correlation-verified' },
      ]);
      expect(messages.some(message => message.type === 'user_notify'
        && /transcript|采集不到本轮/.test(message.message))).toBe(false);
      expect(messages).toContainEqual(expect.objectContaining({ type: 'native_input_consumed', turnId: 'om_input' }));
    } finally {
      const stopped = new Promise<void>(done => child.once('exit', () => done()));
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      await Promise.race([stopped, new Promise<void>(done => setTimeout(done, 5_000))]);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, delayedFinalMs + 50_000);
});
