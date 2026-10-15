import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MAX_TRUSTED_DELIVERY_FILE_BYTES,
  MAX_TRUSTED_DELIVERY_MARKDOWN_CHARS,
  decodeTrustedResultDeliveryIpcEnvelope,
  deliverValidatedTrustedResultDelivery,
  parseTrustedResultDelivery,
  sendTrustedDeliveryIpcWithBackpressure,
  TrustedResultDeliverySerialQueue,
  TrustedResultDeliveryEffectError,
  trustedResultDeliveryIpcFiles,
  trustedResultTerminalObservation,
} from '../src/core/plugins/mcp/trusted-result-delivery.js';
import { buildTrustedResultDeliveryCard } from '../src/im/lark/trusted-result-delivery-card.js';

describe('trusted plugin result delivery', () => {
  it('accepts regular files only from the plugin outbound directory', () => {
    const home = mkdtempSync(join(tmpdir(), 'botmux-delivery-'));
    const outbound = join(home, 'outbound');
    mkdirSync(outbound);
    writeFileSync(join(outbound, 'report.pdf'), 'report');
    const parsed = parseTrustedResultDelivery({
      schemaVersion: 1,
      deliveryId: 'report_20261014',
      markdown: '完成',
      files: [{ path: 'report.pdf' }],
    }, home);
    expect(parsed.files![0].data.toString('utf8')).toBe('report');
    expect(parsed.files?.[0].name).toBe('report.pdf');
    expect(existsSync(join(outbound, 'report.pdf'))).toBe(false);
  });

  it('rejects symlinks and paths outside the plugin outbound directory', () => {
    const home = mkdtempSync(join(tmpdir(), 'botmux-delivery-'));
    const outbound = join(home, 'outbound');
    mkdirSync(outbound);
    const outside = join(home, 'secret.txt');
    writeFileSync(outside, 'secret');
    symlinkSync(outside, join(outbound, 'linked.txt'));
    expect(() => parseTrustedResultDelivery({
      schemaVersion: 1,
      deliveryId: 'report_20261014',
      files: [{ path: outside }],
    }, home)).toThrow(/outside_plugin_home/);
    expect(() => parseTrustedResultDelivery({
      schemaVersion: 1,
      deliveryId: 'report_20261015',
      files: [{ path: 'linked.txt' }],
    }, home)).toThrow(/outside_plugin_home|file_type/);
  });

  it('rejects an outbound root that is itself a symlink', () => {
    const home = mkdtempSync(join(tmpdir(), 'botmux-delivery-'));
    const outside = mkdtempSync(join(tmpdir(), 'botmux-delivery-outside-'));
    writeFileSync(join(outside, 'report.pdf'), 'outside');
    symlinkSync(outside, join(home, 'outbound'));
    expect(() => parseTrustedResultDelivery({
      schemaVersion: 1,
      deliveryId: 'report_20261016',
      files: [{ path: 'report.pdf' }],
    }, home)).toThrow(/outbound_root/);
  });

  it('keeps final IPC bytes immutable when the plugin rewrites sources and scans tmp', () => {
    const preexistingSpools = new Set(
      readdirSync(tmpdir()).filter(dir => dir.startsWith('botmux-result-delivery-')),
    );
    const home = mkdtempSync(join(tmpdir(), 'botmux-delivery-'));
    const outbound = join(home, 'outbound');
    mkdirSync(outbound);
    const source = join(outbound, 'report.pdf');
    const outside = join(home, 'secret.txt');
    writeFileSync(source, 'approved-report');
    writeFileSync(outside, 'secret-after-validation');
    const parsed = parseTrustedResultDelivery({
      schemaVersion: 1,
      deliveryId: 'report_20261017',
      files: [{ path: source }],
    }, home);
    writeFileSync(source, 'tampered-by-plugin-uid');
    rmSync(source);
    symlinkSync(outside, source);
    for (const dir of readdirSync(tmpdir())) {
      if (dir.startsWith('botmux-result-delivery-') && !preexistingSpools.has(dir)) {
        throw new Error(`unexpected same-uid spool: ${dir}`);
      }
    }
    expect(trustedResultDeliveryIpcFiles(parsed)).toEqual([{
      name: 'report.pdf',
      dataBase64: Buffer.from('approved-report').toString('base64'),
    }]);
  });

  it('validates the whole envelope before consuming files and never creates a spool', () => {
    const home = mkdtempSync(join(tmpdir(), 'botmux-delivery-'));
    const outbound = join(home, 'outbound');
    mkdirSync(outbound);
    const source = join(outbound, 'report.pdf');
    writeFileSync(source, 'report');
    const before = new Set(readdirSync(tmpdir()).filter(name => name.startsWith('botmux-result-delivery-')));
    expect(() => parseTrustedResultDelivery({
      schemaVersion: 1,
      deliveryId: 'report_20261020',
      files: [{ path: source }],
      responseKind: 'bogus',
    }, home)).toThrow(/response_kind/);
    expect(existsSync(source)).toBe(true);
    const after = readdirSync(tmpdir()).filter(name => name.startsWith('botmux-result-delivery-'));
    expect(after.filter(name => !before.has(name))).toEqual([]);
  });

  it('rejects an oversized rendered card before consuming attachments', () => {
    const home = mkdtempSync(join(tmpdir(), 'botmux-delivery-'));
    const outbound = join(home, 'outbound');
    mkdirSync(outbound);
    const source = join(outbound, 'report.xlsx');
    writeFileSync(source, 'business-result');
    const markdown = '数据'.repeat(15_000);
    const validate = (value: string) => buildTrustedResultDeliveryCard({
      markdown: value,
      chatId: `oc_${'0'.repeat(32)}`,
      uuid: 'prd_'.padEnd(50, '0'),
      recipientOpenId: 'ou_requester',
      brand: 'botmux',
      locale: 'zh',
      workingDir: home,
    });
    expect(() => parseTrustedResultDelivery({
      schemaVersion: 1,
      deliveryId: 'report_20261026',
      markdown,
      files: [{ path: 'report.xlsx' }],
    }, home, validate)).toThrow('host_delivery_markdown_too_large');
    expect(existsSync(source)).toBe(true);
  });

  it('enforces byte limits before IPC', () => {
    const home = mkdtempSync(join(tmpdir(), 'botmux-delivery-'));
    const outbound = join(home, 'outbound');
    mkdirSync(outbound);
    writeFileSync(join(outbound, 'large.bin'), Buffer.alloc(MAX_TRUSTED_DELIVERY_FILE_BYTES + 1));
    expect(() => parseTrustedResultDelivery({
      schemaVersion: 1,
      deliveryId: 'report_20261021',
      files: [{ path: 'large.bin' }],
    }, home)).toThrow(/file_too_large/);

    for (const name of ['a.bin', 'b.bin', 'c.bin']) {
      writeFileSync(join(outbound, name), Buffer.alloc(6 * 1024 * 1024));
    }
    expect(() => parseTrustedResultDelivery({
      schemaVersion: 1,
      deliveryId: 'report_20261022',
      files: ['a.bin', 'b.bin', 'c.bin'].map(path => ({ path })),
    }, home)).toThrow(/files_too_large/);
  });

  it('waits for IPC backpressure callbacks and rejects interrupted sends', async () => {
    let callback: ((error: Error | null) => void) | undefined;
    let settled = false;
    const pending = sendTrustedDeliveryIpcWithBackpressure({
      connected: true,
      send(_message, done) { callback = done; return false; },
    }, { payload: 'bounded' }).then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    callback?.(null);
    await pending;
    expect(settled).toBe(true);

    await expect(sendTrustedDeliveryIpcWithBackpressure({
      connected: false,
      send() { throw new Error('unreachable'); },
    }, { payload: 'discarded' })).rejects.toThrow(/disconnected/);
  });

  it('does not report a timeout while an accepted IPC send is still pending', async () => {
    let callback: ((error: Error | null) => void) | undefined;
    let rejected = false;
    const pending = sendTrustedDeliveryIpcWithBackpressure({
      connected: true,
      send(_message, done) { callback = done; return false; },
    }, { payload: 'eventually-enqueued' }).catch((error) => {
      rejected = true;
      throw error;
    });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(rejected).toBe(false);
    callback?.(null);
    await expect(pending).resolves.toBeUndefined();
  });

  it('serializes through final receipt and releases after every terminal outcome', async () => {
    const queue = new TrustedResultDeliverySerialQueue();
    let active = 0;
    let maxActive = 0;
    const gates: Array<() => void> = [];
    const outcomes = ['success', 'daemon_reject', 'ipc_disconnect'] as const;
    const tasks = outcomes.map((outcome) => queue.run(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>(resolve => gates.push(resolve));
      active -= 1;
      if (outcome === 'daemon_reject') throw new Error(outcome);
      if (outcome === 'ipc_disconnect') {
        await sendTrustedDeliveryIpcWithBackpressure({
          connected: false,
          send() { throw new Error('unreachable'); },
        }, { payload: outcome });
      }
      return outcome;
    }));
    await Promise.resolve();
    expect(gates).toHaveLength(1);
    gates.shift()?.();
    await expect(tasks[0]).resolves.toBe('success');
    await Promise.resolve();
    expect(gates).toHaveLength(1);
    gates.shift()?.();
    await expect(tasks[1]).rejects.toThrow('daemon_reject');
    await Promise.resolve();
    expect(gates).toHaveLength(1);
    gates.shift()?.();
    await expect(tasks[2]).rejects.toThrow('ipc_disconnect');
    expect(maxActive).toBe(1);
  });

  it('bounds concurrent 16 MiB deliveries before Base64 materialization', async () => {
    const queue = new TrustedResultDeliverySerialQueue();
    const buffers = [
      Buffer.alloc(16 * 1024 * 1024, 1),
      Buffer.alloc(16 * 1024 * 1024, 2),
    ];
    let entered = 0;
    let activeEncodedBytes = 0;
    let peakEncodedBytes = 0;
    const releases: Array<() => void> = [];
    const tasks = buffers.map(buffer => queue.run(async () => {
      entered += 1;
      const encoded = buffer.toString('base64');
      activeEncodedBytes += encoded.length;
      peakEncodedBytes = Math.max(peakEncodedBytes, activeEncodedBytes);
      await new Promise<void>(resolve => releases.push(resolve));
      activeEncodedBytes -= encoded.length;
    }));
    await Promise.resolve();
    expect(entered).toBe(1);
    expect(releases).toHaveLength(1);
    releases.shift()?.();
    await tasks[0];
    await Promise.resolve();
    expect(entered).toBe(2);
    releases.shift()?.();
    await tasks[1];
    expect(peakEncodedBytes).toBe(buffers[0].toString('base64').length);
  });

  it('fully validates and decodes the daemon envelope before delivery', () => {
    const valid = {
      deliveryId: 'report_20261023',
      markdown: '完成',
      responseKind: 'final' as const,
      files: [{ name: 'report.xlsx', dataBase64: Buffer.from('xlsx').toString('base64') }],
    };
    expect(decodeTrustedResultDeliveryIpcEnvelope(valid).files[0].data.toString()).toBe('xlsx');
    expect(() => decodeTrustedResultDeliveryIpcEnvelope({
      ...valid,
      files: Array.from({ length: 9 }, (_, index) => ({ name: `f${index}.txt`, dataBase64: '' })),
    })).toThrow(/files/);
    expect(() => decodeTrustedResultDeliveryIpcEnvelope({
      ...valid,
      files: [valid.files[0], { name: 'bad.txt', dataBase64: '!!!!' }],
    })).toThrow(/file|base64/);
    expect(() => decodeTrustedResultDeliveryIpcEnvelope({
      ...valid,
      files: [{ name: 'bad.txt', dataBase64: 'Zh==' }],
    })).toThrow(/base64/);
    expect(() => decodeTrustedResultDeliveryIpcEnvelope({
      ...valid,
      markdown: 'x'.repeat(MAX_TRUSTED_DELIVERY_MARKDOWN_CHARS + 1),
    })).toThrow(/markdown/);
  });

  it('has zero delivery side effects for every malformed whole-envelope case', async () => {
    const effects = {
      sendMarkdown: async () => 'om_card',
      sendFile: async () => 'om_file',
    };
    let markdownCalls = 0;
    let uploadCalls = 0;
    const countedEffects = {
      async sendMarkdown(markdown: string) {
        markdownCalls += 1;
        return effects.sendMarkdown(markdown);
      },
      async sendFile(file: { name: string; data: Buffer }, index: number) {
        uploadCalls += 1;
        return effects.sendFile(file, index);
      },
    };
    const base = {
      deliveryId: 'report_20261024',
      markdown: '完成',
      responseKind: 'final' as const,
    };
    const malformed = [
      {
        ...base,
        files: Array.from({ length: 9 }, (_, index) => ({ name: `f${index}.txt`, dataBase64: '' })),
      },
      {
        ...base,
        files: [
          { name: 'good.txt', dataBase64: Buffer.from('good').toString('base64') },
          { name: 'last.txt', dataBase64: '!!!!' },
        ],
      },
      { ...base, markdown: 'x'.repeat(MAX_TRUSTED_DELIVERY_MARKDOWN_CHARS + 1), files: [] },
    ];
    for (const envelope of malformed) {
      await expect(deliverValidatedTrustedResultDelivery(envelope, countedEffects)).rejects.toThrow();
    }
    expect(markdownCalls).toBe(0);
    expect(uploadCalls).toBe(0);
  });

  it('rejects an oversized rendered card in the daemon before every side effect', async () => {
    let cardCalls = 0;
    let uploadCalls = 0;
    const markdown = '数据'.repeat(15_000);
    await expect(deliverValidatedTrustedResultDelivery({
      deliveryId: 'report_20261027',
      markdown,
      responseKind: 'final',
      files: [{ name: 'result.xlsx', dataBase64: Buffer.from('secret').toString('base64') }],
    }, {
      validateMarkdown(value) {
        buildTrustedResultDeliveryCard({
          markdown: value,
          chatId: `oc_${'0'.repeat(32)}`,
          uuid: 'prd_'.padEnd(50, '0'),
        });
      },
      async sendMarkdown() { cardCalls += 1; return 'om_card'; },
      async sendFile() { uploadCalls += 1; return 'om_file'; },
    })).rejects.toThrow('host_delivery_markdown_too_large');
    expect(cardCalls).toBe(0);
    expect(uploadCalls).toBe(0);
  });

  it('retains only acknowledged message ids when a delivery effect fails', async () => {
    const delivery = deliverValidatedTrustedResultDelivery({
      deliveryId: 'report_20261025',
      markdown: 'CONFIDENTIAL_RESULT_SENTINEL',
      responseKind: 'final',
      files: [{ name: 'secret.xlsx', dataBase64: Buffer.from('secret').toString('base64') }],
    }, {
      async sendMarkdown() { return 'om_primary'; },
      async sendFile() { throw new Error('/private/path/secret.xlsx'); },
    });
    await expect(delivery).rejects.toMatchObject({
      name: 'TrustedResultDeliveryEffectError',
      message: 'plugin_result_delivery_effect_failed',
      messageIds: ['om_primary'],
    } satisfies Partial<TrustedResultDeliveryEffectError>);
    await delivery.catch(error => {
      expect(JSON.stringify(error)).not.toContain('CONFIDENTIAL_RESULT_SENTINEL');
      expect(JSON.stringify(error)).not.toContain('secret.xlsx');
      expect(String(error)).not.toContain('/private/path');
    });
  });

  it('marks host-delivered finals with the correct terminal carrier', () => {
    expect(trustedResultTerminalObservation({
      schemaVersion: 1,
      deliveryId: 'report_20261018',
      markdown: '完成',
      files: [{ name: 'report.xlsx', data: Buffer.from('xlsx') }],
    }, ['om_card', 'om_file'])).toEqual({
      messageId: 'om_card',
      terminalCarrier: 'standard_reply_card',
    });
    expect(trustedResultTerminalObservation({
      schemaVersion: 1,
      deliveryId: 'report_20261019',
      files: [{ name: 'report.xlsx', data: Buffer.from('xlsx') }],
    }, ['om_file'])).toEqual({
      messageId: 'om_file',
      terminalCarrier: 'non_patchable',
    });
  });
});
