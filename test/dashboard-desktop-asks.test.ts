import { describe, expect, it, vi } from 'vitest';

import {
  parseDashboardAskAnswerRequest,
  proxyDashboardAskAnswer,
} from '../src/dashboard/desktop-asks.js';

describe('desktop ask dashboard routing', () => {
  it('requires a concrete daemon target and validates selections deeply', () => {
    expect(parseDashboardAskAnswerRequest({
      askId: 'ask-1',
      selections: [['yes']],
    })).toEqual({
      ok: false,
      error: 'askId_larkAppId_and_selections_required',
    });
    expect(parseDashboardAskAnswerRequest({
      askId: 'ask-1',
      larkAppId: 'app-a',
      selections: [1],
    })).toEqual({ ok: false, error: 'invalid_selections' });
    expect(parseDashboardAskAnswerRequest({
      askId: 'ask-1',
      larkAppId: 'app-a',
      selections: [['yes', 1]],
    })).toEqual({ ok: false, error: 'invalid_selections' });
  });

  it('proxies exactly once to the selected daemon and preserves upstream status', async () => {
    const proxy = vi.fn(async () => new Response(
      JSON.stringify({ ok: false, error: 'already_settled' }),
      { status: 409, headers: { 'content-type': 'application/json' } },
    ));
    const result = await proxyDashboardAskAnswer({
      askId: 'ask-1',
      larkAppId: 'app-b',
      selections: [['yes']],
    }, proxy);

    expect(proxy).toHaveBeenCalledTimes(1);
    expect(proxy).toHaveBeenCalledWith(
      'app-b',
      '/api/asks/answer',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(result.status).toBe(409);
    expect(JSON.parse(result.body)).toMatchObject({ error: 'already_settled' });
  });

  it('maps an unavailable selected daemon to 503 without trying another daemon', async () => {
    const proxy = vi.fn(async () => {
      throw new Error('offline');
    });
    const result = await proxyDashboardAskAnswer({
      askId: 'ask-1',
      larkAppId: 'app-offline',
      selections: [['yes']],
    }, proxy);

    expect(proxy).toHaveBeenCalledTimes(1);
    expect(result.status).toBe(503);
    expect(JSON.parse(result.body)).toEqual({ ok: false, error: 'daemon_unavailable' });
  });
});
