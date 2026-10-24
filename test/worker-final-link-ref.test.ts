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

  it('rejects a truncated direct URL in an automatic final without a LinkRef placeholder', () => {
    const { runtime, key, fullUrl } = setup();
    const baseUrl = fullUrl.slice(0, fullUrl.indexOf('?'));
    expect(() => runtime.prepareFinalDraft({ key, mode: 'enabled', content: `授权：${baseUrl}` }))
      .toThrowError(expect.objectContaining({ code: 'link_ref_final_url_mismatch' }));
  });

  it('rejects malformed Markdown in an automatic final without a LinkRef placeholder', () => {
    const { runtime, key, fullUrl } = setup();
    expect(() => runtime.prepareFinalDraft({
      key,
      mode: 'enabled',
      content: `[授权](${fullUrl}`,
    })).toThrowError(expect.objectContaining({ code: 'link_ref_malformed_markdown' }));
  });

  it('validates a direct same-endpoint URL after expanding a LinkRef draft', () => {
    const { runtime, key, fullUrl, refId } = setup();
    const baseUrl = fullUrl.slice(0, fullUrl.indexOf('?'));

    expect(() => runtime.prepareFinalDraft({
      key,
      mode: 'enabled',
      content: `完整：{{botmux_link:${refId}}}\n截断：${baseUrl}`,
    })).toThrowError(expect.objectContaining({ code: 'link_ref_final_url_mismatch' }));
  });

  it('delivers plain automatic finals when registration failed before opening a turn', () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-final-link-ref-missing-turn-'));
    roots.push(root);
    const ledger = new LinkRefLedger(root);
    const runtime = createLinkRefRuntime(root, { ledger: () => ledger });
    const key = { appId: 'app', sessionId: 'session', turnId: 'missing', dispatchAttempt: 2 };

    expect(runtime.prepareFinalDraft({ key, mode: 'enabled', content: '纯文本回答' }))
      .toEqual({ content: '纯文本回答', draftPending: false });
  });

  it('delivers plain automatic finals after their registration turn expires', () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-final-link-ref-expired-turn-'));
    roots.push(root);
    let now = Date.now();
    const ledger = new LinkRefLedger(root, { now: () => now });
    const runtime = createLinkRefRuntime(root, { ledger: () => ledger });
    const key = { appId: 'app', sessionId: 'session', turnId: 'expired', dispatchAttempt: 2 };
    ledger.openTurn(key);
    expect(runtime.restoreMode(key)).toBe('enabled');
    now += 8 * 24 * 60 * 60_000;

    expect(runtime.prepareFinalDraft({ key, mode: 'enabled', content: '纯文本回答' }))
      .toEqual({ content: '纯文本回答', draftPending: false });
  });

  it('keeps an unavailable ledger fail-closed for automatic finals', () => {
    const runtime = createLinkRefRuntime('/unused', {
      ledger: () => { throw new Error('database unavailable'); },
    });

    expect(() => runtime.prepareFinalDraft({
      key: { appId: 'app', sessionId: 'session', turnId: 'turn' },
      mode: 'enabled',
      content: '纯文本回答',
    })).toThrowError(expect.objectContaining({ code: 'link_ref_ledger_unavailable' }));
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
