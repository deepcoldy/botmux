import { createServer, type Server } from 'node:http';
import { describe, expect, it } from 'vitest';
import {
  createTerminalFrontProxy,
  parseTerminalFrontPath,
  terminalForwardHeaders,
  TERMINAL_CONTROL_HEADER,
} from '../src/dashboard/terminal-front-proxy.js';

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') reject(new Error('missing test port'));
      else resolve(address.port);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise(resolve => server.close(() => resolve()));
}

describe('central terminal front proxy boundary', () => {
  it('decodes exactly one session path segment and rejects malformed IDs', () => {
    expect(parseTerminalFrontPath('/s/session%20one/')).toEqual({ sessionId: 'session one' });
    expect(parseTerminalFrontPath('/s/session%2Fescape/')).toBeNull();
    expect(parseTerminalFrontPath('/s/')).toBeNull();
    expect(parseTerminalFrontPath('/preview/s1/')).toBeNull();
  });

  it('strips browser credentials and forged Botmux headers before injecting one internal grant', () => {
    const grant = 'internal-short-lived-grant';
    const headers = terminalForwardHeaders({
      host: 'dashboard.example',
      cookie: 'botmux_dashboard_session=browser-secret',
      authorization: 'Bearer browser-secret',
      'proxy-authorization': 'Basic browser-secret',
      referer: 'https://dashboard.example/?t=legacy-secret',
      forwarded: 'host=attacker',
      'x-forwarded-host': 'attacker',
      'x-botmux-role': 'owner',
      [TERMINAL_CONTROL_HEADER]: 'forged-grant',
      'sec-websocket-protocol': 'terminal',
    }, grant);
    expect(headers).toEqual({
      host: 'dashboard.example',
      'sec-websocket-protocol': 'terminal',
      [TERMINAL_CONTROL_HEADER]: grant,
    });
    const serialized = JSON.stringify(headers);
    expect(serialized).not.toContain('browser-secret');
    expect(serialized).not.toContain('forged-grant');
    expect(serialized).not.toContain('?t=');
  });

  it('preserves legacy view/write capability requests when no Dashboard identity was resolved', () => {
    const original = {
      cookie: 'unrecognized=opaque',
      host: 'localhost',
      'x-test': 'value',
      [TERMINAL_CONTROL_HEADER]: 'client-replay-must-be-dropped',
    };
    expect(terminalForwardHeaders(original, undefined)).toEqual({
      cookie: 'unrecognized=opaque',
      host: 'localhost',
      'x-test': 'value',
    });
  });

  it('strips the legacy owner cookie when a separately minted query capability is used', () => {
    expect(terminalForwardHeaders({
      host: 'dashboard.example',
      cookie: 'botmux_dashboard=owner-secret',
      authorization: 'Bearer owner-secret',
      'x-test': 'kept',
      [TERMINAL_CONTROL_HEADER]: 'forged',
    }, undefined, { stripBrowserCredentials: true })).toEqual({
      host: 'dashboard.example',
      'x-test': 'kept',
    });
  });

  it('keeps default requests on short grants but validates explicit legacy links without cookies', async () => {
    const observed: Array<{ url: string; cookie?: string; grant?: string }> = [];
    const upstream = createServer((req, res) => {
      observed.push({
        url: req.url ?? '',
        ...(req.headers.cookie ? { cookie: req.headers.cookie } : {}),
        ...(typeof req.headers[TERMINAL_CONTROL_HEADER] === 'string'
          ? { grant: req.headers[TERMINAL_CONTROL_HEADER] }
          : {}),
      });
      res.end('ok');
    });
    const upstreamPort = await listen(upstream);
    const proxy = createTerminalFrontProxy({
      resolvePort: () => upstreamPort,
      resolveActor: () => ({ userId: 'owner', authSessionId: 'legacy', expiresAt: Number.MAX_SAFE_INTEGER }),
      allowLegacyQueryCapabilities: () => true,
      control: {
        grantForProxy: () => ({ token: 'short-read-grant', scope: 'read' }),
      } as any,
    });
    const front = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (!proxy.handleHttp(req, res, url)) res.writeHead(404).end();
    });
    const frontPort = await listen(front);
    try {
      expect((await fetch(`http://127.0.0.1:${frontPort}/s/s1/`, {
        headers: { cookie: 'botmux_dashboard=owner-cookie' },
      })).status).toBe(200);
      expect((await fetch(`http://127.0.0.1:${frontPort}/s/s1/?token=worker-write`, {
        headers: { cookie: 'botmux_dashboard=owner-cookie' },
      })).status).toBe(200);
      expect(observed).toEqual([
        { url: '/s/s1/', grant: 'short-read-grant' },
        { url: '/s/s1/?token=worker-write' },
      ]);
    } finally {
      await close(front);
      await close(upstream);
    }
  });
});
