import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanPluginContributions } from '../src/core/plugins/convention-scanner.js';
import { installLocalPlugin } from '../src/core/plugins/install.js';
import { materializePlugin, readMaterializedPlugin } from '../src/core/plugins/materializer.js';
import { readPluginRegistry } from '../src/services/plugin-registry-store.js';
import { pluginMaterializedPath, pluginRegistryPath } from '../src/core/plugins/paths.js';
import {
  assertWebhookRoutesAvoidReservedEndpoints,
  collectReservedPluginCallbackEndpoints,
  detectPluginProxyRawTargetKind,
  isLegacyPluginConnectorWebhookTarget,
  matchPluginWebhookRoute,
  parsePluginWebhooksContribution,
  parseRawPluginServiceProxyRequest,
  parseRawPluginWebhookRequest,
  PLUGIN_WEBHOOK_DEFAULT_MAX_BODY_BYTES,
  PLUGIN_WEBHOOK_HARD_MAX_BODY_BYTES,
  upstreamPathMatchesReservedEndpoint,
  validateRawHttpFraming,
} from '../src/core/plugins/webhooks/protocol.js';

function createPluginPackage(root: string, opts: {
  id?: string;
  withService?: boolean;
  webhooksJson?: unknown;
  commandsJson?: unknown;
  cardActionsJson?: unknown;
} = {}): void {
  const id = opts.id ?? 'webhook-demo';
  const withService = opts.withService ?? true;
  mkdirSync(join(root, 'dist'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    name: `botmux-plugin-${id}`,
    version: '1.0.0',
    keywords: ['botmux-plugin'],
    botmux: {
      schemaVersion: 1,
      id,
      ...(withService ? { service: { mode: 'manual' } } : {}),
    },
  }, null, 2));
  if (withService) {
    mkdirSync(join(root, 'dist', 'service'), { recursive: true });
    writeFileSync(
      join(root, 'dist', 'service', 'index.js'),
      'export default { mode: "manual", port: 43310, pm2: { script: "./service/server.js" } };\n',
    );
    writeFileSync(join(root, 'dist', 'service', 'server.js'), 'setInterval(() => {}, 60000);\n');
  }
  if (opts.webhooksJson !== undefined) {
    mkdirSync(join(root, 'dist', 'webhooks'), { recursive: true });
    writeFileSync(join(root, 'dist', 'webhooks', 'index.json'), JSON.stringify(opts.webhooksJson, null, 2));
  }
  if (opts.commandsJson !== undefined) {
    mkdirSync(join(root, 'dist', 'commands'), { recursive: true });
    writeFileSync(join(root, 'dist', 'commands', 'index.json'), JSON.stringify(opts.commandsJson, null, 2));
  }
  if (opts.cardActionsJson !== undefined) {
    mkdirSync(join(root, 'dist', 'card-actions'), { recursive: true });
    writeFileSync(join(root, 'dist', 'card-actions', 'index.json'), JSON.stringify(opts.cardActionsJson, null, 2));
  }
}

describe('plugin webhooks contribution scanning, matching, and raw URL protocol guards', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'plugin-webhooks-proto-'));
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  it('scans, installs, and materializes dist/webhooks/index.json without exposing secrets', () => {
    const pkgDir = join(home, 'pkg-valid');
    createPluginPackage(pkgDir, {
      webhooksJson: {
        schemaVersion: 1,
        maxBodyBytes: 512 * 1024,
        routes: [
          { path: '/events' },
          { path: '/hooks', prefix: true, endpoint: '/internal/hooks', maxBodyBytes: 128 * 1024 },
          { path: '/plain', prefix: false },
        ],
      },
    });

    const scanned = scanPluginContributions(join(pkgDir, 'dist'), {
      schemaVersion: 1,
      id: 'webhook-demo',
      service: { mode: 'manual' },
    });
    expect(scanned?.webhooks).toEqual({
      schemaVersion: 1,
      maxBodyBytes: 512 * 1024,
      routes: [
        { path: '/events' },
        { path: '/hooks', prefix: true, endpoint: '/internal/hooks', maxBodyBytes: 128 * 1024 },
        { path: '/plain' },
      ],
    });

    const { record } = installLocalPlugin(pkgDir);
    expect(record.contributions?.webhooks).toEqual(scanned?.webhooks);
    expect(readPluginRegistry().plugins['webhook-demo']?.contributions?.webhooks).toEqual(scanned?.webhooks);

    const materialized = materializePlugin('webhook-demo');
    expect(materialized.webhooks).toEqual(scanned?.webhooks);
    expect(readMaterializedPlugin('webhook-demo')?.webhooks).toEqual(scanned?.webhooks);
    expect(readFileSync(pluginRegistryPath(), 'utf8')).not.toContain('BOTMUX_PLUGIN_CARD_ACTION_TOKEN');
    expect(readFileSync(pluginRegistryPath(), 'utf8')).not.toContain('BOTMUX_PLUGIN_WEBHOOK_TOKEN');
    expect(readFileSync(pluginMaterializedPath('webhook-demo'), 'utf8')).not.toContain('BOTMUX_PLUGIN_WEBHOOK_TOKEN');
  });

  it('omits webhooks when dist/webhooks/index.json is absent', () => {
    const pkgDir = join(home, 'pkg-no-webhooks');
    createPluginPackage(pkgDir, { webhooksJson: undefined });
    const scanned = scanPluginContributions(join(pkgDir, 'dist'), {
      schemaVersion: 1,
      id: 'webhook-demo',
      service: { mode: 'manual' },
    });
    expect(scanned?.webhooks).toBeUndefined();
  });

  it('rejects dist/webhooks/index.json when the plugin has no Host Service', () => {
    const pkgDir = join(home, 'pkg-no-service');
    createPluginPackage(pkgDir, {
      withService: false,
      webhooksJson: { schemaVersion: 1, routes: [{ path: '/events' }] },
    });
    expect(() => scanPluginContributions(join(pkgDir, 'dist'), {
      schemaVersion: 1,
      id: 'webhook-demo',
    })).toThrow('plugin_webhooks_service_required');
  });

  it('rejects webhook routes overlapping /botmux/*, commands.endpoint, or card-actions.endpoint at scan time', () => {
    // Prefix route overlapping /botmux/inputs/v1
    const pkgBotmux = join(home, 'pkg-botmux');
    createPluginPackage(pkgBotmux, {
      webhooksJson: { schemaVersion: 1, routes: [{ path: '/botmux/hooks' }] },
    });
    expect(() => scanPluginContributions(join(pkgBotmux, 'dist'), {
      schemaVersion: 1,
      id: 'webhook-demo',
      service: { mode: 'manual' },
    })).toThrow('plugin_webhook_route_reserved_endpoint:/botmux/hooks');

    // Prefix route whose endpoint is an ancestor of custom commands.endpoint
    const pkgCmd = join(home, 'pkg-cmd-overlap');
    createPluginPackage(pkgCmd, {
      commandsJson: { schemaVersion: 1, endpoint: '/rpc/commands/v1', commands: [{ name: '/demo-cmd' }] },
      webhooksJson: { schemaVersion: 1, routes: [{ path: '/hooks', prefix: true, endpoint: '/rpc' }] },
    });
    expect(() => scanPluginContributions(join(pkgCmd, 'dist'), {
      schemaVersion: 1,
      id: 'webhook-demo',
      service: { mode: 'manual' },
    })).toThrow('plugin_webhook_route_reserved_endpoint:/hooks');

    // Exact route pointing to cardActions.endpoint (even with different case/encoding)
    const pkgCard = join(home, 'pkg-card-overlap');
    createPluginPackage(pkgCard, {
      cardActionsJson: { schemaVersion: 1, endpoint: '/cb/cards', actions: ['demo.ok'] },
      webhooksJson: { schemaVersion: 1, routes: [{ path: '/events', endpoint: '/CB/%63ards' }] },
    });
    expect(() => scanPluginContributions(join(pkgCard, 'dist'), {
      schemaVersion: 1,
      id: 'webhook-demo',
      service: { mode: 'manual' },
    })).toThrow('plugin_webhook_route_reserved_endpoint:/events');

    // Runtime reserved check catches decoded/uppercase/subpath overlaps too
    const reserved = collectReservedPluginCallbackEndpoints({
      commands: { endpoint: '/custom/cmd' },
      cardActions: { endpoint: '/custom/card' },
    });
    expect(reserved.some(ep => upstreamPathMatchesReservedEndpoint('/%62otmux/inputs/v1', ep))).toBe(true);
    expect(reserved.some(ep => upstreamPathMatchesReservedEndpoint('/CUSTOM/CMD/', ep))).toBe(true);
    expect(reserved.some(ep => upstreamPathMatchesReservedEndpoint('/custom/card/sub', ep))).toBe(true);
    expect(reserved.some(ep => upstreamPathMatchesReservedEndpoint('/webhooks/events', ep))).toBe(false);
    expect(() => assertWebhookRoutesAvoidReservedEndpoints(
      parsePluginWebhooksContribution({ schemaVersion: 1, routes: [{ path: '/events' }] }),
      reserved,
    )).not.toThrow();
  });

  it.each([
    ['wrong schema', { schemaVersion: 2, routes: [{ path: '/events' }] }, 'invalid_plugin_webhooks_schema'],
    ['empty routes', { schemaVersion: 1, routes: [] }, 'plugin_webhooks_routes_required'],
    ['too many routes', {
      schemaVersion: 1,
      routes: Array.from({ length: 33 }, (_, i) => ({ path: `/r${i}` })),
    }, 'plugin_webhooks_routes_too_many'],
    ['root path', { schemaVersion: 1, routes: [{ path: '/' }] }, 'invalid_plugin_webhook_route_path'],
    ['trailing slash', { schemaVersion: 1, routes: [{ path: '/events/' }] }, 'invalid_plugin_webhook_route_path'],
    ['double slash', { schemaVersion: 1, routes: [{ path: '/a//b' }] }, 'invalid_plugin_webhook_route_path'],
    ['backslash', { schemaVersion: 1, routes: [{ path: '/a\\b' }] }, 'invalid_plugin_webhook_route_path'],
    ['query in path', { schemaVersion: 1, routes: [{ path: '/a?x=1' }] }, 'invalid_plugin_webhook_route_path'],
    ['space in path', { schemaVersion: 1, routes: [{ path: '/my hook' }] }, 'invalid_plugin_webhook_route_path'],
    ['non-ASCII in path', { schemaVersion: 1, routes: [{ path: '/事件' }] }, 'invalid_plugin_webhook_route_path'],
    ['dot-dot segment', { schemaVersion: 1, routes: [{ path: '/a/../b' }] }, 'invalid_plugin_webhook_route_path'],
    ['single dot segment', { schemaVersion: 1, routes: [{ path: '/a/./b' }] }, 'invalid_plugin_webhook_route_path'],
    ['encoded dot-dot', { schemaVersion: 1, routes: [{ path: '/a/%2e%2e/b' }] }, 'invalid_plugin_webhook_route_path'],
    ['encoded slash', { schemaVersion: 1, routes: [{ path: '/a%2fb' }] }, 'invalid_plugin_webhook_route_path'],
    ['encoded backslash', { schemaVersion: 1, routes: [{ path: '/a%5cb' }] }, 'invalid_plugin_webhook_route_path'],
    ['encoded CRLF', { schemaVersion: 1, routes: [{ path: '/a%0d%0ab' }] }, 'invalid_plugin_webhook_route_path'],
    ['prefix route with root endpoint', { schemaVersion: 1, routes: [{ path: '/hooks', prefix: true, endpoint: '/' }] }, 'invalid_plugin_webhook_route_endpoint'],
    ['bad endpoint space', { schemaVersion: 1, routes: [{ path: '/a', endpoint: '/my hook' }] }, 'invalid_plugin_webhook_route_endpoint'],
    ['bad endpoint trailing slash', { schemaVersion: 1, routes: [{ path: '/a', endpoint: '/hook/' }] }, 'invalid_plugin_webhook_route_endpoint'],
    ['bad endpoint dot-dot', { schemaVersion: 1, routes: [{ path: '/a', endpoint: '/x/../y' }] }, 'invalid_plugin_webhook_route_endpoint'],
    ['non-boolean prefix', { schemaVersion: 1, routes: [{ path: '/a', prefix: 'yes' }] }, 'invalid_plugin_webhook_route_prefix'],
    ['duplicate route', { schemaVersion: 1, routes: [{ path: '/events' }, { path: '/events', prefix: true }] }, 'duplicate_plugin_webhook_route:/events'],
    ['encoded canonical duplicate', { schemaVersion: 1, routes: [{ path: '/a%3Ab' }, { path: '/a%3ab' }] }, 'duplicate_plugin_webhook_route:/a%3ab'],
    ['maxBodyBytes zero', { schemaVersion: 1, maxBodyBytes: 0, routes: [{ path: '/a' }] }, 'invalid_plugin_webhooks_max_body_bytes'],
    ['maxBodyBytes exceeds hard cap', { schemaVersion: 1, maxBodyBytes: PLUGIN_WEBHOOK_HARD_MAX_BODY_BYTES + 1, routes: [{ path: '/a' }] }, 'invalid_plugin_webhooks_max_body_bytes'],
    ['route maxBodyBytes float', { schemaVersion: 1, routes: [{ path: '/a', maxBodyBytes: 12.5 }] }, 'invalid_plugin_webhook_route_max_body_bytes'],
  ])('rejects invalid webhooks declaration: %s', (_label, raw, expectedError) => {
    expect(() => parsePluginWebhooksContribution(raw)).toThrow(expectedError);
  });

  it('matches exact first, then longest segment-boundary prefix, with safe endpoint rewrite', () => {
    const contribution = parsePluginWebhooksContribution({
      schemaVersion: 1,
      maxBodyBytes: 256 * 1024,
      routes: [
        { path: '/hooks', prefix: true, endpoint: '/wh' },
        { path: '/hooks/ci', prefix: true, endpoint: '/ci-v2', maxBodyBytes: 64 * 1024 },
        { path: '/hooks/ci/exact', endpoint: '/exact-only' },
        { path: '/root-exact', endpoint: '/' },
        { path: '/events' },
      ],
    });

    expect(matchPluginWebhookRoute(contribution, '/hooks/ci/exact')).toEqual({
      route: { path: '/hooks/ci/exact', endpoint: '/exact-only' },
      upstreamPathname: '/exact-only',
      maxBodyBytes: 256 * 1024,
    });

    expect(matchPluginWebhookRoute(contribution, '/hooks/ci/repo/push')).toEqual({
      route: { path: '/hooks/ci', prefix: true, endpoint: '/ci-v2', maxBodyBytes: 64 * 1024 },
      upstreamPathname: '/ci-v2/repo/push',
      maxBodyBytes: 64 * 1024,
    });

    expect(matchPluginWebhookRoute(contribution, '/root-exact')).toEqual({
      route: { path: '/root-exact', endpoint: '/' },
      upstreamPathname: '/',
      maxBodyBytes: 256 * 1024,
    });
    expect(matchPluginWebhookRoute(contribution, '/hooks/sub/item')).toEqual({
      route: { path: '/hooks', prefix: true, endpoint: '/wh' },
      upstreamPathname: '/wh/sub/item',
      maxBodyBytes: 256 * 1024,
    });

    // Segment boundary: /hooks-admin MUST NOT match /hooks prefix
    expect(matchPluginWebhookRoute(contribution, '/hooks-admin')).toBeNull();
    expect(matchPluginWebhookRoute(contribution, '/events/sub')).toBeNull();
    expect(matchPluginWebhookRoute(contribution, '/events/')).toBeNull();

    const defaultOnly = parsePluginWebhooksContribution({
      schemaVersion: 1,
      routes: [{ path: '/events' }],
    });
    expect(matchPluginWebhookRoute(defaultOnly, '/events')?.maxBodyBytes).toBe(PLUGIN_WEBHOOK_DEFAULT_MAX_BODY_BYTES);
  });

  it('detects and blocks pre-normalization traversals, encoded/cased/double-slash/dot prefix bypasses, and non-origin-form URLs', () => {
    for (const target of [
      '/webhook/plugin/demo/events',
      '/webhook/%70lugin/demo/events',
      '/webhook/a/../%70lugin/tok',
      '/./webhook/%70lugin/tok',
      '/webhook/a/../Plugin/tok',
      '/./webhook/Plugin/tok',
      '/webhook/foo/../plugin/demo/events',
      '/webhook//plugin/demo/events/../../../../../__health',
      '/./webhook/plugin/demo/events/../../../../__health',
      'http://evil.example/webhook/plugin/demo/events',
    ]) {
      expect(detectPluginProxyRawTargetKind(target)).toBe('webhook');
    }

    for (const target of [
      '/api/plugins/demo/service/../../../bots',
      '/api/plugins/demo/%73ervice/status',
      '/./api/plugins/demo/%73ervice/status',
      '/api/a/../plugins/demo/%73ervice/status',
      '/api/plugins//demo/service/../../../../../__health',
      '/./api/plugins/demo/service/../../../../__health',
      '//evil.example/api/plugins/demo/service/status',
    ]) {
      expect(detectPluginProxyRawTargetKind(target)).toBe('service');
    }

    // Legitimate unrelated routes remain null
    for (const benign of [
      '/api/bots',
      '/webhook/my-conn/plugin',
      '/api/plugins/demo/settings',
      '/api/plugins/demo/services/start',
      '/api/plugins/service/settings',
      '/api/plugins/demo/bots/service',
    ]) {
      expect(detectPluginProxyRawTargetKind(benign)).toBeNull();
    }

    for (const badHook of [
      '/webhook/%70lugin/demo/events',
      '/webhook/a/../%70lugin/tok',
      '/./webhook/Plugin/tok',
      '/webhook//plugin/demo/events/../../../../../__health',
      '/webhook/plugin/demo/../../../__health',
      '/webhook/plugin/demo/%2e%2e/secret',
    ]) {
      expect(parseRawPluginWebhookRequest(badHook)).toEqual({
        ok: false, status: 400, error: 'invalid_webhook_path',
      });
    }
    expect(parseRawPluginWebhookRequest('/webhook/plugin/demo/events?url=https://example.com/a&diff=a..b')).toEqual({
      ok: true,
      pluginId: 'demo',
      subpath: '/events',
      rawSearch: '?url=https://example.com/a&diff=a..b',
    });

    for (const badSvc of [
      '/api/plugins/demo/service/../../../bots',
      '/api/plugins/demo/service/%2e%2e/admin',
      '/./api/plugins/demo/%73ervice/status',
      '/api/plugins//demo/service/../../../../../__health',
      '/api/plugins/demo/service/a#frag',
    ]) {
      expect(parseRawPluginServiceProxyRequest(badSvc)).toEqual({
        ok: false, status: 400, error: 'invalid_service_path',
      });
    }
    expect(parseRawPluginServiceProxyRequest('/api/plugins/demo/service/v1.0/items?repo=org%2Fproj&diff=a..b')).toEqual({
      ok: true,
      pluginId: 'demo',
      upstreamPath: '/v1.0/items',
      rawSearch: '?repo=org%2Fproj&diff=a..b',
    });
    expect(parseRawPluginServiceProxyRequest('/api/plugins/demo/service')).toEqual({
      ok: true,
      pluginId: 'demo',
      upstreamPath: '/',
      rawSearch: '',
    });
    expect(parseRawPluginServiceProxyRequest('/api/plugins/demo/service/')).toEqual({
      ok: true,
      pluginId: 'demo',
      upstreamPath: '/',
      rawSearch: '',
    });
    expect(parseRawPluginServiceProxyRequest('/api/plugins/BAD_ID/service/status')).toEqual({
      ok: false, status: 404, error: 'plugin_not_found',
    });
  });

  it('validates raw HTTP framing headers strictly against duplicate CL, TE+CL, and unsupported TE', () => {
    expect(validateRawHttpFraming(['Content-Length', '42'])).toEqual({ ok: true, contentLength: 42, chunked: false });
    expect(validateRawHttpFraming(['Transfer-Encoding', 'chunked'])).toEqual({ ok: true, chunked: true });
    expect(validateRawHttpFraming(['Content-Length', '2', 'Content-Length', '2'])).toEqual({
      ok: false, status: 400, error: 'duplicate_content_length',
    });
    expect(validateRawHttpFraming(['Content-Length', '10', 'Transfer-Encoding', 'chunked'])).toEqual({
      ok: false, status: 400, error: 'ambiguous_request_framing',
    });
    expect(validateRawHttpFraming(['Content-Length', '0x10'])).toEqual({
      ok: false, status: 400, error: 'invalid_content_length',
    });
    expect(validateRawHttpFraming(['Transfer-Encoding', 'gzip, chunked'])).toEqual({
      ok: false, status: 501, error: 'unsupported_transfer_encoding',
    });
  });

  it('classifies only the 1–2 segment reserved-id connector shape as legacy connector fall-through', () => {
    const legacyTrue: Array<[string, string]> = [
      ['/webhook/plugin', 'bare connector id'],
      ['/webhook/plugin?token=abc', 'connector id with query token'],
      ['/webhook/plugin/legacy-secret', 'token baked into path'],
      ['/webhook/%70lugin/legacy-secret', 'percent-encoded lowercase p'],
      ['/webhook/PLUGIN/upper-secret', 'uppercase persisted connector id'],
      ['/webhook/Plugin?token=mixed-secret', 'mixed-case connector id'],
      ['/webhook/%50lugin/mixed-secret', 'percent-encoded capital P'],
    ];
    for (const [rawUrl, label] of legacyTrue) {
      expect(isLegacyPluginConnectorWebhookTarget(rawUrl), label).toBe(true);
    }
    const legacyFalse: Array<[string, string]> = [
      ['/webhook/plugin/', 'trailing slash never matched legacy segment regex'],
      ['/webhook/plugin/demo/events', 'plugin route requires 3+ segments'],
      ['/webhook/plugin/ghost/x', 'unknown plugin still has plugin shape, no fall-through'],
      ['/webhook/other/token', 'different connector id'],
      ['/webhook/plugin/a/b', 'three segments is plugin shape'],
      ['/webhook/plugin/..\\..\\__health', 'backslash traversal must stay behind the strict guard'],
      ['/webhook/%70lugin/..\\..\\__health', 'encoded id plus backslash traversal'],
      ['/webhook/plugin/../../__health', 'dot-segment traversal rejected by strict path validation'],
      ['/webhook/plugin/a%2fb', 'encoded slash in token segment'],
      ['/webhook/plugin/a%5Cb', 'encoded backslash in token segment'],
      ['//evil.example/webhook/plugin/token', 'protocol-relative target rejected'],
      ['/webhook', 'unrelated webhook prefix'],
      ['/webhook/plugin?x=1#frag', 'fragment-bearing target rejected at origin-form parse'],
      ['not a url', 'garbage input'],
      [undefined as unknown as string, 'undefined input'],
    ];
    for (const [rawUrl, label] of legacyFalse) {
      expect(isLegacyPluginConnectorWebhookTarget(rawUrl), label).toBe(false);
    }
  });
});
