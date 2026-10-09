import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveSessionById } from '../src/cli/resolve-session-by-id.js';
import { UNMIGRATED_OPERATOR_HINT } from '../src/services/session-store-copy.js';
import { seedPersistedSessionRows } from './helpers/session-store-disk.js';

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

  it('without BOTMUX_LARK_APP_ID, a 404 from a non-owning daemon does not short-circuit the store', async () => {
    // Bot A is online and does not own s1; bot B (the owner) is offline and
    // its row lives only in B's SQLite store. The host shell has no appId.
    const dataDir = mkdtempSync(join(tmpdir(), 'resolve-session-'));
    const rowB = { sessionId: 's1', larkAppId: 'cli_b', chatId: 'oc_b', rootMessageId: 'om_b', status: 'active' };
    seedPersistedSessionRows(dataDir, 'cli_b', { s1: rowB });
    let asked = 0;
    const result = await resolveSessionById('s1', {
      dataDir,
      env: {},
      listDaemons: () => [{ larkAppId: 'cli_a', ipcPort: 9 }],
      loadSecret: () => 'secret',
      fetchIpc: async () => { asked += 1; return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 }); },
    });
    expect(asked).toBe(1);
    expect(result).toMatchObject({ ok: true, source: 'store', session: { sessionId: 's1', larkAppId: 'cli_b' } });
  });

  it('without BOTMUX_LARK_APP_ID and no online daemon, reads the store', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'resolve-session-'));
    seedPersistedSessionRows(dataDir, 'cli_b', {
      s1: { sessionId: 's1', larkAppId: 'cli_b', chatId: 'oc_b', rootMessageId: 'om_b', status: 'active' },
    });
    const result = await resolveSessionById('s1', {
      dataDir,
      env: {},
      listDaemons: () => [],
      loadSecret: () => 'secret',
      fetchIpc: async () => { throw new Error('must not be called'); },
    });
    expect(result).toMatchObject({ ok: true, source: 'store', session: { sessionId: 's1', larkAppId: 'cli_b' } });
  });

  it('without BOTMUX_LARK_APP_ID, an enumerated daemon that answers 200 wins over the store', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'resolve-session-'));
    seedPersistedSessionRows(dataDir, 'cli_b', {
      s1: { sessionId: 's1', larkAppId: 'cli_b', chatId: 'oc_stale', rootMessageId: 'om_b', status: 'active' },
    });
    const live = { sessionId: 's1', larkAppId: 'cli_b', chatId: 'oc_live', rootMessageId: 'om_b', status: 'active' };
    const result = await resolveSessionById('s1', {
      dataDir,
      env: {},
      listDaemons: () => [{ larkAppId: 'cli_a', ipcPort: 9 }, { larkAppId: 'cli_b', ipcPort: 10 }],
      loadSecret: () => 'secret',
      fetchIpc: async (port: number) => port === 10
        ? new Response(JSON.stringify({ session: live }), { status: 200 })
        : new Response(JSON.stringify({ error: 'not_found' }), { status: 404 }),
    });
    expect(result).toEqual({ ok: true, source: 'daemon', session: live });
  });

  it('without BOTMUX_LARK_APP_ID, a leftover JSON of a bot that no longer exists is not_found, not unmigrated', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'resolve-session-'));
    writeFileSync(join(dataDir, 'sessions-cli_gone.json'), JSON.stringify({
      s1: { sessionId: 's1', larkAppId: 'cli_gone', status: 'active' },
    }));
    const base = {
      dataDir,
      env: {},
      listDaemons: () => [],
      loadSecret: () => 'secret',
      fetchIpc: async () => { throw new Error('must not be called'); },
    };
    expect(await resolveSessionById('s1', { ...base, knownAppIds: new Set(['cli_a']) }))
      .toMatchObject({ ok: false, reason: 'not_found' });
    // Still configured → the file really is a pending migration.
    expect(await resolveSessionById('s1', { ...base, knownAppIds: new Set(['cli_gone']) }))
      .toMatchObject({ ok: false, reason: 'unmigrated' });
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
