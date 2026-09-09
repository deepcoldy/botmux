import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveSessionById } from '../src/cli/resolve-session-by-id.js';
import { UNMIGRATED_OPERATOR_HINT } from '../src/services/session-store-copy.js';

describe('resolveSessionById', () => {
  it('uses a 200 from the owning daemon and rejects an appId mismatch', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'resolve-session-'));
    const row = { sessionId: 's1', larkAppId: 'cli_other', chatId: 'oc_1', rootMessageId: 'om_1' };
    const result = await resolveSessionById('s1', {
      dataDir,
      env: { BOTMUX_LARK_APP_ID: 'cli_self' },
      findDaemon: () => ({ larkAppId: 'cli_self', ipcPort: 9 }),
      loadSecret: () => 'secret',
      fetchIpc: async () => new Response(JSON.stringify({ session: row }), { status: 200 }),
    });
    expect(result).toMatchObject({ ok: false, reason: 'app_id_mismatch' });
  });

  it('treats an answered 404 as authoritative absence', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'resolve-session-'));
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, 'sessions-cli_self.json'), JSON.stringify({
      s1: { sessionId: 's1', larkAppId: 'cli_self', status: 'active' },
    }));
    const result = await resolveSessionById('s1', {
      dataDir,
      env: { BOTMUX_LARK_APP_ID: 'cli_self' },
      findDaemon: () => ({ larkAppId: 'cli_self', ipcPort: 9 }),
      loadSecret: () => 'secret',
      fetchIpc: async () => new Response(JSON.stringify({ error: 'not_found' }), { status: 404 }),
    });
    expect(result).toMatchObject({ ok: false, reason: 'not_found' });
  });

  it('uses a 200 row when only leftover JSON exists on disk', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'resolve-session-'));
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, 'sessions-cli_self.json'), JSON.stringify({}));
    const row = {
      sessionId: 's1',
      larkAppId: 'cli_self',
      chatId: 'oc_1',
      rootMessageId: 'om_1',
      status: 'active',
    };
    const result = await resolveSessionById('s1', {
      dataDir,
      env: { BOTMUX_LARK_APP_ID: 'cli_self' },
      findDaemon: () => ({ larkAppId: 'cli_self', ipcPort: 9 }),
      loadSecret: () => 'secret',
      fetchIpc: async () => new Response(JSON.stringify({ session: row }), { status: 200 }),
    });
    expect(result).toEqual({ ok: true, source: 'daemon', session: row });
  });

  it('falls back to unmigrated when the daemon does not answer', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'resolve-session-'));
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, 'sessions-cli_self.json'), JSON.stringify({
      s1: { sessionId: 's1', larkAppId: 'cli_self', status: 'active' },
    }));
    const result = await resolveSessionById('s1', {
      dataDir,
      env: { BOTMUX_LARK_APP_ID: 'cli_self' },
      findDaemon: () => ({ larkAppId: 'cli_self', ipcPort: 9 }),
      loadSecret: () => 'secret',
      fetchIpc: async () => { throw new Error('connect ECONNREFUSED'); },
    });
    expect(result).toMatchObject({ ok: false, reason: 'unmigrated', message: UNMIGRATED_OPERATOR_HINT });
  });
});
