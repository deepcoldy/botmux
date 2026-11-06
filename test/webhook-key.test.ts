import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { logger } from '../src/utils/logger.js';
import {
  createWebhookSecret,
  deleteWebhookSecret,
  getWebhookSecret,
  listWebhookSecretRefs,
  setWebhookSecret,
} from '../src/services/webhook-key.js';

describe('webhook-key', () => {
  it('stores encrypted secrets and decrypts by ref', () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-webhook-key-'));
    const record = createWebhookSecret('super-secret', dir);
    expect(record.ref).toMatch(/^whsec_/);
    expect(getWebhookSecret(record.ref, dir)).toBe('super-secret');

    const raw = readFileSync(join(dir, 'webhook-secrets.json'), 'utf-8');
    expect(raw).not.toContain('super-secret');
    expect(existsSync(join(dir, 'webhook-master.key'))).toBe(true);
    expect((statSync(join(dir, 'webhook-master.key')).mode & 0o777)).toBe(0o600);
  });

  it('rotates a known ref and lists metadata without ciphertext', () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-webhook-key-'));
    setWebhookSecret('whsec_known', 'old', dir);
    setWebhookSecret('whsec_known', 'new', dir);
    expect(getWebhookSecret('whsec_known', dir)).toBe('new');
    const refs = listWebhookSecretRefs(dir);
    expect(refs).toHaveLength(1);
    expect(refs[0].ref).toBe('whsec_known');
    expect(JSON.stringify(refs[0])).not.toContain('ciphertext');
  });

  it('deletes secrets', () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-webhook-key-'));
    setWebhookSecret('whsec_delete', 'secret', dir);
    expect(deleteWebhookSecret('whsec_delete', dir)).toBe(true);
    expect(deleteWebhookSecret('whsec_delete', dir)).toBe(false);
    expect(getWebhookSecret('whsec_delete', dir)).toBeNull();
  });
});

describe('webhook-key: corrupt secrets store', () => {
  it('quarantines webhook-secrets.json (keeping 0600) instead of wiping every stored secret on the next set', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      const dir = mkdtempSync(join(tmpdir(), 'botmux-webhook-key-corrupt-'));
      const first = createWebhookSecret('keep-me', dir);
      const fp = join(dir, 'webhook-secrets.json');
      const corrupt = readFileSync(fp, 'utf-8').slice(0, -20); // truncated mid-record
      writeFileSync(fp, corrupt, { mode: 0o600 });

      expect(getWebhookSecret(first.ref, dir)).toBeNull(); // degraded read, as before
      const second = createWebhookSecret('new-secret', dir); // write must not destroy the evidence

      expect(getWebhookSecret(second.ref, dir)).toBe('new-secret');
      const quarantined = readdirSync(dir).filter(f => f.startsWith('webhook-secrets.json.corrupt-'));
      expect(quarantined).toHaveLength(1);
      expect(readFileSync(join(dir, quarantined[0]), 'utf-8')).toBe(corrupt);
      expect(statSync(fp).mode & 0o777).toBe(0o600);
    } finally {
      warn.mockRestore();
    }
  });
});
