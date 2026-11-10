import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadOncallGroupTarget, oncallUsername, readOncallGroupSettings, saveOncallGroupTarget } from '../src/services/oncall-group-client.js';

let dir: string;
const legacy = { endpoint: 'https://legacy.example.test/api/inf/v1/chat/', emailDomain: 'legacy.test', tenantId: 12, region: 'cn', typeId: 34 };
const file = () => join(dir, 'oncall-group-targets.json');
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'oncall-target-settings-'));
  vi.stubEnv('HOME', dir); vi.stubEnv('ONCALL_GROUP_ENDPOINT', ''); vi.stubEnv('ONCALL_EMAIL_DOMAIN', '');
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); vi.unstubAllEnvs(); });

describe('Oncall business settings and deployment connection', () => {
  it('preserves legacy connection values and other bots when editing business routing', () => {
    writeFileSync(file(), JSON.stringify({ app: legacy, other: legacy }));
    saveOncallGroupTarget(dir, 'app', { tenantId: 56 });
    expect(loadOncallGroupTarget(dir, 'app')).toEqual({ endpoint: legacy.endpoint, emailDomain: legacy.emailDomain, tenantId: 56 });
    expect(loadOncallGroupTarget(dir, 'other')).toEqual(legacy);
    expect(readOncallGroupSettings(dir, 'app')).toEqual({ target: { tenantId: 56 }, connectionReady: true });
  });

  it('shares the deployment connection without copying it into bot settings', () => {
    vi.stubEnv('ONCALL_GROUP_ENDPOINT', ' https://shared.example.test/api/inf/v1/chat/ ');
    vi.stubEnv('ONCALL_EMAIL_DOMAIN', ' shared.test ');
    saveOncallGroupTarget(dir, 'app', { tenantId: 12 });
    saveOncallGroupTarget(dir, 'other', { tenantId: 56 });
    expect(JSON.parse(readFileSync(file(), 'utf8'))).toEqual({ app: { tenantId: 12 }, other: { tenantId: 56 } });
    for (const appId of ['app', 'other']) {
      const target = loadOncallGroupTarget(dir, appId);
      expect(target.endpoint).toBe('https://shared.example.test/api/inf/v1/chat/');
      expect(oncallUsername('actor@shared.test', target)).toBe('actor');
      expect(() => oncallUsername('actor@other.test', target)).toThrow();
    }
  });

  it('waits for the deployment connection on a fresh deployment and keeps business routing separate', () => {
    expect(readOncallGroupSettings(dir, 'app')).toMatchObject({ target: null, connectionReady: false });
    saveOncallGroupTarget(dir, 'app', { tenantId: 12 });
    expect(readOncallGroupSettings(dir, 'app')).toMatchObject({ target: { tenantId: 12 }, connectionReady: false });
    expect(() => loadOncallGroupTarget(dir, 'app')).toThrow('平台连接尚未配置');
    expect(JSON.parse(readFileSync(file(), 'utf8'))).toEqual({ app: { tenantId: 12 } });
    vi.stubEnv('ONCALL_GROUP_ENDPOINT', legacy.endpoint); vi.stubEnv('ONCALL_EMAIL_DOMAIN', legacy.emailDomain);
    expect(loadOncallGroupTarget(dir, 'app')).toEqual({ tenantId: 12, endpoint: legacy.endpoint, emailDomain: legacy.emailDomain });
  });

  it('prefers deployment values while retaining the existing fallback on disk', () => {
    writeFileSync(file(), JSON.stringify({ app: legacy }));
    vi.stubEnv('ONCALL_GROUP_ENDPOINT', 'https://shared.example.test/api/inf/v1/chat/');
    vi.stubEnv('ONCALL_EMAIL_DOMAIN', 'shared.test');
    saveOncallGroupTarget(dir, 'app', { tenantId: 56, typeId: 78, region: 'us' });
    expect(loadOncallGroupTarget(dir, 'app')).toEqual({ endpoint: 'https://shared.example.test/api/inf/v1/chat/', emailDomain: 'shared.test', tenantId: 56, typeId: 78, region: 'us' });
    expect(JSON.parse(readFileSync(file(), 'utf8')).app).toMatchObject({ endpoint: legacy.endpoint, emailDomain: legacy.emailDomain });
    vi.stubEnv('ONCALL_GROUP_ENDPOINT', 'http://unsafe.test');
    expect(readOncallGroupSettings(dir, 'app').connectionReady).toBe(false);
    expect(() => loadOncallGroupTarget(dir, 'app')).toThrow();
  });

  it('rejects connection edits through the business settings path without modifying the file', () => {
    writeFileSync(file(), JSON.stringify({ app: legacy }));
    const before = readFileSync(file(), 'utf8');
    for (const target of [{ tenantId: 56, endpoint: 'https://other.test' }, { tenantId: 56, emailDomain: 'other.test' }, { tenantId: 0 }]) {
      expect(() => saveOncallGroupTarget(dir, 'app', target)).toThrow();
    }
    expect(readFileSync(file(), 'utf8')).toBe(before);
  });

  it('does not overwrite corrupt existing configuration', () => {
    writeFileSync(file(), '{broken');
    expect(() => saveOncallGroupTarget(dir, 'app', { tenantId: 12 })).toThrow();
    expect(readFileSync(file(), 'utf8')).toBe('{broken');
  });
});
