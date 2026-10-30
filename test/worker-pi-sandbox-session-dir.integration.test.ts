/**
 * Real worker + a fake `pi` (a shell script that records its argv and probes
 * the filesystem it can see), checking how a Pi session's transcript dir is
 * wired under the allowlist file sandbox (`sandbox: "oncall"`):
 *
 *  - sandboxed: Pi gets `--session-dir ~/.pi/agent/sessions/botmux/<sid>`, can
 *    write there, and cannot read other sessions' transcripts in the shared
 *    `sessions/` tree;
 *  - sandboxed resume of a session that has history only in Pi's native cwd
 *    bucket: the history is copied into the session's own dir first;
 *  - unsandboxed: no `--session-dir` for a session that never ran sandboxed,
 *    and the session's own dir is kept once it has history there.
 *
 * Fully hermetic: HOME, SESSION_DATA_DIR and bots.json live in a temp dir. The
 * sandboxed cases need bwrap (user + mount + PID namespaces) and are skipped
 * where the host cannot run it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnNodeTsScript, spawnSyncTsEvalWithRepoImports } from './helpers/ts-runner.js';
import { rmSandboxScratch } from './helpers/rm-sandbox-scratch.js';
import { probeHostCredentialIsolationMechanism } from '../src/adapters/backend/sandbox.js';
import { piSessionDirName } from '../src/services/pi-transcript.js';
import type { DaemonToWorker } from '../src/types.js';

const bwrapRuntime = process.platform === 'linux' && (() => {
  const probe = probeHostCredentialIsolationMechanism();
  return probe.supported && probe.mechanism === 'bwrap';
})();

const SID = '7d1f3c2a-5b6e-4f80-9a1b-2c3d4e5f6a7b';

let child: ChildProcess | undefined;
let root: string | undefined;
afterEach(async () => {
  if (child && child.exitCode === null && child.signalCode === null) {
    const stopped = new Promise<void>(done => child!.once('exit', () => done()));
    child.kill('SIGKILL');
    await Promise.race([stopped, new Promise<void>(done => setTimeout(done, 5_000))]);
  }
  child = undefined;
  if (root) rmSandboxScratch(root);
  root = undefined;
});

function lab() {
  // Short path under /tmp: the sandbox binds these real paths.
  root = mkdtempSync('/tmp/pi-sbx-dir-');
  const home = root;
  const botmuxHome = join(home, '.botmux');
  const dataDir = join(botmuxHome, 'data');
  const workDir = join(home, 'work');
  const sessions = join(home, '.pi', 'agent', 'sessions');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(workDir, { recursive: true });
  const bots = join(botmuxHome, 'bots.json');
  writeFileSync(bots, JSON.stringify([{ larkAppId: 'app_pi', larkAppSecret: '', apiOnly: true, cliId: 'pi' }]));
  // Another session's transcript in the shared tree: must stay unreadable.
  const sibling = join(sessions, piSessionDirName('/elsewhere'), `2026-10-01T00-00-00-000Z_0b0b0b0b-0000-4000-8000-000000000000.jsonl`);
  mkdirSync(join(sibling, '..'), { recursive: true });
  writeFileSync(sibling, 'sibling-secret\n');
  // And another botmux session's own dir: the carve-out is this session only.
  const siblingOwn = join(sessions, 'botmux', '0c0c0c0c-0000-4000-8000-000000000000', `2026-10-01T00-00-00-000Z_0c0c0c0c-0000-4000-8000-000000000000.jsonl`);
  mkdirSync(join(siblingOwn, '..'), { recursive: true });
  writeFileSync(siblingOwn, 'sibling-own-secret\n');
  const report = join(workDir, 'fake-pi-report');
  const fakePi = join(workDir, 'fake-pi');
  writeFileSync(fakePi, `#!/bin/sh
dir=""
prev=""
for a in "$@"; do
  [ "$prev" = "--session-dir" ] && dir="$a"
  prev="$a"
done
{
  echo "argv:$*"
  echo "tar:$TAR_OPTIONS"
  if cat '${sibling}' >/dev/null 2>&1; then echo "sibling:READ"; else echo "sibling:HIDDEN"; fi
  if cat '${siblingOwn}' >/dev/null 2>&1; then echo "siblingOwn:READ"; else echo "siblingOwn:HIDDEN"; fi
  if [ -n "$dir" ] && echo probe > "$dir/probe-${SID}.jsonl" 2>/dev/null; then echo "own:WROTE"; else echo "own:NONE"; fi
} > '${report}.tmp' && mv '${report}.tmp' '${report}'
echo '> '
exec sleep 600
`, { mode: 0o755 });
  const env: NodeJS.ProcessEnv = {
    ...process.env, HOME: home, SHELL: '/bin/sh', SESSION_DATA_DIR: dataDir, BOTS_CONFIG: bots, BOTMUX_NO_CLAIM: '1',
  };
  for (const key of Object.keys(env)) if (key.startsWith('BOTMUX_') && key !== 'BOTMUX_NO_CLAIM') delete env[key];
  delete env.TMUX;
  delete env.TMUX_PANE;
  return {
    home, sessions, workDir, report, fakePi,
    ownDir: join(sessions, 'botmux', SID),
    start(opts: { sandbox: boolean; resume?: boolean; botEnv?: Record<string, string> }) {
      const logs: string[] = [];
      child = spawnNodeTsScript(resolve('src/worker.ts'), [], { env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      child.stdout?.on('data', chunk => logs.push(String(chunk)));
      child.stderr?.on('data', chunk => logs.push(String(chunk)));
      child.send({
        type: 'init', sessionId: SID, chatId: 'oc_pi', rootMessageId: 'om_pi', workingDir: workDir,
        cliId: 'pi', cliPathOverride: fakePi, backendType: 'pty', prompt: '',
        apiOnly: true, larkAppId: 'app_pi', larkAppSecret: '', ownerOpenId: 'ou_owner',
        loadedBotsConfigPath: bots, loadedBotsConfigProvenance: 'loaded', promptInjection: 'none',
        ...(opts.resume ? { resume: true, cliSessionId: SID } : {}),
        ...(opts.botEnv ? { env: opts.botEnv } : {}),
        ...(opts.sandbox ? { sandbox: 'oncall' } : {}),
      } satisfies DaemonToWorker);
      return logs;
    },
  };
}

async function readReport(path: string, logs: string[]): Promise<Record<string, string>> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      return Object.fromEntries(readFileSync(path, 'utf8').trim().split('\n')
        .map(line => [line.slice(0, line.indexOf(':')), line.slice(line.indexOf(':') + 1)]));
    }
    if (child?.exitCode !== null || child?.signalCode !== null) break;
    await new Promise(done => setTimeout(done, 50));
  }
  throw new Error(`fake pi never reported\n${logs.join('')}`);
}

describe('Pi transcript dir under the allowlist file sandbox (real worker)', () => {
  it.skipIf(!bwrapRuntime)('sandboxed: own session dir is passed and writable, sibling sessions are masked', async () => {
    const l = lab();
    const logs = l.start({ sandbox: true });
    const report = await readReport(l.report, logs);
    expect(report.argv).toContain(`--session-dir ${l.ownDir}`);
    expect(report.own).toBe('WROTE');
    expect(existsSync(join(l.ownDir, `probe-${SID}.jsonl`))).toBe(true);
    expect(report.sibling).toBe('HIDDEN');
    expect(report.siblingOwn).toBe('HIDDEN');
  }, 60_000);

  it.skipIf(!bwrapRuntime || process.getuid?.() !== 0)('sandboxed, root worker: the bot\'s own TAR_OPTIONS reaches the CLI extended with --no-same-owner', async () => {
    const l = lab();
    const logs = l.start({ sandbox: true, botEnv: { TAR_OPTIONS: '--warning=no-timestamp' } });
    const report = await readReport(l.report, logs);
    expect(report.tar).toBe('--warning=no-timestamp --no-same-owner');
  }, 60_000);

  it.skipIf(!bwrapRuntime)('sandboxed resume: history that only exists in the cwd bucket is copied into the own dir first', async () => {
    const l = lab();
    const bucket = join(l.sessions, piSessionDirName(l.workDir));
    mkdirSync(bucket, { recursive: true });
    const name = `2026-10-02T00-00-00-000Z_${SID}.jsonl`;
    writeFileSync(join(bucket, name), JSON.stringify({ type: 'session', version: 3, id: SID, cwd: l.workDir }) + '\n');
    const logs = l.start({ sandbox: true, resume: true });
    const report = await readReport(l.report, logs);
    expect(report.argv).toContain(`--session-dir ${l.ownDir}`);
    expect(readdirSync(l.ownDir)).toContain(name);
    expect(readFileSync(join(l.ownDir, name), 'utf8')).toContain(`"id":"${SID}"`);
  }, 60_000);

  it('unsandboxed: a session that never ran sandboxed keeps Pi\'s native layout', async () => {
    const l = lab();
    const logs = l.start({ sandbox: false });
    const report = await readReport(l.report, logs);
    expect(report.argv).toContain(`--session-id ${SID}`);
    expect(report.argv).not.toContain('--session-dir');
  }, 60_000);

  it('unsandboxed restart of a session that ran sandboxed keeps its own dir', async () => {
    const l = lab();
    mkdirSync(l.ownDir, { recursive: true });
    writeFileSync(join(l.ownDir, `2026-10-03T00-00-00-000Z_${SID}.jsonl`),
      JSON.stringify({ type: 'session', version: 3, id: SID, cwd: l.workDir }) + '\n');
    const logs = l.start({ sandbox: false, resume: true });
    const report = await readReport(l.report, logs);
    expect(report.argv).toContain(`--session-dir ${l.ownDir}`);
  }, 60_000);

  it('unsandboxed resume after a /cd: the new cwd\'s native history is copied into the own dir it keeps using', async () => {
    const l = lab();
    const cwdA = join(l.home, 'cwd-a');
    mkdirSync(cwdA, { recursive: true });
    // Ran sandboxed in A: the own dir has A's file only.
    mkdirSync(l.ownDir, { recursive: true });
    writeFileSync(join(l.ownDir, `2026-10-01T00-00-00-000Z_${SID}.jsonl`),
      JSON.stringify({ type: 'session', version: 3, id: SID, cwd: cwdA }) + '\n');
    // Then, sandbox off, `/cd` to the working dir: Pi filed that cwd natively.
    const bucket = join(l.sessions, piSessionDirName(l.workDir));
    mkdirSync(bucket, { recursive: true });
    const name = `2026-10-02T00-00-00-000Z_${SID}.jsonl`;
    writeFileSync(join(bucket, name), JSON.stringify({ type: 'session', version: 3, id: SID, cwd: l.workDir }) + '\n');
    const logs = l.start({ sandbox: false, resume: true });
    const report = await readReport(l.report, logs);
    expect(report.argv).toContain(`--session-dir ${l.ownDir}`);
    expect(readdirSync(l.ownDir)).toContain(name);
  }, 60_000);

  it('the resume command a closed card or local terminal offers points at the own dir once it has history', () => {
    const l = lab();
    const resumeCommand = () => {
      const r = spawnSyncTsEvalWithRepoImports(`
        import { createPiAdapter } from './src/adapters/cli/pi.js';
        process.stdout.write(String(createPiAdapter('/bin/pi', () => '/x.js').buildResumeCommand?.({ sessionId: ${JSON.stringify(SID)} })));
      `, { cwd: resolve('.'), env: { ...process.env, HOME: l.home }, encoding: 'utf8', timeout: 60_000 });
      expect(r.status, String(r.stderr)).toBe(0);
      return String(r.stdout);
    };
    expect(resumeCommand()).toBe(`pi --session-id ${SID}`);
    mkdirSync(l.ownDir, { recursive: true });
    writeFileSync(join(l.ownDir, `2026-10-03T00-00-00-000Z_${SID}.jsonl`),
      JSON.stringify({ type: 'session', version: 3, id: SID, cwd: l.workDir }) + '\n');
    expect(resumeCommand()).toBe(`pi --session-id '${SID}' --session-dir '${l.ownDir}'`);
  }, 60_000);
});
