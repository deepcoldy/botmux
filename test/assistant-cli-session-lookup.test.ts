import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { spawnTsScript } from './helpers/ts-runner.js';
import { readRequestBodyJson } from './helpers/read-request-body.js';
import { managedOriginCapabilityPath, replaceManagedOriginCapabilityFile } from '../src/core/managed-origin-capability.js';
import { MANAGED_ORIGIN_PROOF_DOMAIN, writeManagedOriginAttestationProof, type ManagedOriginAttestation } from '../src/core/managed-origin-attestation.js';

const app = 'cli_assistant';
const sid = 'assistant-session';
const channel = '66'.repeat(32);
const capability = 'cd'.repeat(32);
const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const authPath = `/api/sessions/${sid}/auth-request`;
const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>(resolve => server.close(() => resolve()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** An assistant-mode pane: no daemon secret and no session store on disk, only
 *  this turn's managed-origin capability and a daemon that can attest it. */
async function assistantPane(customize?: (proof: ManagedOriginAttestation) => void) {
  const root = mkdtempSync(join(tmpdir(), 'assistant-cli-lookup-')); roots.push(root);
  const dataDir = join(root, '.botmux', 'data');
  mkdirSync(dataDir, { recursive: true });
  const requests: Array<{ url?: string; body: Record<string, unknown> }> = [];
  const server = createServer(async (req, res) => {
    const body = await readRequestBodyJson<Record<string, unknown>>(req, { strict: true }) ?? {};
    requests.push({ url: req.url, body });
    if (req.url === authPath) {
      return res.end(JSON.stringify({ ok: true, status: 'sent', delivery: 'dm' }));
    }
    const proof: ManagedOriginAttestation = { sessionId: sid, turnId: 'om_live', callerOpenId: 'ou_owner',
      larkAppId: app, requiresCodexAppLedger: false,
      session: { status: 'active', chatId: 'oc_p2p', rootMessageId: 'om_root', scope: 'chat', chatType: 'p2p',
        workingDir: root, ownerOpenId: 'ou_owner', ownerUnionId: 'on_owner' } };
    customize?.(proof);
    writeManagedOriginAttestationProof({ dataDir, proof: {
      ...proof, domain: MANAGED_ORIGIN_PROOF_DOMAIN, version: 1, nonce: body.nonce as string,
      channelId: channel, issuedAtMs: Date.now(),
    } });
    res.end('{}');
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  replaceManagedOriginCapabilityFile(managedOriginCapabilityPath(dataDir, sid, channel), JSON.stringify({
    sessionId: sid, channelId: channel, capability, turnId: 'om_live', larkAppId: app, ipcPort: port,
  }));
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: root, SESSION_DATA_DIR: dataDir, NO_COLOR: '1',
    BOTMUX_LARK_APP_ID: app, BOTMUX_SESSION_ID: sid, BOTMUX_ORIGIN_CHANNEL_ID: channel,
    BOTMUX_READ_ISOLATION: '1', BOTMUX_DAEMON_IPC_PORT: String(port) };
  const run = (args: string[]) => {
    const child = spawnTsScript(cli, args, {
      cwd: fileURLToPath(new URL('..', import.meta.url)), env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = ''; child.stdout!.on('data', data => { output += data; }); child.stderr!.on('data', data => { output += data; });
    return new Promise<{ code: number | null; output: string }>((resolve, reject) => {
      child.on('error', reject); child.on('close', code => resolve({ code, output }));
    });
  };
  return { env, run, requests };
}

describe('session-scoped CLI commands in an assistant-mode sandbox', () => {
  it('auth request locates its own session from the proof and reaches the daemon', async () => {
    const pane = await assistantPane();
    const result = await pane.run(['auth', 'request', '--scope', 'im:message:readonly', '--json']);
    expect(result.code, result.output).toBe(0);
    expect(result.output).not.toContain('未找到 session');
    const auth = pane.requests.find(r => r.url === authPath);
    expect(auth?.body).toMatchObject({ sessionId: sid, scopes: ['im:message:readonly'],
      originCapability: capability, originTurnId: 'om_live' });
  });

  it('does not route by a proof whose session is no longer active', async () => {
    const pane = await assistantPane(proof => { proof.session!.status = 'closed'; });
    const result = await pane.run(['auth', 'request', '--scope', 'im:message:readonly', '--json']);
    expect(result.code).not.toBe(0);
    expect(result.output).toContain('未找到 session');
    expect(pane.requests.some(r => r.url === authPath)).toBe(false);
  });

  it('does not borrow the proof for a session other than its own', async () => {
    const pane = await assistantPane();
    const result = await pane.run(['history', '--session-id', 'another-session']);
    expect(result.code).not.toBe(0);
    expect(result.output).toContain('未找到 session another-session');
    expect(pane.requests).toHaveLength(0);
  });
});
