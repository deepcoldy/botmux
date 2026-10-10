import { describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildBotWorkerEnv, buildSessionChildEnv, botInjectedEnv } from '../src/core/env-policy.js';
import { strictPaneCommand } from '../src/adapters/backend/strict-env.js';
import { startOutboxWatcher } from '../src/adapters/backend/sandbox.js';
import { RELAY_ORIGIN_CAPABILITY_BASENAME } from '../src/core/managed-origin-capability.js';
import { seedPersistedSessionRows } from './helpers/session-store-disk.js';
import { nodeTsRunnerPrefix } from './helpers/ts-runner.js';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const policy = { mode: 'strict' as const };
function prepare() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'strict-send-')));
  const data = join(root, 'data'); const codex = join(root, 'bots/cli_strict_probe/codex');
  mkdirSync(data); mkdirSync(codex, { recursive: true });
  writeFileSync(join(codex, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'own-file-auth' }), { mode: 0o600 });
  const bots = join(root, 'bots.json');
  writeFileSync(bots, JSON.stringify([{ larkAppId: 'cli_strict_probe', larkAppSecret: 'own-im-secret', cliId: 'codex', allowedUsers: ['ou_owner'] }]), { mode: 0o600 });
  seedPersistedSessionRows(data, 'cli_strict_probe', { 'strict-send-probe': {
    sessionId: 'strict-send-probe', chatId: 'oc_strict_probe', rootMessageId: 'om_strict_probe',
    scope: 'chat', chatType: 'group', status: 'active', title: 'probe', ownerOpenId: 'ou_owner',
    createdAt: new Date().toISOString(), larkAppId: 'cli_strict_probe', cliId: 'codex', workingDir: root,
  } });
  const workerEnv = buildBotWorkerEnv({ PATH: process.env.PATH, HOME: root, SESSION_DATA_DIR: data,
    HOUSEHOLD_API_CREDENTIAL: 'household-sentinel', FINANCE_SERVICE_SECRET: 'finance-sentinel',
    SIBLING_AUTH: 'sibling-sentinel', LARK_APP_SECRET: 'daemon-sentinel' }, policy);
  const env = { ...buildSessionChildEnv(workerEnv, policy), ...botInjectedEnv({ OPENAI_API_KEY: 'own-model-auth' }, policy),
    BOTS_CONFIG: bots, CODEX_HOME: codex, BOTMUX_LARK_APP_ID: 'cli_strict_probe',
    BOTMUX_SESSION_ID: 'strict-send-probe', BOTMUX_CHAT_ID: 'oc_strict_probe', BOTMUX_ROOT_MESSAGE_ID: 'om_strict_probe',
    BOTMUX_OWNER_OPEN_ID: 'ou_owner', __OWNER_OPEN_ID: 'ou_owner', BOTMUX_NO_CLAIM: '1',
    BOTMUX_SESSION_SCOPE: 'chat' };
  return { root, env };
}
async function runCli(script: string, args: string[], env: Record<string, string | undefined>, cwd: string) {
  const runner = nodeTsRunnerPrefix();
  // Load the repo's tsx helper before entering the independent work directory.
  const bootstrap = `process.chdir(${JSON.stringify(cwd)}); process.argv = ${JSON.stringify([runner.command, script, ...args])}; await import(${JSON.stringify(pathToFileURL(script).href)});`;
  const [command, ...argv] = strictPaneCommand(runner.command, [...runner.prefixArgs, '--input-type=module', '--eval', bootstrap], { cwd, cols: 80, rows: 24, env: env as Record<string, string>, strictEnv: true });
  const child = spawn(command, argv, { cwd: process.cwd(), env: { PATH: process.env.PATH, HOUSEHOLD_API_CREDENTIAL: 'outer-sentinel' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', data => stdout += String(data)); child.stderr.on('data', data => stderr += String(data));
  try {
    await vi.waitFor(() => expect(child.exitCode !== null || child.signalCode !== null, stderr).toBe(true), { timeout: 20000 });
    expect(child.exitCode, stderr).toBe(0);
    return stdout;
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await new Promise<void>(resolve => child.once('exit', () => resolve()));
    }
  }
}
function captured(stdout: string, prefix: string) {
  const row = stdout.split('\n').find(line => line.startsWith(prefix));
  expect(row, stdout).toBeTruthy();
  return JSON.parse(row!.slice(prefix.length));
}

describe('strict environment retains actual Botmux send paths', () => {
  it('real CLI resolves own registry/identity/auth and routes a mocked provider send', async () => {
    const { root, env } = prepare();
    try {
      const stdout = await runCli(join(process.cwd(), 'test/fixtures/strict-env-send-capture.ts'), ['send', '--no-mention', '--top-level', 'strict message'], env, root);
      for (const ok of Object.values(captured(stdout, 'CAPTURE_RUNTIME='))) expect(ok).toBe(true);
      expect(captured(stdout, 'CAPTURE_AUTH=')).toEqual({ own: true });
      expect(captured(stdout, 'CAPTURE_TARGET=')).toEqual({ own: true, text: true });
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 30000);
  it('real CLI copies a relative attachment to relay and host re-exec keeps only owning context', async () => {
    const { root, env } = prepare();
    const outbox = join(root, 'outbox'); mkdirSync(outbox);
    const token = 'c'.repeat(64); const result = join(root, 'captured.json');
    writeFileSync(join(outbox, RELAY_ORIGIN_CAPABILITY_BASENAME), JSON.stringify({ token }), { mode: 0o600 });
    writeFileSync(join(root, 'attachment.txt'), 'attachment-bytes');
    const hostFixture = join(root, 'relay-host.mjs');
    writeFileSync(hostFixture, `import {readFileSync,writeFileSync} from 'node:fs';
const args=process.argv.slice(2); const value=k=>args[args.indexOf(k)+1]; const e=process.env;
writeFileSync(${JSON.stringify(result)},JSON.stringify({
 command:args[0], session:value('--session-id'), attachment:readFileSync(value('--files'),'utf8'), content:readFileSync(value('--content-file'),'utf8'),
 owner:e.BOTMUX_OWNER_OPEN_ID==='ou_owner'&&e.__OWNER_OPEN_ID==='ou_owner',
 registry:e.BOTS_CONFIG===${JSON.stringify(env.BOTS_CONFIG)}, home:e.CODEX_HOME===${JSON.stringify(env.CODEX_HOME)},
 origin:e.BOTMUX_HOST_RELAY_AUTHORIZED==='1'&&e.BOTMUX_TURN_ID==='turn-probe',
 unknownAbsent:!('HOUSEHOLD_API_CREDENTIAL' in e)&&!('FINANCE_SERVICE_SECRET' in e)&&!('SIBLING_AUTH' in e),
 daemonAbsent:!('LARK_APP_SECRET' in e), relayAbsent:!('BOTMUX_SEND_RELAY' in e), attachmentStaged:value('--files').includes('/relay-staging/')
})); console.log('relay accepted by fixture');`);
    let authorized = false;
    // This is the real relay watcher. Its downstream send process is a local
    // capture fixture, so it cannot post to any IM transport.
    const stop = startOutboxWatcher(outbox, env, 'strict-send-probe', { cliPath: hostFixture,
      authorize: claim => { authorized = claim.capability === token; return authorized ? { ok: true, origin: { turnId: 'turn-probe' } } : { ok: false, error: 'wrong capability' }; } });
    try {
      await runCli(join(process.cwd(), 'src/cli.ts'), ['send', '--no-mention', '--files', 'attachment.txt', 'strict message'], { ...env, BOTMUX_SEND_RELAY: outbox }, root);
      expect(authorized).toBe(true); expect(existsSync(result)).toBe(true);
      const report = JSON.parse(readFileSync(result, 'utf8'));
      expect(report).toMatchObject({ command: 'send', session: 'strict-send-probe', attachment: 'attachment-bytes', content: 'strict message' });
      for (const key of ['owner','registry','home','origin','unknownAbsent','daemonAbsent','relayAbsent','attachmentStaged']) expect(report[key], key).toBe(true);
    } finally { stop(); rmSync(root, { recursive: true, force: true }); }
  }, 30000);
});
