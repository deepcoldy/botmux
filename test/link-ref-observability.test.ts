import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LinkRefLedger } from '../src/services/link-ref-ledger.js';
import { createLinkRefRuntime } from '../src/services/link-ref-runtime.js';
import type { LinkRefDiagnostic } from '../src/services/link-ref-types.js';
import { logger } from '../src/utils/logger.js';

const allowed = new Set([
  'mode', 'sourceType', 'scannedBytes', 'found', 'registered', 'deduplicated',
  'filtered', 'limited', 'refId', 'urlHash', 'outcome', 'errorCode', 'refCount',
  'durationMs',
]);

describe('LinkRef observability', () => {
  const roots: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('projects diagnostics onto the scalar allowlist', () => {
    const events: LinkRefDiagnostic[] = [];
    const runtime = createLinkRefRuntime('/unused', { onDiagnostic: event => events.push(event) });
    runtime.recordDiagnostic({
      mode: 'enabled',
      sourceType: 'tool',
      found: 1,
      refId: 'lr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      urlHash: 'hash-only',
      outcome: 'registered',
      errorCode: 'link_ref_unknown',
      durationMs: 3,
      originalUrl: 'https://secret.example/path',
      companion: '<botmux_link_refs>raw</botmux_link_refs>',
      password: 'never-log-me',
      nested: { cookie: 'private' },
    } as LinkRefDiagnostic & Record<string, unknown>);

    expect(events).toHaveLength(1);
    expect(Object.keys(events[0]!).every(key => allowed.has(key))).toBe(true);
    expect(JSON.stringify(events)).not.toContain('secret.example');
    expect(JSON.stringify(events)).not.toContain('never-log-me');
    expect(JSON.stringify(events)).not.toContain('botmux_link_refs');
    runtime.close();
  });

  it('observe mode reports counts without a database, companion, or raw sensitive data', () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-link-ref-observe-diagnostics-'));
    roots.push(root);
    const events: LinkRefDiagnostic[] = [];
    const runtime = createLinkRefRuntime(root, { onDiagnostic: event => events.push(event) });
    const authorizationUrl = 'https://login.example.test/authorize'
      + '?code=one&token=two&signature=three&state=four&redirect_uri=https%3A%2F%2Fclient.test%2Fdone';
    const bearer = 'Bearer top-secret-value';

    const result = runtime.registerSources({
      key: { appId: 'app', sessionId: 'session', turnId: 'turn' },
      mode: 'observe',
      sources: [{
        sourceType: 'tool',
        kind: 'structured',
        value: {
          authorization_url: authorizationUrl,
          headers: { authorization: bearer, cookie: 'sid=private' },
        },
      }],
    });

    expect(result.companion).toBeUndefined();
    expect(result.stats.found).toBe(1);
    expect(result.stats.filteredCredential).toBeGreaterThanOrEqual(2);
    expect(existsSync(join(root, 'link-refs', 'link-refs.sqlite'))).toBe(false);
    const output = JSON.stringify(events);
    expect(output).not.toContain('login.example.test');
    expect(output).not.toContain('top-secret-value');
    expect(output).not.toContain('sid=private');
    expect(events).toContainEqual(expect.objectContaining({ mode: 'observe', found: 1 }));
    runtime.close();
  });

  it('reports redacted registration and resolution outcomes without URL bytes', () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-link-ref-enabled-diagnostics-'));
    roots.push(root);
    const events: LinkRefDiagnostic[] = [];
    const runtime = createLinkRefRuntime(root, { onDiagnostic: event => events.push(event) });
    const key = { appId: 'app', sessionId: 'session', turnId: 'turn' };
    const originalUrl = 'https://private.example.test/path#fragment';
    const registration = runtime.registerSources({
      key,
      mode: 'enabled',
      sources: [{ sourceType: 'tool', kind: 'text', text: originalUrl }],
    });
    expect(registration.companion).toContain(originalUrl);
    const refId = registration.companion?.match(/lr_[0-9a-f]{32}/)?.[0];
    expect(refId).toBeDefined();

    const resolved = runtime.resolveForDaemon(key, 'enabled', {
      text: `open {{botmux_link:${refId}}}`,
    });
    expect(resolved.text).toBe(`open ${originalUrl}`);

    expect(() => runtime.resolveForDaemon(key, 'enabled', {
      text: '{{botmux_link:lr_ffffffffffffffffffffffffffffffff}}',
    })).toThrowError(expect.objectContaining({ code: 'link_ref_unknown' }));

    const output = JSON.stringify(events);
    expect(output).not.toContain('private.example.test');
    expect(output).not.toContain('#fragment');
    expect(events).toContainEqual(expect.objectContaining({
      mode: 'enabled', registered: 1,
    }));
    expect(events).toContainEqual(expect.objectContaining({
      mode: 'enabled', outcome: 'resolved', refCount: 1,
      durationMs: expect.any(Number),
    }));
    expect(events).toContainEqual(expect.objectContaining({
      mode: 'enabled', outcome: 'resolution_failed', errorCode: 'link_ref_unknown',
      durationMs: expect.any(Number),
    }));
    runtime.close();
  });

  it('reports URL limits and registration failures with stable redacted fields', () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-link-ref-limited-diagnostics-'));
    roots.push(root);
    const events: LinkRefDiagnostic[] = [];
    const runtime = createLinkRefRuntime(root, { onDiagnostic: event => events.push(event) });
    const sources = Array.from({ length: 129 }, (_, index) => ({
      sourceType: 'tool' as const,
      kind: 'text' as const,
      text: `https://limit-${index}.example.test/path#private-${index}`,
    }));

    runtime.registerSources({
      key: { appId: 'app', sessionId: 'session', turnId: 'limited' },
      mode: 'enabled',
      sources,
    });
    expect(events).toContainEqual(expect.objectContaining({
      mode: 'enabled', registered: 128, limited: 1,
      errorCode: 'link_ref_limit_exceeded',
    }));
    expect(JSON.stringify(events)).not.toContain('private-128');
    runtime.close();

    const failedEvents: LinkRefDiagnostic[] = [];
    const failedRuntime = createLinkRefRuntime('/unused', {
      ledger: () => ({
        pruneExpired: () => ({ expired: 0, removed: 0 }),
        openTurn: () => { throw Object.assign(new Error('sensitive-host.example'), {
          code: 'link_ref_ledger_unavailable',
        }); },
        close: () => undefined,
      }) as unknown as LinkRefLedger,
      onDiagnostic: event => failedEvents.push(event),
    });
    failedRuntime.registerSources({
      key: { appId: 'app', sessionId: 'session', turnId: 'failed' },
      mode: 'enabled',
      sources: [{
        sourceType: 'tool', kind: 'text',
        text: 'https://registration.example.test/path#private-fragment',
      }],
    });
    expect(failedEvents).toContainEqual(expect.objectContaining({
      mode: 'enabled', outcome: 'registration_failed',
      errorCode: 'link_ref_ledger_unavailable',
    }));
    expect(JSON.stringify(failedEvents)).not.toContain('registration.example.test');
    expect(JSON.stringify(failedEvents)).not.toContain('private-fragment');
    failedRuntime.close();
  });

  it('redacts the default diagnostic log output', () => {
    const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    const runtime = createLinkRefRuntime('/unused');
    runtime.recordDiagnostic({
      mode: 'enabled',
      outcome: 'registered',
      found: 1,
      originalUrl: 'https://logged.example.test/path#private',
      authorization: 'Bearer private-token',
    } as LinkRefDiagnostic & Record<string, unknown>);

    expect(info).toHaveBeenCalledOnce();
    const output = info.mock.calls.flat().join(' ');
    expect(output).toContain('"mode":"enabled"');
    expect(output).not.toContain('logged.example.test');
    expect(output).not.toContain('private-token');
    runtime.close();
  });
});
