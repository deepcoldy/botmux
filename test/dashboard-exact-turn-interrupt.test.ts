import { describe, expect, it } from 'vitest';
import { proxySessionStopControl } from '../src/dashboard/session-stop-control.js';

describe('Dashboard session stop control', () => {
  it('routes only to the owner and preserves exact encoded identities and daemon status', async () => {
    const calls: unknown[] = [];
    const reply = await proxySessionStopControl('POST', '/api/sessions/session%20one/turns/trigger%2Fone/interrupt', {
      ownerOf: sid => { expect(sid).toBe('session one'); return 'cli_owner'; },
      proxyToDaemon: async (...args) => { calls.push(args); return Response.json({ ok: false, error: 'stale_turn' }, { status: 409 }); },
    });
    expect(calls).toEqual([['cli_owner', '/api/sessions/session%20one/turns/trigger%2Fone/interrupt', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    }]]);
    expect(reply?.status).toBe(409); expect(await reply?.json()).toEqual({ ok: false, error: 'stale_turn' });
  });
  it('never substitutes a session interrupt or broadcasts when identity is missing', async () => {
    const deps = { ownerOf: () => undefined, proxyToDaemon: async () => { throw Error('must not send'); } };
    expect((await proxySessionStopControl('POST', '/api/sessions/unknown/turns/turn/interrupt', deps))?.status).toBe(404);
    expect((await proxySessionStopControl('POST', '/api/sessions/%ZZ/turns/turn/interrupt', deps))?.status).toBe(400);
    expect(await proxySessionStopControl('GET', '/api/sessions/s/turns/t/interrupt', deps)).toBeNull();
    expect(await proxySessionStopControl('POST', '/api/sessions/s/interrupt', deps)).toBeNull();
  });
  it('propagates unavailable upstream without trying a different turn or daemon', async () => {
    let calls = 0;
    await expect(proxySessionStopControl('POST', '/api/sessions/s/turns/t/interrupt', {
      ownerOf: () => 'cli_owner', proxyToDaemon: async () => { calls++; throw Error('offline'); },
    })).rejects.toThrow('offline');
    expect(calls).toBe(1);
  });
});
