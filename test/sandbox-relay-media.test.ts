/**
 * CLI boundary regression for media typing across the sandbox send relay.
 *
 * Inside the sandbox `botmux send --images a.png --files b.txt` used to copy
 * BOTH kinds into the outbox under `attachments`, so the host watcher could
 * only rebuild `--files` and an explicitly-sent image rendered in Lark as a
 * file attachment. The sandbox child must now serialise the two kinds
 * separately (`images` vs `attachments`) and copy the bytes under the exact
 * basenames it reports — the host side trusts only those basenames.
 */
import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, watch, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnTsScript } from './helpers/ts-runner.js';
import { RELAY_ORIGIN_CAPABILITY_BASENAME, replaceManagedOriginCapabilityFile } from '../src/core/managed-origin-capability.js';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const posixIt = process.platform === 'win32' ? it.skip : it;

posixIt('serialises --images and --files as separate outbox fields with the bytes staged', async () => {
  const root = mkdtempSync(join(tmpdir(), 'botmux-relay-media-'));
  const relay = join(root, 'relay');
  mkdirSync(relay);
  const channel = 'ab'.repeat(32);
  replaceManagedOriginCapabilityFile(join(relay, RELAY_ORIGIN_CAPABILITY_BASENAME), JSON.stringify({
    sessionId: 'sid_relay_media', channelId: channel, capability: 'cd'.repeat(32),
    turnId: 'om_relay_media', ipcPort: 7952,
  }));
  const imagePath = join(root, 'chart.png');
  const filePath = join(root, 'notes.txt');
  writeFileSync(imagePath, 'PNG-BYTES');
  writeFileSync(filePath, 'plain text notes');
  writeFileSync(join(root, 'bots.json'), JSON.stringify([
    { larkAppId: 'cli_media_test', larkAppSecret: 'test-secret', cliId: 'codex' },
  ]));
  let acceptRequest!: (file: string) => void;
  const request = new Promise<string>(resolve => { acceptRequest = resolve; });
  const watcher = watch(relay, (_event, file) => {
    if (file?.toString().endsWith('.req.json')) acceptRequest(file.toString());
  });
  const child = spawnTsScript(cli, [
    'send', '--images', imagePath, '--files', filePath, '--no-mention', 'see attachments',
  ], {
    env: {
      PATH: process.env.PATH, SESSION_DATA_DIR: join(root, 'data'), BOTS_CONFIG: join(root, 'bots.json'),
      BOTMUX_SESSION_ID: 'sid_relay_media', BOTMUX_TURN_ID: 'om_relay_media', BOTMUX_LARK_APP_ID: 'cli_media_test',
      BOTMUX_SEND_RELAY: relay, BOTMUX_ORIGIN_CHANNEL_ID: channel,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = ''; let stderr = '';
  child.stdout!.on('data', chunk => { stdout += chunk; });
  child.stderr!.on('data', chunk => { stderr += chunk; });
  const closed = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject); child.once('close', resolve);
  });
  try {
    const file = await Promise.race([request, closed.then(() => { throw new Error(`relay exited before request: ${stderr}`); })]);
    const payload = JSON.parse(readFileSync(join(relay, file), 'utf8')) as {
      images: string[]; attachments: string[]; flags: string[];
    };
    expect(payload.images).toHaveLength(1);
    expect(payload.attachments).toHaveLength(1);
    // The image must travel under images, never be merged into attachments.
    expect(payload.images[0]).toMatch(/^[a-f0-9]+-[a-f0-9]+-chart\.png$/);
    expect(payload.attachments[0]).toMatch(/^[a-f0-9]+-[a-f0-9]+-notes\.txt$/);
    expect(payload.attachments.some(name => name.endsWith('chart.png'))).toBe(false);
    expect(readFileSync(join(relay, payload.images[0]), 'utf8')).toBe('PNG-BYTES');
    expect(readFileSync(join(relay, payload.attachments[0]), 'utf8')).toBe('plain text notes');
    // Only the request + the two media files should be staged (no leaked sandbox paths).
    const staged = readdirSync(relay);
    expect(staged).toContain(payload.images[0]);
    expect(staged).toContain(payload.attachments[0]);
    writeFileSync(join(relay, file.replace('.req.json', '.res.json')),
      JSON.stringify({ code: 0, stdout: '{"success":true,"messageId":"om_relay_media"}', stderr: '' }));
    expect(await closed, stderr).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ success: true, messageId: 'om_relay_media' });
  } finally {
    watcher.close();
    if (child.exitCode === null) child.kill();
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
