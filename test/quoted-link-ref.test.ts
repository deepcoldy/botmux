import { describe, expect, it, vi } from 'vitest';
import { decorateCliLinkRefResult } from '../src/core/link-ref-ipc.js';

const authorizationUrl = 'https://auth.example.test/authorize'
  + '?code=code-value&token=token-value&signature=sig-value&state=state-value'
  + '&redirect_uri=https%3A%2F%2Fclient.example.test%2Fcallback';

describe('botmux quoted — LinkRef result companion', () => {
  it('registers after rendering raw card JSON and downloaded attachment paths are present', async () => {
    const quoted = {
      messageId: 'om_quoted',
      text: `需要授权：${authorizationUrl}`,
      cardJson: { actions: [{ url: authorizationUrl }] },
      attachments: [{ name: 'details.txt', path: '/tmp/quoted/details.txt' }],
      rawContent: JSON.stringify({ url: authorizationUrl }),
    };
    const original = structuredClone(quoted);
    const register = vi.fn(async (payload: unknown) => ({
      companion: '<botmux_link_refs>\nlr_auth = exact\n</botmux_link_refs>',
      stats: {},
    }));

    const decorated = await decorateCliLinkRefResult({
      mode: 'enabled',
      sourceType: 'quoted',
      sourceId: 'om_quoted',
      value: quoted,
      register,
    });

    expect(quoted).toEqual(original);
    expect(decorated).toEqual({
      ...original,
      linkRefs: { companion: '<botmux_link_refs>\nlr_auth = exact\n</botmux_link_refs>' },
    });
    expect(register).toHaveBeenCalledWith({
      sourceType: 'quoted',
      sourceId: 'om_quoted',
      value: original,
    });
    expect(JSON.stringify(register.mock.calls[0]?.[0])).toContain(authorizationUrl);
  });

  it('observe registers for redacted statistics without changing the result', async () => {
    const quoted = { text: authorizationUrl };
    const before = JSON.stringify(quoted, null, 2);
    const register = vi.fn(async () => ({ stats: { found: 1 } }));

    const decorated = await decorateCliLinkRefResult({
      mode: 'observe',
      sourceType: 'quoted',
      value: quoted,
      register,
    });

    expect(decorated).toBe(quoted);
    expect(JSON.stringify(decorated, null, 2)).toBe(before);
    expect(register).toHaveBeenCalledOnce();
  });

  it('fails open when registration is unavailable', async () => {
    const quoted = { text: authorizationUrl };
    const register = vi.fn(async () => { throw new Error('daemon unavailable'); });

    const decorated = await decorateCliLinkRefResult({
      mode: 'enabled',
      sourceType: 'quoted',
      value: quoted,
      register,
    });

    expect(decorated).toBe(quoted);
  });
});
