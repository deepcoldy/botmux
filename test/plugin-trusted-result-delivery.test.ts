import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  consumeTrustedResultDeliverySources,
  MAX_TRUSTED_DELIVERY_FILE_BYTES,
  parseTrustedResultDelivery,
  sendTrustedDeliveryIpcWithBackpressure,
  TrustedResultDeliverySerialQueue,
  trustedResultTerminalObservation,
} from '../src/core/plugins/mcp/trusted-result-delivery.js';
import { PluginResultArtifactStore } from '../src/core/plugins/mcp/result-artifact-store.js';
import { buildTrustedResultDeliveryCard } from '../src/im/lark/trusted-result-delivery-card.js';

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'botmux-delivery-'));
  const outbound = join(home, 'outbound');
  mkdirSync(outbound);
  return { home, outbound };
}

describe('trusted plugin result delivery', () => {
  it('snapshots regular outbound files and consumes them only after persistence', () => {
    const { home, outbound } = fixture();
    const source = join(outbound, 'report.pdf');
    writeFileSync(source, 'report');
    const delivery = parseTrustedResultDelivery({
      schemaVersion: 1,
      deliveryId: 'report_20261014',
      markdown: '完成',
      files: [{ path: 'report.pdf' }],
    }, home);
    expect(delivery.files?.[0].name).toBe('report.pdf');
    expect(realpathSync(delivery.files![0].sourcePath)).toBe(realpathSync(source));
    expect(delivery.files?.[0].data.toString()).toBe('report');
    expect(existsSync(source)).toBe(true);

    const store = new PluginResultArtifactStore({ dataDir: join(home, 'data') });
    const artifact = store.create({
      pluginId: 'reference-reporter', delivery, ownerUnionId: 'on_requester123',
      ownerOpenId: 'ou_requester', larkAppId: 'cli_fixture', sessionId: 'session_fixture', turnId: 'om_fixture',
    });
    consumeTrustedResultDeliverySources(delivery);
    expect(existsSync(source)).toBe(false);
    const manifest = store.redeem(artifact.viewToken, 'on_requester123');
    expect(store.readSummary(manifest)).toBe('完成');
    expect(readFileSync(store.filePath(manifest, 0).path, 'utf8')).toBe('report');
  });

  it('rejects symlinks, paths outside outbound, and oversized files without consuming sources', () => {
    const { home, outbound } = fixture();
    const outside = join(home, 'secret.txt');
    writeFileSync(outside, 'secret');
    symlinkSync(outside, join(outbound, 'linked.txt'));
    expect(() => parseTrustedResultDelivery({ schemaVersion: 1, deliveryId: 'report_20261015', files: [{ path: outside }] }, home))
      .toThrow(/outside_plugin_home/);
    expect(() => parseTrustedResultDelivery({ schemaVersion: 1, deliveryId: 'report_20261016', files: [{ path: 'linked.txt' }] }, home))
      .toThrow(/outside_plugin_home|file_type/);
    const large = join(outbound, 'large.bin');
    writeFileSync(large, Buffer.alloc(MAX_TRUSTED_DELIVERY_FILE_BYTES + 1));
    expect(() => parseTrustedResultDelivery({ schemaVersion: 1, deliveryId: 'report_20261017', files: [{ path: 'large.bin' }] }, home))
      .toThrow(/file_too_large/);
    expect(existsSync(large)).toBe(true);
  });

  it('binds access to the owner, consumes the entry token once, expires and revokes fail closed', () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-result-store-'));
    let now = Date.parse('2026-10-16T00:00:00.000Z');
    let sequence = 0;
    const store = new PluginResultArtifactStore({
      dataDir: root,
      now: () => now,
      ttlMs: 60_000,
      randomId: () => `opaque_identifier_${++sequence}_abcdefghij`,
      randomToken: () => `view_token_${++sequence}_abcdefghijklmnopqrstuvwxyz`,
    });
    const make = () => store.create({
      pluginId: 'reference-reporter',
      delivery: { schemaVersion: 1, deliveryId: `delivery_${sequence}_abcdefgh`, markdown: 'private result' },
      ownerUnionId: 'on_owner123', larkAppId: 'cli_fixture', sessionId: 'session_fixture', turnId: 'om_fixture',
    });

    const first = make();
    expect(() => store.redeem(first.viewToken, 'on_other123')).toThrow('plugin_result_access_denied');
    expect(store.redeem(first.viewToken, 'on_owner123').viewId).toBe(first.viewId);
    expect(() => store.redeem(first.viewToken, 'on_owner123')).toThrow('plugin_result_token_replayed');
    expect(() => store.resolveView(first.viewId, 'on_other123')).toThrow('plugin_result_access_denied');

    const expired = make();
    now += 60_000;
    expect(() => store.redeem(expired.viewToken, 'on_owner123')).toThrow('plugin_result_expired');

    now -= 60_000;
    const revoked = make();
    store.revoke(revoked.artifactId);
    expect(() => store.redeem(revoked.viewToken, 'on_owner123')).toThrow('plugin_result_revoked');
    expect(() => store.resolveView(revoked.viewId, 'on_owner123')).toThrow('plugin_result_revoked');
  });

  it('renders a metadata-only entry card without result content or internal handles', () => {
    const accessUrl = 'https://example.test/plugin-result-access/view_token_abcdefghijklmnopqrstuvwxyz';
    const card = buildTrustedResultDeliveryCard({ accessUrl, expiresAt: '2026-10-16T01:00:00.000Z' });
    expect(card).toContain(accessUrl);
    expect(card).toContain('结果已生成');
    expect(card).not.toContain('private result');
    expect(card).not.toContain('artifactId');
    expect(card).not.toContain('deliveryId');
  });

  it('waits for IPC backpressure and serializes deliveries through the final receipt', async () => {
    let callback: ((error: Error | null) => void) | undefined;
    let settled = false;
    const pending = sendTrustedDeliveryIpcWithBackpressure({
      connected: true,
      send(_message, done) { callback = done; return false; },
    }, { metadataOnly: true }).then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    callback?.(null);
    await pending;

    const queue = new TrustedResultDeliverySerialQueue();
    let active = 0;
    let peak = 0;
    const run = () => queue.run(async () => {
      active += 1; peak = Math.max(peak, active);
      await Promise.resolve();
      active -= 1;
    });
    await Promise.all([run(), run()]);
    expect(peak).toBe(1);
  });

  it('marks the entry card as the only final terminal carrier', () => {
    expect(trustedResultTerminalObservation(['om_entry'])).toEqual({
      messageId: 'om_entry',
      terminalCarrier: 'standard_reply_card',
    });
  });
});
