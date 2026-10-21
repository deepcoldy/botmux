import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LinkRefLedger } from '../src/services/link-ref-ledger.js';
import { createLinkRefRuntime } from '../src/services/link-ref-runtime.js';

describe('automatic final LinkRef drafts', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function setup() {
    const root = mkdtempSync(join(tmpdir(), 'botmux-final-link-ref-'));
    roots.push(root);
    let sequence = 0;
    const ledger = new LinkRefLedger(root, {
      randomBytes: () => Buffer.from(String(++sequence).padStart(32, '0'), 'hex'),
    });
    const runtime = createLinkRefRuntime(root, { ledger: () => ledger });
    const key = { appId: 'app', sessionId: 'session', turnId: 'turn', dispatchAttempt: 2 };
    const fullUrl = 'https://auth.example.test/approve' + '?code=keep&state=ready';
    const registration = runtime.registerSources({
      key,
      mode: 'enabled',
      sources: [{ sourceType: 'mcp', kind: 'text', text: fullUrl }],
    });
    const refId = registration.companion!.match(/lr_[0-9a-f]{32}/)![0];
    return { root, ledger, runtime, key, fullUrl, refId };
  }

  it('persists the exact unresolved draft before resolving and clears only after confirmation', () => {
    const { ledger, runtime, key, fullUrl, refId } = setup();
    const unresolved = `授权：{{botmux_link:${refId}}}`;
    const save = vi.spyOn(ledger, 'savePendingDraft');
    const resolve = vi.spyOn(ledger, 'resolveBatch');
    const prepared = runtime.prepareFinalDraft({ key, mode: 'enabled', content: unresolved });
    expect(save).toHaveBeenCalledWith(key, unresolved);
    expect(save.mock.invocationCallOrder[0]).toBeLessThan(resolve.mock.invocationCallOrder[0]);
    expect(prepared).toEqual({ content: `授权：${fullUrl}`, draftPending: true });
    expect(ledger.readPendingDraft(key)).toBe(unresolved);
    runtime.clearPendingDraft(key);
    expect(ledger.readPendingDraft(key)).toBeUndefined();
  });

  it('prefers an exact persisted draft after restart and never replaces it with replay text', () => {
    const { root, ledger, runtime, key, fullUrl, refId } = setup();
    const unresolved = `授权：{{botmux_link:${refId}}}`;
    runtime.prepareFinalDraft({ key, mode: 'enabled', content: unresolved });
    runtime.close();
    const reopened = createLinkRefRuntime(root);
    expect(reopened.prepareFinalDraft({
      key,
      mode: 'enabled',
      content: `different replay body {{botmux_link:${refId}}}`,
    })).toEqual({ content: `授权：${fullUrl}`, draftPending: true });
    reopened.close();
    ledger.close();
  });

  it('fails before resolution when draft persistence fails', () => {
    const { ledger, runtime, key, refId } = setup();
    vi.spyOn(ledger, 'savePendingDraft').mockImplementation(() => {
      const error = new Error('database is busy') as Error & { code: string };
      error.code = 'SQLITE_BUSY';
      throw error;
    });
    const resolve = vi.spyOn(ledger, 'resolveBatch');
    expect(() => runtime.prepareFinalDraft({
      key,
      mode: 'enabled',
      content: `{{botmux_link:${refId}}}`,
    })).toThrowError(expect.objectContaining({ code: 'link_ref_ledger_unavailable' }));
    expect(resolve).not.toHaveBeenCalled();
  });

  it('keeps disabled finals byte-identical without opening a ledger', () => {
    const ledger = vi.fn();
    const runtime = createLinkRefRuntime('/unused', { ledger });
    const content = '\\{{botmux_link:lr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa}}';
    expect(runtime.prepareFinalDraft({
      key: { appId: 'a', sessionId: 's', turnId: 't' },
      mode: 'disabled',
      content,
    })).toEqual({ content, draftPending: false });
    expect(ledger).not.toHaveBeenCalled();
  });

  it('removes only the escape backslash without querying the ledger when enabled text has no executable refs', () => {
    const { ledger, runtime, key } = setup();
    const resolve = vi.spyOn(ledger, 'resolveBatch');
    const escaped = '\\{{botmux_link:lr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa}}';
    expect(runtime.prepareFinalDraft({ key, mode: 'enabled', content: escaped }))
      .toEqual({ content: escaped.slice(1), draftPending: false });
    expect(resolve).not.toHaveBeenCalled();
  });
});
