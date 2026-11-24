import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { approvalAutomationOptionsForBot, persistNewApprovalDeferredScopes } from '../src/services/approval-deferred-scopes-store.js';
import type { DeferredApprovalScope } from '../src/setup/approval-scope-resolver.js';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function configFile(existing?: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'botmux-approval-deferred-store-'));
  dirs.push(dir);
  const file = join(dir, 'bots.json');
  writeFileSync(file, JSON.stringify([{
    larkAppId: 'cli_partial',
    larkAppSecret: 'secret',
    allowedUsers: ['owner@example.com'],
    ...(existing === undefined ? {} : { approvalDeferredScopes: existing }),
  }]));
  return file;
}

const read = (file: string) => JSON.parse(readFileSync(file, 'utf8'));
const deferred = (bucket: 'tenant' | 'user', name: string): DeferredApprovalScope => ({
  bucket, name, isolation: 'exact', group: bucket === 'user' && name === 'offline_access' ? 'offline_access' : 'core_im',
});

describe('approvalAutomationOptionsForBot', () => {
  it('uses default-on avoidance and preserves explicit opt-out plus exclusions at every caller', () => {
    const approvalDeferredScopes = { tenant: ['im:message.group_msg'] };
    expect(approvalAutomationOptionsForBot({ approvalDeferredScopes })).toEqual({
      excludeScopes: approvalDeferredScopes,
      autoAvoidApproval: true,
    });
    expect(approvalAutomationOptionsForBot({ approvalDeferredScopes, autoAvoidApproval: false })).toEqual({
      excludeScopes: approvalDeferredScopes,
      autoAvoidApproval: false,
    });
  });
});

describe('persistNewApprovalDeferredScopes', () => {
  it('unions new partial-run deferrals with the latest on-disk record and never clears uncovered scopes', async () => {
    const file = configFile({ tenant: ['im:message.group_msg'], user: ['offline_access'] });
    const onCommitted = vi.fn(() => {
      // Publication happens only after the merged generation is durable.
      expect(read(file)[0].approvalDeferredScopes.tenant).toContain('vc:meeting.bot.join:write');
    });

    const result = await persistNewApprovalDeferredScopes('cli_partial', [
      deferred('tenant', 'vc:meeting.bot.join:write'),
    ], { path: file, onCommitted });

    expect(result).toEqual({
      ok: true,
      buckets: {
        tenant: ['im:message.group_msg', 'vc:meeting.bot.join:write'],
        user: ['offline_access'],
      },
    });
    expect(read(file)[0].approvalDeferredScopes).toEqual(result.ok ? result.buckets : undefined);
    expect(onCommitted).toHaveBeenCalledOnce();
  });

  it('serializes concurrent partial discoveries without losing either bucket', async () => {
    const file = configFile({ tenant: ['im:message.group_msg'] });
    await Promise.all([
      persistNewApprovalDeferredScopes('cli_partial', [deferred('user', 'offline_access')], { path: file }),
      persistNewApprovalDeferredScopes('cli_partial', [deferred('tenant', 'vc:meeting.bot.join:write')], { path: file }),
    ]);
    expect(read(file)[0].approvalDeferredScopes).toEqual({
      tenant: ['im:message.group_msg', 'vc:meeting.bot.join:write'],
      user: ['offline_access'],
    });
  });

  it('does not touch disk or publish memory when there is no new deferral', async () => {
    const file = configFile({ tenant: ['im:message.group_msg'] });
    const before = readFileSync(file, 'utf8');
    const onCommitted = vi.fn();
    const result = await persistNewApprovalDeferredScopes('cli_partial', [], { path: file, onCommitted });
    expect(result).toEqual({ ok: true, buckets: undefined });
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(onCommitted).not.toHaveBeenCalled();
  });

  it('returns a structured failure and does not publish when persistence fails', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-approval-deferred-missing-'));
    dirs.push(dir);
    const file = join(dir, 'missing', 'bots.json');
    const onCommitted = vi.fn();
    const result = await persistNewApprovalDeferredScopes('cli_partial', [deferred('user', 'offline_access')], { path: file, onCommitted });
    expect(result.ok).toBe(false);
    expect(onCommitted).not.toHaveBeenCalled();
  });
});
