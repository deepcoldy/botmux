/**
 * Regression: a renamed bot's OLD name kept surfacing when it @-mentioned
 * another bot. Two independent leaks, both fixed here:
 *
 *   WRITER — updateBotOpenIdCrossRef only ever ADDED a name→open_id entry and
 *   never evicted the pre-rename alias. `bot-openids-<app>.json` accumulated
 *   every historical name for one open_id (observed live:
 *   ou_… → ['Claude2','Claude分身','Botmux开发者(Claude)']). lookupForeignBotName
 *   returns the FIRST name matching an open_id (insertion order = the OLDEST),
 *   so the stale name won. The fix drops any other name key pointing at the same
 *   open_id before recording the current one → one current name per open_id, and
 *   self-heals a polluted table on the next @ by the new name.
 *
 *   READER — resolveSiblingBotNameByUnionId resolves a sibling's CURRENT name
 *   from its tenant-stable union_id (stamped on every inbound event) → the one
 *   locally-configured sibling that learned that union_id → its bots-info.json
 *   botName, which the sibling's own daemon rewrites on every rename. This is the
 *   only source that reflects a rename when the renamed bot merely SENDS to us
 *   (no @ of it flows through us, so the by-name cross-ref never refreshes then).
 *
 * Run: pnpm vitest run test/bot-rename-name-refresh.test.ts
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  updateBotOpenIdCrossRef,
  readBotOpenIdCrossRef,
  resolveSiblingBotNameByUnionId,
} from '../src/im/lark/event-dispatcher.js';
import { readPeerCrossRef, __resetPeerCrossRefCacheForTest } from '../src/services/peer-cross-ref-store.js';
import { recordBotUnionId } from '../src/services/bot-union-ids-store.js';

const RECEIVER_APP = 'cli_receiver_rename_test';
const SIBLING_APP = 'cli_sibling_rename_test';
const SIBLING_OPEN_ID = 'ou_sibling_open_id'; // receiver-scoped open_id of the sibling
const SIBLING_UNION_ID = 'on_sibling_union_id';

let dataDir = '';
let prevBotsConfig: string | undefined;

/** Point loadBotConfigs() at a temp bots.json listing the receiver + one sibling. */
function seedBotConfigs(): void {
  const fp = join(dataDir, 'bots.json');
  writeFileSync(fp, JSON.stringify([
    { larkAppId: RECEIVER_APP, larkAppSecret: 's', cliId: 'claude-code', allowedUsers: ['ou_owner'] },
    { larkAppId: SIBLING_APP, larkAppSecret: 's', cliId: 'codex' },
  ]));
  process.env.BOTS_CONFIG = fp;
}

/** Write the shared, rename-fresh bots-info.json (each daemon rewrites its own row on rename). */
function seedBotsInfo(siblingName: string): void {
  writeFileSync(join(dataDir, 'bots-info.json'), JSON.stringify([
    { larkAppId: RECEIVER_APP, botOpenId: 'ou_receiver_self', botName: 'Receiver', cliId: 'claude-code' },
    { larkAppId: SIBLING_APP, botOpenId: 'ou_sibling_self', botName: siblingName, cliId: 'codex' },
  ]));
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'botmux-rename-refresh-'));
  process.env.SESSION_DATA_DIR = dataDir;
  prevBotsConfig = process.env.BOTS_CONFIG;
  __resetPeerCrossRefCacheForTest();
});

afterEach(() => {
  __resetPeerCrossRefCacheForTest();
  if (prevBotsConfig === undefined) delete process.env.BOTS_CONFIG;
  else process.env.BOTS_CONFIG = prevBotsConfig;
  rmSync(dataDir, { recursive: true, force: true });
});

describe('writer: updateBotOpenIdCrossRef evicts pre-rename name aliases', () => {
  it('keeps exactly one current name per open_id after a rename', () => {
    // Sibling was first seen as "OldName", then renamed to "NewName". Both names
    // are "known bot names" (bots-info.json) so both would match the guard.
    writeFileSync(join(dataDir, 'bots-info.json'), JSON.stringify([
      { larkAppId: RECEIVER_APP, botOpenId: 'ou_receiver_self', botName: 'Receiver', cliId: 'claude-code' },
      { larkAppId: SIBLING_APP, botOpenId: 'ou_sibling_self', botName: 'NewName', cliId: 'codex' },
      // OldName must also be a known name so the first-seen learn is allowed.
      { larkAppId: 'cli_ghost', botOpenId: null, botName: 'OldName', cliId: 'codex' },
    ]));

    // First contact under the old name.
    updateBotOpenIdCrossRef(dataDir, RECEIVER_APP, [
      { name: 'OldName', id: { open_id: SIBLING_OPEN_ID } },
    ]);
    expect(readPeerCrossRef(dataDir, RECEIVER_APP)).toEqual({ OldName: SIBLING_OPEN_ID });

    __resetPeerCrossRefCacheForTest();
    // After rename, the same open_id is @-mentioned under the new name.
    updateBotOpenIdCrossRef(dataDir, RECEIVER_APP, [
      { name: 'NewName', id: { open_id: SIBLING_OPEN_ID } },
    ]);

    __resetPeerCrossRefCacheForTest();
    const after = readPeerCrossRef(dataDir, RECEIVER_APP);
    // The stale alias is gone; only the current name maps to the open_id.
    expect(after).toEqual({ NewName: SIBLING_OPEN_ID });
    expect(after).not.toHaveProperty('OldName');
  });

  it('does not disturb a different bot that shares the mention batch', () => {
    writeFileSync(join(dataDir, 'bots-info.json'), JSON.stringify([
      { larkAppId: 'a', botOpenId: null, botName: 'Alpha', cliId: 'codex' },
      { larkAppId: 'b', botOpenId: null, botName: 'Beta', cliId: 'codex' },
      { larkAppId: 'c', botOpenId: null, botName: 'AlphaRenamed', cliId: 'codex' },
    ]));
    updateBotOpenIdCrossRef(dataDir, RECEIVER_APP, [
      { name: 'Alpha', id: { open_id: 'ou_alpha' } },
      { name: 'Beta', id: { open_id: 'ou_beta' } },
    ]);
    __resetPeerCrossRefCacheForTest();
    // Alpha renames; Beta untouched. Only Alpha's alias should be rewritten.
    updateBotOpenIdCrossRef(dataDir, RECEIVER_APP, [
      { name: 'AlphaRenamed', id: { open_id: 'ou_alpha' } },
    ]);
    __resetPeerCrossRefCacheForTest();
    expect(readPeerCrossRef(dataDir, RECEIVER_APP)).toEqual({
      AlphaRenamed: 'ou_alpha',
      Beta: 'ou_beta',
    });
  });

  it('readBotOpenIdCrossRef reflects the healed single name', () => {
    writeFileSync(join(dataDir, 'bots-info.json'), JSON.stringify([
      { larkAppId: 'x', botOpenId: null, botName: 'Nom', cliId: 'codex' },
      { larkAppId: 'y', botOpenId: null, botName: 'NomV2', cliId: 'codex' },
    ]));
    updateBotOpenIdCrossRef(dataDir, RECEIVER_APP, [{ name: 'Nom', id: { open_id: 'ou_nom' } }]);
    __resetPeerCrossRefCacheForTest();
    updateBotOpenIdCrossRef(dataDir, RECEIVER_APP, [{ name: 'NomV2', id: { open_id: 'ou_nom' } }]);
    __resetPeerCrossRefCacheForTest();
    const m = readBotOpenIdCrossRef(dataDir, RECEIVER_APP);
    // lowercased keys; only the current name survives.
    expect([...m.keys()]).toEqual(['nomv2']);
    expect(m.get('nomv2')).toBe('ou_nom');
  });
});

describe('reader: resolveSiblingBotNameByUnionId returns the CURRENT name (rename-proof)', () => {
  beforeEach(() => {
    seedBotConfigs();
    recordBotUnionId(dataDir, SIBLING_APP, SIBLING_UNION_ID);
  });

  it('resolves the fresh bots-info name via union_id even when the cross-ref is stale', () => {
    // The by-name cross-ref still holds the OLD name (never refreshed because the
    // renamed sibling merely SENDS to us — no @ of it flows through the receiver).
    writeFileSync(join(dataDir, `bot-openids-${RECEIVER_APP}.json`), JSON.stringify({ OldName: SIBLING_OPEN_ID }));
    // bots-info.json carries the CURRENT name (sibling's own daemon rewrote it).
    seedBotsInfo('CurrentName');
    __resetPeerCrossRefCacheForTest();

    expect(resolveSiblingBotNameByUnionId(dataDir, RECEIVER_APP, SIBLING_UNION_ID)).toBe('CurrentName');
  });

  it('returns undefined for an unknown/empty union_id (caller falls back to cross-ref)', () => {
    seedBotsInfo('CurrentName');
    expect(resolveSiblingBotNameByUnionId(dataDir, RECEIVER_APP, undefined)).toBeUndefined();
    expect(resolveSiblingBotNameByUnionId(dataDir, RECEIVER_APP, '')).toBeUndefined();
    expect(resolveSiblingBotNameByUnionId(dataDir, RECEIVER_APP, 'on_not_a_sibling')).toBeUndefined();
  });

  it('returns undefined when two configured siblings share a union_id (ambiguous → fail safe)', () => {
    // A second sibling learned the same union_id. Can't disambiguate → undefined.
    writeFileSync(join(dataDir, 'bots.json'), JSON.stringify([
      { larkAppId: RECEIVER_APP, larkAppSecret: 's', cliId: 'claude-code', allowedUsers: ['ou_owner'] },
      { larkAppId: SIBLING_APP, larkAppSecret: 's', cliId: 'codex' },
      { larkAppId: 'cli_sibling_two', larkAppSecret: 's', cliId: 'codex' },
    ]));
    recordBotUnionId(dataDir, 'cli_sibling_two', SIBLING_UNION_ID);
    seedBotsInfo('CurrentName');
    expect(resolveSiblingBotNameByUnionId(dataDir, RECEIVER_APP, SIBLING_UNION_ID)).toBeUndefined();
  });

  it('returns undefined when the sibling has no bots-info row yet (caller falls back)', () => {
    // union_id maps to a configured sibling, but bots-info.json has no name for it.
    writeFileSync(join(dataDir, 'bots-info.json'), JSON.stringify([
      { larkAppId: RECEIVER_APP, botOpenId: 'ou_receiver_self', botName: 'Receiver', cliId: 'claude-code' },
    ]));
    expect(resolveSiblingBotNameByUnionId(dataDir, RECEIVER_APP, SIBLING_UNION_ID)).toBeUndefined();
  });
});
