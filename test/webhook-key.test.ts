import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
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
