/**
 * Retired configuration. `native` keys earlier versions wrote — the five of the
 * first round and the twenty of the Dashboard convergence — and the whole
 * `business` section must not stop a connection: the gateway parses the file
 * on every policy read and the Dashboard on every read and save. They are
 * dropped (whatever their value), never written back, and an unknown key is
 * still refused. The users of a retired `approverUsers` list keep operate and
 * approval rights at every moment: right after the upgrade and after any
 * Dashboard save.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseWecomConfig } from '../src/im/wecom/config/config.js';
import { WecomDashboardConfig } from '../src/dashboard/wecom/config.js';
import { wecomConfigId } from '../src/im/wecom/config/discovery.js';
import { emptyNativeCoreState, nativeCanApprove, nativeCapability } from '../src/im/wecom/gateway/native-core.js';

/** A value per retired key that its old validator rejected or that no longer means anything: the parse must not look at it. */
const RETIRED_NATIVE = {
  terminalBaseUrl: 'http://not-loopback.example',
  repositories: { 'bad name': 'relative/path' },
  console: 'https://elsewhere.example/',
  substitutePrompt: 42,
  feedbackButtonAlign: 'left',
  peerTrust: [{ peerId: 'not-hex' }],
  grantDelegateBots: 'not-a-list',
  restrictGrantCommands: 'yes',
  replyDelivery: 'carrier-pigeon',
  autoStartOnGroupJoin: 1,
  autoStartOnGroupJoinPrompt: { not: 'text' },
  autoStartOnGroupJoinSeed: 7,
  groupJoinCommandEnabled: 'on',
  groupJoinCommand: ['/x'],
  autoStartExcludedChats: 'chat',
  regularGroupMentionMode: 'never',
  slashCommands: { enabled: 'no', extra: true },
  privateCard: 'true',
  replyCardNativeCot: 1,
  replyStyle: { theme: 'neon' },
  askOptionLayout: 'grid',
};
const BUSINESS = { chatManagerEnabled: 'yes', steward: { unknown: true }, substituteMode: { enabled: true, targets: ['bob'] } };

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const base = { botId: 'retired-keys', secretEnv: 'FAKE_WECOM_SECRET', coreUrl: 'http://127.0.0.1:19443', allowedUsers: ['alice'] };

describe('a configuration with retired keys', () => {
  it('parses, without them, and keeps every other native key', () => {
    const parsed = parseWecomConfig({
      ...base,
      business: BUSINESS,
      native: { ...RETIRED_NATIVE, approverUsers: ['alice'], p2pOpen: true, summaryMemory: true },
    });
    expect(parsed.native).toEqual({ p2pOpen: true, summaryMemory: true });
    expect(parsed).not.toHaveProperty('business');
  });

  it('still refuses a native key no version ever had', () => {
    expect(() => parseWecomConfig({ ...base, native: { notAKey: true } })).toThrow('wecom_invalid_native_configuration');
    expect(() => parseWecomConfig({ ...base, native: { ...RETIRED_NATIVE, notAKey: true } })).toThrow('wecom_invalid_native_configuration');
  });

  it('makes the users of a retired approverUsers list allowed users, keeping order and dropping duplicates', () => {
    const parsed = parseWecomConfig({ ...base, allowedUsers: ['alice', 'bob'], native: { approverUsers: ['carol', 'alice', '*', '', 'dave', 'carol'] } });
    expect(parsed.allowedUsers).toEqual(['alice', 'bob', 'carol', 'dave']);
    expect(parsed.native).toEqual({});
    // Operate and approval follow from being an allowed user.
    expect(nativeCapability(emptyNativeCoreState(), parsed, { userId: 'carol', chatType: 'group', conversationId: 'g' }, 1)).toBe('operate');
    expect(nativeCanApprove(parsed, 'dave')).toBe(true);
  });

  it('loads in the Dashboard with the approvers among the allowed users, and every save writes the union and none of the retired keys', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wecom-retired-keys-'));
    dirs.push(root);
    const file = join(root, 'config.json');
    writeFileSync(file, JSON.stringify({
      ...base,
      coreUrl: 'http://127.0.0.1:19444',
      business: BUSINESS,
      native: { ...RETIRED_NATIVE, approverUsers: ['owner'], p2pOpen: false },
      managedCore: { botId: 'local_retired', cli: 'codex', backend: 'pty', workingDirectory: root, stateDir: join(root, 'core'), port: 19444 },
    }));
    const service = new WecomDashboardConfig(root);
    const id = wecomConfigId(file);
    const loaded = service.get(id) as any;
    expect(loaded.native).toEqual({ p2pOpen: false });
    // No administrator the page does not show.
    expect(loaded.allowedUsers).toEqual(['alice', 'owner']);
    expect(loaded).not.toHaveProperty('business');

    // A save of an unrelated native key.
    await service.patch(id, { revision: loaded.revision, native: { ...loaded.native, p2pOpen: true } });
    let written = JSON.parse(readFileSync(file, 'utf8'));
    expect(written.native).toEqual({ p2pOpen: true });
    expect(written.allowedUsers).toEqual(['alice', 'owner']);
    expect(written).not.toHaveProperty('business');
    expect(nativeCanApprove(parseWecomConfig(written), 'owner')).toBe(true);

    // A save of something outside native keeps the union too.
    const reloaded = service.get(id) as any;
    await service.patch(id, { revision: reloaded.revision, displayName: 'Renamed' });
    written = JSON.parse(readFileSync(file, 'utf8'));
    expect(written.allowedUsers).toEqual(['alice', 'owner']);
  });

  it('refuses a new message quota above 1000 from the Dashboard but keeps an existing one as it is', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wecom-quota-'));
    dirs.push(root);
    const file = join(root, 'config.json');
    writeFileSync(file, JSON.stringify({
      ...base,
      coreUrl: 'http://127.0.0.1:19446',
      native: { messageQuotaDefaultLimit: 5000 },
      managedCore: { botId: 'local_quota', cli: 'codex', backend: 'pty', workingDirectory: root, stateDir: join(root, 'core'), port: 19446 },
    }));
    const service = new WecomDashboardConfig(root);
    const id = wecomConfigId(file);
    const loaded = service.get(id) as any;
    expect(loaded.native.messageQuotaDefaultLimit).toBe(5000);
    await service.patch(id, { revision: loaded.revision, native: { ...loaded.native, p2pOpen: true } });
    expect(JSON.parse(readFileSync(file, 'utf8')).native).toEqual({ messageQuotaDefaultLimit: 5000, p2pOpen: true });
    const current = service.get(id) as any;
    await expect(service.patch(id, { revision: current.revision, native: { ...current.native, messageQuotaDefaultLimit: 1001 } })).rejects.toThrow('wecom_invalid_configuration');
    await service.patch(id, { revision: current.revision, native: { ...current.native, messageQuotaDefaultLimit: 1000 } });
    expect(JSON.parse(readFileSync(file, 'utf8')).native.messageQuotaDefaultLimit).toBe(1000);
  });
});
