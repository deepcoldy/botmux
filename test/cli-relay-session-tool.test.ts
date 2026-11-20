/**
 * CLI boundary for `sandboxWithholdBotSecret`: inside a sandbox that cannot
 * read its bot's send-cred, `botmux history` / `botmux quoted` must hand the
 * call to the host through the outbox instead of calling Lark. This file plays
 * the host watcher.
 *
 * Run: npx vitest run --project unit test/cli-relay-session-tool.test.ts
 *      bun test test/cli-relay-session-tool.test.ts
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { spawnTsScript } from './helpers/ts-runner.js';

const CLI_PATH = join(__dirname, '..', 'src', 'cli.ts');
const APP = 'cli_relaytest';
const SID = 'sess_relay_tool';
const CAP = 'c'.repeat(64);

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

function setup(withCred: boolean) {
  const root = mkdtempSync(join(tmpdir(), 'botmux-cli-relay-tool-'));
  roots.push(root);
  const home = join(root, '.botmux');
  const dataDir = join(home, 'data');
  const outbox = join(dataDir, 'sandboxes', SID, 'outbox');
  mkdirSync(outbox, { recursive: true });
  writeFileSync(join(outbox, '.botmux-origin-capability.json'), JSON.stringify({ sessionId: SID, capability: CAP }), { mode: 0o600 });
  if (withCred) {
    mkdirSync(join(home, 'bots', APP), { recursive: true });
    writeFileSync(join(home, 'bots', APP, 'send-cred.json'), JSON.stringify({ larkAppId: APP, larkAppSecret: 'x' }));
  }
  return { root, dataDir, outbox };
}

function run(args: string[], s: { root: string; dataDir: string; outbox: string }) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawnTsScript(CLI_PATH, args, {
      env: {
        ...process.env,
        HOME: s.root,
        SESSION_DATA_DIR: s.dataDir,
        BOTMUX_SEND_RELAY: s.outbox,
        BOTMUX_SESSION_ID: SID,
        BOTMUX_LARK_APP_ID: APP,
        BOTMUX_CHAT_ID: 'oc_relay',
        BOTMUX_HOST_RELAY_AUTHORIZED: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = ''; let stderr = '';
    child.stdout!.on('data', (c) => { stdout += c; });
    child.stderr!.on('data', (c) => { stderr += c; });
    child.once('error', reject);
    child.once('close', (status) => resolve({ status, stdout, stderr }));
  });
}

/** Answer the first request; resolve with what the sandbox asked for. */
function mockHost(outbox: string, response: object) {
  let request: any;
  const timer = setInterval(() => {
    const req = readdirSync(outbox).find(n => n.endsWith('.req.json'));
    if (!req || request) return;
    request = JSON.parse(readFileSync(join(outbox, req), 'utf8'));
    writeFileSync(join(outbox, req.replace('.req.json', '.res.json')), JSON.stringify(response));
  }, 50);
  return { stop: () => clearInterval(timer), request: () => request };
}

describe('history / quoted through the outbox when send-cred is withheld', () => {
  it('history becomes a structured session-tool request and mirrors the host result', async () => {
    const s = setup(false);
    const host = mockHost(s.outbox, { code: 0, stdout: 'HOST-HISTORY', stderr: '' });
    try {
      const res = await run(['history', '--limit', '7'], s);
      expect(res.status, res.stderr).toBe(0);
      expect(res.stdout).toBe('HOST-HISTORY');
      expect(host.request()).toEqual({
        command: 'session-tool', tool: { tool: 'history', limit: 7 }, originCapability: CAP,
      });
    } finally { host.stop(); }
  }, 60_000);

  it('quoted brings relayed attachments into the outbox', async () => {
    const s = setup(false);
    const ph = 'botmux-session-tool://attachment/0';
    const host = mockHost(s.outbox, {
      code: 0, stderr: '',
      stdout: JSON.stringify({ attachments: [{ path: ph }] }),
      attachments: [{ placeholder: ph, name: 'pic.png', type: 'image', dataBase64: Buffer.from('IMG').toString('base64') }],
    });
    try {
      const res = await run(['quoted', 'om_quoted1'], s);
      expect(res.status, res.stderr).toBe(0);
      expect(host.request().tool).toEqual({ tool: 'quoted', messageId: 'om_quoted1' });
      const path = JSON.parse(res.stdout).attachments[0].path as string;
      expect(path.startsWith(s.outbox)).toBe(true);
      expect(readFileSync(path, 'utf8')).toBe('IMG');
    } finally { host.stop(); }
  }, 60_000);

  it('refuses options the relay cannot honour without writing a request', async () => {
    const s = setup(false);
    const res = await run(['history', '--query', 'secret'], s);
    expect(res.status).toBe(2);
    expect(readdirSync(s.outbox).filter(n => n.endsWith('.req.json'))).toEqual([]);
  }, 60_000);

  it('keeps the direct path when the sandbox can still read send-cred (default)', async () => {
    const s = setup(true);
    const host = mockHost(s.outbox, { code: 0, stdout: 'HOST-HISTORY', stderr: '' });
    try {
      const res = await run(['history', '--limit', '7'], s);
      expect(res.stdout).not.toBe('HOST-HISTORY');
      expect(host.request()).toBeUndefined();
      expect(existsSync(s.outbox)).toBe(true);
    } finally { host.stop(); }
  }, 60_000);
});
