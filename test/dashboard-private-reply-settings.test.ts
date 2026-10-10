import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../src/config.js';
import { setLarkAppId, startIpcServer, type IpcServerHandle } from '../src/core/dashboard-ipc-server.js';
import { readRoleReplyPrivately, readRolePrivateReplyNotice } from '../src/core/role-resolver.js';

const previousDir = config.session.dataDir;
const dir = mkdtempSync(join(tmpdir(), 'private-reply-settings-'));
let server: IpcServerHandle;
let base: string;
beforeAll(async () => {
  config.session.dataDir = dir;
  setLarkAppId('cli_private_settings');
  server = await startIpcServer({ host: '127.0.0.1', port: 0 });
  base = `http://127.0.0.1:${server.port}`;
});
afterAll(async () => {
  await server.close();
  config.session.dataDir = previousDir;
  rmSync(dir, { recursive: true, force: true });
});
const save = (chatId: string, body: unknown) => fetch(`${base}/api/roles/${chatId}`, {
  method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});
const read = async (chatId: string) => (await fetch(`${base}/api/roles/${chatId}`)).json();

describe('group private-reply settings API', () => {
  it('round-trips settings without requiring a role, preserves them on role edits, and isolates groups/bots', async () => {
    expect(await read('oc_roundtrip')).toMatchObject({ replyPrivately: false, privateReplyNotice: '', hasRole: false });
    expect((await save('oc_roundtrip', { replyPrivately: true, privateReplyNotice: '  已私聊发送  ' })).status).toBe(200);
    expect(await read('oc_roundtrip')).toMatchObject({ replyPrivately: true, privateReplyNotice: '已私聊发送', hasRole: false });
    await save('oc_roundtrip', { content: 'group role', injectMode: 'every', dispatchCompletionEnabled: true });
    expect(await read('oc_roundtrip')).toMatchObject({ replyPrivately: true, privateReplyNotice: '已私聊发送', injectMode: 'every', dispatchCompletionEnabled: true });
    expect(await read('oc_other')).toMatchObject({ replyPrivately: false, privateReplyNotice: '' });
    expect(readRoleReplyPrivately('cli_other', 'oc_roundtrip')).toBe(false);
    await save('oc_roundtrip', { replyPrivately: false, privateReplyNotice: '' });
    expect(await read('oc_roundtrip')).toMatchObject({ replyPrivately: false, privateReplyNotice: '', content: 'group role' });
  });

  it('rejects invalid mixed updates before changing existing settings', async () => {
    await save('oc_validation', { replyPrivately: true, privateReplyNotice: 'saved' });
    for (const patch of [
      { replyPrivately: 'false', privateReplyNotice: 'changed' },
      { replyPrivately: false, privateReplyNotice: 42 },
      { replyPrivately: false, privateReplyNotice: 'x'.repeat(501) },
    ]) {
      expect((await save('oc_validation', patch)).status).toBe(400);
      expect(readRoleReplyPrivately('cli_private_settings', 'oc_validation')).toBe(true);
      expect(readRolePrivateReplyNotice('cli_private_settings', 'oc_validation')).toBe('saved');
    }
  });
});
