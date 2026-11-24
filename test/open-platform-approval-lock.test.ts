import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  automateOpenPlatformSetup,
  BOTMUX_REDIRECT_URL,
  withOpenPlatformAppLock,
  writeStoredCookiesToSessionFile,
  type StoredCookie,
} from '../src/setup/open-platform-automation.js';
import { resolveNextPersistedApprovalDeferredScopes } from '../src/setup/approval-scope-resolver.js';
import { persistNewApprovalDeferredScopes } from '../src/services/approval-deferred-scopes-store.js';
import { rmwBotEntry } from '../src/services/config-store.js';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const cookie = (): StoredCookie => ({
  name: 'session', value: 'test-cookie', domain: '.feishu.cn', path: '/', secure: true,
  httpOnly: true, hostOnly: false, expiresAt: Date.now() + 60_000,
});

describe('open-platform result persistence ordering', () => {
  it('keeps nested automation and partial persistence ahead of a later full-configure clear', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-open-platform-result-lock-'));
    dirs.push(dir);
    const appId = 'cli_result_lock';
    const botsPath = join(dir, 'bots.json');
    writeFileSync(botsPath, JSON.stringify([{ larkAppId: appId, larkAppSecret: 'secret', allowedUsers: ['owner@example.com'] }]));
    const sessionFilePath = join(dir, 'session.json');
    writeStoredCookiesToSessionFile(sessionFilePath, [cookie()]);
    const fetchImpl = (async (url: string | URL | Request) => {
      const href = String(url);
      if (href === 'https://ask.feishu.cn/') return new Response('ask home', { status: 200 });
      if (href.endsWith(`/app/${appId}/auth`)) return new Response('<script>window.csrfToken="c"</script>', { status: 200 });
      if (href.endsWith(`/developers/v1/safe_setting/${appId}`)) {
        return Response.json({ code: 0, data: { allowRefreshToken: false, redirectURL: [BOTMUX_REDIRECT_URL], ipWhiteList: [], safeServerDomain: [] } });
      }
      return Response.json({ code: 0, data: {} });
    }) as typeof fetch;

    const sequence: string[] = [];
    let markPartialStarted!: () => void;
    const partialStarted = new Promise<void>(resolve => { markPartialStarted = resolve; });
    const partial = withOpenPlatformAppLock(appId, async () => {
      sequence.push('partial:start');
      markPartialStarted();
      const nested = await automateOpenPlatformSetup({
        appId,
        brand: 'feishu',
        sessionFilePath,
        disableBytedcliFallback: true,
        redirectOnly: true,
        fetchImpl,
      });
      expect(nested.ok).toBe(true);
      sequence.push('partial:nested-automation-done');
      const persisted = await persistNewApprovalDeferredScopes(appId, [{
        bucket: 'tenant', name: 'stale.partial.scope', isolation: 'exact', group: 'other',
      }], { path: botsPath });
      expect(persisted.ok).toBe(true);
      sequence.push('partial:committed');
    });
    await partialStarted;
    const fullConfigure = withOpenPlatformAppLock(appId, async () => {
      sequence.push('full:start');
      const cleared = await rmwBotEntry(appId, entry => {
        const decision = resolveNextPersistedApprovalDeferredScopes(entry.approvalDeferredScopes, { approvalAutoPassed: true }, []);
        if (decision.action === 'clear') delete entry.approvalDeferredScopes;
        return { write: decision.action === 'clear', result: decision.action };
      }, { path: botsPath });
      expect(cleared.ok).toBe(true);
      sequence.push('full:cleared');
    });
    await Promise.all([partial, fullConfigure]);

    expect(sequence).toEqual([
      'partial:start',
      'partial:nested-automation-done',
      'partial:committed',
      'full:start',
      'full:cleared',
    ]);
    const finalBots = JSON.parse(readFileSync(botsPath, 'utf8'));
    expect(finalBots[0].approvalDeferredScopes).toBeUndefined();
  });
});
