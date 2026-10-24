import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { installLocalPlugin } from '../src/core/plugins/install.js';
import {
  PluginMcpGateway,
  type GatewayLinkRefRegistrationHandler,
  type GatewayTrustedTurnIdentity,
} from '../src/core/plugins/mcp/gateway.js';
import {
  registerMcpLinkRefsFromWorker,
  resolveMcpHostDeliveryLinkRefsFromWorker,
} from '../src/core/link-ref-ipc.js';
import type { LinkRefRuntime } from '../src/services/link-ref-runtime.js';

describe('plugin MCP LinkRef registration', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'botmux-mcp-link-ref-'));
    vi.stubEnv('HOME', home);
    vi.stubEnv('SESSION_DATA_DIR', join(home, '.botmux', 'data'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  function installFixture(): void {
    const source = join(home, 'plugin-link-ref-src');
    mkdirSync(join(source, 'dist', 'mcp'), { recursive: true });
    writeFileSync(join(source, 'package.json'), JSON.stringify({
      name: '@botmux-ai/plugin-link-ref',
      version: '0.1.0',
      type: 'module',
      keywords: ['botmux-plugin'],
      botmux: { schemaVersion: 1, id: 'plugin-link-ref' },
    }));
    writeFileSync(join(source, 'dist', 'mcp', 'index.json'), JSON.stringify({
      transport: 'stdio',
      command: [process.execPath, resolve('test/fixtures/plugin-mcp-server.mjs'), 'link-ref'],
    }));
    installLocalPlugin(source);
  }

  async function connect(input: {
    identity?: () => GatewayTrustedTurnIdentity | undefined;
    register?: GatewayLinkRefRegistrationHandler;
  }): Promise<{ gateway: PluginMcpGateway; client: Client }> {
    installFixture();
    const gateway = new PluginMcpGateway(
      ['plugin-link-ref'],
      { ...process.env, BOTMUX_SESSION_ID: 'session-link-ref' },
      {
        ...(input.identity ? { trustedTurnIdentity: input.identity } : {}),
        ...(input.register ? { linkRefRegistration: input.register } : {}),
      },
    );
    const client = new Client({ name: 'gateway-link-ref-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([gateway.connect(serverTransport), client.connect(clientTransport)]);
    return { gateway, client };
  }

  const identity = (mode: 'observe' | 'enabled'): GatewayTrustedTurnIdentity => ({
    turnId: 'om_link_ref',
    dispatchAttempt: 3,
    linkRefMode: mode,
  });

  it('keeps a tool result intact and appends one text companion in enabled mode', async () => {
    const fullUrl = 'https://auth.example.test/authorize'
      + '?code=code-value&token=token-value&signature=sig-value&state=state-value'
      + '&redirect_uri=https%3A%2F%2Fclient.example.test%2Fcallback';
    let registeredValue: unknown;
    const register = vi.fn(async input => {
      registeredValue = structuredClone(input.value);
      return {
        companion: '<botmux_link_refs>\nlr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa = exact\n</botmux_link_refs>',
        stats: { found: 3 },
      };
    });
    const { gateway, client } = await connect({ identity: () => identity('enabled'), register });
    try {
      const result = await client.callTool({ name: 'echo', arguments: {} });
      expect(register).toHaveBeenCalledWith(expect.objectContaining({
        sourceType: 'mcp',
        identity: identity('enabled'),
      }));
      expect(JSON.stringify(registeredValue)).toContain(fullUrl);
      expect((registeredValue as any).content).toHaveLength(3);
      expect((result.content.at(-1) as any).text).toContain('<botmux_link_refs>');
      expect(result.content).toHaveLength(4);
      expect(result.content[0]).toEqual((registeredValue as any).content[0]);
      expect(result.content[1]).toEqual((registeredValue as any).content[1]);
      expect(result.content[2]).toEqual((registeredValue as any).content[2]);
      expect((result as any).structuredContent).toEqual((registeredValue as any).structuredContent);
    } finally {
      await client.close();
      await gateway.close();
    }
  });

  it('registers observe-mode results for stats without changing tool output', async () => {
    const register = vi.fn(async () => ({ stats: { found: 2 } }));
    const { gateway, client } = await connect({ identity: () => identity('observe'), register });
    try {
      const result = await client.callTool({ name: 'echo', arguments: {} });
      expect(register).toHaveBeenCalledOnce();
      expect(result.content).toHaveLength(3);
      expect(JSON.stringify(result)).not.toContain('<botmux_link_refs>');
    } finally {
      await client.close();
      await gateway.close();
    }
  });

  it('does no LinkRef work when the trusted identity has no non-disabled mode', async () => {
    const register = vi.fn();
    const { gateway, client } = await connect({
      identity: () => ({ turnId: 'om_disabled' }),
      register,
    });
    try {
      const result = await client.callTool({ name: 'echo', arguments: {} });
      expect(register).not.toHaveBeenCalled();
      expect(result.content).toHaveLength(3);
    } finally {
      await client.close();
      await gateway.close();
    }
  });

  it('appends a synthetic text resource after URI remapping', async () => {
    const register = vi.fn(async () => ({
      companion: '<botmux_link_refs>\nlr_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb = exact\n</botmux_link_refs>',
      stats: { found: 1 },
    }));
    const { gateway, client } = await connect({ identity: () => identity('enabled'), register });
    try {
      const [resource] = (await client.listResources()).resources;
      const result = await client.readResource({ uri: resource!.uri });
      expect(register).toHaveBeenCalledWith(expect.objectContaining({
        sourceType: 'mcp',
        identity: identity('enabled'),
      }));
      expect(result.contents).toHaveLength(2);
      expect(result.contents[0]!.uri).toBe(resource!.uri);
      expect(result.contents[1]).toMatchObject({
        uri: 'botmux://link-refs/current-turn',
        mimeType: 'text/plain',
        text: expect.stringContaining('<botmux_link_refs>'),
      });
    } finally {
      await client.close();
      await gateway.close();
    }
  });

  it('freezes identity at request start even if the active turn changes before registration', async () => {
    const identities = [identity('enabled'), { ...identity('enabled'), turnId: 'om_new_turn' }];
    let reads = 0;
    let seen: GatewayTrustedTurnIdentity | undefined;
    const register: GatewayLinkRefRegistrationHandler = async input => {
      seen = input.identity;
      return { stats: { found: 1 } };
    };
    const { gateway, client } = await connect({
      identity: () => identities[Math.min(reads++, identities.length - 1)],
      register,
    });
    try {
      await client.callTool({ name: 'echo', arguments: {} });
      expect(reads).toBe(1);
      expect(seen).toEqual(identity('enabled'));
    } finally {
      await client.close();
      await gateway.close();
    }
  });
});

describe('plugin MCP daemon LinkRef authority', () => {
  const request = {
    sessionId: 'session-link-ref',
    turnId: 'om_link_ref',
    dispatchAttempt: 3,
    linkRefMode: 'enabled' as const,
    pluginId: 'plugin-link-ref',
    sourceId: 'tool:echo',
    value: { content: [{ type: 'text', text: 'https://example.test/path' }] },
  };

  function runtime(overrides: Partial<LinkRefRuntime> = {}): LinkRefRuntime {
    return {
      restoreMode: vi.fn(() => 'enabled'),
      registerSources: vi.fn(() => ({
        companion: '<botmux_link_refs>companion</botmux_link_refs>',
        stats: {
          scannedBytes: 25,
          found: 1,
          candidateCount: 1,
          filteredCredential: 0,
          filteredMetadata: 0,
          filteredInvalid: 0,
        },
      })),
      resolveForDaemon: vi.fn((_key, _mode, payload) => ({
        ...payload,
        text: 'https://example.test/path',
        refCount: 1,
      })),
      ...overrides,
    } as LinkRefRuntime;
  }

  it('derives app identity from the current daemon session and accepts the exact live turn', () => {
    const linkRefs = runtime();
    const result = registerMcpLinkRefsFromWorker({
      ownsWorkerSession: true,
      daemonSession: {
        appId: 'app-host-owned',
        sessionId: 'session-link-ref',
        managedTurnOrigin: {
          turnId: 'om_link_ref',
          dispatchAttempt: 3,
          linkRefMode: 'enabled',
        },
      },
      runtime: linkRefs,
      request,
    });

    expect(result.ok).toBe(true);
    expect(linkRefs.restoreMode).toHaveBeenCalledWith({
      appId: 'app-host-owned',
      sessionId: 'session-link-ref',
      turnId: 'om_link_ref',
      dispatchAttempt: 3,
    });
    expect(linkRefs.registerSources).toHaveBeenCalledWith({
      key: {
        appId: 'app-host-owned',
        sessionId: 'session-link-ref',
        turnId: 'om_link_ref',
        dispatchAttempt: 3,
      },
      mode: 'enabled',
      sources: [{
        sourceType: 'mcp',
        kind: 'structured',
        sourceId: 'tool:echo',
        value: request.value,
      }],
    });
  });

  it.each([
    ['stale generation', false, 'session-link-ref', 'enabled'],
    ['cross session', true, 'session-other', 'enabled'],
    ['settled exact turn', true, 'session-link-ref', undefined],
  ] as const)('rejects %s without registering', (_label, ownsWorkerSession, sessionId, restoredMode) => {
    const registerSources = vi.fn();
    const linkRefs = runtime({
      restoreMode: vi.fn(() => restoredMode),
      registerSources,
    });
    const result = registerMcpLinkRefsFromWorker({
      ownsWorkerSession,
      daemonSession: {
        appId: 'app-host-owned',
        sessionId,
        managedTurnOrigin: { turnId: 'om_link_ref', dispatchAttempt: 3, linkRefMode: 'enabled' },
      },
      runtime: linkRefs,
      request,
    });
    expect(result.ok).toBe(false);
    expect(registerSources).not.toHaveBeenCalled();
  });

  it.each([
    ['stale turn', { turnId: 'om_newer', dispatchAttempt: 3, linkRefMode: 'enabled' as const }],
    ['stale attempt', { turnId: 'om_link_ref', dispatchAttempt: 4, linkRefMode: 'enabled' as const }],
    ['wrong mode', { turnId: 'om_link_ref', dispatchAttempt: 3, linkRefMode: 'observe' as const }],
    ['missing live origin', undefined],
  ])('rejects %s instead of writing another open turn', (_label, managedTurnOrigin) => {
    const linkRefs = runtime();
    const result = registerMcpLinkRefsFromWorker({
      ownsWorkerSession: true,
      daemonSession: { appId: 'app-host-owned', sessionId: 'session-link-ref', managedTurnOrigin },
      runtime: linkRefs,
      request,
    });

    expect(result).toEqual({ ok: false, error: 'link_ref_identity_mismatch' });
    expect(linkRefs.restoreMode).not.toHaveBeenCalled();
    expect(linkRefs.registerSources).not.toHaveBeenCalled();
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid dispatch attempt %s',
    (dispatchAttempt) => {
      const linkRefs = runtime();
      const result = registerMcpLinkRefsFromWorker({
        ownsWorkerSession: true,
        daemonSession: {
          appId: 'app-host-owned',
          sessionId: 'session-link-ref',
          managedTurnOrigin: { turnId: 'om_link_ref', dispatchAttempt, linkRefMode: 'enabled' },
        },
        runtime: linkRefs,
        request: { ...request, dispatchAttempt },
      });
      expect(result).toEqual({ ok: false, error: 'link_ref_identity_mismatch' });
      expect(linkRefs.registerSources).not.toHaveBeenCalled();
    },
  );

  it('converts a restoreMode ledger failure into a worker response', () => {
    const linkRefs = runtime({ restoreMode: vi.fn(() => { throw new Error('sqlite unavailable'); }) });
    const result = registerMcpLinkRefsFromWorker({
      ownsWorkerSession: true,
      daemonSession: {
        appId: 'app-host-owned', sessionId: 'session-link-ref',
        managedTurnOrigin: { turnId: 'om_link_ref', dispatchAttempt: 3, linkRefMode: 'enabled' },
      },
      runtime: linkRefs,
      request,
    });
    expect(result).toEqual({ ok: false, error: 'link_ref_ledger_unavailable' });
  });

  it('resolves host-delivery markdown only for the exact open enabled turn', () => {
    const linkRefs = runtime();
    const result = resolveMcpHostDeliveryLinkRefsFromWorker({
      ownsWorkerSession: true,
      daemonSession: {
        appId: 'app-host-owned', sessionId: 'session-link-ref',
        managedTurnOrigin: { turnId: 'om_link_ref', dispatchAttempt: 3, linkRefMode: 'enabled' },
      },
      runtime: linkRefs,
      request: {
        sessionId: 'session-link-ref',
        turnId: 'om_link_ref',
        dispatchAttempt: 3,
        linkRefMode: 'enabled',
        payload: { text: '{{botmux_link:lr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa}}' },
      },
    });
    expect(result).toEqual({
      ok: true,
      payload: {
        text: 'https://example.test/path',
        refCount: 1,
      },
    });
  });

  it('rejects a stale host-delivery turn before probing the ledger', () => {
    const linkRefs = runtime();
    const result = resolveMcpHostDeliveryLinkRefsFromWorker({
      ownsWorkerSession: true,
      daemonSession: {
        appId: 'app-host-owned', sessionId: 'session-link-ref',
        managedTurnOrigin: { turnId: 'om_newer', dispatchAttempt: 3, linkRefMode: 'enabled' },
      },
      runtime: linkRefs,
      request: {
        sessionId: 'session-link-ref', turnId: 'om_link_ref', dispatchAttempt: 3,
        linkRefMode: 'enabled', payload: { text: 'plain' },
      },
    });
    expect(result).toEqual({ ok: false, error: 'link_ref_identity_mismatch' });
    expect(linkRefs.restoreMode).not.toHaveBeenCalled();
  });

  it('converts a host-delivery restoreMode failure into a worker response', () => {
    const linkRefs = runtime({ restoreMode: vi.fn(() => { throw new Error('sqlite unavailable'); }) });
    const result = resolveMcpHostDeliveryLinkRefsFromWorker({
      ownsWorkerSession: true,
      daemonSession: {
        appId: 'app-host-owned', sessionId: 'session-link-ref',
        managedTurnOrigin: { turnId: 'om_link_ref', dispatchAttempt: 3, linkRefMode: 'enabled' },
      },
      runtime: linkRefs,
      request: {
        sessionId: 'session-link-ref', turnId: 'om_link_ref', dispatchAttempt: 3,
        linkRefMode: 'enabled', payload: { text: 'plain' },
      },
    });
    expect(result).toEqual({ ok: false, error: 'link_ref_ledger_unavailable' });
  });
});
