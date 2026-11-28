import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BOT_PROFILE_SHARED_PARTS } from '../src/dashboard/web/bot-defaults-page.js';
import { WecomBotDefaultsCard } from '../src/dashboard/web/wecom-bot-defaults-card.js';

/**
 * The WeCom configuration card puts the connection id into the request path of
 * its calls: the configuration it reads and the hand-over targets of the
 * 「额度耗尽交接」 tile. The id is one path segment, so characters such as `/`,
 * `?` or a space must be percent-encoded instead of splitting the path or
 * starting a query string.
 */

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

interface SentRequest {
  method: string;
  url: string;
}

let renderer: TestRenderer.ReactTestRenderer | undefined;

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

function responseBody(method: string, url: string): unknown {
  if (url.endsWith('/config')) {
    return {
      editable: true,
      revision: '1',
      cli: 'codex',
      model: '',
      backend: 'pty',
      workingDirectory: '/workspace',
      botConfig: {},
      allowedUsers: ['owner'],
      blockedUsers: [],
      role: { content: '', injectMode: 'once' },
      native: {},
    };
  }
  if (url.endsWith('/fallback-peers')) {
    return { peers: [], trusting: true };
  }
  if (url.endsWith('/environment')) {
    return {
      scope: 'bot',
      rows: [],
      reserved: { keys: [], prefixes: [] },
      redactedHostKeys: [],
      conflicts: [],
      inherit: { mode: 'inherit' },
      canReveal: false,
      sessions: [],
      overlayApplies: true,
    };
  }
  if (url.endsWith('/codex-profiles')) {
    return { connectionId: 'fixture', status: 'empty', candidates: [] };
  }
  return { status: 'unknown', models: [] };
}

/**
 * Renders the real card for `connectionId` and lets every tab panel load (they
 * are all mounted). Returns every request the card sent.
 */
async function sendCardRequests(connectionId: string): Promise<SentRequest[]> {
  const requests: SentRequest[] = [];
  vi.stubGlobal('fetch', async (input: unknown, init: RequestInit = {}) => {
    const url = String(input);
    const method = init.method ?? 'GET';
    requests.push({ method, url });
    return { ok: true, status: 200, json: async () => responseBody(method, url) };
  });
  await act(async () => {
    renderer = TestRenderer.create(React.createElement(WecomBotDefaultsCard, {
      shared: BOT_PROFILE_SHARED_PARTS,
      connection: {
        id: connectionId,
        label: 'WeCom',
        configuration: 'ready',
        ownership: 'dashboard',
        gateway: 'stopped',
      } as any,
      cliState: { options: [{ id: 'codex', label: 'Codex' }] } as any,
      activeTab: 'advanced',
      onTabChange: vi.fn(),
      onRefresh: vi.fn(),
      onAction: vi.fn(),
    }));
  });
  return requests;
}

const urlsOf = (requests: SentRequest[], method: string, suffix: string) =>
  [...new Set(requests.filter(request => request.method === method && request.url.endsWith(suffix)).map(request => request.url))];

describe('WeCom configuration card request paths', () => {
  it('percent-encodes a connection id that contains path, query and space characters', async () => {
    const requests = await sendCardRequests('team/bot?x y');

    expect(urlsOf(requests, 'GET', '/config')).toEqual(['/api/wecom/connections/team%2Fbot%3Fx%20y/config']);
    expect(urlsOf(requests, 'GET', '/fallback-peers')).toEqual(['/api/wecom/connections/team%2Fbot%3Fx%20y/fallback-peers']);
    expect(requests.filter(request => request.url.includes('team/bot?x y'))).toEqual([]);
  });

  it('sends a configuration-file id (64 hex characters) unchanged', async () => {
    const id = '3f2b8c1d9e7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a2b1c';
    const requests = await sendCardRequests(id);

    expect(urlsOf(requests, 'GET', '/config')).toEqual([`/api/wecom/connections/${id}/config`]);
    expect(urlsOf(requests, 'GET', '/fallback-peers')).toEqual([`/api/wecom/connections/${id}/fallback-peers`]);
  });
});
